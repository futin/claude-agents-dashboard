/**
 * agents-cache.ts — incremental offset-following cache over readAgents.
 *
 * Transcripts are append-only, so instead of re-reading the whole file every
 * 3s detail poll, remember the byte offset consumed so far and feed only the
 * appended bytes through the same event parser + reducer `readAgents` uses
 * (see agents.ts). The persistent `ScanState` is what makes out-of-launch-order
 * completions work with no re-scan: a background launch stays registered in
 * `byAgentId` across calls until its `<task-notification>` finally arrives —
 * settled jobs are never re-parsed, and there is no low-water-mark checkpoint
 * to maintain (see backlog/ideas/done/idea-1-incremental-cache-for-subagent-tracking.md).
 *
 * Correctness notes:
 *  - Byte offsets, line splitting and the buffered partial line: see jsonl-tail.ts.
 *    A newline-less tail that parses is consumed, matching the oracle, which parses
 *    a final unterminated line.
 *  - `size < offset` means truncation/rotation → reset and re-read from 0.
 *  - Any unexpected error falls back to the pure whole-file readAgents — in
 *    readAgentsCached(Async) only; readSessionFold throws and readSessionFoldAsync rejects, since the oracle knows nothing about spend.
 *
 * The entry also carries the main transcript's spend tally (spend-tally.ts `onMainRecord`), fed from the same records in the same pass, so the drawer's
 * detail and spend reads fold the main transcript once between them, not once each (#552), and truncation or a failure resets both folds together.
 *
 * Two ways in, over the same entries. The drawer's two HTTP routes — GET /api/sessions/:id (`readAgentsCachedAsync`) and its spend read
 * (session-spend.ts `readSessionSpendAsync`, through `readSessionFoldAsync`) — fold in slices of at most `FOLD_CHUNK_BYTES` with a `setImmediate` yield
 * between them, so a cold entry's full read (a 6.0 MB transcript took 78 ms in one turn, measured 2026-11-25) never holds the event loop for more than a
 * slice (#563). The 3s /api/sessions poll reads synchronously, through scan.ts `subagentRunning` (`readAgentsCached`) — gated there behind a subagent
 * file written in the last 15 minutes that is still mid-turn. So state exists only for sessions the UI watches or that are parked on a live subagent
 * (LRU-capped at MAX_ENTRIES; a client cycling more ids than that re-reads each one, in slices on the async path).
 *
 * The async path's rules:
 *  - Single-flight per entry: the drawer fires detail and spend together on first open, so a second async caller awaits the fold in flight, then re-stats
 *    and folds only what was appended since (normally nothing) — never a second fold over the same `tail`.
 *  - A sync fold may land between two slices. It is never made to wait and never cancels the async one: every slice reads from the entry's current
 *    `tail`, so the sync call just advances it and the next slice starts where it stopped — no record is delivered twice. Keep it that way: a slice must
 *    never cache an offset across a yield.
 *  - An entry evicted mid-fold is finished as an orphan and answers its caller, never re-inserted; one reset by truncation mid-fold is restarted against
 *    the new entry. A failure drops the entry (if still cached) and rejects every waiter with the same error.
 */

import fs from 'node:fs';

import type { AgentJob } from '../../shared/types.js';
import { createScanState, parseRecordEvents, applyEvent, toAgentJobs, readAgents, type ScanState } from './agents.js';
import { createTail, followJsonl, FOLD_CHUNK_BYTES, type JsonlTail } from './jsonl-tail.js';
import { createTally, onMainRecord, type SpendTally } from './spend-tally.js';

interface CacheEntry {
  /** How far into the file `state` has consumed. */
  tail: JsonlTail;
  state: ScanState;
  /** The main transcript's spend so far, over the same bytes as `state`. */
  spend: SpendTally;
  /** Last materialized snapshot, returned as-is when the file hasn't grown. */
  jobs: AgentJob[];
  lastUsed: number;
  /** The async fold running over this entry; a second async caller waits on it rather than folding the same `tail` concurrently. */
  inflight?: Promise<unknown>;
  /** Set when truncation replaced this entry with a fresh one, so an async fold still slicing it restarts instead of answering stale bytes. */
  replaced?: boolean;
}

type SessionFold = { jobs: AgentJob[]; main: SpendTally };

const MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

// Stamped now, not 0: `evictIfNeeded` runs right after insertion, and a 0 would make the new entry the LRU pick, evicting itself.
function freshEntry(): CacheEntry {
  return { tail: createTail(), state: createScanState(), spend: createTally(), jobs: [], lastUsed: Date.now() };
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, e] of cache) {
    if (e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
  }
  if (oldestKey !== null) cache.delete(oldestKey);
}

/**
 * The live entry for `filePath` at `size`: created (and the LRU trimmed) when absent, replaced when the file shrank below what it consumed — everything
 * derived so far is invalid then. Marks it used.
 */
function entryAt(filePath: string, size: number): CacheEntry {
  let entry = cache.get(filePath);
  if (!entry) {
    entry = freshEntry();
    cache.set(filePath, entry);
    evictIfNeeded();
  }
  if (size < entry.tail.offset) {
    // Truncated/rotated in place.
    entry.replaced = true;
    entry = freshEntry();
    cache.set(filePath, entry);
  }
  entry.lastUsed = Date.now();
  return entry;
}

