/**
 * compact-history.ts — the context size a session's newest compaction started from.
 *
 * No record on disk names the window a session runs under (#159), but every
 * compaction writes the context it began at:
 *
 *   {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":268844,…},…}
 *
 * That is context the session really held, so a `preTokens` above 200k proves
 * a larger window as surely as live tokens do — and, unlike live tokens, it is
 * still true after the compaction has brought context back down. The record
 * sinks below the tail window within a few turns, so it is found and
 * remembered the same way as the model attachment (see `record-cache.ts`).
 */

import { createRecordCache } from './record-cache.js';

export const COMPACT_MARKER = '"compact_boundary"';

/** `compactMetadata.preTokens` out of a parsed compact boundary, or null for anything else. */
export function preTokensFromRecord(rec: any): number | null {
  if (!rec || rec.type !== 'system' || rec.subtype !== 'compact_boundary') return null;
  const n = rec.compactMetadata && rec.compactMetadata.preTokens;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const boundaries = createRecordCache(COMPACT_MARKER, preTokensFromRecord);

/** Newest compaction's `preTokens` in the tail window's lines. */
export function findCompactPreTokens(lines: string[], first: number): number | null {
  return boundaries.findInLines(lines, first);
}

/** Resolve a session's newest compaction `preTokens` given what its tail window already yielded. */
export function resolveCompactPreTokens(
  filePath: string,
  tailHit: number | null,
  tailStart: number,
  size: number
): number | null {
  return boundaries.resolve(filePath, tailHit, tailStart, size);
}

/** Test seam: drop all remembered compactions. */
export function resetCompactHistoryCache(): void {
  boundaries.reset();
}

/** Test seam: how many times we went to disk below the tail window. */
export function compactHistoryCacheStats(): { entries: number; fullScans: number } {
  return boundaries.stats();
}
