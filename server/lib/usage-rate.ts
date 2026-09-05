/**
 * usage-rate.ts — what one percent of the 5-hour window is worth, per model.
 *
 * Joins `.usage-history.jsonl` (percent) with `.usage-ledger.jsonl` (tokens)
 * into intervals and fits rates per model over them. Pure — no clock, no disk,
 * everything injected.
 *
 * Three estimators, each reading a **different** set of those intervals: the
 * pooled ratio takes only intervals one model owns outright, and the two joint
 * fits take the mixed and idle ones too. So "which intervals are discarded" has
 * no single answer — it is a property of the estimator, and the classification
 * table in `docs/subsystems/usage-limits.md` is where each one's set is written
 * down. The discipline they share is refusal: publishing nothing rather than a
 * number the evidence does not carry.
 */

import { sameWindow } from './usage-history.js';
import type { UsageSample } from './usage-history.js';
import { addCounts, emptyCounts, scaleCounts, weightedTokens } from './usage-ledger.js';
import type { LedgerLine, TokenCounts } from './usage-ledger.js';

/** Weighted share of an interval one model must hold to own it. */
export const DOMINANCE = 0.9;

/** Matches `shouldWrite`'s epsilon, so a sample the history log thought unchanged is never fitted on. */
export const IDLE_EPS = 0.01;

/** A percent is ~a million weighted tokens, so a rise backed by less was another device. */
export const EXTERNAL_WEIGHTED_MAX = 5_000;

/** Below this the recorder missed minutes we would otherwise price — the interval is unpriced. */
export const LEDGER_COVERAGE_MIN = 0.8;

/**
 * The three kinds whose tokens are missing by construction — and they are three
 * because the reasons differ, not the arithmetic:
 *
 * - `pre-ledger` — the span provably predates the ledger. Benign, and it ages
 *   out of every window on its own; nothing is broken.
 * - `gap` — recording had begun and covered *none* of the span: the recorder
 *   was down. This is the only one of the three that reports a fault.
 * - `partial` — the recorder ran but covered under {@link LEDGER_COVERAGE_MIN}
 *   of the span, so the tokens are there but incomplete.
 */
export type UnpricedKind = 'pre-ledger' | 'gap' | 'partial';

/** What an interval turned out to be. Only `{model}` is ever fitted on; the rest are named separately because they mean different things. */
export type IntervalKind = 'idle' | 'external' | 'mixed' | UnpricedKind | { model: string };

/**
 * Is this a kind no rate may ever be fitted on?
 *
 * **Every consumer asks through here rather than naming a kind.** The two sites
 * that used to compare against `'gap'` literally behaved differently under the
 * split — one fails closed, the other fails *open* and would have quietly
 * admitted `pre-ledger` and `partial` intervals into the two-term fit.
 */
export function isUnpriced(kind: IntervalKind): boolean {
  return kind === 'pre-ledger' || kind === 'gap' || kind === 'partial';
}

/** One consecutive pair of history samples, with the tokens spent between them. */
export interface Interval {
  fromT: number;
  toT: number;
  /** Utilization percentage points gained. Never negative — a drop is discarded. */
  dUtil: number;
  tok: Record<string, TokenCounts>;
  /**
   * Requests per model over the same span, pro-rated at the edges exactly like
   * `tok`. Only meaningful when {@link Interval.reqUsable} is true.
   */
  req: Record<string, number>;
  /**
   * Whether every ledger line behind `req` actually recorded a count.
   *
   * One line that did not poisons the whole interval: a partial count fitted as
   * if it were whole understates the per-request term by an unknown amount,
   * which is worse than dropping the interval from the two-term fit. Token
   * totals are unaffected either way.
   */
  reqUsable: boolean;
  kind: IntervalKind;
}

export function totalWeighted(tok: Record<string, TokenCounts>): number {
  let sum = 0;
  for (const [model, counts] of Object.entries(tok)) sum += weightedTokens(counts, model);
  return sum;
}

/**
 * Which model owns this interval, or null when none holds {@link DOMINANCE}.
 *
 * Dominance rather than decomposing mixed intervals: one equation per interval
 * is under-determined exactly when it matters (two models always used together),
 * and a wrong split is indistinguishable from drift.
 */
export function dominantModel(tok: Record<string, TokenCounts>): string | null {
  const total = totalWeighted(tok);
  if (total <= 0) return null;
  for (const [model, counts] of Object.entries(tok)) {
    if (weightedTokens(counts, model) / total >= DOMINANCE) return model;
  }
  return null;
}

/**
 * The ledger's overlap with `[fromT, toT]`: tokens summed, milliseconds covered.
 *
 * Overlap-weighted, not whole-lines-only: the two logs are written on different
 * grids, and against real logs the whole-lines rule classified **759 of 759**
 * intervals as `gap`. Edge ticks are split pro rata — the one approximation
 * here, bounded by two ticks per interval.
 *
 * **Request counts are pro-rated as a float, exactly like tokens.** A count is
 * an integer event stream, so half a tick's requests is not a thing that
 * happened; the alternative — attributing a straddling tick's count whole to
 * one side — would make the two regressors disagree about the same two edge
 * minutes, and it is their *ratio* the two-term fit measures. A fractional
 * count is unbiased under the same uniform-spend assumption the tokens already
 * make, and bounded by the same two ticks per interval.
 */
function gather(ledger: LedgerLine[], fromT: number, toT: number): {
  tok: Record<string, TokenCounts>;
  req: Record<string, number>;
  reqUsable: boolean;
  coveredMs: number;
} {
  const tok: Record<string, TokenCounts> = {};
  const req: Record<string, number> = {};
  let reqUsable = true;
  let coveredMs = 0;
  for (const line of ledger) {
    const span = line.t - line.prevT;
    if (span <= 0) continue;
    const overlapMs = Math.min(toT, line.t) - Math.max(fromT, line.prevT);
    if (overlapMs <= 0) continue;
    coveredMs += overlapMs;
    const share = overlapMs / span;
    for (const [model, counts] of Object.entries(line.tok)) {
      const bucket = tok[model] ?? (tok[model] = emptyCounts());
      addCounts(bucket, share === 1 ? counts : scaleCounts(counts, share));
      // A line with no `req` at all only poisons the interval if it also
      // carries spend: zero tokens is zero requests, since an event with no
      // tokens is never recorded in the first place.
      const n = line.req?.[model];
      if (n === undefined) reqUsable = false;
      else req[model] = (req[model] ?? 0) + n * share;
    }
  }
  return { tok, req, reqUsable, coveredMs };
}

