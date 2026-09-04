import assert from 'node:assert';

import type { Session } from '../shared/types.js';
import { holdCount, holdKind } from '../client/src/lib/holds.js';
import {
  dedupe, diffNeeds, notifyBody, notifyKey, notifyKind,
  type NotifyKind, type NotifyTarget
} from '../client/src/lib/webNotify.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Minimal Session; only the hold flags, the surface and the label carry meaning here. */
function sess(p: Partial<Session>): Session {
  return {
    id: p.id ?? 'id',
    project: p.project ?? 'proj',
    projectPath: null,
    sessionName: p.sessionName ?? null,
    gitBranch: null,
    model: 'claude-opus-4-8',
    tokens: 0,
    contextWindow: 200_000,
    contextWindowLabel: '200k',
    contextPct: 0,
    status: p.status ?? 'idle',
    surface: p.surface ?? 'local',
    remoteQuestion: p.remoteQuestion ?? false,
    remotePlan: p.remotePlan ?? false,
    remoteReply: p.remoteReply ?? false,
    permissionWait: p.permissionWait ?? false,
    activity: null,
    lastTimestamp: null,
    updatedMs: 1_700_000_000_000,
    version: null,
    kaizenLesson: null
  };
}

/** A headless session — the only surface the browser notifications cover. */
function headless(p: Partial<Session>): Session {
  return sess({ ...p, surface: 'dashboard' });
}

function target(p: Partial<NotifyTarget>): NotifyTarget {
  return { id: p.id ?? 'id', label: p.label ?? 'label', kind: p.kind ?? 'question' };
}

export function run(): number {
  console.log('\n=== holds.ts + webNotify.ts ===\n');
  let p = 0, f = 0;

  // --- holds.ts -----------------------------------------------------------

  if (test('the hold ladder runs question → plan → reply → permission', () => {
    const all = { remoteQuestion: true, remotePlan: true, remoteReply: true, permissionWait: true };
    assert.strictEqual(holdKind(sess(all)), 'question');
    assert.strictEqual(holdKind(sess({ ...all, remoteQuestion: false })), 'plan');
    assert.strictEqual(holdKind(sess({ ...all, remoteQuestion: false, remotePlan: false })), 'reply');
    assert.strictEqual(holdKind(sess({ permissionWait: true })), 'permission');
    assert.strictEqual(holdKind(sess({})), null);
  })) p++; else f++;

  if (test('holdCount counts every waiting row, whatever it waits on', () => {
    assert.strictEqual(holdCount([
      sess({ id: 'a', remoteQuestion: true }),
      sess({ id: 'b', remoteQuestion: true }),
      sess({ id: 'c', permissionWait: true }),
      sess({ id: 'd' }),
      sess({ id: 'e' })
    ]), 3);
  })) p++; else f++;

  // --- notifyKind: the two gates ------------------------------------------

  if (test('a local session announces nothing, however loudly it is waiting', () => {
    assert.strictEqual(notifyKind(sess({ surface: 'local', remoteQuestion: true })), null);
  })) p++; else f++;

  if (test('a headless permission wait announces nothing — there is no TTY to answer it in', () => {
    assert.strictEqual(notifyKind(headless({ permissionWait: true })), null);
  })) p++; else f++;

  if (test('a headless reply window announces', () => {
    assert.strictEqual(notifyKind(headless({ remoteReply: true })), 'reply');
  })) p++; else f++;

  // --- diffNeeds ----------------------------------------------------------

  if (test('an empty baseline yields the whole waiting set — skipping it is the caller’s job', () => {
    const out = diffNeeds(new Map(), [headless({ id: 'a', remoteQuestion: true })]);
    assert.deepStrictEqual(out, [{ id: 'a', label: 'proj', kind: 'question' }]);
  })) p++; else f++;

  if (test('a session still waiting on the same thing is not news', () => {
    const prev = new Map<string, NotifyKind>([['a', 'question']]);
    assert.deepStrictEqual(diffNeeds(prev, [headless({ id: 'a', remoteQuestion: true })]), []);
  })) p++; else f++;

  if (test('a different hold on the same session is news again', () => {
    const prev = new Map<string, NotifyKind>([['a', 'question']]);
    const out = diffNeeds(prev, [headless({ id: 'a', remoteReply: true })]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'reply');
  })) p++; else f++;

  if (test('a session that was working and is now waiting announces', () => {
    const prev = new Map<string, NotifyKind>([['b', 'plan']]);
    const out = diffNeeds(prev, [headless({ id: 'a', remoteQuestion: true })]);
    assert.deepStrictEqual(out.map(t => t.id), ['a']);
  })) p++; else f++;

  if (test('the label prefers the session name and falls back to the project', () => {
    const named = diffNeeds(new Map(), [headless({ id: 'a', sessionName: 'nightly', project: 'dash', remoteQuestion: true })]);
    assert.strictEqual(named[0].label, 'nightly');
    const bare = diffNeeds(new Map(), [headless({ id: 'b', sessionName: null, project: 'dash', remoteQuestion: true })]);
    assert.strictEqual(bare[0].label, 'dash');
  })) p++; else f++;

  // --- bodies -------------------------------------------------------------

  // Asserted against literals on purpose: these mirror `PHRASE` in
  // server/lib/notify.ts, and a drift apart should fail here rather than be
  // noticed by someone holding a phone in one hand and a laptop in the other.
  if (test('the three bodies read the way the ntfy push reads', () => {
    assert.strictEqual(notifyBody(target({ label: 'dash', kind: 'question' })), 'dash — question waiting');
    assert.strictEqual(notifyBody(target({ label: 'dash', kind: 'plan' })), 'dash — plan waiting for review');
    assert.strictEqual(notifyBody(target({ label: 'dash', kind: 'reply' })), 'dash — finished — reply window open');
  })) p++; else f++;

  // --- dedupe -------------------------------------------------------------

  if (test('a repeat inside the TTL is dropped, and the stale key is evicted afterwards', () => {
    const seen = new Map<string, number>();
    const t = target({ id: 'a', kind: 'question' });
    assert.strictEqual(dedupe([t], seen, 1000, 60_000).length, 1, 'first one goes through');
    assert.strictEqual(dedupe([t], seen, 2000, 60_000).length, 0, 'the repeat is suppressed');
    assert.strictEqual(seen.size, 1);
    assert.strictEqual(dedupe([t], seen, 1000 + 60_001, 60_000).length, 1, 'past the TTL it is news again');
    // The ledger must not accumulate: the expired entry was evicted, and what
    // is left is the one just recorded.
    assert.strictEqual(seen.size, 1);
    assert.strictEqual(seen.get('a:question'), 61_001);
  })) p++; else f++;

  if (test('one batch keeps two distinct sessions and drops its own duplicate', () => {
    const seen = new Map<string, number>();
    const out = dedupe([
      target({ id: 'a', kind: 'question' }),
      target({ id: 'b', kind: 'plan' }),
      target({ id: 'a', kind: 'question' })
    ], seen, 1000, 60_000);
    assert.deepStrictEqual(out.map(t => t.id), ['a', 'b']);
    assert.strictEqual(seen.size, 2);
  })) p++; else f++;

  if (test('the key separates two holds on one session', () => {
    assert.notStrictEqual(
      notifyKey(target({ id: 'a', kind: 'question' })),
      notifyKey(target({ id: 'a', kind: 'reply' }))
    );
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
