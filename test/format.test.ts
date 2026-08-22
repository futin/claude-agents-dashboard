import assert from 'node:assert';

import { fmtBytes } from '../client/src/lib/format.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== format.ts ===\n');
  let p = 0, f = 0;

  if (test('fmtBytes: bytes under 1 KB stay whole', () => {
    assert.strictEqual(fmtBytes(0), '0 B');
    assert.strictEqual(fmtBytes(1), '1 B');
    assert.strictEqual(fmtBytes(1023), '1023 B');
  })) p++; else f++;

  if (test('fmtBytes: KB and MB get one decimal, rounded', () => {
    assert.strictEqual(fmtBytes(1024), '1.0 KB');
    assert.strictEqual(fmtBytes(15456), '15.1 KB');
    assert.strictEqual(fmtBytes(1024 * 1024), '1.0 MB');
    assert.strictEqual(fmtBytes(2_600_000), '2.5 MB');
  })) p++; else f++;

  console.log(`\nformat: ${p} passed, ${f} failed`);
  return f;
}
