/**
 * `client/src/lib/gitMatrixCells.ts`: the Git Matrix's six check columns (Working tree · Push · Pull · Prune · Open branches · Fetched), whether a row has
 * work for Sync, and the header's repo count. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { FetchClock, GitBranch, RepoGitStats } from '../../shared/types.js';
import { assessGitRepo, STALE_IDLE_MS } from '../../client/src/lib/gitLevels.js';
import { MATRIX_COLUMNS, matrixCells, matrixHeaderCount, matrixRowHasWork, type MatrixCell } from '../../client/src/lib/gitMatrixCells.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<RepoGitStats, { state: 'ok' }>;

const NOW = 1_800_000_000_000;

/** Clean, level with origin, on main, no branches: every case overrides a field of it. */
function okRepo(over: Partial<Ok> = {}): Ok {
  return {
    dirName: '-r', name: 'repo', path: '/r', state: 'ok', toplevel: '/r', branch: 'main', detachedSha: null, onTrunk: true, uncommitted: 0,
    trunk: 'main', hasOrigin: true, originUrl: null, trunkVsOrigin: { ahead: 0, behind: 0 }, trunkRefs: { local: true, origin: true },
    trunkCheckedOutElsewhere: false, currentVsUpstream: null, fetchedAtMs: null, lastFetch: null, branches: [], unmergedTotal: 0, mergedCount: 0,
    ...over,
  };
}

function br(name: string, over: Partial<GitBranch> = {}): GitBranch {
  return { name, ahead: 1, behind: 0, lastCommitMs: NOW, worktreePath: null, ...over };
}

/** On `feat/x` tracking `origin/feat/x` with the given counts (null: the upstream is gone). */
const onFeat = (counts: { ahead: number; behind: number } | null): Partial<Ok> => ({
  branch: 'feat/x', onTrunk: false, currentVsUpstream: { upstream: 'origin/feat/x', counts },
});

function cells(repo: Ok, clock?: FetchClock): MatrixCell[] {
  return matrixCells({ a: assessGitRepo(repo, [], NOW), repo, nowMs: NOW, clock });
}
const col = (name: (typeof MATRIX_COLUMNS)[number]) => MATRIX_COLUMNS.indexOf(name);
const cell = (repo: Ok, name: (typeof MATRIX_COLUMNS)[number]) => cells(repo)[col(name)];

