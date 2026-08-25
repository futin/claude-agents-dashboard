/**
 * usage-history.ts — learn which hours of the week you actually work.
 *
 * `usage-forecast.ts` walks forward over 168 hour-of-week weights. This module
 * is where those weights come from: a stream of (time, utilization, resetsAt)
 * samples of the **5-hour** window, classified pairwise into active / idle /
 * ambiguous / reset intervals, accumulated per hour-of-week bucket, and folded
 * once a week through an EWMA.
 *
 * Three things about the classification are counter-intuitive enough that each
 * was gotten backwards once:
 *
 * 1. **A flat interval is a measurement of idleness, not missing data.**
 *    Utilization is cumulative within a window, so two samples bracketing a gap
 *    with the same `resetsAt` and the same utilization *prove* nothing was
 *    spent in between. "No data means unknown" would defeat the whole feature:
 *    the laptop sleeps at night, night is exactly what the profile needs to
 *    learn, and those buckets would never collect evidence. A sleeping laptop is
 *    the best teacher this module has.
 * 2. **Ambiguity is a function of duration, not direction.** Two samples a
 *    minute apart with utilization rising pin that activity to that minute —
 *    it is the only way `activeMin` ever grows. Only a *long* rising interval is
 *    unattributable. Get this backwards and every hour learns as idle.
 * 3. **The trust floor is lifetime, not per-week.** A bucket gathers at most 60
 *    minutes per week, so a per-week floor at an hour could never be met. Trust
 *    accrues across weeks; the weight itself is what tracks recency.
 *
 * And a quiet bucket must *decay*, not freeze: a weight only moves when its
 * bucket folds, so an abandoned hour would otherwise keep its old weight forever
 * while lifetime evidence kept it trusted. `observedWeeks` records the weeks we
 * were recording at all, so a month of server downtime ages nothing while a
 * month of ordinary use with that hour idle ages it at the normal half-life.
 *
 * See `docs/subsystems/usage-limits.md`.
 */

import { HOURS_PER_WEEK, hourOfWeek } from './usage-forecast.js';
import type { DutyProfile } from './usage-forecast.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * How much of a week's ratio replaces the standing weight on each fold. 0.3
 * gives a half-life of about two weeks — quick enough to follow a change of
 * habit, slow enough that one unusual week doesn't rewrite the profile.
 */
export const EWMA_ALPHA = 0.3;

/** Lifetime observed minutes before a bucket's weight is used at all. */
export const TRUST_FLOOR_MIN = 60;

/**
 * Longest rising interval whose activity can still be pinned to it. Comfortably
 * above the one-minute sampling cadence, well below any real gap. A rise across
 * anything longer is discarded rather than spread — spreading it by existing
 * weights would train the profile on its own output.
 */
export const MAX_ATTRIBUTABLE_MS = 300_000;

/** Matches the utilization-drop epsilon `recordAndPace` already uses. */
const MOVE_EPSILON = 0.5;

/** Observed weeks retained for the decay count. Half a year is plenty. */
const MAX_OBSERVED_WEEKS = 26;

/** One reading of the 5-hour window, as recorded. */
export interface UsageSample {
  /** Sample time, ms epoch. */
  t: number;
  /** Utilization percent at that time (0–100). */
  utilization: number;
  /** The window's reset time; a change means a different window. */
  resetsAt: string | null;
}

/** One hour-of-week bucket. Indexed 0–167, 0 = Sunday 00:00 local. */
export interface Bucket {
  /** Learned expected active share, 0–1. Null until the first fold. */
  weight: number | null;
  /** ISO week the pending accumulators belong to. Null when never touched. */
  weekStamp: string | null;
  /** Minutes observed **this** week. Zeroed on fold. */
  observedMin: number;
  /** Of those, minutes attributed to activity. Zeroed on fold. */
  activeMin: number;
  /** Minutes observed ever. Never reset — the trust floor's input. */
  lifetimeObservedMin: number;
}

export interface ProfileState {
  buckets: Bucket[];
  /**
   * ISO week keys in which *any* bucket was observed, ascending, pruned to the
   * newest {@link MAX_OBSERVED_WEEKS}. A bucket that sits out one of these
   * decays by it; weeks we weren't recording are absent and cost nothing.
   */
  observedWeeks: string[];
}

export type IntervalKind = 'active' | 'idle' | 'ambiguous' | 'reset';

/** A fresh state. Always a new array — a shared constant would leak across calls. */
export function emptyState(): ProfileState {
  const buckets: Bucket[] = [];
  for (let i = 0; i < HOURS_PER_WEEK; i++) {
    buckets.push({
      weight: null,
      weekStamp: null,
      observedMin: 0,
      activeMin: 0,
      lifetimeObservedMin: 0
    });
  }
  return { buckets, observedWeeks: [] };
}

/**
 * What a pair of consecutive samples tells us about the span between them.
 *
 * `reset` and `ambiguous` are both discarded — the first spans two different
 * windows, the second cannot be attributed to any particular hour inside it.
 */
export function classifyInterval(
  a: UsageSample,
  b: UsageSample,
  maxAttributableMs: number = MAX_ATTRIBUTABLE_MS
): IntervalKind {
  if (a.resetsAt !== b.resetsAt) return 'reset';
  const delta = b.utilization - a.utilization;
  if (delta < -MOVE_EPSILON) return 'reset';
  if (delta > MOVE_EPSILON) {
    return b.t - a.t <= maxAttributableMs ? 'active' : 'ambiguous';
  }
  return 'idle'; // flat at any duration — the sleep measurement
}

