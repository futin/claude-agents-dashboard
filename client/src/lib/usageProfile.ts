import type { UsageProfileCell } from '../../../shared/types';

/**
 * usageProfile.ts — pure helpers for the duty-cycle inspector's status line.
 *
 * The grid is *entirely* texture until a week folds, and that is correct by the
 * model rather than a bug: a weight is a weekly EWMA fold, so there is genuinely
 * nothing to average until a week completes. But it means the inspector's first
 * week shows 168 identical hatched cells with no sign that recording works —
 * which reads as broken. These functions feed the line that says otherwise.
 *
 * Two gates stand between a recorded minute and a coloured cell, and the status
 * line has to be able to name which one you are waiting on:
 *
 *   1. `lifetimeObservedMin >= TRUST_FLOOR_MIN` for that hour-of-week bucket.
 *   2. At least one *fold*, which only happens when a sample lands in a
 *      different ISO week than the bucket's stamp.
 *
 * So an hour can be past the trust floor and still have no weight, for up to a
 * week. Pure and unit-tested (test/usage-profile-view.test.ts) — the weekday
 * arithmetic in particular is the kind that looks obvious and is off by one.
 */

/**
 * Lifetime observed minutes before a bucket's weight is used at all.
 *
 * Mirrors `TRUST_FLOOR_MIN` in `server/lib/usage-history.ts`. Duplicated rather
 * than sent over the wire because it is a constant of the model, not a runtime
 * value — but it does mean the two must move together.
 */
export const TRUST_FLOOR_MIN = 60;

export interface ProfileProgress {
  /** Hour-of-week buckets with any evidence at all. */
  touched: number;
  /** Total observed minutes across every bucket. */
  totalMin: number;
  /** Buckets that have cleared the trust floor. */
  atFloor: number;
  /** Buckets that actually carry a weight — i.e. that have folded. */
  trusted: number;
}

/** Count what the profile has so far. */
export function profileProgress(cells: UsageProfileCell[]): ProfileProgress {
  let touched = 0, totalMin = 0, atFloor = 0, trusted = 0;
  for (const c of cells) {
    if (c.observedMin > 0) touched++;
    totalMin += c.observedMin;
    if (c.observedMin >= TRUST_FLOOR_MIN) atFloor++;
    if (c.weight != null) trusted++;
  }
  return { touched, totalMin, atFloor, trusted };
}

/** Hour-of-week slots. Mirrors `HOURS_PER_WEEK` in `server/lib/usage-forecast.ts`. */
const HOURS_PER_WEEK = 168;

/**
 * Local midnight starting the next ISO week (Monday), as ms epoch.
 *
 * **Not the earliest fold**, though it was used as one and read six days late:
 * a fold fires when a bucket is touched in an ISO week later than its *stamp*,
 * so a bucket carrying last week's stamp folds at its next occurrence, which can
 * be today. See {@link earliestFoldMs}. What this marks is the end of the
 * current ISO week — the boundary a bucket stamped *this* week has to clear.
 */
export function nextWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const isoDay = d.getDay() || 7;   // getDay(): Sunday is 0; ISO wants 7
  d.setDate(d.getDate() + (8 - isoDay));
  return d.getTime();
}

/**
 * Local ms at which `hourOfWeek` next begins, strictly after `nowMs`.
 *
 * Strictly: an hour already in progress has had its chance this week — the fold
 * fires on the tick that enters the bucket, so a cell hovering at its own hour
 * is waiting on the *next* pass, not this one.
 *
 * Walks with `setHours` overflow rather than adding milliseconds, so a DST shift
 * lands on the same wall-clock hour — which is the hour the bucket indexes.
 */
export function nextOccurrenceMs(hourOfWeek: number, nowMs: number): number {
  const d = new Date(nowMs);
  d.setMinutes(0, 0, 0);
  let delta = hourOfWeek - (d.getDay() * 24 + d.getHours());
  if (delta <= 0) delta += HOURS_PER_WEEK;
  d.setHours(d.getHours() + delta);
  return d.getTime();
}

