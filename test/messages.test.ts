import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TEXT_CAP,
  answer, cancel, composeReason, dismissAll, getPendingMessage, messageSessionIds,
  register, resetStore, setIdleReader, sweepIdle
} from '../server/lib/messages.js';
import { setSettings, resetSettings, SETTINGS_FILE } from '../server/lib/settings.js';
import type { MessageWaitResult } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A collector standing in for the hook's held HTTP response. */
function waiter(): { results: MessageWaitResult[]; resolve: (r: MessageWaitResult) => void } {
  const results: MessageWaitResult[] = [];
  return { results, resolve: r => { results.push(r); } };
}

/** Run a test in isolation: tmpdir cwd so settings file is unshared with the real one. */
function inTmpCwd(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-msg-'));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    resetSettings();
    fn();
  } finally {
    process.chdir(prev);
    resetSettings();
  }
}

export async function run(): Promise<number> {
  console.log('\n=== messages.ts ===\n');
  let p = 0, f = 0;
  resetStore();

  /* ----------------------------------------------------- composeReason (pure) */

  if (test('reason carries the text and the away-mode reminder', () => {
    const reason = composeReason('  now run the tests  ');
    assert.ok(reason.includes('now run the tests'));
    assert.ok(reason.includes('AskUserQuestion'));
    assert.ok(reason.includes('away'));
  })) p++; else f++;

  /* ------------------------------------------------------------ state machine */

  if (test('register exposes the window with a deadline and flags the session', () => {
    resetStore();
    const w = waiter();
    const before = Date.now();
    const messageId = register('s1', 60_000, w.resolve);
    const pending = getPendingMessage('s1')!;
    assert.strictEqual(pending.messageId, messageId);
    const expires = Date.parse(pending.expiresAt);
    assert.ok(expires >= before + 59_000 && expires <= Date.now() + 61_000);
    assert.deepStrictEqual([...messageSessionIds()], ['s1']);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('a text answer resolves the waiter with a composed reason and clears the entry', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, text: 'also update the docs' }), 'ok');
    assert.strictEqual(w.results.length, 1);
    assert.strictEqual(w.results[0].status, 'answered');
    assert.ok(w.results[0].reason!.includes('also update the docs'));
    assert.strictEqual(getPendingMessage('s1'), null);
  })) p++; else f++;

  if (test('text is capped at TEXT_CAP', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, text: 'y'.repeat(TEXT_CAP + 500) }), 'ok');
    // composeReason adds fixed prose around the text, so the cap bounds the text, not the reason
    assert.ok(w.results[0].reason!.includes('y'.repeat(TEXT_CAP)));
    assert.ok(!w.results[0].reason!.includes('y'.repeat(TEXT_CAP + 1)));
  })) p++; else f++;

  if (test('dismiss resolves dismissed — the session just stops', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', { messageId, dismiss: true }), 'ok');
    assert.deepStrictEqual(w.results, [{ status: 'dismissed' }]);
  })) p++; else f++;

  if (test('malformed answers are refused without touching the entry', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    assert.strictEqual(answer('s1', null), 'malformed');
    assert.strictEqual(answer('s1', {}), 'malformed');
    assert.strictEqual(answer('s1', { messageId }), 'malformed');            // neither text nor dismiss
    assert.strictEqual(answer('s1', { messageId, text: '   ' }), 'malformed'); // blank text
    assert.strictEqual(answer('s1', { messageId: 'nope', text: 'hi' }), 'mismatch');
    assert.strictEqual(answer('s2', { messageId, text: 'hi' }), 'not-found');
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('re-register supersedes the previous hold', () => {
    resetStore();
    const w1 = waiter(); const w2 = waiter();
    register('s1', 60_000, w1.resolve);
    const second = register('s1', 60_000, w2.resolve);
    assert.deepStrictEqual(w1.results, [{ status: 'superseded' }]);
    assert.strictEqual(getPendingMessage('s1')!.messageId, second);
  })) p++; else f++;

  if (test('cancel with a stale messageId is a no-op', () => {
    resetStore();
    const w = waiter();
    register('s1', 60_000, w.resolve);
    cancel('s1', 'stale-id');
    assert.notStrictEqual(getPendingMessage('s1'), null);
  })) p++; else f++;

  if (test('cancel drops the entry without resolving', () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 60_000, w.resolve);
    cancel('s1', messageId);
    assert.strictEqual(getPendingMessage('s1'), null);
    assert.strictEqual(w.results.length, 0);
  })) p++; else f++;

  if (test('dismissAll releases every hold and reports the count', () => {
    resetStore();
    const w1 = waiter(); const w2 = waiter();
    register('s1', 60_000, w1.resolve);
    register('s2', 60_000, w2.resolve);
    assert.strictEqual(dismissAll(), 2);
    assert.deepStrictEqual(w1.results, [{ status: 'dismissed' }]);
    assert.deepStrictEqual(w2.results, [{ status: 'dismissed' }]);
    assert.strictEqual(messageSessionIds().size, 0);
  })) p++; else f++;

  if (await testAsync('the deadline resolves timeout and a late answer finds nothing', async () => {
    resetStore();
    const w = waiter();
    const messageId = register('s1', 10, w.resolve);
    await new Promise(r => setTimeout(r, 40));
    assert.deepStrictEqual(w.results, [{ status: 'timeout' }]);
    assert.strictEqual(answer('s1', { messageId, text: 'too late' }), 'not-found');
  })) p++; else f++;

  /* ----------------------------------------------------- idle auto-release */

  if (test('sweepIdle releases every hold when you are back at the keyboard', () => {
    inTmpCwd(() => {
      resetStore();
      setSettings({ idleSecs: 60 });
      const w = waiter();
      register('s1', 60_000, w.resolve);
      setIdleReader(() => 3); // 3s idle < 60s threshold
      assert.strictEqual(sweepIdle(), 1);
      assert.deepStrictEqual(w.results, [{ status: 'released' }]);
      setIdleReader(null);
    });
  })) p++; else f++;

  if (test('sweepIdle does nothing while still away', () => {
    inTmpCwd(() => {
      resetStore();
      setSettings({ idleSecs: 60 });
      const w = waiter();
      register('s1', 60_000, w.resolve);
      setIdleReader(() => 9999); // 9999s idle >= 60s threshold
      assert.strictEqual(sweepIdle(), 0);
      assert.strictEqual(w.results.length, 0);
      setIdleReader(null);
    });
  })) p++; else f++;

  if (test('unreadable idle never auto-releases (Docker/non-macOS)', () => {
    inTmpCwd(() => {
      resetStore();
      setSettings({ idleSecs: 60 });
      const w = waiter();
      register('s1', 60_000, w.resolve);
      setIdleReader(() => null); // unreadable idle
      assert.strictEqual(sweepIdle(), 0);
      setIdleReader(null);
    });
  })) p++; else f++;

  if (test('sweepIdle returns 0 when idleSecs is 0 (idle check disabled)', () => {
    inTmpCwd(() => {
      resetStore();
      setSettings({ idleSecs: 0 });
      const w = waiter();
      register('s1', 60_000, w.resolve);
      setIdleReader(() => 3);
      assert.strictEqual(sweepIdle(), 0);
      assert.strictEqual(w.results.length, 0);
      setIdleReader(null);
    });
  })) p++; else f++;

  resetStore();
  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) run().then(f => process.exit(f > 0 ? 1 : 0));
