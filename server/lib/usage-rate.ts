/**
 * usage-rate.ts — what one percent of the 5-hour window is worth, per model.
 *
 * Joins `.usage-history.jsonl` (percent) with `.usage-ledger.jsonl` (tokens)
 * into intervals, discards every interval it cannot attribute, and fits a rate
 * per model over what survives. Pure — no clock, no disk, everything injected.
 *
 * The discipline is refusal: which intervals are thrown away and why is the
 * classification table in `docs/subsystems/usage-limits.md`.
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

/** Below this the recorder missed minutes we would otherwise price — the interval is `gap`. */
export const LEDGER_COVERAGE_MIN = 0.8;

/** What an interval turned out to be. Only `{model}` is ever fitted on; the rest are named separately because they mean different things. */
export type IntervalKind = 'idle' | 'external' | 'mixed' | 'gap' | { model: string };

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
  for (const counts of Object.values(tok)) sum += weightedTokens(counts);
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
    if (weightedTokens(counts) / total >= DOMINANCE) return model;
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

function classify(dUtil: number, tok: Record<string, TokenCounts>, covered: boolean): IntervalKind {
  if (!covered) return 'gap';
  if (dUtil <= IDLE_EPS) return 'idle';
  if (totalWeighted(tok) < EXTERNAL_WEIGHTED_MAX) return 'external';
  const model = dominantModel(tok);
  return model === null ? 'mixed' : { model };
}

/**
 * Pair consecutive samples into classified intervals.
 *
 * A pair survives only inside one window and only rising, and is dropped rather
 * than clamped — a clamped interval contributes tokens with no price. An
 * out-of-order pair is discarded, not sorted: upstream is wrong.
 */
export function joinIntervals(samples: UsageSample[], ledger: LedgerLine[]): Interval[] {
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
    const covered = coveredMs / durationMs >= LEDGER_COVERAGE_MIN;
    out.push({ fromT: from.t, toT: to.t, dUtil, tok, req, reqUsable, kind: classify(dUtil, tok, covered) });
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
}

/**
 * Both floors, because either alone is fooled: 200 intervals of 0.02% is a
 * rounding-error rate, one interval covering 20% is unrepeated. Current is
 * looser only because its window is a fifth of the baseline's span.
 */
export const BASELINE_FLOORS: RateFloors = { minIntervals: 30, minUtil: 15 };
export const CURRENT_FLOORS: RateFloors = { minIntervals: 10, minUtil: 5 };

