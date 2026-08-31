/**
 * usage-ledger.ts — what this machine actually spent, per minute, per model.
 *
 * `usage-history.ts` records the *price* side of the exchange (utilization
 * percent of the 5-hour window). This module records the *goods* side: the
 * tokens the transcripts on this machine show being consumed over the same
 * minute. Divide one by the other and you get what a percent is worth in
 * tokens — see `usage-rate.ts`, and `docs/subsystems/usage-limits.md`.
 *
 * Two halves, split the way the rest of this subsystem splits: a pure core
 * (weights, windowing, the line codec) that tests can drive with plain values,
 * and an I/O shell (offsets, appends, reads) around it.
 *
 * **Token types are weighted, not summed.** Output tokens cost about 5× input,
 * a cache write 1.25×, a cache read 0.1× — uniform ratios across current
 * Anthropic models, which is what makes one ratio set enough. Weighted tokens
 * are therefore mix-invariant: a turn that shifts from cache reads to fresh
 * input moves the raw count a long way and the weighted count barely at all,
 * so a *weighted* rate that moves is a repricing rather than a change of habit.
 * No dollars appear anywhere — only the ratios between types survive.
 */

import fs from 'node:fs';
import path from 'node:path';

import { listTranscripts, projectsRoot } from './scan.js';
import { getSettings } from './settings.js';
import { repoRoot } from './usage-history.js';

/** One bucket of tokens. Names are the ledger's on-disk keys, kept short. */
export interface TokenCounts {
  /** `input_tokens` */
  in: number;
  /** `output_tokens` */
  out: number;
  /** `cache_creation_input_tokens` — a cache *write*. */
  cc: number;
  /** `cache_read_input_tokens` */
  cr: number;
}

/** One recorded tick: everything consumed in `(prevT, t]`, split by model. */
export interface LedgerLine {
  /** Tick time, ms epoch. */
  t: number;
  /**
   * The previous tick's time. Carried explicitly so a recording gap is
   * *visible* — a fitter can see that two lines do not abut and refuse to
   * bridge them, which a bare `t` could never show.
   */
  prevT: number;
  /** Model id → its counts. Empty means a measured zero, not missing data. */
  tok: Record<string, TokenCounts>;
}

/** One assistant message's usage, as read out of a transcript. */
export interface UsageEvent {
  /** Message timestamp, ms epoch. */
  ts: number;
  /** `message.model`. Blank/absent events are dropped by {@link sumWindow}. */
  model: string;
  tok: TokenCounts;
}

/**
 * Cost ratios between token types, normalized to input = 1.
 *
 * From published API pricing, and deliberately *only* the ratios: per-model
 * base price differences are exactly what a fitted per-model rate absorbs, so
 * carrying absolute prices here would double-count them and put a currency in
 * a product that shows none.
 */
export const TYPE_WEIGHTS: Readonly<TokenCounts> = { in: 1, out: 5, cc: 1.25, cr: 0.1 };

/** The mix-invariant total — the quantity every rate and drift verdict is fitted on. */
export function weightedTokens(tok: TokenCounts): number {
  return tok.in * TYPE_WEIGHTS.in
    + tok.out * TYPE_WEIGHTS.out
    + tok.cc * TYPE_WEIGHTS.cc
    + tok.cr * TYPE_WEIGHTS.cr;
}

/** The plain count, for the courtesy "1% ≈ N tokens" translation only. */
export function rawTokens(tok: TokenCounts): number {
  return tok.in + tok.out + tok.cc + tok.cr;
}

/** A zeroed bucket. */
export function emptyCounts(): TokenCounts {
  return { in: 0, out: 0, cc: 0, cr: 0 };
}

/** `tok × k`, for splitting a tick that straddles an interval edge. */
export function scaleCounts(tok: TokenCounts, k: number): TokenCounts {
  return { in: tok.in * k, out: tok.out * k, cc: tok.cc * k, cr: tok.cr * k };
}

/** `into += from`, in place. */
export function addCounts(into: TokenCounts, from: TokenCounts): void {
  into.in += from.in;
  into.out += from.out;
  into.cc += from.cc;
  into.cr += from.cr;
}

