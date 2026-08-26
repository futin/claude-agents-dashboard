import type { ForecastStep, UsageProfileCell, UsageProfileResponse } from '../../../shared/types';

/**
 * walkChart.ts — the pure geometry behind the forward-walk strip.
 *
 * Everything with arithmetic in it lives here so it can be unit-tested without
 * a DOM; the component that draws the strip ends up with no arithmetic of its
 * own. That split is not tidiness — the previous strip's defects were all
 * geometry (per-element device-pixel rounding, an encoding that contradicted
 * the heatmap, a y value nobody could check), and geometry that only exists
 * inside JSX cannot be pinned by a test.
 *
 * The coordinate space is one `viewBox` of `WALK_W(n) × VIEW_H` user units,
 * drawn with `preserveAspectRatio="none"` and `vector-effect: non-scaling-stroke`
 * on every stroked element. That combination is what *structurally* removes the
 * ±1px painted-width unevenness the flexbox bar strip had: the whole chart
 * becomes one uniform scale of a single coordinate space instead of 118
 * independently rounded boxes.
 *
 * One point per walked step, x = the step's index. The point's y is the
 * *cumulative* window percentage after that hour — the fourth column of the
 * walk, not the per-hour gain. The panel exists to answer "when does the weekly
 * window hit 100%", and a cumulative curve puts that answer at an intersection
 * rather than asking the reader to integrate 117 bars.
 */

/** Chart height in user units. Arbitrary, and never seen: the SVG stretches. */
export const VIEW_H = 100;

/**
 * Top of the y domain, in window percent.
 *
 * Fixed rather than scaled to the walk's endpoint. A walk that ends at 294.7%
 * would squash the 100% rule into the bottom third of the box and make two
 * different weeks look like different charts; and every value above 100% is
 * equally "over", so there is nothing gained by resolving them.
 */
export const Y_MAX = 130;

export interface Pt { x: number; y: number }

/** A stretch of consecutive steps that share a `learned` value. */
export interface WalkRun {
  /** True = measured weights (drawn solid); false = the fallback (dashed). */
  learned: boolean;
  /**
   * The run's points, plus the first point of the *next* run so the line has no
   * gap where the encoding changes. A single `<polyline>` cannot be half
   * dashed, which is the entire reason this splitter exists.
   */
  points: Pt[];
}

export interface WalkTick {
  x: number;
  label: string;
  kind: 'now' | 'day';
}

/** Width of the chart's coordinate space for `n` steps. Never 0. */
export function walkWidth(n: number): number {
  return Math.max(n - 1, 1);
}

/**
 * The full-height hit target for step `i`: a column centred on its point,
 * clamped to the chart's edges.
 *
 * Full-height and a column rather than a strip along the line, because the
 * target has to be reachable with a thumb — a 2px-tall hit area on a curve is
 * a mouse-only affordance, and this dashboard is read from a phone.
 */
export function hitRect(i: number, n: number): { x: number; w: number } {
  const w = walkWidth(n);
  const left = Math.max(i - 0.5, 0);
  const right = Math.min(i + 0.5, w);
  return { x: left, w: Math.max(right - left, 0) };
}

/** A y in chart units as a percentage of the height — for HTML overlay labels. */
export function pctY(y: number): number {
  return Math.min(Math.max((y / VIEW_H) * 100, 0), 100);
}

/** An x in chart units as a percentage of the width — for HTML overlay labels. */
export function pctX(x: number, n: number): number {
  const w = walkWidth(n);
  return Math.min(Math.max((x / w) * 100, 0), 100);
}

/**
 * y for a cumulative percentage, clamped into `0 … Y_MAX`.
 *
 * Non-increasing in `cum`, never NaN, never outside `0 … VIEW_H` — the three
 * properties a fill height and a `<polyline>` both depend on.
 */
export function yOf(cum: number): number {
  if (!Number.isFinite(cum)) return VIEW_H;
  const clamped = Math.min(Math.max(cum, 0), Y_MAX);
  return VIEW_H - (clamped / Y_MAX) * VIEW_H;
}

/** One point per step: x is the index, y is that hour's cumulative percent. */
export function walkPoints(walk: ForecastStep[]): Pt[] {
  return walk.map((s, i) => ({ x: i, y: yOf(s.cum) }));
}

/**
 * Split the walk into consecutive runs of equal `learned`.
 *
 * Adjacent runs share their boundary point: a run ends on the first point of
 * the run after it, so the solid and dashed halves meet rather than leaving a
 * one-hour hole at every transition.
 */
export function splitRuns(walk: ForecastStep[]): WalkRun[] {
  if (walk.length === 0) return [];
  const pts = walkPoints(walk);
  const runs: WalkRun[] = [];
  let start = 0;
  for (let i = 1; i <= walk.length; i++) {
    if (i === walk.length || walk[i].learned !== walk[start].learned) {
      // `i` is one past the run; including its point (when there is one) is the
      // shared boundary that closes the gap.
      const end = Math.min(i, walk.length - 1);
      runs.push({ learned: walk[start].learned, points: pts.slice(start, end + 1) });
      start = i;
    }
  }
  return runs;
}

