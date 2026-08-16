import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTO_MODES, maybeSend, resetNotify, resolveLabel, sendTest,
  setLabelResolver, setSender, shouldNotify
} from '../server/lib/notify.js';
import { DEFAULT_NOTIFY, resetSettings, setSettings } from '../server/lib/settings.js';
import { resetState } from '../server/lib/remoteState.js';
import type { NotifyPayload, PredicateContext } from '../server/lib/notify.js';
import type { Config } from '../server/lib/config.js';
import type { NotifyPolicy } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** `test`, but for a case whose body awaits. Same pass/fail contract. */
async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A policy with the master on, one event on, and no optional layers. */
function policy(over: Partial<NotifyPolicy> = {}): NotifyPolicy {
  return {
    ...DEFAULT_NOTIFY,
    enabled: true,
    events: { ...DEFAULT_NOTIFY.events, question: true },
    ...over
  };
}

/** A context that satisfies every layer, so each test can break exactly one. */
function ctx(over: Partial<PredicateContext> = {}): PredicateContext {
  return {
    remoteAnswer: true,
    thresholdSecs: 60,
    permissionMode: 'bypassPermissions',
    readIdle: () => 300,
    ...over
  };
}

/** Only the fields notify reads. */
function conf(over: Partial<Config> = {}): Config {
  return {
    remoteAnswer: true,
    ntfyTopic: 'test-topic',
    ntfyServer: 'https://ntfy.example',
    publicUrl: 'https://dash.example',
    ...over
  } as Config;
}

/**
 * Settings and remote state resolve from cwd, so these tests run in a tmpdir
 * with the transport swapped for a recorder. Async so the two `sendTest` cases
 * can await inside it — a sync-only helper would tear the tmpdir down before
 * their assertions ran.
 */
async function inTmpCwd(fn: (sent: NotifyPayload[]) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-notify-'));
  const prev = process.cwd();
  const sent: NotifyPayload[] = [];
  try {
    process.chdir(dir);
    resetSettings();
    resetState();
    resetNotify();
    setSender(payload => { sent.push(payload); });
    // Otherwise every delivery test scans the developer's real ~/.claude/projects.
    setLabelResolver(() => 'demo-project');
    await fn(sent);
  } finally {
    process.chdir(prev);
    resetNotify();
    resetSettings();
    resetState();
  }
}

