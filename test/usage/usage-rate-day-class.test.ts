/**
 * `client/src/lib/usageRatesFormat.ts` `dayClass`: the class a day cell on the rates strip wears — its deviation colour step when rated, otherwise its
 * state, which the stylesheet draws as texture. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import type { ModelDayRate } from '../../shared/types.js';
import { DRIFT_BAND_PCT, dayClass } from '../../client/src/lib/usageRatesFormat.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function day(over: Partial<ModelDayRate>): ModelDayRate {
  return { date: '2026-11-20', weightedPerPct: 1000, rawPerPct: 2000, intervals: 10, utilSum: 6, deviationPct: 0, state: 'rated', ...over };
}

export function run(): number {
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };

  check(test('dayClass: a rated day wears its deviation step', () => {
    assert.strictEqual(dayClass(day({ deviationPct: 0 })), 'within');
    assert.strictEqual(dayClass(day({ deviationPct: DRIFT_BAND_PCT + 1 })), 'above');
    assert.strictEqual(dayClass(day({ deviationPct: -(2 * DRIFT_BAND_PCT + 1) })), 'far-below');
  }));
  check(test('dayClass: a rated day with no baseline is unjudged, so it wears no class', () => {
    assert.strictEqual(dayClass(day({ deviationPct: null })), '');
  }));
  check(test("dayClass: a 'none' day is the bare cell", () => {
    assert.strictEqual(dayClass(day({ state: 'none', weightedPerPct: null, rawPerPct: null, deviationPct: null })), '');
  }));
  check(test('dayClass: any other state wears its own name, which the stylesheet draws as a texture', () => {
    assert.strictEqual(dayClass(day({ state: 'thin', thinReason: 'floor' })), 'thin');
    assert.strictEqual(dayClass(day({ state: 'pre-ledger', weightedPerPct: null, rawPerPct: null })), 'pre-ledger');
  }));

  console.log(`\nusage-rate-day-class: ${pass}/${total} passed`);
  return total - pass;
}
