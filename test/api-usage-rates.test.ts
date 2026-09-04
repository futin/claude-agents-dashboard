/**
 * `GET /api/usage/rates` — the per-model token-value endpoint.
 *
 * Two layers, deliberately split. The arithmetic and the honesty rules are
 * checked against the **pure** `shapeUsageRates`, fed through the real file
 * readers from a tmpdir fixture, so a wrong number fails with the fixture in
 * front of you. The router-level check goes over a socket, and keeps recording
 * **off** so it can never read the developer's own `.usage-history.jsonl` and
 * pass or fail depending on whose machine ran it.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shapeUsageRates } from '../server/api.js';
import { readRecentSamples } from '../server/lib/usage-history.js';
import { LEDGER_FILE, ledgerStartMs, readLedgerSince } from '../server/lib/usage-ledger.js';
import { BASELINE_MS } from '../server/lib/usage-rate.js';
import { testAsync, withServer } from './api-harness.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-08-29T09:00:00.000Z');
/**
 * One reset window per fixture date.
 *
 * Both fixtures below span two UTC dates, because `CURRENT_FLOORS.minDays` is
 * 2 and a minute-scale fixture is one date however many intervals it holds.
 * They need a `resetsAt` each: `joinIntervals` drops any sample pair that
 * straddles two windows, so the pairs inside a date survive and the one pair
 * bridging the two dates is discarded — which is why the day-two block is one
 * interval shorter than the arithmetic alone would suggest.
 */
const RESETS = ['2026-08-29T13:00:00.000Z', '2026-08-30T13:00:00.000Z'];
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** The last sample `fixtureDir` writes — five minutes into its second date. */
const FIXTURE_END = T0 + DAY + 5 * MIN;

/**
 * Ten one-minute intervals of one model over two UTC dates, on disk in both logs.
 *
 * 4_500_000 cache-read tokens weigh 450_000 (×0.1) and every interval gains
 * 0.5 utilization points, so the pooled fit is 4_500_000 weighted / 5 points =
 * **900_000 weighted per 1%**, and 45_000_000 raw / 5 = **9_000_000 raw**.
 * Ten intervals, 5 cumulative points and 2 dates is exactly the current floor
 * on all three counts — five intervals a date, so the ratio is unchanged from
 * when this fixture was ten in a row.
 */
function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
  const samples: string[] = [];
  const ledger: string[] = [];
  let utilization = 10;
  for (let day = 0; day < 2; day++) {
    const base = T0 + day * DAY;
    samples.push(JSON.stringify({ t: base, utilization, resetsAt: RESETS[day] }));
    for (let i = 1; i <= 5; i++) {
      utilization += 0.5;
      samples.push(JSON.stringify({ t: base + i * MIN, utilization, resetsAt: RESETS[day] }));
      ledger.push(JSON.stringify({
        t: base + i * MIN,
        prevT: base + (i - 1) * MIN,
        tok: { 'opus-5': { in: 0, out: 0, cc: 0, cr: 4_500_000 } }
      }));
    }
  }
  fs.writeFileSync(path.join(dir, '.usage-history.jsonl'), samples.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, LEDGER_FILE), ledger.join('\n') + '\n', 'utf8');
  return dir;
}

/** The coefficients `countedFixtureDir` generates its utilization from. */
const TRUE_PCT_PER_MTOK = 0.1;
const TRUE_PCT_PER_REQUEST = 0.005;

/** Intervals per UTC date in `countedFixtureDir`, summing to its 25. */
const COUNTED_PER_DAY = [13, 12];
/** The last sample it writes. */
const COUNTED_END = T0 + DAY + COUNTED_PER_DAY[1] * MIN;

/**
 * 25 one-minute intervals with **request counts recorded**, over two UTC dates,
 * and utilization generated from the two coefficients above rather than from a
 * single ratio.
 *
 * Tokens walk 1.0 → 3.0 Mtok on a 5-cycle and requests 40 → 140 on an
 * 11-cycle, so the two regressors are separable; the cycles run continuously
 * across the date boundary, so splitting the fixture over two dates leaves the
 * design matrix — and therefore the recovered coefficients — untouched. 25
 * intervals, ~16 cumulative points and 2 dates clear `SPLIT_FLOORS`
 * (20 / 10 / 1) as well as the pooled `CURRENT_FLOORS` (10 / 5 / 2), so one
 * fixture exercises both sets of numbers on the same row.
 */
function countedFixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-counted-'));
  const samples: string[] = [];
  const ledger: string[] = [];
  let utilization = 10;
  let i = 0;
  for (let day = 0; day < COUNTED_PER_DAY.length; day++) {
    const base = T0 + day * DAY;
    samples.push(JSON.stringify({ t: base, utilization, resetsAt: RESETS[day] }));
    for (let j = 1; j <= COUNTED_PER_DAY[day]; j++) {
      const mtok = 1 + (i % 5) * 0.5;
      const reqs = 40 + ((i * 7) % 11) * 10;
      utilization += TRUE_PCT_PER_MTOK * mtok + TRUE_PCT_PER_REQUEST * reqs;
      samples.push(JSON.stringify({ t: base + j * MIN, utilization, resetsAt: RESETS[day] }));
      ledger.push(JSON.stringify({
        t: base + j * MIN,
        prevT: base + (j - 1) * MIN,
        // `in` tokens weigh exactly 1, so weighted tokens read off the fixture.
        tok: { 'opus-5': { in: mtok * 1_000_000, out: 0, cc: 0, cr: 0 } },
        req: { 'opus-5': reqs }
      }));
      i++;
    }
  }
  fs.writeFileSync(path.join(dir, '.usage-history.jsonl'), samples.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, LEDGER_FILE), ledger.join('\n') + '\n', 'utf8');
  return dir;
}

