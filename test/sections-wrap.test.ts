import assert from 'node:assert';

import { wrapClass } from '../client/src/lib/sections.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== sections.ts wrapClass ===\n');
  let p = 0, f = 0;

  // #194: on the pinned shell a tall Projects page overflowed `.main`, and every button past the fold stopped taking clicks.
  if (test('management opts out of the pinned shell', () => {
    assert.strictEqual(wrapClass('management'), 'wrap wide wide-mgmt');
  })) p++; else f++;

  if (test('configs opts out of the pinned shell', () => {
    assert.strictEqual(wrapClass('configs'), 'wrap wide wide-mgmt');
  })) p++; else f++;

  // The mirror case: Analytics is the one section whose tab is its own scroller, so it keeps the pinned shell.
  if (test('analytics keeps the pinned shell', () => {
    assert.strictEqual(wrapClass('analytics'), 'wrap wide');
  })) p++; else f++;

  if (test('settings, sessions and usage get width only', () => {
    for (const s of ['settings', 'sessions', 'usage'] as const) assert.strictEqual(wrapClass(s), 'wrap broad', s);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
