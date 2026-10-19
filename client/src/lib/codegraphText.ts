import type { CodegraphRepo, CodegraphRunKind, CodegraphStats } from '../../../shared/types';
import { ageAt } from './format';
import type { CodegraphProblem } from './codegraphLevels';
import { GIT_NO_PINS } from './gitStatsText';

/**
 * Every string of the CodeGraph view (design spec §Client and the §Levels copy table), as named constants and small functions, so no component spells one
 * out. Pure: the clock comes in as `nowMs`, and a default of `Date.now()` is only a convenience for a caller that has no better one.
 */

// ── empty states and the band ─────────────────────────────────────────────────
export const CODEGRAPH_BAND_SUB = 'Code graph index of your pinned repos. Sync re-parses changed files; Reindex rebuilds from scratch.';
export const CODEGRAPH_LOADING = 'Loading…';
export const CODEGRAPH_LOAD_FAILED = "Couldn't load CodeGraph status. Retrying every 30s.";
export const CODEGRAPH_NO_PINS = GIT_NO_PINS;
export const CODEGRAPH_CLI_MISSING = "codegraph isn't on the server's PATH.";

export function codegraphFirstLoadText(error: boolean): string {
  return error ? CODEGRAPH_LOAD_FAILED : CODEGRAPH_LOADING;
}

// ── lines for the repos that are not in trouble ───────────────────────────────
export const CODEGRAPH_UP_TO_DATE = 'up to date';
export const CODEGRAPH_FOLDER_GONE = 'Folder gone';
export const CODEGRAPH_BUILDING_LINE = 'Indexing… — numbers when it finishes';
/** Inspector's fact for an index built before the CLI stamped its extractor version. */
export const CODEGRAPH_EXTRACTOR_UNKNOWN = 'extractor unknown (older index)';

/** `dir` is the repo's path already shortened for display (`~/…`). */
export function CODEGRAPH_NOT_INDEXED(dir: string): string {
  return `No .codegraph/ in ${dir}`;
}

// ── keys, chips and popover ───────────────────────────────────────────────────
export const CODEGRAPH_KEY_SYNC = 'Sync';
export const CODEGRAPH_KEY_SYNCING = 'Syncing';
export const CODEGRAPH_KEY_REINDEX = 'Reindex';
export const CODEGRAPH_KEY_REINDEXING = 'Reindexing';
export const CODEGRAPH_CONFIRM_CANCEL = 'Cancel';
export const CODEGRAPH_NEEDS_TOKEN = 'Sync and Reindex need the Answer token — set it under Settings › Local › Connection.';

/** The two chips that do not belong to a problem: the dashed one a pending repo carries, and the one a watched repo shows. */
export const CODEGRAPH_CHIP_NO_WATCHER = 'no watcher';
export const CODEGRAPH_CHIP_WATCHING = 'watching';

export const CODEGRAPH_CLOCK_NAME = 'Read and watcher clocks';
export const CODEGRAPH_POP_LABEL = 'Read and sync';
export const METER_READ = 'READ';
export const METER_WATCHERS = 'WATCHERS';
export const ROW_REREAD = 'Re-read status';
export const ROW_REREAD_SUB = 'Ask codegraph again now';
export const ROW_SYNC_ALL = 'Sync all behind';
export const ROW_SYNC_ALL_NONE_SUB = 'Nothing behind';
export const ROW_SYNC_ALL_NEEDS_TOKEN_SUB = 'Needs the Answer token';

export function rowSyncAllSub(n: number): string {
  return `${n} ${n === 1 ? 'repo' : 'repos'} with pending changes and no watcher`;
}

// ── the Matrix's cells ────────────────────────────────────────────────────────
export const MATRIX_INDEX_COMPLETE = 'complete';
export const MATRIX_CHANGES_NONE = 'none';
export const MATRIX_WATCHER_ON = 'on';
export const MATRIX_WATCHER_OFF = 'off';
export const MATRIX_NOT_INDEXED = 'Not indexed';