/** One fitted rate, with the evidence it rests on. */
export interface ModelRate {
  /** Weighted tokens per percentage point — the drift quantity. */
  weightedPerPct: number;
  /** Raw tokens per percentage point — the courtesy translation. */
  rawPerPct: number;
  intervals: number;
  utilSum: number;
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

/** Is this interval this model's, and inside `[sinceMs, untilMs)`? */
function ownedBy(interval: Interval, model: string, sinceMs: number, untilMs: number): boolean {
  if (typeof interval.kind !== 'object' || interval.kind.model !== model) return false;
  return interval.toT >= sinceMs && interval.toT < untilMs;
}

/** The pooled ratio and its evidence, floors not applied. */
function pool(intervals: Interval[], model: string, sinceMs: number, untilMs: number): ModelRate | null {
  let weighted = 0, raw = 0, utilSum = 0, count = 0;
  for (const interval of intervals) {
    if (!ownedBy(interval, model, sinceMs, untilMs)) continue;
    for (const counts of Object.values(interval.tok)) {
      weighted += weightedTokens(counts);
      raw += counts.in + counts.out + counts.cc + counts.cr;
    }
    utilSum += interval.dUtil;
    count++;
  }
  if (count === 0 || utilSum <= 0) return null;
  return { weightedPerPct: weighted / utilSum, rawPerPct: raw / utilSum, intervals: count, utilSum };
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
  return fitted;
}

function deviation(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100;
}

/**
 * Compare a model's trailing rate against its baseline.
 *
 * Verdict order matters — **thin outranks everything**, or the badge would fire
 * hardest exactly when it knows least. The evidence counters describe the
 * *current* window and are reported whatever the verdict, so the card can say
 * "collecting — 4 windows, 1.2 points" rather than a bare `thin`.
 */
export function driftRow(intervals: Interval[], model: string, nowMs: number): DriftRow {
  const base = baselineRange(nowMs);
  const cur = currentRange(nowMs);

  const baseline = rateFor(intervals, model, base.sinceMs, base.untilMs, BASELINE_FLOORS);
  const current = rateFor(intervals, model, cur.sinceMs, cur.untilMs, CURRENT_FLOORS);
  const evidence = pool(intervals, model, cur.sinceMs, cur.untilMs);

  const row: DriftRow = {
    model,
    rawPerPct: current?.rawPerPct ?? null,
    weightedPerPct: current?.weightedPerPct ?? null,
    baselineRawPerPct: baseline?.rawPerPct ?? null,
    baselineWeightedPerPct: baseline?.weightedPerPct ?? null,
    deviationPct: null,
    verdict: 'thin',
    intervals: evidence?.intervals ?? 0,
    utilSum: evidence?.utilSum ?? 0
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
 * `idle` and `gap` are out of the denominator — counting our own downtime as
 * another device's spend would turn a server restart into a claim about the
 * account. Null rather than 0 when nothing moved: "no external burn" and "no
 * evidence either way" are different statements.
 */
export function externalShare(intervals: Interval[], sinceMs: number, untilMs: number): number | null {
  let external = 0, moved = 0;
  for (const interval of intervals) {
    if (interval.toT < sinceMs || interval.toT > untilMs) continue;
    if (interval.kind === 'idle' || interval.kind === 'gap') continue;
    moved += interval.dUtil;
    if (interval.kind === 'external') external += interval.dUtil;
  }
  if (moved <= 0) return null;
  return external / moved;
}

// ── The two-term fit: tokens and requests, separated ─────────────────────────

/**
 * What a two-parameter fit needs per model, against the one-parameter
 * {@link CURRENT_FLOORS} it sits beside.
 *
 * Twice the evidence for twice the parameters, and nothing cleverer: the split
 * is only worth reporting when it is not a line drawn through a handful of
 * points, and a floor is the same instrument the pooled ratio already trusts.
 */
export const SPLIT_FLOORS: RateFloors = { minIntervals: 20, minUtil: 10 };

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
  /** Its columns are in the span of the others: this data cannot single it out. */
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
 * - `gap` is out: the recorder missed minutes, so the tokens are not all there.
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
  return interval.kind !== 'gap' && interval.kind !== 'external';
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
    const v = cols[c].slice();
    const proj = new Array<number>(q.length).fill(0);
    // Twice, because one pass loses orthogonality exactly where this tolerance
    // has to mean something.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < q.length; k++) {
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += q[k][i] * v[i];
        proj[k] += dot;
        for (let i = 0; i < v.length; i++) v[i] -= dot * q[k][i];
      }
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= tol) continue;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    q.push(v);
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
 * per-token ratio came out at ~4.2-4.4x against a ~2x list price, from two
 * estimators with different selection — the residual is the term this fits.
 *
 * The order the columns are offered in is load-bearing. Every model's **token**
 * column goes first, then every model's request column, so when the rank pass
 * has to drop something it drops a request column: a model whose split cannot
 * be identified still keeps a column with which to explain its own
 * utilization, instead of having that utilization pushed onto whichever models
 * remain. A model whose request column is collinear past
 * {@link SPLIT_MAX_R2} is not offered one at all, for the same reason.
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
    return counts === undefined ? 0 : weightedTokens(counts) / MTOK;
  }));
  const requests = models.map((model) => rows.map((interval) => interval.req[model] ?? 0));
  const y = rows.map((interval) => interval.dUtil);

  const diagnostics: SplitDiagnostic[] = models.map((model, m) => {
    let sww = 0, srr = 0, swr = 0, intervalCount = 0, utilSum = 0;
    for (let i = 0; i < rows.length; i++) {
      const w = weighted[m][i], q = requests[m][i];
      sww += w * w; srr += q * q; swr += w * q;
      if (w > 0) { intervalCount++; utilSum += y[i]; }
    }
    // A dead column is not separable from anything, and reads as r² = 1.
    const r2 = sww <= 0 || srr <= 0 ? 1 : (swr * swr) / (sww * srr);
    return { model, r2, intervals: intervalCount, utilSum, refusal: null, fit: null, raw: null };
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
    if (diagnostic.intervals < SPLIT_FLOORS.minIntervals || diagnostic.utilSum < SPLIT_FLOORS.minUtil) {
      diagnostic.refusal = 'thin-evidence';
      continue;
    }
    if (collinear[m]) {
      diagnostic.refusal = 'collinear';
      continue;
    }
    if (perMTok === undefined || perRequest === undefined) {
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
