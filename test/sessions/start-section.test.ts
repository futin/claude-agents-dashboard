/**
 * `startSection` (client/src/lib/deepLink.ts): the section the page opens on — deep links, then the landing setting, then the fallback.
 */
import assert from 'node:assert';

import { startSection } from '../../client/src/lib/deepLink.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const NONE = { session: false, view: null, stored: 'sessions', landing: 'last' } as const;

export function run(): number {
  console.log('\n=== startSection (client/src/lib/deepLink.ts) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(test('a ?session deep link wins over everything, ?view included', () => {
    assert.strictEqual(startSection({ session: true, view: 'git', stored: 'usage', landing: 'settings' }), 'sessions');
  }));
  tally(test('then ?view: git lands on management, routines and usage on themselves, over the landing setting', () => {
    assert.strictEqual(startSection({ ...NONE, view: 'git', landing: 'settings' }), 'management');
    assert.strictEqual(startSection({ ...NONE, view: 'routines', landing: 'settings' }), 'routines');
    assert.strictEqual(startSection({ ...NONE, view: 'usage', stored: 'configs' }), 'usage');
  }));
  tally(test("landing 'last' opens the stored section; a stored legacy 'schedules' maps to 'routines'", () => {
    assert.strictEqual(startSection({ ...NONE, stored: 'analytics' }), 'analytics');
    assert.strictEqual(startSection({ ...NONE, stored: 'schedules' }), 'routines');
  }));
  tally(test('a pinned landing beats the stored section', () => {
    assert.strictEqual(startSection({ ...NONE, stored: 'analytics', landing: 'usage' }), 'usage');
    assert.strictEqual(startSection({ ...NONE, stored: 'schedules', landing: 'configs' }), 'configs');
  }));
  tally(test('an unknown value — a removed section stored or pinned — falls back to sessions', () => {
    assert.strictEqual(startSection({ ...NONE, stored: 'guides' }), 'sessions');
    assert.strictEqual(startSection({ ...NONE, landing: 'guides' }), 'sessions');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
