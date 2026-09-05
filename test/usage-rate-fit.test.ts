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
  explainRates,
  fitRates,
  rateFor
} from '../server/lib/usage-rate.js';
import type { Interval, RateFloors } from '../server/lib/usage-rate.js';

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

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
