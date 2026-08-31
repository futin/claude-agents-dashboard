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
import { LEDGER_FILE, readLedgerSince } from '../server/lib/usage-ledger.js';
import { BASELINE_MS } from '../server/lib/usage-rate.js';
import { testAsync, withServer } from './api-harness.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const T0 = Date.parse('2026-08-30T09:00:00.000Z');
const R = '2026-08-30T13:00:00.000Z';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/**
 * Ten one-minute intervals of one model, on disk in both logs.
 *
 * 4_500_000 cache-read tokens weigh 450_000 (×0.1) and every interval gains
 * 0.5 utilization points, so the pooled fit is 4_500_000 weighted / 5 points =
 * **900_000 weighted per 1%**, and 45_000_000 raw / 5 = **9_000_000 raw**.
 * Ten intervals and 5 cumulative points is exactly the current floor.
 */
function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rates-'));
  const samples: string[] = [];
  const ledger: string[] = [];
  for (let i = 0; i <= 10; i++) {
    samples.push(JSON.stringify({ t: T0 + i * MIN, utilization: 10 + i * 0.5, resetsAt: R }));
    if (i > 0) {
      ledger.push(JSON.stringify({
        t: T0 + i * MIN,
        prevT: T0 + (i - 1) * MIN,
        tok: { 'opus-5': { in: 0, out: 0, cc: 0, cr: 4_500_000 } }
      }));
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

  check(test('recording off → an honest empty body, no error flag', () => {
    const body = shapeUsageRates({ recording: false, samples: [], ledger: [], nowMs: T0 });
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
      const nowMs = T0 + 11 * MIN;
      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        nowMs
      });
      assert.strictEqual(body.models.length, 1, JSON.stringify(body.models));
      const row = body.models[0];
      assert.strictEqual(row.model, 'opus-5');
      assert.strictEqual(row.weightedPerPct, 900_000);
      assert.strictEqual(row.rawPerPct, 9_000_000);
      assert.strictEqual(row.intervals, 10);
      assert.strictEqual(row.utilSum, 5);
      assert.strictEqual(row.verdict, 'thin', 'no baseline mass yet — collecting, not concluding');
      assert.strictEqual(row.baselineWeightedPerPct, null);
      assert.strictEqual(row.deviationPct, null);
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
      const nowMs = T0 + 13 * MIN;
      fs.appendFileSync(path.join(dir, '.usage-history.jsonl'),
        JSON.stringify({ t: T0 + 11 * MIN, utilization: 15.4, resetsAt: R }) + '\n', 'utf8');
      fs.appendFileSync(path.join(dir, LEDGER_FILE), JSON.stringify({
        t: T0 + 11 * MIN, prevT: T0 + 10 * MIN,
        tok: { 'fable-5': { in: 0, out: 0, cc: 0, cr: 1_000_000 } }
      }) + '\n', 'utf8');

      const body = shapeUsageRates({
        recording: true,
        samples: readRecentSamples(dir),
        ledger: readLedgerSince(nowMs - BASELINE_MS, dir),
        nowMs
      });
      assert.deepStrictEqual(body.models.map(m => m.model), ['opus-5', 'fable-5']);
      assert.strictEqual(body.models[1].weightedPerPct, null, 'one interval is under the floor');
      assert.strictEqual(body.models[1].intervals, 1, 'but the evidence it has is still counted');
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
