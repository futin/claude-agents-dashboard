import assert from 'node:assert';

import { describeCron, lastBefore, nextAfter, parseCron, toCalendarIntervals } from '../shared/cron.js';
import type { Cron } from '../shared/cron.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function must(expr: string): Cron {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(`"${expr}" should parse: ${r.error}`);
  return r.cron;
}

function sorted(s: Set<number>): number[] {
  return [...s].sort((a, b) => a - b);
}

// Local-time constructor on purpose: cron fires in the machine's local time, and an ISO string with Z would shift under a non-UTC TZ.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi);

export function run(): number {
  console.log('\n=== cron.ts ===\n');
  let p = 0, f = 0;

  if (test('parseCron: "0 22 * * *" is ok with single minute and hour', () => {
    const c = must('0 22 * * *');
    assert.deepStrictEqual(sorted(c.minute), [0]);
    assert.deepStrictEqual(sorted(c.hour), [22]);
    assert.strictEqual(c.domRestricted, false);
    assert.strictEqual(c.dowRestricted, false);
  })) p++; else f++;

  if (test('parseCron: four fields is an error naming the count', () => {
    const r = parseCron('0 22 * *');
    assert.deepStrictEqual(r, { ok: false, error: 'cron needs five fields (minute hour day month weekday); got 4' });
  })) p++; else f++;

  if (test('parseCron: six fields and an empty string are errors with their own counts', () => {
    const six = parseCron('0 22 * * * *');
    assert.ok(!six.ok && six.error.endsWith('got 6'));
    const none = parseCron('   ');
    assert.ok(!none.ok && none.error.endsWith('got 0'));
  })) p++; else f++;

  if (test('parseCron: out-of-range minute names the field', () => {
    const r = parseCron('60 0 * * *');
    assert.ok(!r.ok);
    if (!r.ok) assert.ok(r.error.includes('minute'), r.error);
  })) p++; else f++;

  if (test('parseCron: out-of-range hour, day, month and weekday each name their field', () => {
    for (const [expr, field] of [['0 24 * * *', 'hour'], ['0 0 0 * *', 'day'], ['0 0 32 * *', 'day'], ['0 0 * 0 *', 'month'], ['0 0 * 13 *', 'month'],
      ['0 0 * * 8', 'weekday']] as const) {
      const r = parseCron(expr);
      assert.ok(!r.ok, expr);
      if (!r.ok) assert.ok(r.error.includes(field), `${expr}: ${r.error}`);
    }
  })) p++; else f++;

  if (test('parseCron: "*/15 * * * *" expands to {0,15,30,45}', () => {
    assert.deepStrictEqual(sorted(must('*/15 * * * *').minute), [0, 15, 30, 45]);
  })) p++; else f++;

  if (test('parseCron: "0 7 * * 1-5" has weekday {1..5} and marks weekday restricted', () => {
    const c = must('0 7 * * 1-5');
    assert.deepStrictEqual(sorted(c.dow), [1, 2, 3, 4, 5]);
    assert.strictEqual(c.dowRestricted, true);
    assert.strictEqual(c.domRestricted, false);
  })) p++; else f++;

  if (test('parseCron: weekday 7 normalises to 0 (also inside a range)', () => {
    assert.deepStrictEqual(sorted(must('0 9 * * 7').dow), [0]);
    assert.deepStrictEqual(sorted(must('0 9 * * 5-7').dow), [0, 5, 6]);
  })) p++; else f++;

  if (test('parseCron: lists, ranges with steps and mixed lists', () => {
    assert.deepStrictEqual(sorted(must('0,30 8-10 * * *').minute), [0, 30]);
    assert.deepStrictEqual(sorted(must('0,30 8-10 * * *').hour), [8, 9, 10]);
    assert.deepStrictEqual(sorted(must('0 1-10/3 * * *').hour), [1, 4, 7, 10]);
    assert.deepStrictEqual(sorted(must('0 0 1,15 * *').dom), [1, 15]);
  })) p++; else f++;

  if (test('parseCron: malformed pieces are errors (reversed range, zero step, empty list item, junk)', () => {
    for (const expr of ['0 10-5 * * *', '*/0 * * * *', '1,,2 * * * *', 'a * * * *', '1- * * * *', '*/x * * * *', '5/15 * * * *']) {
      assert.strictEqual(parseCron(expr).ok, false, expr);
    }
  })) p++; else f++;

  if (test('parseCron: day/weekday restricted flags follow the field text, so "*/2" counts as unrestricted like vixie cron', () => {
    assert.strictEqual(must('0 0 1 * *').domRestricted, true);
    assert.strictEqual(must('0 0 */2 * *').domRestricted, false);
  })) p++; else f++;

  if (test('nextAfter: 21:59 with "0 22 * * *" is 22:00 the same day', () => {
    assert.strictEqual(nextAfter(must('0 22 * * *'), at(2026, 10, 19, 21, 59))?.getTime(), at(2026, 10, 19, 22, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: from exactly 22:00:00 is strictly after, so the next day', () => {
    assert.strictEqual(nextAfter(must('0 22 * * *'), at(2026, 10, 19, 22, 0))?.getTime(), at(2026, 10, 20, 22, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: 22:00:30 is also past that minute, so the next day', () => {
    const from = new Date(2026, 9, 19, 22, 0, 30);
    assert.strictEqual(nextAfter(must('0 22 * * *'), from)?.getTime(), at(2026, 10, 20, 22, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: "0 9 1 * *" from Oct 19 is Nov 1 09:00', () => {
    assert.strictEqual(nextAfter(must('0 9 1 * *'), at(2026, 10, 19, 12, 0))?.getTime(), at(2026, 11, 1, 9, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: "0 0 31 2 *" never matches, so null', () => {
    assert.strictEqual(nextAfter(must('0 0 31 2 *'), at(2026, 10, 19, 0, 0)), null);
  })) p++; else f++;

  if (test('nextAfter: weekday set skips the weekend (Fri 17:00 -> Mon 07:00)', () => {
    // 2026-10-23 is a Friday.
    assert.strictEqual(nextAfter(must('0 7 * * 1-5'), at(2026, 10, 23, 17, 0))?.getTime(), at(2026, 10, 26, 7, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: "*/15 * * * *" steps to the next quarter hour', () => {
    assert.strictEqual(nextAfter(must('*/15 * * * *'), at(2026, 10, 19, 10, 16))?.getTime(), at(2026, 10, 19, 10, 30).getTime());
    assert.strictEqual(nextAfter(must('*/15 * * * *'), at(2026, 10, 19, 10, 45))?.getTime(), at(2026, 10, 19, 11, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: "0 0 29 2 *" lands on the next leap day', () => {
    assert.strictEqual(nextAfter(must('0 0 29 2 *'), at(2026, 10, 19))?.getTime(), at(2028, 2, 29).getTime());
  })) p++; else f++;

  if (test('nextAfter: day-of-month and weekday both restricted fire on either (cron OR)', () => {
    // 2026-10-19 is a Monday: the 20th (dom) comes before the next Friday the 23rd.
    const c = must('0 9 20 * 5');
    assert.strictEqual(nextAfter(c, at(2026, 10, 19, 12, 0))?.getTime(), at(2026, 10, 20, 9, 0).getTime());
    assert.strictEqual(nextAfter(c, at(2026, 10, 20, 12, 0))?.getTime(), at(2026, 10, 23, 9, 0).getTime());
  })) p++; else f++;

  if (test('nextAfter: a year rollover works (Dec 31 23:59 -> Jan 1 00:00)', () => {
    assert.strictEqual(nextAfter(must('0 0 * * *'), at(2026, 12, 31, 23, 59))?.getTime(), at(2027, 1, 1, 0, 0).getTime());
  })) p++; else f++;

  if (test('lastBefore: 22:01 with "0 22 * * *" is 22:00 the same day', () => {
    assert.strictEqual(lastBefore(must('0 22 * * *'), at(2026, 10, 19, 22, 1))?.getTime(), at(2026, 10, 19, 22, 0).getTime());
  })) p++; else f++;

  if (test('lastBefore: from exactly 22:00:00 is strictly before, so the previous day', () => {
    assert.strictEqual(lastBefore(must('0 22 * * *'), at(2026, 10, 19, 22, 0))?.getTime(), at(2026, 10, 18, 22, 0).getTime());
  })) p++; else f++;

  if (test('lastBefore: 22:00:30 counts the 22:00 slot that just passed', () => {
    const from = new Date(2026, 9, 19, 22, 0, 30);
    assert.strictEqual(lastBefore(must('0 22 * * *'), from)?.getTime(), at(2026, 10, 19, 22, 0).getTime());
  })) p++; else f++;

  if (test('lastBefore: "0 9 1 * *" from Oct 19 is Oct 1 09:00; "0 0 31 2 *" is null', () => {
    assert.strictEqual(lastBefore(must('0 9 1 * *'), at(2026, 10, 19, 12, 0))?.getTime(), at(2026, 10, 1, 9, 0).getTime());
    assert.strictEqual(lastBefore(must('0 0 31 2 *'), at(2026, 10, 19)), null);
  })) p++; else f++;

  if (test('lastBefore: weekday set skips back over the weekend (Mon 06:00 -> Fri 07:00) and a year rollover works', () => {
    assert.strictEqual(lastBefore(must('0 7 * * 1-5'), at(2026, 10, 26, 6, 0))?.getTime(), at(2026, 10, 23, 7, 0).getTime());
    assert.strictEqual(lastBefore(must('0 0 * * *'), at(2027, 1, 1, 0, 0))?.getTime(), at(2026, 12, 31, 0, 0).getTime());
  })) p++; else f++;

  if (test('lastBefore: "0 0 29 2 *" from 2026 reaches back to the 2024 leap day', () => {
    assert.strictEqual(lastBefore(must('0 0 29 2 *'), at(2026, 10, 19))?.getTime(), at(2024, 2, 29).getTime());
  })) p++; else f++;

  if (test('toCalendarIntervals: "0 22 * * *" is one Minute/Hour dict', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('0 22 * * *')), [{ Minute: 0, Hour: 22 }]);
  })) p++; else f++;

  if (test('toCalendarIntervals: "0 7 * * 1-5" is five dicts, one per weekday', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('0 7 * * 1-5')), [1, 2, 3, 4, 5].map((Weekday) => ({ Minute: 0, Hour: 7, Weekday })));
  })) p++; else f++;

  if (test('toCalendarIntervals: "*/15 * * * *" is four Minute-only dicts', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('*/15 * * * *')), [0, 15, 30, 45].map((Minute) => ({ Minute })));
  })) p++; else f++;

  if (test('toCalendarIntervals: day-of-month and weekday both restricted is null', () => {
    assert.strictEqual(toCalendarIntervals(must('0 9 1-5 * 1')), null);
  })) p++; else f++;

  if (test('toCalendarIntervals: day-of-month and month emit Day and Month keys; only restricted fields appear', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('30 9 1 6 *')), [{ Minute: 30, Hour: 9, Day: 1, Month: 6 }]);
  })) p++; else f++;

  if (test('toCalendarIntervals: "0 9 * * 7" emits Weekday 0 (Sunday)', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('0 9 * * 7')), [{ Minute: 0, Hour: 9, Weekday: 0 }]);
  })) p++; else f++;

  if (test('toCalendarIntervals: "* * * * *" is one empty dict (every minute)', () => {
    assert.deepStrictEqual(toCalendarIntervals(must('* * * * *')), [{}]);
  })) p++; else f++;

  if (test('describeCron: the four named shapes', () => {
    assert.strictEqual(describeCron(must('0 22 * * *')), '22:00 daily');
    assert.strictEqual(describeCron(must('0 7 * * 1-5')), '07:00 Mon–Fri');
    assert.strictEqual(describeCron(must('30 9 1 * *')), '1st of month 09:30');
    assert.strictEqual(describeCron(must('0 9 * * 0')), 'Sun 09:00');
  })) p++; else f++;

  if (test('describeCron: weekday 7 reads as Sun; other day-of-month ordinals read naturally', () => {
    assert.strictEqual(describeCron(must('0 9 * * 7')), 'Sun 09:00');
    assert.strictEqual(describeCron(must('0 9 2 * *')), '2nd of month 09:00');
    assert.strictEqual(describeCron(must('0 9 3 * *')), '3rd of month 09:00');
    assert.strictEqual(describeCron(must('0 9 11 * *')), '11th of month 09:00');
    assert.strictEqual(describeCron(must('0 9 21 * *')), '21st of month 09:00');
  })) p++; else f++;

  if (test('describeCron: anything else is the expression itself, whitespace-normalised', () => {
    assert.strictEqual(describeCron(must('*/15 * * * *')), '*/15 * * * *');
    assert.strictEqual(describeCron(must('0  9   * *  1,3')), '0 9 * * 1,3');
    assert.strictEqual(describeCron(must('0 9 1 6 *')), '0 9 1 6 *');
  })) p++; else f++;

  console.log(`\ncron: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
