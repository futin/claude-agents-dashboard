/**
 * usage-forecast.ts — the duty-cycle forward walk behind the weekly projection.
 *
 * The old projection was one division: remaining percent over percent-per-hour.
 * That silently assumes you work every hour between now and the reset, so a
 * Friday-evening burn rate got extrapolated across the whole weekend and the
 * weekly window looked like it would blow up on Sunday morning.
 *
 * This module replaces the division with a walk. It steps hour by hour from
 * `now` to the reset and adds `activeRatePerHour × weight(hourOfWeek)` for each
 * slice, where the weight is what fraction of that hour-of-week you typically
 * work (learned in `usage-history.ts`). A flat weight of 1.0 collapses the walk
 * back to exactly the old closed form — that is the regression floor, and a
 * test pins it.
 *
 * Nothing here touches disk or reads a clock, and that is deliberate: the
 * timezone arrives as an injected `offsetMinutes` (minutes east of UTC, so CEST
 * is +120) rather than being read from the host, so every calendar edge case —
 * week wraps, negative offsets, half-hour offsets, a reset in the past — is
 * testable against synthetic profiles with no ambient `TZ`. `localOffsetMinutes`
 * is the single impure line, and production is the only caller.
 *
 * **Accepted limitation:** the offset is taken once at `nowMs` and held for the
 * whole walk, so a DST transition inside the window shifts the projection by an
 * hour twice a year. On a projection already uncertain by hours, recomputing the
 * offset per slice is not worth the complexity.
 *
 * See `docs/subsystems/usage-limits.md`.
 */

import type { ForecastConfidence } from '../../shared/types.js';

const HOUR_MS = 3_600_000;

/** Hours in a week — the bucket count, and the walk's longest possible span. */
export const HOURS_PER_WEEK = 168;

/**
 * Trusted buckets at which the profile's shape stops moving much: roughly two
 * to three weeks of ordinary use. Below it the forecast is real but thin, and
 * the client draws a band rather than leading with a single tick.
 */
const TRUSTED_OK = 120;

/**
 * The learned duty cycle, one weight per hour of the week.
 *
 * Deliberately *not* in `shared/types.ts`: the 168 weights never cross the
 * FE/BE boundary — only the derived `dutyCycle` number and the confidence
 * string do.
 */
export interface DutyProfile {
  /**
   * 168 entries, index 0 = Sunday 00:00 local. `null` where the bucket has too
   * little evidence to trust, in which case `globalMean` stands in.
   */
  weights: (number | null)[];
  /** Fallback for a null bucket: the mean of the trusted ones, or 1. */
  globalMean: number;
  /** How many buckets are non-null. Feeds {@link confidenceOf}. */
  trustedCount: number;
}

/** One walked slice: when it starts, and the percentage points it adds. */
export interface ForecastStepMs {
  tMs: number;
  gain: number;
}

export interface ForecastResult {
  /** Ms epoch the walk crosses 100%, or null when it coasts to the reset. */
  exhaustAtMs: number | null;
  /** Time-weighted mean weight across the *whole* remaining window, 0–1. */
  dutyCycle: number;
  /** One entry per slice, covering the whole window — even past the crossing. */
  steps: ForecastStepMs[];
}

export interface WalkOpts {
  nowMs: number;
  /** Percent of the window already consumed, 0–100. */
  utilization: number;
  /** Percent per *active* hour — the rate with idle time already divided out. */
  activeRatePerHour: number;
  profile: DutyProfile;
  resetsAtMs: number;
  /** Minutes east of UTC. Tests pass 0; production passes localOffsetMinutes(). */
  offsetMinutes: number;
}

/**
 * Index of `ms` in a 168-hour week, `0` = Sunday 00:00 local.
 *
 * Sunday-first matches `Date.prototype.getUTCDay()`'s numbering, which is what
 * makes this a three-line function instead of a wrap-around puzzle: shift the
 * timestamp into local time and read the UTC day and hour off it. (ISO weeks
 * start on Monday, and `usage-history.ts` folds on that boundary — bucket
 * indexing and fold grouping are independent axes. Keep them straight.)
 */
export function hourOfWeek(ms: number, offsetMinutes: number): number {
  const local = new Date(ms + offsetMinutes * 60_000);
  return local.getUTCDay() * 24 + local.getUTCHours();
}

/** Every hour weighted the same. `flatProfile(1)` is today's arithmetic. */
export function flatProfile(weight: number): DutyProfile {
  return {
    weights: new Array(HOURS_PER_WEEK).fill(weight),
    globalMean: weight,
    trustedCount: HOURS_PER_WEEK
  };
}

/** The bucket's weight, falling back to `globalMean` when it isn't trusted. */
export function weightAt(profile: DutyProfile, hw: number): number {
  const w = profile.weights[hw];
  return typeof w === 'number' ? w : profile.globalMean;
}

/** Start of the next local hour after `ms`, in ms epoch. */
function nextLocalHour(ms: number, offsetMinutes: number): number {
  const shift = offsetMinutes * 60_000;
  const local = ms + shift;
  return Math.floor(local / HOUR_MS) * HOUR_MS + HOUR_MS - shift;
}

/**
 * Walk local-hour slices from now to the reset, accumulating the profile's
 * expected gain, and report where 100% is crossed.
 *
 * `steps` and `dutyCycle` deliberately cover the *whole* remaining window even
 * when the crossing happens early: the client renders `dutyCycle` as a rate, and
 * the profile inspector draws every slice — including the ones past the
 * crossing, because the weekend gap is the feature explaining itself.
 */
export function walkForward(opts: WalkOpts): ForecastResult {
  const { nowMs, utilization, activeRatePerHour, profile, resetsAtMs, offsetMinutes } = opts;
  if (!Number.isFinite(resetsAtMs) || resetsAtMs <= nowMs) {
    return { exhaustAtMs: null, dutyCycle: 0, steps: [] };
  }

  const remaining = 100 - utilization;
  // Already spent: the walk still runs (the strip and dutyCycle want the whole
  // window) but the crossing is now, not somewhere in the future.
  let exhaustAtMs: number | null = remaining <= 0 ? nowMs : null;

  const steps: ForecastStepMs[] = [];
  let accumulated = 0;
  let weightedMs = 0;
  let totalMs = 0;

  let t = nowMs;
  while (t < resetsAtMs) {
    const sliceEnd = Math.min(nextLocalHour(t, offsetMinutes), resetsAtMs);
    const sliceMs = sliceEnd - t;
    const weight = weightAt(profile, hourOfWeek(t, offsetMinutes));
    const gain = activeRatePerHour * weight * (sliceMs / HOUR_MS);

    steps.push({ tMs: t, gain });
    weightedMs += weight * sliceMs;
    totalMs += sliceMs;

    // A zero-weight or zero-rate slice adds nothing, so it can never cross —
    // and the guard is what keeps the interpolation from dividing by zero.
    if (exhaustAtMs === null && gain > 0 && accumulated + gain >= remaining) {
      exhaustAtMs = Math.round(t + ((remaining - accumulated) / gain) * sliceMs);
    }
    accumulated += gain;
    t = sliceEnd;
  }

  return {
    exhaustAtMs,
    dutyCycle: totalMs > 0 ? weightedMs / totalMs : 0,
    steps
  };
}

/** How far the profile can be trusted. See {@link TRUSTED_OK}. */
export function confidenceOf(profile: DutyProfile): ForecastConfidence {
  if (profile.trustedCount === 0) return 'none';
  return profile.trustedCount < TRUSTED_OK ? 'thin' : 'ok';
}

/** The host's UTC offset at `ms`, minutes east. The module's only impure line. */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}
