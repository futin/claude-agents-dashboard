import assert from 'node:assert';

import { paceView, FIVE_HOUR_MS, SEVEN_DAY_MS } from '../client/src/lib/pace.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const NOW = 1_800_000_000_000;

export function run(): number {
  console.log('\n=== pace.ts (client view-model) ===\n');
  let p = 0, f = 0;

  // Window: resets in 3h → started 2h ago (anchor = reset − 5h).
  const resetsAt = new Date(NOW + 3 * H).toISOString();

  if (test('elapsedPct: 2h into a 5h window → 40', () => {
    const v = paceView({ utilization: 35, resetsAt }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.elapsedPct, 40);
  })) p++; else f++;

  if (test('wall before reset → verdict wall + tick placed on the time axis', () => {
    // Exhaust 30min before the reset → (5h − 0.5h)/5h = 90%.
    const v = paceView(
      { utilization: 35, resetsAt, ratePerHour: 22, projectedExhaustAt: new Date(NOW + 2.5 * H).toISOString() },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.verdict, 'wall');
    assert.strictEqual(v.wallPct, 90);
  })) p++; else f++;

  if (test('wall after reset → verdict lasts, no tick', () => {
    const v = paceView(
      { utilization: 35, resetsAt, ratePerHour: 5, projectedExhaustAt: new Date(NOW + 13 * H).toISOString() },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.verdict, 'lasts');
    assert.strictEqual(v.wallPct, null);
  })) p++; else f++;

  if (test('idle (rate 0) → verdict lasts, no tick, rate text 0%/h', () => {
    const v = paceView(
      { utilization: 35, resetsAt, ratePerHour: 0, projectedExhaustAt: null },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.verdict, 'lasts');
    assert.strictEqual(v.wallPct, null);
    assert.strictEqual(v.rateText, '0%/h');
  })) p++; else f++;

  if (test('no pace data yet → strip renders (elapsed) but verdict + rate are null', () => {
    const v = paceView({ utilization: 35, resetsAt }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.verdict, null);
    assert.strictEqual(v.rateText, null);
    assert.strictEqual(v.wallPct, null);
  })) p++; else f++;

  if (test('no resetsAt → null (no strip at all)', () => {
    assert.strictEqual(paceView({ utilization: 35, resetsAt: null }, FIVE_HOUR_MS, NOW), null);
  })) p++; else f++;

  if (test('rate text: 5h window per hour, rounded', () => {
    const v = paceView({ utilization: 35, resetsAt, ratePerHour: 22.4, projectedExhaustAt: null }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.rateText, '22%/h');
  })) p++; else f++;

  if (test('rate text: sub-1%/h keeps one decimal', () => {
    const v = paceView({ utilization: 35, resetsAt, ratePerHour: 0.44, projectedExhaustAt: null }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.rateText, '0.4%/h');
  })) p++; else f++;

  if (test('rate text: weekly window shown per day', () => {
    const weekReset = new Date(NOW + 5 * 24 * H).toISOString();
    const v = paceView({ utilization: 18, resetsAt: weekReset, ratePerHour: 0.25, projectedExhaustAt: null }, SEVEN_DAY_MS, NOW)!;
    assert.strictEqual(v.rateText, '6%/day');
  })) p++; else f++;

  if (test('elapsed clamps to 0–100 (stale poll past the reset)', () => {
    const past = new Date(NOW - 60_000).toISOString(); // reset already behind us
    const v = paceView({ utilization: 99, resetsAt: past }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.elapsedPct, 100);
  })) p++; else f++;

  // ── the duty-cycle band and the corrected weekly rate ──

  if (test('weekly rate text is corrected by the duty cycle', () => {
    const weekReset = new Date(NOW + 48 * H).toISOString();
    const v = paceView(
      { utilization: 40, resetsAt: weekReset, ratePerHour: 5, dutyCycle: 0.25, projectedExhaustAt: null },
      SEVEN_DAY_MS,
      NOW
    )!;
    // 5 %/active-hour × 0.25 × 24h = 30 %/day, not 120.
    assert.strictEqual(v.rateText, '30%/day');
  })) p++; else f++;

  if (test('weekly rate text falls back to the flat formula without a duty cycle', () => {
    const weekReset = new Date(NOW + 48 * H).toISOString();
    const v = paceView(
      { utilization: 40, resetsAt: weekReset, ratePerHour: 5, projectedExhaustAt: null },
      SEVEN_DAY_MS,
      NOW
    )!;
    assert.strictEqual(v.rateText, '120%/day');
  })) p++; else f++;

  if (test('the pessimistic tick is placed on the time axis', () => {
    const v = paceView(
      {
        utilization: 35, resetsAt, ratePerHour: 22,
        projectedExhaustAt: new Date(NOW + 2.5 * H).toISOString(),
        pessimisticExhaustAt: new Date(NOW + 1 * H).toISOString(),
        forecastConfidence: 'ok'
      },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.wallPct, 90);   // (5h − 0.5h)/5h
    assert.strictEqual(v.wallPctPessimistic, 60); // (2h + 1h)/5h
    assert.strictEqual(v.confidence, 'ok');
  })) p++; else f++;

  if (test('a pessimistic edge after the reset is dropped, like the optimistic one', () => {
    const v = paceView(
      {
        utilization: 35, resetsAt, ratePerHour: 1,
        projectedExhaustAt: new Date(NOW + 30 * H).toISOString(),
        pessimisticExhaustAt: new Date(NOW + 20 * H).toISOString(),
        forecastConfidence: 'thin'
      },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.verdict, 'lasts');
    assert.strictEqual(v.wallPct, null);
    assert.strictEqual(v.wallPctPessimistic, null);
  })) p++; else f++;

  if (test('confidence defaults to none when the server sends nothing', () => {
    const v = paceView({ utilization: 35, resetsAt }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.confidence, 'none');
    assert.strictEqual(v.wallPctPessimistic, null);
  })) p++; else f++;

  console.log(`\n  pace-view: ${p} passed, ${f} failed`);
  return f;
}