// ── POST /api/codegraph/run notes ─────────────────────────────────────────────
export function codegraphRunConflictText(name: string): string {
  return `${name} is already running a sync or reindex.`;
}
export function codegraphRunMissingText(name: string): string {
  return `${name} has no code graph.`;
}
export function codegraphRunFailedText(name: string, kind: CodegraphRunKind): string {
  return `Couldn't start ${kind} on ${name}.`;
}

/** Reindex asks first because it throws the DB away; while a watcher runs the CLI stops it first, which the user should know. */
export function reindexConfirmText(name: string, watching: boolean): string {
  const base = `Reindex ${name}? This throws the graph away and rebuilds it from scratch — a few minutes on a large repo.`;
  return watching ? `${base} The codegraph watcher here stops first, so open sessions in this repo lose codegraph until it restarts.` : base;
}

// ── numbers ───────────────────────────────────────────────────────────────────
/** 587, 8.3k, 19.4k, 1.2M. */
export function compactCount(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** The database size in binary units, an integer at 10 and over and one decimal below: 512 KB, 5.5 MB, 35 MB. */
export function formatDbSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** The Matrix's Extractor cell: `v27`, `v26 → v27` when stale, `—` when the index predates stamping. */
export function extractorCell(stats: CodegraphStats): string {
  const built = stats.builtWithExtractionVersion;
  const current = stats.currentExtractionVersion;
  if (built === null) return '—';
  return current === null || current === built ? `v${built}` : `v${built} → v${current}`;
}

function countOf(n: number, word: string): string {
  return `${compactCount(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** The sentence's closing full stop, added only when the text has none (a CLI message may already end in one). */
function withStop(s: string): string {
  return /[.!?]$/.test(s) ? s : s + '.';
}

function pendingTotal(s: CodegraphStats): number {
  return s.pending.added + s.pending.modified + s.pending.removed;
}

/** What an All good repo's line in the quiet box reads: `416 files · 8.3k symbols · watching · indexed 2h ago`. A building repo has no numbers yet. */
export function codegraphQuietLine(repo: CodegraphRepo, nowMs: number): string {
  if (repo.state !== 'ok') return CODEGRAPH_BUILDING_LINE;
  const s = repo.stats;
  const parts = [countOf(s.fileCount, 'file'), countOf(s.nodeCount, 'symbol')];
  if (repo.watching) parts.push(CODEGRAPH_CHIP_WATCHING);
  if (s.lastIndexedMs !== null) parts.push(`indexed ${ageAt(s.lastIndexedMs, nowMs)} ago`);
  return parts.join(' · ');
}

// ── per-problem copy: the Levels table ────────────────────────────────────────
export type CodegraphChipTone = 'amber' | 'mustard';
export interface CodegraphChip { text: string; tone: CodegraphChipTone }

/** The Matrix column a problem's pill sits in. */
export type CodegraphPillColumn = 'index' | 'changes' | 'extractor';
export interface CodegraphPill { column: CodegraphPillColumn; text: string }

/** The one sentence that says what is wrong. The caller leads with the worst problem's verdict. */
export function codegraphVerdict(problem: CodegraphProblem, repo: CodegraphRepo): string {
  switch (problem.key) {
    case 'reindex': {
      const s = repo.state === 'ok' ? repo.stats : null;
      const built = s?.builtWithExtractionVersion ?? null;
      const now = s?.currentExtractionVersion ?? null;
      const which = built !== null && now !== null ? ` (v${built}, now v${now})` : now !== null ? ` (now v${now})` : '';
      return `Built by an older codegraph extractor${which}. Queries can miss symbols until it is rebuilt.`;
    }
    case 'pending': {
      const n = repo.state === 'ok' ? pendingTotal(repo.stats) : 0;
      return `${n} ${n === 1 ? 'file' : 'files'} changed since the last index.`;
    }
    case 'partial': return 'The last index skipped some files, so the graph is incomplete.';
    case 'failed': return 'The last index failed.';
    case 'unfinished': return 'An index run stopped before it finished, so the graph is truncated.';
    case 'error': return withStop(`Couldn't read codegraph status: ${repo.state === 'error' ? repo.message : 'unknown error'}`);
    case 'lastRun': {
      const run = repo.lastRun;
      const message = run?.message.trim() ?? '';
      return message === '' ? `The last ${run?.kind ?? 'run'} failed.` : withStop(`The last ${run?.kind ?? 'run'} failed: ${message}`);
    }
    case 'worktree': return 'This index was built from another worktree of the repo.';
  }
}

