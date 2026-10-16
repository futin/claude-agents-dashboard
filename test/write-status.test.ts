/** `writeStatusLine`: the Settings sentence that tells this browser how it reaches the dashboard and what it may write. */

import assert from 'node:assert';

import { writeStatusLine } from '../client/src/lib/writeStatus.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== write status line (client/src/lib/writeStatus.ts) ===\n');
  const results = [
    test('this machine, open', () => {
      assert.equal(writeStatusLine('local', 'open', true), 'This device reaches the dashboard from this machine — writes need no token.');
    }),
    test('tailnet, open', () => {
      assert.equal(writeStatusLine('tailnet', 'open', true), 'This device reaches the dashboard via tailnet — writes need no token.');
    }),
    test('tailnet with the switch off names the switch', () => {
      assert.equal(writeStatusLine('tailnet', 'token', false),
        'This device reaches the dashboard via tailnet, and tailnet trust is off — writes need the answer token.');
      assert.equal(writeStatusLine('tailnet', 'none', false),
        'This device reaches the dashboard via tailnet, and tailnet trust is off — read-only: no answer token is set.');
    }),
    test('LAN, token and read-only', () => {
      assert.equal(writeStatusLine('lan', 'token', true), 'This device reaches the dashboard via LAN — writes need the answer token.');
      assert.equal(writeStatusLine('lan', 'none', true), 'This device reaches the dashboard via LAN — read-only: no answer token is set.');
    }),
    test('an unrecognised address', () => {
      assert.equal(writeStatusLine('unknown', 'token', true), 'This device reaches the dashboard from an unrecognised address — writes need the answer token.');
    }),
    test('no line before health answers or from an older server', () => {
      assert.equal(writeStatusLine('lan', undefined, true), null);
      assert.equal(writeStatusLine(undefined, 'open', true), null);
    }),
    test('settings not loaded yet: no switch note', () => {
      assert.equal(writeStatusLine('tailnet', 'token', undefined), 'This device reaches the dashboard via tailnet — writes need the answer token.');
    })
  ];
  const ok = results.filter(Boolean).length;
  console.log(`\n  ${ok}/${results.length} passed`);
  return results.length - ok;
}