/**
 * Which of the six kinds this interval is, coverage first.
 *
 * Under-covered spans split three ways, in this order: provably before
 * recording began, then nothing recorded at all, then something but not enough.
 * Two boundary choices are deliberate and pinned by tests:
 *
 * - The pre-ledger test is on `toT`, not `fromT`. An interval that *straddles*
 *   the start of recording is not provably unrecorded, so it falls through to
 *   `gap`/`partial` on its actual coverage. That overstates the recorder-down
 *   bucket by at most one interval per install; testing `fromT` instead would
 *   swallow a genuine hole that happens to abut the boundary.
 * - `ledgerStartMs === null` — no ledger, or one that may have rotated —
 *   collapses `pre-ledger` into `gap`. The conservative reading, and the honest
 *   direction to fail in.
 */
function classify(
  dUtil: number,
  tok: Record<string, TokenCounts>,
  coveredMs: number,
  durationMs: number,
  toT: number,
  ledgerStartMs: number | null
): IntervalKind {
  if (coveredMs / durationMs >= LEDGER_COVERAGE_MIN) {
    if (dUtil <= IDLE_EPS) return 'idle';
    if (totalWeighted(tok) < EXTERNAL_WEIGHTED_MAX) return 'external';
    const model = dominantModel(tok);
    return model === null ? 'mixed' : { model };
  }
  if (ledgerStartMs !== null && toT <= ledgerStartMs) return 'pre-ledger';
  if (coveredMs <= 0) return 'gap';
  return 'partial';
}

/**
 * Pair consecutive samples into classified intervals.
 *
 * A pair survives only inside one window and only rising, and is dropped rather
 * than clamped — a clamped interval contributes tokens with no price. An
 * out-of-order pair is discarded, not sorted: upstream is wrong.
 *
 * `ledgerStartMs` is when recording provably began (`ledgerStartMs()` in
 * `usage-ledger.ts`), and it only ever separates `pre-ledger` from `gap`.
 * Optional and null by default so a caller with no answer — a probe, a test —
 * gets the conservative classification rather than a compile error.
 */
export function joinIntervals(
  samples: UsageSample[], ledger: LedgerLine[], ledgerStartMs: number | null = null
): Interval[] {
  const out: Interval[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1];
    const to = samples[i];
    const durationMs = to.t - from.t;
    if (durationMs <= 0) continue;
    if (!sameWindow(from.resetsAt, to.resetsAt)) continue;
    const dUtil = to.utilization - from.utilization;
    if (dUtil < 0) continue;

    const { tok, req, reqUsable, coveredMs } = gather(ledger, from.t, to.t);
    out.push({
      fromT: from.t, toT: to.t, dUtil, tok, req, reqUsable,
      kind: classify(dUtil, tok, coveredMs, durationMs, to.t, ledgerStartMs)
    });
  }
  return out;
}

// ── Rates, baselines and drift ───────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** How far back the baseline reaches. */
export const BASELINE_MS = 17 * DAY_MS;
/** The trailing span compared against that baseline. */
export const CURRENT_MS = 3 * DAY_MS;

/** Wide on purpose: a badge that cries drift at ±5% is ignored within a week. */
export const DRIFT_PCT = 20;

/** Wider still, and never called drift — raw moves whenever the token mix does. */
export const RAW_SHIFT_PCT = 25;

/** What a rate needs before it is worth reporting. */
export interface RateFloors {
  /** Distinct intervals behind the fit. */
  minIntervals: number;
  /** Cumulative utilization percentage points behind it. */
  minUtil: number;
  /**
   * Distinct UTC dates behind it. Required rather than optional: an optional
   * floor defaults to off, and defaulting to off is the defect this exists for.
   */
  minDays: number;
}

/**
 * All three floors, because each alone is fooled: 200 intervals of 0.02% is a
 * rounding-error rate, one interval covering 20% is unrepeated, and 60
 * intervals from one morning are a single day's habit wearing a fortnight's
 * clothes. Current is looser on the first two only because its window is a
 * fifth of the baseline's span.
 *
 * The day floors are 7 and 2 because that is the cheapest pair putting the
 * measured day-to-day dispersion of this machine's own rates (cv ≈ 24%, so a
 * 1σ deviation error of `√(cv²/7 + cv²/2)` ≈ 19.2%) under {@link DRIFT_PCT}.
 * 7 is also half the baseline window's 14-day width, so a verdict now needs a
 * baseline that is at least half-populated.
 */
export const BASELINE_FLOORS: RateFloors = { minIntervals: 30, minUtil: 15, minDays: 7 };
export const CURRENT_FLOORS: RateFloors = { minIntervals: 10, minUtil: 5, minDays: 2 };

/** One fitted rate, with the evidence it rests on. */
export interface ModelRate {
  /** Weighted tokens per percentage point — the drift quantity. */
  weightedPerPct: number;
  /** Raw tokens per percentage point — the courtesy translation. */
  rawPerPct: number;
  intervals: number;
  utilSum: number;
  /** Distinct UTC dates those intervals fall on — the span, not the count. */
  days: number;
}

export type ModelRateVerdictKind = 'drift' | 'stable' | 'mix-shift' | 'thin';

/** One model's row: current rate, baseline, and what the comparison says. */
export interface DriftRow {
  model: string;
  rawPerPct: number | null;
  weightedPerPct: number | null;
  baselineRawPerPct: number | null;
  baselineWeightedPerPct: number | null;
  /** Signed percent change of the weighted rate against baseline. */
  deviationPct: number | null;
  verdict: ModelRateVerdictKind;
  /** Evidence in the **current** window — reported even when it is too thin to fit. */
  intervals: number;
  utilSum: number;
  /** Distinct UTC dates in the current window, on the same terms. */
  days: number;
  /**
   * Distinct UTC dates in the **baseline** window, on the same terms — the one
   * baseline figure reported whatever the verdict, so a card can say the
   * baseline is still forming rather than only that it is absent.
   */
  baselineDays: number;
}