function upToDate(entry: CacheEntry, size: number): boolean {
  return size === entry.tail.offset && entry.tail.partial.length === 0;
}

/** Fold `[entry.tail.offset, end)` of `filePath` into the entry's agents state and spend tally. */
function foldTo(filePath: string, entry: CacheEntry, end: number, eof = true): void {
  const { state, spend } = entry;
  followJsonl(filePath, end, entry.tail, rec => {
    for (const ev of parseRecordEvents(rec)) applyEvent(state, ev);
    onMainRecord(spend, rec);
  }, { eof });
}

function statSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    cache.delete(filePath);
    return null;
  }
}

/**
 * The agents list and the main-transcript spend tally of `filePath`, both folded up to its current size; null when it can't be `stat`ed. O(new bytes)
 * per call after the first. An unexpected read or parse failure drops the entry and throws. The tally is live cache state: read it, never mutate it.
 */
export function readSessionFold(filePath: string): SessionFold | null {
  const size = statSize(filePath);
  if (size === null) return null;
  const entry = entryAt(filePath, size);
  if (upToDate(entry, size)) return { jobs: entry.jobs, main: entry.spend };

  try {
    foldTo(filePath, entry, size);
    entry.jobs = toAgentJobs(entry.state);
    return { jobs: entry.jobs, main: entry.spend };
  } catch (e) {
    cache.delete(filePath);
    throw e;
  }
}

let sliceBytes = FOLD_CHUNK_BYTES;
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** What {@link foldInSlices} returns when truncation replaced its entry mid-fold, so the caller starts over against the new one. */
const RESTART = Symbol('restart');

/**
 * Fold `entry` up to `target` at most {@link sliceBytes} per event-loop turn. Every slice starts from the entry's current `tail`, never a remembered
 * offset, which is what makes a sync fold landing between slices safe. An eviction mid-fold leaves the orphan to finish here; a failure drops the entry
 * only while it is still the cached one.
 */
async function foldInSlices(filePath: string, entry: CacheEntry, target: number): Promise<SessionFold | typeof RESTART> {
  try {
    for (;;) {
      const from = entry.tail.offset;
      const end = Math.min(target, from + sliceBytes);
      const last = end >= target;
      foldTo(filePath, entry, end, last);
      if (last) break;
      await nextTurn();
      if (entry.replaced) return RESTART;
      // Read nothing: the file shrank under this fold. Start over; the re-stat sees the truncation.
      if (entry.tail.offset <= from) return RESTART;
      if (cache.get(filePath) === entry) entry.lastUsed = Date.now();
    }
    entry.jobs = toAgentJobs(entry.state);
    return { jobs: entry.jobs, main: entry.spend };
  } catch (e) {
    if (cache.get(filePath) === entry) cache.delete(filePath);
    throw e;
  }
}

/**
 * {@link readSessionFold} for the HTTP routes: the same answer, folded in slices with a yield between them, so a cold full read never runs more than one
 * slice per event-loop turn. Rejects where the sync read throws.
 */
export async function readSessionFoldAsync(filePath: string): Promise<SessionFold | null> {
  for (;;) {
    // Single-flight: wait out the fold in flight (its failure is ours too), then fold only what was appended since.
    for (let busy = cache.get(filePath)?.inflight; busy; busy = cache.get(filePath)?.inflight) await busy;

    const size = statSize(filePath);
    if (size === null) return null;
    const entry = entryAt(filePath, size);
    if (upToDate(entry, size)) return { jobs: entry.jobs, main: entry.spend };

    const run = foldInSlices(filePath, entry, size);
    entry.inflight = run;
    let result: SessionFold | typeof RESTART;
    try {
      result = await run;
    } finally {
      if (entry.inflight === run) entry.inflight = undefined;
    }
    if (result !== RESTART) return result;
  }
}

/**
 * Drop-in replacement for readAgents on the detail endpoint: same output for
 * the same file contents, but O(new bytes) per call after the first.
 */
export function readAgentsCached(filePath: string): AgentJob[] | null {
  try {
    return readSessionFold(filePath)?.jobs ?? null;
  } catch {
    // Unexpected read/parse failure: readSessionFold dropped the entry; use the pure oracle.
    return readAgents(filePath);
  }
}

/** {@link readAgentsCached} over {@link readSessionFoldAsync}: an unexpected failure resolves to the whole-file oracle, never rejects. */
export async function readAgentsCachedAsync(filePath: string): Promise<AgentJob[] | null> {
  try {
    return (await readSessionFoldAsync(filePath))?.jobs ?? null;
  } catch {
    return readAgents(filePath);
  }
}

/** Test hooks. `_resetAgentsCache` also restores the default slice budget. */
export function _resetAgentsCache(): void { cache.clear(); sliceBytes = FOLD_CHUNK_BYTES; }
export function _setFoldSliceBytes(n: number): void { sliceBytes = n; }
export function _agentsCacheSize(): number { return cache.size; }
