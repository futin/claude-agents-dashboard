import assert from 'node:assert';

import { rawTokens, weightedTokens } from '../server/lib/usage-ledger.js';
import type { TokenCounts } from '../server/lib/usage-ledger.js';
import {
  BASELINE_MS,
  CURRENT_MS,
  DRIFT_PCT,
  RAW_SHIFT_PCT,
  baselineRange,
  currentRange,
  driftRow,
  externalShare,
  rateFor
} from '../server/lib/usage-rate.js';
import type { Interval, RateFloors } from '../server/lib/usage-rate.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-08-31T12:00:00.000Z');

/** No floor at all — for the cases that are about windowing, not confidence. */
const LOOSE: RateFloors = { minIntervals: 1, minUtil: 0 };

/**
 * Counts with exactly `weighted` weighted tokens and `raw` raw ones.
 *
 * Two solvable shapes, picked by which side is larger: input+output when the
 * weighted total is the bigger number, input+cache-read when it isn't. The
 * round-trip assert is the point — a fixture whose arithmetic doesn't hold
 * fails here rather than silently proving the wrong thing downstream.
 */
function tokFor(weighted: number, raw: number): TokenCounts {
  let tok: TokenCounts;
  if (weighted >= raw) {
    const out = (weighted - raw) / 4;      // in·1 + out·5, in + out = raw
    tok = { in: raw - out, out, cc: 0, cr: 0 };
  } else {
    const inp = (weighted - 0.1 * raw) / 0.9; // in·1 + cr·0.1, in + cr = raw
    tok = { in: inp, out: 0, cc: 0, cr: raw - inp };
  }
  assert.ok(tok.in >= 0 && tok.out >= 0 && tok.cr >= 0, `impossible fixture: w=${weighted} raw=${raw}`);
  assert.strictEqual(Math.round(weightedTokens(tok)), Math.round(weighted));
  assert.strictEqual(Math.round(rawTokens(tok)), Math.round(raw));
  return tok;
}

const clean = (toT: number, dUtil: number, model: string, weighted: number, raw: number): Interval => ({
  fromT: toT - MIN, toT, dUtil, tok: { [model]: tokFor(weighted, raw) }, kind: { model }
});

/** `count` clean intervals ending back-to-back before `endT`, at fixed rates. */
function series(opts: {
  count: number; dUtil: number; weightedPerPct: number; rawPerPct: number;
  model: string; endT: number;
}): Interval[] {
  const { count, dUtil, weightedPerPct, rawPerPct, model, endT } = opts;
  return Array.from({ length: count }, (_, i) =>
    clean(endT - i * MIN, dUtil, model, weightedPerPct * dUtil, rawPerPct * dUtil));
}

const kinded = (toT: number, dUtil: number, kind: Interval['kind']): Interval =>
  ({ fromT: toT - MIN, toT, dUtil, tok: {}, kind });