/**
 * Sum events per model over the **half-open** interval `(prevT, t]`.
 *
 * Half-open, and closed on the right, so consecutive ticks tile the timeline
 * exactly once: an event landing on a tick boundary belongs to the tick that
 * just ended, never to both and never to neither.
 *
 * An event with no model is dropped rather than bucketed under `''` — an
 * unattributable token cannot support a per-model rate, and a `''` row would
 * eventually reach the UI as a model named nothing.
 */
export function sumWindow(events: UsageEvent[], prevT: number, t: number): Record<string, TokenCounts> {
  const out: Record<string, TokenCounts> = {};
  for (const e of events) {
    if (e.ts <= prevT || e.ts > t) continue;
    if (!e.model) continue;
    const bucket = out[e.model] ?? (out[e.model] = emptyCounts());
    addCounts(bucket, e.tok);
  }
  return out;
}

/** One compact JSON object, no trailing newline — the caller adds it. */
export function serializeLedgerLine(line: LedgerLine): string {
  return JSON.stringify(line);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parse one ledger line, or null when it isn't usable.
 *
 * `prevT` is required alongside `t`: without it the line cannot say how much
 * time it covers, and a fitter that guessed would silently bridge exactly the
 * gaps `prevT` exists to expose.
 */
export function parseLedgerLine(line: string): LedgerLine | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) return null;
  if (typeof raw.prevT !== 'number' || !Number.isFinite(raw.prevT)) return null;
  const rawTok = raw.tok;
  if (!rawTok || typeof rawTok !== 'object' || Array.isArray(rawTok)) return null;

  const tok: Record<string, TokenCounts> = {};
  for (const [model, counts] of Object.entries(rawTok as Record<string, unknown>)) {
    if (!model || !counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
    const c = counts as Record<string, unknown>;
    tok[model] = { in: num(c.in), out: num(c.out), cc: num(c.cc), cr: num(c.cr) };
  }
  return { t: raw.t, prevT: raw.prevT, tok };
}

// ── The I/O shell ────────────────────────────────────────────────────────────
//
// One file, gitignored, beside `.usage-history.jsonl` at the repo root — the
// two are read together and a rate is meaningless without both.

/** Append-only per-tick token ledger. Sibling of the history log. */
export const LEDGER_FILE = '.usage-ledger.jsonl';

/** ~32 MB, the same ceiling the history log uses. Trimmed to its newest half. */
export const MAX_LEDGER_BYTES = 33_554_432;

/** Read granularity for the backward scan in {@link readLedgerSince}. */
const READ_CHUNK_BYTES = 1_048_576;

const NEWLINE = 0x0a;

/**
 * Turn ids remembered per transcript, so a turn split across two ticks is not
 * counted twice. Records of one turn share a `message.id` and each carries a
 * *copy* of the same usage block (the convention `analyze.ts` handles with
 * `firstOfTurn`); a chunk boundary can land between those copies, which is the
 * only reason this outlives a single read.
 */
const MAX_SEEN_IDS = 256;

interface FileCursor {
  /** Bytes already consumed. Only ever advanced to a line boundary. */
  offset: number;
  /** Recently counted `message.id`s, oldest first. */
  seen: string[];
  seenSet: Set<string>;
}

let cursors = new Map<string, FileCursor>();
let prevTickMs: number | null = null;

/** Test seam, and what a recording toggle does: forget every offset. */
export function resetLedgerRecorder(): void {
  cursors = new Map();
  prevTickMs = null;
}

function ledgerPath(dir?: string): string {
  return path.join(dir ?? repoRoot(), LEDGER_FILE);
}

function remember(cursor: FileCursor, id: string): void {
  cursor.seen.push(id);
  cursor.seenSet.add(id);
  while (cursor.seen.length > MAX_SEEN_IDS) {
    const dropped = cursor.seen.shift();
    if (dropped !== undefined) cursor.seenSet.delete(dropped);
  }
}

