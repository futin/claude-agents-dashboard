import assert from 'node:assert';

import {
  evidenceText,
  formatDeviation,
  formatSharePct,
  formatTok,
  verdictText
} from '../client/src/lib/usageRatesFormat.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== usageRatesFormat.ts ===\n');
  let p = 0, f = 0;

  if (test('formatTok: the five documented magnitudes', () => {
    assert.strictEqual(formatTok(210_000), '210k');
    assert.strictEqual(formatTok(1_500_000), '1.5M');
    assert.strictEqual(formatTok(2_000_000), '2.0M');
    assert.strictEqual(formatTok(950), '950');
    assert.strictEqual(formatTok(null), '—');
  })) p++; else f++;

  if (test('formatTok: an unfitted rate is a dash, never a zero', () => {
    assert.strictEqual(formatTok(Number.NaN), '—');
    assert.strictEqual(formatTok(0), '0');
    assert.strictEqual(formatTok(999), '999');
    assert.strictEqual(formatTok(1_000), '1k');
  })) p++; else f++;

  if (test('formatDeviation always carries its sign', () => {
    assert.strictEqual(formatDeviation(66.6667), '+66.7%');
    assert.strictEqual(formatDeviation(-30), '-30.0%');
    assert.strictEqual(formatDeviation(0), '+0.0%');
    assert.strictEqual(formatDeviation(null), '—');
  })) p++; else f++;

  if (test('evidenceText states windows and cumulative movement', () => {
    assert.strictEqual(evidenceText(10, 5), '10 windows · 5.0 pts');
    assert.strictEqual(evidenceText(1, 0.25), '1 window · 0.3 pts');
  })) p++; else f++;

  if (test('every verdict has copy, and thin reads as collecting', () => {
    assert.strictEqual(verdictText('drift').label, 'drift');
    assert.strictEqual(verdictText('stable').label, 'stable');
    assert.strictEqual(verdictText('mix-shift').label, 'mix shift');
    assert.strictEqual(verdictText('thin').label, 'collecting');
    for (const v of ['drift', 'stable', 'mix-shift', 'thin'] as const) {
      assert.ok(verdictText(v).hint.length > 0, `${v} needs a hint`);
    }
  })) p++; else f++;

  if (test('formatSharePct rounds, and null stays null', () => {
    assert.strictEqual(formatSharePct(12.4), '12%');
    assert.strictEqual(formatSharePct(0), '0%');
    assert.strictEqual(formatSharePct(null), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