/** `[now−17d, now−3d)` — the settled past a change is measured against. */
export function baselineRange(nowMs: number): { sinceMs: number; untilMs: number } {
  return { sinceMs: nowMs - BASELINE_MS, untilMs: nowMs - CURRENT_MS };
}

/**
 * `[now−3d, ∞)` — open at the top rather than closed at `now`, so an interval
 * stamped a moment ahead of the request clock is not dropped at exactly the
 * edge this window exists to watch.
 */
export function currentRange(nowMs: number): { sinceMs: number; untilMs: number } {
  return { sinceMs: nowMs - CURRENT_MS, untilMs: Number.POSITIVE_INFINITY };
}

/** `YYYY-MM-DD` in UTC — the key a day count is taken on. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Is this interval this model's, and inside `[sinceMs, untilMs)`? */
function ownedBy(interval: Interval, model: string, sinceMs: number, untilMs: number): boolean {
  if (typeof interval.kind !== 'object' || interval.kind.model !== model) return false;
  return interval.toT >= sinceMs && interval.toT < untilMs;
}

/** The pooled ratio and its evidence, floors not applied. */
function pool(intervals: Interval[], model: string, sinceMs: number, untilMs: number): ModelRate | null {
  let weighted = 0, raw = 0, utilSum = 0, count = 0;
  // Distinct UTC dates rather than `max(toT) − min(toT)`: a span is cleared by
  // two clusters at either end of the window with nothing in between, which is
  // the same lie one day tells in a different shape.
  const dates = new Set<string>();
  for (const interval of intervals) {
    if (!ownedBy(interval, model, sinceMs, untilMs)) continue;
    for (const [tokModel, counts] of Object.entries(interval.tok)) {
      weighted += weightedTokens(counts, tokModel);
      raw += counts.in + counts.out + counts.cc + counts.cr;
    }
    utilSum += interval.dUtil;
    dates.add(utcDate(interval.toT));
    count++;
  }
  if (count === 0 || utilSum <= 0) return null;
  return {
    weightedPerPct: weighted / utilSum, rawPerPct: raw / utilSum,
    intervals: count, utilSum, days: dates.size
  };
}

/**
 * One model's rate over a window, or null when the evidence is too thin.
 *
 * Pooled Σtokens / Σutil, not a mean of per-interval ratios: a mean lets a
 * 0.02% interval count as much as an hour of steady work. The floors are what
 * keep the pool robust, and why a median was not needed instead.
 */
export function rateFor(
  intervals: Interval[], model: string, sinceMs: number, untilMs: number, floors: RateFloors
): ModelRate | null {
  const fitted = pool(intervals, model, sinceMs, untilMs);
  if (fitted === null) return null;
  if (fitted.intervals < floors.minIntervals) return null;
  if (fitted.utilSum < floors.minUtil) return null;
  if (fitted.days < floors.minDays) return null;
  return fitted;
}

function deviation(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100;
}

/**
 * Compare a model's trailing rate against its baseline.
 *
 * Verdict order matters — **thin outranks everything**, or the badge would fire
 * hardest exactly when it knows least. That is what the day floors enforce:
 * counting intervals says how much evidence a window holds and nothing about
 * how far apart it is spread, so a floor without one is cleared by a single
 * morning. The evidence counters are reported whatever the verdict — the
 * current window's in full, the baseline's day count beside them — so the card
 * can say "collecting — 4 windows over 2 days" rather than a bare `thin`.
 */
export function driftRow(intervals: Interval[], model: string, nowMs: number): DriftRow {
  const base = baselineRange(nowMs);
  const cur = currentRange(nowMs);

  const baseline = rateFor(intervals, model, base.sinceMs, base.untilMs, BASELINE_FLOORS);
  const current = rateFor(intervals, model, cur.sinceMs, cur.untilMs, CURRENT_FLOORS);
  const evidence = pool(intervals, model, cur.sinceMs, cur.untilMs);
  // The baseline's own evidence has to survive its refusal exactly as the
  // current window's already does, or the card can say it went quiet but not why.
  const baselineEvidence = pool(intervals, model, base.sinceMs, base.untilMs);

  const row: DriftRow = {
    model,
    rawPerPct: current?.rawPerPct ?? null,
    weightedPerPct: current?.weightedPerPct ?? null,
    baselineRawPerPct: baseline?.rawPerPct ?? null,
    baselineWeightedPerPct: baseline?.weightedPerPct ?? null,
    deviationPct: null,
    verdict: 'thin',
    intervals: evidence?.intervals ?? 0,
    utilSum: evidence?.utilSum ?? 0,
    days: evidence?.days ?? 0,
    baselineDays: baselineEvidence?.days ?? 0
  };

  if (current === null || baseline === null) return row;
  if (baseline.weightedPerPct <= 0 || baseline.rawPerPct <= 0) return row;

  const weightedDev = deviation(current.weightedPerPct, baseline.weightedPerPct);
  const rawDev = deviation(current.rawPerPct, baseline.rawPerPct);
  row.deviationPct = weightedDev;
  row.verdict = Math.abs(weightedDev) > DRIFT_PCT ? 'drift'
    : Math.abs(rawDev) > RAW_SHIFT_PCT ? 'mix-shift'
      : 'stable';
  return row;
}

/**
 * Share of the *moved* utilization that this machine cannot account for.
 *
 * `idle` and every unpriced kind are out of the denominator — counting our own
 * downtime as another device's spend would turn a server restart into a claim
 * about the account, and counting the span that predates recording would turn
 * the recorder's own start into one. Null rather than 0 when nothing moved:
 * "no external burn" and "no evidence either way" are different statements.
 */
export function externalShare(intervals: Interval[], sinceMs: number, untilMs: number): number | null {
  let external = 0, moved = 0;
  for (const interval of intervals) {
    if (interval.toT < sinceMs || interval.toT > untilMs) continue;
    if (interval.kind === 'idle' || isUnpriced(interval.kind)) continue;
    moved += interval.dUtil;
    if (interval.kind === 'external') external += interval.dUtil;
  }
  if (moved <= 0) return null;
  return external / moved;
}

