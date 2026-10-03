/**
 * `buildUsageHistory` — the pure series builder behind `GET /api/usage/history`.
 *
 * Every case feeds hand-written samples straight in: no disk, no clock. The stamps are fixed so a failing window split shows its `resetsAt` beside it.
 */

import assert from 'node:assert';

import { buildUsageHistory, GAP_MS } from '../server/lib/usage-history-series.js';
import type { UsageSample } from '../server/lib/usage-history.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const R1 = '2026-10-01T13:20:00.000Z';
const R2 = '2026-10-01T18:20:00.000Z';
const W1 = '2026-10-04T06:00:00.000Z';
const W2 = '2026-10-11T06:00:00.000Z';

function s(t: number, utilization: number, resetsAt: string | null, week?: { utilization: number; resetsAt: string | null }): UsageSample {
  const sample: UsageSample = { t, utilization, resetsAt };
  if (week) sample.week = week;
  return sample;
}

export function run(): number {
  console.log('\nusage-history-series');
  let p = 0, f = 0;

  if (test('GAP_MS is the 15-minute heartbeat plus 5 minutes of slack', () => {
    assert.strictEqual(GAP_MS, 1_200_000);
  })) p++; else f++;

  if (test('no samples: no windows, one gap over the whole range', () => {
    const h = buildUsageHistory([], { sinceMs: 0, nowMs: 3_600_000 });
    assert.deepStrictEqual(h.fiveHour, []);
    assert.deepStrictEqual(h.weekly, []);
    assert.deepStrictEqual(h.gaps, [{ fromT: 0, toT: 3_600_000 }]);
  })) p++; else f++;

  if (test('a resetsAt change starts a new window', () => {
    const h = buildUsageHistory([s(0, 10, R1), s(60_000, 20, R1), s(120_000, 5, R2)], { sinceMs: 0, nowMs: 120_000 });
    assert.deepStrictEqual(h.fiveHour, [
      { resetsAt: R1, firstT: 0, lastT: 60_000, peakPct: 20, segments: [[{ t: 0, pct: 10 }, { t: 60_000, pct: 20 }]] },
      { resetsAt: R2, firstT: 120_000, lastT: 120_000, peakPct: 5, segments: [[{ t: 120_000, pct: 5 }]] }
    ]);
    assert.deepStrictEqual(h.gaps, []);
  })) p++; else f++;

  if (test('sub-second stamp jitter from the live log stays one window', () => {
    const h = buildUsageHistory([
      s(0, 10, '2026-09-19T16:09:59.585398+00:00'),
      s(60_000, 11, '2026-09-19T16:09:59.510609+00:00')
    ], { sinceMs: 0, nowMs: 60_000 });
    assert.strictEqual(h.fiveHour.length, 1);
  })) p++; else f++;

  if (test('a drop beyond 0.5 points without a stamp change is a new window; 0.4 is not', () => {
    const drop = buildUsageHistory([s(0, 50, R1), s(60_000, 10, R1)], { sinceMs: 0, nowMs: 60_000 });
    assert.strictEqual(drop.fiveHour.length, 2);
    const jitter = buildUsageHistory([s(0, 50, R1), s(60_000, 49.6, R1)], { sinceMs: 0, nowMs: 60_000 });
    assert.strictEqual(jitter.fiveHour.length, 1);
  })) p++; else f++;

  if (test('gap boundary: exactly GAP_MS apart is one segment, one ms more is two and a gap', () => {
    const at = buildUsageHistory([s(0, 1, R1), s(1_200_000, 1, R1)], { sinceMs: 0, nowMs: 1_200_000 });
    assert.strictEqual(at.fiveHour.length, 1);
    assert.strictEqual(at.fiveHour[0].segments.length, 1);
    assert.deepStrictEqual(at.gaps, []);
    const over = buildUsageHistory([s(0, 1, R1), s(1_200_001, 1, R1)], { sinceMs: 0, nowMs: 1_200_001 });
    assert.strictEqual(over.fiveHour.length, 1);
    assert.strictEqual(over.fiveHour[0].segments.length, 2);
    assert.deepStrictEqual(over.gaps, [{ fromT: 0, toT: 1_200_001 }]);
  })) p++; else f++;

  if (test('leading and trailing silences are gaps', () => {
    const h = buildUsageHistory([s(1_800_000, 1, R1), s(1_860_000, 1, R1)], { sinceMs: 0, nowMs: 3_360_000 });
    assert.deepStrictEqual(h.gaps, [{ fromT: 0, toT: 1_800_000 }, { fromT: 1_860_000, toT: 3_360_000 }]);
  })) p++; else f++;

  if (test('samples outside [sinceMs, nowMs] are ignored, peaks included', () => {
    const h = buildUsageHistory([s(-60_000, 90, R1), s(0, 10, R1), s(60_000, 20, R1), s(60_001, 95, R1)], { sinceMs: 0, nowMs: 60_000 });
    assert.strictEqual(h.fiveHour.length, 1);
    assert.strictEqual(h.fiveHour[0].peakPct, 20);
    assert.strictEqual(h.fiveHour[0].firstT, 0);
    assert.strictEqual(h.fiveHour[0].lastT, 60_000);
    assert.deepStrictEqual(h.fiveHour[0].segments, [[{ t: 0, pct: 10 }, { t: 60_000, pct: 20 }]]);
  })) p++; else f++;

  if (test('weekly series: only samples carrying week, split on the weekly stamp', () => {
    const h = buildUsageHistory([
      s(0, 1, R1, { utilization: 30, resetsAt: W1 }),
      s(60_000, 2, R1),
      s(120_000, 3, R1, { utilization: 31, resetsAt: W1 }),
      s(180_000, 4, R1, { utilization: 0, resetsAt: W2 })
    ], { sinceMs: 0, nowMs: 180_000 });
    assert.deepStrictEqual(h.weekly, [
      { resetsAt: W1, firstT: 0, lastT: 120_000, peakPct: 31, segments: [[{ t: 0, pct: 30 }, { t: 120_000, pct: 31 }]] },
      { resetsAt: W2, firstT: 180_000, lastT: 180_000, peakPct: 0, segments: [[{ t: 180_000, pct: 0 }]] }
    ]);
    assert.strictEqual(h.fiveHour.length, 1);
    assert.strictEqual(h.fiveHour[0].segments.length, 1);
    assert.strictEqual(h.fiveHour[0].segments[0].length, 4);
  })) p++; else f++;

  if (test('weekly silence while the 5h reading keeps writing splits only the weekly segment', () => {
    const samples: UsageSample[] = [];
    for (let i = 0; i <= 30; i++) {
      samples.push(s(i * 60_000, 1, R1, i === 0 || i === 30 ? { utilization: 10, resetsAt: W1 } : undefined));
    }
    const h = buildUsageHistory(samples, { sinceMs: 0, nowMs: 1_800_000 });
    assert.strictEqual(h.weekly.length, 1);
    assert.strictEqual(h.weekly[0].segments.length, 2);
    assert.strictEqual(h.fiveHour.length, 1);
    assert.strictEqual(h.fiveHour[0].segments.length, 1);
    assert.deepStrictEqual(h.gaps, []);
  })) p++; else f++;

  if (test('downsampling keeps each bucket\'s peak plus the segment\'s first and last', () => {
    const samples: UsageSample[] = [];
    for (let i = 0; i < 1000; i++) samples.push(s(i * 60_000, i / 10, R1));
    const h = buildUsageHistory(samples, { sinceMs: 0, nowMs: 59_940_000, maxPoints: 100 });
    assert.strictEqual(h.bucketMs, 600_000);
    assert.strictEqual(h.fiveHour.length, 1);
    assert.strictEqual(h.fiveHour[0].segments.length, 1);
    const pts = h.fiveHour[0].segments[0];
    assert.strictEqual(pts.length, 101);
    assert.strictEqual(pts[0].t, 0);
    assert.strictEqual(pts[1].t, 540_000);
    assert.strictEqual(pts[pts.length - 1].t, 59_940_000);
    assert.strictEqual(h.fiveHour[0].peakPct, 99.9);
  })) p++; else f++;

  if (test('downsampling ties go to the latest sample, and the last sample survives', () => {
    const h = buildUsageHistory([s(0, 10, R1), s(60_000, 50, R1), s(120_000, 50, R1), s(180_000, 50, R1)], { sinceMs: 0, nowMs: 180_000, maxPoints: 1 });
    assert.strictEqual(h.bucketMs, 180_000);
    assert.deepStrictEqual(h.fiveHour[0].segments[0].map(pt => pt.t), [0, 120_000, 180_000]);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
