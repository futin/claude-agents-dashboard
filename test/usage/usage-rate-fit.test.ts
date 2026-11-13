/**
 * The one-term joint fit — a weighted rate per model, over the mixed windows
 * the pooled dominance rate throws away.
 *
 * Every fixture generates `dUtil` from known per-model coefficients, so the
 * expected values here are exact arithmetic rather than eyeballed output. The
 * cases that matter are the refusals: a fit that publishes a number it cannot
 * justify is worse than one that publishes nothing.
 */

import assert from 'node:assert';

import type { TokenCounts } from '../../server/lib/usage-ledger.js';
import {
  BASELINE_MS,
  CURRENT_FLOORS,
  DRIFT_PCT,
  SPLIT_MIN_INDEPENDENT_SHARE,
  SUB_BOOTSTRAP,
  SUB_ERR,
  bootstrapBands,
  errorBand,
  explainRates,
  fitRates,
  poolRate,
  rateFor,
  resetSeparationMemo,
  separatedRate,
  separationContext
} from '../../server/lib/usage-rate.js';
import type { ErrorBand, Interval, RateFloors, SeparationContext } from '../../server/lib/usage-rate.js';
import type { ModelRateSurface } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  // The bands are memoized per clock hour and model set; every fixture here shares NOW, so each case starts cold.
  resetSeparationMemo();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-04T12:00:00.000Z');
/** Wide enough to hold every fixture below, which spans at most a few days. */
const FIT_FROM = NOW - 30 * DAY;

/** No floor at all — for the cases that are about identification, not confidence. */
const NO_FLOOR: RateFloors = { minIntervals: 1, minUtil: 0, minDays: 0 };

/** `weighted` weighted tokens exactly — `in` weighs 1, so it reads off the fixture. */
const wtok = (weighted: number): TokenCounts => ({ in: weighted, out: 0, cc: 0, cr: 0 });

/** Relative closeness, so a coefficient recovered by least squares can be pinned exactly. */
function near(actual: number, expected: number, what: string): void {
  const err = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(err < 1e-6, `${what}: got ${actual}, expected ${expected} (rel err ${err})`);
}

/** The truth every fixture below generates its utilization from, in pt per Mtok. */
const TRUTH: Record<string, number> = { A: 2, B: 5 };

/**
 * One interval carrying `mtok` millions of weighted tokens per model, with
 * `dUtil` generated from {@link TRUTH} unless overridden.
 *
 * `kind` defaults to whichever model holds the tokens when there is one, and
 * `mixed` when two do — the same call `joinIntervals` would have made.
 */
function iv(opts: {
  toT: number;
  mtok: Record<string, number>;
  kind?: Interval['kind'];
  dUtil?: number;
  reqUsable?: boolean;
}): Interval {
  const names = Object.keys(opts.mtok);
  const tok: Record<string, TokenCounts> = {};
  for (const [model, m] of Object.entries(opts.mtok)) tok[model] = wtok(m * 1_000_000);
  let dUtil = opts.dUtil;
  if (dUtil === undefined) {
    dUtil = 0;
    for (const [model, m] of Object.entries(opts.mtok)) dUtil += (TRUTH[model] ?? 0) * m;
  }
  return {
    fromT: opts.toT - MIN,
    toT: opts.toT,
    dUtil,
    tok,
    req: {},
    reqUsable: opts.reqUsable ?? true,
    kind: opts.kind ?? (names.length === 1 ? { model: names[0] } : 'mixed')
  };
}

/**
 * The separable base fixture: A alone in 10 intervals, B alone in 10, and both
 * together in 10 mixed ones, spread over 3 UTC dates so every model clears
 * `CURRENT_FLOORS` on all three counts.
 *
 * The token amounts walk on co-prime cycles so the two columns are far from
 * collinear — 10 intervals where only A spends already guarantee that, but the
 * mixed block is where the identification actually comes from.
 */
function separable(): Interval[] {
  const out: Interval[] = [];
  const at = (i: number): number => NOW - (i % 3) * DAY - Math.floor(i / 3) * MIN - MIN;
  for (let i = 0; i < 10; i++) out.push(iv({ toT: at(i), mtok: { A: 1 + (i % 5) * 0.5 } }));
  for (let i = 0; i < 10; i++) out.push(iv({ toT: at(i) - 30 * MIN, mtok: { B: 0.8 + (i % 4) * 0.3 } }));
  for (let i = 0; i < 10; i++) {
    out.push(iv({
      toT: at(i) - 60 * MIN,
      mtok: { A: 1 + (i % 5) * 0.4, B: 0.5 + (i % 7) * 0.25 }
    }));
  }
  return out;
}

const findRate = (intervals: Interval[], model: string) =>
  explainRates(intervals, FIT_FROM, NOW + MIN).find(d => d.model === model)!;

