/**
 * usage-history-series.ts — the recorded log turned into drawable 5-hour and weekly series.
 *
 * Pure: no clock, no disk, no settings. `GET /api/usage/history` reads the samples and hands them here. The rules — gap threshold, window identity,
 * downsampling — are explained in docs/subsystems/usage-limits.md §The history view.
 */

import type { UsageHistoryGap, UsageHistoryPoint, UsageHistoryWindow } from '../../shared/types.js';
import { classifyInterval } from './usage-history.js';
import type { UsageSample } from './usage-history.js';

/** The 15-minute heartbeat plus 5 minutes of slack: a longer silence means nothing was recording. */
export const GAP_MS = 1_200_000;
/** Target points per series. */
export const MAX_POINTS = 1440;

const MINUTE_MS = 60_000;

export interface UsageHistorySeries {
  bucketMs: number;
  fiveHour: UsageHistoryWindow[];
  weekly: UsageHistoryWindow[];
  gaps: UsageHistoryGap[];
}

/** Each segment's first and last sample, plus each bucket's highest reading (ties to the latest), in time order. */
function downsample(segment: UsageSample[], sinceMs: number, bucketMs: number): UsageHistoryPoint[] {
  const keep = new Set<number>([0, segment.length - 1]);
  const best = new Map<number, number>();
  segment.forEach((sample, i) => {
    const bucket = Math.floor((sample.t - sinceMs) / bucketMs);
    const held = best.get(bucket);
    if (held === undefined || sample.utilization >= segment[held].utilization) best.set(bucket, i);
  });
  for (const i of best.values()) keep.add(i);
  return [...keep].sort((a, b) => a - b).map(i => ({ t: segment[i].t, pct: segment[i].utilization }));
}

/** Split one series into windows (by `classifyInterval`'s reset rule) and each window into gap-free segments. */
function windowsOf(series: UsageSample[], sinceMs: number, bucketMs: number): UsageHistoryWindow[] {
  const out: UsageHistoryWindow[] = [];
  let window: UsageSample[][] = [];
  const flush = (): void => {
    if (window.length === 0) return;
    const all = window.flat();
    out.push({
      resetsAt: all[0].resetsAt,
      firstT: all[0].t,
      lastT: all[all.length - 1].t,
      peakPct: all.reduce((peak, sample) => Math.max(peak, sample.utilization), -Infinity),
      segments: window.map(segment => downsample(segment, sinceMs, bucketMs))
    });
    window = [];
  };
  let prev: UsageSample | null = null;
  for (const sample of series) {
    if (prev === null || classifyInterval(prev, sample) === 'reset') {
      flush();
      window.push([sample]);
    } else if (sample.t - prev.t > GAP_MS) {
      window.push([sample]);
    } else {
      window[window.length - 1].push(sample);
    }
    prev = sample;
  }
  flush();
  return out;
}

/** Spans inside `[sinceMs, nowMs]` longer than {@link GAP_MS} with no sample — leading, interior and trailing. */
function gapsOf(series: UsageSample[], sinceMs: number, nowMs: number): UsageHistoryGap[] {
  if (series.length === 0) return [{ fromT: sinceMs, toT: nowMs }];
  const gaps: UsageHistoryGap[] = [];
  let prev = sinceMs;
  for (const sample of series) {
    if (sample.t - prev > GAP_MS) gaps.push({ fromT: prev, toT: sample.t });
    prev = sample.t;
  }
  if (nowMs - prev > GAP_MS) gaps.push({ fromT: prev, toT: nowMs });
  return gaps;
}

/**
 * The history body's series over `samples`. Samples outside `[sinceMs, nowMs]` are ignored everywhere, peaks included. Gaps come from the 5-hour list
 * alone, because every line carries a 5-hour reading — a weekly silence while the 5-hour reading keeps writing splits a weekly segment, not the record.
 */
export function buildUsageHistory(
  samples: UsageSample[],
  opts: { sinceMs: number; nowMs: number; maxPoints?: number }
): UsageHistorySeries {
  const { sinceMs, nowMs } = opts;
  const maxPoints = opts.maxPoints ?? MAX_POINTS;
  const bucketMs = Math.max(MINUTE_MS, Math.ceil((nowMs - sinceMs) / maxPoints / MINUTE_MS) * MINUTE_MS);
  const inRange = samples.filter(sample => sample.t >= sinceMs && sample.t <= nowMs).sort((a, b) => a.t - b.t);
  const weekly: UsageSample[] = [];
  for (const sample of inRange) {
    if (sample.week) weekly.push({ t: sample.t, utilization: sample.week.utilization, resetsAt: sample.week.resetsAt });
  }
  return {
    bucketMs,
    fiveHour: windowsOf(inRange, sinceMs, bucketMs),
    weekly: windowsOf(weekly, sinceMs, bucketMs),
    gaps: gapsOf(inRange, sinceMs, nowMs)
  };
}
