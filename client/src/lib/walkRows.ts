import type { ForecastStep } from '../../../shared/types';

import { fmtWalkHour, headroomOf } from './walkChart';

/**
 * walkRows.ts — the same forward walk the chart draws, folded into day rows.
 *
 * The sheet prints the curve and this table from **one** array, so the picture
 * and the rows cannot disagree; everything here is arithmetic over `walk`, with
 * no second derivation and no second fetch. The chart answers "when", the rows
 * answer "out of what" — how many hours each day contributes, how many of them
 * the profile expects to be worked, and whether that day's weights were
 * measured or the weekly mean standing in.
 *
 * **Slices, not hours.** The walk's first entry covers only the rest of the
 * current clock hour and its last only the part of an hour before the reset, so
 * a row's `hours` is the summed slice length rather than a count of entries.
 * That is why `resetsAt` is a parameter: without it the final slice has no end,
 * and the duty cycle of the last day would be computed over a full hour that
 * does not exist.
 */

/** One local day of the walk. */
export interface WalkDayRow {
  /** Local date key — stable across a DST day, unlike an hour count. */
  key: string;
  /** `Wed`, the day's own label. */
  label: string;
  /** True for the row the walk starts in — it is a part-day. */
  isNow: boolean;
  /** Hours of window this row covers. Fractional on the first and last rows. */
  hours: number;
  /** Of those, how many the profile expects to be active: Σ weight × hours. */
  activeHours: number;
  /** Slices walked on a measured weight, and slices in the row. */
  learned: number;
  slices: number;
  /** Window points this day is expected to spend. */
  spent: number;
  /** Points of the weekly window left at the end of the day. Negative past empty. */
  endHead: number;
  /** Local hour label of the crossing, when it falls inside this day. */
  crossesAt: string | null;
}

/** The `To the reset` row: the same columns, over the whole walk. */
export interface WalkTotals {
  hours: number;
  activeHours: number;
  learned: number;
  slices: number;
  spent: number;
  endHead: number;
  /** Hours of the walk that fall wholly after the crossing hour. 0 without one. */
  unpayableHours: number;
  /**
   * Whether the walk crossed at all. Its own flag rather than
   * `unpayableHours > 0`, which is a different question: a crossing inside the
   * *last* slice leaves no whole hour after it, so the counter stays 0 while
   * the window is nonetheless empty before the reset. Stamped from the same
   * condition as a row's `crossesAt`, so the rows, the `endHead` cell and the
   * totals caption cannot disagree.
   */
  crossed: boolean;
}

export interface WalkTable {
  rows: WalkDayRow[];
  totals: WalkTotals;
  /** Headroom at `now` — the bar column's denominator, so it drains from full. */
  startHead: number;
}

const HOUR_MS = 3_600_000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Fold the walk into one row per local day.
 *
 * `startHead` is `100 − utilization`, the headroom the first slice starts from;
 * it comes from the response rather than from `walk[0]`, which already has one
 * slice spent out of it.
 */
export function walkRows(
  walk: ForecastStep[],
  opts: { resetsAt: string | null; startHead: number }
): WalkTable {
  const empty: WalkTable = {
    rows: [],
    totals: {
      hours: 0, activeHours: 0, learned: 0, slices: 0, spent: 0,
      endHead: opts.startHead, unpayableHours: 0, crossed: false
    },
    startHead: opts.startHead
  };
  if (walk.length === 0) return empty;

  const endMs = opts.resetsAt ? Date.parse(opts.resetsAt) : Number.NaN;
  const rows: WalkDayRow[] = [];
  const byKey = new Map<string, WalkDayRow>();
  let crossed = false;
  let unpayable = 0;

  for (let i = 0; i < walk.length; i++) {
    const d = new Date(walk[i].t);
    // The last slice runs to the reset. With no reset to run to it is assumed
    // whole — one hour long, the length every other tail slice has.
    const next = i + 1 < walk.length
      ? Date.parse(walk[i + 1].t)
      : (Number.isFinite(endMs) ? endMs : d.getTime() + HOUR_MS);
    const hours = Math.max(0, (next - d.getTime()) / HOUR_MS);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

    let row = byKey.get(key);
    if (row === undefined) {
      row = {
        key,
        label: DAYS[d.getDay()],
        isNow: rows.length === 0,
        hours: 0,
        activeHours: 0,
        learned: 0,
        slices: 0,
        spent: 0,
        endHead: 0,
        crossesAt: null
      };
      byKey.set(key, row);
      rows.push(row);
    }

    row.hours += hours;
    row.activeHours += walk[i].weight * hours;
    row.slices += 1;
    if (walk[i].learned) row.learned += 1;
    row.spent += walk[i].gain;
    row.endHead = headroomOf(walk[i]);

    // Counted *before* the crossing is stamped, so the hour the window goes
    // empty is not itself called unpayable: part of it is paid for, and the
    // crossing time beside it already says where inside the hour that ran out.
    if (crossed) unpayable += hours;
    if (!crossed && walk[i].cum >= 100) {
      crossed = true;
      row.crossesAt = fmtWalkHour(walk[i].t);
    }
  }

  const last = rows[rows.length - 1];
  return {
    rows,
    totals: {
      hours: rows.reduce((n, r) => n + r.hours, 0),
      activeHours: rows.reduce((n, r) => n + r.activeHours, 0),
      learned: rows.reduce((n, r) => n + r.learned, 0),
      slices: rows.reduce((n, r) => n + r.slices, 0),
      spent: rows.reduce((n, r) => n + r.spent, 0),
      endHead: last.endHead,
      unpayableHours: unpayable,
      crossed
    },
    startHead: opts.startHead
  };
}

/**
 * Where a row's weights came from, in the reader's terms.
 *
 * Three states rather than a percentage: what the column answers is whether to
 * believe the row, and "measured, then the mean" is the honest answer for every
 * mix — the split within a day is the heatmap's business, not this table's.
 */
export function weightSource(row: { learned: number; slices: number }, globalMean: number): string {
  if (row.slices === 0) return '—';
  if (row.learned === row.slices) return 'measured weights';
  if (row.learned === 0) return `weekly mean ${globalMean.toFixed(2)}`;
  return 'measured, then the mean';
}

/**
 * How full the day's bar is: the headroom left at the end of it, against the
 * headroom the walk started with. Drains from full to empty, like the curve.
 */
export function headBarPct(endHead: number, startHead: number): number {
  if (!(startHead > 0)) return 0;
  return Math.min(100, Math.max(0, (endHead / startHead) * 100));
}
