import assert from 'node:assert';

import { headBarPct, walkRows, weightSource } from '../client/src/lib/walkRows.js';
import type { ForecastStep } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;

/**
 * A walk of whole local hours from `startMs`, each adding `gain`. Local
 * components on purpose: the rows are grouped by the *browser's* calendar day,
 * so a UTC-built fixture would fold differently in every timezone.
 */
function walkOf(flags: boolean[], opts: { startMs: number; gain?: number; from?: number }): ForecastStep[] {
  const gain = opts.gain ?? 1;
  let cum = opts.from ?? 0;
  return flags.map((learned, i) => {
    cum += gain;
    return {
      t: new Date(opts.startMs + i * H).toISOString(),
      gain, cum, weight: learned ? 0.8 : 0.31, learned
    };
  });
}

export function run(): number {
  console.log('\n=== walkRows.ts (the walk, folded into day rows) ===\n');
  let p = 0, f = 0;

  // Local noon, so the first row is a part-day and the fold has two days in it.
  const NOON = new Date(2026, 8, 9, 12, 0, 0).getTime();

  if (test('an empty walk folds to no rows and keeps the headroom it started with', () => {
    const t = walkRows([], { resetsAt: null, startHead: 39 });
    assert.deepStrictEqual(t.rows, []);
    assert.strictEqual(t.totals.endHead, 39, 'nothing walked, nothing spent');
    assert.strictEqual(t.totals.crossed, false, 'nothing walked, nothing crossed');
    assert.strictEqual(t.totals.hours, 0);
    assert.strictEqual(t.startHead, 39);
  })) p++; else f++;

  if (test('one row per local calendar day, the first one a part-day', () => {
    const w = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 1, from: 61 });
    const resetsAt = new Date(NOON + 30 * H).toISOString();
    const t = walkRows(w, { resetsAt, startHead: 39 });
    assert.strictEqual(t.rows.length, 2, 'noon Wed, then Thu to 17:00');
    assert.strictEqual(t.rows[0].isNow, true);
    assert.strictEqual(t.rows[1].isNow, false);
    assert.strictEqual(t.rows[0].hours, 12, 'noon to midnight');
    assert.strictEqual(t.rows[1].hours, 18);
  })) p++; else f++;

  if (test('the rows sum to the walk: hours, slices and points spent', () => {
    const w = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 1.4, from: 61 });
    const t = walkRows(w, { resetsAt: new Date(NOON + 30 * H).toISOString(), startHead: 39 });
    assert.strictEqual(t.totals.hours, 30);
    assert.strictEqual(t.totals.slices, 30);
    assert.ok(Math.abs(t.totals.spent - 30 * 1.4) < 1e-9);
    assert.ok(Math.abs(t.rows.reduce((n, r) => n + r.hours, 0) - t.totals.hours) < 1e-9);
  })) p++; else f++;

  if (test('active hours are Σ weight × hours, not a count of busy slices', () => {
    // Twelve hours at 0.8 and twelve at 0.31 — the duty cycle's own unit.
    const flags = [...new Array(12).fill(true), ...new Array(12).fill(false)];
    const w = walkOf(flags, { startMs: NOON, gain: 1, from: 0 });
    const t = walkRows(w, { resetsAt: new Date(NOON + 24 * H).toISOString(), startHead: 100 });
    assert.ok(Math.abs(t.totals.activeHours - (12 * 0.8 + 12 * 0.31)) < 1e-9);
    assert.strictEqual(t.totals.learned, 12);
    assert.strictEqual(t.totals.slices, 24);
  })) p++; else f++;

  if (test('the last slice runs to the reset, not to a whole hour it does not have', () => {
    // Twelve slices, but the reset falls 30 minutes into the twelfth.
    const w = walkOf(new Array(12).fill(true), { startMs: NOON, gain: 1, from: 0 });
    const resetsAt = new Date(NOON + 11 * H + H / 2).toISOString();
    const t = walkRows(w, { resetsAt, startHead: 100 });
    assert.strictEqual(t.totals.hours, 11.5, 'the tail is half an hour long');
  })) p++; else f++;

  if (test('with no reset the last slice is assumed whole rather than dropped', () => {
    const w = walkOf(new Array(12).fill(true), { startMs: NOON, gain: 1, from: 0 });
    const t = walkRows(w, { resetsAt: null, startHead: 100 });
    assert.strictEqual(t.totals.hours, 12);
  })) p++; else f++;

  if (test('the crossing is stamped on exactly one row, the first that reaches empty', () => {
    // 61% spent, +4 an hour: the walk is empty ten hours in, which is 22:00.
    const w = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 4, from: 61 });
    const t = walkRows(w, { resetsAt: new Date(NOON + 30 * H).toISOString(), startHead: 39 });
    const stamped = t.rows.filter(r => r.crossesAt !== null);
    assert.strictEqual(stamped.length, 1, 'never twice');
    assert.strictEqual(stamped[0].crossesAt, 'Wed 21:00');
    assert.ok(t.rows[t.rows.length - 1].endHead < 0, 'and the week ends past empty');
  })) p++; else f++;

  if (test('unpayable hours count from the crossing to the reset, and are 0 without one', () => {
    const over = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 4, from: 61 });
    const t = walkRows(over, { resetsAt: new Date(NOON + 30 * H).toISOString(), startHead: 39 });
    // The window empties inside the tenth hour (21:00), so that hour is partly
    // paid for and only the twenty whole hours after it are unpayable.
    assert.strictEqual(t.totals.unpayableHours, 20);

    assert.strictEqual(t.totals.crossed, true);

    const coasts = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 0.5, from: 61 });
    const c = walkRows(coasts, { resetsAt: new Date(NOON + 30 * H).toISOString(), startHead: 39 });
    assert.strictEqual(c.totals.unpayableHours, 0);
    assert.strictEqual(c.totals.crossed, false, 'a week that never empties never crossed');
    assert.ok(c.totals.endHead > 0);
  })) p++; else f++;

  if (test('a crossing in the final slice is still a crossing, with no whole hour after it', () => {
    // 20 points spent an hour for four hours, then 25 in the fifth: the window
    // goes empty inside the last slice of the walk. `unpayableHours` counts
    // *whole* hours past the crossing, so it is legitimately 0 here — which is
    // exactly why the totals caption reads `crossed` instead of that counter.
    const gains = [20, 20, 20, 20, 25];
    const walk: ForecastStep[] = gains.map((gain, i) => ({
      t: new Date(NOON + i * H).toISOString(),
      gain,
      cum: gains.slice(0, i + 1).reduce((n, g) => n + g, 0),
      weight: 0.8,
      learned: true
    }));
    const t = walkRows(walk, { resetsAt: new Date(NOON + 5 * H).toISOString(), startHead: 80 });
    assert.strictEqual(t.totals.endHead, -5, 'five points past empty');
    assert.strictEqual(t.totals.unpayableHours, 0, 'nothing whole follows the crossing hour');
    assert.strictEqual(t.totals.crossed, true, 'but the window did go empty');
    assert.strictEqual(t.rows[0].crossesAt, 'Wed 16:00', 'stamped on the day that ran out');
  })) p++; else f++;

  if (test('a row ends on the headroom of its last slice, which the next row starts from', () => {
    const w = walkOf(new Array(30).fill(true), { startMs: NOON, gain: 1, from: 61 });
    const t = walkRows(w, { resetsAt: new Date(NOON + 30 * H).toISOString(), startHead: 39 });
    assert.strictEqual(t.rows[0].endHead, 39 - 12);
    assert.strictEqual(t.rows[1].endHead, 39 - 30);
    assert.strictEqual(t.totals.endHead, t.rows[t.rows.length - 1].endHead);
  })) p++; else f++;

  if (test('weightSource names the three states and nothing in between', () => {
    assert.strictEqual(weightSource({ learned: 24, slices: 24 }, 0.31), 'measured weights');
    assert.strictEqual(weightSource({ learned: 0, slices: 24 }, 0.31), 'weekly mean 0.31');
    assert.strictEqual(weightSource({ learned: 5, slices: 24 }, 0.31), 'measured, then the mean');
    assert.strictEqual(weightSource({ learned: 0, slices: 0 }, 0.31), '—');
  })) p++; else f++;

  if (test('headBarPct drains from full to empty and never escapes 0…100', () => {
    assert.strictEqual(headBarPct(39, 39), 100);
    assert.strictEqual(headBarPct(0, 39), 0);
    assert.strictEqual(headBarPct(-80, 39), 0, 'a deficit is not a negative width');
    assert.strictEqual(headBarPct(60, 39), 100, 'nor is more than full an overflowing one');
    assert.strictEqual(headBarPct(10, 0), 0, 'a zero denominator does not divide');
  })) p++; else f++;

  if (test('a walk that crosses a DST boundary still folds to one row per day', () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'Europe/Berlin';
      // 2026-03-29 is 23 hours long in Berlin; the fold is by local date, so
      // the short day is still exactly one row.
      const start = Date.parse('2026-03-28T12:00:00Z');
      const w = walkOf(new Array(72).fill(true), { startMs: start, gain: 1, from: 0 });
      const t = walkRows(w, { resetsAt: new Date(start + 72 * H).toISOString(), startHead: 100 });
      assert.strictEqual(t.rows.length, 4);
      assert.strictEqual(t.totals.hours, 72, 'no hour is lost or double-counted');
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