export async function run(): Promise<number> {
  console.log('\n=== usage rates endpoint ===\n');
  let p = 0, f = 0;
  const check = (r: boolean): void => { if (r) p++; else f++; };

  check(test('a ledger with counts fits the split, and both terms reach the body', () => {
    const dir = countedFixtureDir();
    try {
      const nowMs = COUNTED_END + MIN;
      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        ledgerStartMs: ledgerStartMs(dir),
        nowMs
      });
      assert.strictEqual(body.models.length, 1, JSON.stringify(body.models));
      const row = body.models[0];
      assert.strictEqual(row.splitVerdict, 'fitted');
      const tokErr = Math.abs(row.pctPerMWeighted! - TRUE_PCT_PER_MTOK) / TRUE_PCT_PER_MTOK;
      const reqErr = Math.abs(row.pctPerRequest! - TRUE_PCT_PER_REQUEST) / TRUE_PCT_PER_REQUEST;
      assert.ok(tokErr < 0.01, `token term off by ${(tokErr * 100).toFixed(2)}%: ${row.pctPerMWeighted}`);
      assert.ok(reqErr < 0.01, `request term off by ${(reqErr * 100).toFixed(2)}%: ${row.pctPerRequest}`);
      assert.ok(row.pctPerMWeighted! >= 0 && row.pctPerRequest! >= 0, 'no negative rate ever reaches the client');

      // The pooled ratio is untouched by the split, and on this fixture it is
      // exactly the number the split exists to correct: 50M weighted over
      // ~16.25 points is ~3.1M per point, against the token-only 10M.
      assert.strictEqual(row.intervals, 25);
      assert.strictEqual(row.days, 2, 'two dates, or the pooled rate is refused for span');
      // Non-null first: `null < 4_000_000` is true, so the bound below would
      // pass on an unfitted rate and assert nothing at all.
      assert.ok(row.weightedPerPct !== null, 'the pooled rate has to be fitted to be bounded');
      assert.ok(row.weightedPerPct < 4_000_000, `pooled was ${row.weightedPerPct}`);
      assert.strictEqual(row.verdict, 'thin', 'no baseline yet — the split does not change that');
      assert.strictEqual(row.baselineDays, 0, 'nothing in the baseline window at all');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(test('the coverage counters are present and zeroed on an empty body', () => {
    // The response type is the source of truth: `coverage` is never absent, so
    // the card needs no null check for a state that cannot happen. A zero here
    // is a measured zero — these are counters, not fits.
    const zeroed = {
      movedPct: 0, pricedPct: 0, mixedPct: 0, externalPct: 0,
      preLedgerPct: 0, missingPct: 0, partialPct: 0,
      recorderBreakHours: 0, startProvable: false
    };
    const off = shapeUsageRates({
      recording: false, samples: [], ledger: [], ledgerStartMs: null, nowMs: T0
    });
    assert.deepStrictEqual(off.coverage, zeroed, 'recording off');
    const missing = path.join(os.tmpdir(), 'rates-coverage-none-' + T0);
    const empty = shapeUsageRates({
      recording: true,
      samples: readRecentSamples(missing),
      ledger: readLedgerSince(0, missing),
      ledgerStartMs: ledgerStartMs(missing),
      nowMs: T0
    });
    assert.deepStrictEqual(empty.coverage, zeroed, 'recording on with nothing on disk');
  }));

  check(test('a fitted body\'s buckets sum to what moved, and priced matches its rows', () => {
    const dir = fixtureDir();
    try {
      const nowMs = T0 + 11 * MIN;
      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        ledgerStartMs: ledgerStartMs(dir),
        nowMs
      });
      const c = body.coverage;
      assert.strictEqual(
        c.pricedPct + c.mixedPct + c.externalPct + c.preLedgerPct + c.missingPct + c.partialPct,
        c.movedPct
      );
      // Ten intervals of 0.5 points, every one of them owned by `opus-5`.
      assert.strictEqual(c.movedPct, 5);
      assert.strictEqual(c.pricedPct, 5);
      assert.strictEqual(c.pricedPct, body.models[0].utilSum, 'priced is exactly the points behind the row');
      // `fixtureDir` writes its two dates as two blocks of abutting lines with
      // nothing between them, so the day boundary is itself a recorder break —
      // the one hole in the window, and the whole of the figure.
      assert.strictEqual(c.recorderBreakHours, (DAY - 5 * MIN) / 3_600_000,
        'the only hole is the fixture\'s own day boundary');
      assert.strictEqual(c.startProvable, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(test('coverage spans the baseline horizon, exactly like externalSharePct', () => {
    const dir = fixtureDir();
    try {
      // Five days on, so every interval is older than the 3-day current window
      // but well inside the 17-day baseline. Two disclosure figures on one card
      // must never quietly describe different windows.
      const nowMs = T0 + 11 * MIN + 5 * 86_400_000;
      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        ledgerStartMs: ledgerStartMs(dir),
        nowMs
      });
      assert.strictEqual(body.models[0].intervals, 0, 'nothing is in the current window');
      assert.strictEqual(body.coverage.movedPct, 5, 'but the disclosure still sees all of it');
      assert.strictEqual(body.coverage.pricedPct, 5);
      assert.strictEqual(body.externalSharePct, 0, 'the same horizon as the share beside it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(test('an unprovable start puts the pre-ledger points into missing, and says so', () => {
    const dir = fixtureDir();
    try {
      // Past both of the fixture's UTC dates, so a ledger starting `now` leaves
      // every one of its ten intervals before that start. Stopping inside the
      // first date would split the fixture and test the bucketing on half of it.
      const nowMs = T0 + DAY + 11 * MIN;
      const samples = readRecentSamples(dir);
      // No ledger at all: every interval is uncovered, so the only thing that
      // decides `pre-ledger` vs `gap` is whether the start could be proven.
      const provable = shapeUsageRates({
        recording: true, samples, ledger: [], ledgerStartMs: nowMs, nowMs
      });
      assert.strictEqual(provable.coverage.preLedgerPct, 5);
      assert.strictEqual(provable.coverage.missingPct, 0);
      assert.strictEqual(provable.coverage.startProvable, true);

      const unprovable = shapeUsageRates({
        recording: true, samples, ledger: [], ledgerStartMs: null, nowMs
      });
      assert.strictEqual(unprovable.coverage.preLedgerPct, 0, 'nothing may be claimed as pre-ledger');
      assert.strictEqual(unprovable.coverage.missingPct, 5, 'it is absorbed by the conservative bucket');
      assert.strictEqual(unprovable.coverage.startProvable, false);
      assert.strictEqual(unprovable.coverage.movedPct, 5, 'and the denominator is unchanged either way');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(test('recording off → an honest empty body, no error flag', () => {
    const body = shapeUsageRates({
      recording: false, samples: [], ledger: [], ledgerStartMs: null, nowMs: T0
    });
    assert.strictEqual(body.recording, false);
    assert.deepStrictEqual(body.models, []);
    assert.strictEqual(body.externalSharePct, null);
    assert.strictEqual(body.error, undefined);
    assert.strictEqual(new Date(body.generatedAt).toISOString(), body.generatedAt);
  }));

  check(test('recording on with no files yet → the same empty body, still no error', () => {
    const missing = path.join(os.tmpdir(), 'rates-does-not-exist-' + T0);
    const body = shapeUsageRates({
      recording: true,
      samples: readRecentSamples(missing),
      ledger: readLedgerSince(0, missing),
      ledgerStartMs: ledgerStartMs(missing),
      nowMs: T0
    });
    assert.strictEqual(body.recording, true, 'the recorder is on — say so');
    assert.deepStrictEqual(body.models, []);
    assert.strictEqual(body.externalSharePct, null);
    assert.strictEqual(body.error, undefined, 'a missing ledger is an absence, not a failure');
  }));

  check(test('a fixture above the floors fits one row, with the exact pooled rate', () => {
    const dir = fixtureDir();
    try {
      const nowMs = FIXTURE_END + MIN;
      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        ledgerStartMs: ledgerStartMs(dir),
        nowMs
      });
      assert.strictEqual(body.models.length, 1, JSON.stringify(body.models));
      const row = body.models[0];
      assert.strictEqual(row.model, 'opus-5');
      assert.strictEqual(row.weightedPerPct, 900_000);
      assert.strictEqual(row.rawPerPct, 9_000_000);
      assert.strictEqual(row.intervals, 10);
      assert.strictEqual(row.utilSum, 5);
      assert.strictEqual(row.days, 2);
      assert.strictEqual(row.verdict, 'thin', 'no baseline mass yet — collecting, not concluding');
      assert.strictEqual(row.baselineWeightedPerPct, null);
      assert.strictEqual(row.baselineDays, 0);
      assert.strictEqual(row.deviationPct, null);
      // The back-compat guard: this fixture's ledger lines predate request
      // counts, so every number above is the one the single ratio always gave,
      // and the split reports nothing rather than a zero.
      assert.strictEqual(row.splitVerdict, 'thin');
      assert.strictEqual(row.pctPerMWeighted, null);
      assert.strictEqual(row.pctPerRequest, null);
      assert.strictEqual(body.externalSharePct, 0, 'every point of movement is accounted for');
      assert.strictEqual(new Date(body.generatedAt).toISOString(), body.generatedAt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(test('rows are ordered by evidence, richest first', () => {
    const dir = fixtureDir();
    try {
      // A second model with one interval of its own, appended after the first.
      const nowMs = FIXTURE_END + 3 * MIN;
      fs.appendFileSync(path.join(dir, '.usage-history.jsonl'),
        JSON.stringify({ t: FIXTURE_END + MIN, utilization: 15.4, resetsAt: RESETS[1] }) + '\n', 'utf8');
      fs.appendFileSync(path.join(dir, LEDGER_FILE), JSON.stringify({
        t: FIXTURE_END + MIN, prevT: FIXTURE_END,
        tok: { 'fable-5': { in: 0, out: 0, cc: 0, cr: 1_000_000 } }
      }) + '\n', 'utf8');

      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        ledgerStartMs: ledgerStartMs(dir),
        nowMs
      });
      assert.deepStrictEqual(body.models.map(m => m.model), ['opus-5', 'fable-5']);
      assert.strictEqual(body.models[1].weightedPerPct, null, 'one interval is under the floor');
      assert.strictEqual(body.models[1].intervals, 1, 'but the evidence it has is still counted');
      assert.strictEqual(body.models[1].days, 1, 'and so is the single date behind it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

  check(await testAsync('GET /api/usage/rates is routed and answers JSON', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/usage/rates');
      assert.equal(reply.status, 200);
      // The harness only fills `json` when the body parsed as JSON, which is
      // the reachable proxy for the content type here.
      assert.ok(reply.json, 'the body must be JSON: ' + reply.raw.slice(0, 80));
      assert.equal(reply.json?.recording, false, 'recording is off in the harness env');
      assert.deepStrictEqual(reply.json?.models, []);
      assert.equal(reply.json?.externalSharePct, null);
      assert.equal(reply.json?.error, undefined);
    });
  }));

  check(await testAsync('a near-miss path is not the rates endpoint', async () => {
    await withServer(ENV, async h => {
      // Unmatched paths fall through to the SPA shell, so the tell is the body,
      // not the status: `/api/usage/ratesx` must never answer a rates payload.
      const reply = await h.req('/api/usage/ratesx');
      assert.equal(reply.json, null, 'the near miss must not answer JSON');
      assert.ok(reply.raw.startsWith('<!DOCTYPE html>'), 'it falls through to the static handler');
    });
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
