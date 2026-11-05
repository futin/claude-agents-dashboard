/**
 * jsonl-tail.ts — follow an append-only JSONL file by byte offset.
 *
 * The rules agents-cache.ts and session-spend.ts both rely on:
 *  - Offsets are BYTES and lines are split on 0x0A before decoding — a multibyte
 *    UTF-8 sequence can straddle a read boundary, so string lengths must never
 *    drive the offset.
 *  - A read can end mid-line; the fragment is buffered in `partial` and prepended
 *    to the next read. If the newline-less tail parses as JSON it is a complete
 *    record (a strict prefix of a JSON document never parses), so it is consumed.
 *
 * Truncation is the caller's to detect (`size < tail.offset`), because whatever it
 * derived from the consumed bytes has to be reset along with the tail.
 */

import fs from 'node:fs';

export interface JsonlTail {
  /** Bytes consumed — always a line boundary or a consumed EOF tail. */
  offset: number;
  /** Bytes read past `offset` that don't yet form a parseable line. */
  partial: Buffer;
}

export function createTail(): JsonlTail {
  return { offset: 0, partial: Buffer.alloc(0) };
}

function consumeLine(lineBuf: Buffer, onRecord: (rec: any) => void): void {
  const trimmed = lineBuf.toString('utf8').trim();
  if (!trimmed) return;
  let rec: any;
  try { rec = JSON.parse(trimmed); } catch { return; }
  onRecord(rec);
}

/** Feed every record appended since `tail` to `onRecord`, advancing `tail`. A read failure throws. */
export function followJsonl(filePath: string, size: number, tail: JsonlTail, onRecord: (rec: any) => void): void {
  const toRead = size - tail.offset;
  let buf: Buffer;
  if (toRead > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunk = Buffer.alloc(toRead);
      const read = fs.readSync(fd, chunk, 0, toRead, tail.offset);
      buf = Buffer.concat([tail.partial, chunk.subarray(0, read)]);
      tail.offset += read;
    } finally {
      fs.closeSync(fd);
    }
  } else {
    buf = tail.partial;
  }

  let start = 0;
  let nl: number;
  while ((nl = buf.indexOf(0x0a, start)) !== -1) {
    consumeLine(buf.subarray(start, nl), onRecord);
    start = nl + 1;
  }
  let rest = buf.subarray(start);

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
