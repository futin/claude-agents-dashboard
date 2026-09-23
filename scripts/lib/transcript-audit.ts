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
import path from 'node:path';

import { listUsageTranscripts, sessionSurface } from '../../server/lib/scan.js';
import { rawTokens, sumWindow, weightedTokens, weightsFor } from '../../server/lib/usage-ledger.js';
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
  /** The top-level session: a nested file's parent session, else the file's own basename. */
  session: string;
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
    .map(ref => ({
      file: ref.file, nested: ref.parentId !== null, session: ref.parentId ?? path.basename(ref.file, '.jsonl'),
      mtimeMs: ref.mtimeMs
    }));
}

/**
 * Call `onRecord` for every parseable line of every file. A junk line costs
 * that line; an unreadable file costs that file. `filter` is a cheap substring
 * test run before `JSON.parse`, which is most of the cost on a gigabyte of logs;
 * given several, a line containing any one of them passes.
 */
export function scanFiles(
  files: AuditFile[], onRecord: (raw: Record<string, any>, file: AuditFile) => void, filter?: string | string[]
): void {
  const needles = filter === undefined ? undefined : typeof filter === 'string' ? [filter] : filter;
  for (const f of files) {
    let text: string;
    try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line === '' || (needles !== undefined && !needles.some(n => line.includes(n)))) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      if (raw && typeof raw === 'object') onRecord(raw as Record<string, any>, f);
    }
  }
}

// ── records ──

/** One deduplicated assistant turn, with everything the five reports ask about it. */
export interface AuditRecord {
  ts: number;
  model: string;
  tok: TokenCounts;
  /** Record `entrypoint`, `''` when absent. */
  entrypoint: string;
  /** Record `effort`, `''` when absent. */
  effort: string;
  nested: boolean;
  /** The top-level session id — a nested subagent record resolves to its parent's. */
  session: string;
  /**
   * The `permissionMode` of the latest `user` line at or before `ts` in the
   * same session — the record's own file first, then (nested) the parent
   * session's top-level file. `''` when no mode line precedes it. Assistant
   * lines never carry the field, so it has to be inherited.
   */
  permissionMode: string;
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
export function recordFromLine(raw: Record<string, any>, nested: boolean, session = ''): AuditRecord | null {
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
    session,
    permissionMode: '',
    speed: str(u.speed),
    serviceTier: str(u.service_tier),
    isApiError: raw.isApiErrorMessage === true,
    stopReason: str(msg.stop_reason)
  };
}

/** One `user` line's `permissionMode`, at its timestamp. */
export interface ModeMark {
  ts: number;
  mode: string;
}

/** The mode of the latest mark at or before `ts`, or undefined when none precedes it. `marks` sorted by `ts`. */
export function modeAt(marks: ModeMark[] | undefined, ts: number): string | undefined {
  if (!marks) return undefined;
  let lo = 0, hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].ts <= ts) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? undefined : marks[lo - 1].mode;
}

/**
 * Every record in `files`, deduplicated **globally** on `message.id` — one
 * assistant message is copied into as many transcripts as reference it. A line
 * with no id is kept as-is: under-counting a real turn is the worse error.
 *
 * The same pass reads the `user` lines that carry `permissionMode` and gives
 * each record its inherited mode (see {@link AuditRecord.permissionMode}).
 */
export function readRecords(files: AuditFile[]): AuditRecord[] {
  const out: AuditRecord[] = [];
  const fileOf: AuditFile[] = [];
  const seen = new Set<string>();
  const byFile = new Map<string, ModeMark[]>();
  const bySession = new Map<string, ModeMark[]>();
  const push = (m: Map<string, ModeMark[]>, key: string, mark: ModeMark): void => {
    const list = m.get(key);
    if (list) list.push(mark); else m.set(key, [mark]);
  };
  scanFiles(files, (raw, f) => {
    if (raw.type === 'user' && typeof raw.permissionMode === 'string') {
      const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
      if (!Number.isFinite(ts)) return;
      push(byFile, f.file, { ts, mode: raw.permissionMode });
      if (!f.nested) push(bySession, f.session, { ts, mode: raw.permissionMode });
      return;
    }
    const rec = recordFromLine(raw, f.nested, f.session);
    if (!rec) return;
    const id = str(raw.message?.id);
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    out.push(rec);
    fileOf.push(f);
  }, ['"usage"', '"permissionMode"']);
  for (const m of [byFile, bySession]) for (const list of m.values()) list.sort((a, b) => a.ts - b.ts);
  out.forEach((rec, i) => {
    const f = fileOf[i];
    rec.permissionMode = modeAt(byFile.get(f.file), rec.ts)
      ?? (f.nested ? modeAt(bySession.get(f.session), rec.ts) : undefined) ?? '';
  });
  return out;
}

