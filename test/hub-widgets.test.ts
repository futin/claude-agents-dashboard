/**
 * The dashboard's Lookout hub widgets (hub-widgets spec §4): `usage` (gauge), `sessions` (list) and `git` (list), declared through `lookout-widgets` and
 * fed by injected getters, so nothing here touches the network, the real transcript dir or a real repo.
 */

import assert from 'node:assert';

import { checkWidgets } from 'lookout-widgets/testkit';

import { testAsync } from './api-harness.js';
import { createDashboardHub } from '../server/lib/hub-widgets.js';
import type { Config } from '../server/lib/config.js';
import type { UsageState } from '../server/lib/usage.js';
import type { RateLimit, RepoGitStats, Session, UsageLimits } from '../shared/types.js';

const cfg = (showUsage: boolean): Config => ({ showUsage }) as Config;
const win = (utilization: number | null, resetsAt: string | null): RateLimit => ({ utilization, resetsAt }) as RateLimit;
const limits = (five: RateLimit, seven: RateLimit): UsageLimits => ({ fiveHour: five, sevenDay: seven });
const OK: UsageState = { usage: limits(win(42, '2026-10-08T05:00:00Z'), win(10, '2026-10-12T00:00:00Z')), status: 'ok' };

const session = (over: Partial<Session>): Session =>
  ({ id: 'abc', project: 'dash', sessionName: null, gitBranch: null, model: 'opus', contextPct: 41.6, status: 'idle', ...over }) as Session;

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

/** A clean, level repo on main with an origin and no upstream chip: the baseline every git case overrides one field of. */
const okRepo = (name: string, over: Partial<Ok> = {}): Ok => ({
  dirName: `-p-${name}`, name, path: `/p/${name}`, state: 'ok', toplevel: `/p/${name}`,
  branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
  trunk: 'main', hasOrigin: true, trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true }, currentVsUpstream: null,
  fetchedAtMs: null, lastFetch: null, branches: [], unmergedTotal: 0, mergedCount: 0,
  ...over,
});
const onFeat = (upstream: string, counts: { ahead: number; behind: number } | null): Partial<Ok> =>
  ({ branch: 'feat/x', onTrunk: false, currentVsUpstream: { upstream, counts } });

const get = (usage: UsageState, sessions: Session[] = [session({})], showUsage = true) =>
  (path: string) => createDashboardHub(cfg(showUsage), { usage: () => usage, sessions: () => sessions, git: async () => [], watchGit: () => {} })
    .handle({ method: 'GET', path, query: new URLSearchParams() });

type GitRow = { id: string; title: string; subtitle: string; status: string; open: string };
const gitRows = async (repos: RepoGitStats[], watchGit: () => void = () => {}): Promise<GitRow[]> => {
  const r = await createDashboardHub(cfg(false), { sessions: () => [], git: async () => repos, watchGit })
    .handle({ method: 'GET', path: '/api/hub/widgets/git', query: new URLSearchParams() });
  assert.equal(r?.status, 200);
  return (r?.json as { rows: GitRow[] }).rows;
};
const subs = (rows: GitRow[]) => rows.map(x => [x.title, x.subtitle, x.status]);

