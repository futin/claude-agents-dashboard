/**
 * Pins the keying of the visual suite's accepted daylight contrast violations (`test/visual/contrast-known.ts`). The key leaves the selector out on purpose:
 * the CSS Modules migration the suite serves renames classes, and a selector key would report every known violation as new on each step.
 */
import assert from 'node:assert';

import { contrastKey, diffContrast, type ContrastEntry } from './visual/contrast-known.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const entry = (over: Partial<ContrastEntry> = {}): ContrastEntry => ({
  view: 'usage', text: 'resets Sat 02:00', fg: '#a0a0a0', bg: '#ffffff', ratio: 2.61, required: 4.5, selector: '.kpi > .sub', ...over
});

export function run(): number {
  console.log('\n=== visual contrast-known keying ===\n');
  let p = 0, f = 0;

  if (test('the key collapses whitespace and lowercases both colours', () => {
    assert.strictEqual(
      contrastKey(entry({ view: 'usage', text: '  3 m\n ago ', fg: '#9A9A9A', bg: '#F4F4F4' })),
      'usage|3 m ago|#9a9a9a|#f4f4f4'
    );
  })) p++; else f++;

  if (test('the selector is not part of the key', () => {
    assert.strictEqual(contrastKey(entry({ selector: '.a' })), contrastKey(entry({ selector: '._b_x1y2' })));
  })) p++; else f++;

  const a = entry();
  const b = entry({ text: 'fetched 4m ago' });
  const c = entry({ view: 'analytics' });

  if (test('a new violation is added', () => {
    assert.deepStrictEqual(diffContrast([], [a]), { added: [a], fixed: [] });
  })) p++; else f++;

  if (test('a known violation that no longer occurs is fixed', () => {
    assert.deepStrictEqual(diffContrast([a], []), { added: [], fixed: [a] });
  })) p++; else f++;

  if (test('a renamed selector with a moved ratio is neither added nor fixed', () => {
    const renamed = entry({ selector: '._kpiSub_3f9a', ratio: 2.6 });
    assert.deepStrictEqual(diffContrast([a], [renamed]), { added: [], fixed: [] });
  })) p++; else f++;

  if (test('duplicate found keys collapse to the first occurrence', () => {
    assert.strictEqual(diffContrast([], [a, entry({ selector: '.other' })]).added.length, 1);
  })) p++; else f++;

  if (test('added and fixed are computed together', () => {
    assert.deepStrictEqual(diffContrast([a, b], [b, c]), { added: [c], fixed: [a] });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed\n`);
  return f;
}
