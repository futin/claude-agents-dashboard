/**
 * jsonl-tail.ts — follow an append-only JSONL file by byte offset.
 *
 * Two layers. `foldLines` is the read loop every transcript and log follower shares (agents-cache.ts and session-spend.ts through `followJsonl`;
 * tasks.ts, pr-detect.ts, usage-ledger.ts, routine-log.ts and routine-run.ts directly); `followJsonl` adds a parse and the EOF rule on top. The rules:
 *  - Offsets are BYTES and lines are split on 0x0A before decoding — a multibyte
 *    UTF-8 sequence can straddle a read boundary, so string lengths must never
 *    drive the offset.
 *  - Reads are chunked (`FOLD_CHUNK_BYTES`), so memory is bounded by one chunk plus the longest line, never the whole unread span. A line longer than a
 *    chunk is carried across chunks and delivered whole (single records run past 1 MiB: 1.36 MB seen, 2026-10-07).
 *  - A read can end mid-line; `foldLines` hands that fragment back for the caller to keep. `followJsonl` buffers it in `partial` and prepends it to the
 *    next read; if the newline-less tail parses as JSON it is a complete record (a strict prefix of a JSON document never parses), so it is consumed.
 *
 * Truncation is the caller's to detect (`size < tail.offset`), because whatever it
 * derived from the consumed bytes has to be reset along with the tail.
 */

import fs from 'node:fs';

export interface JsonlTail {
  /** Bytes read so far: a line boundary or a consumed EOF tail, plus `partial`. */
  offset: number;
  /** The last bytes before `offset`, read but not yet forming a parseable line. */
  partial: Buffer;
}

export function createTail(): JsonlTail {
  return { offset: 0, partial: Buffer.alloc(0) };
}

/** Most bytes one `readSync` asks for. */
export const FOLD_CHUNK_BYTES = 1024 * 1024;

export interface FoldOptions {
  /** Most bytes per read; default {@link FOLD_CHUNK_BYTES}. */
  chunkBytes?: number;
  /** The fragment an earlier call handed back: the bytes at `[cursor.offset, cursor.offset + carry.length)`, already read, so reading resumes after them. */
  carry?: Buffer;
  /** Called with each read's byte count, as it happens — so a caller's read statistics stay exact even when `onLine` throws. */
  onRead?: (bytes: number) => void;
}

/**
 * Hand every complete line of `[cursor.offset, size)` to `onLine`, as a raw Buffer without its 0x0A — never decoded, so a caller can prefilter the bytes
 * before paying for a parse. `cursor.offset` advances past each line only once `onLine` has returned, so if `onLine` or a read throws, `cursor.offset` is
 * the end of the last line delivered whole and a retry from it re-delivers the line that threw. Returns the newline-less fragment after the last newline
 * (empty when the span ended on one): it is not consumed, and `cursor.offset` stops before it.
 */
export function foldLines(
  fd: number, cursor: { offset: number }, size: number, onLine: (line: Buffer) => void, opts: FoldOptions = {}
): Buffer {
  const chunkBytes = opts.chunkBytes ?? FOLD_CHUNK_BYTES;
  let carry = opts.carry ?? Buffer.alloc(0);
  let pos = cursor.offset + carry.length;
  while (pos < size) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, size - pos));
    const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
    if (n <= 0) break;
    pos += n;
    opts.onRead?.(n);

    const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
    let start = 0;
    for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      onLine(buf.subarray(start, nl));
      cursor.offset += nl + 1 - start;
      start = nl + 1;
    }
    carry = buf.subarray(start);
  }
  return carry;
}

function consumeLine(lineBuf: Buffer, onRecord: (rec: any) => void): void {
  const trimmed = lineBuf.toString('utf8').trim();
  if (!trimmed) return;
  let rec: any;
  try { rec = JSON.parse(trimmed); } catch { return; }
  onRecord(rec);
}

/**
 * Feed every record appended since `tail` to `onRecord`, advancing `tail`. A read failure throws; `tail` is then left at the last line delivered whole
 * (its fragment dropped and re-read from disk next time), so a retry re-delivers nothing and loses nothing.
 */
export function followJsonl(filePath: string, size: number, tail: JsonlTail, onRecord: (rec: any) => void): void {
  let rest = tail.partial;
  if (size > tail.offset) {
    const cursor = { offset: tail.offset - tail.partial.length };
    const fd = fs.openSync(filePath, 'r');
    try {
      rest = foldLines(fd, cursor, size, line => consumeLine(line, onRecord), { carry: tail.partial });
    } catch (e) {
      tail.offset = cursor.offset;
      tail.partial = Buffer.alloc(0);
      throw e;
    } finally {
      fs.closeSync(fd);
    }
    tail.offset = cursor.offset + rest.length;
  }

  if (rest.length > 0) {
    const text = rest.toString('utf8').trim();
    if (text) {
      try {
        onRecord(JSON.parse(text));
        rest = Buffer.alloc(0);
      } catch { /* incomplete — keep buffering */ }
    } else {
      rest = Buffer.alloc(0);
    }
  }
  tail.partial = rest;
}
