import assert from 'node:assert';

import { collapsedSummary, fmtLeft } from '../client/src/lib/panelCollapse.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== panelCollapse.ts ===\n');
  let p = 0, f = 0;

  if (test('one question reads singular', () => {
    assert.strictEqual(collapsedSummary({ kind: 'question', questions: 1 }), '1 question · tap to answer');
  })) p++; else f++;

  if (test('several questions read plural, with the count', () => {
    assert.strictEqual(collapsedSummary({ kind: 'question', questions: 3 }), '3 questions · tap to answer');
  })) p++; else f++;

  if (test('a count of zero clamps to the singular form', () => {
    // The store never holds an empty question set, but a stub reading
    // "0 questions" would be worse than one that under-promises.
    assert.strictEqual(collapsedSummary({ kind: 'question', questions: 0 }), '1 question · tap to answer');
  })) p++; else f++;

  if (test('a plan says how it can be acted on', () => {
    assert.strictEqual(collapsedSummary({ kind: 'plan' }), 'plan waiting · revise from here');
  })) p++; else f++;

  if (test('a reply window carries its countdown', () => {
    assert.strictEqual(collapsedSummary({ kind: 'message', secsLeft: 42 }), 'closes in 42s');
  })) p++; else f++;

  if (test('a long window counts down in minutes', () => {
    assert.strictEqual(collapsedSummary({ kind: 'message', secsLeft: 180 }), 'closes in 3m');
  })) p++; else f++;

  if (test('fmtLeft switches to minutes at two minutes', () => {
    assert.strictEqual(fmtLeft(119), '119s');
    assert.strictEqual(fmtLeft(120), '2m');
  })) p++; else f++;

  if (test('fmtLeft floors at zero', () => {
    assert.strictEqual(fmtLeft(0), '0s');
    assert.strictEqual(fmtLeft(-5), '0s');
  })) p++; else f++;

  console.log(`\npanelCollapse: ${p} passed, ${f} failed`);
  return f;
}
