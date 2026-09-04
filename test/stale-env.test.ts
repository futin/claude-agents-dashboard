/**
 * `staleEnvKeys()` — does this process still run on what `.env` says?
 *
 * Config is read once, at startup. Editing `.env` without restarting leaves the
 * server running values nobody can see any more, and for the push feature that
 * failure is invisible in the worst way: it publishes to the *previous* topic,
 * ntfy answers 2xx, `sendTest` truthfully reports "sent", and nothing arrives.
 * That happened on 2026-09-04 and was diagnosed only by polling ntfy's own
 * message cache from outside the app.
 *
 * The property under test is therefore not "the file changed" but "a setting
 * this process is using changed": comment edits do not count, and a key pinned
 * in `process.env` does not count either, because a restart would not move it.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resetEnvBaseline, staleEnvKeys } from '../server/lib/config.js';
import {
  resetNotify, sendTest, setIdleSource, setLabelResolver, setSender
} from '../server/lib/notify.js';
import { resetSettings, setSettings } from '../server/lib/settings.js';
import { resetState } from '../server/lib/remoteState.js';
import type { Config } from '../server/lib/config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const BASE = 'PORT=4173\nNTFY_TOPIC=phone-one\nNTFY_TOPIC_DESK=desk-one\nLOOKBACK_HOURS=24\n';

/**
 * A tmpdir holding a .env, with the baseline loaded from it. Cleans up.
 *
 * Async and awaiting `fn` even for the synchronous cases: a `try { return fn() }
 * finally { rm }` tears the tmpdir down the moment an async body yields, so the
 * send cases would assert against a directory that no longer exists.
 */
async function inEnvDir(
  body: string,
  fn: (envPath: string, write: (text: string) => void) => void | Promise<void>
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-staleenv-'));
  const envPath = path.join(dir, '.env');
  const prevCwd = process.cwd();
  fs.writeFileSync(envPath, body);
  loadConfig({ envPath });
  try {
    await fn(envPath, text => fs.writeFileSync(envPath, text));
  } finally {
    process.chdir(prevCwd);
    resetEnvBaseline();
    resetNotify();
    resetSettings();
    resetState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(): Promise<number> {
  console.log('\n=== staleEnvKeys (config.ts) ===\n');
  let p = 0, f = 0;

  if (await testAsync('an untouched .env is not stale', () =>
    inEnvDir(BASE, () => {
      assert.deepStrictEqual(staleEnvKeys(), []);
    }))) p++; else f++;

  if (await testAsync('a changed value names that key, and only that key', () =>
    inEnvDir(BASE, (_e, write) => {
      write(BASE.replace('desk-one', 'desk-two'));
      assert.deepStrictEqual(staleEnvKeys(), ['NTFY_TOPIC_DESK']);
    }))) p++; else f++;

  // The whole point of comparing parsed values rather than an mtime: a comment
  // edit would otherwise cry wolf, and a warning that cries wolf gets ignored
  // exactly when it is finally right.
  if (await testAsync('a comment-only edit is not a changed setting', () =>
    inEnvDir(BASE, (_e, write) => {
      write('# a new comment\n\n' + BASE);
      assert.deepStrictEqual(staleEnvKeys(), []);
    }))) p++; else f++;

  if (await testAsync('a key added after load is named', () =>
    inEnvDir(BASE, (_e, write) => {
      write(BASE + 'DASHBOARD_PUBLIC_URL=https://dash.example\n');
      assert.deepStrictEqual(staleEnvKeys(), ['DASHBOARD_PUBLIC_URL']);
    }))) p++; else f++;

  if (await testAsync('a key removed after load is named — the process still holds it', () =>
    inEnvDir(BASE, (_e, write) => {
      write(BASE.replace('NTFY_TOPIC_DESK=desk-one\n', ''));
      assert.deepStrictEqual(staleEnvKeys(), ['NTFY_TOPIC_DESK']);
    }))) p++; else f++;

  if (await testAsync('a deleted .env names every key it used to define', () =>
    inEnvDir(BASE, envPath => {
      fs.rmSync(envPath);
      assert.deepStrictEqual(staleEnvKeys(), ['LOOKBACK_HOURS', 'NTFY_TOPIC', 'NTFY_TOPIC_DESK', 'PORT']);
    }))) p++; else f++;

  // A restart would not change it, so naming it would be false advice.
  if (await testAsync('a key pinned in process.env is skipped, however the file changes', () =>
    inEnvDir(BASE, (_e, write) => {
      const prev = process.env.NTFY_TOPIC_DESK;
      process.env.NTFY_TOPIC_DESK = 'pinned-by-the-shell';
      try {
        write(BASE.replace('desk-one', 'desk-two'));
        assert.deepStrictEqual(staleEnvKeys(), []);
      } finally {
        if (prev === undefined) delete process.env.NTFY_TOPIC_DESK;
        else process.env.NTFY_TOPIC_DESK = prev;
      }
    }))) p++; else f++;

  // A hand-built Config (every test double in this repo) has no baseline, and
  // guessing one from the cwd would report a developer's own .env as stale.
  if (test('with no baseline the answer is empty, not a guess', () => {
    resetEnvBaseline();
    assert.deepStrictEqual(staleEnvKeys(), []);
  })) p++; else f++;

  console.log('\n=== the test push says so (notify.ts) ===\n');

  /** The config the desk-routing tests use, matching BASE's topics. */
  const conf = (over: Partial<Config> = {}): Config => ({
    remoteAnswer: true,
    ntfyTopic: 'phone-one',
    ntfyTopicDesk: 'desk-one',
    ntfyServer: 'https://ntfy.example',
    publicUrl: 'https://dash.example',
    localUrl: 'http://localhost:4173',
    ...over
  } as Config);

  /** Settings live in the cwd, so every send case runs inside the tmpdir. */
  function armSend(envPath: string): void {
    process.chdir(path.dirname(envPath));
    resetSettings();
    resetState();
    resetNotify();
    setSender(() => { /* fire-and-forget: the outcome is what's under test */ });
    setLabelResolver(() => 'demo-project');
    setIdleSource(() => 10); // at the desk
    setSettings({ idleSecs: 60 });
  }

  if (await testAsync('an edited desk topic is called out in the test push outcome', () =>
    inEnvDir(BASE, async (envPath, write) => {
      armSend(envPath);
      write(BASE.replace('desk-one', 'desk-two'));
      const outcome = await sendTest(conf());
      assert.match(outcome, /^sent to/, 'it did send — the warning is about where');
      assert.match(outcome, /NTFY_TOPIC_DESK changed in \.env/);
      assert.match(outcome, /OLD value/);
    }))) p++; else f++;

  if (await testAsync('an unchanged .env leaves the outcome clean', () =>
    inEnvDir(BASE, async envPath => {
      armSend(envPath);
      const outcome = await sendTest(conf());
      assert.doesNotMatch(outcome, /changed in \.env/);
      assert.doesNotMatch(outcome, /⚠️/);
    }))) p++; else f++;

  // The push outcome speaks only for the push. An unrelated key belongs on the
  // Settings page, where the full list is shown.
  if (await testAsync('a changed key this feature never reads is left out', () =>
    inEnvDir(BASE, async (envPath, write) => {
      armSend(envPath);
      write(BASE.replace('LOOKBACK_HOURS=24', 'LOOKBACK_HOURS=48'));
      assert.deepStrictEqual(staleEnvKeys(), ['LOOKBACK_HOURS'], 'it is stale…');
      const outcome = await sendTest(conf());
      assert.doesNotMatch(outcome, /changed in \.env/, '…but not the push feature’s problem');
    }))) p++; else f++;

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
