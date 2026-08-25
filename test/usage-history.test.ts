import assert from 'node:assert';

import {
  emptyState,
  classifyInterval,
  isoWeekKey,
  accumulate,
  deriveProfile,
  MAX_ATTRIBUTABLE_MS,
  TRUST_FLOOR_MIN,
  EWMA_ALPHA
} from '../server/lib/usage-history.js';
import type { UsageSample } from '../server/lib/usage-history.js';
import { HOURS_PER_WEEK } from '../server/lib/usage-forecast.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const MIN = 60_000;
const R1 = '2026-08-28T23:00:00.000Z';
const R2 = '2026-08-29T04:00:00.000Z';
const MON_09 = Date.parse('2026-08-31T09:00:00Z'); // hourOfWeek 33
const FRI_22 = Date.parse('2026-08-28T22:00:00Z'); // hourOfWeek 142

const s = (t: number, utilization: number, resetsAt: string | null = R1): UsageSample =>
  ({ t, utilization, resetsAt });

export function run(): number {
  console.log('\n=== usage-history.ts ===\n');
  let p = 0, f = 0;

  // ── classifyInterval: one test per row of the table ──

  if (test('classify: flat over a minute → idle', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 40)), 'idle');
  })) p++; else f++;

  if (test('classify: flat over eight hours → still idle (the sleep case)', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(8 * H, 40)), 'idle');
  })) p++; else f++;

  if (test('classify: rose within the attributable window → active', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 42)), 'active');
  })) p++; else f++;

  if (test('classify: rose across a long gap → ambiguous', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(4 * H, 55)), 'ambiguous');
  })) p++; else f++;

  if (test('classify: rose exactly at the threshold is still attributable', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MAX_ATTRIBUTABLE_MS, 42)), 'active');
  })) p++; else f++;

  if (test('classify: a changed resetsAt is reset, even with identical utilization', () => {
    assert.strictEqual(classifyInterval(s(0, 40, R1), s(8 * H, 40, R2)), 'reset');
  })) p++; else f++;

  if (test('classify: a fallen utilization is reset', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 10)), 'reset');
  })) p++; else f++;

  if (test('classify: sub-epsilon movement is not a rise', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 40.3)), 'idle');
  })) p++; else f++;

  // ── accumulate ──

  if (test('accumulate: an idle hour credits observed minutes and zero active', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + H, 40), 0);
    assert.strictEqual(st.buckets[33].observedMin, 60);
    assert.strictEqual(st.buckets[33].activeMin, 0);
    assert.strictEqual(st.buckets[33].lifetimeObservedMin, 60);
  })) p++; else f++;

  if (test('accumulate: an active minute credits both counters', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + MIN, 41), 0);
    assert.strictEqual(st.buckets[33].observedMin, 1);
    assert.strictEqual(st.buckets[33].activeMin, 1);
  })) p++; else f++;

  if (test('accumulate: an overnight idle interval teaches every hour it spans', () => {
    // Fri 22:00 → Sat 06:00. Friday is day 5, so 22:00→142 and 23:00→143;
    // Saturday is day 6, so 00:00→144 through 05:00→149. Eight buckets.
    const st = accumulate(emptyState(), s(FRI_22, 40), s(FRI_22 + 8 * H, 40), 0);
    for (const hw of [142, 143, 144, 145, 146, 147, 148, 149]) {
      assert.strictEqual(st.buckets[hw].observedMin, 60, 'bucket ' + hw);
      assert.strictEqual(st.buckets[hw].activeMin, 0, 'bucket ' + hw);
    }
  })) p++; else f++;

  if (test('accumulate: a week-boundary interval stamps each side with its own week', () => {
    // Sun 23:30 → Mon 00:30 local. Sunday is day 0 → bucket 23; Monday → bucket 24.
    // One week key per interval would file Sunday's minutes into the new week.
    const SUN_2330 = Date.parse('2026-08-30T23:30:00Z');
    const st = accumulate(emptyState(), s(SUN_2330, 40), s(SUN_2330 + H, 40), 0);
    assert.strictEqual(st.buckets[23].observedMin, 30);
    assert.strictEqual(st.buckets[24].observedMin, 30);
    assert.notStrictEqual(st.buckets[23].weekStamp, st.buckets[24].weekStamp);
  })) p++; else f++;

  if (test('MUTATION GUARD: an ambiguous interval leaves every counter untouched', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 4 * H, 55), 0);
    const touched = st.buckets.filter((b) => b.observedMin !== 0 || b.activeMin !== 0);
    assert.strictEqual(touched.length, 0);
  })) p++; else f++;

  if (test('MUTATION GUARD: a reset interval leaves every counter untouched', () => {
    // Identical utilization, so only the resetsAt comparison can reject this.
    // Delete that comparison and this test must fail.
    const st = accumulate(emptyState(), s(MON_09, 40, R1), s(MON_09 + 4 * H, 40, R2), 0);
    const touched = st.buckets.filter((b) => b.observedMin !== 0 || b.activeMin !== 0);
    assert.strictEqual(touched.length, 0);
  })) p++; else f++;

  // ── week rollover ──

  // A rising interval only counts as `active` when it is within
  // MAX_ATTRIBUTABLE_MS, so an active stretch must be fed one minute at a time.
  // Ten active minutes and no idle ones gives that week a ratio of exactly 1.0.
  function activeMinutes(st: ReturnType<typeof emptyState>, startMs: number, mins: number) {
    let cur = st;
    for (let i = 0; i < mins; i++) {
      cur = accumulate(cur, s(startMs + i * MIN, 40 + i), s(startMs + (i + 1) * MIN, 41 + i), 0);
    }
    return cur;
  }

  /** 30 active minutes then 30 idle ones in bucket 33 — that week's ratio is 0.5. */
  function halfActiveWeek(st: ReturnType<typeof emptyState>, mondayNine: number) {
    const active = activeMinutes(st, mondayNine, 30);
    return accumulate(active, s(mondayNine + 30 * MIN, 70), s(mondayNine + 60 * MIN, 70), 0);
  }

  if (test('isoWeekKey: same week for two days in it, different across the boundary', () => {
    const mon = Date.parse('2026-08-31T12:00:00Z');
    const tue = Date.parse('2026-09-01T12:00:00Z');
    const prevWeek = Date.parse('2026-08-26T12:00:00Z');
    assert.strictEqual(isoWeekKey(mon, 0), isoWeekKey(tue, 0));
    assert.notStrictEqual(isoWeekKey(mon, 0), isoWeekKey(prevWeek, 0));
  })) p++; else f++;

  if (test('isoWeekKey: the year-end week is one week (2026-W53 reaches into January)', () => {
    // 2026-12-28 is a Monday, 2027-01-01 a Friday — the same ISO week, the exact
    // boundary naive day-of-year arithmetic breaks. 2027-01-04 starts W01.
    assert.strictEqual(
      isoWeekKey(Date.parse('2026-12-28T12:00:00Z'), 0),
      isoWeekKey(Date.parse('2027-01-01T12:00:00Z'), 0)
    );
    assert.notStrictEqual(
      isoWeekKey(Date.parse('2027-01-01T12:00:00Z'), 0),
      isoWeekKey(Date.parse('2027-01-04T12:00:00Z'), 0)
    );
  })) p++; else f++;

  if (test('week rollover: the first fold seeds the weight with the raw ratio', () => {
    // Week 1: 30 active of 60 observed in bucket 33 → ratio 0.5.
    let st = halfActiveWeek(emptyState(), MON_09);
    assert.strictEqual(st.buckets[33].weight, null, 'not folded until the week turns');
    // A sample in the next week triggers the fold.
    const next = MON_09 + 7 * 24 * H;
    st = accumulate(st, s(next, 40), s(next + MIN, 40), 0);
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - 0.5) < 1e-9,
      'expected 0.5, got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('week rollover: a second fold applies the EWMA rather than replacing', () => {
    // Week 1 ratio 0.5, week 2 ratio 1.0 → 0.7·0.5 + 0.3·1.0 = 0.65.
    let st = halfActiveWeek(emptyState(), MON_09);
    const w2 = MON_09 + 7 * 24 * H;
    st = activeMinutes(st, w2, 10); // all active, no idle minutes → ratio 1.0
    const w3 = MON_09 + 14 * 24 * H;
    st = accumulate(st, s(w3, 40), s(w3 + MIN, 40), 0);
    const expected = (1 - EWMA_ALPHA) * 0.5 + EWMA_ALPHA * 1;
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - expected) < 1e-9,
      'expected ' + expected + ', got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('quiet weeks decay a bucket rather than freezing it', () => {
    // Week 1: bucket 33 active for ten minutes → that week's ratio is 1.0.
    let st = activeMinutes(emptyState(), MON_09, 10);
    // Weeks 2 and 3: we were recording — a different hour saw traffic — but
    // bucket 33 was idle. Monday 12:00 is hourOfWeek 36.
    const MON_12 = MON_09 + 3 * H;
    for (const wk of [1, 2]) {
      const t = MON_12 + wk * 7 * 24 * H;
      st = accumulate(st, s(t, 40), s(t + MIN, 41), 0);
    }
    // Week 4 touches bucket 33 again, folding week 1 and then ageing it by the
    // two observed weeks it sat out. Thirty idle minutes accumulate for week 4.
    const w4 = MON_09 + 3 * 7 * 24 * H;
    st = accumulate(st, s(w4, 40), s(w4 + 30 * MIN, 40), 0);
    // Week 5 folds week 4's ratio of 0.
    const w5 = MON_09 + 4 * 7 * 24 * H;
    st = accumulate(st, s(w5, 40), s(w5 + MIN, 40), 0);
    const afterW4Fold = 1 * Math.pow(1 - EWMA_ALPHA, 2);          // 0.49
    const expected = (1 - EWMA_ALPHA) * afterW4Fold + EWMA_ALPHA * 0; // 0.343
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - expected) < 1e-9,
      'expected ' + expected + ', got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('MUTATION GUARD: unobserved weeks do not decay (downtime is not idleness)', () => {
    // Week 1 active, nothing recorded anywhere for three weeks, then active again.
    // k must be 0 both times, so two ratio-1.0 folds leave the weight at 1.0.
    // Delete the "only observed weeks count" rule and this lands at 0.643 — the
    // seed decays to 0.49 (1 × 0.7²) before the week-4 ratio-1.0 fold — not 1.
    let st = activeMinutes(emptyState(), MON_09, 10);
    const w4 = MON_09 + 3 * 7 * 24 * H;
    st = activeMinutes(st, w4, 10);
    const w5 = MON_09 + 4 * 7 * 24 * H;
    st = accumulate(st, s(w5, 40), s(w5 + MIN, 40), 0);
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - 1) < 1e-9,
      'downtime must not decay; expected 1, got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('observedWeeks is pruned and never grows without bound', () => {
    let st = emptyState();
    for (let wk = 0; wk < 40; wk++) {
      const t = MON_09 + wk * 7 * 24 * H;
      st = accumulate(st, s(t, 40), s(t + MIN, 41), 0);
    }
    assert.ok(st.observedWeeks.length <= 26,
      'expected <= 26 retained weeks, got ' + st.observedWeeks.length);
  })) p++; else f++;

  if (test('week rollover: two samples in the same week do not fold twice', () => {
    let st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 40), 0);
    st = accumulate(st, s(MON_09 + 30 * MIN, 40), s(MON_09 + 60 * MIN, 40), 0);
    assert.strictEqual(st.buckets[33].weight, null);
    assert.strictEqual(st.buckets[33].observedMin, 60, 'accumulators must not reset mid-week');
  })) p++; else f++;

  // ── deriveProfile ──

  if (test('deriveProfile: a bucket under the trust floor reports no weight', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 40), 0);
    const next = MON_09 + 7 * 24 * H;
    const folded = accumulate(st, s(next, 40), s(next + MIN, 40), 0);
    // 30 lifetime observed minutes < TRUST_FLOOR_MIN, so untrusted despite a fold.
    assert.ok(TRUST_FLOOR_MIN > 30);
    assert.strictEqual(deriveProfile(folded).weights[33], null);
  })) p++; else f++;

  if (test('deriveProfile: globalMean is 1 when nothing is trusted yet', () => {
    const dp = deriveProfile(emptyState());
    assert.strictEqual(dp.trustedCount, 0);
    assert.strictEqual(dp.globalMean, 1);
  })) p++; else f++;

  if (test('deriveProfile: globalMean averages only the trusted buckets', () => {
    const st = emptyState();
    st.buckets[33] = { weight: 0.8, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 600 };
    st.buckets[34] = { weight: 0.2, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 600 };
    st.buckets[35] = { weight: 0.9, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 10 };
    const dp = deriveProfile(st);
    assert.strictEqual(dp.trustedCount, 2);
    assert.ok(Math.abs(dp.globalMean - 0.5) < 1e-9, 'expected 0.5, got ' + dp.globalMean);
    assert.strictEqual(dp.weights[35], null, 'the thin bucket must not be trusted');
  })) p++; else f++;

  if (test('deriveProfile: always returns 168 weights', () => {
    assert.strictEqual(deriveProfile(emptyState()).weights.length, HOURS_PER_WEEK);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