/** `"x,y x,y …"` for a `<polyline>`, rounded so the attribute stays readable. */
export function pointsAttr(points: Pt[]): string {
  return points.map((p) => `${round3(p.x)},${round3(p.y)}`).join(' ');
}

/** The same points closed down to the baseline — the area under the curve. */
export function areaPath(points: Pt[]): string {
  if (points.length === 0) return '';
  const first = points[0], last = points[points.length - 1];
  const body = points.map((p) => `L${round3(p.x)},${round3(p.y)}`).join('');
  return `M${round3(first.x)},${VIEW_H}${body}L${round3(last.x)},${VIEW_H}Z`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * x where the curve crosses 100%, or null when it never does.
 *
 * Interpolated inside the crossing hour with the same arithmetic the server
 * used for `exhaustAt` — from `cum` and `gain`, never from a parsed timestamp,
 * so the rule cannot drift away from the label beside it.
 */
export function crossingX(walk: ForecastStep[]): number | null {
  for (let i = 0; i < walk.length; i++) {
    if (walk[i].cum < 100) continue;
    // The first drawn point is already at or over the ceiling — there is no
    // segment to the left of it to interpolate along, so the rule sits on it.
    if (i === 0) return 0;
    const before = walk[i].cum - walk[i].gain;
    // A zero-gain hour cannot be the hour that crossed; the guard is also what
    // keeps the interpolation from dividing by zero.
    if (!(walk[i].gain > 0)) return i - 1;
    const frac = Math.min(Math.max((100 - before) / walk[i].gain, 0), 1);
    return i - 1 + frac;
  }
  return null;
}

/**
 * `now` at the left edge, then one tick per local calendar day in the walk.
 *
 * Keyed on the local *date* changing rather than on the hour reading 00:00. The
 * walk's slices are cut with a single UTC offset held for the whole window (an
 * accepted limitation of `usage-forecast.ts`), so after a DST transition the
 * browser's local hour of a slice drifts by one and a midnight can be missed or
 * seen twice. A date change fires exactly once per day whether that day is 23,
 * 24 or 25 hours long.
 */
export function dayTicks(walk: ForecastStep[]): WalkTick[] {
  if (walk.length === 0) return [];
  const ticks: WalkTick[] = [{ x: 0, label: 'now', kind: 'now' }];
  let prev = dayKey(new Date(walk[0].t));
  for (let i = 1; i < walk.length; i++) {
    const d = new Date(walk[i].t);
    const key = dayKey(d);
    if (key === prev) continue;
    prev = key;
    ticks.push({ x: i, label: DAYS[d.getDay()], kind: 'day' });
  }
  return ticks;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Hour-of-week index for a step's timestamp, in the browser's local time. */
export function hourOfWeekLocal(iso: string): number {
  const d = new Date(iso);
  return d.getDay() * 24 + d.getHours();
}

/** `Thu 14:00` — the walk's own hour label, local time. */
export function fmtWalkHour(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:00`;
}

/**
 * The tooltip for one walked hour.
 *
 * Shaped like the heatmap's `cellTitle` on purpose — the two halves of the card
 * should read as one language. The load-bearing line is the last one: an hour
 * standing on the fallback says **assumed**, because a fallback 1.0 and a
 * measured 1.0 are the same number and completely different statements.
 */
export function stepTitle(step: ForecastStep, cell: UsageProfileCell | undefined): string {
  const pct = `${Math.round(step.weight * 100)}%`;
  const lines = [
    fmtWalkHour(step.t),
    `+${step.gain.toFixed(1)}% this hour`,
    `${Math.round(step.cum)}% consumed`
  ];
  if (!step.learned) {
    lines.push(`weight ${pct} — assumed (no evidence)`);
  } else {
    const weeks = Math.round((cell?.observedMin ?? 0) / 60);
    lines.push(`weight ${pct} — measured, ${weeks === 1 ? '1 week' : `${weeks} weeks`}`);
  }
  if (step.cum >= 100) lines.push('past 100%');
  return lines.join('\n');
}

/** Why there is no walk to draw. One sentence, never an unmounted section. */
export function absentText(reason: NonNullable<UsageProfileResponse['walkAbsent']>): string {
  switch (reason) {
    case 'recording-off':
      return 'Nothing to walk: usage recording is off, so there is no profile to project through.';
    case 'no-rate':
      return 'No current burn rate — nothing to project from yet. The strip returns once this ' +
        'account starts spending again.';
    case 'no-window':
      return 'No weekly window to project into: the account limits have not been read yet.';
  }
}
