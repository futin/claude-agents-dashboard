/**
 * The weekly half of `usage-rate.ts` — `joinWeeklyIntervals` and its floors.
 *
 * The load-bearing test here is the first one: it pairs the *same* series two
 * ways and shows that consecutive-sample pairing publishes a weekly rate an
 * order of magnitude too low **while every evidence counter reads identical**.
 * That is why the pairing is a rule rather than a floor — no floor can see it.
 */

import assert from 'node:assert';

import type { UsageSample } from '../server/lib/usage-history.js';
import type { LedgerLine, TokenCounts } from '../server/lib/usage-ledger.js';
import {
  CURRENT_MS, EXTERNAL_WEIGHTED_MAX, EXTERNAL_WEIGHTED_MAX_WEEKLY, WEEKLY_FLOORS,
  joinIntervals, joinWeeklyIntervals, poolRate, rateFor
} from '../server/lib/usage-rate.js';
import type { Interval } from '../server/lib/usage-rate.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-04T09:00:00.000Z');

/** The 5-hour stamp. Constant everywhere below — this file is about the weekly one. */
const R1 = '2026-09-04T13:00:00.000Z';
/** Two weekly stamps, and one that jitters sub-second off the first. */
const W1 = '2026-09-07T07:59:59.840279+00:00';
const W1_JITTER = '2026-09-07T07:59:59.109000+00:00';
const W2 = '2026-09-14T07:59:59.840279+00:00';

/** `in` tokens weigh exactly 1, so weighted totals read straight off the fixture. */
const counts = (weighted: number): TokenCounts => ({ in: weighted, out: 0, cc: 0, cr: 0 });

const l = (prevT: number, t: number, weighted: number): LedgerLine =>
  ({ t, prevT, tok: { A: counts(weighted) } });

/** A widened sample. `fiveHour` defaults to the weekly reading — see case 4. */
const sw = (
  t: number, weekUtil: number, weekResets: string | null = W1, fiveHour: number = weekUtil
): UsageSample => ({
  t, utilization: fiveHour, resetsAt: R1, week: { utilization: weekUtil, resetsAt: weekResets }
});

/** A pre-widening sample: no weekly reading at all. */
const old = (t: number, fiveHour: number): UsageSample =>
  ({ t, utilization: fiveHour, resetsAt: R1 });

/** One interval model A owns outright — for the floor tests, which need no join. */
const owned = (toT: number, dUtil: number, weighted: number): Interval => ({
  fromT: toT - MIN, toT, dUtil, tok: { A: counts(weighted) }, req: {}, reqUsable: false,
  kind: { model: 'A' }
});

const weightedOf = (interval: Interval): number => interval.tok.A?.in ?? 0;

