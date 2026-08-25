import assert from 'node:assert';

import { shapeUsageProfile } from '../server/api.js';
import { emptyState } from '../server/lib/usage-history.js';
import { HOURS_PER_WEEK } from '../server/lib/usage-forecast.js';
import type { ProfileState } from '../server/lib/usage-history.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const SUN_00 = Date.parse('2026-08-30T00:00:00Z'); // hourOfWeek 0, on the boundary

const bucket = (over: Partial<ProfileState['buckets'][number]>) => ({
  weight: null, weekStamp: null, observedMin: 0, activeMin: 0, lifetimeObservedMin: 0, ...over
});

export function run(): number {
  console.log('\n=== /api/usage/profile shaping ===\n');
  let p = 0, f = 0;

  if (test('recording off: still 168 cells, but no confidence and no walk', () => {
    const r = shapeUsageProfile({
      recording: false, state: emptyState(), weekly: null, nowMs: SUN_00, offsetMinutes: 0
    });
    assert.strictEqual(r.recording, false);
    assert.strictEqual(r.cells.length, HOURS_PER_WEEK);
    assert.strictEqual(r.confidence, 'none');
    assert.deepStrictEqual(r.walk, []);
    assert.strictEqual(r.exhaustAt, null);
  })) p++; else f++;

  if (test('empty profile: 168 null weights, globalMean 1, confidence none', () => {
    const r = shapeUsageProfile({
      recording: true, state: emptyState(), weekly: null, nowMs: SUN_00, offsetMinutes: 0
    });
    assert.strictEqual(r.cells.length, HOURS_PER_WEEK);
    assert.strictEqual(r.cells.filter((c) => c.weight !== null).length, 0);
    assert.strictEqual(r.globalMean, 1);
    assert.strictEqual(r.confidence, 'none');
    // hourOfWeek must be the index, in order — the grid is laid out from it.
    assert.strictEqual(r.cells[0].hourOfWeek, 0);
    assert.strictEqual(r.cells[167].hourOfWeek, 167);
  })) p++; else f++;

  if (test('a seeded profile: the trusted bucket round-trips, the thin one reports null', () => {
    const state = emptyState();
    state.buckets[33] = bucket({ weight: 0.8, weekStamp: '2026-W36', lifetimeObservedMin: 600 });
    state.buckets[34] = bucket({ weight: 0.9, weekStamp: '2026-W36', lifetimeObservedMin: 10 });
    state.observedWeeks = ['2026-W36'];
    const r = shapeUsageProfile({
      recording: true, state, weekly: null, nowMs: SUN_00, offsetMinutes: 0
    });
    assert.strictEqual(r.cells[33].weight, 0.8);
    assert.strictEqual(r.cells[33].observedMin, 600);
    assert.strictEqual(r.cells[34].weight, null, 'under the trust floor');
    assert.strictEqual(r.cells[34].observedMin, 10, 'but its real evidence is still reported');
    assert.strictEqual(r.globalMean, 0.8, 'only trusted buckets feed the mean');
    assert.strictEqual(r.confidence, 'thin');
  })) p++; else f++;

  if (test('staleWeeks counts the observed weeks since the bucket last folded', () => {
    const state = emptyState();
    state.buckets[33] = bucket({ weight: 0.5, weekStamp: '2026-W36', lifetimeObservedMin: 600 });
    state.buckets[40] = bucket({ weight: 0.5, weekStamp: '2026-W39', lifetimeObservedMin: 600 });
    state.observedWeeks = ['2026-W36', '2026-W37', '2026-W38', '2026-W39'];
    const r = shapeUsageProfile({
      recording: true, state, weekly: null, nowMs: SUN_00, offsetMinutes: 0
    });
    assert.strictEqual(r.cells[33].staleWeeks, 3);
    assert.strictEqual(r.cells[40].staleWeeks, 0, 'the current week is not stale');
    assert.strictEqual(r.cells[0].staleWeeks, 0, 'a never-touched bucket is not stale');
  })) p++; else f++;

  if (test('walk: one step per hour-slice, 168 on the boundary', () => {
    const r = shapeUsageProfile({
      recording: true,
      state: emptyState(),
      weekly: { utilization: 40, resetsAt: new Date(SUN_00 + 168 * H).toISOString(), ratePerHour: 1 },
      nowMs: SUN_00,
      offsetMinutes: 0
    });
    assert.strictEqual(r.walk.length, 168);
    assert.strictEqual(r.walk[0].t, new Date(SUN_00).toISOString());
    assert.strictEqual(r.walk[0].gain, 1);
  })) p++; else f++;

  if (test('walk: a partial first and last slice makes 169, and never more', () => {
    const r = shapeUsageProfile({
      recording: true,
      state: emptyState(),
      weekly: {
        utilization: 40,
        resetsAt: new Date(SUN_00 + 30 * 60_000 + 168 * H).toISOString(),
        ratePerHour: 1
      },
      nowMs: SUN_00 + 30 * 60_000,
      offsetMinutes: 0
    });
    assert.strictEqual(r.walk.length, 169);
    assert.ok(r.walk.length <= 169, 'a 168h span can never slice into more than 169');
  })) p++; else f++;

  if (test('a crossing inside the window is reported as exhaustAt', () => {
    const r = shapeUsageProfile({
      recording: true,
      state: emptyState(),
      weekly: { utilization: 90, resetsAt: new Date(SUN_00 + 48 * H).toISOString(), ratePerHour: 10 },
      nowMs: SUN_00,
      offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAt, new Date(SUN_00 + 1 * H).toISOString());
  })) p++; else f++;

  if (test('no weekly resetsAt: empty walk, null exhaustAt, no throw', () => {
    const r = shapeUsageProfile({
      recording: true,
      state: emptyState(),
      weekly: { utilization: 40, resetsAt: null, ratePerHour: 5 },
      nowMs: SUN_00,
      offsetMinutes: 0
    });
    assert.deepStrictEqual(r.walk, []);
    assert.strictEqual(r.exhaustAt, null);
    assert.strictEqual(r.cells.length, HOURS_PER_WEEK, 'the grid still renders');
  })) p++; else f++;

  if (test('no weekly rate yet: empty walk, but the grid still renders', () => {
    const r = shapeUsageProfile({
      recording: true,
      state: emptyState(),
      weekly: { utilization: 40, resetsAt: new Date(SUN_00 + 48 * H).toISOString(), ratePerHour: null },
      nowMs: SUN_00,
      offsetMinutes: 0
    });
    assert.deepStrictEqual(r.walk, []);
    assert.strictEqual(r.exhaustAt, null);
    assert.strictEqual(r.cells.length, HOURS_PER_WEEK);
  })) p++; else f++;

  if (test('the response never carries raw samples or file paths', () => {
    const state = emptyState();
    state.buckets[33] = bucket({ weight: 0.8, weekStamp: '2026-W36', lifetimeObservedMin: 600 });
    const r = shapeUsageProfile({
      recording: true,
      state,
      weekly: { utilization: 40, resetsAt: new Date(SUN_00 + 5 * H).toISOString(), ratePerHour: 2 },
      nowMs: SUN_00,
      offsetMinutes: 0
    });
    const json = JSON.stringify(r);
    assert.deepStrictEqual(
      Object.keys(r).sort(),
      ['cells', 'confidence', 'exhaustAt', 'globalMean', 'recording', 'walk']
    );
    assert.ok(!json.includes('.jsonl'), 'no log path may leak');
    assert.ok(!json.includes('utilization'), 'no raw sample may leak');
    assert.deepStrictEqual(
      Object.keys(r.cells[0]).sort(),
      ['hourOfWeek', 'observedMin', 'staleWeeks', 'weight']
    );
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
