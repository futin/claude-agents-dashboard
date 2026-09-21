import type { ForecastStep, UsageProfileCell, UsageProfileResponse } from '../../../shared/types';

/**
 * walkChart.ts — the pure geometry behind the forward walk, drawn as headroom.
 *
 * Everything with arithmetic in it lives here so it can be unit-tested without
 * a DOM; the component that draws the chart ends up with no arithmetic of its
 * own. That split is not tidiness — this chart's defects have all been geometry
 * (per-element device-pixel rounding, an encoding that contradicted the
 * heatmap, a y value nobody could check), and geometry that only exists inside
 * JSX cannot be pinned by a test.
 *
 * The coordinate space is one `viewBox` of `walkWidth(n) × VIEW_H` user units,
 * drawn with `preserveAspectRatio="none"` and `vector-effect: non-scaling-stroke`
 * on every stroked element. That combination is what *structurally* removes the
 * ±1px painted-width unevenness the old flexbox bar strip had: the whole chart
 * becomes one uniform scale of a single coordinate space instead of 118
 * independently rounded boxes.
 *
 * **y is what is left, not what is spent.** The curve plots `100 − cum` — the
 * points of the weekly window still to spend — so it drains from the headroom
 * you have now to empty at the crossing, and keeps going negative after it. The
 * question the panel exists to answer is "when does the window run out", and a
 * draining line puts that answer where the curve meets a rule at zero rather
 * than at an intersection with a ceiling drawn somewhere up in the box. The gap
 * between the zero rule and the line past the crossing is then a quantity in its
 * own right: the work the window cannot pay for.
 */

/** Chart height in user units. Arbitrary, and never seen: the SVG stretches. */
export const VIEW_H = 100;

/**
 * How much of the plot the debt band may take, as a share of the headroom above
 * it, and the floor that keeps a shallow deficit from collapsing to a hairline.
 *
 * The cap is the old `Y_MAX` argument in its natural place: a walk that ends 195
 * points short would otherwise squash the whole drain into the top eighth of the
 * box, and every deficit past "the rest of the week, unpayable" is equally over.
 * Past the cap the line clamps to the floor of the plot and {@link headroomScale}
 * says so in `clamped`, which the chart prints rather than quietly flattening.
 */
export const DEBT_CAP = 1;
export const DEBT_FLOOR = 0.12;

export interface Pt { x: number; y: number }

/** The y domain, in window points. `hi` is above the curve, `lo` at or below 0. */
export interface HeadScale {
  /** Top of the domain — the headroom at `now`, plus a little air. */
  hi: number;
  /** Bottom: 0 when the walk never crosses, else the (capped) deepest deficit. */
  lo: number;
  /** True when the deficit ran past {@link DEBT_CAP} and the line sits on the floor. */
  clamped: boolean;
}

/**
 * One stretch of the curve that is all one side of zero and all one evidence
 * state — the four combinations the chart draws differently.
 */
