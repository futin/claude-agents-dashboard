import assert from 'node:assert';

import { parseSpawnResponse, spawnOutcome } from '../client/src/lib/spawnResponse.js';
import { READ_ONLY_TEXT } from '../client/src/lib/writeRefusal.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const UNREADABLE = 'The launch reply could not be read — check Sessions before trying again.';

const reply = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, refusal: null, body });

export function run(): number {
  console.log('\n=== client/lib/spawnResponse.ts ===\n');
  let p = 0, f = 0;

  if (test('a desktop 200 is a success with or without a session id — never "Launch failed"', () => {
    assert.deepStrictEqual(parseSpawnResponse({ surface: 'desktop' }), { surface: 'desktop' });
    assert.deepStrictEqual(parseSpawnResponse({ surface: 'desktop', sessionId: '' }), { surface: 'desktop' }, 'an empty id is no id');
    assert.deepStrictEqual(parseSpawnResponse({ surface: 'desktop', sessionId: 's3' }), { surface: 'desktop', sessionId: 's3' }, 'a fresh launch keeps its id');
  })) p++; else f++;

  if (test('a dashboard 200 carries its session id', () => {
    assert.deepStrictEqual(parseSpawnResponse({ surface: 'dashboard', sessionId: 's1' }), { surface: 'dashboard', sessionId: 's1' });
  })) p++; else f++;

  if (test('an older server answering a bare {sessionId} reads as a dashboard launch', () => {
    assert.deepStrictEqual(parseSpawnResponse({ sessionId: 's2' }), { surface: 'dashboard', sessionId: 's2' });
  })) p++; else f++;

  if (test('a dashboard answer without a session id, an unknown surface, or no body at all is null', () => {
    assert.strictEqual(parseSpawnResponse({ surface: 'dashboard' }), null);
    assert.strictEqual(parseSpawnResponse({ surface: 'x' }), null);
    assert.strictEqual(parseSpawnResponse(null), null);
  })) p++; else f++;

  if (test('spawnOutcome: no answer shows the network text and leaves both flags as they are', () => {
    const outcome = spawnOutcome({ status: 0, ok: false, refusal: null, body: undefined });
    assert.strictEqual(outcome.response, null);
    assert.strictEqual(outcome.error, 'Could not reach the server.');
    assert.strictEqual('needsToken' in outcome, false, 'a second failure to reach the server must not clear a token prompt on screen');
    assert.strictEqual('readOnly' in outcome, false);
  })) p++; else f++;

  if (test('spawnOutcome: a token refusal asks for the token and shows no text', () => {
    assert.deepStrictEqual(spawnOutcome({ status: 403, ok: false, refusal: 'token', body: { error: 'bad token' } }), {
      response: null, error: null, needsToken: true, readOnly: false
    });
  })) p++; else f++;

  if (test('spawnOutcome: a read-only refusal shows READ_ONLY_TEXT and no token prompt', () => {
    assert.deepStrictEqual(spawnOutcome({ status: 403, ok: false, refusal: 'read-only', body: { error: 'read-only from this network' } }), {
      response: null, error: READ_ONLY_TEXT, needsToken: false, readOnly: true
    });
  })) p++; else f++;

  if (test('spawnOutcome: a 200 that parses is the response, and clears both flags', () => {
    assert.deepStrictEqual(spawnOutcome(reply(200, { surface: 'dashboard', sessionId: 's1' })), {
      response: { surface: 'dashboard', sessionId: 's1' }, error: null, needsToken: false, readOnly: false
    });
  })) p++; else f++;

  if (test('spawnOutcome: a desktop 200 with no id is a success', () => {
    assert.deepStrictEqual(spawnOutcome(reply(200, { surface: 'desktop' })), {
      response: { surface: 'desktop' }, error: null, needsToken: false, readOnly: false
    });
  })) p++; else f++;

  if (test('spawnOutcome: a 200 that does not parse says so, and never says failed', () => {
    const unreadable = { response: null, error: UNREADABLE, needsToken: false, readOnly: false };
    assert.deepStrictEqual(spawnOutcome(reply(200, { surface: 'x' })), unreadable);
    assert.deepStrictEqual(spawnOutcome(reply(200, undefined)), unreadable, 'a 200 that was not JSON');
    assert.strictEqual(/failed/i.test(UNREADABLE), false, 'a 200 means the launch ran: told "failed", a person retries and starts a second session');
  })) p++; else f++;

  if (test('spawnOutcome: any other non-2xx shows the server\'s text', () => {
    assert.deepStrictEqual(spawnOutcome(reply(400, { error: 'unknown project' })), {
      response: null, error: 'unknown project', needsToken: false, readOnly: false
    });
  })) p++; else f++;

  if (test('spawnOutcome: a non-2xx without an error text names the status', () => {
    assert.deepStrictEqual(spawnOutcome(reply(500, undefined)), {
      response: null, error: 'Launch failed (500).', needsToken: false, readOnly: false
    });
  })) p++; else f++;

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
