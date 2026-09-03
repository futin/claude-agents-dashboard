/**
 * usage-ledger.ts — what this machine actually spent, per minute, per model.
 *
 * The *goods* side of the exchange `usage-history.ts` prices: tokens consumed
 * over the same minute, so `usage-rate.ts` can divide one by the other. Split
 * into a pure core (weights, windowing, the line codec) and an I/O shell.
 *
 * Token types are weighted, not summed — see `docs/subsystems/usage-limits.md`
 * for why mix-invariance is the property the whole feature rests on.
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
  /** The previous tick's time. Explicit so a recording gap is *visible* — two lines that do not abut cannot be bridged. */
  prevT: number;
  /** Model id → its counts. Empty means a measured zero, not missing data. */
  tok: Record<string, TokenCounts>;
  /**
   * Model id → requests counted in the same window, or **absent** on every
   * line written before counts were recorded.
   *
   * A parallel map rather than a fifth key inside {@link TokenCounts}: the
   * count is not a token type, so `weightedTokens` / `scaleCounts` must never
   * see it, and per-model absence has to survive a parse that coerces every
   * missing token type to 0. `req` absent means *not recorded*; `req: {}` on a
   * line with spend means recorded and nothing attributable — the two-term fit
   * in `usage-rate.ts` must be able to tell those apart from a measured zero.
   */
  req?: Record<string, number>;
}

/** What one window of events measured: tokens per model, and the requests behind them. */
export interface WindowSums {
  tok: Record<string, TokenCounts>;
  /** One per event kept — an event is one deduplicated assistant `message.id`. */
  req: Record<string, number>;
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
 * Cost ratios between token types, normalized to input = 1. Deliberately only
 * the ratios: a fitted per-model rate already absorbs base price differences.
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
 * Sum events per model over the **half-open** interval `(prevT, t]`, so
 * consecutive ticks tile the timeline exactly once. An event with no model is
 * dropped rather than bucketed under `''`, which would reach the UI as a model
 * named nothing.
 */
export function sumWindow(events: UsageEvent[], prevT: number, t: number): WindowSums {
  const tok: Record<string, TokenCounts> = {};
  const req: Record<string, number> = {};
  for (const e of events) {
    if (e.ts <= prevT || e.ts > t) continue;
    if (!e.model) continue;
    const bucket = tok[e.model] ?? (tok[e.model] = emptyCounts());
    addCounts(bucket, e.tok);
    req[e.model] = (req[e.model] ?? 0) + 1;
  }
  return { tok, req };
}

/** One compact JSON object, no trailing newline — the caller adds it. */
export function serializeLedgerLine(line: LedgerLine): string {
  return JSON.stringify(line);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parse one ledger line, or null when it isn't usable. `prevT` is required
 * alongside `t`: a fitter that guessed it would bridge the gaps it exposes.
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

  // Deliberately not through `num()`: a count that coerced to 0 would claim a
  // measured zero on every line written before counts existed. Absent stays
  // absent, per model and for the line as a whole, and a junk or negative
  // count drops that model's key rather than the line.
  const rawReq = raw.req;
  let req: Record<string, number> | undefined;
  if (rawReq && typeof rawReq === 'object' && !Array.isArray(rawReq)) {
    req = {};
    for (const [model, n] of Object.entries(rawReq as Record<string, unknown>)) {
      if (!model) continue;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue;
      req[model] = n;
    }
  }
  return { t: raw.t, prevT: raw.prevT, tok, ...(req === undefined ? {} : { req }) };
}

// ── The I/O shell ────────────────────────────────────────────────────────────

/** Append-only per-tick token ledger. Gitignored, beside the history log. */
export const LEDGER_FILE = '.usage-ledger.jsonl';

/** ~32 MB, the same ceiling the history log uses. Trimmed to its newest half. */
export const MAX_LEDGER_BYTES = 33_554_432;

/** Read granularity for the backward scan in {@link readLedgerSince}. */
const READ_CHUNK_BYTES = 1_048_576;

const NEWLINE = 0x0a;

/**
 * Turn ids remembered per transcript, so a turn split across two ticks is not
 * counted twice — records of one turn each carry a *copy* of the same usage
 * block, and a chunk boundary can land between those copies.
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
 * Mirrors `analyze.ts` for the same on-disk shape with one deliberate
 * difference: **sidechain (subagent) turns are counted here.** This ledger asks
 * what the *account* spent, and a subagent turn spends like any other.
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
 * only way it is ever seen whole.
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
 * Called beside `recordTick` so a ledger line and a history sample describe the
 * same instant — the whole basis of the join in `usage-rate.ts`. A line is
 * written every tick, even an empty one, and the first tick after start writes
 * nothing; `docs/subsystems/usage-limits.md` covers why both matter.
 *
 * `dir` and `root` are injectable for tests. Never throws — this runs inside
 * the usage fetch.
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
    const { tok, req } = sumWindow(events, prevTickMs, nowMs);
    appendLedgerLine({ t: nowMs, prevT: prevTickMs, tok, req }, opts?.dir);
    prevTickMs = nowMs;
    rotateLedgerIfNeeded(opts?.dir);
  } catch {
    /* fail open — the ledger must never break the usage fetch */
  }
}