export interface HeadSeg {
  /** True below the zero rule: points borrowed against a window that is empty. */
  below: boolean;
  /** True = measured weights (drawn solid); false = the fallback (dashed). */
  learned: boolean;
  /**
   * The segment's points, plus the first point of the *next* segment so the
   * line has no gap where the encoding changes. A single `<polyline>` cannot be
   * half dashed, which is the entire reason this splitter exists.
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

/** Points of the weekly window still to spend after a step. Negative past empty. */
export function headroomOf(step: ForecastStep): number {
  return 100 - step.cum;
}

/** The deepest the walk goes past empty, in points. 0 when it never crosses. */
export function maxDebt(walk: ForecastStep[]): number {
  let worst = 0;
  for (const s of walk) worst = Math.max(worst, -headroomOf(s));
  return worst;
}

/**
 * The y domain for one walk.
 *
 * `startHead` is the headroom at `now` — `100 − utilization`, which the response
 * reports directly. It is passed in rather than recovered from `walk[0]` because
 * the first plotted point is the state *after* the first slice, and the label on
 * the top of the axis is a claim about the present.
 *
 * The top of the domain is that figure plus 6% of air, so the curve starts just
 * under the top edge of the plot in every week rather than at a height that
 * varies with how much of the window is already gone. The bottom is the deficit,
 * capped at the headroom above it — see {@link DEBT_CAP}.
 */
export function headroomScale(walk: ForecastStep[], startHead: number): HeadScale {
  const hiRaw = Math.max(Number.isFinite(startHead) ? startHead : 0, 1);
  const debt = maxDebt(walk);
  if (debt <= 0) return { hi: hiRaw * 1.06, lo: 0, clamped: false };
  const band = Math.min(Math.max(debt, hiRaw * DEBT_FLOOR), hiRaw * DEBT_CAP);
  return { hi: hiRaw * 1.06, lo: -band, clamped: debt > hiRaw * DEBT_CAP };
}

/**
 * y for a headroom value, clamped into the scale's own domain.
 *
 * Non-increasing in `head`, never NaN, never outside `0 … VIEW_H` — the three
 * properties a fill height and a `<polyline>` both depend on.
 */
export function yHead(head: number, s: HeadScale): number {
  if (!Number.isFinite(head)) return VIEW_H;
  const span = s.hi - s.lo;
  if (!(span > 0)) return VIEW_H;
  const clamped = Math.min(Math.max(head, s.lo), s.hi);
  return VIEW_H - ((clamped - s.lo) / span) * VIEW_H;
}

/** y of the zero rule — empty window — in chart units. */
export function zeroY(s: HeadScale): number {
  return yHead(0, s);
}

/**
 * Split the walk into segments of constant (side of zero, evidence state).
 *
 * A synthetic point is inserted at the crossing so the line meets the zero rule
 * exactly where {@link crossingX} says it does, rather than stepping across it
 * at whichever hour happened to be sampled — the rule, the dot, the tag and the
 * fill boundary then all sit on one x by construction.
 *
 * Adjacent segments share their boundary point: a segment ends on the first
 * point of the segment after it, so the halves meet rather than leaving a
 * one-hour hole at every transition.
 */
export function headSegments(walk: ForecastStep[], s: HeadScale): HeadSeg[] {
  if (walk.length === 0) return [];
  type Node = { x: number; y: number; below: boolean; learned: boolean };
  const nodes: Node[] = [];
  const cross = crossingX(walk);
  // The crossing hour's own evidence state: the zero point belongs to the
  // segment that leaves it, and that segment is walked with this hour's weight.
  const crossLearned = cross === null
    ? true
    : (walk[Math.min(Math.ceil(cross), walk.length - 1)] ?? walk[walk.length - 1]).learned;

  // `below: true` on the synthetic node is what makes the crossing the *start*
  // of the deficit rather than a point inside the headroom run: with the
  // shared-boundary convention below, the last point of the run above the rule
  // is then exactly the rule, and every millimetre under it is drawn in the
  // deficit's ink.
  for (let i = 0; i < walk.length; i++) {
    if (cross !== null && cross < i && !nodes.some((n) => n.x === cross)) {
      nodes.push({ x: cross, y: zeroY(s), below: true, learned: crossLearned });
    }
    const head = headroomOf(walk[i]);
    nodes.push({ x: i, y: yHead(head, s), below: head < 0, learned: walk[i].learned });
  }
  nodes.sort((a, b) => a.x - b.x);

  const key = (n: Node) => `${n.below ? 'd' : 'u'}|${n.learned}`;
  const segs: HeadSeg[] = [];
  let start = 0;
  for (let i = 1; i <= nodes.length; i++) {
    if (i === nodes.length || key(nodes[i]) !== key(nodes[start])) {
      // `i` is one past the segment; including its point (when there is one) is
      // the shared boundary that closes the gap.
      const end = Math.min(i, nodes.length - 1);
      segs.push({
        below: nodes[start].below,
        learned: nodes[start].learned,
        points: nodes.slice(start, end + 1).map((n) => ({ x: n.x, y: n.y }))
      });
      start = i;
    }
  }
  return segs;
}

/**
 * Every point of the segments on one side of the rule, in order and with the
 * shared boundaries deduped.
 *
 * The fill above the rule is one shape, not one per evidence run: only the
 * *line* changes ink where the evidence does, and painting the headroom as
 * abutting fills leaves a hairline seam at every flip. `cum` never decreases,
 * so the above-zero part is always a prefix and this concatenation is always
 * contiguous.
 */
export function joinPoints(segs: HeadSeg[]): Pt[] {
  const out: Pt[] = [];
  for (const seg of segs) {
    for (const p of seg.points) {
      const last = out[out.length - 1];
      if (last !== undefined && last.x === p.x && last.y === p.y) continue;
      out.push(p);
    }
  }
  return out;
}

/** `"x,y x,y …"` for a `<polyline>`, rounded so the attribute stays readable. */
export function pointsAttr(points: Pt[]): string {
  return points.map((p) => `${round3(p.x)},${round3(p.y)}`).join(' ');
}

/**
 * One segment closed to the zero rule — the area between the line and empty.
 *
 * Only the gap, not the column of time under it: above the rule this is the
 * headroom still to spend, below it the deficit itself, which is the quantity
 * the reader is being shown.
 */
export function segAreaPath(points: Pt[], s: HeadScale): string {
  if (points.length === 0) return '';
  const zero = round3(zeroY(s));
  const first = points[0], last = points[points.length - 1];
  const body = points.map((p) => `L${round3(p.x)},${round3(p.y)}`).join('');
  return `M${round3(first.x)},${zero}${body}L${round3(last.x)},${zero}Z`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * x where the curve crosses empty, or null when it never does.
 *
 * Interpolated inside the crossing hour with the same arithmetic the server
 * used for `exhaustAt` — from `cum` and `gain`, never from a parsed timestamp,
 * so the rule cannot drift away from the label beside it.
 */
export function crossingX(walk: ForecastStep[]): number | null {
  for (let i = 0; i < walk.length; i++) {
    if (walk[i].cum < 100) continue;
    // The first drawn point is already at or past empty — there is no segment to
    // the left of it to interpolate along, so the rule sits on it.
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
 * Shaped like the heatmap's `cellTitle` on purpose — the two halves of the page
 * should read as one language. Two lines are load-bearing: the headroom, which
 * is what the curve's height actually is, and the evidence line, which says
 * **assumed** where the weight is the fallback — a fallback 1.0 and a measured
 * 1.0 are the same number and completely different statements.
 */
export function stepTitle(step: ForecastStep, cell: UsageProfileCell | undefined): string {
  const pct = `${Math.round(step.weight * 100)}%`;
  const head = headroomOf(step);
  const lines = [
    fmtWalkHour(step.t),
    `−${step.gain.toFixed(1)} pts this hour`,
    head >= 0
      ? `${head.toFixed(1)} pts left`
      : `${(-head).toFixed(1)} pts past empty`
  ];
  if (!step.learned) {
    lines.push(`weight ${pct} — assumed (no evidence)`);
  } else {
    const weeks = Math.round((cell?.observedMin ?? 0) / 60);
    lines.push(`weight ${pct} — measured, ${weeks === 1 ? '1 week' : `${weeks} weeks`}`);
  }
  return lines.join('\n');
}

/** Why there is no walk to draw. One sentence, never an unmounted section. */
export function absentText(reason: NonNullable<UsageProfileResponse['walkAbsent']>): string {
  switch (reason) {
    case 'recording-off':
      return 'Nothing to walk: usage recording is off, so there is no profile to project through.';
    case 'no-rate':
      return 'No current burn rate — nothing to project from yet. The walk returns once this ' +
        'account starts spending again.';
    case 'no-window':
      return 'No weekly window to project into: the account limits have not been read yet.';
  }
}
