/**
 * The off-peak boost detector (`server/lib/usage-boost.ts`): the ET calendar
 * mapping, the weekday within-day verdict, and the weekend verdict on its
 * pooled weekday-peak control.
 *
 * Every fixture date is in September 2026, so every ET wall-clock time below is
 * EDT (UTC−4) and `at()` can state the offset rather than compute it. The
 * horizon ends at NOW, Monday 2026-09-28 00:00 ET, so the 14-day window holds
 * exactly ten weekdays (09-14…09-18, 09-21…09-25) and four weekend days
 * (09-19, 09-20, 09-26, 09-27).
 */

import assert from 'node:assert';

import { rawTokens, weightedTokens } from '../server/lib/usage-ledger.js';
import type { TokenCounts } from '../server/lib/usage-ledger.js';
import type { Interval } from '../server/lib/usage-rate.js';
import {
  BOOST_CELL_FLOORS, BOOST_MAX_INTERVAL_MS, BOOST_MIN_RATIO, BOOST_MIN_RUN_DAYS,
  PEAK_END_HOUR_ET, PEAK_START_HOUR_ET, WEEKEND_CONTROL_FLOORS, WEEKEND_MIN_RUN_DAYS,
  detectBoost, etStamp
} from '../server/lib/usage-boost.js';
import type { UsageBoost } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const M = 'claude-opus-5';
const NOW = Date.parse('2026-09-28T04:00:00Z');

const WEEKDAYS = [
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'
];
const WEEKENDS = ['2026-09-19', '2026-09-20', '2026-09-26', '2026-09-27'];

/** Base rates: weighted and raw tokens per 1%. Raw is the larger, so `tokFor` takes its cache-read shape. */
const W = 200_000;
const R = 1_000_000;

/**
 * Counts with exactly `weighted` weighted tokens and `raw` raw ones — the same
 * idiom as `test/usage-rate-drift.test.ts`, round-trip asserted so a fixture
 * whose arithmetic does not hold fails here rather than proving the wrong thing.
 */
function tokFor(weighted: number, raw: number): TokenCounts {
  let tok: TokenCounts;
  if (weighted >= raw) {
    const out = (weighted - raw) / 4;
    tok = { in: raw - out, out, cc: 0, cr: 0 };
  } else {
    const inp = (weighted - 0.1 * raw) / 0.9;
    tok = { in: inp, out: 0, cc: 0, cr: raw - inp };
  }
  assert.ok(tok.in >= 0 && tok.out >= 0 && tok.cr >= 0, `impossible fixture: w=${weighted} raw=${raw}`);
  assert.strictEqual(Math.round(weightedTokens(tok, M)), Math.round(weighted));
  assert.strictEqual(Math.round(rawTokens(tok)), Math.round(raw));
  return tok;
}

/** An EDT wall-clock time on a fixture date. */
function at(date: string, hour: number, minute: number): number {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return Date.parse(`${date}T${hh}:${mm}:00-04:00`);
}

/** One ten-minute interval whose midpoint is `mid`, at `wRate` / `rRate` tokens per point. */
function iv(mid: number, dUtil: number, wRate: number, rRate: number, model = M): Interval {
  return {
    fromT: mid - 5 * MIN, toT: mid + 5 * MIN, dUtil,
    tok: { [model]: tokFor(wRate * dUtil, rRate * dUtil) },
    req: {}, reqUsable: false, kind: { model }
  };
}

const PEAK_HOURS = [8, 9, 10, 11, 12, 13];
const OFF_HOURS = [6, 7, 14, 15, 16, 17, 18, 19];
const WEEKEND_HOURS = [10, 11, 12, 13, 14, 15, 16, 17];

/** Two intervals per hour at minutes 15 and 45, one point each. */
function hours(date: string, hs: number[], wRate: number, rRate: number, model = M): Interval[] {
  return hs.flatMap((h) => [15, 45].map((m) => iv(at(date, h, m), 1, wRate, rRate, model)));
}

/** A weekday: its peak cell at the base rate, its off-peak cell at `offW` / `offR`. */
function weekday(date: string, offW = W, offR = R): Interval[] {
  return [...hours(date, PEAK_HOURS, W, R), ...hours(date, OFF_HOURS, offW, offR)];
}

function weekendDay(date: string, wRate = W, rRate = R): Interval[] {
  return hours(date, WEEKEND_HOURS, wRate, rRate);
}

const near = (actual: number | null, expected: number, label: string): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= 0.02, `${label}: ${actual} not within 0.02 of ${expected}`);
};

/** Everything but the weekend object — what the weekend cases hold fixed. */
const weekdayPart = (b: UsageBoost): Omit<UsageBoost, 'weekend'> => {
  const { weekend: _weekend, ...rest } = b;
  return rest;
};

