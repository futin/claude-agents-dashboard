/** The phone top bar's hide-on-scroll rules (`client/src/lib/hideOnScroll.ts`), out of `useHideOnScroll` so a flipped comparison fails here. */
import assert from 'node:assert';

import { hideStep, scrollFloor } from '../../client/src/lib/hideOnScroll.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== hideOnScroll.ts ===\n');
  let p = 0, f = 0;

  if (test('inside the 3px dead band nothing changes; a rubber-band past the top clamps to 0', () => {
    assert.strictEqual(hideStep(0, 2, 0), null);
    assert.strictEqual(hideStep(0, -40, 0), null);
  })) p++; else f++;

  if (test('3px is past the dead band: down hides, up shows', () => {
    assert.deepStrictEqual(hideStep(100, 103, 0), { last: 103, hidden: true });
    assert.deepStrictEqual(hideStep(100, 97, 0), { last: 97, hidden: false });
  })) p++; else f++;

  if (test('down inside the top inset does not hide; past it does; at the floor is not past it', () => {
    assert.deepStrictEqual(hideStep(10, 20, 24), { last: 20, hidden: false });
    assert.deepStrictEqual(hideStep(20, 30, 24), { last: 30, hidden: true });
    assert.deepStrictEqual(hideStep(20, 24, 24), { last: 24, hidden: false });
  })) p++; else f++;

  if (test('release from a rubber-band reads as up', () => {
    assert.deepStrictEqual(hideStep(50, -10, 0), { last: 0, hidden: false });
  })) p++; else f++;

  if (test('scrollFloor: the inset times the font scale, unreadable values as 0 and 1', () => {
    assert.strictEqual(scrollFloor('24px', '1.25'), 30);
    assert.strictEqual(scrollFloor('', ''), 0);
    assert.strictEqual(scrollFloor('24px', ''), 24);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
