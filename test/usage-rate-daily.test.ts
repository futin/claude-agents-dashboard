/**
 * `dailyRates` — one model's token value, one UTC day at a time, over the same
 * 17-day horizon the verdict is fitted over.
 *
 * The cases are about windowing and state, not about the ratio: the ratio is
 * `poolRate`'s and is tested with it. What can go wrong here is which
 * intervals land in which day, which days exist at all, and what a day says
 * about itself when it has too little or nothing.
 */

import assert from 'node:assert';

import type { TokenCounts } from '../server/lib/usage-ledger.js';
import {
  BASELINE_MS,
  CURRENT_FLOORS,
  dailyRates,
  poolRate
} from '../server/lib/usage-rate.js';
import type { Interval } from '../server/lib/usage-rate.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
/** The horizon starts 17 days back, mid-day: `2026-08-14T12:00Z`. */
const SINCE = NOW - BASELINE_MS;

/** `weighted` weighted tokens exactly — `in` weighs 1, so raw equals weighted too. */
const wtok = (weighted: number): TokenCounts => ({ in: weighted, out: 0, cc: 0, cr: 0 });

/** One interval `model` owns, ending at `toT`, at `weightedPerPct` tokens per point. */
const own = (toT: number, dUtil: number, weightedPerPct: number, model = 'A'): Interval => ({
  fromT: toT - MIN, toT, dUtil, tok: { [model]: wtok(weightedPerPct * dUtil) },
  req: {}, reqUsable: false, kind: { model }
});

const at = (iso: string): number => Date.parse(iso);

