/**
 * The Usage → History view's pure helpers: the step-after path, the coverage figure, the day ticks, the figure strip and the weekly-fill rows.
 */

import assert from 'node:assert';

import { coveragePct, dayTicks, historyFigures, stepPath, weekRows } from '../client/src/lib/usageHistory.js';
import type { UsageHistoryResponse, UsageHistoryWindow } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const DAY = 86_400_000;
const H = 3_600_000;
/** Mon 7 Sep 2026 00:00Z. */
const MON = Date.UTC(2026, 8, 7);

/** A weekly window resetting at `resetsAtMs`, its readings as `[t, pct]` pairs in one segment. */
function week(resetsAtMs: number | null, points: Array<[number, number]>, peakPct = 0): UsageHistoryWindow {
  const pts = points.map(([t, pct]) => ({ t, pct }));
  return { resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(), firstT: pts[0].t, lastT: pts[pts.length - 1].t, peakPct, segments: [pts] };
}

function resp(over: Partial<UsageHistoryResponse>): UsageHistoryResponse {
  return { recording: true, days: 7, sinceT: 0, nowT: 1000, bucketMs: 60_000, fiveHour: [], weekly: [], gaps: [], ...over };
}

function win(peakPct: number): UsageHistoryWindow {
  return { resetsAt: null, firstT: 0, lastT: 0, peakPct, segments: [[{ t: 0, pct: peakPct }]] };
}

