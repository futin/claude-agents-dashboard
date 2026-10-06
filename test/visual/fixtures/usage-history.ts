/**
 * `GET /api/usage/history` — the 7 days before EPOCH (the view's default range; `?days=` is ignored, so every range draws this week).
 * Two 5-hour windows per day (06:00Z and 11:00Z starts) and two weekly windows split at Fri 26 Sep 02:00Z.
 */
import type { UsageHistoryPoint, UsageHistoryResponse, UsageHistoryWindow } from '../../../shared/types.js';

import { DAY, EPOCH, HOUR, MIN } from './epoch.js';
import { FIVE_RESETS_MS, FIVE_UTIL, WEEK_RESETS_MS, WEEK_UTIL } from './usage-model.js';

const DAYS = 7;
const SINCE = EPOCH - DAYS * DAY;
const BUCKET = 30 * MIN;
const PREV_WEEK_RESET = WEEK_RESETS_MS - 7 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A rising line from `from` to `to` (exclusive of `to` once past EPOCH), easing toward `endPct`. */
function rising(from: number, to: number, startPct: number, endPct: number): UsageHistoryPoint[] {
  const end = Math.min(to, EPOCH);
  const points: UsageHistoryPoint[] = [];
  for (let t = from; t <= end; t += BUCKET) {
    const f = (t - from) / (to - from);
    points.push({ t, pct: round1(startPct + (endPct - startPct) * Math.pow(f, 0.8)) });
  }
  return points;
}

function windowOf(resetsAt: number, segment: UsageHistoryPoint[]): UsageHistoryWindow {
  return {
    resetsAt: iso(resetsAt),
    firstT: segment[0].t,
    lastT: segment[segment.length - 1].t,
    peakPct: Math.max(...segment.map(p => p.pct)),
    segments: [segment]
  };
}

const fiveHour: UsageHistoryWindow[] = [];
for (let d = DAYS - 1; d >= 0; d--) {
  const dayStart = Date.UTC(2026, 8, 30) - d * DAY;
  for (const [w, startH] of [[0, 6], [1, 11]] as const) {
    const start = dayStart + startH * HOUR;
    const end = start + 5 * HOUR;
    if (start < SINCE || start > EPOCH) continue;
    const weekend = [0, 6].includes(new Date(start).getUTCDay());
    const peak = weekend ? 8 + ((d * 5) % 7) : 30 + ((d * 37 + w * 19) % 50);
    // The open window ends exactly where the account bar says it stands now.
    const target = end === FIVE_RESETS_MS ? FIVE_UTIL / Math.pow((EPOCH - start) / (end - start), 0.8) : peak;
    fiveHour.push(windowOf(end, rising(start, end, 0, target)));
  }
}

const weekly: UsageHistoryWindow[] = [
  windowOf(PREV_WEEK_RESET, rising(SINCE, PREV_WEEK_RESET - BUCKET, 61, 88)),
  windowOf(WEEK_RESETS_MS, rising(PREV_WEEK_RESET, EPOCH, 0, WEEK_UTIL))
];

export const usageHistory: UsageHistoryResponse = {
  recording: true,
  days: DAYS,
  sinceT: SINCE,
  nowT: EPOCH,
  bucketMs: BUCKET,
  fiveHour,
  weekly,
  gaps: []
};
