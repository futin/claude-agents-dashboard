import assert from 'node:assert';

import * as usage from '../server/lib/usage.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== usage.ts ===\n');
  let p = 0, f = 0;

  if (test('mapUsage maps top-level five_hour + seven_day (live shape)', () => {
    const u = usage.mapUsage({
      five_hour: { utilization: 17, resets_at: '2026-07-01T17:20:00Z' },
      seven_day: { utilization: 28, resets_at: '2026-07-06T08:00:00Z' },
      seven_day_opus: null
    })!;
    assert.strictEqual(u.fiveHour.utilization, 17);
    assert.strictEqual(u.fiveHour.resetsAt, '2026-07-01T17:20:00Z');
    assert.strictEqual(u.sevenDay.utilization, 28);
    assert.strictEqual(u.sevenDay.resetsAt, '2026-07-06T08:00:00Z');
  })) p++; else f++;

  if (test('mapUsage also accepts a rate_limits wrapper', () => {
    const u = usage.mapUsage({
      rate_limits: { five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: 68, resets_at: null } }
    })!;
    assert.strictEqual(u.fiveHour.utilization, 42);
    assert.strictEqual(u.sevenDay.utilization, 68);
  })) p++; else f++;

  if (test('mapUsage returns null when both windows absent', () => {
    assert.strictEqual(usage.mapUsage({}), null);
    assert.strictEqual(usage.mapUsage({ rate_limits: null }), null);
    assert.strictEqual(usage.mapUsage(null), null);
    assert.strictEqual(usage.mapUsage({ seven_day_opus: null }), null);
  })) p++; else f++;

  if (test('mapUsage coerces missing/invalid window fields to null', () => {
    const u = usage.mapUsage({ five_hour: {}, seven_day: { utilization: 'x' } })!;
    assert.strictEqual(u.fiveHour.utilization, null);
    assert.strictEqual(u.fiveHour.resetsAt, null);
    assert.strictEqual(u.sevenDay.utilization, null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