/**
 * Per session, the timestamps of the assistant lines the rebuild never prices:
 * `isApiErrorMessage` lines and assistant lines with no `message.usage` — the
 * on-disk trace of a retry or a 529. Sorted.
 */
export function readOffbookMarks(files: AuditFile[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  scanFiles(files, (raw, f) => {
    if (raw.message?.role !== 'assistant') return;
    const u = raw.message.usage;
    if (raw.isApiErrorMessage !== true && u && typeof u === 'object') return;
    const ts = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
    if (!Number.isFinite(ts)) return;
    const list = out.get(f.session);
    if (list) list.push(ts); else out.set(f.session, [ts]);
  }, '"assistant"');
  for (const list of out.values()) list.sort((a, b) => a - b);
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
  /**
   * Utilization of the sample the bin starts from — the first merged
   * interval's `fromT` looked up in `utilAt`. Null when no lookup was given or
   * it has no such sample.
   */
  fromUtil: number | null;
}

/**
 * Priced, non-`external` intervals sorted by `toT`, merged while each one
 * starts where the previous ended and the merged span stays within
 * {@link BIN_MAX_MS}. Merging trades time resolution for a Σutil large enough
 * that the ~1-point rounding of each sample stops dominating the ratio.
 */
export function mergeBins(intervals: Interval[], utilAt?: Map<number, number>): Bin[] {
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
      bins.push({ fromT: iv.fromT, toT: iv.toT, dUtil: iv.dUtil, tok, intervals: 1, fromUtil: utilAt?.get(iv.fromT) ?? null });
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

// ── accumulate ──

/** One row of a per-bin table: Σutil, weight and composition over the bins added to it. */
export interface Acc {
  bins: number; util: number; weighted: number; requests: number;
  cc: number; cr: number; out: number; ccW: number; crW: number; outW: number;
}

export const emptyAcc = (): Acc => ({ bins: 0, util: 0, weighted: 0, requests: 0, cc: 0, cr: 0, out: 0, ccW: 0, crW: 0, outW: 0 });

/** Add `bin`'s `model` spend to `acc`. The bin must hold tokens for `model`. */
export function addBin(acc: Acc, bin: Bin, requests: number, model: string): void {
  const c = bin.tok[model];
  const w = weightsFor(model);
  acc.bins++;
  acc.util += bin.dUtil;
  acc.requests += requests;
  acc.weighted += weightedTokens(c, model);
  acc.cc += c.cc; acc.cr += c.cr; acc.out += c.out;
  acc.ccW += c.cc * w.cc; acc.crW += c.cr * w.cr; acc.outW += c.out * w.out;
}

// ── gap ──

/** A pooled interactive/headless ratio under this is not a gap worth explaining. */
export const GAP_MIN_RATIO = 1.3;

/** The levels both surfaces populate must hold this share of headless weight for a share to be computed. */
export const SURFACE_COVERAGE_MIN = 0.8;

/** A covariate explaining at least this share of the gap names it. */
export const NAMED_MIN_SHARE = 0.5;

/** The on-disk covariates `gap` stratifies by, in print order. */
export const COVARIATES = ['mode', 'concurrency', 'nestedShare', 'utilBand', 'offbook'] as const;
export type Covariate = typeof COVARIATES[number];

export interface Covariates extends Record<Covariate, string> {
  surface: string;
}

/**
 * One bin's covariate levels, from its records for the model — null for no
 * records. `offbook` is per session: timestamps of that session's unpriced
 * assistant lines ({@link readOffbookMarks}); one inside `(fromT, toT]` of a
 * session the bin spent in makes the bin `errors`.
 */
export function binCovariates(
  records: AuditRecord[], bin: Pick<Bin, 'fromT' | 'toT' | 'fromUtil'>, offbook?: Map<string, number[]>
): Covariates | null {
  if (records.length === 0) return null;
  const byEp = new Map<string, number>();
  const byMode = new Map<string, number>();
  const sessions = new Set<string>();
  let total = 0, nested = 0;
  for (const r of records) {
    const w = recordWeighted(r);
    byEp.set(r.entrypoint, (byEp.get(r.entrypoint) ?? 0) + w);
    byMode.set(r.permissionMode, (byMode.get(r.permissionMode) ?? 0) + w);
    sessions.add(r.session);
    total += w;
    if (r.nested) nested += w;
  }
  let mode = 'mixed';
  if (total > 0) for (const [m, w] of byMode) if (w / total >= SURFACE_DOMINANCE) mode = m || '(none)';
  const share = total > 0 ? nested / total : 0;
  const u = bin.fromUtil;
  let errors = false;
  for (const s of sessions) {
    if ((offbook?.get(s) ?? []).some(t => t > bin.fromT && t <= bin.toT)) { errors = true; break; }
  }
  return {
    surface: surfaceLabel(byEp),
    mode,
    concurrency: sessions.size >= 3 ? '3+' : String(sessions.size),
    nestedShare: share < 0.25 ? '<25%' : share < 0.5 ? '25-50%' : '>=50%',
    utilBand: u === null ? '(none)' : u < 80 ? '<80' : u < 95 ? '80-94' : '>=95',
    offbook: errors ? 'errors' : 'clean'
  };
}

/** A bin with its covariate levels and request count, ready to stratify. */
export interface LabelledBin {
  bin: Bin;
  cov: Covariates;
  requests: number;
}

/** `surface -> level -> Acc` for one covariate. */
export function stratify(bins: LabelledBin[], covariate: Covariate, model: string): Map<string, Map<string, Acc>> {
  const out = new Map<string, Map<string, Acc>>();
  for (const { bin, cov, requests } of bins) {
    const rows = out.get(cov.surface) ?? out.set(cov.surface, new Map()).get(cov.surface)!;
    const level = cov[covariate];
    addBin(rows.get(level) ?? rows.set(level, emptyAcc()).get(level)!, bin, requests, model);
  }
  return out;
}

/** Fold several surfaces' level tables into one — every interactive entrypoint as one side. */
export function mergeLevels(tables: Map<string, Acc>[]): Map<string, Acc> {
  const out = new Map<string, Acc>();
  for (const t of tables) {
    for (const [level, a] of t) {
      const b = out.get(level) ?? out.set(level, emptyAcc()).get(level)!;
      for (const k of Object.keys(a) as (keyof Acc)[]) b[k] += a[k];
    }
  }
  return out;
}

function pooledRate(levels: Map<string, Acc>): number | null {
  let w = 0, u = 0;
  for (const a of levels.values()) { w += a.weighted; u += a.util; }
  return u > 0 && w > 0 ? w / u : null;
}

/** Interactive over headless pooled weighted-per-1% — how many times more window a headless token spends. */
export function gapRatio(interactive: Map<string, Acc>, headless: Map<string, Acc>): number | null {
  const rI = pooledRate(interactive), rH = pooledRate(headless);
  return rI === null || rH === null ? null : rI / rH;
}

/**
 * The share of the interactive/headless gap one covariate explains: headless
 * tokens priced at the interactive rate of their own level,
 * `R* = Σ wH(l) / Σ (wH(l) / rI(l))`, against the two pooled rates,
 * `(rI − R*) / (rI − rH)`. 1 means the headless mix over levels predicts the
 * whole gap; 0 means it predicts none of it.
 *
 * Null when the levels both sides populate hold under {@link SURFACE_COVERAGE_MIN}
 * of headless weight, or the pooled gap is under {@link GAP_MIN_RATIO}.
 */
export function explainedShare(interactive: Map<string, Acc>, headless: Map<string, Acc>): number | null {
  const ratio = gapRatio(interactive, headless);
  if (ratio === null || ratio < GAP_MIN_RATIO) return null;
  const rI = pooledRate(interactive)!, rH = pooledRate(headless)!;
  let hTotal = 0, covered = 0, priced = 0;
  for (const [level, h] of headless) {
    hTotal += h.weighted;
    const i = interactive.get(level);
    if (!i || i.util <= 0 || i.weighted <= 0 || h.weighted <= 0) continue;
    covered += h.weighted;
    priced += h.weighted / (i.weighted / i.util);
  }
  if (hTotal <= 0 || covered / hTotal < SURFACE_COVERAGE_MIN) return null;
  const rStar = covered / priced;
  return (rI - rStar) / (rI - rH);
}

/**
 * The recorded outcome — `insufficient data` when `ratio` is null — `artefact` when the gap is under {@link GAP_MIN_RATIO},
 * `named: <covariate> (<share>)` for the highest share at or over
 * {@link NAMED_MIN_SHARE}, else `not on disk (best: …)`.
 */
export function gapVerdict(ratio: number | null, shares: Partial<Record<Covariate, number | null>>): string {
  if (ratio === null) return 'insufficient data (a side has too few priced bins)';
  if (ratio < GAP_MIN_RATIO) return 'artefact';
  let best: [string, number] | null = null;
  for (const [c, s] of Object.entries(shares)) if (s !== null && s !== undefined && (!best || s > best[1])) best = [c, s];
  if (best && best[1] >= NAMED_MIN_SHARE) return `named: ${best[0]} (${best[1].toFixed(2)})`;
  return `not on disk (best: ${best ? `${best[0]} ${best[1].toFixed(2)}` : 'none'})`;
}

/** Is a bin labelled `surface` on the interactive side? `mixed-surface` is on neither. */
export function isInteractive(surface: string): boolean {
  return surface !== MIXED_SURFACE && sessionSurface(surface === '(none)' ? '' : surface) === 'local';
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
