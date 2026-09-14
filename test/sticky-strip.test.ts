import assert from 'node:assert';

import { nextStuck } from '../client/src/lib/stickyStrip.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** `--mnav-h`: the phone bar's height, and so where the strip pins. */
const PIN = 60;

export function run(): number {
  console.log('\n=== stickyStrip.ts ===\n');
  let p = 0, f = 0;

  if (test('at the top of the page, nothing is pinned', () => {
    assert.strictEqual(nextStuck(400, PIN, false), false);
  })) p++; else f++;

  if (test('pins the moment the sentinel reaches the bar', () => {
    assert.strictEqual(nextStuck(PIN, PIN, false), true);
  })) p++; else f++;

  if (test('stays pinned above the bar', () => {
    assert.strictEqual(nextStuck(0, PIN, true), true);
    assert.strictEqual(nextStuck(-200, PIN, true), true);
  })) p++; else f++;

  // The pin is a fixed `top`; the bar's auto-hide is a transform on top of it.
  // Nothing about the bar may move this threshold — when it did, the strip
  // waited a further `--body-pad` of scroll before going full-bleed.
  if (test('the bar hiding does not move the threshold', () => {
    assert.strictEqual(nextStuck(PIN - 20, PIN, false), true);
    assert.strictEqual(nextStuck(PIN + 20, PIN, false), false);
  })) p++; else f++;

  if (test('a fractional layout does not leave it one pixel short', () => {
    assert.strictEqual(nextStuck(PIN + 0.4, PIN, false), true);
  })) p++; else f++;

  if (test('inside the band it keeps the class it had', () => {
    // Sub-pixel layout put consecutive ticks either side of a single
    // threshold, and the strip flipped shape on a motionless page.
    assert.strictEqual(nextStuck(PIN + 1, PIN, true), true);
    assert.strictEqual(nextStuck(PIN + 1, PIN, false), false);
  })) p++; else f++;

  if (test('releases past the band, whichever side it came from', () => {
    assert.strictEqual(nextStuck(PIN + 2.5, PIN, true), false);
    assert.strictEqual(nextStuck(PIN + 2.5, PIN, false), false);
  })) p++; else f++;

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