/**
 * The earliest moment any cell can start showing a weight, or null when nothing
 * has been recorded and there is no occurrence to date.
 *
 * Two gates have to fall, and both are datable per cell, so neither is guessed:
 *
 * - **The fold.** `staleWeeks` is what dates it. Non-zero means this bucket's
 *   pending week is already behind the newest observed one, so its very next
 *   occurrence folds it. Zero means it was stamped in the current week, and its
 *   next occurrence only counts once that week has ended — which bites exactly
 *   on Sunday hours, where the Sunday-indexed grid and the Monday-indexed ISO
 *   week disagree.
 * - **The floor.** A bucket short of {@link TRUST_FLOOR_MIN} folds on schedule
 *   but stays blank until the minutes arrive, and they arrive during that same
 *   hour — so the shortfall is simply added on. An hour 16 minutes short shows
 *   its weight 16 minutes into the pass, not a week later.
 *
 * Optimistic by construction: it assumes recording is live and the hour is
 * observed from its start. It answers "no sooner than", which is the question a
 * status line waiting on a slow model is actually being asked.
 */
export function earliestWeightMs(cells: UsageProfileCell[], nowMs: number): number | null {
  const weekEnd = nextWeekStartMs(nowMs);
  let earliest = Infinity;
  for (const c of cells) {
    if (c.weight != null || c.observedMin <= 0) continue;
    let at = nextOccurrenceMs(c.hourOfWeek, nowMs);
    if (c.staleWeeks === 0 && at < weekEnd) at = nextOccurrenceMs(c.hourOfWeek, at);
    at += Math.max(0, TRUST_FLOOR_MIN - c.observedMin) * 60_000;
    if (at < earliest) earliest = at;
  }
  return earliest === Infinity ? null : earliest;
}

/** "30 min" / "2h 05m" — the observed-minutes total, read at a glance. */
export function fmtObserved(totalMin: number): string {
  const mins = Math.round(totalMin);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Column headings, and the day half of a cell's label. Sunday-first, matching `hourOfWeek`. */
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The tooltip for one heatmap cell.
 *
 * Lives here rather than in the component so the wording is under test, and the
 * wording is the whole point: a blank cell has to name the gate it is *actually*
 * waiting on. "60 of 60 min needed" on an hour that cleared the floor days ago
 * reads as a stuck feature rather than as a model that folds weekly — and during
 * the first two weeks that is most of the grid.
 *
 * A cell carrying a weight has necessarily cleared the floor (`deriveProfile`
 * nulls the weight otherwise), so the minutes line never appears on one; its
 * evidence is stated in whole weeks, floored, because a partial second week is
 * not a second week.
 */
export function cellTitle(cell: UsageProfileCell, day: number, hour: number): string {
  const when = `${DAYS[day]} ${String(hour).padStart(2, '0')}:00 · every week`;
  if (cell.weight == null) {
    // Floored, never rounded: minutes are fractional, and a bucket at 59.98
    // rounds up into "60 of 60 min needed" — a demand the cell has already met,
    // which is precisely the contradiction this branch exists to remove.
    const mins = Math.floor(cell.observedMin);
    const why = cell.observedMin >= TRUST_FLOOR_MIN
      ? `${mins} min recorded — waiting for this hour to come round in a new week`
      : `${mins} of ${TRUST_FLOOR_MIN} min needed`;
    return `${when}\nno weight yet\n${why}\nfalls back to the weekly mean`;
  }
  const weeks = Math.floor(cell.observedMin / 60);
  const evidence = `${weeks} ${weeks === 1 ? 'week' : 'weeks'} of evidence`;
  const stale = cell.staleWeeks > 8 ? `\nlast seen ${cell.staleWeeks} weeks ago` : '';
  const level = cell.weight <= 0.02
    ? 'never active — measured, not missing'
    : `${Math.round(cell.weight * 100)}% active`;
  return `${when}\n${level}\n${evidence}${stale}`;
}