function numField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read one transcript record into an event, or null when it carries no spend.
 *
 * Mirrors `analyze.ts`'s conventions for the same on-disk shape, with one
 * deliberate difference: **sidechain (subagent) turns are counted here.**
 * `analyze.ts` skips them so a session's main-agent totals don't double against
 * `bySubagent`; this ledger is asking what the *account* spent, and a subagent
 * turn spends exactly as much as any other.
 */
function eventFromRecord(raw: unknown, cursor: FileCursor): UsageEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, any>;
  const msg = rec.message;
  if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return null;

  const tok: TokenCounts = {
    in: numField(u.input_tokens),
    out: numField(u.output_tokens),
    cc: numField(u.cache_creation_input_tokens),
    cr: numField(u.cache_read_input_tokens)
  };
  if (rawTokens(tok) <= 0) return null;

  const model = typeof msg.model === 'string' ? msg.model : '';
  if (!model) return null;

  // Without an id the record is its own turn — the same fail-open `analyze.ts`
  // takes, and the honest one: under-counting a real turn is worse than the
  // rare double-count a missing id could hide.
  const id = typeof msg.id === 'string' && msg.id ? msg.id : '';
  if (id) {
    if (cursor.seenSet.has(id)) return null;
    remember(cursor, id);
  }

  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return null;

  return { ts, model, tok };
}

/**
 * Consume the bytes appended to every transcript since the last tick.
 *
 * Offsets only ever advance to a **line boundary**: a transcript being written
 * while we read it ends mid-line, and re-reading that fragment next tick is the
 * only way it is ever seen whole. A file shorter than its stored offset was
 * rotated or truncated, so its cursor restarts at 0 — `sumWindow` then drops
 * everything already outside this tick's window.
 */
