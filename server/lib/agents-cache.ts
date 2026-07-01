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
 * to maintain (see docs/ideas/agent-tracking-cache.md).
 *
 * Correctness notes:
 *  - Offsets are BYTES and lines are split on 0x0A before decoding — a
 *    multibyte UTF-8 sequence can straddle a read boundary, so string lengths
 *    must never drive the offset.
 *  - A read can end mid-line; the fragment is buffered in `partial` and
 *    prepended to the next read. If the newline-less tail parses as JSON it is
 *    a complete record (a strict prefix of a JSON document never parses), so it
 *    is consumed — matching the oracle, which parses a final unterminated line.
 *  - `size < offset` means truncation/rotation → reset and re-read from 0.
 *  - Any unexpected error falls back to the pure whole-file readAgents.
 *
 * Used only by the on-demand GET /api/sessions/:id handler — never the 3s
 * /api/sessions poll loop — so state exists only for sessions the UI actually
 * watches (LRU-capped at MAX_ENTRIES).
 */

import fs from 'node:fs';

import type { AgentJob } from '../../shared/types.js';
import { createScanState, parseRecordEvents, applyEvent, toAgentJobs, readAgents, type ScanState } from './agents.js';

interface CacheEntry {
  /** Bytes consumed into `state` — always a line boundary or a consumed EOF tail. */
  offset: number;
  /** Bytes read past `offset` that don't yet form a parseable line. */
  partial: Buffer;
  state: ScanState;
  /** Last materialized snapshot, returned as-is when the file hasn't grown. */
  jobs: AgentJob[];
  lastUsed: number;
}

const MAX_ENTRIES = 32;
const cache = new Map<string, CacheEntry>();

function freshEntry(): CacheEntry {
  return { offset: 0, partial: Buffer.alloc(0), state: createScanState(), jobs: [], lastUsed: 0 };
}

function consumeLine(state: ScanState, lineBuf: Buffer): void {
  const trimmed = lineBuf.toString('utf8').trim();
  if (!trimmed) return;
  let rec: any;
  try { rec = JSON.parse(trimmed); } catch { return; }
  for (const ev of parseRecordEvents(rec)) applyEvent(state, ev);
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
  if (size < entry.offset) {
    // Truncated/rotated in place — everything derived so far is invalid.
    const reset = freshEntry();
    cache.set(filePath, reset);
    entry = reset;
  }
  entry.lastUsed = Date.now();
  if (size === entry.offset && entry.partial.length === 0) return entry.jobs;

  try {
    const toRead = size - entry.offset;
    let buf: Buffer;
    if (toRead > 0) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const chunk = Buffer.alloc(toRead);
        const read = fs.readSync(fd, chunk, 0, toRead, entry.offset);
        buf = Buffer.concat([entry.partial, chunk.subarray(0, read)]);
        entry.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } else {
      buf = entry.partial;
    }

    // Consume complete lines (byte-level split — see header comment).
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      consumeLine(entry.state, buf.subarray(start, nl));
      start = nl + 1;
    }
    let tail = buf.subarray(start);

    // A newline-less tail that parses is a complete final record — consume it
    // so output matches the whole-file oracle.
    if (tail.length > 0) {
      const text = tail.toString('utf8').trim();
      if (text) {
        try {
          const rec = JSON.parse(text);
          for (const ev of parseRecordEvents(rec)) applyEvent(entry.state, ev);
          tail = Buffer.alloc(0);
        } catch { /* incomplete — keep buffering */ }
      } else {
        tail = Buffer.alloc(0);
      }
    }
    entry.partial = tail;

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