export function run(): number {
  console.log('\n=== usage-rate.ts (one-term joint fit) ===\n');
  let p = 0, f = 0;

  if (test('two separable models are recovered exactly, mixed windows included', () => {
    const found = explainRates(separable(), FIT_FROM, NOW + MIN);
    assert.deepStrictEqual(found.map(d => d.model), ['A', 'B']);
    for (const d of found) {
      assert.strictEqual(d.refusal, null, `${d.model} was refused: ${d.refusal}`);
      near(d.fit!.pctPerMWeighted, TRUTH[d.model], `${d.model} coefficient`);
    }
    near(found[0].fit!.weightedPerPct, 500_000, 'A weighted per 1%');
    near(found[1].fit!.weightedPerPct, 200_000, 'B weighted per 1%');
    // Evidence is counted over the rows the model actually spent in — its own
    // 10 plus the 10 shared ones, not the whole design.
    assert.strictEqual(found[0].intervals, 20);
    assert.strictEqual(found[1].intervals, 20);
    assert.strictEqual(found[0].days, 3);
  })) p++; else f++;

  if (test('a model that never dominates a window gets a rate — the case this fit exists for', () => {
    // B is in 12 mixed intervals and never holds more than half their weighted
    // tokens, so `DOMINANCE` gives it no interval and the pooled rate refuses
    // it under *any* floors. The joint fit still recovers its coefficient.
    const out: Interval[] = [];
    for (let i = 0; i < 12; i++) {
      const toT = NOW - (i % 3) * DAY - Math.floor(i / 3) * MIN - MIN;
      out.push(iv({ toT, mtok: { A: 2 + (i % 5) * 0.5 } }));
      out.push(iv({ toT: toT - 20 * MIN, mtok: { A: 2 + (i % 4) * 0.6, B: 0.7 + (i % 7) * 0.2 } }));
    }
    assert.strictEqual(rateFor(out, 'B', FIT_FROM, NOW + MIN, NO_FLOOR), null,
      'B owns no interval, so there is no pooled rate to be had at any floor');
    assert.ok(rateFor(out, 'A', FIT_FROM, NOW + MIN, NO_FLOOR), 'A does own its own windows');

    const fits = fitRates(out, FIT_FROM, NOW + MIN);
    assert.ok(fits.get('B'), 'B has to reach the joint fit: ' + JSON.stringify(findRate(out, 'B')));
    near(fits.get('B')!.pctPerMWeighted, TRUTH.B, 'B coefficient');
    near(fits.get('B')!.weightedPerPct, 200_000, 'B weighted per 1%');
  })) p++; else f++;

  if (test('a collinear pair is refused, and the independence gate is what refuses it', () => {
    // Every interval spends twice as much on B as on A, so the two columns are
    // the same unit vector and no data can separate them.
    const out = Array.from({ length: 30 }, (_, i) => {
      const a = 1 + (i % 5) * 0.4;
      return iv({ toT: NOW - (i % 3) * DAY - Math.floor(i / 3) * MIN - MIN, mtok: { A: a, B: 2 * a } });
    });
    const found = explainRates(out, FIT_FROM, NOW + MIN);
    for (const d of found) {
      assert.strictEqual(d.refusal, 'unidentified', `${d.model}: ${JSON.stringify(d)}`);
      assert.strictEqual(d.fit, null, `${d.model} must publish nothing`);
    }
    assert.strictEqual(fitRates(out, FIT_FROM, NOW + MIN).size, 0);
    // The mutation this test is here for: without the independence comparison,
    // A keeps the coefficient the solve handed it and would be published. Both
    // models clear the floors, so `thin-evidence` cannot be doing the work.
    const a = found.find(d => d.model === 'A')!;
    assert.ok(a.intervals >= CURRENT_FLOORS.minIntervals && a.days >= CURRENT_FLOORS.minDays,
      'the floors must not be what refuses A here');
    assert.ok(a.raw !== null, 'least squares did hand A a coefficient');
    assert.ok(a.independentShare < SPLIT_MIN_INDEPENDENT_SHARE,
      `A's independent share is ${a.independentShare}, so the gate is what refused it`);
  })) p++; else f++;

  if (test('a negative coefficient is refused, not clamped to zero', () => {
    // B's tokens are generated against the utilization: the more B spends, the
    // less the window moved, which least squares can only explain with a
    // negative cost per token.
    const out = Array.from({ length: 30 }, (_, i) => {
      const a = 1 + (i % 5) * 0.4;
      const b = 3 - (i % 7) * 0.3;
      return iv({
        toT: NOW - (i % 3) * DAY - Math.floor(i / 3) * MIN - MIN,
        mtok: { A: a, B: b },
        dUtil: TRUTH.A * a - 1.5 * b + 6
      });
    });
    const b = findRate(out, 'B');
    assert.strictEqual(b.refusal, 'negative', JSON.stringify(b));
    assert.strictEqual(b.fit, null, 'a clamped zero would publish an infinite price');
    assert.ok(b.raw !== null && b.raw < 0, `the signed value is kept for the probe: ${b.raw}`);
  })) p++; else f++;

  if (test('the floors bite at the documented boundary, days included', () => {
    /** `count` A-only intervals over `days` UTC dates, at `mtok` each. */
    const run9 = (count: number, days: number, mtok = 1.5): Interval[] => Array.from(
      { length: count },
      (_, i) => iv({
        toT: NOW - (i % days) * DAY - Math.floor(i / days) * MIN - MIN,
        mtok: { A: mtok }
      })
    );
    // 9 intervals × 1.5 Mtok × 2 pt/Mtok = 27 points over 2 dates: perfectly
    // identified, over the movement floor, and still one interval short.
    const nine = findRate(run9(9, 2), 'A');
    assert.strictEqual(nine.intervals, 9);
    assert.strictEqual(nine.refusal, 'thin-evidence', JSON.stringify(nine));
    const ten = findRate(run9(10, 2), 'A');
    assert.strictEqual(ten.intervals, 10);
    assert.strictEqual(ten.refusal, null, JSON.stringify(ten));
    near(ten.fit!.weightedPerPct, 500_000, 'the rate at exactly the floor');
    // The mirror: a day floor that only ever passes is a decoration.
    const oneDay = findRate(run9(10, 1), 'A');
    assert.strictEqual(oneDay.days, 1);
    assert.strictEqual(oneDay.refusal, 'thin-evidence', 'ten windows in one day is one day of habit');
    // And the movement floor alone, at 10 intervals over 2 dates: 10 × 0.2
    // Mtok × 2 = 4.0 points, under `CURRENT_FLOORS.minUtil` of 5.
    const faint = findRate(run9(10, 2, 0.2), 'A');
    near(faint.utilSum, 4, 'the fixture has to sit under the movement floor');
    assert.strictEqual(faint.refusal, 'thin-evidence');
  })) p++; else f++;

  if (test('external and unpriced intervals are out; idle intervals are in and move the answer', () => {
    const base = separable();
    const baseline = findRate(base, 'A').fit!.weightedPerPct;
    const loud = { A: 40 };
    for (const kind of ['external', 'gap', 'partial', 'pre-ledger'] as const) {
      const withIt = [...base, iv({ toT: NOW - 5 * MIN, mtok: loud, dUtil: 30, kind })];
      near(findRate(withIt, 'A').fit!.weightedPerPct, baseline, `a ${kind} interval must change nothing`);
    }
    // An idle interval carrying real tokens and no movement is a measurement,
    // and dropping it would be selection on the dependent variable. It drags
    // the coefficient down, so the published rate — its reciprocal — goes up.
    const withIdle = [...base, iv({ toT: NOW - 5 * MIN, mtok: { A: 3 }, dUtil: 0, kind: 'idle' })];
    const raised = findRate(withIdle, 'A').fit!.weightedPerPct;
    assert.ok(raised > baseline, `idle rows must raise the rate: ${raised} vs ${baseline}`);
  })) p++; else f++;

  if (test('reqUsable: false does not exclude an interval — the copy-usableForSplit regression', () => {
    const counted = separable();
    const uncounted = counted.map(interval => ({ ...interval, reqUsable: false }));
    const a = explainRates(counted, FIT_FROM, NOW + MIN);
    const b = explainRates(uncounted, FIT_FROM, NOW + MIN);
    assert.deepStrictEqual(b.map(d => d.model), a.map(d => d.model));
    for (let i = 0; i < a.length; i++) {
      assert.strictEqual(b[i].refusal, null, `${b[i].model} was refused without its request counts`);
      near(b[i].fit!.pctPerMWeighted, a[i].fit!.pctPerMWeighted, `${b[i].model} coefficient`);
      assert.strictEqual(b[i].intervals, a[i].intervals);
    }
  })) p++; else f++;

  if (test('the window is half-open on toT: sinceMs is in, untilMs is out', () => {
    // A holds the fixture up on its own; B's single interval is moved onto each
    // boundary in turn, and the tell is whether it is counted at all.
    const edge = (toT: number): Interval[] => [
      ...Array.from({ length: 12 }, (_, i) => iv({
        toT: NOW - (i % 3) * DAY - Math.floor(i / 3) * MIN - MIN,
        mtok: { A: 1 + (i % 5) * 0.5 }
      })),
      iv({ toT, mtok: { A: 1.2, B: 0.9 } })
    ];
    const at = (toT: number, since: number, until: number) =>
      explainRates(edge(toT), since, until).find(d => d.model === 'B');
    const included = at(FIT_FROM, FIT_FROM, NOW + MIN);
    assert.ok(included, 'an interval at exactly sinceMs is inside the window');
    assert.strictEqual(included.intervals, 1);
    assert.strictEqual(included.refusal, 'thin-evidence', 'one interval is under the floor either way');
    assert.strictEqual(at(NOW + MIN, FIT_FROM, NOW + MIN), undefined,
      'an interval at exactly untilMs is outside it, so B is not a model of this fit at all');
  })) p++; else f++;

  // ── separatedRate: one model's tokens against the points left once the others are priced out ──

  /** Within ±1% — the brief's tolerance for every separated figure. */
  const within1 = (actual: number | null | undefined, expected: number, what: string): void => {
    assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`);
    const err = Math.abs(actual - expected) / expected;
    assert.ok(err <= 0.01, `${what}: got ${actual}, expected ${expected} (rel err ${err})`);
  };
  /** A hand-built interval: weighted tokens per model, `kind` set by hand (idle when dUtil is 0, else owner/mixed). */
  const sv = (o: {
    toT: number; w: Record<string, number>; dUtil: number; kind?: Interval['kind'];
    surface?: ModelRateSurface; modelSurfaces?: Record<string, ModelRateSurface>;
  }): Interval => {
    const tok: Record<string, TokenCounts> = {};
    for (const [model, w] of Object.entries(o.w)) tok[model] = wtok(w);
    const names = Object.keys(o.w);
    const kind = o.kind ?? (o.dUtil === 0 ? 'idle' : names.length === 1 ? { model: names[0] } : 'mixed');
    const out: Interval = { fromT: o.toT - MIN, toT: o.toT, dUtil: o.dUtil, tok, req: {}, reqUsable: true, kind };
    if (o.surface) out.surface = o.surface;
    if (o.modelSurfaces) out.modelSurfaces = o.modelSurfaces;
    return out;
  };
  const ctxOf = (
    horizon: Record<string, number>, current: Record<string, number> = {}, error: Record<string, ErrorBand> = {}
  ): SeparationContext =>
    ({ horizon: new Map(Object.entries(horizon)), current: new Map(Object.entries(current)), error: new Map(Object.entries(error)) });
  const SINCE = NOW - 10 * DAY;
  const UNTIL = Number.POSITIVE_INFINITY;
  const D0 = NOW - 2 * DAY;
  const t = (i: number, day = 0): number => D0 + day * DAY + i * MIN;
  const sep = (ivs: Interval[], model: string, ctx: SeparationContext, opts: Partial<{
    floors: RateFloors; surface: ModelRateSurface; checkRepriced: boolean;
  }> = {}) => separatedRate(ivs, model, SINCE, UNTIL, ctx, { floors: NO_FLOOR, ...opts });

  /** [2]'s 20 mixed intervals: A 1.5M (3 pts at 500k) + B 100k (1 pt at 100k), dUtil 4. */
  const knownMix = (): Interval[] =>
    Array.from({ length: 20 }, (_, i) => sv({ toT: t(i), w: { A: 1_500_000, B: 100_000 }, dUtil: 4 }));
  /** [3]: 10 pairs of an idle interval carrying B 100k, then A-owned 2M holding the carried point (dUtil 5). */
  const carryOver = (): Interval[] => {
    const out: Interval[] = [];
    for (let i = 0; i < 10; i++) {
      out.push(sv({ toT: t(2 * i), w: { B: 100_000 }, dUtil: 0 }));
      out.push(sv({ toT: t(2 * i + 1), w: { A: 2_000_000 }, dUtil: 5 }));
    }
    return out;
  };

  if (test('separated [1]: a pure span is W/ΣdUtil with idle added back, and poolRate exactly without idle', () => {
    const owned = Array.from({ length: 5 }, (_, i) => sv({ toT: t(i), w: { A: 1_000_000 }, dUtil: 2 }));
    const idle = Array.from({ length: 3 }, (_, i) => sv({ toT: t(10 + i), w: { A: 200_000 }, dUtil: 0 }));
    const ctx = ctxOf({});
    const pure = sep(owned, 'A', ctx)!;
    assert.strictEqual(pure.weightedPerPct, poolRate(owned, 'A', SINCE, UNTIL)!.weightedPerPct);
    assert.strictEqual(pure.thinReason, null);
    const withIdle = sep([...owned, ...idle], 'A', ctx)!;
    within1(withIdle.weightedPerPct, 5_600_000 / 10, 'idle tokens added back');
    assert.strictEqual(withIdle.rawPerPct, withIdle.weightedPerPct, 'all-`in` fixture: raw = weighted');
    assert.strictEqual(withIdle.thinReason, null);
  })) p++; else f++;

  if (test('separated [2]: a known mix recovers A at 500k where poolRate has nothing', () => {
    const ivs = knownMix();
    const r = sep(ivs, 'A', ctxOf({ B: 100_000 }))!;
    within1(r.weightedPerPct, 500_000, 'A separated');
    within1(r.pricedOutShare, 0.25, 'priced-out share');
    assert.strictEqual(r.thinReason, null);
    assert.strictEqual(poolRate(ivs, 'A', SINCE, UNTIL), null, 'no owned interval');
  })) p++; else f++;

  if (test('separated [2]: carried points beside the mix still give 500k while poolRate reads 400k', () => {
    const ivs = knownMix();
    for (let i = 0; i < 5; i++) {
      ivs.push(sv({ toT: t(100 + 2 * i), w: { B: 100_000 }, dUtil: 0 }));
      ivs.push(sv({ toT: t(101 + 2 * i), w: { A: 2_000_000 }, dUtil: 5 }));
    }
    within1(poolRate(ivs, 'A', SINCE, UNTIL)!.weightedPerPct, 400_000, 'poolRate');
    const r = sep(ivs, 'A', ctxOf({ B: 100_000 }))!;
    within1(r.weightedPerPct, 40_000_000 / 80, 'W_A 40M over U 105 − 25 priced out');
    within1(r.pricedOutShare, 25 / 105, 'priced-out share');
  })) p++; else f++;

  if (test('separated [3]: carry-over onto A-owned ticks reads 400k pooled, 500k separated', () => {
    const ivs = carryOver();
    within1(poolRate(ivs, 'A', SINCE, UNTIL)!.weightedPerPct, 400_000, 'poolRate');
    const r = sep(ivs, 'A', ctxOf({ B: 100_000 }))!;
    within1(r.weightedPerPct, 500_000, 'separated');
    within1(r.pricedOutShare, 0.2, 'priced-out share');
    assert.strictEqual(r.thinReason, null);
    assert.strictEqual(r.intervals, 10, 'only the intervals A spent in');
  })) p++; else f++;

  if (test('separated [4]: the mirror — B carries A\'s points, 80k pooled, 100k separated', () => {
    const ivs: Interval[] = [];
    for (let i = 0; i < 10; i++) {
      ivs.push(sv({ toT: t(2 * i), w: { A: 500_000 }, dUtil: 0 }));
      ivs.push(sv({ toT: t(2 * i + 1), w: { B: 400_000 }, dUtil: 5 }));
    }
    within1(poolRate(ivs, 'B', SINCE, UNTIL)!.weightedPerPct, 80_000, 'poolRate');
    within1(sep(ivs, 'B', ctxOf({ A: 500_000 }))!.weightedPerPct, 100_000, 'separated');
  })) p++; else f++;

  if (test('separated: a day another model ran alone leaves A\'s figure and evidence counters unchanged', () => {
    const base = carryOver();
    const solo = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i, 1), w: { B: 1_000_000 }, dUtil: 10 }));
    const ctx = ctxOf({ B: 100_000 });
    const before = sep(base, 'A', ctx)!;
    const after = sep([...base, ...solo], 'A', ctx)!;
    within1(after.weightedPerPct, before.weightedPerPct!, 'figure');
    assert.strictEqual(after.intervals, before.intervals);
    assert.strictEqual(after.days, before.days);
    assert.strictEqual(after.days, 1);
  })) p++; else f++;

  /** Mixed intervals, A priced at 500k and B at 100k: `aPts` + `bPts` points each. */
  const pair = (aPts: number, bPts: number, n = 10): Interval[] =>
    Array.from({ length: n }, (_, i) =>
      sv({ toT: t(i), w: { A: aPts * 500_000, B: bPts * 100_000 }, dUtil: aPts + bPts }));
  const AB = ctxOf({ A: 500_000, B: 100_000 });

  if (test('separated [5]: at the 15% fallback band the minor partner is mixed, from both sides of one pair', () => {
    const forty = pair(3, 2);
    const a40 = sep(forty, 'A', AB)!;
    assert.strictEqual(a40.thinReason, 'mixed', 'B priced at 40% of U moves A 13.3%');
    within1(a40.weightedPerPct, 500_000, 'figure carried');
    assert.strictEqual(sep(forty, 'B', AB)!.thinReason, 'mixed', 'A priced at 60% of U');
    const bQuarter = pair(3, 1);
    assert.strictEqual(sep(bQuarter, 'A', AB)!.thinReason, null, 'B priced at 25% of U moves A 6.3%');
    assert.strictEqual(sep(bQuarter, 'B', AB)!.thinReason, 'mixed');
    const aQuarter = pair(1, 3);
    const b = sep(aQuarter, 'B', AB)!;
    assert.strictEqual(b.thinReason, null);
    within1(b.weightedPerPct, 100_000, 'B rated');
    assert.strictEqual(sep(aQuarter, 'A', AB)!.thinReason, 'mixed');
  })) p++; else f++;

  if (test('separated [5]: for one neighbour the fallback band is the old flat cap — s 0.34 is exactly the 10% move', () => {
    assert.strictEqual(SUB_ERR, 0.15);
    assert.strictEqual(sep(pair(0.665, 0.335), 'A', AB)!.thinReason, null, 's 0.335 is inside');
    assert.strictEqual(sep(pair(0.64, 0.36), 'A', AB)!.thinReason, 'mixed', 's 0.36 is outside');
    // The bound is what pricing B at 1 − SUB_ERR of its rate actually does to A's figure.
    const move = (s: number): number => {
      const ivs = pair(1 - s, s, 10);
      return Math.abs(sep(ivs, 'A', ctxOf({ B: 100_000 * 0.85 }))!.weightedPerPct! / sep(ivs, 'A', AB)!.weightedPerPct! - 1);
    };
    assert.ok(Math.abs(move(0.34) - 0.10) < 1e-9, `exactly 10% at 0.34, got ${move(0.34)}`);
    assert.ok(Math.abs(move(0.36) - 0.110) < 0.001, `≈11.0% at 0.36, got ${move(0.36)}`);
  })) p++; else f++;

  if (test('separated [5]: a neighbour measured to 3% can be priced out of 40% of the points', () => {
    const r = sep(pair(3, 2), 'A', ctxOf({ A: 500_000, B: 100_000 }, {}, { B: { under: 0.03, over: 0.03 } }))!;
    assert.strictEqual(r.thinReason, null);
    within1(r.weightedPerPct, 500_000, 'rated');
  })) p++; else f++;

  if (test('separated [5]: two neighbours at the fallback combine root-sum-square — 9.1% rated, the same total on one 13.3% mixed', () => {
    const ABC = ctxOf({ A: 500_000, B: 100_000, C: 100_000 });
    // A 3 points, B and C one each, of 5: s 0.40 split in half.
    const split = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 1_500_000, B: 100_000, C: 100_000 }, dUtil: 5 }));
    const two = sep(split, 'A', ABC)!;
    within1(two.pricedOutShare, 0.4, 's');
    assert.strictEqual(two.thinReason, null, 'ΔU = √2 · (1/0.85 − 1) = 0.250 of R 3: a 9.1% move');
    const lone = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 1_500_000, B: 200_000 }, dUtil: 5 }));
    const one = sep(lone, 'A', ABC)!;
    within1(one.pricedOutShare, 0.4, 's');
    assert.strictEqual(one.thinReason, 'mixed', 'ΔU = 2 · (1/0.85 − 1) = 0.353 of R 3: a 13.3% move');
  })) p++; else f++;

  if (test('separated [5]: an unmeasured neighbour (0.99 / 9) is mixed through R − ΔU ≤ 0 at 2% of U, through the ratio at 0.1%, never Infinity', () => {
    const unmeasured = ctxOf({ B: 100_000 }, {}, { B: { under: 0.99, over: 9 } });
    // B prices out 0.02 of each 1-point interval: ΔU = 0.02 · 99 = 1.98 against R = 0.98.
    const twoPct = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 490_000, B: 2_000 }, dUtil: 1 }));
    const r2 = sep(twoPct, 'A', unmeasured)!;
    within1(r2.pricedOutShare, 0.02, 's');
    assert.strictEqual(r2.thinReason, 'mixed');
    assert.ok(Number.isFinite(r2.weightedPerPct!) && Number.isFinite(r2.rawPerPct!), 'figures finite');
    within1(r2.weightedPerPct, 500_000, 'figure carried');
    assert.strictEqual(sep(twoPct, 'A', ctxOf({ B: 100_000 }))!.thinReason, null, 'the same span at the fallback band is rated');
    // 0.1%: ΔU = 0.001 · 99 = 0.099 of R 0.999 — 0.999 / 0.9 − 1 ≈ 11%.
    const tenthPct = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 499_500, B: 100 }, dUtil: 1 }));
    const r01 = sep(tenthPct, 'A', unmeasured)!;
    within1(r01.pricedOutShare, 0.001, 's');
    assert.strictEqual(r01.thinReason, 'mixed');
    // A hand-built `under` of exactly 1 is clamped to 0.99, not divided by zero.
    const clamped = sep(twoPct, 'A', ctxOf({ B: 100_000 }, {}, { B: { under: 1, over: 9 } }))!;
    assert.strictEqual(clamped.thinReason, 'mixed');
    assert.ok(Number.isFinite(clamped.weightedPerPct!), 'figure finite');
  })) p++; else f++;

  if (test('errorBand: under half the resamples is unmeasured; otherwise the nearest-rank 5th and 95th percentiles', () => {
    assert.deepStrictEqual(errorBand(Array(99).fill(1), 200), { under: 0.99, over: 9 }, '99 of 200');
    assert.deepStrictEqual(errorBand(Array(100).fill(1), 200), { under: 0, over: 0 }, 'exactly half is measured');
    assert.deepStrictEqual(errorBand(Array(200).fill(1), 200), { under: 0, over: 0 });
    assert.deepStrictEqual(errorBand([], 0), { under: 0.99, over: 9 }, 'no draws at all');
    // Nearest rank: the p-th percentile of n sorted draws is the ⌈p·n⌉-th. 51 draws 0.80, 0.81 … 1.30 (shuffled by reversing):
    // p5 is the 3rd, 0.82; p95 the 49th, 1.28.
    const spread = Array.from({ length: 51 }, (_, i) => 0.8 + i * 0.01).reverse();
    const band = errorBand(spread, 51);
    assert.ok(Math.abs(band.under - 0.18) < 1e-9, `under ${band.under}`);
    assert.ok(Math.abs(band.over - 0.28) < 1e-9, `over ${band.over}`);
    assert.strictEqual(errorBand(Array(10).fill(0.001), 10).under, 0.99, 'under clamps at 0.99');
  })) p++; else f++;

  /**
   * 14 UTC days back from NOW, each with three A-only, three B-only and three mixed intervals at 06:00. A is 500k per point every day;
   * B is `bRate(k)` on day k, so a per-day difference in B is the only spread the bootstrap can find.
   */
  const fortnight = (bRate: (k: number) => number): Interval[] => {
    const out: Interval[] = [];
    for (let k = 0; k < 14; k++) {
      const t0 = NOW - k * DAY - 6 * 60 * MIN;
      const b = bRate(k);
      for (let i = 0; i < 3; i++) {
        out.push(sv({ toT: t0 + i * MIN, w: { A: 1_000_000 * (1 + i) }, dUtil: 2 * (1 + i) }));
        out.push(sv({ toT: t0 + (10 + i) * MIN, w: { B: b * (1 + i) }, dUtil: 1 + i }));
        out.push(sv({ toT: t0 + (20 + i) * MIN, w: { A: 500_000 * (1 + i), B: b }, dUtil: 2 + i }));
      }
    }
    return out;
  };
  const alternating = (k: number): number => (k % 2 === 0 ? 400_000 : 600_000);
  const HORIZON_FROM = NOW - BASELINE_MS;

  if (test('bootstrapBands: identical days give a band under 0.5%; B alternating 400k / 600k by day gives over 2% both sides', () => {
    const flat = bootstrapBands(fortnight(() => 500_000), HORIZON_FROM, UNTIL);
    for (const model of ['A', 'B']) {
      const band = flat.get(model)!;
      assert.ok(band.under < 0.005 && band.over < 0.005, `${model}: ${JSON.stringify(band)}`);
    }
    const b = bootstrapBands(fortnight(alternating), HORIZON_FROM, UNTIL).get('B')!;
    assert.ok(b.under > 0.02 && b.over > 0.02, `B: ${JSON.stringify(b)}`);
    assert.strictEqual(SUB_BOOTSTRAP, 200);
  })) p++; else f++;

  if (test('bootstrapBands: under 3 distinct UTC days gives no band (a 2-day resample is the sample or unfittable); 3 days give a non-zero one', () => {
    const lastDays = (n: number): Interval[] => fortnight(alternating).filter(iv => iv.toT >= NOW - (n - 1) * DAY - 7 * 60 * MIN);
    assert.strictEqual(bootstrapBands(lastDays(2), HORIZON_FROM, UNTIL).size, 0, 'two noisy days: no band for any model');
    assert.strictEqual(bootstrapBands(lastDays(1), HORIZON_FROM, UNTIL).size, 0, 'one day: none either');
    const three = bootstrapBands(lastDays(3), HORIZON_FROM, UNTIL);
    const b = three.get('B')!;
    assert.ok(b && (b.under > 0 || b.over > 0), `three noisy days: a non-zero band, got ${JSON.stringify(b)}`);
  })) p++; else f++;

  if (test('bootstrapBands: seeded per call — two runs on the same intervals give deep-equal bands', () => {
    const ivs = fortnight(alternating);
    assert.deepStrictEqual(bootstrapBands(ivs, HORIZON_FROM, UNTIL), bootstrapBands(ivs, HORIZON_FROM, UNTIL));
  })) p++; else f++;

  if (test('separationContext: bands memoized per UTC hour and horizon model set — reused in the hour, rebuilt for a new model or hour', () => {
    const ivs = fortnight(alternating);
    const first = separationContext(ivs, NOW);
    assert.deepStrictEqual([...first.error.keys()].sort(), ['A', 'B']);
    const later = separationContext([...ivs, sv({ toT: NOW + 5 * MIN, w: { A: 1_000_000 }, dUtil: 2 })], NOW + 10 * MIN);
    assert.strictEqual(later.error, first.error, 'same hour, same models: the same map, not a refit');
    const withC = [...ivs];
    for (let k = 0; k < 14; k++) {
      for (let i = 0; i < 3; i++) withC.push(sv({ toT: NOW - k * DAY - 4 * 60 * MIN + i * MIN, w: { C: 200_000 * (1 + i) }, dUtil: 1 + i }));
    }
    const third = separationContext(withC, NOW + 20 * MIN);
    assert.notStrictEqual(third.error, first.error, 'a model joined the horizon');
    assert.ok(third.error.has('C'), 'and it has a band');
    const nextHour = separationContext(withC, NOW + 60 * MIN);
    assert.notStrictEqual(nextHour.error, third.error, 'a new UTC hour');
  })) p++; else f++;

  if (test('separated [5b]: a neighbour is repriced when its 3-day rate moves A > 10% — 13.3% at 40% of U, 2.5% at 10%', () => {
    // Measured tight, so the 40% span is not also mixed and "rated without checkRepriced" means something.
    const calm = { B: { under: 0.03, over: 0.03 } };
    const moved = ctxOf({ B: 500_000 }, { B: 650_000 }, calm);
    // B 2 of 5 points at 500k, 1.54 at 650k: A's residual 3 → 3.46.
    const forty = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 1_500_000, B: 1_000_000 }, dUtil: 5 }));
    within1(sep(forty, 'A', moved)!.pricedOutShare, 0.4, 's');
    assert.strictEqual(sep(forty, 'A', moved, { checkRepriced: true })!.thinReason, 'repriced');
    assert.strictEqual(sep(forty, 'A', moved)!.thinReason, null, 'not checked without checkRepriced');
    // B 0.5 of 5 points → 0.385: A's residual 4.5 → 4.615.
    const ten = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 2_250_000, B: 250_000 }, dUtil: 5 }));
    within1(sep(ten, 'A', moved)!.pricedOutShare, 0.1, 's');
    assert.strictEqual(sep(ten, 'A', moved, { checkRepriced: true })!.thinReason, null, 'the same 30% move at 10% of U');
    // B 2.5 of 5 points at 500k is 6.25 at 200k: no residual left after the swap.
    const half = Array.from({ length: 10 }, (_, i) => sv({ toT: t(i), w: { A: 1_250_000, B: 1_250_000 }, dUtil: 5 }));
    const cheaper = ctxOf({ B: 500_000 }, { B: 200_000 }, calm);
    assert.strictEqual(sep(half, 'A', cheaper)!.thinReason, null, 'rated at horizon rates');
    assert.strictEqual(sep(half, 'A', cheaper, { checkRepriced: true })!.thinReason, 'repriced');
    assert.strictEqual(sep(forty, 'A', ctxOf({ B: 500_000 }, {}, calm), { checkRepriced: true })!.thinReason, null,
      'no 3-day fit for B, no evidence it repriced');
    const selfMoved = ctxOf({ A: 500_000, B: 500_000 }, { A: 900_000, B: 500_000 }, calm);
    assert.strictEqual(sep(forty, 'A', selfMoved, { checkRepriced: true })!.thinReason, null, 'never looks at M itself');
  })) p++; else f++;

  if (test('separated [6]: an unpriced neighbour over 1% of tokens marks unpriced; 0.5% is ignored', () => {
    const five = Array.from({ length: 10 }, (_, i) =>
      sv({ toT: t(i), w: { A: 950_000, B: 50_000 }, dUtil: 2, kind: { model: 'A' } }));
    assert.strictEqual(sep(five, 'A', ctxOf({}))!.thinReason, 'unpriced');
    const half = Array.from({ length: 10 }, (_, i) =>
      sv({ toT: t(i), w: { A: 995_000, B: 5_000 }, dUtil: 2, kind: { model: 'A' } }));
    const r = sep(half, 'A', ctxOf({}))!;
    assert.strictEqual(r.thinReason, null);
    within1(r.weightedPerPct, 995_000 / 2, 'B not subtracted: W_A / U');
  })) p++; else f++;

  if (test('separated [7]: a residual under the floor is floor; exactly at it is rated; U = 0 is floor with null figures', () => {
    const floors: RateFloors = { minIntervals: 1, minUtil: 5, minDays: 0 };
    const one = (dUtil: number) => [sv({ toT: t(0), w: { A: 2_000_000, B: 50_000 }, dUtil })];
    const under = sep(one(5.4), 'A', ctxOf({ B: 100_000 }), { floors })!;
    assert.ok(under.utilSum < 5 && under.pricedOutShare! < 0.34, 'inside the sensitivity bound at the fallback band');
    assert.strictEqual(under.thinReason, 'floor');
    assert.strictEqual(sep(one(5.5), 'A', ctxOf({ B: 100_000 }), { floors })!.thinReason, null);
    const idle = Array.from({ length: 3 }, (_, i) => sv({ toT: t(i), w: { A: 100_000 }, dUtil: 0 }));
    const zero = sep(idle, 'A', ctxOf({}))!;
    assert.strictEqual(zero.thinReason, 'floor');
    assert.strictEqual(zero.weightedPerPct, null);
    assert.strictEqual(zero.rawPerPct, null);
    assert.strictEqual(zero.pricedOutShare, null);
  })) p++; else f++;

  if (test('separated [7b]: reason precedence — unpriced > repriced > mixed > floor', () => {
    const floors: RateFloors = { minIntervals: 1, minUtil: 5, minDays: 0 };
    const B100 = ctxOf({ B: 100_000 });
    const mixedUnder = [sv({ toT: t(0), w: { A: 1_000_000, B: 200_000 }, dUtil: 5 })];
    assert.strictEqual(sep(mixedUnder, 'A', B100, { floors })!.thinReason, 'mixed', 's 0.40 and residual 3');
    const negative = sep([sv({ toT: t(0), w: { A: 1_000_000, B: 300_000 }, dUtil: 2 })], 'A', B100)!;
    assert.strictEqual(negative.thinReason, 'mixed', 'residual −1');
    assert.strictEqual(negative.weightedPerPct, null);
    assert.strictEqual(negative.rawPerPct, null);
    assert.strictEqual(negative.utilSum, 0);
    const unpricedMixed = [sv({ toT: t(0), w: { A: 1_000_000, B: 100_000, C: 300_000 }, dUtil: 4 })];
    assert.strictEqual(sep(unpricedMixed, 'A', ctxOf({ C: 100_000 }))!.thinReason, 'unpriced');
    assert.strictEqual(
      sep(pair(3, 2), 'A', ctxOf({ A: 500_000, B: 100_000 }, { B: 130_000 }), { checkRepriced: true })!.thinReason,
      'repriced');
  })) p++; else f++;

  if (test('separated: a stratum is the intervals whose own A tokens the surface dominates', () => {
    const ivs: Interval[] = [];
    for (let i = 0; i < 10; i++) {
      ivs.push(sv({ toT: t(i), w: { A: 1_500_000, B: 100_000 }, dUtil: 4, modelSurfaces: { A: 'interactive', B: 'interactive' } }));
      ivs.push(sv({ toT: t(20 + i), w: { A: 900_000, B: 100_000 }, dUtil: 4, modelSurfaces: { A: 'headless' } }));
    }
    const ctx = ctxOf({ B: 100_000 });
    within1(sep(ivs, 'A', ctx, { surface: 'interactive' })!.weightedPerPct, 500_000, 'interactive');
    within1(sep(ivs, 'A', ctx, { surface: 'headless' })!.weightedPerPct, 300_000, 'headless');
    const owned: Interval[] = [];
    for (let i = 0; i < 10; i++) {
      owned.push(sv({ toT: t(i), w: { A: 1_500_000 }, dUtil: 3, surface: 'interactive' }));
      owned.push(sv({ toT: t(20 + i), w: { A: 900_000 }, dUtil: 3, surface: 'headless' }));
    }
    within1(sep(owned, 'A', ctx, { surface: 'interactive' })!.weightedPerPct, 500_000, 'owner-surface fallback, interactive');
    within1(sep(owned, 'A', ctx, { surface: 'headless' })!.weightedPerPct, 300_000, 'owner-surface fallback, headless');
  })) p++; else f++;

  if (test('separated: intervals without A are spread over A\'s strata by A\'s share — all of it to a lone stratum', () => {
    const ivs: Interval[] = [];
    for (let i = 0; i < 4; i++) {
      ivs.push(sv({ toT: t(2 * i), w: { B: 100_000 }, dUtil: 0 }));
      ivs.push(sv({ toT: t(2 * i + 1), w: { A: 2_000_000 }, dUtil: 5, modelSurfaces: { A: 'interactive' } }));
    }
    const ctx = ctxOf({ B: 100_000 });
    const span = sep(ivs, 'A', ctx)!;
    within1(span.weightedPerPct, 500_000, 'span');
    assert.strictEqual(sep(ivs, 'A', ctx, { surface: 'interactive' })!.weightedPerPct, span.weightedPerPct);
    assert.strictEqual(sep(ivs, 'A', ctx, { surface: 'headless' }), null, 'A spent nothing there');
  })) p++; else f++;

  if (test('separated: with two strata, intervals without A split by A\'s token share (0.625 / 0.375)', () => {
    const ivs: Interval[] = [];
    for (let i = 0; i < 4; i++) {
      ivs.push(sv({ toT: t(2 * i), w: { B: 100_000 }, dUtil: 0 }));
      ivs.push(sv({ toT: t(2 * i + 1), w: { A: 2_000_000 }, dUtil: 5, modelSurfaces: { A: 'interactive' } }));
      ivs.push(sv({ toT: t(20 + i), w: { A: 1_200_000 }, dUtil: 4, modelSurfaces: { A: 'headless' } }));
    }
    const ctx = ctxOf({ B: 100_000 });
    // interactive holds 8M of A's 12.8M stratified tokens: 0.625 of the 4 B points are priced out there.
    within1(sep(ivs, 'A', ctx, { surface: 'interactive' })!.weightedPerPct, 8_000_000 / (20 - 2.5), 'interactive');
    within1(sep(ivs, 'A', ctx, { surface: 'headless' })!.weightedPerPct, 4_800_000 / (16 - 1.5), 'headless');
  })) p++; else f++;

  if (test('separated [7b]: unpriced outranks repriced', () => {
    const ivs = [sv({ toT: t(0), w: { A: 1_000_000, B: 100_000, C: 100_000 }, dUtil: 4 })];
    const ctx = ctxOf({ C: 100_000 }, { C: 130_000 });
    assert.strictEqual(sep(ivs, 'A', ctx, { checkRepriced: true })!.thinReason, 'unpriced');
  })) p++; else f++;

  if (test('separated: null only when the model spent nothing in the span', () => {
    assert.strictEqual(sep(knownMix(), 'C', ctxOf({ A: 500_000, B: 100_000 })), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