function collectEvents(root: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const ref of listTranscripts(root)) {
    let size: number;
    try {
      size = fs.statSync(ref.file).size;
    } catch {
      continue;
    }
    let cursor = cursors.get(ref.file);
    if (!cursor) {
      cursor = { offset: 0, seen: [], seenSet: new Set() };
      cursors.set(ref.file, cursor);
    }
    if (size < cursor.offset) cursor.offset = 0; // rotated out from under us
    if (size <= cursor.offset) continue;

    let fd: number | undefined;
    try {
      fd = fs.openSync(ref.file, 'r');
      const length = size - cursor.offset;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, cursor.offset);
      const lastNewline = buf.lastIndexOf(NEWLINE);
      if (lastNewline === -1) continue; // no complete line yet — re-read next tick
      const complete = buf.subarray(0, lastNewline);
      cursor.offset += lastNewline + 1;
      for (const line of complete.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a junk line costs one record, never the tick
        }
        const event = eventFromRecord(parsed, cursor);
        if (event) events.push(event);
      }
    } catch {
      /* unreadable transcript — skip it, never break the tick */
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

/** Best-effort append, exactly like `appendSample`. */
function appendLedgerLine(line: LedgerLine, dir?: string): void {
  try {
    fs.appendFileSync(ledgerPath(dir), serializeLedgerLine(line) + '\n', 'utf8');
  } catch {
    /* read-only fs / missing dir — recording is best-effort by design */
  }
}

/** Trim the ledger to its newest half once it passes `maxBytes`. */
export function rotateLedgerIfNeeded(dir?: string, maxBytes: number = MAX_LEDGER_BYTES): void {
  const file = ledgerPath(dir);
  let fd: number | undefined;
  try {
    const { size } = fs.statSync(file);
    if (size <= maxBytes) return;
    const keep = Math.floor(maxBytes / 2);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, size - keep);
    const first = buf.indexOf(NEWLINE);
    if (first === -1) return; // one absurd line — leave it alone
    fs.writeFileSync(file, buf.subarray(first + 1), 'utf8');
  } catch {
    /* absent / unreadable / read-only — leave it alone */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Record one tick: everything the transcripts on this machine consumed since
 * the previous tick, per model, as one line.
 *
 * Called beside `recordTick` on the usage fetch's success path, so a ledger
 * line and a history sample describe the same instant — which is the whole
 * basis of the join in `usage-rate.ts`.
 *
 * **A line is written every tick, even an empty one.** `tok: {}` is a measured
 * zero — this machine spent nothing this minute — and that is data: it is what
 * separates "no local tokens" (someone else's device burned the window) from
 * "not recording" (no line at all).
 *
 * The **first tick after start writes nothing**: it only seeds the offsets, so
 * whatever was already on disk isn't attributed to one minute. Switching
 * recording off drops that state, so switching it back on reseeds the same way
 * — one lost minute instead of a backlog dumped into a single interval.
 *
 * `dir` (ledger location) and `root` (transcripts) are injectable for tests;
 * production passes neither. Never throws — this runs inside the usage fetch.
 */
export function recordLedgerTick(opts?: { dir?: string; root?: string; nowMs?: number }): void {
  try {
    if (!getSettings().recordUsageHistory) {
      // Not a pause: the offsets would be stale by an unknown amount when it
      // came back, and one tick of reseeding is cheaper than a wrong interval.
      if (prevTickMs !== null || cursors.size > 0) resetLedgerRecorder();
      return;
    }
    const nowMs = opts?.nowMs ?? Date.now();
    const events = collectEvents(opts?.root ?? projectsRoot());

    if (prevTickMs === null || nowMs <= prevTickMs) {
      prevTickMs = nowMs; // seeding tick (or a clock that went backwards)
      return;
    }
    appendLedgerLine({ t: nowMs, prevT: prevTickMs, tok: sumWindow(events, prevTickMs, nowMs) }, opts?.dir);
    prevTickMs = nowMs;
    rotateLedgerIfNeeded(opts?.dir);
  } catch {
    /* fail open — the ledger must never break the usage fetch */
  }
}

/**
 * Every ledger line stamped at or after `sinceMs`, oldest first.
 *
 * Read **backwards** in chunks and stopped at the first line older than the
 * cutoff, rather than tail-reading a fixed byte window: a fixed cap that
 * happened to be smaller than the caller's horizon would silently drop the
 * oldest part of the baseline, and a baseline quietly fitted on less data than
 * it claims is exactly the failure this feature exists to catch. Malformed
 * lines are skipped individually and never end the scan.
 */
export function readLedgerSince(sinceMs: number, dir?: string): LedgerLine[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(ledgerPath(dir), 'r');
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return [];

    const newestFirst: LedgerLine[] = [];
    let end = size;
    // `subarray` keeps the parent's buffer type, which is not the plain
    // `Buffer` alias — name it once rather than casting at every slice.
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let done = false;

    while (end > 0 && !done) {
      const start = Math.max(0, end - READ_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const combined = Buffer.concat([buf, carry]);
      carry = Buffer.alloc(0);

      const segments: Buffer<ArrayBufferLike>[] = [];
      let idx = 0;
      for (;;) {
        const nl = combined.indexOf(NEWLINE, idx);
        if (nl === -1) break;
        segments.push(combined.subarray(idx, nl));
        idx = nl + 1;
      }
      // Whatever follows the last newline is a whole line: on the first pass
      // it is a file not ending in one, and afterwards it is the line that
      // straddled the chunk boundary (the carry cannot contain a newline).
      const trailing = combined.subarray(idx);
      if (trailing.length > 0) segments.push(trailing);
      // The head of this chunk continues a line that started in the previous
      // one — carried as bytes, never as a string, so a multi-byte character
      // split across the boundary survives.
      if (start > 0 && segments.length > 0) carry = segments.shift() as Buffer<ArrayBufferLike>;

      for (let i = segments.length - 1; i >= 0; i--) {
        const text = segments[i].toString('utf8').trim();
        if (text === '') continue;
        const parsed = parseLedgerLine(text);
        if (!parsed) continue;
        if (parsed.t < sinceMs) { done = true; break; }
        newestFirst.push(parsed);
      }
      end = start;
    }
    return newestFirst.reverse();
  } catch {
    return []; // absent / unreadable — no ledger is not an error
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
