import assert from 'node:assert';

import {
  cellTitle,
  DAY_ORDER,
  DAYS,
  earliestWeightMs,
  forecastHeadline,
  forecastTiming,
  nextOccurrenceMs,
  profileGlossary,
  profileProgress,
  profileTip,
  nextWeekStartMs,
  fmtObserved,
  fmtUntil,
  forecastStats,
  TRUST_FLOOR_MIN
} from '../client/src/lib/usageProfile.js';
import type { ForecastStep, UsageProfileCell } from '../shared/types.js';

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

const step = (over: Partial<ForecastStep> = {}): ForecastStep =>
  ({ t: new Date(2026, 8, 7, 9, 0, 0).toISOString(), gain: 1, cum: 10, weight: 0.5,
    learned: true, ...over });

/** `n` steps — `forecastTiming` only reads the walk's length. */
const walkOf = (n: number): ForecastStep[] => Array.from({ length: n }, () => step());

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

  // ── DAY_ORDER: the columns are Monday-first over Sunday-indexed buckets ──

  if (test('DAY_ORDER renders Monday first and Sunday last', () => {
    assert.deepStrictEqual(DAY_ORDER.map(d => DAYS[d]),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  })) p++; else f++;

  if (test('DAY_ORDER is a permutation of all seven bucket indices', () => {
    // A column dropped or duplicated would silently hide or double an hour of
    // the week, and the grid gives no sign of it — every cell still renders.
    assert.deepStrictEqual([...DAY_ORDER].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  })) p++; else f++;

  if (test('a DAY_ORDER column still labels its own bucket', () => {
    // The permutation is display-only: cellTitle takes the DATA index, so the
    // 7th column must title itself Sunday, not Saturday.
    const cells = grid({});
    const last = DAY_ORDER[6];
    assert.ok(cellTitle(cells[last * 24 + 9], last, 9).startsWith('Sun 09:00'));
    assert.ok(cellTitle(cells[DAY_ORDER[0] * 24 + 9], DAY_ORDER[0], 9).startsWith('Mon 09:00'));
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

  if (test('forecastHeadline: one distinct verdict per confidence, none of them a sentence', () => {
    const all = (['none', 'thin', 'ok'] as const).map(forecastHeadline);
    assert.strictEqual(new Set(all).size, 3, 'two states share a verdict');
    for (const h of all) {
      assert.ok(h.length > 0, 'an empty verdict');
      assert.ok(!h.endsWith('.'), `"${h}" ends in a period`);
    }
    // `none` has to name what the forecast actually is when nothing is learned.
    assert.ok(forecastHeadline('none').includes('flat-rate'));
  })) p++; else f++;

  if (test('forecastTiming: a crossing time reads as the week hitting 100%', () => {
    // Built from local components, like the fmtWalkHour cases: the label is
    // local time, so a fixed UTC string would move with the runner's timezone.
    const thu = new Date(2026, 8, 10, 14, 0, 0);   // Thu 10 Sep 2026, 14:00 local
    assert.strictEqual(forecastTiming(walkOf(3), thu.toISOString()),
      'the week hits 100% Thu 14:00');
  })) p++; else f++;

  if (test('forecastTiming: no crossing on a real walk coasts to the reset', () => {
    assert.strictEqual(forecastTiming(walkOf(3), null), 'the week coasts to the reset');
  })) p++; else f++;

  if (test('forecastTiming: an empty walk has no timing sentence at all', () => {
    // Nothing to project from — `absentText` in the walk panel says why.
    assert.strictEqual(forecastTiming([], null), null);
  })) p++; else f++;

  if (test('forecastTiming: a crossing time with no walk is never printed', () => {
    // The combination should not reach the client, and inventing a crossing for
    // a walk that does not exist is the one wrong answer here.
    assert.strictEqual(forecastTiming([], new Date(2026, 8, 10, 14, 0, 0).toISOString()), null);
  })) p++; else f++;

  if (test('profileGlossary: the seven terms, in the order the tab reads them', () => {
    const g = profileGlossary(0.42);
    assert.deepStrictEqual(g.map(e => e.key),
      ['cell', 'weight', 'evidence', 'confidence', 'ink', 'ceiling', 'walk']);
    for (const e of g) {
      assert.ok(e.term.length > 0, `${e.key} has no term`);
      assert.ok(e.text.length >= 40, `${e.key}'s definition is too thin: "${e.text}"`);
    }
  })) p++; else f++;

  if (test('profileGlossary: the weekly mean is live, which is why it is a builder', () => {
    assert.ok(profileGlossary(0.42).find(e => e.key === 'ink')!.text.includes('42%'));
    assert.ok(profileGlossary(0.07).find(e => e.key === 'ink')!.text.includes('7%'));
  })) p++; else f++;

  if (test('profileGlossary: the model constant is read, never re-typed', () => {
    const g = profileGlossary(0.42);
    assert.ok(g.find(e => e.key === 'evidence')!.text.includes(String(TRUST_FLOOR_MIN)));
  })) p++; else f++;

  if (test('profileGlossary: the empty rule is defined without quoting a scale figure', () => {
    // The plot's floor is a *ratio* now — the debt band is capped at the height
    // of the headroom above it — so a number here would be a figure the chart
    // never draws. The old `ceiling` text named a fixed 130% and had to go with
    // the fixed domain.
    const text = profileGlossary(0.42).find(e => e.key === 'ceiling')!.text;
    assert.ok(text.includes('empty'), text);
    assert.ok(/measured/.test(text) && /guess/.test(text), 'both deficit inks are named');
    assert.ok(!/\d+%/.test(text), 'no invented scale figure: ' + text);
  })) p++; else f++;

  if (test('profileGlossary: every confidence state is documented, with the ok gate', () => {
    const text = profileGlossary(0.42).find(e => e.key === 'confidence')!.text;
    for (const state of ['none', 'thin', 'ok']) {
      assert.ok(text.includes(state), `confidence does not mention ${state}`);
    }
    assert.ok(text.includes('120'), 'the ok gate is not stated');
  })) p++; else f++;

  if (test('profileTip: an ⓘ prints the drawer\'s own string, not a second copy', () => {
    const g = profileGlossary(0.42);
    assert.strictEqual(profileTip('ink', 0.42), g.find(e => e.key === 'ink')!.text);
    assert.strictEqual(profileTip('cell', 0.42), g[0].text);
  })) p++; else f++;

  // ── the figure strip ──

  if (test('fmtUntil: two units at most, and never a negative distance', () => {
    const t0 = Date.parse('2026-09-09T12:00:00Z');
    assert.strictEqual(fmtUntil(t0, t0 + 52 * 3_600_000), '2d 4h');
    assert.strictEqual(fmtUntil(t0, t0 + 48 * 3_600_000), '2d', 'a whole day drops the hours');
    assert.strictEqual(fmtUntil(t0, t0 + 5 * 3_600_000 + 10 * 60_000), '5h 10m');
    assert.strictEqual(fmtUntil(t0, t0 + 7 * 60_000), '7m');
    assert.strictEqual(fmtUntil(t0, t0 - 3_600_000), 'now', 'the past is not a countdown');
    assert.strictEqual(fmtUntil(t0, Number.NaN), 'now');
  })) p++; else f++;

  if (test('forecastStats: the five figures, in the order the page reads them', () => {
    const now = new Date(2026, 8, 9, 12, 0, 0).getTime();
    const tiles = forecastStats({
      utilizationPct: 61,
      resetsAt: new Date(2026, 8, 14, 9, 0, 0).toISOString(),
      exhaustAt: new Date(2026, 8, 11, 16, 0, 0).toISOString(),
      dutyCycle: 0.34,
      hoursLeft: 117,
      activeHours: 40,
      hasWalk: true,
      progress: { touched: 83, totalMin: 860, atFloor: 7, trusted: 51 },
      confidence: 'ok',
      nowMs: now
    });
    assert.deepStrictEqual(tiles.map(t => t.key),
      ['window', 'crossing', 'duty', 'observed', 'confidence']);
    assert.strictEqual(tiles[0].value, '61%');
    assert.ok(tiles[0].sub.includes('resets Mon 09:00'), tiles[0].sub);
    assert.strictEqual(tiles[1].value, 'Fri 16:00');
    assert.ok(tiles[1].sub.includes('2d 4h from now'), tiles[1].sub);
    assert.strictEqual(tiles[2].value, '34%');
    assert.strictEqual(tiles[2].sub, '40 of 117 hours worked');
    assert.strictEqual(tiles[3].value, '83');
    assert.strictEqual(tiles[3].unit, ' / 168');
    assert.strictEqual(tiles[4].value, 'ok');
    assert.strictEqual(tiles[4].term, 'confidence', 'only this one carries an ⓘ');
  })) p++; else f++;

  if (test('forecastStats: a missing figure is a dash, never a fabricated zero', () => {
    const tiles = forecastStats({
      utilizationPct: null, resetsAt: null, exhaustAt: null, dutyCycle: null,
      hoursLeft: 0, activeHours: 0, hasWalk: false,
      progress: { touched: 0, totalMin: 0, atFloor: 0, trusted: 0 },
      confidence: 'none', nowMs: Date.now()
    });
    assert.strictEqual(tiles[0].value, '—');
    assert.strictEqual(tiles[0].sub, '', 'no reset to name');
    assert.strictEqual(tiles[2].value, '—');
    assert.strictEqual(tiles[2].sub, '');
    assert.strictEqual(tiles[3].value, '0', 'a counted zero is a real zero');
  })) p++; else f++;

  if (test('forecastStats: the crossing warns, and a coasting week says so instead', () => {
    const base = {
      utilizationPct: 20, resetsAt: null, dutyCycle: 0.2, hoursLeft: 10, activeHours: 2,
      hasWalk: true,
      progress: { touched: 1, totalMin: 60, atFloor: 1, trusted: 0 },
      confidence: 'ok' as const, nowMs: Date.now()
    };
    const coasting = forecastStats({ ...base, exhaustAt: null });
    assert.strictEqual(coasting[1].value, 'none');
    assert.strictEqual(coasting[1].warn, false);
    assert.ok(coasting[1].sub.includes('coasts'), coasting[1].sub);
    // Measured and forecast are marked separately: a quiet week must not wear
    // the projection's verdict.
    assert.strictEqual(coasting[0].warn, false, '20% is not an alarming window');
    const spent = forecastStats({ ...base, utilizationPct: 88, exhaustAt: null });
    assert.strictEqual(spent[0].warn, true, 'but 88% is');
  })) p++; else f++;

  if (test('forecastStats: with no walk at all the crossing is a dash, not a coasting week', () => {
    // The absent branch of `/api/usage/profile`: recording off (or no rate, or
    // no window) sends `walk: []` with `exhaustAt: null` — the same null a walk
    // that never crosses sends. Only the second one licenses "coasts".
    const base = {
      utilizationPct: 20, resetsAt: null, exhaustAt: null, dutyCycle: null,
      hoursLeft: 0, activeHours: 0,
      progress: { touched: 0, totalMin: 0, atFloor: 0, trusted: 0 },
      confidence: 'none' as const, nowMs: Date.now()
    };
    const none = forecastStats({ ...base, hasWalk: false });
    assert.strictEqual(none[1].value, '—', 'no projection is a dash, like every other missing figure');
    assert.strictEqual(none[1].warn, false);
    assert.ok(!none[1].sub.includes('coast'), none[1].sub);
    assert.strictEqual(none[1].sub, 'nothing to project from');
    // The same input with a walk behind it keeps today's wording exactly.
    const walked = forecastStats({ ...base, hasWalk: true });
    assert.strictEqual(walked[1].value, 'none');
    assert.strictEqual(walked[1].sub, 'the week coasts to its reset');
  })) p++; else f++;

  if (test('forecastStats: an unfinished profile warns on confidence, not on the counters', () => {
    const tiles = forecastStats({
      utilizationPct: 10, resetsAt: null, exhaustAt: null, dutyCycle: 0.1,
      hoursLeft: 10, activeHours: 1, hasWalk: true,
      progress: { touched: 12, totalMin: 300, atFloor: 3, trusted: 0 },
      confidence: 'thin', nowMs: Date.now()
    });
    assert.strictEqual(tiles[4].warn, true);
    assert.strictEqual(tiles[3].warn, undefined);
    assert.ok(tiles[4].sub.includes('0 carrying a weight'), tiles[4].sub);
    assert.ok(tiles[4].sub.includes('3 at the floor'), tiles[4].sub);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