/** Utilization points per interval kind over one window. Counters, not fits — a zero is a measured zero. */
export interface CoverageBreakdown {
  /** Every non-`idle` point in the window: the denominator every share below is read against. */
  moved: number;
  /** Points in `{model}`-owned intervals — the only ones that reach a rate. */
  priced: number;
  mixed: number;
  external: number;
  preLedger: number;
  /** Recorder down: recording had begun and covered none of the span. */
  gap: number;
  partial: number;
}

/**
 * Utilization points per bucket over `[sinceMs, untilMs)`, so the card can say
 * *which* refusal cost what.
 *
 * `idle` is in no bucket and out of `moved`, for the same reason
 * {@link externalShare} excludes it: it is a measurement of nothing moving, and
 * putting it in the denominator would shrink every share by however long the
 * machine sat quiet. Every other bucket sums to `moved` exactly, which is what
 * lets a reader check the split themselves.
 *
 * Windowed on `toT` and half-open, matching the fit's own windows.
 */
export function coverageBreakdown(
  intervals: Interval[], sinceMs: number, untilMs: number
): CoverageBreakdown {
  const out: CoverageBreakdown = {
    moved: 0, priced: 0, mixed: 0, external: 0, preLedger: 0, gap: 0, partial: 0
  };
  for (const interval of intervals) {
    if (interval.toT < sinceMs || interval.toT >= untilMs) continue;
    if (interval.kind === 'idle') continue;
    out.moved += interval.dUtil;
    if (typeof interval.kind === 'object') out.priced += interval.dUtil;
    else if (interval.kind === 'mixed') out.mixed += interval.dUtil;
    else if (interval.kind === 'external') out.external += interval.dUtil;
    else if (interval.kind === 'pre-ledger') out.preLedger += interval.dUtil;
    else if (interval.kind === 'gap') out.gap += interval.dUtil;
    else out.partial += interval.dUtil;
  }
  return out;
}

/**
 * Milliseconds inside `[sinceMs, untilMs)` that fall between two ledger lines
 * which do not abut — how long the recorder was not running.
 *
 * A property of the ledger rather than of the join, which is the point: the
 * server that writes the ledger also writes the history log, so most of these
 * breaks overlap no interval at all and the point buckets cannot see them. The
 * two measures answer different questions — these hours say how much of the
 * *time* went unrecorded, {@link coverageBreakdown} says how much of the
 * *spend* that cost. A break straddling an edge is clamped to the window, and
 * out-of-order or overlapping lines contribute nothing rather than negative
 * time.
 */
export function ledgerBreakMs(ledger: LedgerLine[], sinceMs: number, untilMs: number): number {
  let total = 0;
  for (let i = 1; i < ledger.length; i++) {
    const from = Math.max(ledger[i - 1].t, sinceMs);
    const to = Math.min(ledger[i].prevT, untilMs);
    if (to > from) total += to - from;
  }
  return total;
}

// ── The two-term fit: tokens and requests, separated ─────────────────────────

/**
 * What a two-parameter fit needs per model, against the one-parameter
 * {@link CURRENT_FLOORS} it sits beside.
 *
 * Twice the evidence for twice the parameters, and nothing cleverer: the split
 * is only worth reporting when it is not a line drawn through a handful of
 * points, and a floor is the same instrument the pooled ratio already trusts.
 *
 * `minDays: 1` is a no-op today and deliberately so — the split publishes no
 * cross-window verdict, so a one-day span is not what misfires. It is wired
 * anyway, because a required field nobody reads is a decoration that does
 * nothing the day a later reader raises it.
 */
export const SPLIT_FLOORS: RateFloors = { minIntervals: 20, minUtil: 10, minDays: 1 };

/**
 * Above this the two regressors are one regressor.
 *
 * Uncentered r² between a model's weighted tokens and its request count —
 * uncentered because the fit has no intercept, where collinearity means
 * literally "one column is a multiple of the other". 0.99 is a variance
 * inflation of 100: past it the split is decided by a couple of intervals that
 * happen to break the proportionality, which is a coin toss dressed as a
 * measurement.
 */
export const SPLIT_MAX_R2 = 0.99;

/**
 * How much of a unit-length column has to be *new* for it to stay in the fit.
 *
 * Every column is normalized before the QR pass, so this is a share: a column
 * whose residual against the columns already accepted is under a thousandth of
 * its own length carries no information the fit does not already have, and
 * keeping it makes the solve arbitrary rather than merely noisy.
 */
export const SPLIT_RANK_TOL = 1e-3;

/**
 * How much of a column has to survive projecting out **every other** column
 * before its coefficient is worth publishing.
 *
 * The gap this closes: {@link SPLIT_MAX_R2} compares a model's own two columns
 * and says nothing about model A's tokens against model B's, while
 * {@link SPLIT_RANK_TOL} is a *numerical* floor the solve needs — a residual of
 * 1e-3 is r² ≈ 0.999999, so it only ever fires on columns that are collinear to
 * six decimal places. Between the two lies a wide band where the solve is
 * severely ill-conditioned, no gate fires, and every model is published
 * `fitted`. Measured at r²(A_tok, B_tok) = 0.999957, two models generated from
 * 0.500 and 1.200 pt/Mtok came back 0.763 and 0.667 — a cross-model ratio of
 * 0.87x where the truth is 0.42x, **inverted**, with nothing refused.
 *
 * That is the exact failure this whole feature exists to avoid, and "two models
 * always used together" is the case `DOMINANCE` protects the pooled rate from —
 * the two-term fit drops `DOMINANCE` deliberately, so it owes a guard of its
 * own. 0.1 is a variance inflation of 100, the same the r² ceiling encodes, and
 * the check is **symmetric**: measured against all the other columns rather
 * than only the ones offered earlier, because otherwise the first of a
 * collinear pair is published while only the second is caught — and if the
 * second is dropped from the solve instead, the first silently absorbs its
 * utilization.
 */
