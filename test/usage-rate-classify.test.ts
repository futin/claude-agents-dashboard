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

/** The same line, with request counts recorded — what a post-upgrade tick looks like. */
const lr = (
  prevT: number, t: number, tok: Record<string, TokenCounts>, req: Record<string, number>
): LedgerLine => ({ t, prevT, tok, req });

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

  if (test('two of five minutes recorded → partial, never a silent bridge', () => {
    // Under-covered but not uncovered: the recorder ran, so this is `partial`
    // and not the recorder-down `gap` it used to be lumped in with.
    const ledger = [
      l(0, MIN, { A: counts(10_000) }),
      l(4 * MIN, 5 * MIN, { A: counts(10_000) })
    ];
    const out = joinIntervals([s(0, 10), s(5 * MIN, 14)], ledger);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'partial');
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

  // ── request counts, gathered the same way ──

  if (test('two whole ledger lines sum their counts', () => {
    const out = joinIntervals(
      [s(0, 10), s(2 * MIN, 12)],
      [
        lr(0, MIN, { A: counts(6_000) }, { A: 3 }),
        lr(MIN, 2 * MIN, { A: counts(6_000), B: counts(1_000) }, { A: 4, B: 2 })
      ]
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reqUsable, true);
    assert.deepStrictEqual(out[0].req, { A: 7, B: 2 });
  })) p++; else f++;

  if (test('a straddling edge tick pro-rates its count as a float, like its tokens', () => {
    // One two-minute tick of 4 requests, of which the interval covers half.
    const out = joinIntervals(
      [s(MIN, 10), s(2 * MIN, 12)],
      [lr(0, 2 * MIN, { A: counts(20_000) }, { A: 4 })]
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reqUsable, true);
    assert.deepStrictEqual(out[0].req, { A: 2 }, 'half of 4 — pro-rated, not rounded or attributed whole');
    assert.strictEqual(out[0].tok.A.in, 10_000, 'the tokens are split by the same share');
  })) p++; else f++;

  if (test('one of three lines without a count poisons the count, not the tokens', () => {
    const out = joinIntervals(
      [s(0, 10), s(3 * MIN, 12)],
      [
        lr(0, MIN, { A: counts(5_000) }, { A: 3 }),
        l(MIN, 2 * MIN, { A: counts(5_000) }),               // written before counts existed
        lr(2 * MIN, 3 * MIN, { A: counts(5_000) }, { A: 5 })
      ]
    );
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reqUsable, false, 'a partial count must never be fitted as if whole');
    assert.strictEqual(out[0].tok.A.in, 15_000, 'the token totals are exactly what they were before');
    assert.deepStrictEqual(out[0].kind, { model: 'A' }, 'and the interval still classifies as usual');
  })) p++; else f++;

  if (test('a line recording a count for one model but not another is still poisoned', () => {
    const out = joinIntervals(
      [s(0, 10), s(MIN, 12)],
      [{ t: MIN, prevT: 0, tok: { A: counts(9_000), B: counts(1_000) }, req: { A: 2 } }]
    );
    assert.strictEqual(out[0].reqUsable, false);
  })) p++; else f++;

  if (test('an empty pre-upgrade tick is zero requests, not an unrecorded count', () => {
    // Nothing was spent, so nothing was requested — a line with no `req` and no
    // tokens carries no missing measurement to poison anything with.
    const out = joinIntervals(
      [s(0, 10), s(2 * MIN, 12)],
      [lr(0, MIN, { A: counts(10_000) }, { A: 6 }), l(MIN, 2 * MIN)]
    );
    assert.strictEqual(out[0].reqUsable, true);
    assert.deepStrictEqual(out[0].req, { A: 6 });
  })) p++; else f++;

  // ── the three unpriced kinds ──

  /** Zero ledger coverage of `[0, MIN]`: the only line sits ten minutes later. */
  const uncovered = [l(10 * MIN, 11 * MIN, { A: counts(10_000) })];

  if (test('an uncovered span that ends before recording began is pre-ledger', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 12)], uncovered, 5 * MIN);
    assert.strictEqual(out[0].kind, 'pre-ledger');
  })) p++; else f++;

  if (test('the pre-ledger boundary is inclusive: toT exactly at the start still counts', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 12)], uncovered, MIN);
    assert.strictEqual(out[0].kind, 'pre-ledger', 'the first line covers (prevT, t], so prevT itself is unrecorded');
  })) p++; else f++;

  if (test('one millisecond past the start it is the recorder being down', () => {
    const out = joinIntervals([s(0, 10), s(MIN, 12)], uncovered, MIN - 1);
    assert.strictEqual(out[0].kind, 'gap');
  })) p++; else f++;

  if (test('covered but under the threshold, after the start, is partial', () => {
    // One of two minutes recorded — a coverage of exactly 0.5, well clear of
    // the 0.8 threshold in both directions.
    const out = joinIntervals(
      [s(0, 10), s(2 * MIN, 12)],
      [l(0, MIN, { A: counts(10_000) })],
      0
    );
    assert.strictEqual(out[0].kind, 'partial');
  })) p++; else f++;

  if (test('coverage exactly at the threshold classifies on its tokens, not its coverage', () => {
    // Four of five minutes = 0.8 exactly, and the comparison is `>=`.
    const out = joinIntervals(
      [s(0, 10), s(5 * MIN, 14)],
      [l(0, 4 * MIN, { A: counts(20_000) })],
      0
    );
    assert.deepStrictEqual(out[0].kind, { model: 'A' });
  })) p++; else f++;

  if (test('an unprovable start collapses pre-ledger into gap, never the other way', () => {
    const explicit = joinIntervals([s(0, 10), s(MIN, 12)], uncovered, null);
    assert.strictEqual(explicit[0].kind, 'gap');
    const defaulted = joinIntervals([s(0, 10), s(MIN, 12)], uncovered);
    assert.strictEqual(defaulted[0].kind, 'gap', 'the two-argument call must behave the same way');
  })) p++; else f++;

  if (test('an interval straddling the start of recording is a gap, not pre-ledger', () => {
    // Begins before recording, ends after it: not provably unrecorded, so it
    // classifies on its actual coverage. The documented, bounded overstatement
    // of the recorder-down bucket — at most one interval per install.
    const out = joinIntervals([s(0, 10), s(2 * MIN, 12)], uncovered, MIN);
    assert.strictEqual(out[0].kind, 'gap');
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
