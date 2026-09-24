/**
 * title-cache.ts — remember a session's custom-title so it survives falling out
 * of the transcript tail window.
 *
 * Claude Code appends a `custom-title` record when the session is named or
 * selected and never again, so on a busy session the title sinks below the
 * 256 KB tail window and the row silently falls back to the project name.
 * Observed live at 764 KB below EOF on a 1.2 MB transcript. The tail-then-hunt
 * search and its remembered byte range live in `record-cache.ts`.
 */

import { createRecordCache } from './record-cache.js';

export { CHUNK_BYTES, RECORD_SLACK } from './record-cache.js';

export const TITLE_MARKER = '"custom-title"';

/** A usable title out of a parsed record, or null (placeholder counts as null). */
export function titleFromRecord(rec: any): string | null {
  if (!rec || rec.type !== 'custom-title' || typeof rec.customTitle !== 'string') return null;
  const t = rec.customTitle.trim();
  return t && t !== 'New session' ? t : null;
}

const titles = createRecordCache(TITLE_MARKER, titleFromRecord);

/** Newest usable title in the tail window's lines — see `findSessionName` in `transcript.ts`. */
export function findTitle(lines: string[], first: number): string | null {
  return titles.findInLines(lines, first);
}

/**
 * Resolve a session's title given what its tail window already yielded.
 *
 * @param tailTitle title found in the tail window, or null
 * @param tailStart byte offset the tail window began at (0 ⇒ whole file read)
 * @param size      file size the tail was read from
 */
export function resolveSessionTitle(
  filePath: string,
  tailTitle: string | null,
  tailStart: number,
  size: number
): string | null {
  return titles.resolve(filePath, tailTitle, tailStart, size);
}

/** Test seam: drop all remembered titles. */
export function resetTitleCache(): void {
  titles.reset();
}

/** Test seam: how many times we went to disk below the tail window. */
export function titleCacheStats(): { entries: number; fullScans: number } {
  return titles.stats();
}
