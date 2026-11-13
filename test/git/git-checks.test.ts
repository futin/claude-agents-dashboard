/**
 * The Git Inspector pane's check tiles (`client/src/lib/gitChecks.ts`): one case per branch of Your branch, plus Working tree, Trunk, Origin data and State.
 * Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { FetchClock, RepoGitStats } from '../../shared/types.js';
import { formatAgo } from '../../client/src/lib/format.js';
import { originData, stateCheck, trunk, workingTree, yourBranch } from '../../client/src/lib/gitChecks.js';
import type { GitAssessed } from '../../client/src/lib/gitLevels.js';
import { gitStateSentence, gitTrunkVsOriginText } from '../../client/src/lib/gitStatsText.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

/** A clean, level, no-branch repo on main with an origin: the quiet baseline every case overrides one field of. */
function okRepo(over: Partial<Ok> = {}): Ok {
  return {
    dirName: 'r', name: 'r', path: '/p/r', state: 'ok', toplevel: '/p/r',
    branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
    trunk: 'main', hasOrigin: true, originUrl: null,
    trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true }, trunkCheckedOutElsewhere: false, currentVsUpstream: null,
    fetchedAtMs: null, lastFetch: null, branches: [], unmergedTotal: 0, mergedCount: 0,
    ...over,
  };
}

/** A feature branch off trunk with `upstream` tracking it. */
function onFeature(upstream: Ok['currentVsUpstream']): Ok {
  return okRepo({ branch: 'feat', onTrunk: false, currentVsUpstream: upstream });
}

function assessed(repo: RepoGitStats, problems: GitAssessed['problems'] = []): GitAssessed {
  return { repo, problems, level: problems.length ? 'needs' : 'quiet', weight: 0, verbs: [] };
}

const CLOCK: FetchClock = { intervalSecs: 300, nextAtMs: null, runningSinceMs: null, lastEndedMs: null };