export const SPLIT_MIN_INDEPENDENT_SHARE = 0.1;

/** Millions of weighted tokens — the token column's unit, so both columns are O(1). */
const MTOK = 1_000_000;

/** One model's separated cost, in the units the fit is actually in. */
export interface SplitFit {
  /** Utilization points per 1M weighted tokens. Never negative. */
  pctPerMWeighted: number;
  /** Utilization points per request. Never negative. */
  pctPerRequest: number;
  /** Intervals in which this model spent anything — the evidence, not a published rate. */
  intervals: number;
  /** Cumulative utilization points across those intervals. */
  utilSum: number;
}

/** Why one model got no split, in the words the probe and the docs use. */
export type SplitRefusal =
  /** Its requests and its tokens move together past {@link SPLIT_MAX_R2}. */
  | 'collinear'
  /** Under {@link SPLIT_FLOORS} — not enough intervals, or not enough movement. */
  | 'thin-evidence'
  /**
   * Its columns are in — or too near — the span of the others: this data cannot
   * single it out. Covers both an exactly dependent column and one whose
   * independent share is under {@link SPLIT_MIN_INDEPENDENT_SHARE}.
   */
  | 'unidentified'
  /** Least squares wanted a negative per-token or per-request cost. */
  | 'negative';

/** One model's line of the fit's reasoning, reported whatever the outcome. */
export interface SplitDiagnostic {
  model: string;
  /** Uncentered r² between this model's two regressors, over the fitted rows. */
  r2: number;
  /** Fitted rows in which this model spent anything. */
  intervals: number;
  /** Cumulative utilization points over those rows. */
  utilSum: number;
  /** Distinct UTC dates those rows fall on — checked against {@link SPLIT_FLOORS}. */
  days: number;
  /**
   * The least independent of this model's columns, as a share of its own
   * length, after projecting out every other column in the design — 1 is
   * orthogonal to everything, 0 is a combination of the others. Compare against
   * {@link SPLIT_MIN_INDEPENDENT_SHARE}; the square of it is 1 − r² against
   * their span, so 0.1 is a variance inflation of 100.
   */
  independentShare: number;
  /** Null exactly when `fit` is set. */
  refusal: SplitRefusal | null;
  fit: SplitFit | null;
  /**
   * What least squares actually returned for this model, sign and all, before
   * the floors and the sign refusal were applied — null when its columns were
   * never in the solve.
   *
   * **Diagnostic only.** Nothing surfaces this: a negative cost is not a
   * measurement, and `scripts/probe-usage-split.ts` needs to say *which* of
   * the two terms came back impossible, because that is the difference between
   * "the model is missing a term" and "this data cannot see the term".
   */
  raw: { pctPerMWeighted: number; pctPerRequest: number } | null;
}

/**
 * Which intervals the two-term fit reads, and it is **not** the pooled ratio's set.
 *
 * - `pre-ledger`, `gap` and `partial` are out: the recorder missed minutes — or
 *   had not started — so the tokens are not all there. All three go through
 *   {@link isUnpriced}, because this predicate *admits* whatever it does not
 *   name: a kind added beside `gap` would have walked straight into the fit.
 * - `external` is out: utilization moved on almost no local spend, which is
 *   another device on the account. Fitting it would price our models for
 *   someone else's turns.
 * - `idle` is **in**, and that is the load-bearing one. Utilization is read
 *   coarsely, so spend often lands in one interval and its visible rise in the
 *   next; keeping only the intervals where utilization moved is selection on
 *   the dependent variable, and it inflates every coefficient. The zeros are
 *   measurements — `docs/subsystems/usage-limits.md` already says so — and
 *   including them is what makes the sum over intervals add back up.
 * - `mixed` is **in**, unlike the pooled ratio, which needs one model to own
 *   the interval. Fitting all models' coefficients jointly needs no ownership:
 *   one equation per interval, two unknowns per model, and many intervals.
 *   Those are the intervals where two models were used together, which is
 *   exactly where the information about telling them apart lives.
 *
 * An interval whose counts are not all recorded is out regardless of kind.
 */
function usableForSplit(interval: Interval): boolean {
  if (!interval.reqUsable) return false;
  return !isUnpriced(interval.kind) && interval.kind !== 'external';
}

/**
 * `v` with the orthonormal `basis` projected out: the residual, its length, and
 * how much of `v` each basis vector accounted for.
 *
 * Twice through, because one pass loses orthogonality exactly where these
 * tolerances have to mean something.
 */
function project(v: number[], basis: number[][]): { vector: number[]; norm: number; proj: number[] } {
  const vector = v.slice();
  const proj = new Array<number>(basis.length).fill(0);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < basis.length; k++) {
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += basis[k][i] * vector[i];
      proj[k] += dot;
      for (let i = 0; i < vector.length; i++) vector[i] -= dot * basis[k][i];
    }
  }
  let norm = 0;
  for (const x of vector) norm += x * x;
  return { vector, norm: Math.sqrt(norm), proj };
}

/**
 * For each unit-normed column, the share of it that survives projecting out
 * **all** the others — 1 for a column orthogonal to every other, 0 for one
 * that is a combination of them, and `sqrt(1 - r²)` against their span between.
 *
 * Every column is in the basis for every other, including columns the solve
 * itself dropped: a column that was dropped is precisely the one whose
 * utilization the surviving columns silently absorb, so its presence is what
 * makes their coefficients arbitrary.
 */
function independentShares(cols: number[][]): number[] {
  return cols.map((col, j) => {
    const basis: number[][] = [];
    for (let k = 0; k < cols.length; k++) {
      if (k === j) continue;
      const { vector, norm } = project(cols[k], basis);
      if (!Number.isFinite(norm) || norm <= SPLIT_RANK_TOL) continue;
      basis.push(vector.map((x) => x / norm));
    }
    const { norm } = project(col, basis);
    return Number.isFinite(norm) ? norm : 0;
  });
}

