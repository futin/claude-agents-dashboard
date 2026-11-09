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

import type { TokenCounts } from '../server/lib/usage-ledger.js';
import {
  CURRENT_FLOORS,
  SPLIT_MIN_INDEPENDENT_SHARE,
  SEPARATION_S_CAP,
  SUB_ERR,
  explainRates,
  fitRates,
  poolRate,
  rateFor,
  separatedRate
} from '../server/lib/usage-rate.js';
import type { Interval, RateFloors, SeparationContext } from '../server/lib/usage-rate.js';
import type { ModelRateSurface } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
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
  const ctxOf = (horizon: Record<string, number>, current: Record<string, number> = {}): SeparationContext =>
    ({ horizon: new Map(Object.entries(horizon)), current: new Map(Object.entries(current)) });
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

  if (test('separated [5]: the sensitivity cap marks the minor partner mixed, from both sides of one pair', () => {
    const forty = pair(3, 2);
    const a40 = sep(forty, 'A', AB)!;
    assert.strictEqual(a40.thinReason, 'mixed', 'B priced at 40% of U');
    within1(a40.weightedPerPct, 500_000, 'figure carried');
    assert.strictEqual(sep(forty, 'B', AB)!.thinReason, 'mixed', 'A priced at 60% of U');
    const bQuarter = pair(3, 1);
    assert.strictEqual(sep(bQuarter, 'A', AB)!.thinReason, null);
    assert.strictEqual(sep(bQuarter, 'B', AB)!.thinReason, 'mixed');
    const aQuarter = pair(1, 3);
    const b = sep(aQuarter, 'B', AB)!;
    assert.strictEqual(b.thinReason, null);
    within1(b.weightedPerPct, 100_000, 'B rated');
    assert.strictEqual(sep(aQuarter, 'A', AB)!.thinReason, 'mixed');
  })) p++; else f++;

  if (test('separated [5]: SEPARATION_S_CAP is derived — 0.34 at 15%/20, exactly the 10% move point', () => {
    assert.strictEqual(SUB_ERR, 0.15);
    assert.ok(Math.abs(SEPARATION_S_CAP - 0.34) < 0.001, `cap ${SEPARATION_S_CAP}`);
    const move = (s: number): number => {
      const ivs = pair(1 - s, s, 10);
      const base = sep(ivs, 'A', AB)!.weightedPerPct!;
      const scaled = sep(ivs, 'A', ctxOf({ A: 500_000 * 0.85, B: 100_000 * 0.85 }))!.weightedPerPct!;
      return Math.abs(scaled / base - 1);
    };
    assert.ok(move(0.34) <= 0.10 + 1e-9, `at 0.34 moved ${move(0.34)}`);
    assert.ok(Math.abs(move(0.34) - 0.10) < 1e-9, 'exactly 10% at the cap');
    assert.ok(move(0.36) > 0.10, `at 0.36 moved ${move(0.36)}`);
    assert.ok(Math.abs(move(0.36) - 0.110) < 0.001, `≈11.0% at 0.36, got ${move(0.36)}`);
  })) p++; else f++;

  if (test('separated [5b]: a neighbour repriced by more than DRIFT_PCT marks the span repriced, only when asked', () => {
    const ivs = knownMix();
    const moved = ctxOf({ B: 100_000 }, { B: 130_000 });
    assert.strictEqual(sep(ivs, 'A', moved, { checkRepriced: true })!.thinReason, 'repriced');
    assert.strictEqual(sep(ivs, 'A', moved)!.thinReason, null, 'not checked without checkRepriced');
    assert.strictEqual(sep(ivs, 'A', ctxOf({ B: 100_000 }, { B: 115_000 }), { checkRepriced: true })!.thinReason, null, '15% is inside');
    assert.strictEqual(sep(ivs, 'A', ctxOf({ B: 100_000 }), { checkRepriced: true })!.thinReason, null, 'no current fit, no evidence');
    const bLed = pair(1, 3);
    const selfMoved = ctxOf({ A: 500_000, B: 100_000 }, { A: 500_000, B: 130_000 });
    assert.strictEqual(sep(bLed, 'B', selfMoved, { checkRepriced: true })!.thinReason, null, 'never looks at M itself');
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
    assert.ok(under.utilSum < 5 && under.pricedOutShare! < SEPARATION_S_CAP);
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
