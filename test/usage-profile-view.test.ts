import assert from 'node:assert';

import {
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
    // The current week is the one still accumulating, so its folds are 7 days
    // out. Returning today would promise weights that cannot arrive.
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

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