/**
 * Least squares by modified Gram-Schmidt, dropping every column that the
 * columns before it already explain.
 *
 * A rank-revealing pass rather than normal equations, because on real logs the
 * design is *routinely* rank-deficient and it is not a pathology: a model used
 * in a single interval contributes two columns spanning one dimension, and one
 * such model made the whole joint solve singular — every model reported no
 * split, measured live before this was written. Dropping only the offending
 * column keeps every other model's answer.
 *
 * Columns arrive unit-normed, so {@link SPLIT_RANK_TOL} is a share of a
 * column's own length. Returns the coefficient per column, with `null` for
 * each column that was dropped.
 */
function leastSquares(cols: number[][], y: number[], tol: number): (number | null)[] {
  const q: number[][] = [];
  /** For each accepted column: its projections onto the earlier ones, then its residual norm. */
  const r: number[][] = [];
  const accepted: number[] = [];
  const coef: (number | null)[] = cols.map(() => null);

  for (let c = 0; c < cols.length; c++) {
    const { vector, norm, proj } = project(cols[c], q);
    if (!Number.isFinite(norm) || norm <= tol) continue;
    q.push(vector.map((x) => x / norm));
    r.push([...proj, norm]);
    accepted.push(c);
  }

  const m = accepted.length;
  if (m === 0) return coef;
  const qty = q.map((col) => {
    let acc = 0;
    for (let i = 0; i < y.length; i++) acc += col[i] * y[i];
    return acc;
  });
  // R is upper triangular with R[i][j] = r[j][i]; back-substitute.
  const z = new Array<number>(m).fill(0);
  for (let j = m - 1; j >= 0; j--) {
    let acc = qty[j];
    for (let k = j + 1; k < m; k++) acc -= r[k][j] * z[k];
    z[j] = acc / r[j][j];
  }
  if (!z.every(Number.isFinite)) return coef;
  accepted.forEach((c, j) => { coef[c] = z[j]; });
  return coef;
}

/**
 * Fit utilization against **two** regressors per model — weighted tokens and
 * request count — over `[sinceMs, untilMs)`, jointly across every usable
 * interval, and report the reasoning for each model either way.
 *
 * Why two terms at all: the pooled ratio is only a price if the window is
 * charged purely per token. It is not, and anything charged per request lands
 * in the utilization denominator with no tokens beside it, so a single ratio
 * hands all of it to the token term. Measured on live logs the opus:fable
 * per-token ratio came out at ~4.2-4.4x from two estimators with different
 * selection, where the API list price is 2.00x (checked 2026-09-02) — the
 * residual is the term this fits. The limit's own per-model weighting is
 * unpublished, so 2.00x is a reference point, not a target.
 *
 * The order the columns are offered in is load-bearing. Every model's **token**
 * column goes first, then every model's request column, so when the rank pass
 * has to drop something it drops a request column: a model whose split cannot
 * be identified still keeps a column with which to explain its own
 * utilization, instead of having that utilization pushed onto whichever models
 * remain. A model whose request column is collinear past
 * {@link SPLIT_MAX_R2} is not offered one at all, for the same reason.
 *
 * Being in the solve is not enough to be *published*. A model whose least
 * independent column survives less than {@link SPLIT_MIN_INDEPENDENT_SHARE} of
 * itself once every other column is projected out is refused as
 * `unidentified` — including when the rank pass dropped a *different* model's
 * column, since whoever remains has quietly absorbed its utilization. The rank
 * tolerance is a numerical floor for the solve; this is the honesty floor for
 * the answer, and it is the only one that looks across models.
 *
 * A negative coefficient is a **refusal, not a clamp**: both costs are
 * physically non-negative, so a negative one means this data cannot separate
 * the terms — and publishing the clamped 0 instead would state "requests are
 * free" as a measurement nobody made. Refusing keeps the null meaning "not
 * enough evidence to say", which is what every null in this file means.
 * Models are refused one at a time and the fit is never re-run on a set chosen
 * by its own output.
 */
export function explainSplits(intervals: Interval[], sinceMs: number, untilMs: number): SplitDiagnostic[] {
  const rows = intervals.filter(
    (interval) => interval.toT >= sinceMs && interval.toT < untilMs && usableForSplit(interval)
  );
  const models = [...new Set(rows.flatMap((interval) => Object.keys(interval.tok)))].sort();
  if (models.length === 0 || rows.length === 0) return [];

  const weighted = models.map((model) => rows.map((interval) => {
    const counts = interval.tok[model];
    return counts === undefined ? 0 : weightedTokens(counts, model) / MTOK;
  }));
  const requests = models.map((model) => rows.map((interval) => interval.req[model] ?? 0));
  const y = rows.map((interval) => interval.dUtil);

  const diagnostics: SplitDiagnostic[] = models.map((model, m) => {
    let sww = 0, srr = 0, swr = 0, intervalCount = 0, utilSum = 0;
    const dates = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const w = weighted[m][i], q = requests[m][i];
      sww += w * w; srr += q * q; swr += w * q;
      if (w > 0) { intervalCount++; utilSum += y[i]; dates.add(utcDate(rows[i].toT)); }
    }
    // A dead column is not separable from anything, and reads as r² = 1.
    const r2 = sww <= 0 || srr <= 0 ? 1 : (swr * swr) / (sww * srr);
    return {
      model, r2, intervals: intervalCount, utilSum, days: dates.size,
      independentShare: 0, refusal: null, fit: null, raw: null
    };
  });

  // Token columns first, then the request columns of the models still eligible
  // for one, each normalized so the rank tolerance is a share.
  const cols: number[][] = [];
  const owner: { model: number; term: 'tok' | 'req' }[] = [];
  const norms: number[] = [];
  const offer = (values: number[], model: number, term: 'tok' | 'req'): void => {
    let norm = 0;
    for (const x of values) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm <= 0) return; // nothing observed — the rank pass would drop it anyway
    cols.push(values.map((x) => x / norm));
    owner.push({ model, term });
    norms.push(norm);
  };
  models.forEach((_, m) => offer(weighted[m], m, 'tok'));
  const collinear = models.map((_, m) => diagnostics[m].r2 > SPLIT_MAX_R2);
  models.forEach((_, m) => { if (!collinear[m]) offer(requests[m], m, 'req'); });

  const scaled = leastSquares(cols, y, SPLIT_RANK_TOL);
  const coef = new Map<string, number>();
  scaled.forEach((value, c) => {
    if (value === null) return;
    coef.set(`${owner[c].model}:${owner[c].term}`, value / norms[c]);
  });

  // How well conditioned each model's own columns are against everything else
  // in the design — the guard neither the r² ceiling nor the rank tolerance
  // covers. A model with no column at all keeps its 0 and is refused below.
  const shares = independentShares(cols);
  shares.forEach((share, c) => {
    const diagnostic = diagnostics[owner[c].model];
    diagnostic.independentShare = diagnostic.independentShare === 0
      ? share
      : Math.min(diagnostic.independentShare, share);
  });

  // Refusals are reported most-informative first, which is not the order they
  // are computed in: a model seen once is collinear *because* it was seen once,
  // and "not enough evidence" is the reason worth reading.
  for (let m = 0; m < models.length; m++) {
    const diagnostic = diagnostics[m];
    const perMTok = coef.get(`${m}:tok`);
    const perRequest = coef.get(`${m}:req`);
    if (perMTok !== undefined && perRequest !== undefined) {
      diagnostic.raw = { pctPerMWeighted: perMTok, pctPerRequest: perRequest };
    }
    if (
      diagnostic.intervals < SPLIT_FLOORS.minIntervals
      || diagnostic.utilSum < SPLIT_FLOORS.minUtil
      || diagnostic.days < SPLIT_FLOORS.minDays
    ) {
      diagnostic.refusal = 'thin-evidence';
      continue;
    }
    if (collinear[m]) {
      diagnostic.refusal = 'collinear';
      continue;
    }
    if (
      perMTok === undefined || perRequest === undefined
      || diagnostic.independentShare < SPLIT_MIN_INDEPENDENT_SHARE
    ) {
      diagnostic.refusal = 'unidentified';
      continue;
    }
    if (!Number.isFinite(perMTok) || !Number.isFinite(perRequest) || perMTok < 0 || perRequest < 0) {
      diagnostic.refusal = 'negative';
      continue;
    }
    diagnostic.fit = {
      pctPerMWeighted: perMTok,
      pctPerRequest: perRequest,
      intervals: diagnostic.intervals,
      utilSum: diagnostic.utilSum
    };
  }
  return diagnostics;
}

