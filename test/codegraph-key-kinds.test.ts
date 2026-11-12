/**
 * `codegraphKeyKinds` (client/src/lib/codegraphLevels.ts): which of Sync / Reindex a CodeGraph repo row offers. Reindex throws the DB away, so the set matters.
 */
import assert from 'node:assert';

import { codegraphKeyKinds, type CodegraphAssessed, type CodegraphProblemKey } from '../client/src/lib/codegraphLevels.js';
import type { CodegraphLastRun, CodegraphRepo, CodegraphRun } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function assessed(level: CodegraphAssessed['level'], keys: CodegraphProblemKey[], repo: { run?: CodegraphRun | null; lastRun?: CodegraphLastRun | null } = {}): CodegraphAssessed {
  const r = { dirName: 'r', name: 'r', path: '/p/r', state: 'ok', run: repo.run ?? null, lastRun: repo.lastRun ?? null } as unknown as CodegraphRepo;
  return { repo: r, problems: keys.map(key => ({ key, sev: 3 as const })), level, order: 0 };
}

const failed = (kind: 'sync' | 'reindex'): CodegraphLastRun => ({ kind, ok: false, endedAtMs: 1, message: 'boom' });

export function run(): number {
  console.log('\n=== codegraphKeyKinds (client/src/lib/codegraphLevels.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('not indexed: no keys, even with a run in flight', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('none', [])), []);
    assert.deepStrictEqual(codegraphKeyKinds(assessed('none', [], { run: { kind: 'reindex', startedAtMs: 1 } })), []);
  }));
  tally(test('quiet: Sync only', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('quiet', [])), ['sync']);
  }));
  tally(test('pending changes alone: Sync only', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('look', ['pending'])), ['sync']);
  }));
  tally(test('any other problem: Reindex only', () => {
    for (const k of ['reindex', 'partial', 'failed', 'unfinished', 'error', 'worktree'] as const) {
      assert.deepStrictEqual(codegraphKeyKinds(assessed('needs', [k])), ['reindex'], k);
    }
  }));
  tally(test('pending plus another problem: Sync before Reindex', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('needs', ['pending', 'partial'])), ['sync', 'reindex']);
  }));
  tally(test('a failed last sync offers Sync again beside Reindex; a failed last reindex offers Reindex only', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('needs', ['lastRun'], { lastRun: failed('sync') })), ['sync', 'reindex']);
    assert.deepStrictEqual(codegraphKeyKinds(assessed('needs', ['lastRun'], { lastRun: failed('reindex') })), ['reindex']);
  }));
  tally(test('the kind of a run in flight always shows', () => {
    assert.deepStrictEqual(codegraphKeyKinds(assessed('needs', ['partial'], { run: { kind: 'sync', startedAtMs: 1 } })), ['sync', 'reindex']);
    assert.deepStrictEqual(codegraphKeyKinds(assessed('quiet', [], { run: { kind: 'reindex', startedAtMs: 1 } })), ['sync', 'reindex']);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
