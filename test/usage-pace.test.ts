import assert from 'node:assert';

import * as pace from '../server/lib/usage-pace.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const MIN = 60_000;
const NOW = 1_800_000_000_000;

export function run(): number {
  console.log('\n=== usage-pace.ts ===\n');
  let p = 0, f = 0;

  // ── computePace ──

  if (test('computePace: 30→40 over 30min → 20%/h, exhaust in 3h', () => {
    const out = pace.computePace(
      [{ t: NOW - 30 * MIN, utilization: 30 }, { t: NOW, utilization: 40 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 20);
    assert.strictEqual(out.projectedExhaustAt, new Date(NOW + 3 * H).toISOString());
  })) p++; else f++;

  if (test('computePace: span under minSpan → null', () => {
    const out = pace.computePace(
      [{ t: NOW - 2 * MIN, utilization: 30 }, { t: NOW, utilization: 31 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    );
    assert.strictEqual(out, null);
  })) p++; else f++;

  if (test('computePace: fewer than 2 samples in lookback → null', () => {
    assert.strictEqual(
      pace.computePace([{ t: NOW, utilization: 30 }], { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }),
      null
    );
    assert.strictEqual(
      pace.computePace([], { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }),
      null
    );
  })) p++; else f++;

  if (test('computePace: flat utilization → rate 0, no exhaust projection', () => {
    const out = pace.computePace(
      [{ t: NOW - 20 * MIN, utilization: 35 }, { t: NOW, utilization: 35 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 0);
    assert.strictEqual(out.projectedExhaustAt, null);
  })) p++; else f++;

  if (test('computePace: samples older than lookback are ignored', () => {
    // The 2h-old sample would flatten the rate; only the last two count.
    const out = pace.computePace(
      [
        { t: NOW - 2 * H, utilization: 30 },
        { t: NOW - 20 * MIN, utilization: 30 },
        { t: NOW, utilization: 40 }
      ],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.ratePerHour, 30);
  })) p++; else f++;

  if (test('computePace: projection starts from the latest utilization', () => {
    // 90 → 95 over 30min = 10%/h; 5% left → 30min to exhaust.
    const out = pace.computePace(
      [{ t: NOW - 30 * MIN, utilization: 90 }, { t: NOW, utilization: 95 }],
      { lookbackMs: 30 * MIN, minSpanMs: 5 * MIN, now: NOW }
    )!;
    assert.strictEqual(out.projectedExhaustAt, new Date(NOW + 30 * MIN).toISOString());
  })) p++; else f++;

  // ── prunedSamples ──

  if (test('prunedSamples: drops samples before the window anchor (resetsAt − window)', () => {
    const resetsAt = new Date(NOW + 3 * H).toISOString(); // anchor = NOW − 2h
    const kept = pace.prunedSamples(
      [
        { t: NOW - 3 * H, utilization: 50 }, // previous window
        { t: NOW - 1 * H, utilization: 10 },
        { t: NOW, utilization: 20 }
      ],
      resetsAt,
      5 * H
    );
    assert.deepStrictEqual(kept.map((s) => s.utilization), [10, 20]);
  })) p++; else f++;

  if (test('prunedSamples: null or unparseable resetsAt → unchanged', () => {
    const samples = [{ t: NOW - H, utilization: 10 }, { t: NOW, utilization: 20 }];
    assert.deepStrictEqual(pace.prunedSamples(samples, null, 5 * H), samples);
    assert.deepStrictEqual(pace.prunedSamples(samples, 'not-a-date', 5 * H), samples);
  })) p++; else f++;

  // ── recordAndPace (stateful store) ──

  if (test('recordAndPace: attaches pace fields once history spans minSpan', () => {
    pace.resetPaceStore();
    const rl = { utilization: 30, resetsAt: new Date(NOW + 4 * H).toISOString() };
    const first = pace.recordAndPace('fiveHour', rl, NOW - 30 * MIN);
    assert.strictEqual(first.ratePerHour, null); // one sample — no pace yet
    const second = pace.recordAndPace('fiveHour', { ...rl, utilization: 40 }, NOW);
    assert.strictEqual(second.ratePerHour, 20);
    assert.strictEqual(second.projectedExhaustAt, new Date(NOW + 3 * H).toISOString());
    assert.strictEqual(second.utilization, 40); // original fields pass through
  })) p++; else f++;

  if (test('recordAndPace: a utilization drop (window reset) clears history', () => {
    pace.resetPaceStore();
    const resetsAt = new Date(NOW + 4 * H).toISOString();
    pace.recordAndPace('fiveHour', { utilization: 80, resetsAt }, NOW - 30 * MIN);
    pace.recordAndPace('fiveHour', { utilization: 90, resetsAt }, NOW - 20 * MIN);
    // reset: utilization falls to 2; only post-reset samples may feed pace
    const after = pace.recordAndPace('fiveHour', { utilization: 2, resetsAt }, NOW);
    assert.strictEqual(after.ratePerHour, null);
  })) p++; else f++;

  if (test('recordAndPace: null utilization passes through without recording', () => {
    pace.resetPaceStore();
    const out = pace.recordAndPace('fiveHour', { utilization: null, resetsAt: null }, NOW);
    assert.strictEqual(out.utilization, null);
    assert.strictEqual(out.ratePerHour, null);
  })) p++; else f++;

  if (test('recordAndPace: windows keep separate histories', () => {
    pace.resetPaceStore();
    pace.recordAndPace('fiveHour', { utilization: 30, resetsAt: null }, NOW - 30 * MIN);
    pace.recordAndPace('sevenDay', { utilization: 10, resetsAt: null }, NOW - 30 * MIN);
    const five = pace.recordAndPace('fiveHour', { utilization: 40, resetsAt: null }, NOW);
    assert.strictEqual(five.ratePerHour, 20); // sevenDay's samples never mixed in
  })) p++; else f++;

  if (test('recordAndPace: sevenDay needs a longer span before showing pace', () => {
    pace.resetPaceStore();
    pace.recordAndPace('sevenDay', { utilization: 10, resetsAt: null }, NOW - 10 * MIN);
    const out = pace.recordAndPace('sevenDay', { utilization: 11, resetsAt: null }, NOW);
    assert.strictEqual(out.ratePerHour, null); // 10min < the weekly 30min min span
  })) p++; else f++;

  console.log(`\n  usage-pace: ${p} passed, ${f} failed`);
  return f;
}
