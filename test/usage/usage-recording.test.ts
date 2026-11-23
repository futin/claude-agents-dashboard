/**
 * `startUsageRecording` — the boot-time half of the usage recorder that `server/index.ts` calls once and nothing else exercises. Three rules live only in
 * it: rehydration seeds the **5h** pace ring alone (a weekly ring seeded from the 5h log poisons its slope), the active-time source goes null once
 * recording is turned off, and the sampling interval skips `refresh` while recording is off — all three read the setting per call, so a toggle needs no
 * restart.
 *
 * Every case runs against a tmpdir: `DASHBOARD_STATE_DIR` points the settings store there and the recorder takes the same dir. `setInterval` is swapped
 * for a recorder so the tick can be fired by hand rather than waited for.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetSettings, setSettings } from '../../server/lib/settings.js';
import { appendSample, recordTick, resetRecorder, startUsageRecording, stopUsageRecording } from '../../server/lib/usage-history.js';
import type { UsageSample } from '../../server/lib/usage-history.js';
import { flatProfile } from '../../server/lib/usage-forecast.js';
import { recordAndPace, resetPaceStore, setActiveTimeSource, setForecastProfile } from '../../server/lib/usage-pace.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const MIN = 60_000;
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const FIVE_RESET = new Date(NOW + 2 * 60 * MIN).toISOString();
const WEEK_RESET = new Date(NOW + 3 * 24 * 60 * MIN).toISOString();

/** One 5h-window sample, as the recorder writes it. */
const sample = (t: number, utilization: number): UsageSample => ({ t, utilization, resetsAt: FIVE_RESET });

type Tick = () => void;

/**
 * Run `fn` in a fresh state dir with recording set to `recording`, a recording `setInterval` in place, and every module-level store the recorder and
 * the pace module hold put back afterwards. `fn` gets the dir and the ticks `startUsageRecording` scheduled.
 */
function withRecorder(recording: boolean, fn: (dir: string, ticks: Tick[]) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-recording-'));
  const prevStateDir = process.env.DASHBOARD_STATE_DIR;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const ticks: Tick[] = [];
  try {
    process.env.DASHBOARD_STATE_DIR = dir;
    resetSettings();
    assert.ok(setSettings({ recordUsageHistory: recording }), 'the settings patch must apply');
    resetRecorder();
    resetPaceStore();
    globalThis.setInterval = ((cb: Tick) => { ticks.push(cb); return { unref() { /* never holds the process */ } }; }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => { /* the fake handle holds nothing */ }) as typeof clearInterval;
    fn(dir, ticks);
  } finally {
    stopUsageRecording();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (prevStateDir === undefined) delete process.env.DASHBOARD_STATE_DIR; else process.env.DASHBOARD_STATE_DIR = prevStateDir;
    resetSettings();
    resetRecorder();
    resetPaceStore();
    setActiveTimeSource(null);
    setForecastProfile(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The recorded log a restart rehydrates from: 10% at -40 min, 15% at -20 min. Wide enough for both windows to compute a pace from it — the 5h window
 * needs 5 min of span, the weekly one 30 — so a weekly ring seeded from it would show, rather than read as "too thin".
 */
function plantLog(dir: string): void {
  appendSample(sample(NOW - 40 * MIN, 10), dir);
  appendSample(sample(NOW - 20 * MIN, 15), dir);
}

export function run(): number {
  console.log('\n=== startUsageRecording ===\n');
  let p = 0, f = 0;

  if (test('recording on: the saved log seeds the 5h pace ring, so the first live sample already carries a rate', () => {
    withRecorder(true, dir => {
      plantLog(dir);
      startUsageRecording(() => {}, dir);
      const five = recordAndPace('fiveHour', { utilization: 20, resetsAt: FIVE_RESET }, NOW);
      assert.notEqual(five.ratePerHour, null, 'the seeded -20 min sample gives the 5h window its span');
      assert.ok(Math.abs((five.ratePerHour as number) - 15) < 1e-9, `5% over 20 min is 15%/h, got ${five.ratePerHour}`);
    });
  })) p++; else f++;

  if (test('recording on: the weekly ring is NOT seeded from the 5h log — its first live sample has no rate yet', () => {
    withRecorder(true, dir => {
      plantLog(dir);
      startUsageRecording(() => {}, dir);
      const week = recordAndPace('sevenDay', { utilization: 20, resetsAt: WEEK_RESET }, NOW);
      assert.equal(week.ratePerHour, null, 'a weekly ring seeded from the 5h series would report a slope here');
    });
  })) p++; else f++;

  if (test('recording off: nothing is rehydrated — the 5h ring starts empty', () => {
    withRecorder(false, dir => {
      plantLog(dir);
      startUsageRecording(() => {}, dir);
      const five = recordAndPace('fiveHour', { utilization: 20, resetsAt: FIVE_RESET }, NOW);
      assert.equal(five.ratePerHour, null);
    });
  })) p++; else f++;

  if (test('the active-time source answers while recording is on and goes null once it is turned off, with no restart', () => {
    withRecorder(true, dir => {
      startUsageRecording(() => {}, dir);
      // A ring of idle minutes covering the last 40: measured active time over the lookback is 0.
      for (let t = NOW - 40 * MIN; t <= NOW; t += MIN) recordTick(sample(t, 10), dir);
      // A trusted profile is what lets the weekly window spend the active-time correction at all.
      const weekly = (): number | null | undefined => {
        resetPaceStore();
        setForecastProfile(flatProfile(1));
        recordAndPace('sevenDay', { utilization: 10, resetsAt: WEEK_RESET }, NOW - 35 * MIN);
        return recordAndPace('sevenDay', { utilization: 12, resetsAt: WEEK_RESET }, NOW).ratePerHour;
      };
      // On: the source reports 0 active ms for a 2% rise — a recording gap, so no rate is invented.
      assert.equal(weekly(), null, 'with recording on the measured (zero) active time must reach the weekly rate');
      assert.ok(setSettings({ recordUsageHistory: false }));
      // Off: the source answers null, so the raw wall slope stands — 2% over 35 min.
      const off = weekly();
      assert.notEqual(off, null, 'with recording off the source must answer null and leave the wall slope');
      assert.ok(Math.abs((off as number) - 2 / (35 / 60)) < 1e-9, `expected the wall slope, got ${off}`);
    });
  })) p++; else f++;

  if (test('the sampling tick calls refresh only while recording is on, and follows the toggle both ways', () => {
    for (const startOn of [true, false]) {
      withRecorder(startOn, (dir, ticks) => {
        let refreshes = 0;
        startUsageRecording(() => { refreshes++; }, dir);
        assert.equal(ticks.length, 1, 'one sampling interval, whatever the setting at boot — the toggle must work without a restart');
        ticks[0]();
        assert.equal(refreshes, startOn ? 1 : 0, `booted ${startOn ? 'on' : 'off'}: the first tick`);
        assert.ok(setSettings({ recordUsageHistory: !startOn }));
        ticks[0]();
        assert.equal(refreshes, 1, `after turning recording ${startOn ? 'off' : 'on'}: the second tick`);
      });
    }
  })) p++; else f++;

  console.log(`\n  startUsageRecording: ${p} passed, ${f} failed`);
  return f;
}
