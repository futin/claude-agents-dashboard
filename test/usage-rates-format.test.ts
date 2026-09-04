import assert from 'node:assert';

import {
  baselineText,
  evidenceText,
  formatDeviation,
  formatSharePct,
  formatTok,
  rawAsideText,
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

  if (test('evidenceText states windows, days and cumulative movement', () => {
    assert.strictEqual(evidenceText(10, 2, 5), '10 windows · 2 days · 5.0 pts');
    assert.strictEqual(evidenceText(1, 1, 0.25), '1 window · 1 day · 0.3 pts');
    assert.strictEqual(evidenceText(428, 4, 455), '428 windows · 4 days · 455.0 pts');
  })) p++; else f++;

  if (test('baselineText tells a forming baseline apart from an absent one', () => {
    // The disclosure half of bug-17: with every baseline rate null, "no
    // baseline yet" and "one startup day, refused" read identically on screen.
    assert.strictEqual(baselineText(null, 0), 'no baseline yet');
    assert.strictEqual(baselineText(null, 1), 'baseline forming · 1 day');
    assert.strictEqual(baselineText(null, 6), 'baseline forming · 6 days');
    assert.strictEqual(baselineText(163_184, 9), 'baseline 163k · 9 days');
  })) p++; else f++;

  if (test('baselineText: a rate with no days behind it is still no baseline', () => {
    // Unreachable from the server — a fitted rate always has days — but the
    // day count is what the copy claims, so it is what decides the wording.
    assert.strictEqual(baselineText(900_000, 0), 'no baseline yet');
    assert.strictEqual(baselineText(Number.NaN, 3), 'baseline forming · 3 days');
  })) p++; else f++;

  if (test('every verdict has copy, and thin reads as collecting', () => {
    assert.strictEqual(verdictText('drift').label, 'drift');
    assert.strictEqual(verdictText('stable').label, 'stable');
    assert.strictEqual(verdictText('mix-shift').label, 'mix shift');
    assert.strictEqual(verdictText('thin').label, 'collecting');
    for (const v of ['drift', 'stable', 'mix-shift', 'thin'] as const) {
      assert.ok(verdictText(v).hint.length > 0, `${v} needs a hint`);
    }
    // The thin hint names both day floors, so the card says what it is waiting
    // for rather than only that it is waiting.
    assert.match(verdictText('thin').hint, /7 separate days/);
    assert.match(verdictText('thin').hint, /2 behind the current window/);
  })) p++; else f++;

  if (test('rawAsideText labels the raw figure as a mix-dependent translation', () => {
    assert.strictEqual(
      rawAsideText(1_737_000),
      "\u2248 1.7M raw at this model's recent mix"
    );
    assert.strictEqual(
      rawAsideText(358_000),
      "\u2248 358k raw at this model's recent mix"
    );
  })) p++; else f++;

  if (test('rawAsideText: a translation of nothing is no line, never a dash', () => {
    assert.strictEqual(rawAsideText(null), null);
    assert.strictEqual(rawAsideText(Number.NaN), null);
  })) p++; else f++;

  if (test('formatSharePct rounds, and null stays null', () => {
    assert.strictEqual(formatSharePct(12.4), '12%');
    assert.strictEqual(formatSharePct(0), '0%');
    assert.strictEqual(formatSharePct(null), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
