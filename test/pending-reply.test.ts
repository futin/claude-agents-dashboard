import assert from 'node:assert';

import { afterDismiss, afterPoll, afterSend, canSend, replyOutcome } from '../client/src/lib/pendingReply.js';
import type { WriteResult } from '../client/src/lib/postWrite.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A `WriteResult` for `status`; `refusal` as `postWrite` would classify it. */
function result(status: number, refusal: WriteResult['refusal'] = null): WriteResult {
  return { status, ok: status >= 200 && status < 300, refusal, body: undefined };
}

export function run(): number {
  console.log('\n=== pendingReply.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('replyOutcome: 200 ok, 403 by refusal, 404/409 gone, everything else error', () => {
    assert.strictEqual(replyOutcome(result(200)), 'ok');
    assert.strictEqual(replyOutcome(result(403, 'read-only')), 'read-only');
    assert.strictEqual(replyOutcome(result(403, 'token')), 'token');
    assert.strictEqual(replyOutcome(result(404)), 'gone');
    assert.strictEqual(replyOutcome(result(409)), 'gone');
    assert.strictEqual(replyOutcome(result(400)), 'error');
    assert.strictEqual(replyOutcome(result(500)), 'error');
    assert.strictEqual(replyOutcome(result(0)), 'error');
  }));

  tally(test('afterSend: success clears both flags; a refusal sets its flag and clears the other; gone and error touch neither', () => {
    assert.deepStrictEqual(afterSend('ok', 'sent'), { phase: 'sent', needsToken: false, readOnly: false });
    assert.deepStrictEqual(afterSend('ok', 'submitted'), { phase: 'submitted', needsToken: false, readOnly: false });
    assert.deepStrictEqual(afterSend('token', 'sent'), { phase: 'idle', needsToken: true, readOnly: false });
    assert.deepStrictEqual(afterSend('read-only', 'sent'), { phase: 'idle', readOnly: true, needsToken: false });
    assert.deepStrictEqual(afterSend('gone', 'sent'), { phase: 'gone' });
    assert.deepStrictEqual(afterSend('error', 'sent'), { phase: 'idle' });
  }));

  tally(test('afterDismiss: a refusal sets only its own flag — the other flag key is absent', () => {
    assert.deepStrictEqual(afterDismiss('ok'), { phase: 'idle', clearPending: true });
    assert.deepStrictEqual(afterDismiss('token'), { phase: 'idle', needsToken: true });
    assert.ok(!('readOnly' in afterDismiss('token')), 'token dismiss leaves readOnly alone');
    assert.deepStrictEqual(afterDismiss('read-only'), { phase: 'idle', readOnly: true });
    assert.ok(!('needsToken' in afterDismiss('read-only')), 'read-only dismiss leaves needsToken alone');
    assert.deepStrictEqual(afterDismiss('gone'), { phase: 'gone' });
    assert.deepStrictEqual(afterDismiss('error'), { phase: 'idle' });
  }));

  tally(test('afterPoll: a fresh accepted banner outlives the wait; a new id resets the panel', () => {
    assert.deepStrictEqual(afterPoll('q1', null, 'sent', 'sent'), { phaseFor: 'q1', phase: 'sent', fresh: false });
    assert.deepStrictEqual(afterPoll('q1', null, 'gone', 'sent'), { phaseFor: 'q1', phase: 'idle', fresh: false });
    assert.deepStrictEqual(afterPoll(null, null, 'idle', 'sent'), { phaseFor: null, phase: 'idle', fresh: false });
    assert.deepStrictEqual(afterPoll('q1', 'q2', 'sent', 'sent'), { phaseFor: 'q2', phase: 'idle', fresh: true });
    assert.deepStrictEqual(afterPoll('q1', 'q1', 'submitting', 'sent'), { phaseFor: 'q1', phase: 'submitting', fresh: false });
  }));

  tally(test('canSend: needs something pending, no POST out, and non-blank text when text is given', () => {
    const pending = { messageId: 'm1' };
    assert.strictEqual(canSend(null, 'idle'), false);
    assert.strictEqual(canSend(pending, 'submitting'), false);
    assert.strictEqual(canSend(pending, 'idle', '  '), false);
    assert.strictEqual(canSend(pending, 'idle', 'x'), true);
    assert.strictEqual(canSend(pending, 'idle'), true);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
