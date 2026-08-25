import assert from 'node:assert';

import {
  hourOfWeek,
  flatProfile,
  weightAt,
  walkForward,
  confidenceOf,
  HOURS_PER_WEEK
} from '../server/lib/usage-forecast.js';
import type { DutyProfile } from '../server/lib/usage-forecast.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;

// Fixed calendar anchors, all UTC so the tests pass offsetMinutes 0.
const FRI_18 = 1_787_940_000_000; // 2026-08-28T18:00:00Z, a Friday
const MON_16 = 1_788_192_000_000; // 2026-08-31T16:00:00Z
const WED_00 = 1_788_307_200_000; // 2026-09-02T00:00:00Z

/** Weight 1 for Mon–Fri 09:00–19:00, 0 everywhere else. */
function officeHours(): DutyProfile {
  const weights: (number | null)[] = new Array(HOURS_PER_WEEK).fill(0);
  for (let day = 1; day <= 5; day++) {
    for (let hour = 9; hour < 19; hour++) weights[day * 24 + hour] = 1;
  }
  return { weights, globalMean: 0.3, trustedCount: HOURS_PER_WEEK };
}

export function run(): number {
  console.log('\n=== usage-forecast.ts ===\n');
  let p = 0, f = 0;

  if (test('hourOfWeek: Sunday 00:00 UTC is 0, Monday 09:00 is 33, Friday 18:00 is 138', () => {
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-30T00:00:00Z'), 0), 0);
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-31T09:00:00Z'), 0), 33);
    assert.strictEqual(hourOfWeek(FRI_18, 0), 138);
  })) p++; else f++;

  if (test('hourOfWeek: offsets shift the index and wrap at both week edges', () => {
    // 23:30 UTC Saturday + 120min = 01:30 Sunday local → index 1.
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-29T23:30:00Z'), 120), 1);
    // 02:00 UTC Sunday − 300min = 21:00 Saturday local → index 165. A naive
    // modulo goes negative here; this pins the negative-offset wrap.
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-30T02:00:00Z'), -300), 165);
  })) p++; else f++;

  if (test('REGRESSION FLOOR: a flat 1.0 profile reproduces the old closed form', () => {
    // (100 − 60) / 5 = 8h. This is exactly what computePace does today.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 8 * H);
    assert.strictEqual(r.dutyCycle, 1);
  })) p++; else f++;

  if (test('office-hours profile: Friday evening projects into Monday, not Saturday', () => {
    // Fri 18:00→19:00 is 1 active hour → 60 + 5 = 65. Weekend contributes 0.
    // Needs 35 more at 5%/active-hour = 7 active hours into Monday's 09:00 → 16:00.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: officeHours(), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, MON_16);
  })) p++; else f++;

  if (test('office-hours profile: coasting through the reset yields null', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0.5,
      profile: officeHours(), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('crossing lands mid-hour, not snapped to the boundary', () => {
    // Flat 1.0, 90% used, 20%/h → 0.5h.
    const r = walkForward({
      nowMs: FRI_18, utilization: 90, activeRatePerHour: 20,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 0.5 * H);
  })) p++; else f++;

  if (test('crossing exactly on an hour boundary', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 90, activeRatePerHour: 10,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 1 * H);
  })) p++; else f++;

  if (test('already at 100% exhausts now', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 100, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18);
  })) p++; else f++;

  if (test('a zero rate never exhausts, and never divides by zero', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('an all-zero profile never exhausts even at a high rate', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 50,
      profile: flatProfile(0), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
    assert.strictEqual(r.dutyCycle, 0);
  })) p++; else f++;

  if (test('a reset already in the past yields null, not a backwards walk', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: FRI_18 - H, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('dutyCycle is the time-weighted mean over the remaining window', () => {
    // Fri 18:00 → Sat 00:00 is 6h: one active hour (18–19), five idle.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0,
      profile: officeHours(), resetsAtMs: FRI_18 + 6 * H, offsetMinutes: 0
    });
    assert.ok(Math.abs(r.dutyCycle - 1 / 6) < 1e-9, 'expected 1/6, got ' + r.dutyCycle);
  })) p++; else f++;

  if (test('steps: one per slice, gains match the profile, full window even past the crossing', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: officeHours(), resetsAtMs: WED_00, offsetMinutes: 0
    });
    // Fri 18:00 → Wed 00:00 on exact hour boundaries: 6 + 24×4 = 102 slices.
    assert.strictEqual(r.steps.length, 102);
    assert.strictEqual(r.steps[0].tMs, FRI_18);
    assert.strictEqual(r.steps[0].gain, 5);  // Fri 18–19 is in-profile
    assert.strictEqual(r.steps[1].gain, 0);  // Fri 19–20 is not
    // Steps keep going past the Monday-16:00 crossing: the strip and dutyCycle
    // both want the whole remaining window. 21 active hours × 5 = 105.
    const total = r.steps.reduce((a, s) => a + s.gain, 0);
    assert.ok(Math.abs(total - 105) < 1e-9, 'expected 105, got ' + total);
  })) p++; else f++;

  if (test('weightAt falls back to globalMean for an untrusted bucket', () => {
    const weights: (number | null)[] = new Array(HOURS_PER_WEEK).fill(null);
    weights[33] = 0.9;
    const profile: DutyProfile = { weights, globalMean: 0.4, trustedCount: 1 };
    assert.strictEqual(weightAt(profile, 33), 0.9);
    assert.strictEqual(weightAt(profile, 34), 0.4);
  })) p++; else f++;

  if (test('confidenceOf: none / thin / ok by trusted-bucket count', () => {
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 0 }), 'none');
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 40 }), 'thin');
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 130 }), 'ok');
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