export function run(): number {
  console.log('\nusage-boost');
  let p = 0, f = 0;
  const check = (ok: boolean): void => { if (ok) p++; else f++; };

  // ── ET calendar mapping ────────────────────────────────────────────────────

  check(test('etStamp: 04:30Z on a March Saturday is 00:xx ET the same Saturday', () => {
    assert.deepStrictEqual(etStamp(Date.parse('2026-03-14T04:30:00Z')), { date: '2026-03-14', hour: 0, weekend: true });
  }));

  check(test('etStamp: 04:30Z in January is 23:xx the previous (Wednesday) ET date', () => {
    assert.deepStrictEqual(etStamp(Date.parse('2026-01-15T04:30:00Z')), { date: '2026-01-14', hour: 23, weekend: false });
  }));

  check(test('etStamp: the spring-forward instant is hour 3 and does not throw', () => {
    assert.strictEqual(etStamp(Date.parse('2026-03-08T07:00:00Z')).hour, 3);
  }));

  check(test('etStamp: both passes through the fall-back hour read hour 1, never 24', () => {
    for (const iso of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
      assert.deepStrictEqual(etStamp(Date.parse(iso)), { date: '2026-11-01', hour: 1, weekend: true }, iso);
    }
  }));

  check(test('etStamp: the peak window opens inclusively at 08:00 ET', () => {
    assert.strictEqual(etStamp(Date.parse('2026-09-09T12:00:00Z')).hour, 8);
    assert.strictEqual(PEAK_START_HOUR_ET, 8);
    assert.strictEqual(PEAK_END_HOUR_ET, 14);
  }));

  // ── Weekday verdict ────────────────────────────────────────────────────────

  const lastFive = WEEKDAYS.slice(-5);
  const flatFive = lastFive.flatMap((d) => weekday(d));

  check(test('null: five flat weekdays read none / flat at a ratio of 1.0', () => {
    const b = detectBoost(flatFive, NOW);
    assert.strictEqual(b.verdict, 'none');
    assert.strictEqual(b.reason, 'flat');
    near(b.ratio, 1, 'ratio');
    near(b.rawRatio, 1, 'rawRatio');
    assert.strictEqual(b.model, M);
    assert.deepStrictEqual(b.hours, []);
  }));

  check(test('a 2× off-peak step on four weekdays is a boost, with its observed hours', () => {
    const days = WEEKDAYS.slice(-4);
    const b = detectBoost(days.flatMap((d) => weekday(d, 2 * W, 2 * R)), NOW);
    assert.strictEqual(b.verdict, 'boost');
    assert.strictEqual(b.reason, null);
    near(b.ratio, 2, 'ratio');
    near(b.rawRatio, 2, 'rawRatio');
    assert.strictEqual(b.days, 4);
    assert.strictEqual(b.since, days[0]);
    const hs = b.hours.map((h) => h.hour);
    assert.ok(hs.includes(15), `an off-peak hour is reported: ${hs.join(',')}`);
    assert.ok(!hs.includes(9), 'a peak hour is not');
    assert.deepStrictEqual(hs, OFF_HOURS, 'exactly the boosted hours, ascending');
    assert.strictEqual(b.hours[0].utilSum, 8, 'two points an hour over four days');
  }));

  check(test('a weighted-only step is inconclusive / mix-shift', () => {
    const b = detectBoost(WEEKDAYS.slice(-4).flatMap((d) => weekday(d, 2 * W, 1.05 * R)), NOW);
    assert.strictEqual(b.verdict, 'inconclusive');
    assert.strictEqual(b.reason, 'mix-shift');
  }));

  check(test('the mirror — a raw-only step — is inconclusive / mix-shift too', () => {
    const b = detectBoost(WEEKDAYS.slice(-4).flatMap((d) => weekday(d, 1.05 * W, 2 * R)), NOW);
    assert.strictEqual(b.verdict, 'inconclusive');
    assert.strictEqual(b.reason, 'mix-shift');
  }));

  check(test('onset: two flat days then three at 2× is a three-day boost from the third-newest', () => {
    const b = detectBoost([
      ...lastFive.slice(0, 2).flatMap((d) => weekday(d)),
      ...lastFive.slice(2).flatMap((d) => weekday(d, 2 * W, 2 * R))
    ], NOW);
    assert.strictEqual(b.verdict, 'boost');
    assert.strictEqual(b.days, 3);
    assert.strictEqual(b.since, lastFive[2]);
    near(b.ratio, 2, 'the flat days are not in the ratio');
  }));

  check(test('a run of two is too short to claim — thin-evidence, alone or after flat days', () => {
    const alone = detectBoost(WEEKDAYS.slice(-2).flatMap((d) => weekday(d, 2 * W, 2 * R)), NOW);
    assert.strictEqual(alone.verdict, 'none');
    assert.strictEqual(alone.reason, 'thin-evidence');
    const afterFlat = detectBoost([
      ...lastFive.slice(0, 3).flatMap((d) => weekday(d)),
      ...lastFive.slice(3).flatMap((d) => weekday(d, 2 * W, 2 * R))
    ], NOW);
    assert.strictEqual(afterFlat.verdict, 'none');
    assert.strictEqual(afterFlat.reason, 'thin-evidence');
    assert.strictEqual(BOOST_MIN_RUN_DAYS, 3);
  }));

  check(test('a day whose peak cell misses the floor is unpaired, not counted', () => {
    const days = WEEKDAYS.slice(-4);
    const newest = days[3];
    const b = detectBoost([
      ...days.slice(0, 3).flatMap((d) => weekday(d, 2 * W, 2 * R)),
      iv(at(newest, 9, 15), 0.5, W, R),
      ...hours(newest, OFF_HOURS, 2 * W, 2 * R)
    ], NOW);
    assert.strictEqual(b.verdict, 'boost');
    assert.strictEqual(b.days, 3);
    assert.strictEqual(b.since, days[0]);
    assert.deepStrictEqual(BOOST_CELL_FLOORS, { minIntervals: 5, minUtil: 3 });
  }));

  check(test('an interval longer than an hour is dropped from every cell', () => {
    const long: Interval = {
      fromT: at(lastFive[4], 6, 0), toT: at(lastFive[4], 14, 0), dUtil: 10,
      tok: { [M]: tokFor(50 * W, 50 * R) }, req: {}, reqUsable: false, kind: { model: M }
    };
    assert.ok(long.toT - long.fromT > BOOST_MAX_INTERVAL_MS);
    assert.deepStrictEqual(detectBoost([...flatFive, long], NOW), detectBoost(flatFive, NOW));
  }));

  check(test('the dominant model is the sensor — a minor model\'s step does not fire', () => {
    const S = 'claude-sonnet-5';
    const minor = lastFive.flatMap((d) => [
      ...PEAK_HOURS.map((h) => iv(at(d, h, 30), 0.2, W, R, S)),
      ...OFF_HOURS.map((h) => iv(at(d, h, 30), 0.2, 2 * W, 2 * R, S))
    ]);
    const b = detectBoost([...flatFive, ...minor], NOW);
    assert.strictEqual(b.model, M);
    assert.strictEqual(b.verdict, 'none');
  }));

  // ── Weekend verdict ────────────────────────────────────────────────────────

  const flatWeek = WEEKDAYS.flatMap((d) => weekday(d));
  const weekdayAlone = weekdayPart(detectBoost(flatWeek, NOW));
  const olderWeekend = WEEKENDS.slice(0, 2).flatMap((d) => weekendDay(d));

  check(test('weekend 2×: the two newest weekend days against a ten-date control fire alone', () => {
    const b = detectBoost([
      ...flatWeek, ...olderWeekend, ...WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 2 * W, 2 * R))
    ], NOW);
    assert.strictEqual(b.weekend.verdict, 'boost');
    assert.strictEqual(b.weekend.reason, null);
    near(b.weekend.ratio, 2, 'weekend.ratio');
    near(b.weekend.rawRatio, 2, 'weekend.rawRatio');
    assert.strictEqual(b.weekend.days, 2);
    assert.strictEqual(b.weekend.since, '2026-09-26');
    assert.strictEqual(b.weekend.controlDays, 10);
    assert.strictEqual(b.verdict, 'none');
    assert.deepStrictEqual(weekdayPart(b), weekdayAlone, 'the weekday verdict is untouched');
  }));

  check(test('weekend flat: weekend days at the control\'s own rate read none / flat at 1.0', () => {
    const b = detectBoost([...flatWeek, ...WEEKENDS.flatMap((d) => weekendDay(d))], NOW);
    assert.strictEqual(b.weekend.verdict, 'none');
    assert.strictEqual(b.weekend.reason, 'flat');
    near(b.weekend.ratio, 1, 'weekend.ratio');
    assert.deepStrictEqual(weekdayPart(b), weekdayAlone);
  }));

  check(test('weekend run too short: only the newest weekend day at 2× is thin-evidence', () => {
    const b = detectBoost([
      ...flatWeek, ...olderWeekend, ...weekendDay('2026-09-26'), ...weekendDay('2026-09-27', 2 * W, 2 * R)
    ], NOW);
    assert.strictEqual(b.weekend.verdict, 'none');
    assert.strictEqual(b.weekend.reason, 'thin-evidence');
    assert.strictEqual(WEEKEND_MIN_RUN_DAYS, 2);
    assert.deepStrictEqual(weekdayPart(b), weekdayAlone);
  }));

  check(test('weekend weighted-only step is inconclusive / mix-shift', () => {
    const b = detectBoost([
      ...flatWeek, ...WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 2 * W, 1.05 * R))
    ], NOW);
    assert.strictEqual(b.weekend.verdict, 'inconclusive');
    assert.strictEqual(b.weekend.reason, 'mix-shift');
    assert.deepStrictEqual(weekdayPart(b), weekdayAlone);
  }));

  check(test('the weekend mirror — raw-only — is inconclusive / mix-shift too', () => {
    const b = detectBoost([
      ...flatWeek, ...WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 1.05 * W, 2 * R))
    ], NOW);
    assert.strictEqual(b.weekend.verdict, 'inconclusive');
    assert.strictEqual(b.weekend.reason, 'mix-shift');
    assert.deepStrictEqual(weekdayPart(b), weekdayAlone);
  }));

  check(test('a control from four weekday dates is too thin, however loud the weekend', () => {
    const fourDates = WEEKDAYS.slice(-4).flatMap((d) => weekday(d));
    const b = detectBoost([...fourDates, ...WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 2 * W, 2 * R))], NOW);
    assert.strictEqual(b.weekend.verdict, 'none');
    assert.strictEqual(b.weekend.reason, 'thin-evidence');
    assert.strictEqual(b.weekend.controlDays, 4);
    assert.strictEqual(WEEKEND_CONTROL_FLOORS.minDays, 5);
    // Only the day floor can be what refused: 4 × 12 peak intervals and points clear the other two.
    assert.ok(48 >= WEEKEND_CONTROL_FLOORS.minIntervals && 48 >= WEEKEND_CONTROL_FLOORS.minUtil);
    assert.deepStrictEqual(weekdayPart(b), weekdayPart(detectBoost(fourDates, NOW)));
  }));

  check(test('a peak cell under the cell floor is not a control day — dust cannot reach minDays', () => {
    // Three real dates clear the interval and point floors on their own (36 each), so only the day count can refuse; two more dates hold one 0.05-pt
    // peak interval each — present, but not a measurement. Counted as dates they would make five and fire the loud weekend.
    const real = WEEKDAYS.slice(-3).flatMap((d) => weekday(d));
    const dust = WEEKDAYS.slice(3, 5).map((d) => iv(at(d, 10, 15), 0.05, W, R));
    const loud = WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 2 * W, 2 * R));
    const b = detectBoost([...real, ...dust, ...loud], NOW);
    assert.strictEqual(b.weekend.verdict, 'none');
    assert.strictEqual(b.weekend.reason, 'thin-evidence');
    assert.strictEqual(b.weekend.ratio, null);
    assert.strictEqual(b.weekend.controlDays, 3);
  }));

  check(test('a weekend-only record has no control, so neither verdict publishes a ratio', () => {
    const b = detectBoost(WEEKENDS.flatMap((d) => weekendDay(d, 2 * W, 2 * R)), NOW);
    assert.strictEqual(b.verdict, 'none');
    assert.strictEqual(b.reason, 'thin-evidence');
    assert.strictEqual(b.weekend.verdict, 'none');
    assert.strictEqual(b.weekend.reason, 'thin-evidence');
    assert.strictEqual(b.weekend.ratio, null);
    assert.strictEqual(b.weekend.rawRatio, null);
    assert.strictEqual(b.weekend.controlDays, 0);
  }));

  check(test('both fire, each with its own since and day count', () => {
    const b = detectBoost([
      ...WEEKDAYS.slice(0, 7).flatMap((d) => weekday(d)),
      ...WEEKDAYS.slice(7).flatMap((d) => weekday(d, 2 * W, 2 * R)),
      ...olderWeekend,
      ...WEEKENDS.slice(2).flatMap((d) => weekendDay(d, 2 * W, 2 * R))
    ], NOW);
    assert.strictEqual(b.verdict, 'boost');
    assert.strictEqual(b.days, 3);
    assert.strictEqual(b.since, '2026-09-23');
    assert.strictEqual(b.weekend.verdict, 'boost');
    assert.strictEqual(b.weekend.days, 2);
    assert.strictEqual(b.weekend.since, '2026-09-26');
  }));

  check(test('the weekend control is the weekday peak — never the boosted off-peak', () => {
    const b = detectBoost([
      ...WEEKDAYS.flatMap((d) => weekday(d, 2 * W, 2 * R)),
      ...WEEKENDS.flatMap((d) => weekendDay(d, 2 * W, 2 * R))
    ], NOW);
    assert.strictEqual(b.verdict, 'boost', 'the weekday promo is live');
    assert.strictEqual(b.weekend.verdict, 'boost');
    near(b.weekend.ratio, 2, 'weekend.ratio against the peak');
    assert.ok(BOOST_MIN_RATIO === 1.5);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
