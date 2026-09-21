import assert from 'node:assert';

import {
  absentText, crossingX, dayTicks, DEBT_CAP, headroomOf, headroomScale, headSegments, hitRect,
  joinPoints, maxDebt, pctX, pctY, pointsAttr, segAreaPath, stepTitle, VIEW_H, walkWidth,
  yHead, zeroY
} from '../client/src/lib/walkChart.js';
import type { HeadSeg } from '../client/src/lib/walkChart.js';
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
  console.log('\n=== walkChart.ts (headroom chart geometry) ===\n');
  let p = 0, f = 0;

  // ── the segmenter ──

  /** `headSegments` over a scale derived from the same walk. */
  const segsOf = (w: ForecastStep[], startHead = 100 - (w[0]?.cum ?? 0) + (w[0]?.gain ?? 0)) =>
    headSegments(w, headroomScale(w, startHead));
  const kinds = (segs: HeadSeg[]) => segs.map(s => `${s.below ? 'd' : 'u'}${s.learned ? 'L' : '-'}`);

  if (test('headSegments: all-assumed and all-measured are each exactly one segment', () => {
    assert.deepStrictEqual(kinds(segsOf(walkOf([false, false, false, false]))), ['u-']);
    assert.deepStrictEqual(kinds(segsOf(walkOf([true, true, true]))), ['uL']);
    assert.strictEqual(segsOf(walkOf([false, false, false, false]))[0].points.length, 4);
  })) p++; else f++;

  if (test('headSegments: alternating flags split, each starting on the previous last point', () => {
    const segs = segsOf(walkOf([true, false, true, false, false]));
    assert.deepStrictEqual(kinds(segs), ['uL', 'u-', 'uL', 'u-']);
    for (let i = 1; i < segs.length; i++) {
      const prevLast = segs[i - 1].points[segs[i - 1].points.length - 1];
      // The shared boundary point is the whole reason the splitter exists: a
      // gap here is a one-hour hole in the line at every encoding change.
      assert.deepStrictEqual(segs[i].points[0], prevLast, 'boundary ' + i);
    }
  })) p++; else f++;

  if (test('headSegments: a single-step walk is one segment of one point, empty is none', () => {
    const segs = segsOf(walkOf([true]));
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].points.length, 1);
    assert.deepStrictEqual(headSegments([], headroomScale([], 40)), []);
  })) p++; else f++;

  if (test('headSegments: the crossing gets its own point, exactly on the zero rule', () => {
    // From 45, +10 an hour: the 5th point stands at 105, so the curve crosses
    // empty halfway along the segment before it — x = 4.5.
    const w = walkOf(new Array(7).fill(true), { gain: 10, from: 45 });
    const scale = headroomScale(w, 55);
    const segs = headSegments(w, scale);
    assert.deepStrictEqual(kinds(segs), ['uL', 'dL'], 'above the rule, then below it');
    const boundary = segs[0].points[segs[0].points.length - 1];
    assert.strictEqual(boundary.x, 4.5, 'the boundary sits where crossingX says');
    assert.ok(Math.abs(boundary.y - zeroY(scale)) < 1e-9, 'and exactly on the rule');
    assert.deepStrictEqual(segs[1].points[0], boundary, 'the debt run starts on it');
  })) p++; else f++;

  if (test('headSegments: the debt run splits at an evidence flip, so the fills can differ', () => {
    const w = walkOf([true, true, true, true, true, false, false], { gain: 20, from: 20 });
    // cum: 40 60 80 100 120 140 160 — empty is reached at point 3.
    const segs = segsOf(w, 80);
    assert.deepStrictEqual(kinds(segs), ['uL', 'dL', 'd-']);
  })) p++; else f++;

  if (test('headSegments: every walked hour is still drawn, in order', () => {
    const w = walkOf([true, true, false, true, false, false], { gain: 22, from: 10 });
    const xs = segsOf(w, 90).flatMap(s => s.points.map(pt => pt.x));
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], 'x went backwards');
    // Shared boundaries and the synthetic crossing duplicate, so dedupe first.
    const drawn = [...new Set(xs)].filter(x => Number.isInteger(x));
    assert.deepStrictEqual(drawn, w.map((_, i) => i));
  })) p++; else f++;

  if (test('joinPoints: concatenates the above-rule segments with no duplicated boundary', () => {
    const w = walkOf([true, false, true], { gain: 5, from: 0 });
    const pts = joinPoints(segsOf(w, 100));
    assert.deepStrictEqual(pts.map(pt => pt.x), [0, 1, 2]);
    assert.deepStrictEqual(joinPoints([]), []);
  })) p++; else f++;

  // ── the y scale ──

  if (test('headroomScale: with no crossing the domain stops at the rule', () => {
    const w = walkOf([true, true, true], { gain: 1, from: 0 });
    const s = headroomScale(w, 40);
    assert.strictEqual(s.lo, 0, 'no deficit, so nothing below the rule');
    assert.ok(s.hi > 40, 'and a little air above the start');
    assert.strictEqual(s.clamped, false);
  })) p++; else f++;

  if (test('headroomScale: the debt band is the deficit, floored so it stays visible', () => {
    // A 1-point overrun out of 40 points of headroom would be a hairline.
    const shallow = walkOf(new Array(41).fill(true), { gain: 1, from: 60 });
    const s = headroomScale(shallow, 40);
    assert.ok(-s.lo > 1, 'a shallow deficit is opened out to the floor');
    assert.ok(Math.abs(-s.lo - 40 * 0.12) < 1e-9);
  })) p++; else f++;

  if (test('headroomScale: a runaway deficit clamps at the cap and says so', () => {
    // 195 points short on 40 points of headroom — the live flat-profile week.
    const w = walkOf(new Array(60).fill(false), { gain: 4, from: 60 });
    const s = headroomScale(w, 40);
    assert.strictEqual(s.clamped, true, 'the reader is told the plot is cut');
    assert.ok(Math.abs(-s.lo - 40 * DEBT_CAP) < 1e-9, 'the band never exceeds the headroom');
    assert.ok(maxDebt(w) > -s.lo, 'and the real deficit is deeper than what is drawn');
  })) p++; else f++;

  if (test('yHead: the rule, the top and the floor land where they should', () => {
    const s = headroomScale(walkOf(new Array(40).fill(true), { gain: 3, from: 40 }), 60);
    assert.strictEqual(yHead(s.hi, s), 0, 'the top of the domain is the top of the box');
    assert.strictEqual(yHead(s.lo, s), VIEW_H, 'and the bottom is the bottom');
    assert.strictEqual(zeroY(s), yHead(0, s));
    assert.ok(zeroY(s) > 0 && zeroY(s) < VIEW_H, 'the rule is inside the box, not on an edge');
  })) p++; else f++;

  if (test('yHead: never NaN, never outside the box, however absurd the input', () => {
    const s = headroomScale(walkOf([true], { gain: 1, from: 0 }), 40);
    for (const v of [1e9, -1e9, Number.NaN, Number.POSITIVE_INFINITY, -294.7]) {
      const y = yHead(v, s);
      assert.ok(Number.isFinite(y), String(v) + ' produced ' + y);
      assert.ok(y >= 0 && y <= VIEW_H, String(v) + ' escaped the box: ' + y);
    }
  })) p++; else f++;

  if (test('yHead: non-increasing in headroom across the whole domain', () => {
    const s = headroomScale(walkOf(new Array(30).fill(true), { gain: 4, from: 50 }), 50);
    let prev = yHead(-200, s);
    for (let v = -200; v <= 200; v += 0.5) {
      const y = yHead(v, s);
      assert.ok(y <= prev + 1e-12, 'y rose at head=' + v);
      prev = y;
    }
  })) p++; else f++;

  if (test('yHead: a degenerate scale falls to the baseline rather than dividing by zero', () => {
    assert.strictEqual(yHead(5, { hi: 0, lo: 0, clamped: false }), VIEW_H);
  })) p++; else f++;

  if (test('headroomOf / maxDebt read the walk the way the curve draws it', () => {
    assert.strictEqual(headroomOf({ t: '', gain: 1, cum: 61, weight: 1, learned: true }), 39);
    assert.strictEqual(maxDebt(walkOf([true, true], { gain: 1, from: 0 })), 0);
    const over = walkOf(new Array(30).fill(true), { gain: 5, from: 0 });
    assert.strictEqual(Math.round(maxDebt(over)), 50);
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

  if (test('pointsAttr and segAreaPath: an empty walk produces no path, never "NaN"', () => {
    const w = walkOf([true, false], { gain: 5, from: 0 });
    const s = headroomScale(w, 100);
    assert.strictEqual(pointsAttr([]), '');
    assert.strictEqual(segAreaPath([], s), '');
    const d = segAreaPath(joinPoints(headSegments(w, s)), s);
    assert.ok(!d.includes('NaN'), d);
    assert.ok(d.startsWith('M') && d.endsWith('Z'), d);
    // The fill closes to the rule, not to the floor: it is the gap that is the
    // quantity, never the column of time under it.
    const zero = String(Math.round(zeroY(s) * 1000) / 1000);
    assert.ok(d.startsWith('M0,' + zero), d);
  })) p++; else f++;

  // ── the crossing ──

  if (test('crossingX: interpolates inside the hour that reaches 100', () => {
    // Steps end at 55, 65, …; the segment from point 4 (95) to point 5 (105)
    // crosses halfway, so the rule belongs at x = 4.5.
    const w = walkOf([false, false, false, false, false, false, false], { gain: 10, from: 45 });
    assert.strictEqual(crossingX(w), 4.5);
  })) p++; else f++;

  if (test('crossingX: null when the walk coasts to its reset with headroom left', () => {
    assert.strictEqual(crossingX(walkOf([true, true, true], { gain: 1, from: 0 })), null);
    assert.strictEqual(crossingX([]), null);
  })) p++; else f++;

  if (test('crossingX: a window already spent puts the crossing at the left edge', () => {
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
    assert.ok(text.includes('−2.1 pts this hour'), text);
    assert.ok(text.includes('29.6 pts left'), text);
    assert.ok(text.includes('weight 100% — assumed (no evidence)'), text);
    assert.ok(!text.includes('measured'), text);
  })) p++; else f++;

  if (test('stepTitle: a measured hour reports its weeks, from observedMin / 60', () => {
    const s: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 1.33, cum: 52.1, weight: 0.62, learned: true
    };
    assert.ok(stepTitle(s, cell({ observedMin: 300 })).includes('weight 62% — measured, 5 weeks'));
    assert.ok(stepTitle(s, cell({ observedMin: 60 })).includes('measured, 1 week'), 'singular');
  })) p++; else f++;

  if (test('stepTitle: an hour past empty counts what is owed, not what is left', () => {
    const s: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 2, cum: 148.2, weight: 1, learned: false
    };
    const text = stepTitle(s, undefined);
    assert.ok(text.includes('48.2 pts past empty'), text);
    assert.ok(!text.includes('left'), text);
  })) p++; else f++;

  if (test('stepTitle: the flip happens exactly at empty, not just past it', () => {
    const at100: ForecastStep = {
      t: '2026-08-30T09:00:00Z', gain: 1, cum: 100, weight: 1, learned: false
    };
    assert.ok(stepTitle(at100, undefined).includes('0.0 pts left'), 'zero is still "left"');
    assert.ok(stepTitle({ ...at100, cum: 100.4 }, undefined).includes('0.4 pts past empty'));
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
