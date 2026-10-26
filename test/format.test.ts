import assert from 'node:assert';

import { ageAt, fmtBytes, fmtDuration, fmtTok, formatAgo } from '../client/src/lib/format.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== format.ts ===\n');
  let p = 0, f = 0;

  if (test('fmtBytes: bytes under 1 KB stay whole', () => {
    assert.strictEqual(fmtBytes(0), '0 B');
    assert.strictEqual(fmtBytes(1), '1 B');
    assert.strictEqual(fmtBytes(1023), '1023 B');
  })) p++; else f++;

  if (test('fmtBytes: KB and MB get one decimal, rounded', () => {
    assert.strictEqual(fmtBytes(1024), '1.0 KB');
    assert.strictEqual(fmtBytes(15456), '15.1 KB');
    assert.strictEqual(fmtBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(fmtBytes(2_600_000), '2.5 MB');
  })) p++; else f++;

  if (test('fmtBytes: a value that rounds up to 1024 KB moves to MB', () => {
    assert.strictEqual(fmtBytes(1024 * 1024 - 1), '1.0 MB');
    assert.strictEqual(fmtBytes(1024 * 1024 - 52), '1023.9 KB');
  })) p++; else f++;

  if (test('fmtTok: whole under 1k, one decimal k, two decimal M', () => {
    assert.strictEqual(fmtTok(0), '0');
    assert.strictEqual(fmtTok(999), '999');
    assert.strictEqual(fmtTok(1000), '1.0k');
    assert.strictEqual(fmtTok(3_449), '3.4k');
    assert.strictEqual(fmtTok(1_234_567), '1.23M');
  })) p++; else f++;

  if (test('fmtTok: a value that rounds up to 1000.0k moves to M', () => {
    assert.strictEqual(fmtTok(999_949), '999.9k');
    assert.strictEqual(fmtTok(999_960), '1.00M');
    assert.strictEqual(fmtTok(999_999), '1.00M');
  })) p++; else f++;

  if (test('fmtDuration: each unit, and each boundary rounds into the next unit', () => {
    assert.strictEqual(fmtDuration(-1), '');
    assert.strictEqual(fmtDuration(NaN), '');
    assert.strictEqual(fmtDuration(900), '900ms');
    assert.strictEqual(fmtDuration(999.4), '999ms');
    assert.strictEqual(fmtDuration(999.6), '1s');
    assert.strictEqual(fmtDuration(12_000), '12s');
    assert.strictEqual(fmtDuration(59_499), '59s');
    assert.strictEqual(fmtDuration(59_500), '1m');
    assert.strictEqual(fmtDuration(90_000), '1m30s');
    assert.strictEqual(fmtDuration(3_599_500), '1h');
    assert.strictEqual(fmtDuration(7_500_000), '2h5m');
  })) p++; else f++;

  if (test('ageAt: seconds, minutes, hours, days against a given now; a future timestamp reads 0s', () => {
    const now = 1_000_000_000_000;
    assert.strictEqual(ageAt(now - 5_000, now), '5s');
    assert.strictEqual(ageAt(now - 180_000, now), '3m');
    assert.strictEqual(ageAt(now - 2 * 3_600_000, now), '2h');
    assert.strictEqual(ageAt(now - 26 * 3_600_000, now), '1d');
    assert.strictEqual(ageAt(now + 9_000, now), '0s');
  })) p++; else f++;

  if (test('formatAgo still reads the clock: it agrees with ageAt at Date.now()', () => {
    const t = Date.now() - 3 * 3_600_000;
    assert.strictEqual(formatAgo(t), '3h');
    assert.strictEqual(formatAgo(Date.now()), '0s');
  })) p++; else f++;

  console.log(`\nformat: ${p} passed, ${f} failed`);
  return f;
}
