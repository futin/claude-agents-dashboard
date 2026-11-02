import assert from 'node:assert';

import { NETWORK_TEXT, pinWriteOutcome, TOKEN_TEXT } from '../client/src/lib/pinWrite.js';
import type { WriteResult } from '../client/src/lib/postWrite.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';
import type { PinsResponse } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function reply(status: number, body: unknown, refusal: WriteResult['refusal'] = null): WriteResult {
  return { status, ok: status >= 200 && status < 300, refusal, body };
}

const PAYLOAD: PinsResponse = { pinned: [], recent: [], older: [], home: '' };

export function run(): number {
  console.log('\n=== pin write outcome (client/src/lib/pinWrite.ts) ===\n');
  const results = [
    test('a 200 with the payload is fresh, the payload passed through', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(200, PAYLOAD)), { kind: 'fresh', pins: PAYLOAD });
    }),
    test('a 200 without the payload is failed with the network text', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(200, {})), { kind: 'failed', text: NETWORK_TEXT });
    }),
    test('no answer at all is failed with the network text', () => {
      assert.deepStrictEqual(pinWriteOutcome({ status: 0, ok: false, refusal: null, body: undefined }), { kind: 'failed', text: NETWORK_TEXT });
    }),
    test('a 403 asking for the token is failed with the token prompt', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(403, { error: 'bad token' }, 'token')), { kind: 'failed', text: TOKEN_TEXT });
    }),
    test('a read-only 403 is failed with the read-only text', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(403, { error: 'read-only from this network' }, 'read-only')), { kind: 'failed', text: READ_ONLY_TEXT });
    }),
    test('a 409 is conflict whatever its body, carrying the server text for setPin', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(409, { error: 'pin limit reached' })), { kind: 'conflict', text: 'pin limit reached' });
      assert.deepStrictEqual(pinWriteOutcome(reply(409, undefined)), { kind: 'conflict', text: 'Failed (409).' });
    }),
    test('a 500 with saved: true is saved, with the server text', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(500, { error: 'X', saved: true })), { kind: 'saved', text: 'X' });
    }),
    test('a 500 without saved is failed, with the server text', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(500, { error: 'pins write failed' })), { kind: 'failed', text: 'pins write failed' });
    }),
    test('a 500 whose saved is anything but true is failed', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(500, { error: 'X', saved: 'true' })), { kind: 'failed', text: 'X' });
      assert.deepStrictEqual(pinWriteOutcome(reply(500, { error: 'X', saved: false })), { kind: 'failed', text: 'X' });
    }),
    test('a 500 with no body is failed with the status text', () => {
      assert.deepStrictEqual(pinWriteOutcome(reply(500, undefined)), { kind: 'failed', text: 'Failed (500).' });
    }),
    test('a 200 carrying saved: true beside the payload is still fresh, not saved', () => {
      const body = { ...PAYLOAD, saved: true };
      assert.deepStrictEqual(pinWriteOutcome(reply(200, body)), { kind: 'fresh', pins: body });
    })
  ];
  const ok = results.filter(Boolean).length;
  console.log(`\npin write outcome: ${ok}/${results.length} passed`);
  return results.length - ok;
}
