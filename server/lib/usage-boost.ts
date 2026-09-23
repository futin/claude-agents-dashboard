/**
 * Is a time-of-day capacity promotion running — limits raised outside weekday peak hours, as they were 2026-03-13 → 2026-03-27?
 *
 * Pure over `Interval[]`, no clock and no disk, exactly like the fitter beside it. It adds a grouping over intervals `usage-rate.ts` already
 * produces and measures nothing new: every rate below is {@link poolRate} over a slice, so the dominance rule and the pooled arithmetic stay in
 * one place.
 *
 * Two verdicts, deliberately independent and never merged:
 *
 * - **Weekday** — each ET weekday's off-peak cell against that *same day's* peak cell. Every day is its own control, so day-to-day variation,
 *   model drift and workload drift cancel, and the verdict rides on how many consecutive recent days agree.
 * - **Weekend** — a weekend day has no unboosted hours to pair against, so each is compared against the weekday *peak* rate pooled over every
 *   weekday date in the horizon. A cross-day control: the weaker instrument of the two, and labelled so wherever it surfaces.
 *
 * Both require the **weighted and the raw** ratio to clear the floor together. A genuine limit boost halves the percentage charged for every
 * token, so both double; a cache-heavy stretch moves raw far more than weighted, and a weighting artifact moves weighted and not raw. That is
 * the same weighted-vs-raw discriminator `driftRow` uses to tell drift from mix-shift — its verdict is not reused because it compares two
 * windows of time, not two times of day.
 */

import type { BoostHour, BoostReason, BoostVerdict, BoostWeekend, UsageBoost } from '../../shared/types.js';
import { poolRate } from './usage-rate.js';
import type { Interval, ModelRate } from './usage-rate.js';

const DAY_MS = 86_400_000;

/** How far back the detector reads. The observed promo ran 14 days, so a live one is wholly inside this window by its end. */
export const BOOST_MS = 14 * DAY_MS;

/**
 * The peak window under test, half-open, in ET hours — [08:00, 14:00) on weekdays, from the 2026-03-13 → 2026-03-27 promo, the only instance
 * ever seen. Hardcoded as the hypothesis under test rather than learned: a change point needs coverage this record does not have. What the
 * card shows as *carrying* a boost is observed, per hour, not these announced bounds.
 */
export const PEAK_START_HOUR_ET = 8;
export const PEAK_END_HOUR_ET = 14;

/**
 * Both ratios must reach this. Per-day rate cv ≈ 24% on this machine, so a ratio of two daily cells sits near cv ≈ 34% and 1.5 is ≈ +1.5σ;
 * {@link BOOST_MIN_RUN_DAYS} consecutive days agreeing puts chance firing near 3 × 10⁻⁴, while a true 2× sits ≈ 3σ clear.
 *
 * For the weekend comparison the control is pooled, so its own noise falls to ≈ 7.6% at 10 weekday dates (≈ 10.7% at the floor of 5) and the
 * ratio carries ≈ 25.2% (≈ 26.3%): the same 1.5 is ≈ 2.0σ (1.9σ) and a true 2× is ≈ 4.0σ (3.8σ).
 */
export const BOOST_MIN_RATIO = 1.5;

/** Consecutive newest paired weekdays that must agree before the weekday verdict may claim anything. */
export const BOOST_MIN_RUN_DAYS = 3;

/**
 * What one day's peak or off-peak cell (or one weekend day) needs to count. Cleared many times over on a working day — peak ≈ 59 pts/day and
 * off-peak ≈ 74 pts/day on idea-23's baseline — and correctly excludes days off.
 */
export const BOOST_CELL_FLOORS = { minIntervals: 5, minUtil: 3 } as const;

/** Longer than this spans buckets and cannot be attributed to one. Dropped, never split: a split invents a token distribution never measured. */
export const BOOST_MAX_INTERVAL_MS = 3_600_000;

/** Points one ET hour needs, pooled across the run, before its rate is reported at all. Under it the hour is omitted, not shown as zero. */
export const BOOST_HOUR_MIN_UTIL = 3;

/**
 * Consecutive newest weekend days that must agree. One weekend: two is the most a single weekend can offer, and waiting for two weekends
 * would report a 14-day promo half-over. Two days at ≈ 2σ each puts chance firing near 0.05% under independence — call it under 1% in
 * practice, since one unusual weekend correlates its own two days.
 */
export const WEEKEND_MIN_RUN_DAYS = 2;

/**
 * What the pooled weekday-peak control needs. `minDays` is the load-bearing one — distinct weekday **ET** dates — because the whole case for
 * a cross-day control is that pooling shrinks its noise, and 5 dates is where that still holds (≈ 10.7%).
 */
export const WEEKEND_CONTROL_FLOORS = { minIntervals: 30, minUtil: 15, minDays: 5 } as const;

export interface EtStamp {
  /** `YYYY-MM-DD` in America/New_York. */
  date: string;
  /** 0–23. */
  hour: number;
  weekend: boolean;
}

// `hourCycle: 'h23'` rather than `hour12: false`, which can yield `'24'` for midnight on some ICU builds. DST is the formatter's problem.
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short'
});