/** Just the models whose split is worth reporting — see {@link explainSplits}. */
export function fitSplits(intervals: Interval[], sinceMs: number, untilMs: number): Map<string, SplitFit> {
  const out = new Map<string, SplitFit>();
  for (const diagnostic of explainSplits(intervals, sinceMs, untilMs)) {
    if (diagnostic.fit !== null) out.set(diagnostic.model, diagnostic.fit);
  }
  return out;
}

/** One model's rate from the one-term joint fit, in both the units the card speaks. */
export interface RateFit {
  /**
   * Weighted tokens per percentage point — the same unit as
   * {@link ModelRate.weightedPerPct}, so the two estimators sit on one row and
   * compare directly. Always finite and positive: the reciprocal below is
   * refused before it can be published as `Infinity`.
   */
  weightedPerPct: number;
  /** Utilization points per 1M weighted tokens — the coefficient as fitted. Never negative. */
  pctPerMWeighted: number;
  /** Intervals in which this model spent anything — the evidence, not a published rate. */
  intervals: number;
  /** Cumulative utilization points across those intervals. */
  utilSum: number;
}

/** Why one model got no fitted rate, in the words the probe and the docs use. */
export type RateRefusal =
  /** Under {@link CURRENT_FLOORS} — not enough intervals, movement, or days. */
  | 'thin-evidence'
  /**
   * Its column is in — or too near — the span of the other models': this data
   * cannot tell it apart from whatever it always runs beside. Covers both an
   * exactly dependent column and one whose independent share is under
   * {@link SPLIT_MIN_INDEPENDENT_SHARE}.
   */
  | 'unidentified'
  /** Least squares wanted a non-positive cost per token. */
  | 'negative';

/** One model's line of the one-term fit's reasoning, reported whatever the outcome. */
export interface RateDiagnostic {
  model: string;
  /** Fitted rows in which this model spent anything. */
  intervals: number;
  /** Cumulative utilization points over those rows. */
  utilSum: number;
  /** Distinct UTC dates those rows fall on — checked against {@link CURRENT_FLOORS}. */
  days: number;
  /**
   * How much of this model's unit-length column survives projecting out every
   * other model's — 1 is orthogonal to all of them, 0 is a combination of
   * them. Compare against {@link SPLIT_MIN_INDEPENDENT_SHARE}.
   */
  independentShare: number;
  /** Null exactly when `fit` is set. */
  refusal: RateRefusal | null;
  fit: RateFit | null;
  /**
   * What least squares actually returned for this model in `pt/Mtok`, sign and
   * all, before the floors and the sign refusal — null when its column was
   * never in the solve.
   *
   * **Diagnostic only.** A negative cost is not a measurement; the probe
   * prints it because "the fit came back impossible" and "the fit never ran"
   * are different findings.
   */
  raw: number | null;
}

/**
 * Which intervals the one-term joint fit reads — the same set as the two-term
 * fit **minus its request-count condition**.
 *
 * `{model}`, `mixed` and `idle` are in; `external` and everything
 * {@link isUnpriced} names are out, for the reasons {@link usableForSplit}
 * gives — and through `isUnpriced` for the same reason, so a kind added later
 * beside `gap` cannot walk into the fit.
 *
 * **It deliberately does not test `reqUsable`.** That flag is a two-term-only
 * requirement: a missing request count says nothing about the token totals,
 * and `usableForSplit` gates on it only because its second regressor *is* the
 * request column. This fit has one regressor and it is tokens. Copying
 * `usableForSplit` wholesale would have thrown away the ~40% of live ledger
 * lines written before the recorder produced counts, for nothing.
 */
function usableForRate(interval: Interval): boolean {
  return !isUnpriced(interval.kind) && interval.kind !== 'external';
}

