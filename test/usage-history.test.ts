import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  emptyState,
  classifyInterval,
  isoWeekKey,
  accumulate,
  deriveProfile,
  MAX_ATTRIBUTABLE_MS,
  TRUST_FLOOR_MIN,
  EWMA_ALPHA,
  shouldWrite,
  appendSample,
  readRecentSamples,
  rotateIfNeeded,
  loadProfileState,
  saveProfileState,
  HISTORY_FILE,
  PROFILE_FILE,
  HEARTBEAT_MS,
  MAX_HISTORY_BYTES,
  recordTick,
  observedActiveMs,
  resetRecorder
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

  // Four consecutive *real* fetches of one unchanged 5-hour window, straight out
  // of .usage-history.jsonl. The endpoint recomputes resetsAt per request, so
  // string equality would call every one of these a reset and the profile would
  // never learn a minute. This is the case that caught it.
  const JITTER = [
    '2026-08-25T21:19:59.657311+00:00',
    '2026-08-25T21:20:00.387292+00:00',
    '2026-08-25T21:20:00.404859+00:00',
    '2026-08-25T21:20:00.508567+00:00'
  ];

  if (test('classify: sub-second resetsAt jitter is the same window, not a reset', () => {
    for (let i = 1; i < JITTER.length; i++) {
      assert.strictEqual(
        classifyInterval(s(0, 40, JITTER[i - 1]), s(MIN, 40, JITTER[i])), 'idle',
        'jitter pair ' + i
      );
    }
    // Across the whole set, not just neighbours.
    assert.strictEqual(classifyInterval(s(0, 40, JITTER[0]), s(MIN, 41, JITTER[3])), 'active');
  })) p++; else f++;

  if (test('MUTATION GUARD: the jitter tolerance does not swallow a real window change', () => {
    // R1 → R2 is five hours: a genuinely new 5h window. Widen the tolerance far
    // enough to cover that and this fails.
    assert.strictEqual(classifyInterval(s(0, 40, R1), s(MIN, 40, R2)), 'reset');
    // And an unscoped ⇄ scoped transition is a real change too, not jitter.
    assert.strictEqual(classifyInterval(s(0, 40, null), s(MIN, 40, R1)), 'reset');
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

  // ── I/O shell (tmpdir-backed) ──

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-'));

  if (test('shouldWrite: the first sample always writes', () => {
    assert.strictEqual(shouldWrite(null, s(0, 40)), true);
  })) p++; else f++;

  if (test('shouldWrite: a changed utilization writes', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(MIN, 41)), true);
  })) p++; else f++;

  if (test('shouldWrite: a changed resetsAt writes even at the same utilization', () => {
    assert.strictEqual(shouldWrite(s(0, 40, R1), s(MIN, 40, R2)), true);
  })) p++; else f++;

  if (test('shouldWrite: sub-second resetsAt jitter is not a change', () => {
    // Otherwise write-on-change silently becomes write-always: ~55 MB/year
    // instead of ~17, which is the arithmetic the storage decision rests on.
    assert.strictEqual(shouldWrite(s(0, 40, JITTER[0]), s(MIN, 40, JITTER[3])), false);
  })) p++; else f++;

  if (test('shouldWrite: an unchanged sample inside the heartbeat does not write', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(MIN, 40)), false);
  })) p++; else f++;

  if (test('shouldWrite: an unchanged sample past the heartbeat writes', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(HEARTBEAT_MS + MIN, 40)), true);
  })) p++; else f++;

  if (test('append then read round-trips samples in order', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'rt-'));
    appendSample(s(1000, 10), dir);
    appendSample(s(2000, 20), dir);
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[0].t, 1000);
    assert.strictEqual(back[1].utilization, 20);
  })) p++; else f++;

  if (test('readRecentSamples on an absent file returns empty, does not throw', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'absent-'));
    assert.deepStrictEqual(readRecentSamples(dir), []);
  })) p++; else f++;

  if (test('readRecentSamples skips a truncated leading line', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'trunc-'));
    // A partial first line is what a tail read produces mid-file.
    fs.writeFileSync(path.join(dir, HISTORY_FILE),
      '{"t":1,"utiliz\n' + JSON.stringify({ t: 2000, utilization: 20, resetsAt: R1 }) + '\n');
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].t, 2000);
  })) p++; else f++;

  if (test('readRecentSamples drops a malformed line without losing the good ones', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
    fs.writeFileSync(path.join(dir, HISTORY_FILE),
      JSON.stringify({ t: 1000, utilization: 10, resetsAt: R1 }) + '\n' +
      'not json at all\n' +
      JSON.stringify({ t: 3000, utilization: 30, resetsAt: R1 }) + '\n');
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[1].t, 3000);
  })) p++; else f++;

  if (test('profile state round-trips through disk', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'prof-'));
    const st = emptyState();
    st.buckets[33] = { weight: 0.75, weekStamp: '2026-W35', observedMin: 5, activeMin: 2, lifetimeObservedMin: 600 };
    assert.strictEqual(saveProfileState(st, dir), true);
    const back = loadProfileState(dir);
    assert.strictEqual(back.buckets[33].weight, 0.75);
    assert.strictEqual(back.buckets[33].lifetimeObservedMin, 600);
    assert.strictEqual(back.buckets.length, HOURS_PER_WEEK);
  })) p++; else f++;

  if (test('loadProfileState on an absent file returns an empty state', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'noprof-'));
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
    assert.strictEqual(loadProfileState(dir).buckets[0].weight, null);
  })) p++; else f++;

  if (test('loadProfileState on a malformed file falls back rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'badprof-'));
    fs.writeFileSync(path.join(dir, PROFILE_FILE), '{ this is not json');
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
  })) p++; else f++;

  if (test('loadProfileState on a wrong-length bucket array falls back', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'shortprof-'));
    fs.writeFileSync(path.join(dir, PROFILE_FILE), JSON.stringify({ buckets: [{ weight: 1 }] }));
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
    assert.strictEqual(loadProfileState(dir).buckets[0].weight, null);
  })) p++; else f++;

  if (test('saveProfileState leaves no .tmp file behind', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'atomic-'));
    saveProfileState(emptyState(), dir);
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  })) p++; else f++;

  // The rotation cases pass an explicit small cap rather than writing 32 MB per
  // case: the behaviour under test is the trim-and-keep-the-tail logic, and
  // MAX_HISTORY_BYTES is asserted separately to be the production default.
  const ROT_CAP = 64 * 1024;

  if (test('MAX_HISTORY_BYTES is the production cap the timer runs against', () => {
    assert.strictEqual(MAX_HISTORY_BYTES, 33_554_432);
  })) p++; else f++;

  if (test('rotation trims an oversized log but keeps the newest lines readable', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'rot-'));
    const file = path.join(dir, HISTORY_FILE);
    const line = JSON.stringify({ t: 1, utilization: 1, resetsAt: R1 }) + '\n';
    // Exceed the cap, ending with a uniquely identifiable newest line.
    fs.writeFileSync(file, line.repeat(Math.ceil(ROT_CAP / line.length) + 10));
    fs.appendFileSync(file, JSON.stringify({ t: 999_999, utilization: 77, resetsAt: R1 }) + '\n');
    rotateIfNeeded(dir, ROT_CAP);
    assert.ok(fs.statSync(file).size < ROT_CAP, 'still oversized after rotation');
    const back = readRecentSamples(dir);
    assert.strictEqual(back[back.length - 1].t, 999_999, 'newest line lost in rotation');
  })) p++; else f++;

  if (test('rotation does not touch a log under the cap', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'norot-'));
    appendSample(s(1000, 10), dir);
    const before = fs.statSync(path.join(dir, HISTORY_FILE)).size;
    rotateIfNeeded(dir);
    assert.strictEqual(fs.statSync(path.join(dir, HISTORY_FILE)).size, before);
  })) p++; else f++;

  if (test('the profile survives rotation of the raw log', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'rotprof-'));
    const st = emptyState();
    st.buckets[33] = { weight: 0.6, weekStamp: '2026-W35', observedMin: 0, activeMin: 0, lifetimeObservedMin: 900 };
    saveProfileState(st, dir);
    const file = path.join(dir, HISTORY_FILE);
    const line = JSON.stringify({ t: 1, utilization: 1, resetsAt: R1 }) + '\n';
    fs.writeFileSync(file, line.repeat(Math.ceil(ROT_CAP / line.length) + 10));
    rotateIfNeeded(dir, ROT_CAP);
    // The learned profile is derived state in its own file; truncating the raw
    // log must not touch it. This is why the EWMA never needs the raw history.
    assert.strictEqual(loadProfileState(dir).buckets[33].weight, 0.6);
    assert.strictEqual(loadProfileState(dir).buckets[33].lifetimeObservedMin, 900);
  })) p++; else f++;

  // ── the classifier ring behind observedActiveMs ──

  if (test('observedActiveMs: an empty ring returns null, never 0', () => {
    resetRecorder();
    assert.strictEqual(observedActiveMs(MON_09, MON_09 + H), null);
  })) p++; else f++;

  if (test('observedActiveMs: one active minute inside a fully covered span', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ring-'));
    resetRecorder();
    // Two idle minutes, one active minute, one more idle: coverage starts at MON_09.
    recordTick(s(MON_09, 40), dir);
    recordTick(s(MON_09 + MIN, 40), dir);
    recordTick(s(MON_09 + 2 * MIN, 41), dir);   // the active minute
    recordTick(s(MON_09 + 3 * MIN, 41), dir);
    assert.strictEqual(observedActiveMs(MON_09, MON_09 + 3 * MIN), 60_000);
  })) p++; else f++;

  if (test('observedActiveMs: a span reaching back before the ring returns null', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ring-partial-'));
    resetRecorder();
    recordTick(s(MON_09, 40), dir);
    recordTick(s(MON_09 + MIN, 41), dir);
    // Half-covered would undercount active time and overstate the rate, so the
    // only honest answer is "I don't know".
    assert.strictEqual(observedActiveMs(MON_09 - H, MON_09 + MIN), null);
  })) p++; else f++;

  if (test('observedActiveMs: only the overlap with the span counts', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ring-overlap-'));
    resetRecorder();
    recordTick(s(MON_09, 40), dir);
    recordTick(s(MON_09 + 2 * MIN, 42), dir);   // 2 active minutes, MON_09 → +2min
    recordTick(s(MON_09 + 3 * MIN, 42), dir);
    // Ask about the second half of the active interval only.
    assert.strictEqual(observedActiveMs(MON_09 + MIN, MON_09 + 3 * MIN), 60_000);
  })) p++; else f++;

  if (test('recordTick: an idle tick teaches the profile without writing a line', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'tick-'));
    resetRecorder();
    recordTick(s(MON_09, 40), dir);              // first sample always writes
    recordTick(s(MON_09 + MIN, 40), dir);        // unchanged, inside the heartbeat
    const lines = fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1, 'the unchanged sample must not be appended');
    assert.strictEqual(observedActiveMs(MON_09, MON_09 + MIN), 0, 'idle, but observed');
  })) p++; else f++;

  resetRecorder();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