/** What to do about it, one line each. `pending` carries the breakdown and the index age, which is why it needs `nowMs`. */
export function codegraphSteps(problem: CodegraphProblem, repo: CodegraphRepo, nowMs: number = Date.now()): string[] {
  switch (problem.key) {
    case 'reindex': {
      if (repo.state !== 'ok') return [];
      const s = repo.stats;
      return [`${countOf(s.fileCount, 'file')} · ${countOf(s.nodeCount, 'symbol')} · ${formatDbSize(s.dbSizeBytes)}: a full rebuild takes a few minutes`];
    }
    case 'pending': {
      if (repo.state !== 'ok') return [];
      const { modified, added, removed } = repo.stats.pending;
      const parts = [[modified, 'modified'], [added, 'added'], [removed, 'removed']] as const;
      const lines = [parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(' · ')];
      if (repo.stats.lastIndexedMs !== null) lines.push(`Indexed ${ageAt(repo.stats.lastIndexedMs, nowMs)} ago`);
      return lines;
    }
    case 'partial': return ['Reindex to rebuild it in full.'];
    case 'failed':
    case 'unfinished': return ['Reindex to rebuild it.'];
    case 'error': return ['Reindex if this persists.'];
    case 'lastRun': return ['Try again, or Reindex.'];
    case 'worktree': return ['Reindex here to rebuild it from this checkout.'];
  }
}

/** The chip a problem draws on the repo's row. A pending repo also carries `CODEGRAPH_CHIP_NO_WATCHER`, drawn dashed by the view. */
export function codegraphChip(problem: CodegraphProblem, repo: CodegraphRepo): CodegraphChip {
  switch (problem.key) {
    case 'reindex': return { text: 'reindex', tone: 'amber' };
    case 'pending': return { text: `${repo.state === 'ok' ? pendingTotal(repo.stats) : 0} pending`, tone: 'mustard' };
    case 'partial': return { text: 'partial', tone: 'amber' };
    case 'failed': return { text: 'failed', tone: 'amber' };
    case 'unfinished': return { text: 'unfinished', tone: 'amber' };
    case 'error': return { text: "can't read", tone: 'amber' };
    case 'lastRun': return { text: `${repo.lastRun?.kind ?? 'run'} failed`, tone: 'amber' };
    case 'worktree': return { text: 'other worktree', tone: 'mustard' };
  }
}

/** The Matrix pill a problem puts in its column; a failed run has none, since no column is about runs. */
export function codegraphPill(problem: CodegraphProblem, repo: CodegraphRepo): CodegraphPill | null {
  switch (problem.key) {
    case 'reindex': return repo.state === 'ok' ? { column: 'extractor', text: extractorCell(repo.stats) } : null;
    case 'pending': return { column: 'changes', text: `${repo.state === 'ok' ? pendingTotal(repo.stats) : 0} pending` };
    case 'partial': return { column: 'index', text: 'partial' };
    case 'failed': return { column: 'index', text: 'failed' };
    case 'unfinished': return { column: 'index', text: 'unfinished' };
    case 'error': return { column: 'index', text: "can't read" };
    case 'lastRun': return null;
    case 'worktree': return { column: 'index', text: 'other worktree' };
  }
}
