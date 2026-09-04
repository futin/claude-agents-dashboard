import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atDesk, AUTO_MODES, maybeSend, resetNotify, resolveLabel, sendTest,
  setIdleSource, setLabelResolver, setSender, shouldNotify
} from '../server/lib/notify.js';
import { DEFAULT_NOTIFY, resetSettings, setSettings } from '../server/lib/settings.js';
import { resetState } from '../server/lib/remoteState.js';
import type { NotifyPayload, PredicateContext } from '../server/lib/notify.js';
import { resetEnvBaseline } from '../server/lib/config.js';
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
    // Another suite's `loadConfig` on a tmpdir would otherwise leave a baseline
    // pointing at a directory that is gone, making `staleEnvKeys` report every
    // key as changed and every "sent" outcome carry a warning.
    resetEnvBaseline();
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

  if (await testAsync('a phrase override replaces the stock event phrase', () => inTmpCwd(sent => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    maybeSend(conf(), 'stop', { sessionId: SID, phrase: 'finished — reply window open' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].body, 'demo-project — finished — reply window open');
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

  // The whole point of the test button: a refused or undelivered push must not
  // read like a delivered one. Before the transport reported back, all three of
  // these cases returned the same "sent to …" string.
  if (await testAsync('sendTest reports a refusal from ntfy', () => inTmpCwd(async () => {
    setSender(() => Promise.resolve({ ok: false, status: 404, detail: 'topic not found' }));
    const outcome = await sendTest(conf());
    assert.match(outcome, /404/);
    assert.match(outcome, /topic not found/);
    assert.doesNotMatch(outcome, /^sent/);
  }))) p++; else f++;

  if (await testAsync('sendTest reports a server it could not reach', () => inTmpCwd(async () => {
    setSender(() => Promise.resolve({ ok: false, status: 0, detail: 'getaddrinfo ENOTFOUND' }));
    const outcome = await sendTest(conf());
    assert.match(outcome, /couldn't reach/);
    assert.match(outcome, /ENOTFOUND/);
  }))) p++; else f++;

  if (await testAsync('sendTest still reports a transport that says nothing', () => inTmpCwd(async () => {
    setSender(() => { /* the fire-and-forget contract */ });
    assert.match(await sendTest(conf()), /^sent to/);
  }))) p++; else f++;

  // A delivered push whose tap opens nothing is the failure this button exists
  // to expose, so "sent" alone is not an honest answer without a public URL.
  if (await testAsync('sendTest says so when there is no public URL to tap through to', () =>
    inTmpCwd(async () => {
      const outcome = await sendTest(conf({ publicUrl: '' }));
      assert.match(outcome, /^sent to/);
      assert.match(outcome, /DASHBOARD_PUBLIC_URL/);
    }))) p++; else f++;

  if (await testAsync('a rejecting sender never escapes maybeSend', () => inTmpCwd(async () => {
    setSettings({ notify: { enabled: true, events: { stop: true } } });
    setSender(() => Promise.reject(new Error('socket hang up')));
    maybeSend(conf(), 'stop', { sessionId: SID });
    // An un-awaited rejection surfaces a tick later, so give it one before the
    // process gets the chance to die on it.
    await new Promise(r => setTimeout(r, 0));
  }))) p++; else f++;

  // --- atDesk: the one "are they at the keyboard" rule, shared by backAtDesk,
  // the requireAfk clause and the desk routing.

  if (test('atDesk is true only below the threshold, exclusive at the boundary', () => {
    assert.strictEqual(atDesk(10, 60), true);
    assert.strictEqual(atDesk(60, 60), false, 'equal counts as away, matching backAtDesk');
    assert.strictEqual(atDesk(61, 60), false);
  })) p++; else f++;

  if (test('atDesk treats an unreadable idle as away', () => {
    assert.strictEqual(atDesk(null, 60), false);
  })) p++; else f++;

  if (test('atDesk treats a zero threshold as away', () => {
    assert.strictEqual(atDesk(0, 0), false, 'zero disables the idle gate everywhere');
    assert.strictEqual(atDesk(10, 0), false);
  })) p++; else f++;

  // Asserted rather than guarded: a negative reading is nonsense the caller
  // should never produce, and pinning today's answer means a future guard has to
  // change this line on purpose rather than by accident.
  if (test('atDesk does not special-case a negative reading', () => {
    assert.strictEqual(atDesk(-1, 60), true);
  })) p++; else f++;

  // --- the idle reading is a thunk so an uninterested policy never spawns
  // `ioreg`, and memoised so an interested one spawns exactly once.

  if (await testAsync('maybeSend never reads idle when no clause wants it', () => inTmpCwd(() => {
    let calls = 0;
    setSettings({ idleSecs: 60, notify: { enabled: true, events: { stop: true } } });
    setIdleSource(() => { calls++; return 300; });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(calls, 0, 'requireAfk off and no desk topic must cost no ioreg spawn');
  }))) p++; else f++;

  if (await testAsync('maybeSend reads idle exactly once for requireAfk', () => inTmpCwd(() => {
    let calls = 0;
    setSettings({
      idleSecs: 60,
      notify: { enabled: true, events: { stop: true }, requireAfk: true }
    });
    setIdleSource(() => { calls++; return 300; });
    maybeSend(conf(), 'stop', { sessionId: SID });
    assert.strictEqual(calls, 1);
  }))) p++; else f++;

  // --- desk routing. Exclusive: exactly one publish, to exactly one topic.

  /** A config with both topics set, so routing has a real choice to make. */
  const twoTopic = (over: Partial<Config> = {}): Config => conf({
    ntfyTopicDesk: 'desk-topic',
    localUrl: 'http://localhost:4173',
    ...over
  } as Partial<Config>);

  if (await testAsync('at the desk, a push goes to the desk topic and taps only dismiss', () =>
    inTmpCwd(sent => {
      setSettings({ idleSecs: 60, notify: { enabled: true, events: { stop: true } } });
      setIdleSource(() => 10);
      maybeSend(twoTopic(), 'stop', { sessionId: SID });
      assert.strictEqual(sent.length, 1, 'exclusive — never both topics');
      assert.strictEqual(sent[0].topic, 'desk-topic');
      assert.strictEqual(sent[0].click, 'http://localhost:4173/api/dismiss',
        'the desk push carries no deep link — tapping only dismisses');
    }))) p++; else f++;

  if (await testAsync('away from the desk, a push goes to the phone topic and the public URL', () =>
    inTmpCwd(sent => {
      setSettings({ idleSecs: 60, notify: { enabled: true, events: { stop: true } } });
      setIdleSource(() => 120);
      maybeSend(twoTopic(), 'stop', { sessionId: SID });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].topic, 'test-topic');
      assert.strictEqual(sent[0].click, `https://dash.example/?session=${SID}`);
    }))) p++; else f++;

  if (await testAsync('an unreadable idle routes to the phone', () => inTmpCwd(sent => {
    setSettings({ idleSecs: 60, notify: { enabled: true, events: { stop: true } } });
    setIdleSource(() => null);
    maybeSend(twoTopic(), 'stop', { sessionId: SID });
    assert.strictEqual(sent[0].topic, 'test-topic', 'cannot tell → the channel that always works');
  }))) p++; else f++;

  if (await testAsync('a zero idle threshold routes to the phone', () => inTmpCwd(sent => {
    setSettings({ idleSecs: 0, notify: { enabled: true, events: { stop: true } } });
    setIdleSource(() => 0);
    maybeSend(twoTopic(), 'stop', { sessionId: SID });
    assert.strictEqual(sent[0].topic, 'test-topic', 'zero disables the idle gate everywhere');
  }))) p++; else f++;

  // The mirror case, and the one that would otherwise ship broken: proving the
  // desk path works says nothing about the path everyone who never sets a desk
  // topic is still on.
  if (await testAsync('with no desk topic, sitting at the desk changes nothing', () =>
    inTmpCwd(sent => {
      setSettings({ idleSecs: 60, notify: { enabled: true, events: { stop: true } } });
      setIdleSource(() => 10);
      maybeSend(conf(), 'stop', { sessionId: SID });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].topic, 'test-topic');
      assert.strictEqual(sent[0].click, `https://dash.example/?session=${SID}`);
    }))) p++; else f++;

  // Delete the memoisation in `maybeSend` and this goes to 2 — the requireAfk
  // clause reads once, then `routePush` reads again.
  if (await testAsync('routing and requireAfk share one idle reading', () => inTmpCwd(() => {
    let calls = 0;
    setSettings({
      idleSecs: 60,
      notify: { enabled: true, events: { stop: true }, requireAfk: true }
    });
    setIdleSource(() => { calls++; return 300; });
    maybeSend(twoTopic(), 'stop', { sessionId: SID });
    assert.strictEqual(calls, 1, 'two consumers, one ioreg spawn');
  }))) p++; else f++;

  // The test button's whole claim is that it routes as a real push does, so the
  // payload is asserted and not only the sentence it reports.
  if (await testAsync('sendTest sends the desk push the desk topic routes to', () =>
    inTmpCwd(async sent => {
      setIdleSource(() => 10);
      const outcome = await sendTest(twoTopic());
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].topic, 'desk-topic');
      assert.strictEqual(sent[0].click, 'http://localhost:4173/api/dismiss',
        'the test push must tap through where a real desk push does — nowhere');
      assert.match(outcome, /desk topic/);
      assert.match(outcome, /taps only dismiss/);
    }))) p++; else f++;

  if (await testAsync('sendTest names the phone topic when away', () => inTmpCwd(async sent => {
    setIdleSource(() => 300);
    const outcome = await sendTest(twoTopic());
    assert.strictEqual(sent[0].topic, 'test-topic');
    assert.match(sent[0].click, /^https:\/\/dash\.example\//,
      'the phone test push taps through to the dashboard, as a real one does');
    assert.match(outcome, /phone topic/);
    assert.match(outcome, /dash\.example/);
  }))) p++; else f++;

  // A desk topic with no phone topic behind it is a misconfiguration, not a mode.
  if (await testAsync('sendTest still refuses when only the desk topic is set', () =>
    inTmpCwd(async () => {
      setIdleSource(() => 10);
      const outcome = await sendTest(twoTopic({ ntfyTopic: '' } as Partial<Config>));
      assert.match(outcome, /no NTFY_TOPIC set/);
    }))) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
