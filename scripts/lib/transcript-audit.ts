/**
 * transcript-audit.ts — the pipeline behind `scripts/rates-audit.ts`: the
 * Token-value card's inputs re-derived **from the transcripts**, a data path
 * that never reads `.usage-ledger.jsonl` for its tokens.
 *
 * Pure except for {@link walkTranscripts} and {@link scanFiles}; every report
 * function takes its records, ticks and clock as arguments so the tests can
 * drive them without a subprocess. One function per stage — walk, records,
 * rebuild, bins — so a change to how the recorder enumerates or reads a
 * transcript is a one-line change here too.
 *
 * Weights are always `weightedTokens(tok, model)`. The scratchpad probe this
 * replaced inlined `{1, 5, 2, 0.1}` and mis-weighted Fable's 0.025 cache read.
 */

import fs from 'node:fs';

import { listUsageTranscripts } from '../../server/lib/scan.js';
import { rawTokens, sumWindow, weightedTokens } from '../../server/lib/usage-ledger.js';
import type { LedgerLine, TokenCounts, UsageEvent } from '../../server/lib/usage-ledger.js';
import { DOMINANCE, isUnpriced, totalWeighted } from '../../server/lib/usage-rate.js';
import type { Interval } from '../../server/lib/usage-rate.js';

export const DAY_MS = 86_400_000;

/** A request is "long context" past this many input-side tokens — the >200k price tier. */
export const LONG_CONTEXT_TOKENS = 200_000;

/** One entrypoint must hold this share of a bin's model-weighted tokens for the bin to be that surface's. */
export const SURFACE_DOMINANCE = 0.8;

/** Longest span one merged bin may cover. */
export const BIN_MAX_MS = 30 * 60_000;

/** The `ledger` gate: rows with at least this much disk weight must reconcile. */
export const GATE_FLOOR_WEIGHTED = 5_000_000;
export const GATE_MIN_RATIO = 0.95;
export const GATE_MAX_RATIO = 1.05;

/** The label a bin gets when no entrypoint holds {@link SURFACE_DOMINANCE}. */
export const MIXED_SURFACE = 'mixed-surface';

// ── walk ──

export interface AuditFile {
  file: string;
  /** `<projectDir>/<sessionId>/subagents/*.jsonl` rather than `<projectDir>/<file>`. */
  nested: boolean;
  mtimeMs: number;
}

/**
 * Every transcript under `root` modified at or after `sinceMs`.
 *
 * Delegates to the recorder's own enumerator, `listUsageTranscripts`, so this
 * audit reads exactly the files the ledger reads — including the `subagents/`
 * ones bug-22 was about. `listTranscripts` is one level deep and must not be
 * used here.
 */
export function walkTranscripts(root: string, sinceMs: number): AuditFile[] {
  return listUsageTranscripts(root)
    .filter(ref => ref.mtimeMs >= sinceMs)
    .map(ref => ({ file: ref.file, nested: ref.parentId !== null, mtimeMs: ref.mtimeMs }));
}

/**
 * Call `onRecord` for every parseable line of every file. A junk line costs
 * that line; an unreadable file costs that file. `filter` is a cheap substring
 * test run before `JSON.parse`, which is most of the cost on a gigabyte of logs.
 */
export function scanFiles(
  files: AuditFile[], onRecord: (raw: Record<string, any>, file: AuditFile) => void, filter?: string
): void {
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line === '' || (filter !== undefined && !line.includes(filter))) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      if (raw && typeof raw === 'object') onRecord(raw as Record<string, any>, f);
    }
  }
}

// ── records ──

/** One deduplicated assistant turn, with everything the four reports ask about it. */
export interface AuditRecord {
  ts: number;
  model: string;
  tok: TokenCounts;
  /** Record `entrypoint`, `''` when absent. */
  entrypoint: string;
  /** Record `effort`, `''` when absent. */
  effort: string;
  nested: boolean;
  /** `usage.speed`, `''` when absent. */
  speed: string;
  /** `usage.service_tier`, `''` when absent. */
  serviceTier: string;
  isApiError: boolean;
  stopReason: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * One transcript line as a record, or null when it is not an assistant line
 * with `message.usage`, a string `message.model` and a parseable `timestamp`.
 * No dedupe here — that is {@link readRecords}' job, and it is global.
 */
export function recordFromLine(raw: Record<string, any>, nested: boolean): AuditRecord | null {
  const msg = raw.message;
  if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return null;
  if (typeof msg.model !== 'string' || msg.model === '') return null;
  const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    model: msg.model,
    tok: {
      in: num(u.input_tokens), out: num(u.output_tokens),
      cc: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens)
    },
    entrypoint: str(raw.entrypoint),
    effort: str(raw.effort),
    nested,
    speed: str(u.speed),
    serviceTier: str(u.service_tier),
    isApiError: raw.isApiErrorMessage === true,
    stopReason: str(msg.stop_reason)
  };
}

