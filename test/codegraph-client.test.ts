/**
 * Client domain logic of the Management › CodeGraph sub-view (`client/src/lib/codegraphLevels.ts`, `codegraphText.ts`, `codegraphLayouts.ts`): the Levels table
 * of the design spec, its copy table, the layout switcher's rules and the settings the view owns. All pure, so no React and no DOM.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import type { CodegraphRepo, CodegraphStats } from '../shared/types.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';
import { clampSettings } from '../client/src/lib/settings.js';
import {
  CODEGRAPH_LEVELS, CODEGRAPH_LEVEL_DOT, codegraphLevelOf, codegraphProblems, kindGroups, rankCodegraphRepos,
} from '../client/src/lib/codegraphLevels.js';
import {
  CODEGRAPH_BUILDING_LINE, CODEGRAPH_CLI_MISSING, CODEGRAPH_FOLDER_GONE, CODEGRAPH_NEEDS_TOKEN, CODEGRAPH_NO_PINS, CODEGRAPH_NOT_INDEXED, CODEGRAPH_UP_TO_DATE,
  CODEGRAPH_KEY_REINDEX, CODEGRAPH_KEY_REINDEXING, CODEGRAPH_KEY_SYNC, CODEGRAPH_KEY_SYNCING,
  codegraphChip, codegraphFirstLoadText, codegraphPill, codegraphQuietLine, codegraphRunConflictText, codegraphRunFailedText, codegraphRunMissingText,
  codegraphSteps, codegraphVerdict, compactCount, extractorCell, formatDbSize, reindexConfirmText,
  CODEGRAPH_BAND_SUB, CODEGRAPH_BAND_TITLE, CODEGRAPH_EXTRACTOR_UNKNOWN, FACT_CHANGES_NONE, FACT_WATCHER_OFF, FACT_WATCHER_ON,
  ROW_REREAD, ROW_REREAD_SUB, ROW_SYNC_ALL, ROW_SYNC_ALL_NEEDS_TOKEN_SUB, ROW_SYNC_ALL_NONE_SUB, changesFact, codegraphKeyAria, fullCount, indexedAge,
  languagesFact, lastIndexedFact, rowSyncAllSub, watcherFact, watchersValue,
} from '../client/src/lib/codegraphText.js';
import { CODEGRAPH_FAST_POLL_MS, hasLiveRun, runNote } from '../client/src/lib/codegraphPoll.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';
import { GIT_NO_PINS } from '../client/src/lib/gitStatsText.js';
import {
  CODEGRAPH_LAYOUTS, DEFAULT_CODEGRAPH_LAYOUT, codegraphLayoutsFor, drawableCodegraphLayout, parseCodegraphLayout,
} from '../client/src/lib/codegraphLayouts.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/codegraph-status-1.6.2.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-19T10:14:07.660Z');

type Ok = Extract<CodegraphRepo, { state: 'ok' }>;

/** The fixture's real 1.6.2 numbers as the server's typed stats: the clean, complete, current-extractor baseline. */
function stats(over: Partial<CodegraphStats> = {}): CodegraphStats {
  return {
    lastIndexedMs: Date.parse(FIXTURE.lastIndexed), fileCount: FIXTURE.fileCount, nodeCount: FIXTURE.nodeCount, edgeCount: FIXTURE.edgeCount,
    dbSizeBytes: FIXTURE.dbSizeBytes, nodesByKind: FIXTURE.nodesByKind, languages: FIXTURE.languages,
    pending: { added: 0, modified: 0, removed: 0 }, worktreeMismatch: null, version: FIXTURE.version, indexState: 'complete',
    reindexRecommended: false, builtWithVersion: '1.6.2', builtWithExtractionVersion: 27, currentExtractionVersion: 27,
    ...over,
  };
}

const base = (name: string) => ({
  dirName: name, name, path: `/p/${name}`, watching: false, watcherSinceMs: null, rebuildLive: false, run: null, lastRun: null,
});

function okRepo(name: string, s: Partial<CodegraphStats> = {}, over: Partial<Ok> = {}): Ok {
  return { ...base(name), state: 'ok', root: `/p/${name}`, stats: stats(s), ...over };
}

function keysOf(r: CodegraphRepo): string[] { return codegraphProblems(r).map(p => p.key); }
function levelOf(r: CodegraphRepo) { return codegraphLevelOf(r, codegraphProblems(r)); }