/** An epoch ms as an ET calendar date, hour and weekend flag. */
export function etStamp(ms: number): EtStamp {
  const parts: Record<string, string> = {};
  for (const part of ET.formatToParts(ms)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun'
  };
}

const isPeakHour = (hour: number): boolean => hour >= PEAK_START_HOUR_ET && hour < PEAK_END_HOUR_ET;

const pool = (slice: Interval[], model: string): ModelRate | null =>
  poolRate(slice, model, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);

function clearsCell(rate: ModelRate | null): rate is ModelRate {
  return rate !== null && rate.intervals >= BOOST_CELL_FLOORS.minIntervals && rate.utilSum >= BOOST_CELL_FLOORS.minUtil;
}

/** One compared day: the numerator and denominator slices, and the two ratios they give. */
interface Paired {
  date: string;
  num: Interval[];
  den: Interval[];
  weightedRatio: number;
  rawRatio: number;
}

const clears = (day: Paired): boolean => day.weightedRatio >= BOOST_MIN_RATIO && day.rawRatio >= BOOST_MIN_RATIO;

/** Pooled numerator over pooled denominator — pooled rather than a mean of daily ratios, for the reason `poolRate` pools. */
function pooledRatio(num: Interval[], den: Interval[], model: string): { ratio: number | null; rawRatio: number | null } {
  const top = pool(num, model);
  const bottom = pool(den, model);
  if (top === null || bottom === null) return { ratio: null, rawRatio: null };
  return { ratio: top.weightedPerPct / bottom.weightedPerPct, rawRatio: top.rawPerPct / bottom.rawPerPct };
}

interface Judged {
  verdict: BoostVerdict;
  reason: BoostReason | null;
  ratio: number | null;
  rawRatio: number | null;
  days: number;
  since: string | null;
  run: Paired[];
}

/**
 * The shared walk: `days` newest-first, the leading run where both ratios clear the floor.
 *
 * A run of at least `minRun` is a boost, pooled over the run alone so older unboosted days neither dilute it nor count. Otherwise the newest
 * day's two ratios disagreeing is `mix-shift`; a record too short to hold `minRun` days, **or** a run that started but has not yet reached
 * `minRun`, is `thin-evidence` — a boost may be beginning and the honest answer is "not enough yet", not "flat". Only a record with no run at
 * all reads `flat`. Outside a boost the ratio is pooled over every compared day, so a flat reading still publishes its ~1.0.
 */
function judge(days: Paired[], minRun: number, model: string): Judged {
  let runLength = 0;
  while (runLength < days.length && clears(days[runLength])) runLength++;
  const run = days.slice(0, runLength);
  if (runLength >= minRun) {
    return {
      verdict: 'boost', reason: null,
      ...pooledRatio(run.flatMap((d) => d.num), run.flatMap((d) => d.den), model),
      days: runLength, since: run[runLength - 1].date, run
    };
  }
  const all = days.length === 0
    ? { ratio: null, rawRatio: null }
    : pooledRatio(days.flatMap((d) => d.num), days.flatMap((d) => d.den), model);
  const base = { ...all, days: days.length, since: null, run: [] };
  const newest = days[0];
  if (newest !== undefined && (newest.weightedRatio >= BOOST_MIN_RATIO) !== (newest.rawRatio >= BOOST_MIN_RATIO)) {
    return { verdict: 'inconclusive', reason: 'mix-shift', ...base };
  }
  if (days.length < minRun || runLength > 0) return { verdict: 'none', reason: 'thin-evidence', ...base };
  return { verdict: 'none', reason: 'flat', ...base };
}

function ratiosOf(num: ModelRate, den: ModelRate): { weightedRatio: number; rawRatio: number } {
  return { weightedRatio: num.weightedPerPct / den.weightedPerPct, rawRatio: num.rawPerPct / den.rawPerPct };
}

/** The model holding the most owned utilization — the one sensor. A boost is an account property, and pooling models would reintroduce mix. */
function sensorModel(intervals: Interval[]): string | null {
  const util = new Map<string, number>();
  for (const interval of intervals) {
    if (typeof interval.kind !== 'object') continue;
    util.set(interval.kind.model, (util.get(interval.kind.model) ?? 0) + interval.dUtil);
  }
  let best: string | null = null;
  for (const [model, sum] of util) {
    if (best === null || sum > util.get(best)! || (sum === util.get(best)! && model < best)) best = model;
  }
  return best;
}

/** The zeroed body — every verdict `none`, every counter zero. What the not-recording and fail-open responses carry. */
export function emptyBoost(): UsageBoost {
  return {
    verdict: 'none', reason: 'thin-evidence', model: null, ratio: null, rawRatio: null, days: 0, since: null,
    peakStartHourEt: PEAK_START_HOUR_ET, peakEndHourEt: PEAK_END_HOUR_ET, hours: [],
    weekend: { verdict: 'none', reason: 'thin-evidence', ratio: null, rawRatio: null, days: 0, since: null, controlDays: 0 }
  };
}