/**
 * Every record in `files`, deduplicated **globally** on `message.id` — one
 * assistant message is copied into as many transcripts as reference it. A line
 * with no id is kept as-is: under-counting a real turn is the worse error.
 */
export function readRecords(files: AuditFile[]): AuditRecord[] {
  const out: AuditRecord[] = [];
  const seen = new Set<string>();
  scanFiles(files, (raw, f) => {
    const rec = recordFromLine(raw, f.nested);
    if (!rec) return;
    const id = str(raw.message?.id);
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    out.push(rec);
  }, '"usage"');
  return out;
}

export function recordWeighted(r: AuditRecord): number {
  return weightedTokens(r.tok, r.model);
}

// ── rebuild ──

export interface Rebuild {
  /** One line per real tick, holding what the transcripts say was spent in it. */
  lines: LedgerLine[];
  /** Records that fell inside no tick — reported, never silently dropped. */
  outsideTick: number;
}

/**
 * A synthetic ledger on the **real** ledger's tick boundaries: each record goes
 * to the tick with `prevT < ts ≤ t`, and each tick is summed by the recorder's
 * own `sumWindow`, so `req` and `sur` mean what they mean on disk. Records with
 * no tokens are skipped exactly as the recorder skips them.
 */
export function rebuildLedger(records: AuditRecord[], ticks: LedgerLine[]): Rebuild {
  const sorted = [...ticks].sort((a, b) => a.t - b.t);
  const buckets: UsageEvent[][] = sorted.map(() => []);
  let outsideTick = 0;
  for (const r of records) {
    if (rawTokens(r.tok) <= 0) continue;
    // First tick whose `t` is at or after the record.
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t < r.ts) lo = mid + 1; else hi = mid;
    }
    if (lo === sorted.length || sorted[lo].prevT >= r.ts) { outsideTick++; continue; }
    buckets[lo].push({ ts: r.ts, model: r.model, tok: r.tok, surface: r.entrypoint });
  }
  const lines = sorted.map((tick, i) => ({ t: tick.t, prevT: tick.prevT, ...sumWindow(buckets[i], tick.prevT, tick.t) }));
  return { lines, outsideTick };
}

// ── bins ──

/** Contiguous priced intervals merged into one span of at most {@link BIN_MAX_MS}. */
export interface Bin {
  fromT: number;
  toT: number;
  dUtil: number;
  tok: Record<string, TokenCounts>;
  intervals: number;
}

/**
 * Priced, non-`external` intervals sorted by `toT`, merged while each one
 * starts where the previous ended and the merged span stays within
 * {@link BIN_MAX_MS}. Merging trades time resolution for a Σutil large enough
 * that the ~1-point rounding of each sample stops dominating the ratio.
 */
export function mergeBins(intervals: Interval[]): Bin[] {
  const usable = intervals
    .filter(iv => !isUnpriced(iv.kind) && iv.kind !== 'external')
    .sort((a, b) => a.toT - b.toT);
  const bins: Bin[] = [];
  for (const iv of usable) {
    const last = bins[bins.length - 1];
    if (last && iv.fromT === last.toT && iv.toT - last.fromT <= BIN_MAX_MS) {
      last.toT = iv.toT;
      last.dUtil += iv.dUtil;
      addInto(last.tok, iv.tok);
      last.intervals++;
    } else {
      const tok: Record<string, TokenCounts> = {};
      addInto(tok, iv.tok);
      bins.push({ fromT: iv.fromT, toT: iv.toT, dUtil: iv.dUtil, tok, intervals: 1 });
    }
  }
  return bins;
}

function addInto(into: Record<string, TokenCounts>, from: Record<string, TokenCounts>): void {
  for (const [model, c] of Object.entries(from)) {
    const b = into[model] ?? (into[model] = { in: 0, out: 0, cc: 0, cr: 0 });
    b.in += c.in; b.out += c.out; b.cc += c.cc; b.cr += c.cr;
  }
}

/** Does `model` hold {@link DOMINANCE} of the bin's weighted tokens? */
export function modelDominates(bin: Bin, model: string): boolean {
  const total = totalWeighted(bin.tok);
  const own = bin.tok[model] ? weightedTokens(bin.tok[model], model) : 0;
  return total > 0 && own / total >= DOMINANCE;
}

/** The entrypoint holding {@link SURFACE_DOMINANCE} of these weights, else {@link MIXED_SURFACE}. */
export function surfaceLabel(weightByEntrypoint: Map<string, number>): string {
  let total = 0;
  for (const w of weightByEntrypoint.values()) total += w;
  if (total <= 0) return MIXED_SURFACE;
  for (const [ep, w] of weightByEntrypoint) if (w / total >= SURFACE_DOMINANCE) return ep || '(none)';
  return MIXED_SURFACE;
}

