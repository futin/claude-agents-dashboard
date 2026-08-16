import assert from 'node:assert';

import { readSessionParam } from '../client/src/lib/deepLink.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== deepLink.ts ===\n');
  let p = 0, f = 0;

  if (test('reads a session id', () => {
    assert.strictEqual(
      readSessionParam('?session=abc12345-0000-0000-0000-000000000000'),
      'abc12345-0000-0000-0000-000000000000'
    );
  })) p++; else f++;

  if (test('reads it alongside other params', () => {
    assert.strictEqual(readSessionParam('?x=1&session=abc12345&y=2'), 'abc12345');
  })) p++; else f++;

  if (test('no param yields null', () => {
    assert.strictEqual(readSessionParam(''), null);
    assert.strictEqual(readSessionParam('?other=1'), null);
    assert.strictEqual(readSessionParam('?session='), null);
  })) p++; else f++;

  if (test('rejects anything not shaped like a session id', () => {
    // The value reaches a find() over the poll's list, never a path — but a
    // shape check keeps junk out of the drawer key and out of any future use.
    assert.strictEqual(readSessionParam('?session=../../etc/passwd'), null);
    assert.strictEqual(readSessionParam('?session=<script>'), null);
    assert.strictEqual(readSessionParam('?session=' + 'a'.repeat(200)), null);
  })) p++; else f++;

  if (test('survives a malformed query string', () => {
    assert.strictEqual(readSessionParam('?%'), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
