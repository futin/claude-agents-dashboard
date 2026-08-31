/**
 * usage-rate.ts — what one percent of the 5-hour window is worth, per model.
 *
 * Anthropic publishes a utilization *percent* and never the budget behind it,
 * so the exchange rate has to be measured. Both halves are already on this
 * machine: `.usage-history.jsonl` prices each minute (percent), and
 * `.usage-ledger.jsonl` weighs it (tokens). This module joins them into
 * intervals, throws away every interval it cannot attribute, and fits a rate
 * per model over what survives.
 *
 * Pure throughout — no clock, no disk. Everything arrives as arguments so each
 * threshold and calendar edge is testable (`test/usage-rate-*.test.ts`).
 *
 * **The discipline here is refusal.** Almost every kind of interval is thrown
 * away: a window roll, a utilization drop, a minute the recorder missed, a
 * minute where two models were both busy, a minute burned on another device.
 * What is left is a small, clean sample — and the alternative (spreading
 * ambiguous spend across models by some assumption) would train the fit on its
 * own guesses. See `docs/subsystems/usage-limits.md`.
 */

import { sameWindow } from './usage-history.js';
import type { UsageSample } from './usage-history.js';
import { addCounts, emptyCounts, scaleCounts, weightedTokens } from './usage-ledger.js';
import type { LedgerLine, TokenCounts } from './usage-ledger.js';

/** Weighted share of an interval one model must hold to own it. */
export const DOMINANCE = 0.9;

/**
 * Utilization movement below this is no movement at all. Matches the epsilon
 * `shouldWrite` already treats as an unchanged sample, so an interval the
 * history log considered worth no new line is never fitted on either.
 */
export const IDLE_EPS = 0.01;

/**
 * Weighted tokens under which a *rising* interval is someone else's spend.
 *
 * A percent of the window is on the order of a million weighted tokens, so a
 * rise backed by a few thousand cannot have happened here — it is another
 * device on the same account. Excluded from every fit and disclosed separately;
 * it is the one systematic bias in the measurement.
 */
export const EXTERNAL_WEIGHTED_MAX = 5_000;

/**
 * Fraction of an interval's duration that must be covered by ledger lines.
 *
 * History samples are write-on-change compressed, so one interval routinely
 * spans several ledger lines — but a *missing* line means the server was down
 * for that minute, and the tokens spent then were never measured. Attributing
 * the whole interval's utilization to the minutes we did see would inflate the
 * rate silently, so the interval is marked `gap` and dropped instead.
 */
export const LEDGER_COVERAGE_MIN = 0.8;

/**
 * What an interval turned out to be.
 *
 * `{model}` is the only kind a rate is ever fitted on. The rest are named
 * rather than merged into one "unusable" bucket because they mean different
 * things: `external` is a disclosed bias, `gap` is our own downtime, `mixed` is
 * a limitation of dominance attribution, and `idle` is a measurement.
 */
export type IntervalKind = 'idle' | 'external' | 'mixed' | 'gap' | { model: string };

/** One consecutive pair of history samples, with the tokens spent between them. */
export interface Interval {
  fromT: number;
  toT: number;
  /** Utilization percentage points gained. Never negative — a drop is discarded. */
  dUtil: number;
  /** Per-model counts summed from the ledger lines inside the interval. */
  tok: Record<string, TokenCounts>;
  kind: IntervalKind;
}

/** Total weighted tokens across every model in an interval. */
export function totalWeighted(tok: Record<string, TokenCounts>): number {
  let sum = 0;
  for (const counts of Object.values(tok)) sum += weightedTokens(counts);
  return sum;
}

/**
 * Which model owns this interval, or null when none holds {@link DOMINANCE}.
 *
 * Dominance rather than a least-squares decomposition of mixed intervals: with
 * a handful of models and one equation per interval the decomposition is
 * under-determined exactly when it matters (two models always used together),
 * and a wrong split is indistinguishable from drift. Discarding is honest and
 * costs only sample size — revisit if the discard share proves high.
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
 * **Overlap-weighted, not whole-lines-only** — and this was measured, not
 * chosen for elegance. The two logs are written on different grids: history
 * samples are write-on-change, so an interval starts and ends whenever
 * utilization happened to move, while ledger ticks land once a minute. Counting
 * only the lines lying *wholly* inside an interval therefore throws away up to
 * a minute at each edge, which is most of a short interval — run against real
 * logs that rule classified **759 of 759** intervals as `gap`, i.e. the feature
 * measured nothing at all.
 *
 * Consecutive ticks tile the timeline (`prevT` of one is the `t` of the last),
 * so summing overlaps recovers the interval's full duration whenever the
 * recorder was running, and falls short by exactly the minutes it was not —
 * which is what {@link LEDGER_COVERAGE_MIN} is meant to test.
 *
 * The edge ticks are split *pro rata*, which assumes spend was uniform inside
 * those two minutes. That is the one approximation here, it is bounded by two
 * ticks per interval, and the alternative was measuring nothing.
 */