export async function run(): Promise<number> {
  console.log('\n=== notify.ts ===\n');
  let p = 0, f = 0;

  if (test('sends when every gate passes', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx()), true);
  })) p++; else f++;

  if (test('master off blocks everything', () => {
    assert.strictEqual(shouldNotify('question', policy({ enabled: false }), ctx()), false);
  })) p++; else f++;

  if (test('an unselected event is never sent', () => {
    assert.strictEqual(shouldNotify('stop', policy(), ctx()), false);
    assert.strictEqual(shouldNotify('plan', policy(), ctx()), false);
    assert.strictEqual(shouldNotify('permission', policy(), ctx()), false);
  })) p++; else f++;

  if (test('requireRemoteAnswer honours the toggle', () => {
    const pol = policy({ requireRemoteAnswer: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: true })), true);
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: false })), false);
  })) p++; else f++;

  if (test('requireRemoteAnswer off ignores the toggle', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx({ remoteAnswer: false })), true);
  })) p++; else f++;

  if (test('requireAfk compares idle against the threshold', () => {
    const pol = policy({ requireAfk: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 61 })), true);
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 60 })), true, 'equal counts as away');
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 59 })), false);
  })) p++; else f++;

  if (test('unreadable idle pushes anyway', () => {
    const pol = policy({ requireAfk: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => null })), true);
  })) p++; else f++;

  if (test('requireAfk off never reads idle', () => {
    let calls = 0;
    shouldNotify('question', policy(), ctx({ readIdle: () => { calls++; return 0; } }));
    assert.strictEqual(calls, 0, 'the ioreg spawn must be skipped entirely');
  })) p++; else f++;

  if (test('a failing cheap gate short-circuits before idle', () => {
    let calls = 0;
    const pol = policy({ enabled: false, requireAfk: true });
    shouldNotify('question', pol, ctx({ readIdle: () => { calls++; return 0; } }));
    assert.strictEqual(calls, 0);
  })) p++; else f++;

  if (test('requireAutoMode accepts only auto-ish modes', () => {
    const pol = policy({ requireAutoMode: true });
    for (const mode of AUTO_MODES) {
      assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: mode })), true, mode);
    }
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'default' })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'plan' })), false);
  })) p++; else f++;

  if (test('a missing permission mode is not auto-ish', () => {
    const pol = policy({ requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: undefined })), false);
  })) p++; else f++;

  if (test('requireAutoMode off ignores the mode', () => {
    assert.strictEqual(shouldNotify('question', policy(), ctx({ permissionMode: undefined })), true);
  })) p++; else f++;

  if (test('all three layers on, all satisfied', () => {
    const pol = policy({ requireRemoteAnswer: true, requireAfk: true, requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx()), true);
  })) p++; else f++;

  if (test('all three layers on, any one violated blocks', () => {
    const pol = policy({ requireRemoteAnswer: true, requireAfk: true, requireAutoMode: true });
    assert.strictEqual(shouldNotify('question', pol, ctx({ remoteAnswer: false })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ readIdle: () => 5 })), false);
    assert.strictEqual(shouldNotify('question', pol, ctx({ permissionMode: 'default' })), false);
  })) p++; else f++;

  const SID = 'abc12345-0000-0000-0000-000000000000';

  if (await testAsync('maybeSend delivers when the policy passes', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].title, 'Claude Code');
    assert.match(sent[0].body, /task finished$/);
  }))) p++; else f++;

  if (await testAsync('maybeSend is silent when the policy fails', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: false, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 0);
  }))) p++; else f++;

  if (await testAsync('no topic configured means nothing is sent', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf({ ntfyTopic: '' }), 'stop', { sessionId: SID });
    assert.strictEqual(sent.length, 0);
  }))) p++; else f++;

  if (await testAsync('the visible payload carries no work content', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf(), 'question', { sessionId: SID, permissionMode: 'bypassPermissions' });
    assert.strictEqual(sent.length, 1);
    // The click URL legitimately holds the id; nothing the user reads may.
    const visible = `${sent[0].title} ${sent[0].body} ${sent[0].tags}`;
    for (const leak of ['bypassPermissions', SID]) {
      assert.ok(!visible.includes(leak), `visible payload must not contain ${leak}`);
    }
  }))) p++; else f++;

  if (await testAsync('the click URL deep-links to the session', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf(), 'question', { sessionId: SID });
    assert.strictEqual(sent[0].click, `https://dash.example/?session=${SID}`);
  }))) p++; else f++;

  if (await testAsync('no public URL means no click header', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { question: true } } });
    maybeSend(conf({ publicUrl: '' }), 'question', { sessionId: SID });
    assert.strictEqual(sent.length, 1, 'the push still goes out');
    assert.strictEqual(sent[0].click, '');
  }))) p++; else f++;

  if (await testAsync('the label reaches the body', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(sent[0].body, 'demo-project — task finished');
  }))) p++; else f++;

  // The one case that exercises the real lookup, so the fallback is covered
  // rather than stubbed. Runs one scan; no id this shaped can ever match.
  if (test('an unknown session falls back to a short id', () => {
    resetNotify();
    assert.strictEqual(resolveLabel(conf(), 'deadbeef-0000-0000-0000-000000000000'), 'deadbeef');
  })) p++; else f++;

  if (await testAsync('a throwing sender never escapes maybeSend', () => inTmpCwd(() => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    setSender(() => { throw new Error('network down'); });
    maybeSend(conf(), 'stop', { sessionId: SID }); // must not throw
  }))) p++; else f++;

  if (await testAsync('sendTest fires regardless of the policy', () => inTmpCwd(async sent => {
    // Master switch left off — the test button must still send.
    const outcome = await sendTest(conf());
    assert.strictEqual(sent.length, 1);
    assert.match(outcome, /sent/);
  }))) p++; else f++;

  if (await testAsync('sendTest reports a missing topic instead of throwing', () => inTmpCwd(async () => {
    const outcome = await sendTest(conf({ ntfyTopic: '' }));
    assert.match(outcome, /NTFY_TOPIC/);
  }))) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