export function run(): number {
  console.log('\n=== usage-rate.ts (the weekly window) ===\n');
  let p = 0, f = 0;

  if (test('the documented weekly thresholds', () => {
    assert.strictEqual(EXTERNAL_WEIGHTED_MAX_WEEKLY, 45_000);
    assert.deepStrictEqual(WEEKLY_FLOORS, { minIntervals: 10, minUtil: 10, minDays: 2 });
  })) p++; else f++;

  // ── case 4: the pairing, and the bug it exists for ──

  if (test('tick to tick collapses a flat run; sample to sample loses 32/33 of its tokens', () => {
    // 33 spans inside one weekly window, 10_000 weighted each. The weekly
    // counter holds at 10 across all of them and steps to 11 at the last
    // sample. The 5-hour reading is set to the *same* series on purpose: that
    // makes `joinIntervals` literally the consecutive-pairing counterfactual
    // over identical input, which is the comparison this test is for.
    const samples: UsageSample[] = [];
    const ledger: LedgerLine[] = [];
    for (let i = 0; i <= 33; i++) {
      samples.push(sw(T0 + i * MIN, i === 33 ? 11 : 10));
      if (i > 0) ledger.push(l(T0 + (i - 1) * MIN, T0 + i * MIN, 10_000));
    }

    const weekly = joinWeeklyIntervals(samples, ledger, null);
    assert.strictEqual(weekly.length, 1, 'the flat run must collapse into one interval');
    assert.strictEqual(weekly[0].fromT, T0);
    assert.strictEqual(weekly[0].toT, T0 + 33 * MIN);
    assert.strictEqual(weekly[0].dUtil, 1);
    assert.strictEqual(weightedOf(weekly[0]), 330_000, 'the interval must carry every token');

    const consecutive = joinIntervals(samples, ledger, null);
    assert.strictEqual(consecutive.length, 33);
    assert.strictEqual(consecutive.filter((i) => i.kind === 'idle').length, 32,
      'consecutive pairing hands 32 spans to intervals whose counter did not move');

    const right = poolRate(weekly, 'A', 0, Number.POSITIVE_INFINITY);
    const wrong = poolRate(consecutive, 'A', 0, Number.POSITIVE_INFINITY);
    assert.ok(right !== null && wrong !== null);
    assert.strictEqual(right.weightedPerPct, 330_000);
    assert.strictEqual(wrong.weightedPerPct, 10_000);
    assert.ok(right.weightedPerPct / wrong.weightedPerPct >= 10,
      'the wrong pairing must read an order of magnitude low');

    // And this is why no evidence floor catches it: the counters are identical.
    assert.strictEqual(right.intervals, wrong.intervals);
    assert.strictEqual(right.utilSum, wrong.utilSum);
    assert.strictEqual(right.days, wrong.days);
  })) p++; else f++;

  // ── case 5: window changes ──

  if (test('a weekly window change closes the run without emitting across it', () => {
    const samples = [
      sw(T0, 10, W1), sw(T0 + MIN, 11, W1),          // one tick inside W1
      sw(T0 + 2 * MIN, 3, W2), sw(T0 + 3 * MIN, 4, W2) // a fresh window, then a tick in it
    ];
    const ledger = [
      l(T0, T0 + MIN, 60_000), l(T0 + MIN, T0 + 2 * MIN, 60_000),
      l(T0 + 2 * MIN, T0 + 3 * MIN, 60_000)
    ];
    const out = joinWeeklyIntervals(samples, ledger, null);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((i) => [i.fromT, i.toT]), [
      [T0, T0 + MIN], [T0 + 2 * MIN, T0 + 3 * MIN]
    ]);
    for (const interval of out) assert.strictEqual(interval.dUtil, 1);
  })) p++; else f++;

  if (test('a weekly stamp jittering under two minutes is the same window', () => {
    // The endpoint recomputes the stamp per request; comparing strings would
    // classify every weekly interval as a window change and the card would
    // never fill. Same slack the 5-hour stamp already gets.
    const samples = [sw(T0, 10, W1), sw(T0 + MIN, 11, W1_JITTER)];
    const out = joinWeeklyIntervals(samples, [l(T0, T0 + MIN, 60_000)], null);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].dUtil, 1);
  })) p++; else f++;

  // ── case 6: pre-widening samples ──

  if (test('samples with no week are skipped — they never open, close or split a run', () => {
    const samples = [
      sw(T0, 10), old(T0 + MIN, 10), old(T0 + 2 * MIN, 10), sw(T0 + 3 * MIN, 11)
    ];
    const ledger = [
      l(T0, T0 + MIN, 20_000), l(T0 + MIN, T0 + 2 * MIN, 20_000),
      l(T0 + 2 * MIN, T0 + 3 * MIN, 20_000)
    ];
    const out = joinWeeklyIntervals(samples, ledger, null);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].fromT, T0, 'the run opens at the first widened tick');
    assert.strictEqual(out[0].toT, T0 + 3 * MIN);
    assert.strictEqual(weightedOf(out[0]), 60_000, 'the tokens spent across them are included');
  })) p++; else f++;

  // ── case 7: the mid-window reset this account saw on 2026-09-04 ──

  if (test('the 2026-09-04 reset: 85 → 0 with the stamp unchanged emits nothing', () => {
    const samples = [
      sw(T0, 84, W1), sw(T0 + MIN, 85, W1),            // a tick, inside the window
      sw(T0 + 2 * MIN, 0, W1),                          // the counter is zeroed, stamp unmoved
      sw(T0 + 3 * MIN, 1, W1)                           // and starts again from 0
    ];
    const ledger = [
      l(T0, T0 + MIN, 60_000), l(T0 + MIN, T0 + 2 * MIN, 60_000),
      l(T0 + 2 * MIN, T0 + 3 * MIN, 60_000)
    ];
    const out = joinWeeklyIntervals(samples, ledger, null);
    for (const interval of out) {
      assert.ok(interval.dUtil > 0, `a drop must never reach an interval (${interval.dUtil})`);
    }
    // Remove the drop rule and `sameWindow` alone would emit [T0+MIN, T0+2MIN]
    // carrying dUtil = −85, which poisons every pooled sum it lands in.
    assert.ok(!out.some((i) => i.fromT === T0 + MIN && i.toT === T0 + 2 * MIN),
      'no interval may span the reset');
    assert.deepStrictEqual(out.map((i) => [i.fromT, i.toT]), [
      [T0, T0 + MIN], [T0 + 2 * MIN, T0 + 3 * MIN]
    ]);
    assert.strictEqual(weightedOf(out[1]), 60_000,
      'the fresh run starts after the drop, not before it');
  })) p++; else f++;

  if (test('the same reset with the stamp also moving: identical outcome, via sameWindow', () => {
    const samples = [
      sw(T0, 84, W1), sw(T0 + MIN, 85, W1),
      sw(T0 + 2 * MIN, 0, W2), sw(T0 + 3 * MIN, 1, W2)
    ];
    const ledger = [
      l(T0, T0 + MIN, 60_000), l(T0 + MIN, T0 + 2 * MIN, 60_000),
      l(T0 + 2 * MIN, T0 + 3 * MIN, 60_000)
    ];
    const out = joinWeeklyIntervals(samples, ledger, null);
    assert.deepStrictEqual(out.map((i) => [i.fromT, i.toT, i.dUtil]), [
      [T0, T0 + MIN, 1], [T0 + 2 * MIN, T0 + 3 * MIN, 1]
    ]);
  })) p++; else f++;

  if (test('the trailing partial run is not emitted — censoring, not bias', () => {
    const samples = [sw(T0, 10), sw(T0 + MIN, 11), sw(T0 + 2 * MIN, 11)];
    const ledger = [l(T0, T0 + MIN, 60_000), l(T0 + MIN, T0 + 2 * MIN, 60_000)];
    const out = joinWeeklyIntervals(samples, ledger, null);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].toT, T0 + MIN);
  })) p++; else f++;

  // ── case 8: the weekly external threshold ──

  if (test('the weekly external threshold is the one in force, and only there', () => {
    // 20_000 weighted sits between the two constants: it is a real model's
    // window at 5-hour grain and another device's spend at weekly grain.
    assert.ok(EXTERNAL_WEIGHTED_MAX < 20_000 && 20_000 < EXTERNAL_WEIGHTED_MAX_WEEKLY);
    const samples = [sw(T0, 10), sw(T0 + MIN, 11)];
    const ledger = [l(T0, T0 + MIN, 20_000)];
    const weekly = joinWeeklyIntervals(samples, ledger, null);
    const fiveHour = joinIntervals(samples, ledger, null);
    assert.strictEqual(weekly.length, 1);
    assert.strictEqual(fiveHour.length, 1);
    assert.strictEqual(weekly[0].kind, 'external');
    assert.deepStrictEqual(fiveHour[0].kind, { model: 'A' });
  })) p++; else f++;

  // ── case 9: the floors ──

  if (test('WEEKLY_FLOORS: 9 intervals refuses, 10 over 2 dates at 10.0 points fits', () => {
    const nine = [];
    for (let i = 0; i < 9; i++) {
      nine.push(owned(T0 + (i < 5 ? 0 : DAY) + i * MIN, 10 / 9, 100_000));
    }
    assert.strictEqual(rateFor(nine, 'A', 0, Number.POSITIVE_INFINITY, WEEKLY_FLOORS), null);

    const ten = [];
    for (let i = 0; i < 10; i++) {
      ten.push(owned(T0 + (i < 5 ? 0 : DAY) + i * MIN, 1, 100_000));
    }
    const fitted = rateFor(ten, 'A', 0, Number.POSITIVE_INFINITY, WEEKLY_FLOORS);
    assert.ok(fitted !== null, 'exactly at the floor on all three counts must fit');
    assert.strictEqual(fitted.intervals, 10);
    assert.strictEqual(fitted.utilSum, 10);
    assert.strictEqual(fitted.days, 2);
    assert.strictEqual(fitted.weightedPerPct, 100_000);
  })) p++; else f++;

  if (test('WEEKLY_FLOORS: each floor alone refuses in the mirror direction', () => {
    const oneDate = [];
    for (let i = 0; i < 10; i++) oneDate.push(owned(T0 + i * MIN, 1, 100_000));
    assert.strictEqual(rateFor(oneDate, 'A', 0, Number.POSITIVE_INFINITY, WEEKLY_FLOORS), null,
      '10 intervals over 1 date is a single day wearing a fortnight’s clothes');

    const thinPoints = [];
    for (let i = 0; i < 10; i++) {
      thinPoints.push(owned(T0 + (i < 5 ? 0 : DAY) + i * MIN, 0.9, 100_000));
    }
    assert.strictEqual(rateFor(thinPoints, 'A', 0, Number.POSITIVE_INFINITY, WEEKLY_FLOORS), null,
      '9.0 points is under the 10 that bounds the quantization error at 10%');
  })) p++; else f++;

  if (test('WEEKLY_FLOORS.minDays can actually be met inside the fit window', () => {
    // A floor wider than its own window is a column that never fills.
    assert.ok(WEEKLY_FLOORS.minDays <= CURRENT_MS / DAY,
      `minDays ${WEEKLY_FLOORS.minDays} exceeds the ${CURRENT_MS / DAY}d fit window`);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
