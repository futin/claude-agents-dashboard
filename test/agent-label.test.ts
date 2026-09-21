import assert from 'node:assert';

import { DEFAULT_SUBAGENT_TYPE, agentTypeLabel, agentLineName } from '../client/src/lib/agentLabel.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== agentLabel.ts ===\n');
  let p = 0, f = 0;

  if (test('the catch-all type gets no label — it is a constant column, not signal', () => {
    assert.strictEqual(agentTypeLabel('general-purpose'), null);
  })) p++; else f++;

  if (test('the default constant is the documented catch-all name', () => {
    assert.strictEqual(DEFAULT_SUBAGENT_TYPE, 'general-purpose');
  })) p++; else f++;

  if (test('a non-default type keeps its label', () => {
    assert.strictEqual(agentTypeLabel('Explore'), 'Explore');
    assert.strictEqual(agentTypeLabel('claude-code-guide'), 'claude-code-guide');
  })) p++; else f++;

  if (test('an omitted type shows nothing, same as the default', () => {
    assert.strictEqual(agentTypeLabel(''), null);
    assert.strictEqual(agentTypeLabel(undefined), null);
  })) p++; else f++;

  if (test('whitespace-only and padded types are trimmed before the check', () => {
    assert.strictEqual(agentTypeLabel('   '), null);
    assert.strictEqual(agentTypeLabel(' general-purpose '), null);
    assert.strictEqual(agentTypeLabel(' Explore '), 'Explore');
  })) p++; else f++;

  if (test('the catch-all name is matched case-insensitively', () => {
    assert.strictEqual(agentTypeLabel('General-Purpose'), null);
  })) p++; else f++;

  // agentLineName: the Analytics row has no separate description column, so a
  // hidden label would leave the row nameless. It falls back instead.
  if (test('an informative type names the Analytics line', () => {
    assert.strictEqual(agentLineName('Explore', 'sweep the client'), 'Explore');
  })) p++; else f++;

  if (test('a catch-all type falls back to the description', () => {
    assert.strictEqual(agentLineName('general-purpose', 'Implement Task 2'), 'Implement Task 2');
  })) p++; else f++;

  if (test('an omitted type falls back to the description', () => {
    assert.strictEqual(agentLineName('', 'Implement Task 2'), 'Implement Task 2');
  })) p++; else f++;

  if (test('with neither, the line keeps the generic marker', () => {
    assert.strictEqual(agentLineName('general-purpose', ''), 'agent');
    assert.strictEqual(agentLineName('', undefined), 'agent');
    assert.strictEqual(agentLineName('', '   '), 'agent');
  })) p++; else f++;

  if (test('a padded description is trimmed', () => {
    assert.strictEqual(agentLineName('general-purpose', '  Implement Task 2  '), 'Implement Task 2');
  })) p++; else f++;

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