/**
 * Fit utilization against **one** regressor per model — its weighted tokens —
 * over `[sinceMs, untilMs)`, jointly across every usable interval, and report
 * the reasoning for each model either way.
 *
 * Why this beside the pooled ratio: the pooled rate needs one model to hold
 * {@link DOMINANCE} of an interval, so every window where two models ran
 * together is discarded — and a model used only as a subagent beside a driver
 * model owns nothing at all and gets no rate whatsoever. Fitting all models
 * jointly needs no ownership: one equation per interval, one unknown per
 * model, and many intervals. Measured on this machine's logs over 17 days
 * (2026-09-05) the mixed intervals are only 6.9% of the moved points but carry
 * most of the information about telling models apart — the two estimators
 * disagreed by +58% to +141% on the models that cleared these gates.
 *
 * The gates are the two-term fit's, minus the one that has nothing to say
 * here. {@link SPLIT_RANK_TOL} is the numerical floor the solve needs and
 * {@link SPLIT_MIN_INDEPENDENT_SHARE} is the honesty floor for the answer —
 * the guard that matters most, because cross-model collinearity is the entire
 * risk when every column belongs to a different model.
 * {@link SPLIT_MAX_R2} is **deliberately not applied**: it compares a model's
 * own two regressors against each other, and this fit gives a model one.
 *
 * The floors are {@link CURRENT_FLOORS}, not {@link SPLIT_FLOORS}.
 * `SPLIT_FLOORS` is doubled because the split fits two parameters per model;
 * this fits one — the same count the pooled ratio fits — so it earns the same
 * floor rather than the doubled one. That is a decision, not an oversight.
 *
 * A non-positive coefficient is a **refusal, not a clamp**, for the reason
 * {@link explainSplits} gives, and with one more edge of its own: the rate the
 * card publishes is `1M / coefficient`, so a clamped zero would not read as
 * "these tokens are free" but as an infinite price.
 */
export function explainRates(intervals: Interval[], sinceMs: number, untilMs: number): RateDiagnostic[] {
  const rows = intervals.filter(
    (interval) => interval.toT >= sinceMs && interval.toT < untilMs && usableForRate(interval)
  );
  const models = [...new Set(rows.flatMap((interval) => Object.keys(interval.tok)))].sort();
  if (models.length === 0 || rows.length === 0) return [];

  const weighted = models.map((model) => rows.map((interval) => {
    const counts = interval.tok[model];
    return counts === undefined ? 0 : weightedTokens(counts, model) / MTOK;
  }));
  const y = rows.map((interval) => interval.dUtil);

  const diagnostics: RateDiagnostic[] = models.map((model, m) => {
    let intervalCount = 0, utilSum = 0;
    const dates = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      if (weighted[m][i] <= 0) continue;
      intervalCount++;
      utilSum += y[i];
      dates.add(utcDate(rows[i].toT));
    }
    return {
      model, intervals: intervalCount, utilSum, days: dates.size,
      independentShare: 0, refusal: null, fit: null, raw: null
    };
  });

  // One column per model, each normalized so the rank tolerance stays a share
  // of the column's own length rather than an absolute token count.
  const cols: number[][] = [];
  const owner: number[] = [];
  const norms: number[] = [];
  models.forEach((_, m) => {
    let norm = 0;
    for (const x of weighted[m]) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm <= 0) return; // nothing observed — the rank pass would drop it anyway
    cols.push(weighted[m].map((x) => x / norm));
    owner.push(m);
    norms.push(norm);
  });

  const scaled = leastSquares(cols, y, SPLIT_RANK_TOL);
  const coef = new Map<number, number>();
  scaled.forEach((value, c) => { if (value !== null) coef.set(owner[c], value / norms[c]); });

  // Every column is in the basis for every other, including ones the solve
  // dropped: a dropped column is precisely the one whose utilization the
  // survivors silently absorb.
  independentShares(cols).forEach((share, c) => { diagnostics[owner[c]].independentShare = share; });

  // Most-informative refusal first, which is not the order they are computed
  // in: a model seen twice is unidentifiable *because* it was seen twice, and
  // "not enough evidence" is the reason worth reading.
  for (let m = 0; m < models.length; m++) {
    const diagnostic = diagnostics[m];
    const perMTok = coef.get(m);
    if (perMTok !== undefined) diagnostic.raw = perMTok;
    if (
      diagnostic.intervals < CURRENT_FLOORS.minIntervals
      || diagnostic.utilSum < CURRENT_FLOORS.minUtil
      || diagnostic.days < CURRENT_FLOORS.minDays
    ) {
      diagnostic.refusal = 'thin-evidence';
      continue;
    }
    if (perMTok === undefined || diagnostic.independentShare < SPLIT_MIN_INDEPENDENT_SHARE) {
      diagnostic.refusal = 'unidentified';
      continue;
    }
    // `<= 0` rather than `< 0`: zero is where the reciprocal below becomes
    // `Infinity`, and an infinite price is not a measurement either.
    if (!Number.isFinite(perMTok) || perMTok <= 0) {
      diagnostic.refusal = 'negative';
      continue;
    }
    diagnostic.fit = {
      weightedPerPct: MTOK / perMTok,
      pctPerMWeighted: perMTok,
      intervals: diagnostic.intervals,
      utilSum: diagnostic.utilSum
    };
  }
  return diagnostics;
}

/** Just the models whose fitted rate is worth reporting — see {@link explainRates}. */
export function fitRates(intervals: Interval[], sinceMs: number, untilMs: number): Map<string, RateFit> {
  const out = new Map<string, RateFit>();
  for (const diagnostic of explainRates(intervals, sinceMs, untilMs)) {
    if (diagnostic.fit !== null) out.set(diagnostic.model, diagnostic.fit);
  }
  return out;
}

/**
 * Signed percent of the fitted rate against the pooled one — how far the two
 * estimators disagree, which is the disclosure and never a verdict.
 *
 * Null when either rate is missing, and null rather than `Infinity` when the
 * pooled rate is not positive: a percentage against zero is not a comparison.
 */
export function fitDeviation(fitted: number | null, pooled: number | null): number | null {
  if (fitted === null || pooled === null) return null;
  if (!Number.isFinite(fitted) || !Number.isFinite(pooled) || pooled <= 0) return null;
  return deviation(fitted, pooled);
}
