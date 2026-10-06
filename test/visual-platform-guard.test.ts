/** Pins the one line `pnpm test:visual` prints when run off macOS (`test/visual/platform-guard.ts`). */
import assert from 'node:assert';

import { platformRefusal } from './visual/platform-guard.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== visual platform guard ===\n');
  let p = 0, f = 0;

  if (test('darwin is allowed', () => {
    assert.strictEqual(platformRefusal('darwin'), null);
  })) p++; else f++;

  if (test('linux is refused with the exact line', () => {
    assert.strictEqual(
      platformRefusal('linux'),
      'visual baselines exist for macOS only (platform: linux); run pnpm test:visual on a Mac'
    );
  })) p++; else f++;

  if (test('win32 is refused with the exact line', () => {
    assert.strictEqual(
      platformRefusal('win32'),
      'visual baselines exist for macOS only (platform: win32); run pnpm test:visual on a Mac'
    );
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed\n`);
  return f;
}