/**
 * `YYYY-Www` for the ISO-8601 week containing `ms` in local time.
 *
 * Real Thursday-anchored numbering, not `dayOfYear / 7`: only equality is ever
 * compared, but a wrong boundary would fold twice in one week or skip one
 * entirely. Note ISO weeks start on Monday while `hourOfWeek` counts from
 * Sunday — bucket indexing and fold grouping are independent axes.
 */
export function isoWeekKey(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * 60_000);
  // Move to the Thursday of this ISO week; its calendar year is the ISO year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(d.getTime());
  thursday.setUTCDate(d.getUTCDate() - dayNum + 3);
  thursday.setUTCHours(0, 0, 0, 0);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstDayNum = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const week1Monday = firstThursday - firstDayNum * 24 * HOUR_MS;
  const week = Math.round((thursday.getTime() - week1Monday) / (7 * 24 * HOUR_MS)) + 1;
  return year + '-W' + String(week).padStart(2, '0');
}

/** Observed weeks strictly between `from` and `to`, i.e. the ones sat out. */
function skippedWeeks(observedWeeks: string[], from: string, to: string): number {
  let n = 0;
  for (const wk of observedWeeks) if (wk > from && wk < to) n++;
  return n;
}

/**
 * Fold the pending week into the standing weight, then age it by the weeks this
 * bucket sat out.
 *
 * **The order is load-bearing.** The pending accumulators belong to the bucket's
 * `weekStamp` week and the skipped weeks came *after* it, so they age that
 * week's contribution. Decaying first would age a weight the skipped weeks
 * predate, and a first-ever fold would skip the decay entirely and leave a stale
 * seed at full strength.
 */
function foldBucket(bucket: Bucket, weekKey: string, observedWeeks: string[]): void {
  if (bucket.weekStamp === null || bucket.weekStamp === weekKey) return;
  if (bucket.observedMin <= 0) return; // nothing pending: nothing folds, nothing decays

  const ratio = bucket.activeMin / bucket.observedMin;
  const folded = bucket.weight === null
    ? ratio
    : (1 - EWMA_ALPHA) * bucket.weight + EWMA_ALPHA * ratio;
  const k = skippedWeeks(observedWeeks, bucket.weekStamp, weekKey);
  bucket.weight = folded * Math.pow(1 - EWMA_ALPHA, k);
  bucket.observedMin = 0;
  bucket.activeMin = 0;
}

/**
 * Credit one classified interval to every hour-of-week bucket it spans.
 *
 * Never mutates `state` — callers hold onto earlier states. An interval can
 * cross hour and week boundaries, so it is split at local hour boundaries and
 * each slice stamps and folds with **its own** week key: one key per interval
 * would misfile the Sunday side of a week-boundary interval into the new week.
 */
export function accumulate(
  state: ProfileState,
  a: UsageSample,
  b: UsageSample,
  offsetMinutes: number
): ProfileState {
  const kind = classifyInterval(a, b);
  if (kind !== 'active' && kind !== 'idle') return state; // discarded
  if (b.t <= a.t) return state;

  const buckets = state.buckets.map((x) => ({ ...x }));
  const observedWeeks = [...state.observedWeeks];

  let t = a.t;
  while (t < b.t) {
    const shift = offsetMinutes * 60_000;
    const nextHour = Math.floor((t + shift) / HOUR_MS) * HOUR_MS + HOUR_MS - shift;
    const sliceEnd = Math.min(nextHour, b.t);
    const mins = (sliceEnd - t) / MINUTE_MS;
    const weekKey = isoWeekKey(t, offsetMinutes);
    const bucket = buckets[hourOfWeek(t, offsetMinutes)];

    foldBucket(bucket, weekKey, observedWeeks);
    bucket.weekStamp = weekKey;
    bucket.observedMin += mins;
    bucket.lifetimeObservedMin += mins;
    if (kind === 'active') bucket.activeMin += mins;

    if (!observedWeeks.includes(weekKey)) {
      observedWeeks.push(weekKey);
      observedWeeks.sort();
      if (observedWeeks.length > MAX_OBSERVED_WEEKS) {
        observedWeeks.splice(0, observedWeeks.length - MAX_OBSERVED_WEEKS);
      }
    }
    t = sliceEnd;
  }

  return { buckets, observedWeeks };
}

/**
 * The profile the forecast walk consumes: weights for the trusted buckets, and
 * the mean of those as the fallback for the rest.
 *
 * `globalMean` is 1 when nothing is trusted yet — the pessimistic default, which
 * reproduces today's flat-rate behaviour rather than inventing an optimistic one.
 */
export function deriveProfile(state: ProfileState): DutyProfile {
  const weights: (number | null)[] = state.buckets.map((b) =>
    b.lifetimeObservedMin >= TRUST_FLOOR_MIN ? b.weight : null
  );
  const trusted = weights.filter((w): w is number => typeof w === 'number');
  return {
    weights,
    globalMean: trusted.length > 0 ? trusted.reduce((a, w) => a + w, 0) / trusted.length : 1,
    trustedCount: trusted.length
  };
}
