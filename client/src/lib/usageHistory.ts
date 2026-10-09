import type { UsageHistoryPoint, UsageHistoryResponse, UsageHistoryWindow } from '../../../shared/types';

/**
 * usageHistory.ts — pure helpers for the Usage → History view: the coverage figure, the figure strip and the weekly-fill rows.
 *
 * Held, never interpolated: the log is write-on-change, so between two lines the reading stayed where the earlier one left it, and a straight line
 * across a quiet heartbeat stretch would draw a ramp that never happened (docs/subsystems/usage-limits.md §The history view).
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** A day that gained less than this many points of the week is not drawn. */
export const MIN_GAIN_PCT = 0.3;
/** Unrecorded time under this is not worth marking on a day. */
export const OFF_MIN_MS = 3_600_000;

/** Percent of the range that was recorded, as an integer; 0 for an empty range. */
export function coveragePct(resp: UsageHistoryResponse): number {
  const span = resp.nowT - resp.sinceT;
  if (span <= 0) return 0;
  const missing = resp.gaps.reduce((sum, gap) => sum + (gap.toT - gap.fromT), 0);
  return Math.round(100 * (1 - missing / span));
}

export interface HistoryFigures {
  /** Recorded share of the range, percent. */
  coverage: number;
  /** 5-hour windows in range. */
  windows: number;
  /** 5-hour windows that reached 100%. */
  atLimit: number;
  /** Highest weekly reading in range; null when no weekly window was recorded — never a fabricated 0. */
  weeklyPeak: number | null;
}

/** The four figures the strip above the chart prints. */
export function historyFigures(resp: UsageHistoryResponse): HistoryFigures {
  return {
    coverage: coveragePct(resp),
    windows: resp.fiveHour.length,
    atLimit: resp.fiveHour.filter(w => w.peakPct >= 100).length,
    weeklyPeak: resp.weekly.length === 0 ? null : Math.max(...resp.weekly.map(w => w.peakPct))
  };
}

export interface WeekDay {
  /** Segment start: the row's `firstT`, or a local midnight. */
  fromT: number;
  /** Next local midnight, or the row's end. */
  toT: number;
  /** Reading held at `fromT`. */
  fromPct: number;
  /** Reading held at `toT`. */
  toPct: number;
  /**
   * Unrecorded ms between the last reading at or before `fromT` and `toT`, summed over the gaps the reading rose across (by at least {@link MIN_GAIN_PCT},
   * on a reading taken inside this day) — a gap it did not rise across is the server being off, not use that went unseen. 0 when under {@link OFF_MIN_MS}.
   */
  offMs: number;
}

export interface WeekRow {
  /** `resetsAt`, or `unscoped-<firstT>` for a window the endpoint reported without one. */
  key: string;
  /** `Date.parse(resetsAt)`; null when unscoped. */
  resetsAtMs: number | null;
  /** The previous weekly window's reset; null for the oldest window or an unscoped one. Observed, never `resetsAt` minus 7 days. */
  startT: number | null;
  firstT: number;
  /** The window has not reset yet. */
  current: boolean;
  /** The first reading's pct — what the week had spent before this row's data; 0 when under {@link MIN_GAIN_PCT}. */
  prePct: number;
  /** Why the row opens part-filled: `range` when the range opened on it, `recording` when the first reading came late. */
  preCause: 'range' | 'recording';
  /** Chronological; days that gained under {@link MIN_GAIN_PCT} dropped. */
  days: WeekDay[];
  peakPct: number;
  /** 5-hour windows that reached 100% and opened inside this week. */
  limitHits: number;
}

/**
 * One row per weekly window, newest first, each filled day by day: a day runs from the row's first reading or a local midnight to the next midnight
 * or the row's end, holding each reading until the next. `offsetMinutes` is minutes east of UTC, held for the whole range — the convention of `localOffsetMinutes` in server/lib/usage-forecast.ts.
 */
export function weekRows(resp: UsageHistoryResponse, offsetMinutes: number): WeekRow[] {
  const offsetMs = offsetMinutes * MINUTE_MS;
  const sorted = [...resp.weekly].sort((a, b) => a.firstT - b.firstT);
  const resets = sorted.map(wk => (wk.resetsAt === null ? null : Date.parse(wk.resetsAt)));
  const rows = sorted.map((wk, i): WeekRow => {
    const resetsAtMs = resets[i];
    const startT = i > 0 ? resets[i - 1] : null;
    const points = wk.segments.flat();
    /** The last reading at or before `t`; the first when `t` precedes them all. */
    const lastPoint = (t: number): UsageHistoryPoint | undefined => {
      let hit = points[0];
      for (const p of points) { if (p.t > t) break; hit = p; }
      return hit;
    };
    const held = (t: number): number => lastPoint(t)?.pct ?? 0;
    const lastRead = (t: number): number => {
      const p = lastPoint(t);
      return p !== undefined && p.t <= t ? p.t : wk.firstT;
    };
    const end = Math.min(resetsAtMs ?? wk.lastT, resp.nowT);
    const bounds = [wk.firstT];
    for (let t = Math.floor((wk.firstT + offsetMs) / DAY_MS + 1) * DAY_MS - offsetMs; t < end; t += DAY_MS) {
      if (t > wk.firstT) bounds.push(t);
    }
    bounds.push(end);
    const days: WeekDay[] = [];
    for (let d = 0; d < bounds.length - 1; d++) {
      const fromT = bounds[d], toT = bounds[d + 1];
      const fromPct = held(fromT), toPct = held(toT);
      if (toPct - fromPct < MIN_GAIN_PCT) continue;
      const from = lastRead(fromT);
      const off = resp.gaps.reduce((sum, g) => {
        const overlap = Math.min(g.toT, toT) - Math.max(g.fromT, from);
        if (overlap <= 0) return sum;
        const after = points.find(pt => pt.t >= g.toT);
        return after !== undefined && after.t <= toT && after.pct - held(g.fromT) >= MIN_GAIN_PCT ? sum + overlap : sum;
      }, 0);
      days.push({ fromT, toT, fromPct, toPct, offMs: off >= OFF_MIN_MS ? off : 0 });
    }
    const first = held(wk.firstT);
    const limitHits = resp.fiveHour.filter(f =>
      f.peakPct >= 100 && f.firstT >= (startT ?? wk.firstT) && f.firstT < (resetsAtMs ?? wk.lastT)).length;
    return {
      key: wk.resetsAt ?? `unscoped-${wk.firstT}`,
      resetsAtMs,
      startT,
      firstT: wk.firstT,
      current: resetsAtMs !== null && resetsAtMs > resp.nowT,
      prePct: first >= MIN_GAIN_PCT ? first : 0,
      preCause: wk.firstT - resp.sinceT <= 2 * resp.bucketMs ? 'range' : 'recording',
      days,
      peakPct: wk.peakPct,
      limitHits
    };
  });
  return rows.reverse();
}