// ── ledger ──

export interface LedgerRow {
  day: string;
  model: string;
  diskTop: number;
  diskNested: number;
  disk: number;
  /**
   * The part of `disk` that falls inside some real ledger tick — what the
   * recorder was running to see. `disk − inTicks` is spend while it was down,
   * which reads low in `ratio` exactly like a blind spot does; this column is
   * how a reader tells the two apart. It does not change the gate.
   */
  inTicks: number;
  recorded: number;
  /** `recorded / disk`, null when disk is zero. */
  ratio: number | null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The last `days` complete UTC days before `nowMs`'s, oldest first. */
export function completeDays(nowMs: number, days: number): { sinceMs: number; untilMs: number } {
  const untilMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { sinceMs: untilMs - days * DAY_MS, untilMs };
}

/**
 * Per UTC day × model inside `[sinceMs, untilMs)`: disk weight split top-level
 * / nested, and what the ledger recorded, by each line's `t`.
 */
export function ledgerRows(
  records: AuditRecord[], ledger: LedgerLine[], sinceMs: number, untilMs: number
): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  const row = (day: string, model: string): LedgerRow => {
    const key = day + '\u0000' + model;
    let r = rows.get(key);
    if (!r) rows.set(key, r = { day, model, diskTop: 0, diskNested: 0, disk: 0, inTicks: 0, recorded: 0, ratio: null });
    return r;
  };
  for (const rec of records) {
    if (rec.ts < sinceMs || rec.ts >= untilMs) continue;
    const r = row(utcDay(rec.ts), rec.model);
    const w = recordWeighted(rec);
    if (rec.nested) r.diskNested += w; else r.diskTop += w;
    r.disk += w;
  }
  for (const line of ledger) {
    if (line.t < sinceMs || line.t >= untilMs) continue;
    for (const [model, c] of Object.entries(line.tok)) row(utcDay(line.t), model).recorded += weightedTokens(c, model);
  }
  for (const line of rebuildLedger(records, ledger).lines) {
    if (line.t < sinceMs || line.t >= untilMs) continue;
    for (const [model, c] of Object.entries(line.tok)) row(utcDay(line.t), model).inTicks += weightedTokens(c, model);
  }
  const out = [...rows.values()];
  for (const r of out) r.ratio = r.disk > 0 ? r.recorded / r.disk : null;
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

/**
 * The rows that fail the gate: disk weight at least {@link GATE_FLOOR_WEIGHTED}
 * and a ratio outside `[0.95, 1.05]`. Low is the recorder's blind spot; high is
 * double counting. Rows under the floor print and never gate.
 */
export function gateFailures(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter(r => r.disk >= GATE_FLOOR_WEIGHTED
    && (r.ratio === null || r.ratio < GATE_MIN_RATIO || r.ratio > GATE_MAX_RATIO));
}

// ── modifiers ──

export interface ModifierRow {
  day: string;
  weighted: number;
  bySpeed: Map<string, number>;
  byTier: Map<string, number>;
  byEffort: Map<string, number>;
  /** Weighted tokens in requests whose `in + cc + cr` exceeds {@link LONG_CONTEXT_TOKENS}. */
  longContext: number;
  requests: number;
  contextSum: number;
  outputSum: number;
}

function bump(m: Map<string, number>, key: string, by: number): void {
  const k = key || '(none)';
  m.set(k, (m.get(k) ?? 0) + by);
}

/** Per UTC day, for one model: what the requests themselves looked like. */
export function modifierRows(records: AuditRecord[], model: string): ModifierRow[] {
  const rows = new Map<string, ModifierRow>();
  for (const rec of records) {
    if (rec.model !== model) continue;
    const day = utcDay(rec.ts);
    let r = rows.get(day);
    if (!r) {
      rows.set(day, r = {
        day, weighted: 0, bySpeed: new Map(), byTier: new Map(), byEffort: new Map(),
        longContext: 0, requests: 0, contextSum: 0, outputSum: 0
      });
    }
    const w = recordWeighted(rec);
    const ctx = rec.tok.in + rec.tok.cc + rec.tok.cr;
    r.weighted += w;
    bump(r.bySpeed, rec.speed, w);
    bump(r.byTier, rec.serviceTier, w);
    bump(r.byEffort, rec.effort, w);
    if (ctx > LONG_CONTEXT_TOKENS) r.longContext += w;
    r.requests++;
    r.contextSum += ctx;
    r.outputSum += rec.tok.out;
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** `fast=75.0% standard=25.0%`, largest share first. */
export function formatShares(m: Map<string, number>): string {
  let total = 0;
  for (const v of m.values()) total += v;
  if (total <= 0) return '-';
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${((v / total) * 100).toFixed(1)}%`)
    .join(' ');
}
