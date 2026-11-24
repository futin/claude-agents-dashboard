/** `parseNumberDraft` (SettingsRow.tsx): a NumberField commits only a number the user actually typed — a blank never becomes 0 (#519). */
import assert from 'node:assert';

import { parseNumberDraft } from '../../client/src/components/settings/SettingsRow.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== parseNumberDraft (SettingsRow.tsx) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('a blank or whitespace box is no value', () => {
    assert.strictEqual(parseNumberDraft(''), null);
    assert.strictEqual(parseNumberDraft('   '), null);
  });
  t('unparseable text is no value', () => {
    assert.strictEqual(parseNumberDraft('abc'), null);
    assert.strictEqual(parseNumberDraft('1e'), null);
  });
  t('a non-finite number is no value', () => {
    assert.strictEqual(parseNumberDraft('Infinity'), null);
  });
  t('a typed 0 is still a value (it switches the away check off on purpose)', () => {
    assert.strictEqual(parseNumberDraft('0'), 0);
  });
  t('ordinary numbers parse, surrounding spaces and decimals included', () => {
    assert.strictEqual(parseNumberDraft('60'), 60);
    assert.strictEqual(parseNumberDraft(' 30 '), 30);
    assert.strictEqual(parseNumberDraft('2.5'), 2.5);
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
