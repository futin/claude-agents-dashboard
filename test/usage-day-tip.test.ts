/**
 * `dayTip` (client/src/lib/usageHistory.ts): a week-fill day segment's tooltip — the held-offset date, the mid-day "from", the gain, the not-recorded note.
 */
import assert from 'node:assert';

import { dayTip, fmtClock, type WeekDay, type WeekRow } from '../client/src/lib/usageHistory.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const HOUR = 3_600_000;
/** UTC+1: a local midnight of 29 Mar 2026 is 28 Mar 23:00 UTC. */
const OFFSET = HOUR;
const MIDNIGHT = Date.UTC(2026, 2, 29) - OFFSET;

const label = (utcMs: number): string => new Date(utcMs).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function day(over: Partial<WeekDay> = {}): WeekDay {
  return { fromT: MIDNIGHT, toT: MIDNIGHT + 24 * HOUR, fromPct: 10, toPct: 22.34, offMs: 0, ...over };
}

function row(over: Partial<WeekRow> = {}): WeekRow {
  return {
    key: 'k', resetsAtMs: null, startT: null, firstT: MIDNIGHT - 5 * 24 * HOUR, current: false, prePct: 0, preCause: 'range', days: [], peakPct: 40,
    limitHits: 0, ...over,
  };
}

export function run(): number {
  console.log('\n=== dayTip (client/src/lib/usageHistory.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('the date is read in the held offset, not UTC: a +1h midnight labels its own day', () => {
    const tip = dayTip(row(), day(), OFFSET);
    assert.ok(tip.startsWith(label(Date.UTC(2026, 2, 29)) + '\n'), tip);
    assert.ok(!tip.startsWith(label(Date.UTC(2026, 2, 28))), 'read without the offset it would be a day early');
  }));

  tally(test('the gain and the end-of-day reading, to one decimal', () => {
    assert.ok(dayTip(row(), day(), OFFSET).endsWith('\n+12.3% of the week · 22.3% by the end of the day'));
  }));

  tally(test('a mid-day start — the row\'s first reading, with a pre-fill — shows "from HH:MM"', () => {
    const start = MIDNIGHT + 14.5 * HOUR;
    const tip = dayTip(row({ firstT: start, prePct: 5 }), day({ fromT: start }), OFFSET);
    assert.ok(tip.includes(` from ${fmtClock(start)}\n`), tip);
  }));

  tally(test('no "from" at a midnight, nor on a first reading with no pre-fill', () => {
    assert.ok(!dayTip(row({ prePct: 5 }), day(), OFFSET).includes(' from '));
    const start = MIDNIGHT + 9 * HOUR;
    assert.ok(!dayTip(row({ firstT: start, prePct: 0 }), day({ fromT: start }), OFFSET).includes(' from '));
  }));

  tally(test('an unrecorded stretch adds the not-recorded note, in hours or days; none without one', () => {
    assert.ok(dayTip(row(), day({ offMs: 2 * HOUR }), OFFSET).endsWith('\nincludes 2h not recorded — use from those hours lands here'));
    assert.ok(dayTip(row(), day({ offMs: 36 * HOUR }), OFFSET).includes('includes 1.5d not recorded'));
    assert.ok(!dayTip(row(), day(), OFFSET).includes('not recorded'));
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
