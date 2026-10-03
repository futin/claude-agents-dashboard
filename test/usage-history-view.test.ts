/**
 * The Usage → History view's pure helpers: the step-after path, the coverage figure, the day ticks and the figure strip.
 */

import assert from 'node:assert';

import { coveragePct, dayTicks, historyFigures, stepPath } from '../client/src/lib/usageHistory.js';
import type { UsageHistoryResponse, UsageHistoryWindow } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const DAY = 86_400_000;

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

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