export function run(): number {
  let p = 0, f = 0;
  console.log('\ncodegraph client logic');

  // ── levels: one case per row of the spec's Levels table ───────────────────
  if (test('reindexRecommended is needs (sev 3), watcher or not', () => {
    const r = okRepo('a', { reindexRecommended: true });
    assert.deepStrictEqual(codegraphProblems(r), [{ key: 'reindex', sev: 3 }]);
    assert.strictEqual(levelOf(r), 'needs');
    assert.strictEqual(levelOf({ ...r, watching: true }), 'needs');
  })) p++; else f++;

  if (test('indexState partial and failed are needs', () => {
    assert.deepStrictEqual(codegraphProblems(okRepo('a', { indexState: 'partial' })), [{ key: 'partial', sev: 3 }]);
    assert.deepStrictEqual(codegraphProblems(okRepo('a', { indexState: 'failed' })), [{ key: 'failed', sev: 3 }]);
    assert.strictEqual(levelOf(okRepo('a', { indexState: 'partial' })), 'needs');
    assert.strictEqual(levelOf(okRepo('a', { indexState: 'failed' })), 'needs');
  })) p++; else f++;

  if (test('indexing with no live rebuild is needs (unfinished); with a live rebuild it is quiet and adds no problem', () => {
    const at = okRepo('a', { indexState: 'indexing' });
    assert.deepStrictEqual(codegraphProblems(at), [{ key: 'unfinished', sev: 3 }]);
    assert.strictEqual(levelOf(at), 'needs');
    const live = okRepo('a', { indexState: 'indexing' }, { rebuildLive: true });
    assert.deepStrictEqual(codegraphProblems(live), []);
    assert.strictEqual(levelOf(live), 'quiet');
  })) p++; else f++;

  if (test("state 'error' is needs", () => {
    const r: CodegraphRepo = { ...base('a'), state: 'error', root: '/p/a', message: 'boom' };
    assert.deepStrictEqual(codegraphProblems(r), [{ key: 'error', sev: 3 }]);
    assert.strictEqual(levelOf(r), 'needs');
  })) p++; else f++;

  if (test('a failed lastRun is needs; a successful one, even "watcher is syncing it", is no problem', () => {
    const failed = okRepo('a', {}, { lastRun: { kind: 'sync', ok: false, endedAtMs: NOW, message: 'bad' } });
    assert.deepStrictEqual(codegraphProblems(failed), [{ key: 'lastRun', sev: 3 }]);
    assert.strictEqual(levelOf(failed), 'needs');
    const watcher = okRepo('a', {}, { lastRun: { kind: 'sync', ok: true, endedAtMs: NOW, message: 'watcher is syncing it' } });
    assert.deepStrictEqual(codegraphProblems(watcher), []);
    assert.strictEqual(levelOf(watcher), 'quiet');
  })) p++; else f++;

  if (test('pending changes with no watcher are look (sev 2); with a watcher they are quiet', () => {
    const pending = { added: 3, modified: 4, removed: 0 };
    const r = okRepo('a', { pending });
    assert.deepStrictEqual(codegraphProblems(r), [{ key: 'pending', sev: 2 }]);
    assert.strictEqual(levelOf(r), 'look');
    const watched = okRepo('a', { pending }, { watching: true });
    assert.deepStrictEqual(codegraphProblems(watched), []);
    assert.strictEqual(levelOf(watched), 'quiet');
  })) p++; else f++;

  if (test('worktreeMismatch is look', () => {
    const r = okRepo('a', { worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' } });
    assert.deepStrictEqual(codegraphProblems(r), [{ key: 'worktree', sev: 2 }]);
    assert.strictEqual(levelOf(r), 'look');
  })) p++; else f++;

  if (test('a clean ok repo and a building repo are quiet with no problems; none and missing are the none level', () => {
    assert.deepStrictEqual(codegraphProblems(okRepo('a')), []);
    assert.strictEqual(levelOf(okRepo('a')), 'quiet');
    const building: CodegraphRepo = { ...base('a'), state: 'building', root: '/p/a', rebuildLive: true, run: { kind: 'reindex', startedAtMs: NOW } };
    assert.deepStrictEqual(codegraphProblems(building), []);
    assert.strictEqual(levelOf(building), 'quiet');
    const none: CodegraphRepo = { ...base('a'), state: 'none' };
    const missing: CodegraphRepo = { ...base('a'), state: 'missing', path: null };
    assert.deepStrictEqual(codegraphProblems(none), []);
    assert.strictEqual(levelOf(none), 'none');
    assert.strictEqual(levelOf(missing), 'none');
  })) p++; else f++;

  if (test('problems come in the table order, sev 3 before sev 2', () => {
    const r = okRepo('a', {
      reindexRecommended: true, indexState: 'partial', pending: { added: 1, modified: 0, removed: 0 }, worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' },
    }, { lastRun: { kind: 'reindex', ok: false, endedAtMs: NOW, message: 'x' } });
    assert.deepStrictEqual(keysOf(r), ['reindex', 'partial', 'lastRun', 'pending', 'worktree']);
  })) p++; else f++;

  if (test('the four tiles read Needs you, Worth a look, All good, Not indexed, with Git\'s dot classes', () => {
    assert.deepStrictEqual(CODEGRAPH_LEVELS, [
      { key: 'needs', label: 'Needs you' }, { key: 'look', label: 'Worth a look' }, { key: 'quiet', label: 'All good' }, { key: 'none', label: 'Not indexed' },
    ]);
    assert.deepStrictEqual(CODEGRAPH_LEVEL_DOT, { needs: 'needs', look: 'flight', quiet: 'quiet', none: 'dead' });
  })) p++; else f++;

  // ── ranking ───────────────────────────────────────────────────────────────
  if (test('rank: level first, then summed severity, then pin order: [quiet A, none B, needs C, look D, needs E x2] -> E C D A B', () => {
    const A = okRepo('A');
    const B: CodegraphRepo = { ...base('B'), state: 'none' };
    const C = okRepo('C', { indexState: 'failed' });
    const D = okRepo('D', { pending: { added: 1, modified: 0, removed: 0 } });
    const E = okRepo('E', { indexState: 'failed', reindexRecommended: true });
    const ranked = rankCodegraphRepos([A, B, C, D, E]);
    assert.deepStrictEqual(ranked.map(a => a.repo.name), ['E', 'C', 'D', 'A', 'B']);
    assert.deepStrictEqual(ranked.map(a => a.level), ['needs', 'needs', 'look', 'quiet', 'none']);
    assert.deepStrictEqual(ranked.map(a => a.order), [4, 2, 3, 0, 1]);
    assert.deepStrictEqual(ranked[0]!.problems.map(x => x.key), ['reindex', 'failed']);
  })) p++; else f++;

  if (test('rank: equal repos keep pin order', () => {
    const ranked = rankCodegraphRepos([okRepo('x'), okRepo('y'), okRepo('z')]);
    assert.deepStrictEqual(ranked.map(a => a.repo.name), ['x', 'y', 'z']);
  })) p++; else f++;

  // ── copy ──────────────────────────────────────────────────────────────────
  if (test('reindex verdict names both extractor versions; chip, pill and steps match the spec table', () => {
    const r = okRepo('a', { reindexRecommended: true, builtWithExtractionVersion: 26, currentExtractionVersion: 27 });
    const prob = { key: 'reindex', sev: 3 } as const;
    assert.strictEqual(codegraphVerdict(prob, r),
      'Built by an older codegraph extractor (v26, now v27). Queries can miss symbols until it is rebuilt.');
    assert.deepStrictEqual(codegraphChip(prob, r), { text: 'reindex', tone: 'amber' });
    assert.deepStrictEqual(codegraphPill(prob, r), { column: 'extractor', text: 'v26 → v27' });
    assert.deepStrictEqual(codegraphSteps(prob, r), ['416 files · 8.3k symbols · 35 MB: a full rebuild takes a few minutes']);
  })) p++; else f++;

  if (test('reindex verdict with an unstamped index still reads, without a version it does not know', () => {
    const r = okRepo('a', { reindexRecommended: true, builtWithExtractionVersion: null, currentExtractionVersion: 27 });
    assert.strictEqual(codegraphVerdict({ key: 'reindex', sev: 3 }, r),
      'Built by an older codegraph extractor (now v27). Queries can miss symbols until it is rebuilt.');
  })) p++; else f++;

  if (test('pending verdict and steps: 7 files, "5 modified · 2 added" (zero parts dropped), then the index age', () => {
    const r = okRepo('a', { pending: { modified: 5, added: 2, removed: 0 }, lastIndexedMs: NOW - 2 * 3_600_000 });
    const prob = { key: 'pending', sev: 2 } as const;
    assert.strictEqual(codegraphVerdict(prob, r), '7 files changed since the last index.');
    assert.deepStrictEqual(codegraphSteps(prob, r, NOW), ['5 modified · 2 added', 'Indexed 2h ago']);
    assert.deepStrictEqual(codegraphChip(prob, r), { text: '7 pending', tone: 'mustard' });
    assert.deepStrictEqual(codegraphPill(prob, r), { column: 'changes', text: '7 pending' });
    const one = okRepo('a', { pending: { modified: 0, added: 0, removed: 1 } });
    assert.strictEqual(codegraphVerdict(prob, one), '1 file changed since the last index.');
    assert.deepStrictEqual(codegraphSteps(prob, one, NOW)[0], '1 removed');
  })) p++; else f++;

  if (test('pending steps drop the age line when the index time is unknown', () => {
    const r = okRepo('a', { pending: { modified: 1, added: 0, removed: 0 }, lastIndexedMs: null });
    assert.deepStrictEqual(codegraphSteps({ key: 'pending', sev: 2 }, r, NOW), ['1 modified']);
  })) p++; else f++;

  if (test('partial, failed, unfinished, error, lastRun and worktree: verdict, steps, chip and pill, verbatim from the table', () => {
    const rows: [string, CodegraphRepo, string, string[], string, string | null][] = [
      ['partial', okRepo('a', { indexState: 'partial' }), 'The last index skipped some files, so the graph is incomplete.', ['Reindex to rebuild it in full.'], 'partial', 'partial'],
      ['failed', okRepo('a', { indexState: 'failed' }), 'The last index failed.', ['Reindex to rebuild it.'], 'failed', 'failed'],
      ['unfinished', okRepo('a', { indexState: 'indexing' }), 'An index run stopped before it finished, so the graph is truncated.', ['Reindex to rebuild it.'], 'unfinished', 'unfinished'],
      ['error', { ...base('a'), state: 'error', root: '/p/a', message: 'status timed out' }, "Couldn't read codegraph status: status timed out.", ['Reindex if this persists.'], "can't read", "can't read"],
      ['worktree', okRepo('a', { worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' } }), 'This index was built from another worktree of the repo.', ['Reindex here to rebuild it from this checkout.'], 'other worktree', 'other worktree'],
    ];
    for (const [key, repo, verdict, steps, chip, pill] of rows) {
      const prob = codegraphProblems(repo).find(x => x.key === key)!;
      assert.ok(prob, key);
      assert.strictEqual(codegraphVerdict(prob, repo), verdict, key);
      assert.deepStrictEqual(codegraphSteps(prob, repo, NOW), steps, key);
      assert.strictEqual(codegraphChip(prob, repo).text, chip, key);
      assert.strictEqual(codegraphPill(prob, repo)?.text ?? null, pill, key);
      assert.strictEqual(codegraphPill(prob, repo)?.column, 'index', key);
    }
    assert.strictEqual(codegraphChip(codegraphProblems(okRepo('a', { worktreeMismatch: { worktreeRoot: '/w', indexRoot: '/i' } }))[0]!, okRepo('a')).tone, 'mustard');
    assert.strictEqual(codegraphChip({ key: 'partial', sev: 3 }, okRepo('a')).tone, 'amber');
  })) p++; else f++;

  if (test('a failed lastRun: chip "<kind> failed", verdict carries the message, no matrix pill', () => {
    const r = okRepo('a', {}, { lastRun: { kind: 'sync', ok: false, endedAtMs: NOW, message: 'EACCES: permission denied' } });
    const prob = { key: 'lastRun', sev: 3 } as const;
    assert.strictEqual(codegraphChip(prob, r).text, 'sync failed');
    assert.strictEqual(codegraphVerdict(prob, r), 'The last sync failed: EACCES: permission denied.');
    assert.deepStrictEqual(codegraphSteps(prob, r, NOW), ['Try again, or Reindex.']);
    assert.strictEqual(codegraphPill(prob, r), null);
    const re = okRepo('a', {}, { lastRun: { kind: 'reindex', ok: false, endedAtMs: NOW, message: 'x.' } });
    assert.strictEqual(codegraphChip(prob, re).text, 'reindex failed');
    assert.strictEqual(codegraphVerdict(prob, re), 'The last reindex failed: x.');
    const bare = okRepo('a', {}, { lastRun: { kind: 'sync', ok: false, endedAtMs: NOW, message: '' } });
    assert.strictEqual(codegraphVerdict(prob, bare), 'The last sync failed.');
  })) p++; else f++;

  if (test('compactCount: 8254 -> 8.3k, 19400 -> 19.4k, 587 -> 587, 1.2M for a million', () => {
    assert.strictEqual(compactCount(8254), '8.3k');
    assert.strictEqual(compactCount(19400), '19.4k');
    assert.strictEqual(compactCount(587), '587');
    assert.strictEqual(compactCount(0), '0');
    assert.strictEqual(compactCount(1_234_567), '1.2M');
  })) p++; else f++;

  if (test('formatDbSize: MiB, integer at 10 and over, one decimal below, KB under a MiB', () => {
    assert.strictEqual(formatDbSize(36786176), '35 MB');
    assert.strictEqual(formatDbSize(5 * 1024 * 1024 + 524288), '5.5 MB');
    assert.strictEqual(formatDbSize(10 * 1024 * 1024), '10 MB');
    assert.strictEqual(formatDbSize(512 * 1024), '512 KB');
    assert.strictEqual(formatDbSize(3 * 1024 ** 3), '3.0 GB');
  })) p++; else f++;

  if (test('extractorCell: v27, v26 -> v27, and a dash for an unstamped index', () => {
    assert.strictEqual(extractorCell(stats()), 'v27');
    assert.strictEqual(extractorCell(stats({ builtWithExtractionVersion: 26 })), 'v26 → v27');
    assert.strictEqual(extractorCell(stats({ builtWithExtractionVersion: null })), '—');
  })) p++; else f++;

  if (test('kindGroups on the fixture: functions 2637, imports 1968, properties 1481, constants 1145, types 436, other 587 (sum 8254)', () => {
    const g = kindGroups(FIXTURE.nodesByKind);
    assert.deepStrictEqual(g, [
      { key: 'functions', count: 2637 }, { key: 'imports', count: 1968 }, { key: 'properties', count: 1481 },
      { key: 'constants', count: 1145 }, { key: 'types', count: 436 }, { key: 'other', count: 587 },
    ]);
    assert.strictEqual(g.reduce((s, x) => s + x.count, 0), FIXTURE.nodeCount);
  })) p++; else f++;

  if (test('kindGroups: an unknown kind lands in other, and an empty map is six zeros', () => {
    assert.strictEqual(kindGroups({ function: 1, rune: 4 }).find(x => x.key === 'other')!.count, 4);
    assert.deepStrictEqual(kindGroups({}).map(x => x.count), [0, 0, 0, 0, 0, 0]);
  })) p++; else f++;

  if (test('codegraphQuietLine: fixture with a watcher, indexed 2h ago; no watcher drops "watching"; building reads the indexing line', () => {
    const r = okRepo('a', { lastIndexedMs: NOW - 2 * 3_600_000 }, { watching: true });
    assert.strictEqual(codegraphQuietLine(r, NOW), '416 files · 8.3k symbols · watching · indexed 2h ago');
    assert.strictEqual(codegraphQuietLine({ ...r, watching: false }, NOW), '416 files · 8.3k symbols · indexed 2h ago');
    assert.strictEqual(codegraphQuietLine(okRepo('a', { lastIndexedMs: null }), NOW), '416 files · 8.3k symbols');
    const building: CodegraphRepo = { ...base('a'), state: 'building', root: '/p/a' };
    assert.strictEqual(codegraphQuietLine(building, NOW), 'Indexing… — numbers when it finishes');
  })) p++; else f++;

  if (test('fixed strings: CLI missing, up to date, folder gone, not indexed, building, keys, no pins is Git\'s sentence', () => {
    assert.strictEqual(CODEGRAPH_CLI_MISSING, "codegraph isn't on the server's PATH.");
    assert.strictEqual(CODEGRAPH_UP_TO_DATE, 'up to date');
    assert.strictEqual(CODEGRAPH_FOLDER_GONE, 'Folder gone');
    assert.strictEqual(CODEGRAPH_NOT_INDEXED('~/dev/app'), 'No .codegraph/ in ~/dev/app');
    assert.strictEqual(CODEGRAPH_BUILDING_LINE, 'Indexing… — numbers when it finishes');
    assert.deepStrictEqual([CODEGRAPH_KEY_SYNC, CODEGRAPH_KEY_SYNCING, CODEGRAPH_KEY_REINDEX, CODEGRAPH_KEY_REINDEXING], ['Sync', 'Syncing', 'Reindex', 'Reindexing']);
    assert.strictEqual(CODEGRAPH_NEEDS_TOKEN, 'Sync and Reindex need the Answer token — set it under Settings › Local › Connection.');
    assert.strictEqual(CODEGRAPH_NO_PINS, GIT_NO_PINS);
  })) p++; else f++;

  if (test('first-load text: Loading… until the first read, the retry line once it failed', () => {
    assert.strictEqual(codegraphFirstLoadText(false), 'Loading…');
    assert.strictEqual(codegraphFirstLoadText(true), "Couldn't load CodeGraph status. Retrying every 30s.");
  })) p++; else f++;

  if (test('reindex confirm: the watcher sentence is added only while a watcher runs', () => {
    const plain = 'Reindex app? This throws the graph away and rebuilds it from scratch — a few minutes on a large repo.';
    assert.strictEqual(reindexConfirmText('app', false), plain);
    assert.strictEqual(reindexConfirmText('app', true),
      plain + ' The codegraph watcher here stops first, so open sessions in this repo lose codegraph until it restarts.');
  })) p++; else f++;

  if (test('POST notes: 409, 404 and the generic failure', () => {
    assert.strictEqual(codegraphRunConflictText('app'), 'app is already running a sync or reindex.');
    assert.strictEqual(codegraphRunMissingText('app'), 'app has no code graph.');
    assert.strictEqual(codegraphRunFailedText('app', 'reindex'), "Couldn't start reindex on app.");
  })) p++; else f++;

  // ── layouts ───────────────────────────────────────────────────────────────
  if (test('CODEGRAPH_LAYOUTS lists Inbox, Matrix, Inspector; inbox is the default', () => {
    assert.deepStrictEqual(CODEGRAPH_LAYOUTS, [{ key: 'inbox', label: 'Inbox' }, { key: 'matrix', label: 'Matrix' }, { key: 'inspector', label: 'Inspector' }]);
    assert.strictEqual(DEFAULT_CODEGRAPH_LAYOUT, 'inbox');
  })) p++; else f++;

  if (test('parseCodegraphLayout: a current key stands, branches (a Git key), 42 and undefined read as inbox', () => {
    assert.strictEqual(parseCodegraphLayout('matrix'), 'matrix');
    assert.strictEqual(parseCodegraphLayout('inspector'), 'inspector');
    for (const v of ['branches', 'cards', 42, null, undefined]) assert.strictEqual(parseCodegraphLayout(v), 'inbox');
  })) p++; else f++;

  if (test('matrix is wide-only: a phone draws inbox, a laptop matrix; inbox and inspector are never coerced', () => {
    assert.strictEqual(drawableCodegraphLayout('matrix', true), 'inbox');
    assert.strictEqual(drawableCodegraphLayout('matrix', false), 'matrix');
    assert.strictEqual(drawableCodegraphLayout('inbox', true), 'inbox');
    assert.strictEqual(drawableCodegraphLayout('inspector', true), 'inspector');
    assert.deepStrictEqual(codegraphLayoutsFor(true).map(l => l.key), ['inbox', 'inspector']);
    assert.deepStrictEqual(codegraphLayoutsFor(false).map(l => l.key), ['inbox', 'matrix', 'inspector']);
  })) p++; else f++;

  // ── poll and run notes ────────────────────────────────────────────────────
  if (test('hasLiveRun: null and a quiet payload are false, one repo with a run is true; the fast poll is 3s', () => {
    assert.strictEqual(CODEGRAPH_FAST_POLL_MS, 3000);
    assert.strictEqual(hasLiveRun(null), false);
    const quiet = { generatedAt: 1, cli: 'ok' as const, repos: [okRepo('a'), okRepo('b')] };
    assert.strictEqual(hasLiveRun(quiet), false);
    const live = { ...quiet, repos: [okRepo('a'), okRepo('b', {}, { run: { kind: 'sync', startedAtMs: 1 } })] };
    assert.strictEqual(hasLiveRun(live), true);
  })) p++; else f++;

  if (test('runNote: 200 is no note; 409, 404, 403 bad token, 403 read-only and 500 each say their line', () => {
    assert.strictEqual(runNote(200, { ok: true }, 'brickwright', 'sync'), null);
    assert.strictEqual(runNote(409, { error: 'already running' }, 'brickwright', 'sync'), 'brickwright is already running a sync or reindex.');
    assert.strictEqual(runNote(404, { error: 'not indexed' }, 'brickwright', 'sync'), 'brickwright has no code graph.');
    assert.strictEqual(runNote(403, { error: 'bad token' }, 'brickwright', 'sync'), CODEGRAPH_NEEDS_TOKEN);
    assert.strictEqual(runNote(403, { error: 'read-only from this network' }, 'brickwright', 'sync'), READ_ONLY_TEXT);
    assert.strictEqual(runNote(500, undefined, 'brickwright', 'sync'), "Couldn't start sync on brickwright.");
    assert.strictEqual(runNote(500, null, 'brickwright', 'reindex'), "Couldn't start reindex on brickwright.");
  })) p++; else f++;

  if (test("runNote: a 403 'not a pinned project' is not a token problem, so no token prompt; a 400 is the generic line", () => {
    assert.strictEqual(runNote(403, { error: 'not a pinned project' }, 'x', 'reindex'), "Couldn't start reindex on x.");
    assert.strictEqual(runNote(400, { error: 'bad body' }, 'x', 'sync'), "Couldn't start sync on x.");
  })) p++; else f++;

  // ── label text: the spec's literal strings and the small formatters ────────
  if (test('the band and the clock popover carry the spec strings verbatim', () => {
    assert.strictEqual(CODEGRAPH_BAND_TITLE, 'Management · CodeGraph');
    assert.strictEqual(CODEGRAPH_BAND_SUB, 'Code graph index of your pinned repos. Sync re-parses changed files; Reindex rebuilds from scratch.');
    assert.strictEqual(ROW_REREAD, 'Re-read status');
    assert.strictEqual(ROW_REREAD_SUB, 'Ask codegraph again now');
    assert.strictEqual(ROW_SYNC_ALL, 'Sync all behind');
    assert.strictEqual(ROW_SYNC_ALL_NONE_SUB, 'Nothing behind');
    assert.strictEqual(ROW_SYNC_ALL_NEEDS_TOKEN_SUB, 'Needs the Answer token');
    assert.strictEqual(CODEGRAPH_EXTRACTOR_UNKNOWN, 'extractor unknown (older index)');
  })) p++; else f++;

  if (test('rowSyncAllSub counts repos and pluralises: 1 repo, 2 repos', () => {
    assert.strictEqual(rowSyncAllSub(1), '1 repo with pending changes and no watcher');
    assert.strictEqual(rowSyncAllSub(2), '2 repos with pending changes and no watcher');
    assert.strictEqual(rowSyncAllSub(0), '0 repos with pending changes and no watcher');
  })) p++; else f++;

  if (test('watchersValue reads watching over indexed; codegraphKeyAria names the key and the repo', () => {
    assert.strictEqual(watchersValue(3, 5), '3 / 5');
    assert.strictEqual(watchersValue(0, 0), '0 / 0');
    assert.strictEqual(codegraphKeyAria(CODEGRAPH_KEY_SYNC, 'brickwright'), 'Sync brickwright');
    assert.strictEqual(codegraphKeyAria(CODEGRAPH_KEY_SYNCING, 'brickwright'), 'Syncing brickwright');
  })) p++; else f++;

  if (test('fullCount groups thousands with a comma; indexedAge is `<age> ago`, or a dash with no timestamp', () => {
    assert.strictEqual(fullCount(2672), '2,672');
    assert.strictEqual(fullCount(416), '416');
    assert.strictEqual(fullCount(1234567), '1,234,567');
    assert.strictEqual(indexedAge(stats({ lastIndexedMs: NOW - 2 * 3600_000 }), NOW), '2h ago');
    assert.strictEqual(indexedAge(stats({ lastIndexedMs: null }), NOW), '—');
  })) p++; else f++;

  if (test('languagesFact joins the names with a middle dot; an empty list is a dash', () => {
    assert.strictEqual(languagesFact(stats({ languages: ['typescript', 'tsx', 'javascript'] })), 'typescript · tsx · javascript');
    assert.strictEqual(languagesFact(stats({ languages: ['rust'] })), 'rust');
    assert.strictEqual(languagesFact(stats({ languages: [] })), '—');
  })) p++; else f++;

  if (test('lastIndexedFact: age, codegraph version and extractor; an unstamped index says so instead', () => {
    const at = NOW - 2 * 3600_000;
    assert.strictEqual(
      lastIndexedFact(stats({ lastIndexedMs: at, builtWithVersion: '1.6.2', builtWithExtractionVersion: 27 }), NOW),
      '2h ago · codegraph 1.6.2, extractor v27',
    );
    // An extractor stamp without a codegraph version drops the "codegraph x, " lead rather than printing "null".
    assert.strictEqual(lastIndexedFact(stats({ lastIndexedMs: at, builtWithVersion: null, builtWithExtractionVersion: 26 }), NOW), '2h ago · extractor v26');
    assert.strictEqual(
      lastIndexedFact(stats({ lastIndexedMs: at, builtWithVersion: null, builtWithExtractionVersion: null }), NOW),
      '2h ago · extractor unknown (older index)',
    );
    assert.strictEqual(
      lastIndexedFact(stats({ lastIndexedMs: null, builtWithVersion: '1.6.2', builtWithExtractionVersion: 27 }), NOW),
      '— · codegraph 1.6.2, extractor v27',
    );
  })) p++; else f++;

  if (test('changesFact: None pending, else the total then the non-zero parts in modified, added, removed order', () => {
    assert.strictEqual(FACT_CHANGES_NONE, 'None pending');
    assert.strictEqual(changesFact(stats()), 'None pending');
    assert.strictEqual(changesFact(stats({ pending: { added: 2, modified: 5, removed: 0 } })), '7 pending · 5 modified · 2 added');
    assert.strictEqual(changesFact(stats({ pending: { added: 0, modified: 0, removed: 1 } })), '1 pending · 1 removed');
    assert.strictEqual(changesFact(stats({ pending: { added: 1, modified: 1, removed: 1 } })), '3 pending · 1 modified · 1 added · 1 removed');
  })) p++; else f++;

  if (test('watcherFact: Not running, Running with no start time, then today as a time and an earlier day with its date', () => {
    // Built from local-time components, so the expectation holds in any timezone the suite runs in.
    const nowLocal = new Date(2026, 9, 19, 12, 0).getTime();
    const off = okRepo('a');
    assert.strictEqual(FACT_WATCHER_OFF, 'Not running');
    assert.strictEqual(FACT_WATCHER_ON, 'Running');
    assert.strictEqual(watcherFact(off, nowLocal), 'Not running');
    assert.strictEqual(watcherFact({ ...off, watching: true, watcherSinceMs: null }, nowLocal), 'Running');
    assert.strictEqual(watcherFact({ ...off, watching: true, watcherSinceMs: new Date(2026, 9, 19, 10, 31).getTime() }, nowLocal), 'Running since 10:31');
    assert.strictEqual(watcherFact({ ...off, watching: true, watcherSinceMs: new Date(2026, 9, 17, 10, 31).getTime() }, nowLocal), 'Running since 17 Oct, 10:31');
    // A stale pid file's start time does not matter once the daemon is not alive.
    assert.strictEqual(watcherFact({ ...off, watching: false, watcherSinceMs: new Date(2026, 9, 19, 10, 31).getTime() }, nowLocal), 'Not running');
  })) p++; else f++;

  // ── settings ──────────────────────────────────────────────────────────────
  if (test("clampSettings keeps managementTab 'codegraph'; an unknown tab still falls back", () => {
    assert.strictEqual(clampSettings({ managementTab: 'codegraph' }).managementTab, 'codegraph');
    assert.strictEqual(clampSettings({ managementTab: 'nope' }).managementTab, 'projects');
  })) p++; else f++;

  if (test('OWNED_KEYS contains management.codegraphLayout, so Reset clears the choice', () => {
    assert.ok(OWNED_KEYS.includes('management.codegraphLayout'));
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
