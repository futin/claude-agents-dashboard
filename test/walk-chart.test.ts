import assert from 'node:assert';

import {
  absentText, areaPath, crossingX, dayTicks, hitRect, pctX, pctY, pointsAttr,
  splitRuns, stepTitle, VIEW_H, walkPoints, walkWidth, Y_MAX, yOf
} from '../client/src/lib/walkChart.js';
import type { ForecastStep, UsageProfileCell } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;

/** A walk of `learned` flags, one hour apart, accumulating `gain` per hour. */
function walkOf(flags: boolean[], opts: { startMs?: number; gain?: number; from?: number } = {}): ForecastStep[] {
  const start = opts.startMs ?? Date.parse('2026-08-30T00:00:00Z');
  const gain = opts.gain ?? 1;
  let cum = opts.from ?? 0;
  return flags.map((learned, i) => {
    cum += gain;
    return { t: new Date(start + i * H).toISOString(), gain, cum, weight: 1, learned };
  });
}

const cell = (over: Partial<UsageProfileCell> = {}): UsageProfileCell =>
  ({ hourOfWeek: 0, weight: null, observedMin: 0, staleWeeks: 0, ...over });

export function run(): number {
  console.log('\n=== walkChart.ts (forward-walk strip geometry) ===\n');
  let p = 0, f = 0;

  // ── the run splitter ──

  if (test('splitRuns: all-assumed and all-measured are each exactly one run', () => {
    assert.strictEqual(splitRuns(walkOf([false, false, false, false])).length, 1);
    assert.strictEqual(splitRuns(walkOf([true, true, true])).length, 1);
    const only = splitRuns(walkOf([false, false, false, false]))[0];
    assert.strictEqual(only.learned, false);
    assert.strictEqual(only.points.length, 4, 'one run keeps every point');
  })) p++; else f++;

  if (test('splitRuns: alternating flags give N runs, each starting on the previous run\'s last point', () => {
    const runs = splitRuns(walkOf([true, false, true, false, false]));
    assert.strictEqual(runs.length, 4);
    assert.deepStrictEqual(runs.map(r => r.learned), [true, false, true, false]);
    for (let i = 1; i < runs.length; i++) {
      const prevLast = runs[i - 1].points[runs[i - 1].points.length - 1];
      // The shared boundary point is the whole reason the splitter exists: a
      // gap here is a one-hour hole in the line at every encoding change.
      assert.deepStrictEqual(runs[i].points[0], prevLast, 'boundary ' + i);
    }
  })) p++; else f++;

  if (test('splitRuns: a single-step walk is one run of one point, and an empty walk is no runs', () => {
    const runs = splitRuns(walkOf([true]));
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].points.length, 1);
    assert.deepStrictEqual(splitRuns([]), []);
  })) p++; else f++;

  if (test('splitRuns: every point of the walk is still drawn, in order', () => {
    const w = walkOf([true, true, false, true, false, false]);
    const runs = splitRuns(w);
    const xs = runs.flatMap(r => r.points.map(pt => pt.x));
    // Shared boundaries duplicate, so dedupe before comparing to the walk.
    assert.deepStrictEqual([...new Set(xs)].sort((a, b) => a - b), walkPoints(w).map(pt => pt.x));
  })) p++; else f++;

  // ── the y scale ──

  if (test('yOf: exact at 0 and at 100', () => {
    assert.strictEqual(yOf(0), VIEW_H, '0% sits on the baseline');
    assert.strictEqual(yOf(100), VIEW_H - (100 / Y_MAX) * VIEW_H);
    assert.strictEqual(yOf(Y_MAX), 0, 'the top of the domain is the top of the box');
  })) p++; else f++;

  if (test('yOf: clamps far past the ceiling — never NaN, never a negative height', () => {
    // 294.7% is the live figure from the flat-profile week that motivated the
    // fixed domain; it must draw, not disappear or invert.
    for (const v of [294.7, 1e9, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const y = yOf(v);
      assert.ok(Number.isFinite(y), String(v) + ' produced ' + y);
      assert.ok(y >= 0 && y <= VIEW_H, String(v) + ' escaped the box: ' + y);
    }
    assert.strictEqual(yOf(294.7), 0);
    assert.strictEqual(yOf(-50), VIEW_H);
  })) p++; else f++;

  if (test('yOf: non-increasing across the whole domain', () => {
    let prev = yOf(-10);
    for (let cum = -10; cum <= 300; cum += 0.5) {
      const y = yOf(cum);
      assert.ok(y <= prev + 1e-12, 'y rose at cum=' + cum);
      prev = y;
    }
  })) p++; else f++;

  // ── the coordinate space ──

  if (test('walkWidth is never zero, so no division by it can blow up', () => {
    assert.strictEqual(walkWidth(0), 1);
    assert.strictEqual(walkWidth(1), 1);
    assert.strictEqual(walkWidth(2), 1);
    assert.strictEqual(walkWidth(118), 117);
  })) p++; else f++;

  if (test('hitRect: one column per hour, half-width at the edges, always inside the box', () => {
    const n = 5, w = walkWidth(n);
    const rects = Array.from({ length: n }, (_, i) => hitRect(i, n));
    assert.deepStrictEqual(rects[0], { x: 0, w: 0.5 }, 'the first column is clipped at the left edge');
    assert.deepStrictEqual(rects[n - 1], { x: w - 0.5, w: 0.5 });
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.x + r.w <= w, 'escaped the box: ' + JSON.stringify(r));
      assert.ok(r.w > 0, 'a zero-width column cannot be tapped');
    }
    // Adjacent columns must tile with no dead gap between them.
    for (let i = 1; i < n; i++) {
      assert.ok(Math.abs((rects[i - 1].x + rects[i - 1].w) - rects[i].x) < 1e-9, 'gap before ' + i);
    }
  })) p++; else f++;

  if (test('hitRect: a single-step walk still yields a tappable column', () => {
    const r = hitRect(0, 1);
    assert.ok(r.w > 0, JSON.stringify(r));
  })) p++; else f++;

  if (test('pctX / pctY stay inside 0…100', () => {
    assert.strictEqual(pctX(0, 5), 0);
    assert.strictEqual(pctX(4, 5), 100);
    assert.strictEqual(pctX(-3, 5), 0);
    assert.strictEqual(pctX(99, 5), 100);
    assert.strictEqual(pctY(VIEW_H), 100);
    assert.strictEqual(pctY(0), 0);
  })) p++; else f++;

  if (test('pointsAttr and areaPath: an empty walk produces no path, never "NaN"', () => {
    assert.strictEqual(pointsAttr([]), '');
    assert.strictEqual(areaPath([]), '');
    const d = areaPath(walkPoints(walkOf([true, false])));
    assert.ok(!d.includes('NaN'), d);
    assert.ok(d.startsWith('M') && d.endsWith('Z'), d);
  })) p++; else f++;

  // ── the crossing ──

  if (test('crossingX: interpolates inside the hour that reaches 100', () => {
    // Steps end at 55, 65, …; the segment from point 4 (95) to point 5 (105)
    // crosses halfway, so the rule belongs at x = 4.5.
    const w = walkOf([false, false, false, false, false, false, false], { gain: 10, from: 45 });
    assert.strictEqual(crossingX(w), 4.5);
  })) p++; else f++;

  if (test('crossingX: null when the walk coasts under the ceiling', () => {
    assert.strictEqual(crossingX(walkOf([true, true, true], { gain: 1, from: 0 })), null);
    assert.strictEqual(crossingX([]), null);
  })) p++; else f++;

  if (test('crossingX: a window already spent puts the rule at the left edge', () => {
    const w = walkOf([false, false], { gain: 1, from: 120 });
    assert.strictEqual(crossingX(w), 0);
  })) p++; else f++;

  if (test('crossingX: a zero-gain crossing hour does not divide by zero', () => {
    const w: ForecastStep[] = [
      { t: '2026-08-30T00:00:00Z', gain: 0, cum: 100, weight: 0, learned: true },
      { t: '2026-08-30T01:00:00Z', gain: 0, cum: 100, weight: 0, learned: true }
    ];
    const x = crossingX(w);
    assert.ok(x !== null && Number.isFinite(x), String(x));
  })) p++; else f++;

  // ── day ticks ──

  if (test('dayTicks: now at the left edge, then one tick per local calendar day', () => {
    // Built from local components so the count holds in any TZ.
    const start = new Date(2026, 7, 30, 12, 0, 0).getTime();   // local noon
    const w = walkOf(new Array(60).fill(false), { startMs: start });
    const ticks = dayTicks(w);
    assert.strictEqual(ticks[0].kind, 'now');
    assert.strictEqual(ticks[0].x, 0);
    const days = ticks.filter(t => t.kind === 'day');
    const distinct = new Set(w.map(s => new Date(s.t).toDateString()));
    // The first day is the one `now` is already in, so it gets no day tick.
    assert.strictEqual(days.length, distinct.size - 1);
    assert.strictEqual(new Set(ticks.map(t => t.x)).size, ticks.length, 'no duplicated tick');
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x > ticks[i - 1].x, 'ticks ascend');
  })) p++; else f++;

  if (test('dayTicks: an empty walk has no ticks at all', () => {
    assert.deepStrictEqual(dayTicks([]), []);
  })) p++; else f++;

  if (test('dayTicks: one tick per calendar day across a 23-hour and a 25-hour day', () => {
    // Keyed on the local date changing, not on the hour reading 00:00 — the
    // walk's slices are cut with one fixed UTC offset, so after a transition
    // the browser's local hour drifts and a midnight can be missed or doubled.
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'Europe/Berlin';
      // Spring forward: 2026-03-29 is 23 hours long in Berlin.
      const spring = dayTicks(walkOf(new Array(72).fill(false),
        { startMs: Date.parse('2026-03-28T00:00:00Z') }));
      assert.deepStrictEqual(spring.map(t => t.label), ['now', 'Sun', 'Mon', 'Tue']);
      // Fall back: 2026-10-25 is 25 hours long.
      const autumn = dayTicks(walkOf(new Array(72).fill(false),
        { startMs: Date.parse('2026-10-24T00:00:00Z') }));
      assert.deepStrictEqual(autumn.map(t => t.label), ['now', 'Sun', 'Mon', 'Tue']);
      for (const ticks of [spring, autumn]) {
        assert.strictEqual(new Set(ticks.map(t => t.x)).size, ticks.length, 'no duplicated tick');
      }
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  })) p++; else f++;

  // ── the tooltip ──

  if (test('stepTitle: an assumed hour says assumed, and never claims evidence', () => {
    const s: ForecastStep = {
      t: '2026-08-30T14:00:00Z', gain: 2.146, cum: 70.4, weight: 1, learned: false
    };
    const text = stepTitle(s, cell({ observedMin: 0 }));
    assert.ok(text.includes('+2.1% this hour'), text);
    assert.ok(text.includes('70% consumed'), text);
    assert.ok(text.includes('weight 100% — assumed (no evidence)'), text);
    assert.ok(!text.includes('measured'), text);
    assert.ok(!text.includes('past 100%'), text);
  })) p++; else f++;

  if (test('stepTitle: a measured hour reports its weeks, from observedMin / 60', () => {
    const s: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 1.33, cum: 52.1, weight: 0.62, learned: true
    };
    assert.ok(stepTitle(s, cell({ observedMin: 300 })).includes('weight 62% — measured, 5 weeks'));
    assert.ok(stepTitle(s, cell({ observedMin: 60 })).includes('measured, 1 week'), 'singular');
  })) p++; else f++;

  if (test('stepTitle: an hour past the ceiling says so', () => {
    const s: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 2, cum: 148.2, weight: 1, learned: false
    };
    const text = stepTitle(s, undefined);
    assert.ok(text.includes('past 100%'), text);
    assert.ok(text.includes('148% consumed'), text);
  })) p++; else f++;

  if (test('stepTitle: the ceiling line appears exactly at 100, not just above it', () => {
    const at100: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 1, cum: 100, weight: 1, learned: false
    };
    assert.ok(stepTitle(at100, undefined).includes('past 100%'));
    assert.ok(!stepTitle({ ...at100, cum: 99.4 }, undefined).includes('past 100%'));
  })) p++; else f++;

  if (test('stepTitle: a missing cell degrades to zero weeks instead of throwing', () => {
    const s: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 1, cum: 10, weight: 0.5, learned: true
    };
    assert.ok(stepTitle(s, undefined).includes('measured, 0 weeks'));
  })) p++; else f++;

  if (test('absentText: every reason gets its own sentence, and none is empty', () => {
    const seen = new Set<string>();
    for (const reason of ['recording-off', 'no-rate', 'no-window'] as const) {
      const text = absentText(reason);
      assert.ok(text.length > 20, reason + ' → ' + text);
      assert.ok(!seen.has(text), reason + ' repeats another reason');
      seen.add(text);
    }
    // The idle case is the one the old strip answered by vanishing.
    assert.ok(absentText('no-rate').includes('burn rate'));
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
