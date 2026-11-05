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
 *  - Any unexpected error falls back to the pure whole-file readAgents.
 *
 * Three callers: the on-demand GET /api/sessions/:id handler, the drawer's
 * spend read (session-spend.ts), and the 3s /api/sessions poll through scan.ts
 * `subagentRunning` — gated there behind a subagent file written in the last 15
 * minutes that is still mid-turn. So state
 * exists only for sessions the UI watches or that are parked on a live subagent
 * (LRU-capped at MAX_ENTRIES).
 */

import fs from 'node:fs';

import type { AgentJob } from '../../shared/types.js';
import { createScanState, parseRecordEvents, applyEvent, toAgentJobs, readAgents, type ScanState } from './agents.js';
import { createTail, followJsonl, type JsonlTail } from './jsonl-tail.js';

interface CacheEntry {
  /** How far into the file `state` has consumed. */
  tail: JsonlTail;
  state: ScanState;
  /** Last materialized snapshot, returned as-is when the file hasn't grown. */
  jobs: AgentJob[];
  lastUsed: number;
}

const MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

// Stamped now, not 0: `evictIfNeeded` runs right after insertion, and a 0 would make the new entry the LRU pick, evicting itself.
function freshEntry(): CacheEntry {
  return { tail: createTail(), state: createScanState(), jobs: [], lastUsed: Date.now() };
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
 * Drop-in replacement for readAgents on the detail endpoint: same output for
 * the same file contents, but O(new bytes) per call after the first.
 */
export function readAgentsCached(filePath: string): AgentJob[] | null {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    cache.delete(filePath);
    return null;
  }

  let entry = cache.get(filePath);
  if (!entry) {
    entry = freshEntry();
    cache.set(filePath, entry);
    evictIfNeeded();
  }
  if (size < entry.tail.offset) {
    // Truncated/rotated in place — everything derived so far is invalid.
    const reset = freshEntry();
    cache.set(filePath, reset);
    entry = reset;
  }
  entry.lastUsed = Date.now();
  if (size === entry.tail.offset && entry.tail.partial.length === 0) return entry.jobs;

  try {
    const state = entry.state;
    followJsonl(filePath, size, entry.tail, rec => {
      for (const ev of parseRecordEvents(rec)) applyEvent(state, ev);
    });
    entry.jobs = toAgentJobs(entry.state);
    return entry.jobs;
  } catch {
    // Unexpected read/parse failure: drop the entry, use the pure oracle.
    cache.delete(filePath);
    return readAgents(filePath);
  }
}

/** Test hooks. */
export function _resetAgentsCache(): void { cache.clear(); }
export function _agentsCacheSize(): number { return cache.size; }
