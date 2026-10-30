import assert from 'node:assert';

import { parseSpawnResponse } from '../client/src/lib/spawnResponse.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== client/lib/spawnResponse.ts ===\n');
  let p = 0, f = 0;

  if (test('a desktop 200 is a success with no session id — never "Launch failed"', () => {
    assert.deepStrictEqual(parseSpawnResponse({ surface: 'desktop' }), { surface: 'desktop' });
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

  console.log(`\n  ${p}/${p + f} passed`);
  return f;
}
