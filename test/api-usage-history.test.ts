/**
 * `GET /api/usage/history` — `serveUsageHistory` driven with a fake response, a fixture log directory and a fixed clock.
 *
 * Every case runs from a tmpdir cwd with settings reset, because `settings.ts` resolves its file from cwd and caches it — the developer's own
 * `.dashboard-settings.json` must never decide whether a case passes.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

import { serveUsageHistory } from '../server/api.js';
import { HISTORY_FILE } from '../server/lib/usage-history.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';
import type { UsageHistoryResponse } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

interface Reply { status: number; raw: string; body: UsageHistoryResponse }

function call(query: string, dir: string): Reply {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk: string) { raw = chunk; }
  } as unknown as ServerResponse;
  serveUsageHistory(res, new URLSearchParams(query), dir, NOW);
  return { status, raw, body: JSON.parse(raw) as UsageHistoryResponse };
}

/** A log of one 5-hour window with a weekly reading, an hour of one-minute samples ending at NOW. */
function writeLog(dir: string): void {
  const lines: string[] = [];
  for (let i = 0; i <= 60; i++) {
    lines.push(JSON.stringify({
      t: NOW - (60 - i) * 60_000,
      utilization: i / 2,
      resetsAt: '2026-10-01T15:00:00.000Z',
      week: { utilization: 20, resetsAt: '2026-10-04T06:00:00.000Z' }
    }));
  }
  fs.writeFileSync(path.join(dir, HISTORY_FILE), lines.join('\n') + '\n', 'utf8');
}

export function run(): number {
  console.log('\napi-usage-history');
  let p = 0, f = 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-usage-history-'));
  const prevCwd = process.cwd();
  process.chdir(tmp);
  resetSettings();
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  const logged = fs.mkdtempSync(path.join(tmp, 'logged-'));
  writeLog(logged);

  try {
    if (test('days: digits only, clamped to [1, 365], anything else is 7', () => {
      const cases: Array<[string, number]> = [['', 7], ['days=30', 30], ['days=0', 1], ['days=999', 365], ['days=abc', 7], ['days=2.5', 7], ['days=-3', 7]];
      for (const [query, days] of cases) assert.strictEqual(call(query, empty).body.days, days, query || '(absent)');
    })) p++; else f++;

    if (test('with a log: 200, sinceT is nowT less the range, and no path or file name leaks', () => {
      const reply = call('days=30', logged);
      assert.strictEqual(reply.status, 200);
      assert.strictEqual(reply.body.nowT, NOW);
      assert.strictEqual(reply.body.sinceT, reply.body.nowT - 30 * DAY);
      assert.strictEqual(reply.body.fiveHour.length, 1);
      assert.strictEqual(reply.body.weekly.length, 1);
      assert.ok(!reply.raw.includes(logged), 'the fixture directory must not appear in the body');
      assert.ok(!reply.raw.includes('.usage-history'), 'the log file name must not appear in the body');
    })) p++; else f++;

    if (test('no log file: 200, empty series, one gap over the range, no error key', () => {
      const reply = call('', empty);
      assert.strictEqual(reply.status, 200);
      assert.deepStrictEqual(reply.body.fiveHour, []);
      assert.deepStrictEqual(reply.body.weekly, []);
      assert.deepStrictEqual(reply.body.gaps, [{ fromT: reply.body.sinceT, toT: reply.body.nowT }]);
      assert.ok(!('error' in reply.body));
    })) p++; else f++;

    if (test('recording switched off: the history is still served, recording false', () => {
      setSettings({ recordUsageHistory: false });
      const reply = call('days=1', logged);
      assert.strictEqual(reply.body.recording, false);
      assert.strictEqual(reply.body.fiveHour.length, 1);
      assert.strictEqual(reply.body.weekly.length, 1);
    })) p++; else f++;
  } finally {
    process.chdir(prevCwd);
    resetSettings();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