function gather(ledger: LedgerLine[], fromT: number, toT: number): {
  tok: Record<string, TokenCounts>;
  coveredMs: number;
} {
  const tok: Record<string, TokenCounts> = {};
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
    }
  }
  return { tok, coveredMs };
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
 * A pair survives only inside one window and only rising: a reset restarts the
 * count at zero (the 5-hour window is a fixed session window, not a sliding
 * one — see `docs/subsystems/usage-limits.md`), and a drop without a window
 * change is a reading we cannot explain. Both are dropped entirely rather than
 * clamped, because a clamped interval would contribute tokens with no price.
 *
 * Samples are assumed time-ordered, as both the log and the reader produce
 * them; a pair that is not strictly increasing is discarded rather than sorted,
 * since out-of-order samples mean something upstream is wrong.
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

    const { tok, coveredMs } = gather(ledger, from.t, to.t);
    const covered = coveredMs / durationMs >= LEDGER_COVERAGE_MIN;
    out.push({ fromT: from.t, toT: to.t, dUtil, tok, kind: classify(dUtil, tok, covered) });
  }
  return out;
}

// ── Rates, baselines and drift ───────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** How far back the baseline reaches. */
export const BASELINE_MS = 17 * DAY_MS;
/** The trailing span compared against that baseline. */
export const CURRENT_MS = 3 * DAY_MS;

/**
 * Weighted deviation from baseline, in percent, beyond which the rate has
 * genuinely moved. Wide on purpose: the pooled ratio still carries sampling
 * noise, and a badge that cries drift at ±5% would be ignored within a week.
 */
export const DRIFT_PCT = 20;

/**
 * The same for the *raw* rate, and only ever reported as a **mix shift**.
 *
 * Raw tokens per percent move whenever the token mix does — a session leaning
 * harder on cache reads shifts it a long way with nothing repriced. Wider than
 * {@link DRIFT_PCT} because it is the noisier quantity, and it is never called
 * drift: the weighted rate is the one that means the exchange rate changed.
 */
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
 * rounding-error rate, and one interval covering 20% is a single unrepeated
 * observation. The current floors are lower than the baseline's because the
 * current window is a fifth of the span — holding it to the same evidence
 * would mean the card never said anything until the fourteenth day.
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
 * `[now−3d, ∞)` — the trailing window.
 *
 * Open at the top rather than closed at `now`: an interval stamped a moment
 * ahead of the request clock is still the most recent thing measured, and
 * dropping it for being a second in the future would be a silent hole at
 * exactly the edge this window exists to watch.
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
 * **Pooled Σtokens / Σutil, not a mean of per-interval ratios.** A mean lets a
 * 0.02% interval with a noisy numerator count as much as an hour of steady
 * work; pooling weights every interval by the movement it actually explains,
 * which is the quantity being measured. The floors are what keep the pool
 * robust — and they are the reason a median was not needed instead.
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
 * Verdict order matters: **thin outranks everything**. A rate fitted on too
 * little data can deviate by any amount at all, so calling that drift would
 * make the badge fire hardest exactly when it knows least. Only once both sides
 * are real does the weighted deviation decide, and only if *that* is flat does
 * the raw one get to speak — as `mix-shift`, which explicitly says the exchange
 * rate did not move.
 *
 * The evidence counters describe the **current** window and are reported
 * whatever the verdict: "collecting — 4 windows, 1.2 points" is a useful thing
 * for the card to say, and a bare `thin` is not.
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
 * The denominator is everything that moved and was measured — external, clean
 * and mixed intervals. `idle` is excluded because nothing moved, and `gap`
 * because we were not watching: counting our own downtime as another device's
 * spend would turn a server restart into a claim about the account.
 *
 * Null rather than 0 when nothing moved at all: "no external burn" and "no
 * evidence either way" are different statements, and only one of them belongs
 * on a card.
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
