import assert from 'node:assert';

import { AUTO_MODES, shouldNotify } from '../server/lib/notify.js';
import { DEFAULT_NOTIFY } from '../server/lib/settings.js';
import type { PredicateContext } from '../server/lib/notify.js';
import type { NotifyPolicy } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
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

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
