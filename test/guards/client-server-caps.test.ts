/**
 * Every client copy of a server cap or a server-model threshold, pinned to the server value it mirrors. The client keeps its own copy on purpose — only the
 * typed JSON in `shared/types.ts` crosses the FE/BE boundary, and one integer is not worth a runtime import — so this suite is what makes a server cap that
 * moves turn something red, instead of a slider offering rows the server clamps or a composer accepting text the server slices. `NAME_CAP`, `PROMPT_CAP` and
 * the spawn option lists are pinned in `test/spawn/spawn-options.test.ts` and are not repeated here.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANSWER_SECS_MAX, ANSWER_SECS_MIN, IDLE_SECS_MAX } from '../../client/src/lib/settingsBounds.js';
import { SYNC_SCAN_LIMIT } from '../../client/src/lib/gitSync.js';
import { GIT_BRANCH_CAP } from '../../client/src/lib/gitStatsText.js';
import { LIMITS } from '../../client/src/lib/settings.js';
import {
  CHAT_MAX_WINDOW_MB, CHAT_MESSAGES_HINT, CHAT_TEXT_CAP, CHAT_TOOL_BODY_CAP, CHAT_WINDOW_KB, MESSAGE_TEXT_CAP, PLAN_FEEDBACK_CAP, QUESTION_OTHER_CAP
} from '../../client/src/lib/textCaps.js';
import { QUICK_TIMEOUT_SECS } from '../../client/src/lib/gitQuick.js';
import { OLDER_PROJECTS_DAYS } from '../../client/src/lib/projectsView.js';
import { HOURS_PER_WEEK, TRUSTED_OK, TRUST_FLOOR_MIN } from '../../client/src/lib/usageProfile.js';
import {
  BASELINE_DAYS, BASELINE_DAY_FLOOR, BOOST_DAYS, BOOST_MIN_RATIO, BOOST_MIN_RUN_DAYS, CURRENT_DAYS, CURRENT_DAY_FLOOR, CURRENT_MIN_WINDOWS,
  DAY_FLOOR_PTS, DOMINANCE_PCT, DRIFT_BAND_PCT, PEAK_END_HOUR_ET, PEAK_START_HOUR_ET, WEEKEND_MIN_RUN_DAYS
} from '../../client/src/lib/usageRatesFormat.js';
import { SCAN_CAPS } from '../../server/api.js';
import { MAX_BRANCHES } from '../../server/lib/git-stats.js';
import { TEXT_CAP } from '../../server/lib/messages.js';
import { SELECTED_CAP } from '../../server/lib/pending.js';
import { MAX_ANSWER_SECS, MAX_IDLE_SECS, MIN_ANSWER_SECS } from '../../server/lib/settings.js';
import { FEEDBACK_CAP } from '../../server/lib/plans.js';
import {
  HOURS_PER_WEEK as SERVER_HOURS_PER_WEEK, TRUSTED_OK as SERVER_TRUSTED_OK
} from '../../server/lib/usage-forecast.js';
import { TRUST_FLOOR_MIN as SERVER_TRUST_FLOOR_MIN } from '../../server/lib/usage-history.js';
import { BASELINE_FLOORS, BASELINE_MS, CURRENT_FLOORS, CURRENT_MS, DOMINANCE, DRIFT_PCT } from '../../server/lib/usage-rate.js';
import {
  BOOST_MIN_RATIO as SERVER_BOOST_MIN_RATIO, BOOST_MIN_RUN_DAYS as SERVER_BOOST_MIN_RUN_DAYS, BOOST_MS,
  PEAK_END_HOUR_ET as SERVER_PEAK_END_HOUR_ET, PEAK_START_HOUR_ET as SERVER_PEAK_START_HOUR_ET,
  WEEKEND_MIN_RUN_DAYS as SERVER_WEEKEND_MIN_RUN_DAYS
} from '../../server/lib/usage-boost.js';
import { CHAT_MAX_WINDOW_BYTES, CHAT_WINDOW_BYTES, TEXT_CAP as CHAT_SERVER_TEXT_CAP, TOOL_BODY_CAP } from '../../server/lib/chat.js';
import { QUICK_TIMEOUT_MS } from '../../server/lib/git-quick.js';
import { OLDER_PROJECTS_DAYS as SERVER_OLDER_PROJECTS_DAYS } from '../../server/lib/management.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY_MS = 86_400_000;

/** A `maxLength` given as a bare number: the shape that let a composer's cap drift from the server's unnoticed. */
const BARE_MAX_LENGTH = /maxLength=\{\s*\d/g;

/** Line numbers (1-based) of every bare-number `maxLength` in a source text. */
export function bareMaxLengthLines(src: string): number[] {
  return [...src.matchAll(BARE_MAX_LENGTH)].map(m => src.slice(0, m.index).split('\n').length);
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.isFile() && e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

export function run(): number {
  console.log('\n=== client copies of server caps and thresholds ===\n');
  let p = 0, f = 0;
  const r = (ok: boolean) => { if (ok) p++; else f++; };

  /** One pair: `client` must equal `server`, and a red run names both constants and both files. */
  const pin = (client: [string, string, number], server: [string, string, number]): void => {
    const [cName, cFile, cVal] = client;
    const [sName, sFile, sVal] = server;
    r(test(`${cName} (${cFile}) === ${sName} (${sFile})`, () => {
      assert.strictEqual(cVal, sVal, `${cName} in ${cFile} is ${cVal}, but ${sName} in ${sFile} is ${sVal}`);
    }));
  };

  const SETTINGS = 'client/src/lib/settings.ts';
  const API = 'server/api.ts';
  const RATES = 'client/src/lib/usageRatesFormat.ts';
  const RATE = 'server/lib/usage-rate.ts';
  const PROFILE = 'client/src/lib/usageProfile.ts';
  const FORECAST = 'server/lib/usage-forecast.ts';

  pin(['LIMITS.maxSessions.max', SETTINGS, LIMITS.maxSessions.max], ['SCAN_CAPS.limit', API, SCAN_CAPS.limit]);
  pin(['LIMITS.lookbackHours.max', SETTINGS, LIMITS.lookbackHours.max], ['SCAN_CAPS.lookback', API, SCAN_CAPS.lookback]);
  pin(['LIMITS.activeWindowMin.max', SETTINGS, LIMITS.activeWindowMin.max], ['SCAN_CAPS.active', API, SCAN_CAPS.active]);
  pin(['SYNC_SCAN_LIMIT', 'client/src/lib/gitSync.ts', SYNC_SCAN_LIMIT], ['SCAN_CAPS.limit', API, SCAN_CAPS.limit]);
  pin(['MESSAGE_TEXT_CAP', 'client/src/lib/textCaps.ts', MESSAGE_TEXT_CAP], ['TEXT_CAP', 'server/lib/messages.ts', TEXT_CAP]);
  pin(['PLAN_FEEDBACK_CAP', 'client/src/lib/textCaps.ts', PLAN_FEEDBACK_CAP], ['FEEDBACK_CAP', 'server/lib/plans.ts', FEEDBACK_CAP]);
  pin(['QUESTION_OTHER_CAP', 'client/src/lib/textCaps.ts', QUESTION_OTHER_CAP], ['SELECTED_CAP', 'server/lib/pending.ts', SELECTED_CAP]);
  pin(['TRUST_FLOOR_MIN', PROFILE, TRUST_FLOOR_MIN], ['TRUST_FLOOR_MIN', 'server/lib/usage-history.ts', SERVER_TRUST_FLOOR_MIN]);
  pin(['TRUSTED_OK', PROFILE, TRUSTED_OK], ['TRUSTED_OK', FORECAST, SERVER_TRUSTED_OK]);
  pin(['HOURS_PER_WEEK', PROFILE, HOURS_PER_WEEK], ['HOURS_PER_WEEK', FORECAST, SERVER_HOURS_PER_WEEK]);
  pin(['DRIFT_BAND_PCT', RATES, DRIFT_BAND_PCT], ['DRIFT_PCT', RATE, DRIFT_PCT]);
  pin(['DAY_FLOOR_PTS', RATES, DAY_FLOOR_PTS], ['CURRENT_FLOORS.minUtil', RATE, CURRENT_FLOORS.minUtil]);
  pin(['BASELINE_DAY_FLOOR', RATES, BASELINE_DAY_FLOOR], ['BASELINE_FLOORS.minDays', RATE, BASELINE_FLOORS.minDays]);
  pin(['CURRENT_DAY_FLOOR', RATES, CURRENT_DAY_FLOOR], ['CURRENT_FLOORS.minDays', RATE, CURRENT_FLOORS.minDays]);
  pin(['CURRENT_DAYS', RATES, CURRENT_DAYS], ['CURRENT_MS / 86_400_000', RATE, CURRENT_MS / DAY_MS]);
  pin(['GIT_BRANCH_CAP', 'client/src/lib/gitStatsText.ts', GIT_BRANCH_CAP], ['MAX_BRANCHES', 'server/lib/git-stats.ts', MAX_BRANCHES]);

  // #509: the numbers user-facing copy states — each one interpolated from a named constant, so the copy follows the server through these pins.
  const TEXT_CAPS = 'client/src/lib/textCaps.ts';
  const CHAT = 'server/lib/chat.ts';
  const BOOST = 'server/lib/usage-boost.ts';
  pin(['CHAT_TEXT_CAP', TEXT_CAPS, CHAT_TEXT_CAP], ['TEXT_CAP', CHAT, CHAT_SERVER_TEXT_CAP]);
  pin(['CHAT_TOOL_BODY_CAP', TEXT_CAPS, CHAT_TOOL_BODY_CAP], ['TOOL_BODY_CAP', CHAT, TOOL_BODY_CAP]);
  pin(['CHAT_WINDOW_KB', TEXT_CAPS, CHAT_WINDOW_KB], ['CHAT_WINDOW_BYTES / 1024', CHAT, CHAT_WINDOW_BYTES / 1024]);
  pin(['CHAT_MAX_WINDOW_MB', TEXT_CAPS, CHAT_MAX_WINDOW_MB], ['CHAT_MAX_WINDOW_BYTES / 1024²', CHAT, CHAT_MAX_WINDOW_BYTES / (1024 * 1024)]);
  pin(['QUICK_TIMEOUT_SECS', 'client/src/lib/gitQuick.ts', QUICK_TIMEOUT_SECS], ['QUICK_TIMEOUT_MS / 1000', 'server/lib/git-quick.ts', QUICK_TIMEOUT_MS / 1000]);
  pin(['OLDER_PROJECTS_DAYS', 'client/src/lib/projectsView.ts', OLDER_PROJECTS_DAYS],
    ['OLDER_PROJECTS_DAYS', 'server/lib/management.ts', SERVER_OLDER_PROJECTS_DAYS]);
  pin(['DOMINANCE_PCT', RATES, DOMINANCE_PCT], ['DOMINANCE * 100', RATE, Math.round(DOMINANCE * 100)]);
  pin(['CURRENT_MIN_WINDOWS', RATES, CURRENT_MIN_WINDOWS], ['CURRENT_FLOORS.minIntervals', RATE, CURRENT_FLOORS.minIntervals]);
  pin(['BASELINE_DAYS', RATES, BASELINE_DAYS], ['BASELINE_MS / 86_400_000', RATE, BASELINE_MS / DAY_MS]);
  pin(['PEAK_START_HOUR_ET', RATES, PEAK_START_HOUR_ET], ['PEAK_START_HOUR_ET', BOOST, SERVER_PEAK_START_HOUR_ET]);
  pin(['PEAK_END_HOUR_ET', RATES, PEAK_END_HOUR_ET], ['PEAK_END_HOUR_ET', BOOST, SERVER_PEAK_END_HOUR_ET]);
  pin(['BOOST_MIN_RATIO', RATES, BOOST_MIN_RATIO], ['BOOST_MIN_RATIO', BOOST, SERVER_BOOST_MIN_RATIO]);
  pin(['BOOST_MIN_RUN_DAYS', RATES, BOOST_MIN_RUN_DAYS], ['BOOST_MIN_RUN_DAYS', BOOST, SERVER_BOOST_MIN_RUN_DAYS]);
  pin(['BOOST_DAYS', RATES, BOOST_DAYS], ['BOOST_MS / 86_400_000', BOOST, BOOST_MS / DAY_MS]);
  pin(['WEEKEND_MIN_RUN_DAYS', RATES, WEEKEND_MIN_RUN_DAYS], ['WEEKEND_MIN_RUN_DAYS', BOOST, SERVER_WEEKEND_MIN_RUN_DAYS]);

  r(test('chat hint states both caps and the real window bound — 512 KB widening to 8 MB, never "at most one" window', () => {
    for (const part of ['2,000 characters', '20,000', '512 KB', '8 MB']) assert.ok(CHAT_MESSAGES_HINT.includes(part), `missing ${part}: ${CHAT_MESSAGES_HINT}`);
    assert.ok(!CHAT_MESSAGES_HINT.includes('at most one'), CHAT_MESSAGES_HINT);
  }));

  r(test('copy sites carry no hand-typed copy of a pinned number (#509)', () => {
    const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const gone: [string, string[]][] = [
      ['client/src/components/settings/SettingsView.tsx', ['512 KB', '2 000', '20 000']],
      ['client/src/components/usage/UsageRates.tsx', ['ten recorded windows', '90%']],
      ['client/src/lib/gitQuick.ts', ['60s']],
      ['client/src/lib/projectsView.ts', ['30 days']],
      ['client/src/lib/usageRatesFormat.ts', ['08:00–14:00', '1.5×', '14 days', 'three days running', 'Two weekend days', 'the 17 ']]
    ];
    const hits: string[] = [];
    for (const [rel, literals] of gone) for (const l of literals) if (src(rel).includes(l)) hits.push(`${rel}: ${l}`);
    assert.deepStrictEqual(hits, []);
  }));

  const BOUNDS = 'client/src/lib/settingsBounds.ts';
  const SERVER_SETTINGS = 'server/lib/settings.ts';
  pin(['ANSWER_SECS_MIN', BOUNDS, ANSWER_SECS_MIN], ['MIN_ANSWER_SECS', SERVER_SETTINGS, MIN_ANSWER_SECS]);
  pin(['ANSWER_SECS_MAX', BOUNDS, ANSWER_SECS_MAX], ['MAX_ANSWER_SECS', SERVER_SETTINGS, MAX_ANSWER_SECS]);
  pin(['IDLE_SECS_MAX', BOUNDS, IDLE_SECS_MAX], ['MAX_IDLE_SECS', SERVER_SETTINGS, MAX_IDLE_SECS]);

  r(test('SettingsView.tsx: the Answer window and idle fields take their bounds from settingsBounds.ts, not literals', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/src/components/settings/SettingsView.tsx'), 'utf8');
    for (const prop of ['min={ANSWER_SECS_MIN}', 'max={ANSWER_SECS_MAX}', 'max={IDLE_SECS_MAX}']) assert.ok(src.includes(prop), `missing ${prop}`);
  }));

  r(test('no client .tsx gives maxLength a bare number — a composer cap is a named constant pinned above', () => {
    // The matcher first, so a guard that matches nothing cannot pass vacuously.
    assert.deepStrictEqual(bareMaxLengthLines('<textarea\n  maxLength={4000}\n/>'), [2]);
    assert.deepStrictEqual(bareMaxLengthLines('<textarea maxLength={PROMPT_CAP} />'), []);
    const hits: string[] = [];
    for (const file of tsxFiles(path.join(ROOT, 'client', 'src'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const line of bareMaxLengthLines(fs.readFileSync(file, 'utf8'))) hits.push(`${rel}:${line}`);
    }
    assert.deepStrictEqual(hits, [], `bare maxLength literal at ${hits.join(', ')}`);
  }));

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
