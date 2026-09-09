import type { ForecastConfidence, ForecastStep, UsageProfileCell } from '../../../shared/types';
import { fmtWalkHour, Y_MAX } from './walkChart';

/**
 * usageProfile.ts — pure helpers for the duty-cycle inspector's status line and
 * for the glossary its `How to read this` drawer prints.
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
 *
 * The glossary lives here for the same reason the tooltips do: it is copy, and
 * copy that quotes a live number (the weekly mean) or a model constant (the
 * trust floor, the chart's ceiling, the trusted-hour gate) drifts the moment it
 * is retyped in a component. Every ⓘ on the tab prints an entry of it, so the
 * panel and the drawer are one string, tested as one.
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

/**
 * The day half of a cell's label, indexed the way `hourOfWeek` is — Sunday
 * first, because the bucket index is `getDay() * 24 + hour`. This is the *data*
 * order, not the display order: render columns through {@link DAY_ORDER}.
 */
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Display order of the seven columns, as indices into {@link DAYS}.
 *
 * Monday-first, which is what the week the forecast folds on actually starts
 * on: the ISO week, the weekly usage reset and every "next Monday" this module
 * dates all agree, and a Sunday-first grid put the odd day out at the front.
 * The buckets stay Sunday-indexed — only the columns are permuted, so
 * `cellTitle(cell, day, hour)` still takes the *data* index.
 */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

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

/**
 * Trusted buckets at which the profile's shape stops moving much.
 *
 * Mirrors `TRUSTED_OK` in `server/lib/usage-forecast.ts`. Duplicated rather
 * than sent over the wire because it is a constant of the model, not a runtime
 * value — but it does mean the two must move together.
 */
const TRUSTED_OK = 120;

/**
 * The three confidence sentences, owned here so the headline and the drawer
 * cannot drift apart. Verbatim from the legend line they used to render as.
 */
const CONFIDENCE_TEXT: Record<ForecastConfidence, string> = {
  none: 'no learned hours yet — the forecast is still the flat-rate one',
  thin: 'thin — expected for the first couple of weeks; the shape is still moving',
  ok: 'enough evidence to lead with'
};

/**
 * The tab's headline — the trust verdict, before any figure.
 *
 * The verdict leads and the crossing time follows it, because the crossing is a
 * *number* and whether to believe it is the question. Exhaustive over the union
 * with no `default`: a fourth confidence value must fail typecheck rather than
 * fall through to a verdict that is wrong about it.
 */
export function forecastHeadline(confidence: ForecastConfidence): string {
  switch (confidence) {
    case 'none': return 'Still the flat-rate forecast';
    case 'thin': return 'The forecast is learning your week';
    case 'ok': return 'The forecast is running on your week';
  }
}

/**
 * The 100% answer, as one lowercase clause to sit beside the headline — or
 * null when there is nothing to say.
 *
 * `null` whenever the walk is empty, *including* when `exhaustAt` is set: that
 * combination should not reach the client, and timing a crossing for a walk
 * that does not exist is the one wrong answer here. The walk panel's
 * `absentText` already says why there is no projection.
 */
export function forecastTiming(walk: ForecastStep[], exhaustAt: string | null): string | null {
  if (walk.length === 0) return null;
  if (exhaustAt === null) return 'the week coasts to the reset';
  if (Number.isNaN(new Date(exhaustAt).getTime())) return null;
  return `the week hits 100% ${fmtWalkHour(exhaustAt)}`;
}

/** The seven terms the inspector's `How to read this` drawer defines, in order. */
export type ProfileTerm =
  'cell' | 'weight' | 'evidence' | 'confidence' | 'ink' | 'ceiling' | 'walk';

/**
 * Every definition the tab makes, in one place.
 *
 * A **builder** rather than a constant like `RATES_GLOSSARY`, because two of
 * the seven quote a live number: the weekly mean the forecast falls back to.
 * Formatted the way the legend formats it, so the drawer and the legend cannot
 * print two different means. The two constants — the trust floor and the
 * chart's ceiling — are read from the modules that own them, never re-typed.
 */
export function profileGlossary(
  globalMean: number
): readonly { key: ProfileTerm; term: string; text: string }[] {
  const mean = `${Math.round(globalMean * 100)}%`;
  return [
    {
      key: 'cell',
      term: 'Hour of the week',
      text: 'A cell is one hour of the week: Monday 09:00 is a different cell from '
        + 'Tuesday 09:00, and nothing is averaged across days. What accumulates across '
        + 'weeks is the evidence — a cell can gather at most 60 minutes per week.'
    },
    {
      key: 'weight',
      term: 'Weight',
      text: 'The share of that hour you are typically active, 0–1; the forecast '
        + "multiplies the hour's burn rate by it. An empty cell is a measured idle "
        + 'hour, which is a different statement from a low weight — and different again '
        + `from no evidence, which falls back to the ${mean} weekly mean.`
    },
    {
      key: 'evidence',
      term: 'Evidence, and the two gates',
      text: `An hour needs ${TRUST_FLOOR_MIN} minutes of observed time and one week `
        + 'roll-over to fold before its weight is used. Until both fall the cell is '
        + 'hatched and the forecast uses the weekly mean instead, so an hour can be past '
        + 'the floor and still blank for up to a week.'
    },
    {
      key: 'confidence',
      term: 'Confidence',
      text: `none — ${CONFIDENCE_TEXT.none}. ${CONFIDENCE_TEXT.thin}. `
        + `ok — ${CONFIDENCE_TEXT.ok}, at ${TRUSTED_OK} of 168 hours carrying a weight.`
    },
    {
      key: 'ink',
      term: 'Solid vs dashed',
      text: 'Solid hours are walked with a measured weight; dashed hours have no evidence '
        + `for that hour of the week yet and fall back to the ${mean} weekly mean — the `
        + 'same height, a weaker claim.'
    },
    {
      key: 'ceiling',
      term: 'The 100% ceiling',
      text: `The scale stops at ${Y_MAX}%: past the ceiling everything is equally over, so `
        + 'the curve is not auto-scaled to its endpoint. The red rule is 100% of the '
        + 'weekly window, and the vertical line is where the walk crosses it.'
    },
    {
      key: 'walk',
      term: 'The walk',
      text: 'The same forward walk that produced the weekly projection in the header, hour '
        + 'by hour from now to the weekly reset. Re-run by the endpoint rather than '
        + 'from a second derivation, so the inspector cannot disagree with the number it '
        + 'explains.'
    }
  ];
}

/** The definition behind one ⓘ — the same string the drawer prints. */
export function profileTip(key: ProfileTerm, globalMean: number): string {
  return profileGlossary(globalMean).find(g => g.key === key)!.text;
}
