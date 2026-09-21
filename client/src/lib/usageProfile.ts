import type { ForecastConfidence, ForecastStep, UsageProfileCell } from '../../../shared/types';
import { fmtWalkHour } from './walkChart';

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
 * trust floor, the debt cap, the trusted-hour gate) drifts the moment it
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
      term: 'Empty, and what is borrowed past it',
      text: 'The rule is an empty weekly window. Above it the curve is what is left to '
        + 'spend; below it, the gap between the rule and the line is work the window '
        + 'cannot pay for — red where the weights are measured, amber and hatched where '
        + 'the walk is guessing. The band below the rule stops at the height of the '
        + 'headroom above it: past that everything is equally over, so a week that ends '
        + '190 points short is not allowed to squash the drain into a sliver.'
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

/**
 * One cell of a page's figure strip: a label, the figure, a line of evidence
 * under it.
 *
 * Data, not JSX, so the five forecast figures and the five token-value ones are
 * both testable and both drawn by the same component. `term` is the glossary key
 * whose ⓘ belongs beside the label — the strip never writes its own definition.
 */
export interface StatTile {
  key: string;
  label: string;
  /** The figure itself. `—` whenever the input is missing; never a fabricated 0. */
  value: string;
  /** A quieter suffix inside the figure, e.g. the ` / 168` of an out-of count. */
  unit?: string;
  /** The evidence line. Empty string prints nothing. */
  sub: string;
  /** Draws the figure in the attention colour. */
  warn?: boolean;
  term?: ProfileTerm;
}

/** `2d 4h`, `5h 10m`, `just now` — the distance to a timestamp, at two units. */
export function fmtUntil(fromMs: number, toMs: number): string {
  const min = Math.round((toMs - fromMs) / 60_000);
  if (!Number.isFinite(min) || min <= 0) return 'now';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** `11 Sep` — a date without the year, which the reader supplies. */
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Whole hours, rounded — the unit every figure on the forecast strip counts in. */
function hrs(n: number): string {
  return String(Math.round(n));
}

/**
 * The forecast page's five figures, in reading order: where the window stands,
 * when it runs out, how hard the rest of it is expected to be worked, how much
 * of the week has been observed, and whether to believe any of it.
 *
 * The utilization figure warns from 80 points rather than at the projection,
 * because the two say different things: one is measured and one is a forecast,
 * and marking the measured figure with the forecast's verdict would make a quiet
 * week look spent. The crossing warns whenever there *is* a crossing — that one
 * is the forecast, and its existence is the finding.
 *
 * `hasWalk` separates the two meanings a null `exhaustAt` used to carry. The
 * server sends null both for "the walk was run and never crossed" and for "no
 * walk could be run at all" (`walkAbsent`, `api.ts`), and only the first of
 * those licenses the claim that the week coasts to its reset — the second is
 * the absence of evidence, which the tile has to print as a dash like every
 * other unmeasured figure on the strip.
 */
export function forecastStats(opts: {
  utilizationPct: number | null;
  resetsAt: string | null;
  exhaustAt: string | null;
  dutyCycle: number | null;
  /** Hours of window left to walk, and how many of them are expected to be active. */
  hoursLeft: number;
  activeHours: number;
  /** Whether a walk was run at all. False = nothing to project from. */
  hasWalk: boolean;
  progress: ProfileProgress;
  confidence: ForecastConfidence;
  nowMs: number;
}): StatTile[] {
  const { utilizationPct, resetsAt, exhaustAt, dutyCycle, hasWalk, progress, confidence, nowMs } = opts;
  const resetMs = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const crossMs = exhaustAt ? Date.parse(exhaustAt) : Number.NaN;

  return [
    {
      key: 'window',
      label: 'Weekly window',
      value: utilizationPct === null ? '—' : `${Math.round(utilizationPct)}%`,
      sub: Number.isFinite(resetMs) ? `resets ${fmtWalkHour(new Date(resetMs).toISOString())}` : '',
      warn: utilizationPct !== null && utilizationPct >= 80
    },
    {
      key: 'crossing',
      label: 'Projected crossing',
      value: !hasWalk ? '—' : Number.isFinite(crossMs) ? fmtWalkHour(new Date(crossMs).toISOString()) : 'none',
      sub: !hasWalk
        ? 'nothing to project from'
        : Number.isFinite(crossMs)
          ? `${fmtDay(crossMs)} · ${fmtUntil(nowMs, crossMs)} from now`
          : 'the week coasts to its reset',
      warn: hasWalk && Number.isFinite(crossMs)
    },
    {
      key: 'duty',
      label: 'Duty cycle, hours left',
      value: dutyCycle === null ? '—' : `${Math.round(dutyCycle * 100)}%`,
      sub: opts.hoursLeft > 0
        ? `${hrs(opts.activeHours)} of ${hrs(opts.hoursLeft)} hours worked`
        : ''
    },
    {
      key: 'observed',
      label: 'Hours observed',
      value: String(progress.touched),
      unit: ' / 168',
      sub: `${fmtObserved(progress.totalMin)} recorded`
    },
    {
      key: 'confidence',
      label: 'Confidence',
      value: confidence,
      term: 'confidence',
      sub: `${progress.trusted} carrying a weight · ${progress.atFloor} at the floor`,
      warn: confidence !== 'ok'
    }
  ];
}