export async function run(): Promise<number> {
  console.log('\n=== hub widgets (lookout-widgets) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('checkWidgets over all three widgets finds nothing wrong', async () => {
    const git = async (): Promise<RepoGitStats[]> => [okRepo('a', { uncommitted: 1 }), { dirName: 'b', name: 'b', path: null, state: 'missing' }];
    const hub = createDashboardHub(cfg(true), { usage: () => OK, sessions: () => [session({}), session({ id: 'x/y', status: 'working' })], git, watchGit: () => {} });
    assert.deepStrictEqual(await checkWidgets(hub), []);
  }));

  check(await testAsync('a null weekly window is omitted; 5-hour carries its resetsAt', async () => {
    const r = await get({ usage: limits(win(42, '2026-10-08T05:00:00Z'), win(null, '2026-10-12T00:00:00Z')), status: 'ok' })('/api/hub/widgets/usage');
    assert.equal(r?.status, 200);
    assert.deepStrictEqual((r?.json as { bars: unknown }).bars, [{ label: '5-hour', percent: 42, resetsAt: '2026-10-08T05:00:00Z' }]);
  }));

  check(await testAsync('both windows give two bars in order; a null resetsAt leaves no key', async () => {
    const r = await get({ usage: limits(win(42, '2026-10-08T05:00:00Z'), win(10, null)), status: 'ok' })('/api/hub/widgets/usage');
    assert.deepStrictEqual((r?.json as { bars: unknown }).bars, [
      { label: '5-hour', percent: 42, resetsAt: '2026-10-08T05:00:00Z' },
      { label: 'Weekly', percent: 10 }
    ]);
  }));

  check(await testAsync('both windows null is 500 usage has no windows', async () => {
    const r = await get({ usage: limits(win(null, null), win(null, null)), status: 'ok' })('/api/hub/widgets/usage');
    assert.deepStrictEqual(r, { status: 500, json: { error: 'usage has no windows' } });
  }));

  for (const [state, error] of [
    [{ usage: null, status: 'unavailable' }, 'usage unavailable'],
    [{ usage: OK.usage, status: 'token-expired' }, 'usage token-expired'],
    [{ usage: null, status: 'ok' }, 'usage ok']
  ] as [UsageState, string][]) {
    check(await testAsync(`${JSON.stringify(state.status)} with usage ${state.usage === null ? 'null' : 'set'} is 500 ${error}`, async () => {
      assert.deepStrictEqual(await get(state)('/api/hub/widgets/usage'), { status: 500, json: { error } });
    }));
  }

  check(await testAsync('showUsage false serves only sessions; usage is 404', async () => {
    const g = get(OK, [session({})], false);
    assert.deepStrictEqual(((await g('/api/hub/widgets'))?.json as { widgets: { id: string }[] }).widgets.map(w => w.id), ['sessions', 'git']);
    assert.equal((await g('/api/hub/widgets/usage'))?.status, 404);
  }));

  check(await testAsync('one session per status maps to running, warn, error, idle in scan order', async () => {
    const r = await get(OK, (['working', 'question', 'incomplete', 'idle'] as const).map((status, i) => session({ id: `s${i}`, status })))('/api/hub/widgets/sessions');
    assert.deepStrictEqual((r?.json as { rows: { status: string }[] }).rows.map(x => x.status), ['running', 'warn', 'error', 'idle']);
  }));

  check(await testAsync('title falls back to project; subtitle drops null parts and rounds ctx', async () => {
    const r = await get(OK, [session({}), session({ id: 'b', sessionName: 'Fix', gitBranch: 'main' })])('/api/hub/widgets/sessions');
    const rows = (r?.json as { rows: { title: string; subtitle: string }[] }).rows;
    assert.deepStrictEqual(rows.map(x => [x.title, x.subtitle]), [['dash', 'opus · ctx 42%'], ['Fix', 'main · opus · ctx 42%']]);
  }));

  check(await testAsync('row open is /?session=<encoded id>; no total, no actions', async () => {
    const r = await get(OK, [session({}), session({ id: 'a b' })])('/api/hub/widgets/sessions');
    const json = r?.json as { rows: Record<string, unknown>[] };
    assert.deepStrictEqual(json.rows.map(x => x.open), ['/?session=abc', '/?session=a%20b']);
    assert.equal('total' in json, false);
    assert.equal(json.rows.some(x => 'actions' in x), false);
  }));

  // ── git ──────────────────────────────────────────────────────────────────────
  check(await testAsync('git is a list "Git pending", every 30s, opening /?view=git', async () => {
    const widgets = ((await get(OK)('/api/hub/widgets'))?.json as { widgets: Record<string, unknown>[] }).widgets;
    const git = widgets.find(w => w.id === 'git');
    assert.deepStrictEqual([git?.title, git?.render, git?.refreshSeconds, git?.open], ['Git pending', 'list', 30, '/?view=git']);
  }));

  check(await testAsync('a clean, level repo has no row; no total is sent', async () => {
    const r = await createDashboardHub(cfg(false), { sessions: () => [], git: async () => [okRepo('a'), okRepo('b', { trunkVsOrigin: null })], watchGit: () => {} })
      .handle({ method: 'GET', path: '/api/hub/widgets/git', query: new URLSearchParams() });
    assert.deepStrictEqual((r?.json as { rows: unknown[] }).rows, []);
    assert.equal('total' in (r?.json as object), false);
  }));

  check(await testAsync('uncommitted work reads "N changed", running', async () => {
    assert.deepStrictEqual(subs(await gitRows([okRepo('a', { uncommitted: 3 })])), [['a', '3 changed', 'running']]);
  }));

  check(await testAsync('a trunk ahead of origin reads ↑N, running; behind reads ↓N, warn', async () => {
    assert.deepStrictEqual(subs(await gitRows([okRepo('a', { trunkVsOrigin: { ahead: 2, behind: 0 } })])), [['a', '↑2', 'running']]);
    assert.deepStrictEqual(subs(await gitRows([okRepo('a', { trunkVsOrigin: { ahead: 0, behind: 4 } })])), [['a', '↓4', 'warn']]);
  }));

  check(await testAsync('the current branch against its upstream counts both ways', async () => {
    assert.deepStrictEqual(subs(await gitRows([okRepo('a', onFeat('origin/feat/x', { ahead: 1, behind: 2 }))])), [['a', '↑1 · ↓2', 'warn']]);
  }));

  check(await testAsync('trunk and upstream counts add up; all parts join changed · ↑ · ↓', async () => {
    const r = okRepo('a', { uncommitted: 3, trunkVsOrigin: { ahead: 1, behind: 1 }, ...onFeat('origin/feat/x', { ahead: 2, behind: 0 }) });
    assert.deepStrictEqual(subs(await gitRows([r])), [['a', '3 changed · ↑3 · ↓1', 'warn']]);
  }));

  check(await testAsync('an upstream of origin/<trunk> and a gone upstream raise nothing', async () => {
    assert.deepStrictEqual(await gitRows([okRepo('a', onFeat('origin/main', { ahead: 5, behind: 3 })), okRepo('b', onFeat('origin/feat/x', null))]), []);
  }));

  check(await testAsync('an unreadable repo is an error row with a short reason', async () => {
    const rows = await gitRows([
      { dirName: 'm', name: 'm', path: null, state: 'missing' },
      { dirName: 'n', name: 'n', path: '/n', state: 'not-git' },
      { dirName: 't', name: 't', path: '/t', state: 'error', message: 'git status timed out after 5s' },
      { dirName: 'g', name: 'g', path: '/g', state: 'error', message: 'git not found' },
    ]);
    assert.deepStrictEqual(subs(rows), [
      ['m', 'folder missing', 'error'], ['n', 'not a git repo', 'error'], ['t', 'timed out', 'error'], ['g', 'git error', 'error'],
    ]);
  }));

  check(await testAsync('rows go pull, then commit/push, then unreadable, pin order within each', async () => {
    const rows = await gitRows([
      okRepo('push1', { uncommitted: 1 }),
      { dirName: 'bad', name: 'bad', path: null, state: 'missing' },
      okRepo('pull1', { trunkVsOrigin: { ahead: 0, behind: 1 } }),
      okRepo('clean'),
      okRepo('push2', { trunkVsOrigin: { ahead: 1, behind: 0 } }),
      okRepo('pull2', { uncommitted: 2, ...onFeat('origin/feat/x', { ahead: 0, behind: 1 }) }),
    ]);
    assert.deepStrictEqual(rows.map(x => x.title), ['pull1', 'pull2', 'push1', 'push2', 'bad']);
  }));

  check(await testAsync('a row is keyed by dirName, titled by name and opens /?view=git', async () => {
    const [row] = await gitRows([okRepo('lookout', { uncommitted: 1 })]);
    assert.deepStrictEqual([row.id, row.title, row.open], ['-p-lookout', 'lookout', '/?view=git']);
  }));

  check(await testAsync('each data read marks the Git view watched; the catalog does not', async () => {
    let n = 0;
    const hub = createDashboardHub(cfg(false), { sessions: () => [], git: async () => [], watchGit: () => { n++; } });
    await hub.handle({ method: 'GET', path: '/api/hub/widgets', query: new URLSearchParams() });
    assert.equal(n, 0);
    await hub.handle({ method: 'GET', path: '/api/hub/widgets/git', query: new URLSearchParams() });
    assert.equal(n, 1);
  }));

  console.log(`\nhub widgets: ${ok}/${total} passed`);
  return total - ok;
}
