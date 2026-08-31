import assert from 'node:assert';

import type { LedgerLine, TokenCounts } from '../server/lib/usage-ledger.js';
import type { UsageSample } from '../server/lib/usage-history.js';
import {
  DOMINANCE,
  EXTERNAL_WEIGHTED_MAX,
  IDLE_EPS,
  LEDGER_COVERAGE_MIN,
  joinIntervals
} from '../server/lib/usage-rate.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const R1 = '2026-08-28T23:00:00.000Z';
/** 90 seconds off R1 — inside the 2-minute slack, so the same window. */
const R1_JITTER = '2026-08-28T23:01:30.000Z';
/** Three minutes off R1 — past the slack, so a different window. */
const R1_FAR = '2026-08-28T23:03:00.000Z';
const R2 = '2026-08-29T04:00:00.000Z';

const s = (t: number, utilization: number, resetsAt: string | null = R1): UsageSample =>
  ({ t, utilization, resetsAt });

/** `in` tokens weigh exactly 1, so weighted totals read off the fixture. */
const counts = (weighted: number): TokenCounts => ({ in: weighted, out: 0, cc: 0, cr: 0 });

const l = (prevT: number, t: number, tok: Record<string, TokenCounts> = {}): LedgerLine =>
  ({ t, prevT, tok });

export function run(): number {
  console.log('\n=== usage-rate.ts (join + classify) ===\n');
  let p = 0, f = 0;

  if (test('the documented thresholds', () => {
    assert.strictEqual(DOMINANCE, 0.9);
    assert.strictEqual(IDLE_EPS, 0.01);
    assert.strictEqual(EXTERNAL_WEIGHTED_MAX, 5_000);
    assert.strictEqual(LEDGER_COVERAGE_MIN, 0.8);
  })) p++; else f++;

  if (test('a window change breaks the chain — that pair is discarded', () => {
    const out = joinIntervals(
      [s(0, 10), s(MIN, 12), s(2 * MIN, 5, R2)],
      [l(0, MIN, { A: counts(10_000) }), l(MIN, 2 * MIN, { A: counts(10_000) })]
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].fromT, 0);
    assert.strictEqual(out[0].toT, MIN);
    assert.strictEqual(out[0].dUtil, 2);
  })) p++; else f++;

  if (test('a utilization drop inside one window is discarded too', () => {
    const out = joinIntervals([s(0, 12), s(MIN, 11)], [l(0, MIN, { A: counts(10_000) })]);
    assert.deepStrictEqual(out, []);
  })) p++; else f++;

  if (test('resetsAt jitter under the slack is the same window; past it is not', () => {
    const near = joinIntervals([s(0, 10), s(MIN, 12, R1_JITTER)], [l(0, MIN, { A: counts(10_000) })]);
    assert.strictEqual(near.length, 1);
    const far = joinIntervals([s(0, 10), s(MIN, 12, R1_FAR)], [l(0, MIN, { A: counts(10_000) })]);
    assert.deepStrictEqual(far, []);
  })) p++; else f++;

  if (test('one interval sums every ledger line inside it', () => {
    // 2000 + 100·5 + 40·1.25 + 200·0.1 = 2570 weighted per line, 12_850 over
    // the five — comfortably past the external ceiling, so this classifies.
    const ledger = Array.from({ length: 5 }, (_, i) =>
      l(i * MIN, (i + 1) * MIN, { A: { in: 2_000, out: 100, cc: 40, cr: 200 } }));
    const out = joinIntervals([s(0, 10), s(5 * MIN, 14)], ledger);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].tok, { A: { in: 10_000, out: 500, cc: 200, cr: 1_000 } });
    assert.deepStrictEqual(out[0].kind, { model: 'A' });
  })) p++; else f++;

  if (test('two of five minutes recorded → gap, never a silent bridge', () => {
    const ledger = [
      l(0, MIN, { A: counts(10_000) }),
      l(4 * MIN, 5 * MIN, { A: counts(10_000) })
    ];
    const out = joinIntervals([s(0, 10), s(5 * MIN, 14)], ledger);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'gap');
  })) p++; else f++;

  if (test('a straddling ledger line contributes its overlapping share, pro rata', () => {
    // One two-minute tick, of which the interval covers the second half.
    const out = joinIntervals(
      [s(MIN, 10), s(2 * MIN, 12)],
      [l(0, 2 * MIN, { A: { in: 10_000, out: 200, cc: 40, cr: 800 } })]
    );
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].tok, { A: { in: 5_000, out: 100, cc: 20, cr: 400 } });
    assert.deepStrictEqual(out[0].kind, { model: 'A' });
  })) p++; else f++;

  if (test('an interval offset from the ledger grid is still fully covered', () => {
    // The real case: history samples are write-on-change, so an interval's
    // edges never line up with the minute the ledger ticks on. Consecutive
    // ticks tile the timeline, so the overlaps still add up to the whole span.
    const ledger = [l(0, MIN, { A: counts(60_000) }), l(MIN, 2 * MIN, { A: counts(60_000) })];
    const out = joinIntervals([s(20_000, 10), s(80_000, 11)], ledger);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].kind, { model: 'A' }, 'this must not read as a gap');
    // 40s of the first tick and 20s of the second, both at 60_000 weighted.
    assert.strictEqual(out[0].tok.A.in, 60_000);
  })) p++; else f++;

  if (test('an interval the recorder never saw is still a gap', () => {
    const out = joinIntervals([s(10 * MIN, 10), s(11 * MIN, 12)], [l(0, MIN, { A: counts(10_000) })]);
    assert.strictEqual(out[0].kind, 'gap');
    assert.deepStrictEqual(out[0].tok, {});
  })) p++; else f++;

  if (test('flat utilization is idle, whatever the tokens say', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 10.005)], [l(0, MIN, { A: counts(50_000) })]);
    assert.strictEqual(out[0].kind, 'idle');
  })) p++; else f++;

  if (test('a rise with almost no local tokens is external burn', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 10.5)], [l(0, MIN, { A: counts(4_999) })]);
    assert.strictEqual(out[0].kind, 'external');
  })) p++; else f++;

  if (test('exactly the external ceiling is not external — it goes on to dominance', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 10.5)], [l(0, MIN, { A: counts(5_000) })]);
    assert.deepStrictEqual(out[0].kind, { model: 'A' });
  })) p++; else f++;

  if (test('91% of the weighted tokens attributes the interval; 89% does not', () => {
    const dominant = joinIntervals(
      [s(0, 10), s(MIN, 12)],
      [l(0, MIN, { A: counts(9_100), B: counts(900) })]
    );
    assert.deepStrictEqual(dominant[0].kind, { model: 'A' });

    const mixed = joinIntervals(
      [s(0, 10), s(MIN, 12)],
      [l(0, MIN, { A: counts(8_900), B: counts(1_100) })]
    );
    assert.strictEqual(mixed[0].kind, 'mixed');
  })) p++; else f++;

  if (test('samples out of order or coincident are not intervals', () => {
    assert.deepStrictEqual(joinIntervals([s(MIN, 10), s(0, 12)], []), []);
    assert.deepStrictEqual(joinIntervals([s(0, 10), s(0, 12)], []), []);
  })) p++; else f++;

  if (test('fewer than two samples yields nothing', () => {
    assert.deepStrictEqual(joinIntervals([], []), []);
    assert.deepStrictEqual(joinIntervals([s(0, 10)], []), []);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
