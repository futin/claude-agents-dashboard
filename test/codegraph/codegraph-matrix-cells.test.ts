/**
 * `client/src/lib/codegraphMatrixCells.ts` and the two CodeGraph rules beside it in `codegraphLevels.ts`: the Matrix's four check columns, what counts as
 * indexing, and which repos Sync all behind posts to. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { CodegraphRepo, CodegraphStats } from '../../shared/types.js';
import { behindRepos, isIndexing, rankCodegraphRepos, type CodegraphAssessed } from '../../client/src/lib/codegraphLevels.js';
import { CODEGRAPH_NA_CELL, codegraphChecks, type CodegraphCell } from '../../client/src/lib/codegraphMatrixCells.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Ok = Extract<CodegraphRepo, { state: 'ok' }>;

/** Complete, current extractor, nothing pending: every case overrides a field of it. */
function stats(over: Partial<CodegraphStats> = {}): CodegraphStats {
  return {
    lastIndexedMs: 1_800_000_000_000, fileCount: 10, nodeCount: 100, edgeCount: 200, dbSizeBytes: 4096, nodesByKind: {}, languages: ['typescript'],
    pending: { added: 0, modified: 0, removed: 0 }, worktreeMismatch: null, version: '1.6.2', indexState: 'complete', reindexRecommended: false,
    builtWithVersion: '1.6.2', builtWithExtractionVersion: 27, currentExtractionVersion: 27, ...over,
  };
}

const base = (name: string) => ({
  dirName: name, name, path: `/p/${name}`, watching: false, watcherSinceMs: null, rebuildLive: false, run: null, lastRun: null,
});

function okRepo(name: string, s: Partial<CodegraphStats> = {}, over: Partial<Ok> = {}): Ok {
  return { ...base(name), state: 'ok', root: `/p/${name}`, stats: stats(s), ...over };
}

/** One repo read through the real Levels rules, so `level` and `problems` are what the view would hold. */
function assess(repo: CodegraphRepo): CodegraphAssessed {
  return rankCodegraphRepos([repo])[0];
}

const PENDING = { pending: { added: 2, modified: 1, removed: 0 } };
const RUN_SYNC = { kind: 'sync' as const, startedAtMs: 1 };
const RUN_REINDEX = { kind: 'reindex' as const, startedAtMs: 1 };
const cell = (c: CodegraphCell['c'], t: string): CodegraphCell => ({ c, t });

