import assert from 'node:assert';

import {
  cellTitle,
  earliestWeightMs,
  nextOccurrenceMs,
  profileProgress,
  nextWeekStartMs,
  fmtObserved,
  TRUST_FLOOR_MIN
} from '../client/src/lib/usageProfile.js';
import type { UsageProfileCell } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const cell = (over: Partial<UsageProfileCell> = {}): UsageProfileCell =>
  ({ hourOfWeek: 0, weight: null, observedMin: 0, staleWeeks: 0, ...over });

/** 168 empty cells, with `over` applied at the given indices. */
function grid(over: Record<number, Partial<UsageProfileCell>> = {}): UsageProfileCell[] {
  return Array.from({ length: 168 }, (_, hourOfWeek) =>
    cell({ hourOfWeek, ...(over[hourOfWeek] ?? {}) }));
}

export function run(): number {
  console.log('\n=== usageProfile.ts (inspector status line) ===\n');
  let p = 0, f = 0;

  if (test('profileProgress: a fresh profile is all zeroes', () => {
    assert.deepStrictEqual(profileProgress(grid()),
      { touched: 0, totalMin: 0, atFloor: 0, trusted: 0 });
  })) p++; else f++;

  if (test('profileProgress: counts touched, total, floor and trusted separately', () => {
    const g = grid({
      33: { observedMin: 30 },                         // touched, under the floor
      34: { observedMin: 90 },                          // touched, over the floor, unfolded
      35: { observedMin: 600, weight: 0.8 },            // touched, over the floor, trusted
      36: { observedMin: 12 }
    });
    assert.deepStrictEqual(profileProgress(g),
      { touched: 4, totalMin: 732, atFloor: 2, trusted: 1 });
  })) p++; else f++;

  if (test('profileProgress: the trust floor is inclusive at exactly 60', () => {
    // The gate is `>= TRUST_FLOOR_MIN`; an hour of evidence must count as an hour.
    assert.strictEqual(profileProgress(grid({ 33: { observedMin: TRUST_FLOOR_MIN } })).atFloor, 1);
    assert.strictEqual(profileProgress(grid({ 33: { observedMin: TRUST_FLOOR_MIN - 0.5 } })).atFloor, 0);
  })) p++; else f++;

  if (test('profileProgress: past the floor but unfolded is NOT trusted', () => {
    // This is the state the whole status line exists to explain: enough
    // evidence, no weight yet, because the week has not rolled over.
    const g = grid({ 33: { observedMin: 600, weight: null } });
    const r = profileProgress(g);
    assert.strictEqual(r.atFloor, 1);
    assert.strictEqual(r.trusted, 0, 'a null weight is never trusted, however much evidence');
  })) p++; else f++;

  // ── nextWeekStartMs: local midnight of the coming Monday ──
  // Built from local components so the assertions hold in any TZ.
  const localMidnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

  if (test('nextWeekStartMs: from a Wednesday, the Monday five days later', () => {
    // 2026-08-26 is a Wednesday; 2026-08-31 is the Monday after it.
    const wed = new Date(2026, 7, 26, 13, 45, 30).getTime();
    assert.strictEqual(nextWeekStartMs(wed), localMidnight(2026, 8, 31));
  })) p++; else f++;

  if (test('nextWeekStartMs: from a Sunday, tomorrow', () => {
    // 2026-08-30 is a Sunday. getDay() is 0 there, which a naive ISO
    // conversion turns into "8 days away" — this pins it at 1.
    const sun = new Date(2026, 7, 30, 23, 59, 0).getTime();
    assert.strictEqual(nextWeekStartMs(sun), localMidnight(2026, 8, 31));
  })) p++; else f++;

  if (test('nextWeekStartMs: from a Monday, the FOLLOWING Monday, not today', () => {
    // This marks the END of the current ISO week, which today is not. Folds are
    // dated by earliestWeightMs; this only bounds a bucket stamped this week.
    const mon = new Date(2026, 7, 31, 9, 0, 0).getTime();
    assert.strictEqual(nextWeekStartMs(mon), localMidnight(2026, 9, 7));
  })) p++; else f++;

  if (test('nextWeekStartMs: crosses a month and a year end', () => {
    // 2026-12-31 is a Thursday → Monday 2027-01-04.
    const thu = new Date(2026, 11, 31, 20, 0, 0).getTime();
    assert.strictEqual(nextWeekStartMs(thu), localMidnight(2027, 1, 4));
  })) p++; else f++;

  if (test('nextWeekStartMs: always lands on a Monday at local midnight', () => {
    for (let day = 1; day <= 28; day++) {
      const at = nextWeekStartMs(new Date(2026, 7, day, 17, 30, 0).getTime());
      const d = new Date(at);
      assert.strictEqual(d.getDay(), 1, 'day ' + day + ' → ' + d.toString());
      assert.strictEqual(d.getHours(), 0, 'day ' + day + ' should be midnight');
      assert.ok(at > new Date(2026, 7, day, 17, 30, 0).getTime(), 'day ' + day + ' must be in the future');
    }
  })) p++; else f++;

  if (test('fmtObserved: minutes under an hour, h/m above', () => {
    assert.strictEqual(fmtObserved(0), '0 min');
    assert.strictEqual(fmtObserved(30.4), '30 min');
    assert.strictEqual(fmtObserved(59), '59 min');
    assert.strictEqual(fmtObserved(60), '1h 00m');
    assert.strictEqual(fmtObserved(125), '2h 05m');
  })) p++; else f++;

  // cellTitle — the blank cell has to name the gate it is actually waiting on.

  if (test('cellTitle: a cell at the floor with no weight blames the fold, not the minutes', () => {
    const t = cellTitle(cell({ observedMin: 60, weight: null }), 1, 9);
    assert.ok(t.startsWith('Mon 09:00 · every week\n'), t);
    assert.ok(t.includes('60 min recorded'), t);
    assert.ok(t.includes('waiting for this hour to come round in a new week'), t);
    // The regression: "60 of 60 min needed" read as a stuck feature.
    assert.ok(!t.includes('of ' + TRUST_FLOOR_MIN + ' min needed'), t);
    assert.ok(t.includes('falls back to the weekly mean'), t);
  })) p++; else f++;

  if (test('cellTitle: a cell under the floor still asks for minutes', () => {
    const t = cellTitle(cell({ observedMin: 32, weight: null }), 4, 0);
    assert.ok(t.startsWith('Thu 00:00 · every week\n'), t);
    assert.ok(t.includes('32 of ' + TRUST_FLOOR_MIN + ' min needed'), t);
    assert.ok(!t.includes('come round in a new week'), t);
  })) p++; else f++;

  if (test('cellTitle: fractional minutes floor, so 59.98 never reads as 60 of 60', () => {
    // Live data: buckets sit at 59.98 min, and rounding printed a demand the
    // cell had already met. Under the floor it is still under the floor.
    const t = cellTitle(cell({ observedMin: 59.98, weight: null }), 1, 0);
    assert.ok(t.includes('59 of ' + TRUST_FLOOR_MIN + ' min needed'), t);
    assert.ok(!t.includes('60 of ' + TRUST_FLOOR_MIN), t);
  })) p++; else f++;

  if (test('cellTitle: an untouched cell asks for the whole floor', () => {
    const t = cellTitle(cell({ observedMin: 0, weight: null }), 0, 3);
    assert.ok(t.includes('0 of ' + TRUST_FLOOR_MIN + ' min needed'), t);
  })) p++; else f++;

  if (test('cellTitle: a weighted cell states evidence in whole weeks, floored', () => {
    // A weighted cell has necessarily cleared the floor, so the minutes line
    // must never appear on one — 90 min is one week of evidence, not "under one".
    const one = cellTitle(cell({ observedMin: 90, weight: 0.45 }), 2, 14);
    assert.ok(one.includes('45% active'), one);
    assert.ok(one.includes('1 week of evidence'), one);
    assert.ok(!one.includes('min needed') && !one.includes('under one week'), one);
    const many = cellTitle(cell({ observedMin: 300, weight: 0.45 }), 2, 14);
    assert.ok(many.includes('5 weeks of evidence'), many);
  })) p++; else f++;

  if (test('cellTitle: a measured-zero cell says never active, not missing', () => {
    const t = cellTitle(cell({ observedMin: 240, weight: 0 }), 6, 4);
    assert.ok(t.includes('never active — measured, not missing'), t);
    assert.ok(!t.includes('no weight yet'), t);
  })) p++; else f++;

  if (test('cellTitle: the stale line appears only past eight weeks', () => {
    const fresh = cellTitle(cell({ observedMin: 600, weight: 0.5, staleWeeks: 8 }), 5, 12);
    assert.ok(!fresh.includes('last seen'), fresh);
    const old = cellTitle(cell({ observedMin: 600, weight: 0.5, staleWeeks: 9 }), 5, 12);
    assert.ok(old.includes('last seen 9 weeks ago'), old);
  })) p++; else f++;

  // nextOccurrenceMs / earliestWeightMs — when a blank cell can first show a weight.

  const hw = (day: number, hour: number) => day * 24 + hour;

  if (test('nextOccurrenceMs: the next matching hour, strictly in the future', () => {
    // Mon 31 Aug 2026, 09:30 local.
    const now = new Date(2026, 7, 31, 9, 30, 0).getTime();
    assert.strictEqual(nextOccurrenceMs(hw(2, 23), now),
      new Date(2026, 8, 1, 23, 0, 0).getTime(), 'Tue 23:00 is tomorrow');
    assert.strictEqual(nextOccurrenceMs(hw(0, 3), now),
      new Date(2026, 8, 6, 3, 0, 0).getTime(), 'Sun 03:00 is this coming Sunday');
  })) p++; else f++;

  if (test('nextOccurrenceMs: the hour in progress is a week out, not now', () => {
    // The fold fires on the tick that enters the bucket, so this hour's chance
    // has already been taken. Returning `now` would promise a fold that passed.
    const now = new Date(2026, 7, 31, 9, 30, 0).getTime();
    assert.strictEqual(nextOccurrenceMs(hw(1, 9), now),
      new Date(2026, 8, 7, 9, 0, 0).getTime());
  })) p++; else f++;

  if (test('earliestWeightMs: a stale-stamped hour folds days before the next Monday', () => {
    // The regression. Live data on Mon 31 Aug: hours recorded last week carried
    // W35 stamps, so the first weight was six days sooner than the status line's
    // "the week rolls over on Mon 7 Sept".
    const now = new Date(2026, 7, 31, 21, 40, 0).getTime();
    const g = grid({ [hw(3, 0)]: { observedMin: 60, staleWeeks: 1 } });
    assert.strictEqual(earliestWeightMs(g, now), new Date(2026, 8, 2, 0, 0, 0).getTime());
    assert.ok(earliestWeightMs(g, now)! < nextWeekStartMs(now), 'must beat the next Monday');
  })) p++; else f++;

  if (test('earliestWeightMs: an hour short of the floor waits out its shortfall', () => {
    // 44 of 60 min: it folds at 23:00 but only clears the floor 16 min in, and
    // that is when a weight actually becomes visible.
    const now = new Date(2026, 7, 31, 21, 40, 0).getTime();
    const g = grid({ [hw(2, 23)]: { observedMin: 44, staleWeeks: 1 } });
    assert.strictEqual(earliestWeightMs(g, now), new Date(2026, 8, 1, 23, 16, 0).getTime());
  })) p++; else f++;

  if (test('earliestWeightMs: an hour stamped this week must clear the week boundary', () => {
    // staleWeeks 0 means the pending minutes belong to the current ISO week, so
    // its next occurrence folds nothing.
    const now = new Date(2026, 7, 31, 21, 40, 0).getTime();
    const g = grid({ [hw(3, 0)]: { observedMin: 60, staleWeeks: 0 } });
    assert.strictEqual(earliestWeightMs(g, now), new Date(2026, 8, 9, 0, 0, 0).getTime());
  })) p++; else f++;

  if (test('earliestWeightMs: a Sunday hour stamped this week skips the same ISO week', () => {
    // The Sunday-indexed grid and the Monday-indexed ISO week disagree: Sun 6
    // Sept is still this ISO week, so that pass folds nothing.
    const now = new Date(2026, 7, 31, 21, 40, 0).getTime();
    const g = grid({ [hw(0, 3)]: { observedMin: 60, staleWeeks: 0 } });
    assert.strictEqual(earliestWeightMs(g, now), new Date(2026, 8, 13, 3, 0, 0).getTime());
  })) p++; else f++;

  if (test('earliestWeightMs: takes the soonest cell, and ignores folded ones', () => {
    const now = new Date(2026, 7, 31, 21, 40, 0).getTime();
    const g = grid({
      [hw(5, 0)]: { observedMin: 60, staleWeeks: 1 },              // Fri
      [hw(3, 0)]: { observedMin: 60, staleWeeks: 1 },              // Wed — sooner
      [hw(2, 0)]: { observedMin: 600, weight: 0.4, staleWeeks: 1 } // Tue, already weighted
    });
    assert.strictEqual(earliestWeightMs(g, now), new Date(2026, 8, 2, 0, 0, 0).getTime());
  })) p++; else f++;

  if (test('earliestWeightMs: nothing recorded means nothing to date', () => {
    assert.strictEqual(earliestWeightMs(grid(), new Date(2026, 7, 31, 21, 40, 0).getTime()), null);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
