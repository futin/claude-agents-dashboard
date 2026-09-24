/**
 * record-cache.ts — find the newest record of one kind in a transcript, even
 * after it has sunk below the tail window, and remember the answer.
 *
 * `readTranscript` only reads the last `DEFAULT_TAIL_BYTES` (256 KB) of a file.
 * Some records Claude Code writes once and then buries under normal work: the
 * `custom-title` record (see `title-cache.ts`), observed live at 764 KB below
 * EOF on a 1.2 MB transcript, and the model-identity attachment (see
 * `model-identity.ts`), written near the session's start.
 *
 * Widening the window is not the fix — transcripts here run to 5.8 MB and the
 * scan re-reads every session every 3 s. Instead: search the tail (free, the
 * bytes are already decoded), and only when that misses fall back to a chunked
 * backward hunt through the rest of the file — once, then remembered.
 *
 * The entry records **which byte range has been searched**, not just the
 * answer, so a later poll can prove its own tail window joins up with what was
 * already covered and skip the disk entirely. Transcripts are append-only, so
 * "already searched" never expires; a file that shrank was rotated or truncated
 * and drops its entry.
 *
 * Each lookup is one `createRecordCache(marker, extract)` instance: `marker` is
 * a cheap ASCII substring every wanted record contains, `extract` turns a
 * parsed record into the answer or null. The marker also matches ordinary
 * message text, so `extract` must check the record's shape, not trust the hit.
 */

import fs from 'node:fs';

/** Bytes per backward chunk when hunting a record below the tail window. */
export const CHUNK_BYTES = 512 * 1024;
/**
 * Bounds the re-read that recovers the whole record around a marker hit, and
 * doubles as the chunk overlap — see `scanBack`.
 */
export const RECORD_SLACK = 4096;

interface Entry<T> {
  value: T | null;
  /** Everything in [scannedFrom, size) has been searched for a matching record. */
  scannedFrom: number;
  /** File size when that range was established. */
  size: number;
}

export interface RecordCache<T> {
  /** Newest match in the tail window's decoded lines, scanned newest-first. */
  findInLines(lines: string[], first: number): T | null;
  /**
   * Resolve a file's newest match given what its tail window already yielded.
   *
   * @param tailHit   match found in the tail window, or null
   * @param tailStart byte offset the tail window began at (0 ⇒ whole file read)
   * @param size      file size the tail was read from
   */
  resolve(filePath: string, tailHit: T | null, tailStart: number, size: number): T | null;
  /** Test seam: drop everything remembered. */
  reset(): void;
  /** Test seam: entries held, and how many times we went to disk below the tail window. */
  stats(): { entries: number; fullScans: number };
}

export function createRecordCache<T>(marker: string, extract: (rec: any) => T | null): RecordCache<T> {
  const cache = new Map<string, Entry<T>>();
  let fullScans = 0;

  /**
   * Recover the whole record containing a marker hit and extract from it.
   * Reads a bounded window and splits on `0x0A` **before** decoding — same
   * byte-discipline as `chat.ts`, since a multibyte sequence can straddle any
   * boundary we pick. A clipped record fails to parse and reads as "no match",
   * which is also the right answer for the literal marker text appearing inside
   * some message body.
   */
  function readAt(fd: number, size: number, markerOffset: number): T | null {
    const start = Math.max(0, markerOffset - RECORD_SLACK);
    const end = Math.min(size, markerOffset + RECORD_SLACK);
    const len = end - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, start); } catch { return null; }

    const rel = markerOffset - start;
    const from = buf.lastIndexOf(0x0a, rel);           // -1 ⇒ line starts at `start`
    const to = buf.indexOf(0x0a, rel);
    const line = buf.subarray(from + 1, to === -1 ? buf.length : to).toString('utf8').trim();
    if (!line) return null;
    try { return extract(JSON.parse(line)); } catch { return null; }
  }

  /**
   * Newest match in [0, upTo), walking backwards a chunk at a time and
   * stopping at the first hit.
   *
   * Chunks overlap upward by a whole `RECORD_SLACK`, not merely by the marker
   * length: a record can straddle any boundary we pick, and the first boundary
   * is `upTo` — the tail window's own start, whose straddling record the caller
   * already dropped as a partial line. A marker-sized overlap would miss a
   * record that begins just below the window and carries its marker just above.
   *
   * Decoded as latin1 on purpose: the marker is pure ASCII and latin1 keeps one
   * char per byte, so string indices stay byte-exact regardless of what UTF-8
   * sits around them. Decoding as utf8 here would desync every offset.
   */
  function scanBack(fd: number, size: number, upTo: number): T | null {
    let end = Math.min(upTo, size);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK_BYTES);
      const readEnd = Math.min(size, end + RECORD_SLACK);
      const len = readEnd - start;
      const buf = Buffer.alloc(len);
      try { fs.readSync(fd, buf, 0, len, start); } catch { return null; }
      const text = buf.toString('latin1');

      let idx = text.lastIndexOf(marker);
      while (idx !== -1) {
        const hit = readAt(fd, size, start + idx);
        if (hit !== null) return hit;
        idx = idx > 0 ? text.lastIndexOf(marker, idx - 1) : -1;
      }
      end = start;
    }
    return null;
  }

  function findInLines(lines: string[], first: number): T | null {
    for (let i = lines.length - 1; i >= first; i--) {
      const line = lines[i];
      if (!line || line.indexOf(marker) === -1) continue;
      try {
        const hit = extract(JSON.parse(line.trim()));
        if (hit !== null) return hit;
      } catch { continue; }
    }
    return null;
  }

  function resolve(filePath: string, tailHit: T | null, tailStart: number, size: number): T | null {
    const prev = cache.get(filePath);
    // Shrunk ⇒ rotated or truncated; nothing we remembered describes this file.
    const entry = prev && size >= prev.size ? prev : undefined;
    if (prev && !entry) cache.delete(filePath);

    // The tail window is the newest bytes, so a hit there wins outright.
    if (tailHit !== null) {
      cache.set(filePath, { value: tailHit, scannedFrom: tailStart, size });
      return tailHit;
    }

    // No hit in the tail. If the range we searched before runs into this tail
    // window with no gap, [entry.scannedFrom, size) is covered and the remembered
    // answer is still the newest one there is.
    if (entry && entry.size >= tailStart) {
      cache.set(filePath, { ...entry, size });
      return entry.value;
    }

    // Either nothing remembered, or appends opened a gap wider than the tail
    // window. Re-establish coverage from byte 0 — simpler than stitching ranges,
    // and it happens at most once per file in the common case.
    if (tailStart <= 0) {
      // The tail already was the whole file; the miss is authoritative.
      cache.set(filePath, { value: null, scannedFrom: 0, size });
      return null;
    }

    let fd: number | undefined;
    let found: T | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      fullScans++;
      found = scanBack(fd, size, tailStart);
    } catch {
      return entry ? entry.value : null;   // unreadable now — keep what we had
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }

    cache.set(filePath, { value: found, scannedFrom: 0, size });
    return found;
  }

  return {
    findInLines,
    resolve,
    reset() { cache.clear(); fullScans = 0; },
    stats() { return { entries: cache.size, fullScans }; }
  };
}