export function run(): number {
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };

  // behindRepos: the targets of Sync all behind
  check(test('behindRepos: a Worth a look repo with pending changes and nothing running is a target', () => {
    const a = assess(okRepo('a', PENDING));
    assert.strictEqual(a.level, 'look');
    assert.deepStrictEqual(behindRepos([a]).map(x => x.repo.name), ['a']);
  }));
  check(test('behindRepos: a run already in flight is skipped, since the POST would only 409', () => {
    assert.deepStrictEqual(behindRepos([assess(okRepo('a', PENDING, { run: RUN_SYNC }))]), []);
    assert.deepStrictEqual(behindRepos([assess(okRepo('b', PENDING, { run: RUN_REINDEX }))]), []);
  }));
  check(test('behindRepos: Worth a look for another reason (worktree) with no pending changes is not a target', () => {
    const a = assess(okRepo('a', { worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' } }));
    assert.strictEqual(a.level, 'look');
    assert.deepStrictEqual(behindRepos([a]), []);
  }));
  check(test('behindRepos: pending under a watcher is quiet, and a needs-you repo with pending is not Worth a look — neither is a target', () => {
    const watched = assess(okRepo('w', PENDING, { watching: true }));
    const needs = assess(okRepo('n', { ...PENDING, reindexRecommended: true, builtWithExtractionVersion: 26 }));
    assert.deepStrictEqual([watched.level, needs.level], ['quiet', 'needs']);
    assert.deepStrictEqual(behindRepos([watched, needs]), []);
  }));
  check(test('behindRepos: no repo behind returns an empty list, so Sync all sends nothing', () => {
    assert.deepStrictEqual(behindRepos([]), []);
    assert.deepStrictEqual(behindRepos([assess(okRepo('q'))]), []);
  }));
  check(test('behindRepos: a mixed ranking keeps only the targets, in rank order', () => {
    const ranked = rankCodegraphRepos([okRepo('q'), okRepo('a', PENDING), okRepo('r', PENDING, { run: RUN_SYNC }), okRepo('b', PENDING)]);
    assert.deepStrictEqual(behindRepos(ranked).map(x => x.repo.name), ['a', 'b']);
  }));

  // isIndexing
  check(test('isIndexing: a reindex run or a live rebuild is indexing; a sync run is not', () => {
    assert.strictEqual(isIndexing(assess(okRepo('a', {}, { run: RUN_REINDEX }))), true);
    assert.strictEqual(isIndexing(assess(okRepo('a', {}, { rebuildLive: true }))), true);
    assert.strictEqual(isIndexing(assess(okRepo('a', {}, { run: RUN_SYNC }))), false);
    assert.strictEqual(isIndexing(assess(okRepo('a'))), false);
  }));

  // codegraphChecks: Index · Changes · Extractor · Watcher
  check(test('checks: a clean quiet repo reads complete · none · its extractor · off, all grey', () => {
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('a'))), [cell('ok', 'complete'), cell('ok', 'none'), cell('ok', 'v27'), cell('ok', 'off')]);
  }));
  check(test('checks: the Index cell takes a problem pill first, even while a rebuild runs', () => {
    const a = assess(okRepo('a', { indexState: 'partial' }, { run: RUN_REINDEX }));
    assert.deepStrictEqual(codegraphChecks(a)[0], cell('bad', 'partial'));
  }));
  check(test('checks: with no index pill, a rebuild in flight reads Indexing…, otherwise complete', () => {
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('a', {}, { run: RUN_REINDEX })))[0], cell('live', 'Indexing…'));
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('a', {}, { rebuildLive: true })))[0], cell('live', 'Indexing…'));
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('a')))[0], cell('ok', 'complete'));
  }));
  check(test('checks: the worktree problem pills the Index cell mustard', () => {
    const a = assess(okRepo('a', { worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' } }));
    assert.deepStrictEqual(codegraphChecks(a)[0], cell('meh', 'other worktree'));
  }));
  check(test('checks: a repo that is not ok collapses the last three cells to NA', () => {
    const err: CodegraphRepo = { ...base('e'), state: 'error', root: '/p/e', message: 'boom' };
    assert.deepStrictEqual(codegraphChecks(assess(err)), [cell('bad', "can't read"), CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL]);
    const building: CodegraphRepo = { ...base('b'), state: 'building', root: '/p/b', run: RUN_REINDEX };
    assert.deepStrictEqual(codegraphChecks(assess(building)), [cell('live', 'Indexing…'), CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL]);
    const idle: CodegraphRepo = { ...base('i'), state: 'building', root: '/p/i' };
    assert.deepStrictEqual(codegraphChecks(assess(idle)), [CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL, CODEGRAPH_NA_CELL]);
  }));
  check(test('checks: pending changes with no watcher pill the Changes cell with the summed count', () => {
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('a', PENDING)))[1], cell('meh', '3 pending'));
  }));
  check(test('checks: pending changes under a watcher are grey text with the count, and Watcher reads on', () => {
    const a = assess(okRepo('a', { pending: { added: 0, modified: 0, removed: 4 } }, { watching: true }));
    const cells = codegraphChecks(a);
    assert.deepStrictEqual([cells[1], cells[3]], [cell('ok', '4 pending'), cell('ok', 'on')]);
  }));
  check(test('checks: a reindex-recommended repo pills the Extractor cell with the version step', () => {
    const a = assess(okRepo('a', { reindexRecommended: true, builtWithExtractionVersion: 26 }));
    assert.deepStrictEqual(codegraphChecks(a)[2], cell('bad', 'v26 → v27'));
  }));
  check(test('checks: Watcher off dims only on a Worth a look repo', () => {
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('look', PENDING)))[3], cell('dim', 'off'));
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('quiet')))[3], cell('ok', 'off'));
    assert.deepStrictEqual(codegraphChecks(assess(okRepo('needs', { reindexRecommended: true })))[3], cell('ok', 'off'));
  }));

  console.log(`\ncodegraph-matrix-cells: ${pass}/${total} passed`);
  return total - pass;
}