export function run(): number {
  console.log('\n=== gitChecks.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  // ── Your branch: one case per branch ─────────────────────────────────────
  tally(test('yourBranch: detached HEAD → meh, names the sha', () => {
    assert.deepStrictEqual(yourBranch(okRepo({ branch: null, detachedSha: 'abc1234', onTrunk: false })),
      { k: 'Your branch', c: 'meh', v: 'Detached at abc1234', h: 'Check out a branch before committing.' });
  }));
  tally(test('yourBranch: on trunk → ok, branch name', () => {
    assert.deepStrictEqual(yourBranch(okRepo()), { k: 'Your branch', c: 'ok', v: 'main', h: 'On trunk, tracked beside.' });
  }));
  tally(test('yourBranch: feature branch with no upstream → ok, "No upstream set."', () => {
    assert.deepStrictEqual(yourBranch(onFeature(null)), { k: 'Your branch', c: 'ok', v: 'feat', h: 'No upstream set.' });
  }));
  tally(test('yourBranch: tracking origin/<trunk> → ok, never counted as ahead/behind', () => {
    assert.deepStrictEqual(yourBranch(onFeature({ upstream: 'origin/main', counts: { ahead: 3, behind: 2 } })),
      { k: 'Your branch', c: 'ok', v: 'feat', h: 'Tracks origin/main.' });
  }));
  tally(test('yourBranch: upstream gone (counts null) → meh, "<upstream> gone"', () => {
    assert.deepStrictEqual(yourBranch(onFeature({ upstream: 'origin/feat', counts: null })),
      { k: 'Your branch', c: 'meh', v: 'origin/feat gone', h: 'Its upstream is gone; push to set a new one.' });
  }));
  tally(test('yourBranch: behind its upstream → bad, "Pull before you push." (behind outranks ahead)', () => {
    assert.deepStrictEqual(yourBranch(onFeature({ upstream: 'origin/feat', counts: { ahead: 1, behind: 2 } })),
      { k: 'Your branch', c: 'bad', v: '↓2 ↑1 vs origin/feat', h: 'Pull before you push.' });
  }));
  tally(test('yourBranch: only ahead → meh, "Commits on this machine only."', () => {
    assert.deepStrictEqual(yourBranch(onFeature({ upstream: 'origin/feat', counts: { ahead: 4, behind: 0 } })),
      { k: 'Your branch', c: 'meh', v: '↓0 ↑4 vs origin/feat', h: 'Commits on this machine only.' });
  }));
  tally(test('yourBranch: level with upstream → ok, "In step."', () => {
    assert.deepStrictEqual(yourBranch(onFeature({ upstream: 'origin/feat', counts: { ahead: 0, behind: 0 } })),
      { k: 'Your branch', c: 'ok', v: '↓0 ↑0 vs origin/feat', h: 'In step.' });
  }));
  tally(test('yourBranch: a repo with no trunk never matches origin/<trunk>', () => {
    assert.strictEqual(yourBranch(okRepo({ branch: 'feat', onTrunk: false, trunk: null, currentVsUpstream: { upstream: 'origin/null', counts: { ahead: 0, behind: 1 } } })).c, 'bad');
  }));

  // ── Working tree ─────────────────────────────────────────────────────────
  tally(test('workingTree: clean → ok', () => {
    const r = okRepo();
    assert.deepStrictEqual(workingTree(assessed(r), r, false), { k: 'Working tree', c: 'ok', v: 'Clean', h: 'Nothing to commit.' });
  }));
  tally(test('workingTree: dirty with the calm flag (an agent is working) → meh', () => {
    const r = okRepo({ uncommitted: 3 });
    const a = assessed(r, [{ sev: 1, k: 'dirty', short: '', text: '', calm: true }]);
    assert.deepStrictEqual(workingTree(a, r, true), { k: 'Working tree', c: 'meh', v: '3 uncommitted', h: 'An agent is working here, so this is expected.' });
  }));
  tally(test('workingTree: dirty, agent on the branch but not working → bad, says so', () => {
    const r = okRepo({ uncommitted: 2 });
    const a = assessed(r, [{ sev: 3, k: 'dirty', short: '', text: '' }]);
    assert.deepStrictEqual(workingTree(a, r, true), { k: 'Working tree', c: 'bad', v: '2 uncommitted', h: 'An agent is on this branch but not working. Commit or stash.' });
  }));
  tally(test('workingTree: dirty, nobody on the branch → bad', () => {
    const r = okRepo({ uncommitted: 1 });
    assert.strictEqual(workingTree(assessed(r, [{ sev: 3, k: 'dirty', short: '', text: '' }]), r, false).h, 'Nobody is on this branch. Commit or stash.');
  }));

  // ── Trunk ────────────────────────────────────────────────────────────────
  tally(test('trunk: no comparison and an origin → ok, the copy table text', () => {
    const r = okRepo({ trunkVsOrigin: null });
    assert.deepStrictEqual(trunk(r), { k: 'Trunk', c: 'ok', v: gitTrunkVsOriginText(r) });
  }));
  tally(test('trunk: no remote → meh, "Nothing here is backed up."', () => {
    assert.deepStrictEqual(trunk(okRepo({ trunkVsOrigin: null, hasOrigin: false })), { k: 'Trunk', c: 'meh', v: 'No remote', h: 'Nothing here is backed up.' });
  }));
  tally(test('trunk: behind origin → meh, stale hint; ahead only → meh, origin-lacks hint', () => {
    assert.deepStrictEqual(trunk(okRepo({ trunkVsOrigin: { ahead: 1, behind: 2 } })),
      { k: 'Trunk', c: 'meh', v: 'main ↓2 ↑1', h: 'Local main is stale; new branches would start old.' });
    assert.deepStrictEqual(trunk(okRepo({ trunkVsOrigin: { ahead: 3, behind: 0 } })),
      { k: 'Trunk', c: 'meh', v: 'main ↑3', h: 'Local main has commits origin lacks.' });
  }));
  tally(test('trunk: level with origin → ok', () => {
    assert.deepStrictEqual(trunk(okRepo()), { k: 'Trunk', c: 'ok', v: 'main = origin', h: 'In step with origin.' });
  }));

  // ── Origin data ──────────────────────────────────────────────────────────
  tally(test('originData: a shown fetch error → bad, its age, trouble word and hint; never fetched reads "never"', () => {
    const c = originData(okRepo({ lastFetch: { atMs: 1, error: 'auth' } }), CLOCK);
    assert.strictEqual(c.c, 'bad');
    assert.match(c.v, /^never old · /);
    assert.strictEqual(c.h, 'Run gh auth login in a terminal, then Retry fetch.');
  }));
  tally(test("originData: a 'lock' error is not shown — falls through to the age", () => {
    const at = Date.now() - 60_000;
    assert.deepStrictEqual(originData(okRepo({ fetchedAtMs: at, lastFetch: { atMs: at, error: 'lock' } }), CLOCK),
      { k: 'Origin data', c: 'ok', v: `${formatAgo(at)} old`, h: 'Auto-fetch every 5 min.' });
  }));
  tally(test('originData: a running fetch → live "fetching…", only for a repo with an origin', () => {
    const running = { ...CLOCK, runningSinceMs: 1 };
    assert.deepStrictEqual(originData(okRepo(), running), { k: 'Origin data', c: 'live', v: 'fetching…' });
    assert.notStrictEqual(originData(okRepo({ hasOrigin: false }), running).c, 'live');
  }));
  tally(test('originData: fetched, auto-fetch off or no clock → "Auto-fetch is off."', () => {
    const at = Date.now() - 60_000;
    assert.strictEqual(originData(okRepo({ fetchedAtMs: at }), { ...CLOCK, intervalSecs: 0 }).h, 'Auto-fetch is off.');
    assert.strictEqual(originData(okRepo({ fetchedAtMs: at }), undefined).h, 'Auto-fetch is off.');
  }));
  tally(test('originData: never fetched → ok, hint says why', () => {
    assert.deepStrictEqual(originData(okRepo(), CLOCK), { k: 'Origin data', c: 'ok', v: 'Never fetched', h: 'Not fetched yet.' });
    assert.strictEqual(originData(okRepo({ hasOrigin: false }), CLOCK).h, 'No remote to fetch.');
  }));

  // ── State ────────────────────────────────────────────────────────────────
  tally(test('stateCheck: missing / not-git / error each get their own hint, the sentence from the copy table', () => {
    const pin = { dirName: 'r', name: 'r', path: '/p/r' };
    const missing = { ...pin, state: 'missing' as const };
    const notGit = { ...pin, state: 'not-git' as const };
    const error = { ...pin, state: 'error' as const, message: 'boom' };
    assert.deepStrictEqual(stateCheck(missing),
      { k: 'State', c: 'meh', v: gitStateSentence(missing), h: 'The folder moved or was deleted. Unpin it, or pin it again at its new path under Projects.' });
    assert.strictEqual(stateCheck(notGit).h, 'No .git above this folder. Pin the repo root instead.');
    assert.strictEqual(stateCheck(error).h, 'Git failed reading it; the next poll tries again.');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
