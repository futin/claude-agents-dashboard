/** `refusalKind`: tell a read-only network apart from a token refusal, off the 403's status and body alone. */

import assert from 'node:assert';

import { READ_ONLY_TEXT, refusalKind } from '../client/src/lib/writeRefusal.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== write refusal kind (client/src/lib/writeRefusal.ts) ===\n');
  const results = [
    test('a 403 with the read-only body is read-only', () => {
      assert.equal(refusalKind(403, { error: 'read-only from this network' }), 'read-only');
    }),
    test('a 403 with bad token is a token refusal', () => {
      assert.equal(refusalKind(403, { error: 'bad token' }), 'token');
    }),
    test('a 403 with no readable body is a token refusal, as before this change', () => {
      assert.equal(refusalKind(403, undefined), 'token');
    }),
    test('a bare string body is not the read-only shape', () => {
      assert.equal(refusalKind(403, 'read-only from this network'), 'token');
    }),
    test('the match is exact, case included', () => {
      assert.equal(refusalKind(403, { error: 'Read-only from this network' }), 'token');
    }),
    test('any status but 403 is not a refusal', () => {
      assert.equal(refusalKind(404, { error: 'read-only from this network' }), null);
      assert.equal(refusalKind(200, {}), null);
    }),
    test('the read-only sentence is the spec copy', () => {
      assert.equal(READ_ONLY_TEXT, 'Read-only from this network: open the dashboard through Tailscale, or set ANSWER_TOKEN.');
    })
  ];
  const ok = results.filter(Boolean).length;
  console.log(`\n  ${ok}/${results.length} passed`);
  return results.length - ok;
}
