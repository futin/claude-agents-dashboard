import assert from 'node:assert';

import { modelLabel } from '../client/src/lib/modelLabel.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== modelLabel.ts ===\n');
  let p = 0, f = 0;

  if (test('family-first ids read as Family major.minor', () => {
    assert.strictEqual(modelLabel('claude-opus-5-5'), 'Opus 5.5');
    assert.strictEqual(modelLabel('claude-haiku-4-5'), 'Haiku 4.5');
    assert.strictEqual(modelLabel('claude-opus-5'), 'Opus 5');
  })) p++; else f++;

  if (test('the date stamp is dropped', () => {
    assert.strictEqual(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
    assert.strictEqual(modelLabel('claude-opus-4-20250514'), 'Opus 4');
    assert.strictEqual(modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  })) p++; else f++;

  if (test('a [1m] suffix is dropped', () => {
    assert.strictEqual(modelLabel('claude-fable-5-1[1m]'), 'Fable 5.1');
  })) p++; else f++;

  if (test('Claude 3.x version-first ids', () => {
    assert.strictEqual(modelLabel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
    assert.strictEqual(modelLabel('claude-3-haiku-20240307'), 'Haiku 3');
  })) p++; else f++;

  if (test('anything else comes back unchanged', () => {
    for (const id of ['', '<synthetic>', 'opus', 'gpt-4o', 'claude-opus', 'us.anthropic.claude-opus-4-v1:0']) {
      assert.strictEqual(modelLabel(id), id);
    }
  })) p++; else f++;

  console.log(`\nmodel-label: ${p} passed, ${f} failed`);
  return f;
}
