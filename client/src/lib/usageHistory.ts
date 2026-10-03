import type { UsageHistoryPoint, UsageHistoryResponse } from '../../../shared/types';

/**
 * usageHistory.ts — pure helpers for the Usage → History view: the step-after path, the coverage figure, the day ticks and the figure strip.
 *
 * Step-after, never linear: the log is write-on-change, so between two lines the reading stayed where the earlier one left it, and a straight line
 * across a quiet heartbeat stretch would draw a ramp that never happened (docs/subsystems/usage-limits.md §The history view).
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** More day ticks than this and the axis keeps Mondays only. */
const MAX_DAY_TICKS = 14;

/** At most two decimals, trailing zeros dropped. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** An SVG path holding each reading flat until the next: `M x0 y0`, then `H xi V yi` per following point. One point is just its `M`. */
export function stepPath(points: UsageHistoryPoint[], x: (t: number) => number, y: (pct: number) => number): string {
  if (points.length === 0) return '';
  let d = `M${num(x(points[0].t))} ${num(y(points[0].pct))}`;
  for (let i = 1; i < points.length; i++) d += `H${num(x(points[i].t))}V${num(y(points[i].pct))}`;
  return d;
}

/** Percent of the range that was recorded, as an integer; 0 for an empty range. */
export function coveragePct(resp: UsageHistoryResponse): number {
  const span = resp.nowT - resp.sinceT;
  if (span <= 0) return 0;
  const missing = resp.gaps.reduce((sum, gap) => sum + (gap.toT - gap.fromT), 0);
  return Math.round(100 * (1 - missing / span));
}

/**
 * Local midnights strictly inside `(sinceT, nowT)`; past {@link MAX_DAY_TICKS} only the Mondays. `offsetMinutes` is minutes east of UTC — the
 * convention of `localOffsetMinutes` in server/lib/usage-forecast.ts — held for the whole range.
 */
export function dayTicks(sinceT: number, nowT: number, offsetMinutes: number): number[] {
  const offsetMs = offsetMinutes * MINUTE_MS;
  const ticks: number[] = [];
  for (let t = Math.floor((sinceT + offsetMs) / DAY_MS + 1) * DAY_MS - offsetMs; t < nowT; t += DAY_MS) {
    if (t > sinceT) ticks.push(t);
  }
  if (ticks.length <= MAX_DAY_TICKS) return ticks;
  return ticks.filter(t => new Date(t + offsetMs).getUTCDay() === 1);
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