/**
 * Every ledger line stamped at or after `sinceMs`, oldest first.
 *
 * Read **backwards** in chunks to the cutoff rather than tail-reading a fixed
 * byte window: a cap smaller than the caller's horizon would silently shorten
 * the baseline, which is exactly the failure this feature exists to catch.
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
      // Whatever follows the last newline is a whole line — the carry cannot
      // contain a newline.
      const trailing = combined.subarray(idx);
      if (trailing.length > 0) segments.push(trailing);
      // Carried as bytes, never as a string, so a multi-byte character split
      // across the chunk boundary survives.
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

/**
 * At or above this size the ledger may already have been rotated, so its first
 * surviving line is a floor on recording rather than its start.
 *
 * `rotateLedgerIfNeeded` trims to `floor(MAX_LEDGER_BYTES / 2)` and the file
 * then grows back toward the maximum, so a file *under* this size has provably
 * never been trimmed.
 */
export const LEDGER_UNROTATED_MAX_BYTES = MAX_LEDGER_BYTES / 2;

/** Enough for the first line by orders of magnitude; a line is ~100 bytes. */
const HEAD_CHUNK_BYTES = 65_536;

/**
 * When recording **provably** began, or null when that cannot be proven.
 *
 * The first line covers `(prevT, t]`, so `prevT` is the instant before which
 * nothing was ever recorded — which is only the start of recording if no
 * earlier line was ever trimmed away, hence the
 * {@link LEDGER_UNROTATED_MAX_BYTES} guard. Null when the file is absent,
 * empty, unparseable at the head, or big enough to have rotated: every caller
 * then reads its unrecorded intervals as plain downtime, which overstates the
 * recorder's holes rather than inventing a start.
 */
export function ledgerStartMs(dir?: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(ledgerPath(dir), 'r');
    const { size } = fs.fstatSync(fd);
    if (size <= 0) return null;
    if (size >= LEDGER_UNROTATED_MAX_BYTES) return null;

    const length = Math.min(size, HEAD_CHUNK_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);

    let idx = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, idx);
      // Only a newline-terminated line is whole — unless the chunk *is* the
      // whole file, where the trailing bytes are a complete line.
      if (nl === -1 && length !== size) return null;
      const end = nl === -1 ? length : nl;
      const text = buf.subarray(idx, end).toString('utf8').trim();
      if (text !== '') {
        const parsed = parseLedgerLine(text);
        if (parsed) return parsed.prevT;
      }
      if (nl === -1) return null;
      idx = nl + 1;
      if (idx >= length) return null;
    }
  } catch {
    return null; // absent / unreadable — no ledger is not an error
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