export function run(): number {
  console.log('\n=== usage-rate.ts · dailyRates ===\n');
  let p = 0, f = 0;
  const check = (ok: boolean) => { if (ok) p++; else f++; };

  check(test('one entry per UTC date the horizon touches, oldest first, today last', () => {
    const days = dailyRates([], 'A', NOW, null, null);
    assert.strictEqual(days.length, 18, '14 Aug 12:00 → 31 Aug 12:00 touches 18 dates');
    assert.strictEqual(days[0].date, '2026-08-14');
    assert.strictEqual(days[17].date, '2026-08-31');
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i].date > days[i - 1].date, 'strictly ascending');
    }
  }));

  check(test('the first date is clipped to the horizon start, not the whole calendar day', () => {
    const before = own(SINCE - 6 * 3_600_000, 1, 100_000); // 14 Aug 06:00 — outside
    const after = own(SINCE + 3_600_000, 1, 100_000);      // 14 Aug 13:00 — inside
    const days = dailyRates([before, after], 'A', NOW, null, null);
    assert.strictEqual(days[0].date, '2026-08-14');
    assert.strictEqual(days[0].intervals, 1, 'only the interval after 12:00 counts');
    assert.strictEqual(days[0].utilSum, 1);
  }));

  check(test("today's date is open at the top, so an interval stamped just ahead of now still counts", () => {
    const ahead = own(NOW + MIN, 2, 100_000);
    const days = dailyRates([ahead], 'A', NOW, null, null);
    assert.strictEqual(days[17].date, '2026-08-31');
    assert.strictEqual(days[17].intervals, 1);
    assert.strictEqual(days[17].utilSum, 2);
  }));

  check(test('a date this model owned nothing on is `none`: nulls and zeros, never a rate', () => {
    const days = dailyRates([own(at('2026-08-20T10:00:00Z'), 5, 100_000)], 'A', NOW, null, 100_000);
    const empty = days.find(d => d.date === '2026-08-21')!;
    assert.strictEqual(empty.state, 'none');
    assert.strictEqual(empty.weightedPerPct, null);
    assert.strictEqual(empty.rawPerPct, null);
    assert.strictEqual(empty.deviationPct, null);
    assert.strictEqual(empty.intervals, 0);
    assert.strictEqual(empty.utilSum, 0);
  }));

  check(test('dates that ended before the ledger began are `pre-ledger`; the day it began is not', () => {
    const start = at('2026-08-20T00:00:00Z');
    const days = dailyRates([], 'A', NOW, start, null);
    assert.strictEqual(days.find(d => d.date === '2026-08-19')!.state, 'pre-ledger');
    assert.strictEqual(days.find(d => d.date === '2026-08-14')!.state, 'pre-ledger');
    assert.strictEqual(days.find(d => d.date === '2026-08-20')!.state, 'none', 'ends after the start');
  }));

  check(test('a ledger start that lands mid-day still leaves that day recordable', () => {
    const start = at('2026-08-20T07:41:00Z');
    const days = dailyRates([], 'A', NOW, start, null);
    assert.strictEqual(days.find(d => d.date === '2026-08-19')!.state, 'pre-ledger');
    assert.strictEqual(days.find(d => d.date === '2026-08-20')!.state, 'none');
  }));

  check(test('with the start unprovable nothing is called pre-ledger', () => {
    const days = dailyRates([], 'A', NOW, null, null);
    assert.ok(days.every(d => d.state === 'none'));
  }));

  check(test('under the current utilization floor a day is `thin` and still carries its figures', () => {
    const floor = CURRENT_FLOORS.minUtil;
    const thinDay = at('2026-08-22T09:00:00Z');
    const ratedDay = at('2026-08-23T09:00:00Z');
    const days = dailyRates([
      own(thinDay, floor - 0.1, 120_000),
      own(ratedDay, floor, 120_000)
    ], 'A', NOW, null, null);
    const thin = days.find(d => d.date === '2026-08-22')!;
    const rated = days.find(d => d.date === '2026-08-23')!;
    assert.strictEqual(thin.state, 'thin');
    assert.strictEqual(Math.round(thin.weightedPerPct!), 120_000, 'the figure is carried');
    assert.strictEqual(thin.intervals, 1);
    assert.strictEqual(rated.state, 'rated', 'exactly at the floor is enough');
    assert.strictEqual(Math.round(rated.weightedPerPct!), 120_000);
  }));

  check(test('deviation is signed against the baseline, and null without one or without a rate', () => {
    const day = at('2026-08-25T09:00:00Z');
    const withBase = dailyRates([own(day, 10, 150_000)], 'A', NOW, null, 200_000);
    const cell = withBase.find(d => d.date === '2026-08-25')!;
    assert.strictEqual(cell.state, 'rated');
    assert.ok(Math.abs(cell.deviationPct! - (-25)) < 1e-9, `expected -25, got ${cell.deviationPct}`);
    assert.strictEqual(withBase.find(d => d.date === '2026-08-26')!.deviationPct, null, 'no rate → null');

    const noBase = dailyRates([own(day, 10, 150_000)], 'A', NOW, null, null);
    assert.strictEqual(noBase.find(d => d.date === '2026-08-25')!.deviationPct, null);
    assert.strictEqual(noBase.find(d => d.date === '2026-08-25')!.state, 'rated', 'still rated, just unjudged');
  }));

  check(test('a thin day is judged too — its deviation is carried for the tip', () => {
    const day = at('2026-08-25T09:00:00Z');
    const days = dailyRates([own(day, 1, 300_000)], 'A', NOW, null, 200_000);
    const cell = days.find(d => d.date === '2026-08-25')!;
    assert.strictEqual(cell.state, 'thin');
    assert.ok(Math.abs(cell.deviationPct! - 50) < 1e-9);
  }));

  check(test("another model's intervals do not reach this model's day", () => {
    const day = at('2026-08-25T09:00:00Z');
    const days = dailyRates([own(day, 10, 150_000, 'B')], 'A', NOW, null, 200_000);
    assert.strictEqual(days.find(d => d.date === '2026-08-25')!.state, 'none');
  }));

  check(test("a day's figure is poolRate's over exactly that date, clipped to the horizon", () => {
    const d = at('2026-08-25T00:00:00Z');
    const intervals = [own(d + 3_600_000, 2, 100_000), own(d + 7_200_000, 6, 300_000)];
    const days = dailyRates(intervals, 'A', NOW, null, null);
    const cell = days.find(dd => dd.date === '2026-08-25')!;
    const pooled = poolRate(intervals, 'A', d, d + DAY)!;
    assert.strictEqual(cell.weightedPerPct, pooled.weightedPerPct);
    assert.strictEqual(cell.rawPerPct, pooled.rawPerPct);
    assert.strictEqual(cell.utilSum, 8);
    assert.strictEqual(cell.intervals, 2);
    // Σtokens / Σutil, not a mean of ratios: (200k + 1.8M) / 8 = 250k.
    assert.strictEqual(Math.round(cell.weightedPerPct!), 250_000);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
