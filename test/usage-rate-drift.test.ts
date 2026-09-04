import assert from 'node:assert';

import { rawTokens, weightedTokens } from '../server/lib/usage-ledger.js';
import type { TokenCounts } from '../server/lib/usage-ledger.js';
import {
  BASELINE_FLOORS,
  BASELINE_MS,
  CURRENT_FLOORS,
  CURRENT_MS,
  DRIFT_PCT,
  RAW_SHIFT_PCT,
  SPLIT_FLOORS,
  SPLIT_MAX_R2,
  SPLIT_MIN_INDEPENDENT_SHARE,
  SPLIT_RANK_TOL,
  baselineRange,
  currentRange,
  driftRow,
  explainSplits,
  externalShare,
  fitSplits,
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
const LOOSE: RateFloors = { minIntervals: 1, minUtil: 0, minDays: 0 };

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
  fromT: toT - MIN, toT, dUtil, tok: { [model]: tokFor(weighted, raw) },
  req: {}, reqUsable: false, kind: { model }
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

/**
 * `count` clean intervals distributed round-robin over `days` consecutive UTC
 * dates, the last of them `endT`'s date, minute-spaced within each date.
 *
 * Round-robin rather than a fixed per-interval step, because the date count is
 * the quantity under test: derive it from a step and a fixture meant to hold
 * exactly 7 dates quietly holds 6 or 8 the moment its count changes.
 */
function daily(opts: {
  count: number; days: number; dUtil: number; weightedPerPct: number; rawPerPct: number;
  model: string; endT: number;
}): Interval[] {
  const { count, days, dUtil, weightedPerPct, rawPerPct, model, endT } = opts;
  return Array.from({ length: count }, (_, i) => {
    const toT = endT - (i % days) * DAY - Math.floor(i / days) * MIN;
    return clean(toT, dUtil, model, weightedPerPct * dUtil, rawPerPct * dUtil);
  });
}

const kinded = (toT: number, dUtil: number, kind: Interval['kind']): Interval =>
  ({ fromT: toT - MIN, toT, dUtil, tok: {}, req: {}, reqUsable: false, kind });

/** `weighted` weighted tokens exactly — `in` weighs 1, so it reads off the fixture. */
const wtok = (weighted: number): TokenCounts => ({ in: weighted, out: 0, cc: 0, cr: 0 });

/**
 * One interval for the two-term fit: `mtok` millions of weighted tokens and
 * `reqs` requests for `model`, with its counts recorded.
 */
function split(opts: {
  toT: number; dUtil: number; model: string; mtok: number; reqs: number;
  kind?: Interval['kind'];
}): Interval {
  const { toT, dUtil, model, mtok, reqs } = opts;
  return {
    fromT: toT - MIN, toT, dUtil,
    tok: { [model]: wtok(mtok * 1_000_000) },
    req: { [model]: reqs },
    reqUsable: true,
    kind: opts.kind ?? { model }
  };
}

/** The truth the synthetic fixtures below are generated from. */
const TRUE_PCT_PER_MTOK = 0.5;
const TRUE_PCT_PER_REQUEST = 0.02;

/**
 * `count` intervals whose tokens and requests vary independently, with
 * utilization generated exactly from the two coefficients above.
 *
 * The two regressors have to move apart for the split to be identified at all,
 * which is the whole point: `mtok` walks 1.0 → 3.0 on a 5-cycle while `reqs`
 * walks 40 → 140 on an 11-cycle, so their uncentered r² is ~0.79.
 */
function splitSeries(count: number, model = 'A', kind?: Interval['kind']): Interval[] {
  return Array.from({ length: count }, (_, i) => {
    const mtok = 1 + (i % 5) * 0.5;
    const reqs = 40 + ((i * 7) % 11) * 10;
    return split({
      toT: NOW - (i + 1) * MIN,
      dUtil: TRUE_PCT_PER_MTOK * mtok + TRUE_PCT_PER_REQUEST * reqs,
      model, mtok, reqs, kind
    });
  });
}

const FIT_FROM = NOW - DAY;

/** A seeded LCG, so every fixture below is the same run to run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** The truth `coupledPair` generates its utilization from, per model. */
const PAIR_TRUTH = {
  A: { perMTok: 0.5, perRequest: 0.02 },
  B: { perMTok: 1.2, perRequest: 0.03 }
};

/**
 * `count` **mixed** intervals in which two models are always used together,
 * with B's token column tied to A's by `coupling` — 0 independent, 1 an exact
 * multiple.
 *
 * The noise is what makes this a real test: with exact data even a hopelessly
 * ill-conditioned system reproduces the coefficients it was generated from, so
 * a noiseless fixture would prove nothing about conditioning at all.
 */
function coupledPair(coupling: number, count = 200): Interval[] {
  const rand = lcg(20260902);
  return Array.from({ length: count }, (_, i) => {
    const aTok = 0.5 + rand() * 2.5;
    const independent = 0.4 + rand() * 1.6;
    const bTok = coupling * (0.8 * aTok) + (1 - coupling) * independent;
    const aReq = 20 + Math.round(rand() * 120);
    const bReq = 15 + Math.round(rand() * 90);
    const noise = (rand() - 0.5) * 0.3;
    const toT = NOW - (i + 1) * MIN;
    return {
      fromT: toT - MIN,
      toT,
      dUtil: PAIR_TRUTH.A.perMTok * aTok + PAIR_TRUTH.A.perRequest * aReq
        + PAIR_TRUTH.B.perMTok * bTok + PAIR_TRUTH.B.perRequest * bReq + noise,
      tok: { A: wtok(aTok * 1_000_000), B: wtok(bTok * 1_000_000) },
      req: { A: aReq, B: bReq },
      reqUsable: true,
      kind: 'mixed'
    };
  });
}

export function run(): number {
  console.log('\n=== usage-rate.ts (rates + drift) ===\n');
  let p = 0, f = 0;

  if (test('the documented thresholds and windows', () => {
    assert.strictEqual(DRIFT_PCT, 20);
    assert.strictEqual(RAW_SHIFT_PCT, 25);
    assert.strictEqual(BASELINE_MS, 17 * DAY);
    assert.strictEqual(CURRENT_MS, 3 * DAY);
    assert.deepStrictEqual(BASELINE_FLOORS, { minIntervals: 30, minUtil: 15, minDays: 7 });
    assert.deepStrictEqual(CURRENT_FLOORS, { minIntervals: 10, minUtil: 5, minDays: 2 });
  })) p++; else f++;

  // ── rateFor: the pooled ratio ──

  if (test('rateFor pools Σtokens / Σdutil, not a mean of ratios', () => {
    const intervals: Interval[] = [
      { fromT: 0, toT: MIN, dUtil: 2, tok: { A: tokFor(1_000_000, 10_000_000) }, req: {}, reqUsable: false, kind: { model: 'A' } },
      { fromT: MIN, toT: 2 * MIN, dUtil: 3, tok: { A: tokFor(2_000_000, 20_000_000) }, req: {}, reqUsable: false, kind: { model: 'A' } }
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
      { fromT: 0, toT: MIN, dUtil: 2, tok: { A: tokFor(1_000_000, 10_000_000) }, req: {}, reqUsable: false, kind: { model: 'A' } },
      { fromT: MIN, toT: 2 * MIN, dUtil: 4, tok: { B: tokFor(9_000_000, 9_000_000) }, req: {}, reqUsable: false, kind: { model: 'B' } },
      // A mixed interval holds A's tokens but belongs to no model.
      { fromT: 2 * MIN, toT: 3 * MIN, dUtil: 4, tok: { A: tokFor(9_000_000, 9_000_000) }, req: {}, reqUsable: false, kind: 'mixed' }
    ];
    const rate = rateFor(intervals, 'A', 0, 10 * MIN, LOOSE);
    assert.strictEqual(rate!.weightedPerPct, 500_000);  // 1_000_000 / 2 — A's clean interval only
    assert.strictEqual(rate!.utilSum, 2);
  })) p++; else f++;

  if (test('all three floors bind independently', () => {
    const floors: RateFloors = { minIntervals: 30, minUtil: 15, minDays: 7 };
    const RATES = { weightedPerPct: 900_000, rawPerPct: 2_000_000, model: 'A' };
    const enough = (count: number, dUtil: number, days: number) =>
      rateFor(daily({ ...RATES, count, dUtil, days, endT: NOW }), 'A', 0, NOW + MIN, floors);

    assert.strictEqual(enough(29, 1, 7), null, '29 intervals is under the count floor');
    assert.strictEqual(enough(30, 0.4, 7), null, 'utilSum 12 is under the movement floor');
    assert.strictEqual(enough(30, 0.5, 6), null, '6 dates is under the day floor');
    assert.ok(enough(30, 0.5, 7), 'all three floors met');
  })) p++; else f++;

  if (test('no intervals at all → null, never a divide by zero', () => {
    assert.strictEqual(rateFor([], 'A', 0, NOW, LOOSE), null);
  })) p++; else f++;

  // ── the day floor: bug-17 ──

  if (test('MUTATION: a one-day baseline is refused however many intervals it holds', () => {
    // The live numbers behind bug-17: the recorder's first 10.8 hours cleared
    // 30 intervals / 15 points with room to spare and was judged `drift`
    // against a 3-day pool. Delete the day check in `rateFor` and the first
    // assert here goes green while the badge is wrong.
    const opts = { count: 60, dUtil: 65 / 60, weightedPerPct: 163_184, rawPerPct: 1_126_873, model: 'A' };
    const oneDay = series({ ...opts, endT: NOW - 4 * DAY });
    assert.strictEqual(rateFor(oneDay, 'A', 0, NOW, BASELINE_FLOORS), null,
      '60 intervals on one UTC date is not a 14-day baseline');

    const spread = daily({ ...opts, days: 7, endT: NOW - 4 * DAY });
    const fitted = rateFor(spread, 'A', 0, NOW, BASELINE_FLOORS);
    assert.ok(fitted, 'the same evidence across 7 dates is a baseline');
    assert.strictEqual(fitted.days, 7);
    assert.strictEqual(fitted.intervals, 60, 'same evidence, only spread further');
  })) p++; else f++;

  if (test('days counts distinct UTC dates, not elapsed time', () => {
    // Two minutes apart across midnight is two dates; almost 24 hours inside
    // one date is one. A `max(toT) − min(toT)` span would get both backwards.
    const acrossMidnight = [
      clean(Date.parse('2026-08-20T23:59:00.000Z'), 1, 'A', 1_000_000, 400_000),
      clean(Date.parse('2026-08-21T00:01:00.000Z'), 1, 'A', 1_000_000, 400_000)
    ];
    assert.strictEqual(rateFor(acrossMidnight, 'A', 0, NOW, LOOSE)!.days, 2);

    const oneLongDay = [
      clean(Date.parse('2026-08-20T00:01:00.000Z'), 1, 'A', 1_000_000, 400_000),
      clean(Date.parse('2026-08-20T23:59:00.000Z'), 1, 'A', 1_000_000, 400_000)
    ];
    assert.strictEqual(rateFor(oneLongDay, 'A', 0, NOW, LOOSE)!.days, 1);
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
    ...daily({ count: 30, days: 7, dUtil: 0.5, weightedPerPct: opts.baseWeighted, rawPerPct: opts.baseRaw, model: 'A', endT: NOW - 4 * DAY }),
    ...daily({ count: 10, days: 2, dUtil: 0.5, weightedPerPct: opts.curWeighted, rawPerPct: opts.curRaw, model: 'A', endT: NOW - MIN })
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
      ...daily({ count: 30, days: 7, dUtil: 0.5, weightedPerPct: 900_000, rawPerPct: 2_000_000, model: 'A', endT: NOW - 4 * DAY }),
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
      daily({ count: 10, days: 2, dUtil: 0.5, weightedPerPct: 1_500_000, rawPerPct: 3_000_000, model: 'A', endT: NOW - MIN }),
      'A', NOW
    );
    assert.strictEqual(row.verdict, 'thin');
    assert.strictEqual(row.weightedPerPct, 1_500_000);
    assert.strictEqual(row.baselineWeightedPerPct, null);
    assert.strictEqual(row.deviationPct, null);
  })) p++; else f++;

  if (test('a one-day baseline is thin, and its day count is still reported', () => {
    const row = driftRow([
      ...series({ count: 60, dUtil: 65 / 60, weightedPerPct: 163_184, rawPerPct: 1_126_873, model: 'A', endT: NOW - 4 * DAY }),
      ...daily({ count: 12, days: 3, dUtil: 0.5, weightedPerPct: 219_654, rawPerPct: 1_468_790, model: 'A', endT: NOW - MIN })
    ], 'A', NOW);
    assert.strictEqual(row.verdict, 'thin', 'one startup day is not a baseline');
    assert.strictEqual(row.deviationPct, null);
    assert.strictEqual(row.baselineWeightedPerPct, null, 'refused, so never published');
    assert.strictEqual(row.baselineDays, 1, 'but the card can say why it went quiet');
    assert.strictEqual(row.days, 3);
  })) p++; else f++;

  if (test('a one-day current window is thin too, and the baseline is still reported', () => {
    // The mirror of the case above: the day floor binds on both sides, and the
    // evidence surviving the refusal is the half a card can act on.
    const row = driftRow([
      ...daily({ count: 30, days: 7, dUtil: 0.5, weightedPerPct: 900_000, rawPerPct: 2_000_000, model: 'A', endT: NOW - 4 * DAY }),
      ...series({ count: 10, dUtil: 0.5, weightedPerPct: 1_500_000, rawPerPct: 3_000_000, model: 'A', endT: NOW - MIN })
    ], 'A', NOW);
    assert.strictEqual(row.verdict, 'thin');
    assert.strictEqual(row.weightedPerPct, null, '10 intervals in one morning is not 3 days');
    assert.strictEqual(row.days, 1);
    assert.strictEqual(row.baselineWeightedPerPct, 900_000);
    assert.strictEqual(row.baselineDays, 7);
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

  // ── the two-term fit: tokens and requests, separated ──

  if (test('the documented split thresholds', () => {
    assert.deepStrictEqual(SPLIT_FLOORS, { minIntervals: 20, minUtil: 10, minDays: 1 });
    assert.strictEqual(SPLIT_MAX_R2, 0.99);
    assert.strictEqual(SPLIT_RANK_TOL, 1e-3);
    assert.strictEqual(SPLIT_MIN_INDEPENDENT_SHARE, 0.1);
  })) p++; else f++;

  if (test('MUTATION: two models used together are refused, not published wrong', () => {
    // The failure this whole feature exists to avoid: two models always used
    // together, neither own-r² nor the rank tolerance firing, and a *confident*
    // cross-model ratio published off the back of an ill-conditioned solve.
    const ill = coupledPair(0.99);
    const found = explainSplits(ill, FIT_FROM, NOW);
    const a = found.find(d => d.model === 'A');
    const b = found.find(d => d.model === 'B');
    assert.ok(a && b, 'both models must be diagnosed');

    // Neither existing gate sees this: each model's own token-vs-request r² is
    // far under the ceiling, and both columns survive the rank pass.
    assert.ok(a.r2 < SPLIT_MAX_R2, `A own r² was ${a.r2}`);
    assert.ok(b.r2 < SPLIT_MAX_R2, `B own r² was ${b.r2}`);
    assert.ok(a.raw && b.raw, 'both were in the solve — this is not rank deficiency');

    // The mutation, run rather than asserted about: `raw` is exactly what a
    // build with no conditioning guard would have published on these two rows.
    const aErr = Math.abs(a.raw.pctPerMWeighted - PAIR_TRUTH.A.perMTok) / PAIR_TRUTH.A.perMTok;
    const bErr = Math.abs(b.raw.pctPerMWeighted - PAIR_TRUTH.B.perMTok) / PAIR_TRUTH.B.perMTok;
    assert.ok(aErr > 0.25, `A must be badly wrong unguarded, was off ${(aErr * 100).toFixed(0)}%`);
    assert.ok(bErr > 0.1, `B must be wrong unguarded, was off ${(bErr * 100).toFixed(0)}%`);
    const trueRatio = PAIR_TRUTH.A.perMTok / PAIR_TRUTH.B.perMTok;
    const rawRatio = a.raw.pctPerMWeighted / b.raw.pctPerMWeighted;
    assert.ok(rawRatio / trueRatio > 1.4,
      `the unguarded cross-model ratio must be materially wrong: ${rawRatio.toFixed(3)} vs ${trueRatio.toFixed(3)}`);

    // The guard: nothing is published, and the reason is named.
    assert.strictEqual(a.refusal, 'unidentified');
    assert.strictEqual(b.refusal, 'unidentified');
    assert.strictEqual(a.fit, null);
    assert.strictEqual(b.fit, null);
    assert.strictEqual(fitSplits(ill, FIT_FROM, NOW).size, 0, 'no row may carry a coefficient here');
    assert.ok(a.independentShare < SPLIT_MIN_INDEPENDENT_SHARE, `A share ${a.independentShare}`);
    assert.ok(b.independentShare < SPLIT_MIN_INDEPENDENT_SHARE, `B share ${b.independentShare}`);
  })) p++; else f++;

  if (test('the survivor of a dropped column is refused too, not left absorbing it', () => {
    // At this coupling the rank pass does drop one of the two token columns —
    // and whoever is left has quietly absorbed the other model's utilization,
    // so a guard that only measured columns against *earlier* ones would
    // publish it. Measured unguarded: 1.46 pt/Mtok against a truth of 0.50.
    const found = explainSplits(coupledPair(0.999), FIT_FROM, NOW);
    const dropped = found.filter(d => d.raw === null);
    assert.strictEqual(dropped.length, 1, 'exactly one model should lose a column to the rank pass');
    const survivor = found.find(d => d.raw !== null);
    assert.ok(survivor?.raw);
    const err = Math.abs(survivor.raw.pctPerMWeighted - PAIR_TRUTH.A.perMTok) / PAIR_TRUTH.A.perMTok;
    assert.ok(err > 0.5, `the survivor must be badly wrong unguarded, was off ${(err * 100).toFixed(0)}%`);
    assert.strictEqual(survivor.refusal, 'unidentified', 'and it must be refused all the same');
    assert.strictEqual(fitSplits(coupledPair(0.999), FIT_FROM, NOW).size, 0);
  })) p++; else f++;

  if (test('the same fixture without the coupling fits both models', () => {
    // The complement, so the refusal above is about conditioning and not about
    // the noise, the interval count or the `mixed` kind.
    const fine = coupledPair(0);
    const fits = fitSplits(fine, FIT_FROM, NOW);
    for (const [model, truth] of Object.entries(PAIR_TRUTH)) {
      const fit = fits.get(model);
      assert.ok(fit, `${model} must fit when its columns are independent`);
      const tokErr = Math.abs(fit.pctPerMWeighted - truth.perMTok) / truth.perMTok;
      const reqErr = Math.abs(fit.pctPerRequest - truth.perRequest) / truth.perRequest;
      assert.ok(tokErr < 0.02, `${model} token term off by ${(tokErr * 100).toFixed(2)}%`);
      assert.ok(reqErr < 0.02, `${model} request term off by ${(reqErr * 100).toFixed(2)}%`);
    }
    for (const d of explainSplits(fine, FIT_FROM, NOW)) {
      assert.ok(d.independentShare > SPLIT_MIN_INDEPENDENT_SHARE * 2,
        `${d.model} share ${d.independentShare} should clear the floor comfortably`);
    }
  })) p++; else f++;

  if (test('each refusal is named, and named the most informative way', () => {
    const reason = (intervals: Interval[], model = 'A'): string | null | undefined => {
      const found = explainSplits(intervals, FIT_FROM, NOW).find(d => d.model === model);
      return found === undefined ? 'absent' : found.refusal;   // null means fitted
    };

    assert.strictEqual(reason(splitSeries(19)), 'thin-evidence');
    assert.strictEqual(reason(splitSeries(30)), null, 'a fitted model has no refusal');

    const collinear = Array.from({ length: 30 }, (_, i) => {
      const mtok = 1 + (i % 5) * 0.5;
      return split({
        toT: NOW - (i + 1) * MIN, dUtil: 1.5 * mtok, model: 'A', mtok, reqs: 50 * mtok
      });
    });
    assert.strictEqual(reason(collinear), 'collinear');

    const negative = Array.from({ length: 30 }, (_, i) => split({
      toT: NOW - (i + 1) * MIN, dUtil: i % 2 === 0 ? 1.0 : 0.8,
      model: 'A', mtok: 1, reqs: i % 2 === 0 ? 100 : 200
    }));
    assert.strictEqual(reason(negative), 'negative');
    const raw = explainSplits(negative, FIT_FROM, NOW)[0].raw;
    assert.ok(raw && raw.pctPerRequest < 0, 'the impossible number is kept for the probe to name');
  })) p++; else f++;

  if (test('a model seen once does not make every other model thin', () => {
    // Measured live: one model with a single interval left the joint solve
    // rank-deficient, and *every* model reported no split. Only the column it
    // cannot identify may be dropped.
    const rare = split({ toT: NOW - 90 * MIN, dUtil: 0.9, model: 'Z', mtok: 0.2, reqs: 9 });
    const fits = fitSplits([...splitSeries(30), rare], FIT_FROM, NOW);
    assert.ok(fits.get('A'), 'A must still fit alongside a one-interval model');
    assert.ok(Math.abs(fits.get('A')!.pctPerMWeighted - TRUE_PCT_PER_MTOK) / TRUE_PCT_PER_MTOK < 0.05);
    assert.strictEqual(fits.get('Z'), undefined, 'and Z itself reports nothing');
  })) p++; else f++;

  if (test('both coefficients are recovered from a fixture generated with them', () => {
    const fits = fitSplits(splitSeries(30), FIT_FROM, NOW);
    const fit = fits.get('A');
    assert.ok(fit, 'a 30-interval fixture with separable regressors must fit');
    const tokErr = Math.abs(fit.pctPerMWeighted - TRUE_PCT_PER_MTOK) / TRUE_PCT_PER_MTOK;
    const reqErr = Math.abs(fit.pctPerRequest - TRUE_PCT_PER_REQUEST) / TRUE_PCT_PER_REQUEST;
    assert.ok(tokErr < 0.05, `token term off by ${(tokErr * 100).toFixed(2)}%: ${fit.pctPerMWeighted}`);
    assert.ok(reqErr < 0.05, `request term off by ${(reqErr * 100).toFixed(2)}%: ${fit.pctPerRequest}`);
    assert.strictEqual(fit.intervals, 30);
  })) p++; else f++;

  if (test('MUTATION: dropping the request term misses the token rate by 2.8x', () => {
    // The mutation, run rather than asserted about: the one-regressor OLS of
    // the *same* fixture — which is what the pooled single ratio is — and it
    // must not land near the truth, or the case above proves nothing.
    const intervals = splitSeries(30);
    let sww = 0, swy = 0, weighted = 0, utilSum = 0;
    for (const interval of intervals) {
      const w = interval.tok.A.in / 1_000_000;
      sww += w * w;
      swy += w * interval.dUtil;
      weighted += interval.tok.A.in;
      utilSum += interval.dUtil;
    }
    const oneTerm = swy / sww;
    const err = Math.abs(oneTerm - TRUE_PCT_PER_MTOK) / TRUE_PCT_PER_MTOK;
    assert.ok(err > 0.5, `one regressor must be badly wrong here, was off by ${(err * 100).toFixed(0)}%`);

    // And the shipped pooled ratio, in its own units, is wrong the same way:
    // 2.0M weighted per point is the truth, and it reports ~714k.
    const pooled = weighted / utilSum;
    const truth = 1_000_000 / TRUE_PCT_PER_MTOK;
    assert.ok(pooled < truth * 0.5, `pooled ${Math.round(pooled)} should be far under ${truth}`);
  })) p++; else f++;

  if (test('mixed intervals feed the fit — that is where the information is', () => {
    const fits = fitSplits(splitSeries(30, 'A', 'mixed'), FIT_FROM, NOW);
    const fit = fits.get('A');
    assert.ok(fit, 'dominance is not required by a joint fit');
    assert.ok(Math.abs(fit.pctPerMWeighted - TRUE_PCT_PER_MTOK) / TRUE_PCT_PER_MTOK < 0.05);
  })) p++; else f++;

  if (test('gap and external intervals never feed it', () => {
    for (const kind of ['gap', 'external'] as const) {
      assert.strictEqual(fitSplits(splitSeries(30, 'A', kind), FIT_FROM, NOW).size, 0, kind);
    }
  })) p++; else f++;

  if (test('an interval with unrecorded counts is dropped, and a whole ledger of them fits nothing', () => {
    const noCounts = splitSeries(30).map(i => ({ ...i, req: {}, reqUsable: false }));
    assert.strictEqual(fitSplits(noCounts, FIT_FROM, NOW).size, 0, 'no counts recorded → no split, ever');

    const one = splitSeries(30);
    one[0] = { ...one[0], reqUsable: false };
    assert.strictEqual(fitSplits(one, FIT_FROM, NOW).get('A')!.intervals, 29,
      'the other 29 still fit; only the poisoned interval is out');
  })) p++; else f++;

  if (test('requests as an exact multiple of tokens yields no split, not a confident one', () => {
    const collinear = Array.from({ length: 30 }, (_, i) => {
      const mtok = 1 + (i % 5) * 0.5;
      const reqs = 50 * mtok;                       // perfectly proportional
      return split({
        toT: NOW - (i + 1) * MIN,
        dUtil: TRUE_PCT_PER_MTOK * mtok + TRUE_PCT_PER_REQUEST * reqs,
        model: 'A', mtok, reqs
      });
    });
    assert.strictEqual(fitSplits(collinear, FIT_FROM, NOW).size, 0,
      'two columns that are one column cannot be split apart');
  })) p++; else f++;

  if (test('a fit whose only honest answer is negative is refused, not clamped', () => {
    // Two distinct (tokens, requests) points, solvable exactly: utilization
    // *falls* as requests rise, so the per-request coefficient is -0.002.
    const negative = Array.from({ length: 30 }, (_, i) => split({
      toT: NOW - (i + 1) * MIN,
      dUtil: i % 2 === 0 ? 1.0 : 0.8,
      model: 'A', mtok: 1, reqs: i % 2 === 0 ? 100 : 200
    }));
    assert.strictEqual(fitSplits(negative, FIT_FROM, NOW).size, 0,
      'a negative per-request cost is impossible — report nothing, never a clamped 0');

    // The same shape with the sign the other way up does fit, so the refusal
    // above is about the sign and not about the fixture.
    const positive = negative.map(i => ({ ...i, dUtil: i.req.A === 100 ? 1.0 : 1.2 }));
    const fit = fitSplits(positive, FIT_FROM, NOW).get('A');
    assert.ok(fit, 'the mirror fixture must fit');
    assert.ok(Math.abs(fit.pctPerRequest - 0.002) < 1e-9, `per-request was ${fit.pctPerRequest}`);
    assert.ok(Math.abs(fit.pctPerMWeighted - 0.8) < 1e-9, `per-Mtok was ${fit.pctPerMWeighted}`);
  })) p++; else f++;

  if (test('both split floors bind independently', () => {
    assert.strictEqual(fitSplits(splitSeries(19), FIT_FROM, NOW).size, 0, '19 intervals is under the count floor');
    assert.ok(fitSplits(splitSeries(20), FIT_FROM, NOW).get('A'), '20 is the floor');

    // 20 intervals whose utilization sums to 4 points — under minUtil 10.
    const faint = splitSeries(20).map(i => ({ ...i, dUtil: i.dUtil * 0.05 }));
    assert.ok(faint.reduce((s, i) => s + i.dUtil, 0) < SPLIT_FLOORS.minUtil);
    assert.strictEqual(fitSplits(faint, FIT_FROM, NOW).size, 0, 'movement floor binds on its own');
  })) p++; else f++;

  if (test('two models are fitted jointly, each keeping its own coefficients', () => {
    const a = splitSeries(30, 'A');
    // B spends half the tokens per request that A does, so its per-token cost
    // is double — the case a single pooled ratio cannot separate from A's.
    const b = Array.from({ length: 30 }, (_, i) => {
      const mtok = 0.5 + (i % 4) * 0.25;
      const reqs = 30 + ((i * 5) % 9) * 12;
      return split({
        toT: NOW - (i + 31) * MIN,
        dUtil: 1.2 * mtok + 0.03 * reqs,
        model: 'B', mtok, reqs
      });
    });
    const fits = fitSplits([...a, ...b], FIT_FROM, NOW);
    assert.ok(Math.abs(fits.get('A')!.pctPerMWeighted - 0.5) < 0.005, String(fits.get('A')!.pctPerMWeighted));
    assert.ok(Math.abs(fits.get('B')!.pctPerMWeighted - 1.2) < 0.012, String(fits.get('B')!.pctPerMWeighted));
    assert.ok(Math.abs(fits.get('B')!.pctPerRequest - 0.03) < 0.0003, String(fits.get('B')!.pctPerRequest));
  })) p++; else f++;

  if (test('the fit reads only its own window', () => {
    const old = splitSeries(30).map(i => ({ ...i, fromT: i.fromT - 5 * DAY, toT: i.toT - 5 * DAY }));
    assert.strictEqual(fitSplits(old, FIT_FROM, NOW).size, 0, 'everything is older than the window');
    assert.ok(fitSplits(old, NOW - 6 * DAY, NOW).get('A'), 'and inside a wider one it fits');
  })) p++; else f++;

  if (test('no usable intervals at all is an empty map, never a throw', () => {
    assert.strictEqual(fitSplits([], 0, NOW).size, 0);
    assert.strictEqual(fitSplits([kinded(NOW - MIN, 1, 'idle')], 0, NOW).size, 0);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