export function run(): number {
  console.log('\n=== git matrix cells (lib/gitMatrixCells.ts) ===\n');
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };

  check(test('the six columns, in order', () => {
    assert.deepStrictEqual([...MATRIX_COLUMNS], ['Working tree', 'Push', 'Pull', 'Prune', 'Open branches', 'Fetched']);
  }));

  // Working tree
  check(test('working tree: clean → ok "clean"', () => assert.deepStrictEqual(cell(okRepo(), 'Working tree'), { c: 'ok', t: 'clean' })));
  check(test('working tree: 3 uncommitted → bad "3 uncommitted"', () => {
    assert.deepStrictEqual(cell(okRepo({ uncommitted: 3 }), 'Working tree'), { c: 'bad', t: '3 uncommitted' });
  }));

  // Push: trunk first, then the checked-out branch, each naming its branch
  check(test('push: main 1 ahead of origin → meh "1 on main"', () => {
    assert.deepStrictEqual(cell(okRepo({ trunkVsOrigin: { ahead: 1, behind: 0 } }), 'Push'), { c: 'meh', t: '1 on main' });
  }));
  check(test('push: feat/x 2 ahead of its upstream → meh "2 on feat/x"', () => {
    assert.deepStrictEqual(cell(okRepo(onFeat({ ahead: 2, behind: 0 })), 'Push'), { c: 'meh', t: '2 on feat/x' });
  }));
  check(test('push: main 3 ahead and feat/x 2 ahead → "3 on main · 2 on feat/x"', () => {
    assert.deepStrictEqual(cell(okRepo({ ...onFeat({ ahead: 2, behind: 0 }), trunkVsOrigin: { ahead: 3, behind: 0 } }), 'Push'),
      { c: 'meh', t: '3 on main · 2 on feat/x' });
  }));
  check(test('push: the upstream is gone → meh "origin/feat/x gone"', () => {
    assert.deepStrictEqual(cell(okRepo(onFeat(null)), 'Push'), { c: 'meh', t: 'origin/feat/x gone' });
  }));
  check(test('push: no origin → meh "no remote"', () => {
    assert.deepStrictEqual(cell(okRepo({ hasOrigin: false, trunkVsOrigin: null }), 'Push'), { c: 'meh', t: 'no remote' });
  }));
  check(test('push: level → ok "nothing"', () => assert.deepStrictEqual(cell(okRepo(), 'Push'), { c: 'ok', t: 'nothing' })));

  // Pull
  check(test('pull: main 4 behind → bad "4 on main"', () => {
    assert.deepStrictEqual(cell(okRepo({ trunkVsOrigin: { ahead: 0, behind: 4 } }), 'Pull'), { c: 'bad', t: '4 on main' });
  }));
  check(test('pull: main 4 behind and feat/x 5 behind → "4 on main · 5 on feat/x"', () => {
    assert.deepStrictEqual(cell(okRepo({ ...onFeat({ ahead: 0, behind: 5 }), trunkVsOrigin: { ahead: 0, behind: 4 } }), 'Pull'),
      { c: 'bad', t: '4 on main · 5 on feat/x' });
  }));
  check(test('pull: no origin → na "—"', () => {
    assert.deepStrictEqual(cell(okRepo({ hasOrigin: false, trunkVsOrigin: null }), 'Pull'), { c: 'na', t: '—' });
  }));
  check(test('pull: level → ok "up to date"', () => assert.deepStrictEqual(cell(okRepo(), 'Pull'), { c: 'ok', t: 'up to date' })));

  // Prune: the merged branches the old Branches cell never counted
  check(test('prune: 2 merged → meh "2 merged"', () => {
    assert.deepStrictEqual(cell(okRepo({ mergedCount: 2 }), 'Prune'), { c: 'meh', t: '2 merged' });
  }));
  check(test('prune: none merged → ok "nothing"', () => assert.deepStrictEqual(cell(okRepo(), 'Prune'), { c: 'ok', t: 'nothing' })));

  // Open branches: a plain count, stale as a note, never a pill
  check(test('open branches: 1 unmerged, stale → plain "1" with note "1 stale"', () => {
    const stale = br('old', { lastCommitMs: NOW - STALE_IDLE_MS - 1 });
    assert.deepStrictEqual(cell(okRepo({ branches: [stale], unmergedTotal: 1 }), 'Open branches'), { c: 'plain', t: '1', note: '1 stale' });
  }));
  check(test('open branches: 2 unmerged, none stale → plain "2", no note', () => {
    assert.deepStrictEqual(cell(okRepo({ branches: [br('a'), br('b')], unmergedTotal: 2 }), 'Open branches'), { c: 'plain', t: '2' });
  }));
  check(test('open branches: none → na "0"', () => assert.deepStrictEqual(cell(okRepo(), 'Open branches'), { c: 'na', t: '0' })));

  // Fetched (the old Origin data, unchanged)
  check(test('fetched: never → na "never"', () => assert.deepStrictEqual(cell(okRepo(), 'Fetched'), { c: 'na', t: 'never' })));
  check(test('fetched: a fetch running → live "fetching…"', () => {
    const clock = { runningSinceMs: NOW } as FetchClock;
    assert.deepStrictEqual(cells(okRepo(), clock)[col('Fetched')], { c: 'live', t: 'fetching…' });
  }));

  // Row work: what turns the Sync key amber
  check(test('row work: clean and level → no work', () => assert.strictEqual(matrixRowHasWork(cells(okRepo())), false)));
  check(test('row work: only merged branches → work', () => assert.strictEqual(matrixRowHasWork(cells(okRepo({ mergedCount: 1 }))), true)));
  check(test('row work: main ahead → work', () => {
    assert.strictEqual(matrixRowHasWork(cells(okRepo({ trunkVsOrigin: { ahead: 1, behind: 0 } }))), true);
  }));
  check(test('row work: uncommitted → work', () => assert.strictEqual(matrixRowHasWork(cells(okRepo({ uncommitted: 2 }))), true)));
  check(test('row work: open (unmerged) branches alone, even stale → no work', () => {
    const stale = br('old', { lastCommitMs: NOW - STALE_IDLE_MS - 1 });
    assert.strictEqual(matrixRowHasWork(cells(okRepo({ branches: [stale, br('b')], unmergedTotal: 2 }))), false);
  }));

  // Header count: repos, said as repos
  check(test('header count: 0 → empty', () => assert.strictEqual(matrixHeaderCount(0), '')));
  check(test('header count: 1 → "1 repo"', () => assert.strictEqual(matrixHeaderCount(1), '1 repo')));
  check(test('header count: 3 → "3 repos"', () => assert.strictEqual(matrixHeaderCount(3), '3 repos')));

  console.log(`\n  ${pass}/${total} passed`);
  return total - pass;
}
