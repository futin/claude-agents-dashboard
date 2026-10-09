/**
 * The dashboard's two Lookout hub widgets (hub-widgets spec §4): `usage` (gauge) and `sessions` (list), declared through `lookout-widgets` and fed by
 * injected getters, so nothing here touches the network or the real transcript dir.
 */

import assert from 'node:assert';

import { checkWidgets } from 'lookout-widgets/testkit';

import { testAsync } from './api-harness.js';
import { createDashboardHub } from '../server/lib/hub-widgets.js';
import type { Config } from '../server/lib/config.js';
import type { UsageState } from '../server/lib/usage.js';
import type { RateLimit, Session, UsageLimits } from '../shared/types.js';

const cfg = (showUsage: boolean): Config => ({ showUsage }) as Config;
const win = (utilization: number | null, resetsAt: string | null): RateLimit => ({ utilization, resetsAt }) as RateLimit;
const limits = (five: RateLimit, seven: RateLimit): UsageLimits => ({ fiveHour: five, sevenDay: seven });
const OK: UsageState = { usage: limits(win(42, '2026-10-08T05:00:00Z'), win(10, '2026-10-12T00:00:00Z')), status: 'ok' };

const session = (over: Partial<Session>): Session =>
  ({ id: 'abc', project: 'dash', sessionName: null, gitBranch: null, model: 'opus', contextPct: 41.6, status: 'idle', ...over }) as Session;

const get = (usage: UsageState, sessions: Session[] = [session({})], showUsage = true) =>
  (path: string) => createDashboardHub(cfg(showUsage), { usage: () => usage, sessions: () => sessions })
    .handle({ method: 'GET', path, query: new URLSearchParams() });

export async function run(): Promise<number> {
  console.log('\n=== hub widgets (lookout-widgets) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('checkWidgets over both widgets finds nothing wrong', async () => {
    const hub = createDashboardHub(cfg(true), { usage: () => OK, sessions: () => [session({}), session({ id: 'x/y', status: 'working' })] });
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
    assert.deepStrictEqual(((await g('/api/hub/widgets'))?.json as { widgets: { id: string }[] }).widgets.map(w => w.id), ['sessions']);
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

  console.log(`\nhub widgets: ${ok}/${total} passed`);
  return total - ok;
}