export function run(): number {
  console.log('\nusage-history-view');
  let p = 0, f = 0;

  if (test('stepPath holds each reading flat until the next, then steps', () => {
    const pts = [{ t: 0, pct: 0 }, { t: 10, pct: 50 }, { t: 20, pct: 100 }];
    assert.strictEqual(stepPath(pts, t => t * 10, pct => 100 - pct), 'M0 100H100V50H200V0');
    assert.strictEqual(stepPath([{ t: 0, pct: 0 }], t => t * 10, pct => 100 - pct), 'M0 100');
  })) p++; else f++;

  if (test('stepPath prints at most two decimals, trailing zeros dropped', () => {
    assert.strictEqual(stepPath([{ t: 0, pct: 0 }, { t: 1, pct: 0 }], t => t / 3, () => 1.5), 'M0 1.5H0.33V1.5');
  })) p++; else f++;

  if (test('coveragePct is the share of the range not inside a gap', () => {
    assert.strictEqual(coveragePct(resp({ gaps: [{ fromT: 0, toT: 250 }] })), 75);
    assert.strictEqual(coveragePct(resp({ gaps: [] })), 100);
    assert.strictEqual(coveragePct(resp({ gaps: [{ fromT: 0, toT: 1000 }] })), 0);
    assert.strictEqual(coveragePct(resp({ sinceT: 500, nowT: 500 })), 0);
  })) p++; else f++;

  if (test('dayTicks: local midnights strictly inside the range', () => {
    const since = Date.parse('2026-09-28T12:00:00Z');
    const now = Date.parse('2026-10-01T12:00:00Z');
    assert.deepStrictEqual(dayTicks(since, now, 0), [
      Date.parse('2026-09-29T00:00:00Z'), Date.parse('2026-09-30T00:00:00Z'), Date.parse('2026-10-01T00:00:00Z')
    ]);
    assert.deepStrictEqual(dayTicks(since, now, 120), [
      Date.parse('2026-09-28T22:00:00Z'), Date.parse('2026-09-29T22:00:00Z'), Date.parse('2026-09-30T22:00:00Z')
    ]);
  })) p++; else f++;

  if (test('dayTicks: a 90-day range keeps only Mondays, at most 14', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const ticks = dayTicks(now - 90 * DAY, now, 0);
    assert.ok(ticks.length > 0 && ticks.length <= 14, `got ${ticks.length} ticks`);
    for (const t of ticks) assert.strictEqual(new Date(t).getUTCDay(), 1);
  })) p++; else f++;

  if (test('historyFigures counts windows at the limit, and a missing weekly peak is null', () => {
    const figures = historyFigures(resp({ fiveHour: [win(100), win(40), win(99.9)] }));
    assert.strictEqual(figures.atLimit, 1);
    assert.strictEqual(figures.windows, 3);
    assert.strictEqual(figures.weeklyPeak, null);
    assert.strictEqual(historyFigures(resp({ weekly: [win(30), win(62.5)] })).weeklyPeak, 62.5);
  })) p++; else f++;

  if (test('weekRows splits a window at local midnights, holding each reading', () => {
    const rows = weekRows(resp({
      sinceT: MON, nowT: MON + DAY + 20 * H,
      weekly: [week(MON + 7 * DAY + 9 * H, [[MON + 10 * H, 0], [MON + 15 * H, 10], [MON + DAY + 11 * H, 25]])]
    }), 0);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0].days, [
      { fromT: MON + 10 * H, toT: MON + DAY, fromPct: 0, toPct: 10, offMs: 0 },
      { fromT: MON + DAY, toT: MON + DAY + 20 * H, fromPct: 10, toPct: 25, offMs: 0 }
    ]);
    assert.strictEqual(rows[0].current, true);
    assert.strictEqual(rows[0].prePct, 0);
  })) p++; else f++;

  if (test('weekRows: the pre segment carries what the week spent before the range', () => {
    const since = MON + 2 * DAY;
    const rows = weekRows(resp({
      sinceT: since, nowT: since + DAY, bucketMs: 60_000,
      weekly: [week(MON + 7 * DAY, [[since + 60_000, 28.8], [since + 5 * H, 35]])]
    }), 0);
    assert.strictEqual(rows[0].prePct, 28.8);
    assert.strictEqual(rows[0].preCause, 'range');
    assert.strictEqual(rows[0].days[0].fromPct, 28.8);
  })) p++; else f++;

  if (test("weekRows: a late first reading is 'recording', not 'range'", () => {
    const since = MON + 2 * DAY;
    const rows = weekRows(resp({
      sinceT: since, nowT: since + DAY, bucketMs: 60_000,
      weekly: [week(MON + 7 * DAY, [[since + 3 * H, 28.8], [since + 5 * H, 35]])]
    }), 0);
    assert.strictEqual(rows[0].preCause, 'recording');
  })) p++; else f++;

  if (test('weekRows drops a zero-gain day and keeps a 0.3-point one', () => {
    const rows = weekRows(resp({
      sinceT: MON, nowT: MON + 3 * DAY,
      weekly: [week(MON + 7 * DAY, [[MON + 1 * H, 10], [MON + DAY + 1 * H, 10.2], [MON + 2 * DAY + 1 * H, 10.5]])]
    }), 0);
    assert.strictEqual(rows[0].days.length, 1);
    assert.ok(Math.abs(rows[0].days[0].toPct - rows[0].days[0].fromPct - 0.3) < 1e-9);
  })) p++; else f++;

  if (test("weekRows: offMs counts unrecorded time since the day's last reading, from one hour up", () => {
    const base = { sinceT: MON, nowT: MON + DAY, weekly: [week(MON + 7 * DAY, [[MON + 1 * H, 0], [MON + 4 * H, 5], [MON + 10 * H, 9]])] };
    const long = weekRows(resp({ ...base, gaps: [{ fromT: MON + 5 * H, toT: MON + 7 * H }] }), 0);
    assert.strictEqual(long[0].days[0].offMs, 7_200_000);
    const short = weekRows(resp({ ...base, gaps: [{ fromT: MON + 5 * H, toT: MON + 5 * H + 30 * 60_000 }] }), 0);
    assert.strictEqual(short[0].days[0].offMs, 0);
  })) p++; else f++;

  if (test("weekRows: startT is the previous window's reset, newest row first, hits counted per row", () => {
    const r1 = MON + 7 * DAY, r2 = MON + 14 * DAY;
    const five = (firstT: number, peakPct: number): UsageHistoryWindow => ({ resetsAt: null, firstT, lastT: firstT, peakPct, segments: [[{ t: firstT, pct: peakPct }]] });
    const rows = weekRows(resp({
      sinceT: MON, nowT: r2 + DAY,
      weekly: [week(r2, [[r1 + H, 1], [r1 + 2 * DAY, 20]]), week(r1, [[MON + H, 1], [MON + 2 * DAY, 30]])],
      fiveHour: [five(r1 - 3 * H, 100), five(r1 + 2 * H, 100), five(r1 + DAY, 100), five(r1 + 2 * DAY, 99.9)]
    }), 0);
    assert.deepStrictEqual(rows.map(r => r.resetsAtMs), [r2, r1]);
    assert.strictEqual(rows[0].startT, r1);
    assert.strictEqual(rows[0].limitHits, 2);
    assert.strictEqual(rows[1].startT, null);
    assert.strictEqual(rows[1].limitHits, 1);
  })) p++; else f++;

  if (test('weekRows: an unscoped window renders without a reset', () => {
    const rows = weekRows(resp({
      sinceT: MON, nowT: MON + 3 * DAY,
      weekly: [week(null, [[MON + 1 * H, 0], [MON + DAY + 2 * H, 12]])]
    }), 0);
    assert.strictEqual(rows[0].resetsAtMs, null);
    assert.strictEqual(rows[0].current, false);
    assert.strictEqual(rows[0].startT, null);
    assert.ok(rows[0].key.startsWith('unscoped-'));
    assert.strictEqual(rows[0].days[rows[0].days.length - 1].toT, MON + DAY + 2 * H);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