export function run(): number {
  console.log('\n=== usage-rate.ts (rates + drift) ===\n');
  let p = 0, f = 0;

  if (test('the documented thresholds and windows', () => {
    assert.strictEqual(DRIFT_PCT, 20);
    assert.strictEqual(RAW_SHIFT_PCT, 25);
    assert.strictEqual(BASELINE_MS, 17 * DAY);
    assert.strictEqual(CURRENT_MS, 3 * DAY);
  })) p++; else f++;

  // ── rateFor: the pooled ratio ──

  if (test('rateFor pools Σtokens / Σdutil, not a mean of ratios', () => {
    const intervals: Interval[] = [
      { fromT: 0, toT: MIN, dUtil: 2, tok: { A: tokFor(1_000_000, 10_000_000) }, kind: { model: 'A' } },
      { fromT: MIN, toT: 2 * MIN, dUtil: 3, tok: { A: tokFor(2_000_000, 20_000_000) }, kind: { model: 'A' } }
    ];
    const rate = rateFor(intervals, 'A', 0, 10 * MIN, LOOSE);
    assert.ok(rate);
    assert.strictEqual(rate.weightedPerPct, 600_000);   // 3_000_000 / 5
    assert.strictEqual(rate.rawPerPct, 6_000_000);      // 30_000_000 / 5
    assert.strictEqual(rate.utilSum, 5);
    assert.strictEqual(rate.intervals, 2);
  })) p++; else f++;

  if (test('another model never leaks into this one', () => {
    const intervals: Interval[] = [
      { fromT: 0, toT: MIN, dUtil: 2, tok: { A: tokFor(1_000_000, 10_000_000) }, kind: { model: 'A' } },
      { fromT: MIN, toT: 2 * MIN, dUtil: 4, tok: { B: tokFor(9_000_000, 9_000_000) }, kind: { model: 'B' } },
      // A mixed interval holds A's tokens but belongs to no model.
      { fromT: 2 * MIN, toT: 3 * MIN, dUtil: 4, tok: { A: tokFor(9_000_000, 9_000_000) }, kind: 'mixed' }
    ];
    const rate = rateFor(intervals, 'A', 0, 10 * MIN, LOOSE);
    assert.strictEqual(rate!.weightedPerPct, 500_000);  // 1_000_000 / 2 — A's clean interval only
    assert.strictEqual(rate!.utilSum, 2);
  })) p++; else f++;

  if (test('both floors bind independently', () => {
    const floors: RateFloors = { minIntervals: 30, minUtil: 15 };
    const enough = (count: number, dUtil: number) =>
      rateFor(series({ count, dUtil, weightedPerPct: 900_000, rawPerPct: 2_000_000, model: 'A', endT: NOW }),
        'A', 0, NOW + MIN, floors);

    assert.strictEqual(enough(29, 1), null, '29 intervals is under the count floor');
    assert.strictEqual(enough(30, 0.4), null, 'utilSum 12 is under the movement floor');
    assert.ok(enough(30, 0.5), 'both floors met');
  })) p++; else f++;

  if (test('no intervals at all → null, never a divide by zero', () => {
    assert.strictEqual(rateFor([], 'A', 0, NOW, LOOSE), null);
  })) p++; else f++;

  // ── the window boundaries ──

  if (test('now−3d is current, now−17d is baseline, now−18d is neither', () => {
    const intervals = [
      clean(NOW - 3 * DAY, 1, 'A', 1_000_000, 400_000),
      clean(NOW - 17 * DAY, 1, 'A', 1_000_000, 400_000),
      clean(NOW - 18 * DAY, 1, 'A', 1_000_000, 400_000)
    ];
    const cur = currentRange(NOW);
    const base = baselineRange(NOW);
    assert.strictEqual(rateFor(intervals, 'A', cur.sinceMs, cur.untilMs, LOOSE)!.intervals, 1);
    assert.strictEqual(rateFor(intervals, 'A', base.sinceMs, base.untilMs, LOOSE)!.intervals, 1);
    assert.strictEqual(rateFor(intervals, 'A', 0, NOW - 18 * DAY, LOOSE), null, 'nothing older is reachable');
  })) p++; else f++;

  // ── driftRow verdicts ──

  /** A full baseline + current pair at the given rates. */
  const rows = (opts: {
    baseWeighted: number; baseRaw: number; curWeighted: number; curRaw: number;
  }) => driftRow([
    ...series({ count: 30, dUtil: 0.5, weightedPerPct: opts.baseWeighted, rawPerPct: opts.baseRaw, model: 'A', endT: NOW - 4 * DAY }),
    ...series({ count: 10, dUtil: 0.5, weightedPerPct: opts.curWeighted, rawPerPct: opts.curRaw, model: 'A', endT: NOW - MIN })
  ], 'A', NOW);

  if (test('a weighted rate two thirds above baseline is drift', () => {
    const row = rows({ baseWeighted: 900_000, baseRaw: 2_000_000, curWeighted: 1_500_000, curRaw: 3_333_333.333333 });
    assert.strictEqual(row.verdict, 'drift');
    assert.strictEqual(row.baselineWeightedPerPct, 900_000);
    assert.strictEqual(row.weightedPerPct, 1_500_000);
    assert.ok(Math.abs(row.deviationPct! - 66.6667) < 0.001, `deviation was ${row.deviationPct}`);
  })) p++; else f++;

  if (test('+16.7% is inside the band — not drift', () => {
    const row = rows({ baseWeighted: 900_000, baseRaw: 2_000_000, curWeighted: 1_050_000, curRaw: 2_333_333.333333 });
    assert.strictEqual(row.verdict, 'stable');
    assert.ok(Math.abs(row.deviationPct! - 16.6667) < 0.001, `deviation was ${row.deviationPct}`);
  })) p++; else f++;

  if (test('a flat weighted rate with the raw count adrift is a mix shift, not drift', () => {
    const shift = rows({ baseWeighted: 1_000_000, baseRaw: 400_000, curWeighted: 1_050_000, curRaw: 520_000 });
    assert.strictEqual(shift.verdict, 'mix-shift');   // weighted +5%, raw +30%
    const stable = rows({ baseWeighted: 1_000_000, baseRaw: 400_000, curWeighted: 1_050_000, curRaw: 480_000 });
    assert.strictEqual(stable.verdict, 'stable');     // weighted +5%, raw +20%
  })) p++; else f++;

  if (test('a drop below baseline is drift too — the sign is kept', () => {
    const row = rows({ baseWeighted: 1_000_000, baseRaw: 400_000, curWeighted: 700_000, curRaw: 280_000 });
    assert.strictEqual(row.verdict, 'drift');
    assert.strictEqual(row.deviationPct, -30);
  })) p++; else f++;

  if (test('too little current data is thin, and the baseline is still reported', () => {
    const row = driftRow([
      ...series({ count: 30, dUtil: 0.5, weightedPerPct: 900_000, rawPerPct: 2_000_000, model: 'A', endT: NOW - 4 * DAY }),
      ...series({ count: 3, dUtil: 0.5, weightedPerPct: 1_500_000, rawPerPct: 3_000_000, model: 'A', endT: NOW - MIN })
    ], 'A', NOW);
    assert.strictEqual(row.verdict, 'thin');
    assert.strictEqual(row.weightedPerPct, null);
    assert.strictEqual(row.baselineWeightedPerPct, 900_000);
    assert.strictEqual(row.deviationPct, null);
    assert.strictEqual(row.intervals, 3, 'the evidence it does have is still counted');
    assert.strictEqual(row.utilSum, 1.5);
  })) p++; else f++;

  if (test('no baseline yet is thin, and the current rate is still reported', () => {
    const row = driftRow(
      series({ count: 10, dUtil: 0.5, weightedPerPct: 1_500_000, rawPerPct: 3_000_000, model: 'A', endT: NOW - MIN }),
      'A', NOW
    );
    assert.strictEqual(row.verdict, 'thin');
    assert.strictEqual(row.weightedPerPct, 1_500_000);
    assert.strictEqual(row.baselineWeightedPerPct, null);
    assert.strictEqual(row.deviationPct, null);
  })) p++; else f++;

  // ── external share ──

  if (test('externalShare is external over everything that moved', () => {
    const intervals = [
      kinded(NOW - MIN, 2, 'external'),
      clean(NOW - 2 * MIN, 6, 'A', 6_000_000, 6_000_000),
      kinded(NOW - 3 * MIN, 2, 'mixed'),
      kinded(NOW - 4 * MIN, 5, 'idle'),   // never in the denominator
      kinded(NOW - 5 * MIN, 5, 'gap')     // nor is our own downtime
    ];
    assert.strictEqual(externalShare(intervals, 0, NOW), 0.2);
  })) p++; else f++;

  if (test('externalShare with nothing that moved is null, not zero', () => {
    assert.strictEqual(externalShare([kinded(NOW - MIN, 0, 'idle')], 0, NOW), null);
    assert.strictEqual(externalShare([], 0, NOW), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
