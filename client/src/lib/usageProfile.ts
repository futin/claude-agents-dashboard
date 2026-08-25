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

/**
 * Local midnight starting the next ISO week (Monday), as ms epoch — the earliest
 * moment any bucket can fold and so the earliest a cell can carry a weight.
 *
 * On a Monday this returns the *following* Monday, not today: the current week
 * is the one still accumulating, so its folds are still seven days out.
 */
export function nextWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const isoDay = d.getDay() || 7;   // getDay(): Sunday is 0; ISO wants 7
  d.setDate(d.getDate() + (8 - isoDay));
  return d.getTime();
}

/** "30 min" / "2h 05m" — the observed-minutes total, read at a glance. */
export function fmtObserved(totalMin: number): string {
  const mins = Math.round(totalMin);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