/** Both verdicts over `[nowMs − BOOST_MS, ∞)`. */
export function detectBoost(intervals: Interval[], nowMs: number): UsageBoost {
  // Open at the top for the reason `currentRange` is: an interval stamped a moment ahead of the request clock is not dropped at the edge.
  const sinceMs = nowMs - BOOST_MS;
  const inHorizon = intervals.filter((i) => i.toT >= sinceMs && i.toT - i.fromT <= BOOST_MAX_INTERVAL_MS);
  const model = sensorModel(inHorizon);
  if (model === null) return emptyBoost();

  // Bucketed by midpoint. `poolRate` still re-applies ownership on every slice, so nothing here re-derives it.
  const peak = new Map<string, Interval[]>();
  const offPeak = new Map<string, Interval[]>();
  const weekendDays = new Map<string, Interval[]>();
  const hourOf = new Map<Interval, number>();
  for (const interval of inHorizon) {
    if (typeof interval.kind !== 'object' || interval.kind.model !== model) continue;
    const stamp = etStamp((interval.fromT + interval.toT) / 2);
    hourOf.set(interval, stamp.hour);
    const cells = stamp.weekend ? weekendDays : isPeakHour(stamp.hour) ? peak : offPeak;
    const cell = cells.get(stamp.date);
    if (cell === undefined) cells.set(stamp.date, [interval]); else cell.push(interval);
  }
  const newestFirst = (dates: Iterable<string>): string[] => [...dates].sort().reverse();

  // ── Weekday: each date against itself ─────────────────────────────────────
  const paired: Paired[] = [];
  for (const date of newestFirst(peak.keys())) {
    const den = peak.get(date)!;
    const num = offPeak.get(date) ?? [];
    const denRate = pool(den, model);
    const numRate = pool(num, model);
    if (!clearsCell(denRate) || !clearsCell(numRate)) continue;
    paired.push({ date, num, den, ...ratiosOf(numRate, denRate) });
  }
  const weekday = judge(paired, BOOST_MIN_RUN_DAYS, model);

  // Observed hours, only for a boost: each hour pooled across the run, against the run's pooled peak rate.
  const hours: BoostHour[] = [];
  if (weekday.verdict === 'boost') {
    const peakRate = pool(weekday.run.flatMap((d) => d.den), model)!;
    const byHour = new Map<number, Interval[]>();
    for (const interval of weekday.run.flatMap((d) => [...d.num, ...d.den])) {
      const hour = hourOf.get(interval)!;
      const slot = byHour.get(hour);
      if (slot === undefined) byHour.set(hour, [interval]); else slot.push(interval);
    }
    for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
      const rate = pool(byHour.get(hour)!, model);
      if (rate === null || rate.utilSum < BOOST_HOUR_MIN_UTIL) continue;
      if (rate.weightedPerPct < BOOST_MIN_RATIO * peakRate.weightedPerPct) continue;
      hours.push({ hour, weightedPerPct: rate.weightedPerPct, utilSum: rate.utilSum });
    }
  }

  // ── Weekend: each date against the pooled weekday *peak* ──────────────────
  // Never the off-peak: during a live promotion those are the boosted hours, and the control would divide a boost by a boost and read flat.
  // Only a peak cell that clears the cell floor is a control day: a date holding one stray interval is present but measures nothing, and counted
  // as a date it would carry the day floor below on dust.
  const controlCells = [...peak.values()].filter((cell) => clearsCell(pool(cell, model)));
  const control = controlCells.flat();
  const controlDays = controlCells.length;
  const controlRate = pool(control, model);
  let weekend: BoostWeekend;
  if (controlRate === null || controlRate.intervals < WEEKEND_CONTROL_FLOORS.minIntervals
    || controlRate.utilSum < WEEKEND_CONTROL_FLOORS.minUtil || controlDays < WEEKEND_CONTROL_FLOORS.minDays) {
    // A ratio with no adequate control is not a measurement, so none is published.
    weekend = { verdict: 'none', reason: 'thin-evidence', ratio: null, rawRatio: null, days: 0, since: null, controlDays };
  } else {
    const days: Paired[] = [];
    for (const date of newestFirst(weekendDays.keys())) {
      const num = weekendDays.get(date)!;
      const numRate = pool(num, model);
      if (!clearsCell(numRate)) continue;
      days.push({ date, num, den: control, ...ratiosOf(numRate, controlRate) });
    }
    // Every day's denominator is the same pool; repeating it once per day scales both sides of the pooled rate alike, so the ratio holds.
    const judged = judge(days, WEEKEND_MIN_RUN_DAYS, model);
    weekend = {
      verdict: judged.verdict, reason: judged.reason, ratio: judged.ratio, rawRatio: judged.rawRatio,
      days: judged.days, since: judged.since, controlDays
    };
  }

  return {
    verdict: weekday.verdict, reason: weekday.reason, model,
    ratio: weekday.ratio, rawRatio: weekday.rawRatio, days: weekday.days, since: weekday.since,
    peakStartHourEt: PEAK_START_HOUR_ET, peakEndHourEt: PEAK_END_HOUR_ET, hours, weekend
  };
}
