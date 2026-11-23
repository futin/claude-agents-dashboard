/**
 * `client/src/lib/usageProfile.ts`' cell and figure helpers for the Forecast sheet: the five-step ramp of the profile grid and the walk table's Spent and
 * Left figures. Pure, so no React and no DOM.
 */
import assert from 'node:assert';

import { fmtLeft, fmtPts, profileStep } from '../../client/src/lib/usageProfile.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  let pass = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) pass++; };

  check(test('profileStep: a weight of 0.02 or less is measured idle, the bare cell', () => {
    assert.deepStrictEqual([0, 0.01, 0.02].map(profileStep), ['', '', '']);
  }));
  check(test('profileStep: q1 starts just above 0.02 and runs to 0.2 inclusive', () => {
    assert.deepStrictEqual([0.021, 0.2].map(profileStep), ['q1', 'q1']);
  }));
  check(test('profileStep: each next step starts just above the 0.2 boundary before it', () => {
    assert.deepStrictEqual([0.201, 0.4, 0.401, 0.6, 0.601, 0.8, 0.801, 1].map(profileStep), ['q2', 'q2', 'q3', 'q3', 'q4', 'q4', 'q5', 'q5']);
  }));

  check(test('fmtPts: spend is a subtraction with a U+2212 minus, one decimal', () => {
    assert.strictEqual(fmtPts(3.14), '−3.1');
  }));
  check(test('fmtPts: anything under 0.05 either way shows as zero, with no minus', () => {
    assert.deepStrictEqual([0, 0.049, -0.049].map(fmtPts), ['0.0', '0.0', '0.0']);
  }));
  check(test('fmtPts: 0.05 is the first spend that shows', () => assert.strictEqual(fmtPts(0.05), '−0.1')));

  check(test('fmtLeft: headroom rounds to a whole point', () => {
    assert.deepStrictEqual([0, 12.4, 12.5].map(fmtLeft), ['0', '12', '13']);
  }));
  check(test('fmtLeft: past empty is negative, set in the U+2212 minus', () => {
    assert.deepStrictEqual([-7.6, -0.4].map(fmtLeft), ['−8', '0']);
  }));

  console.log(`\nusage-profile-cells: ${pass}/${total} passed`);
  return total - pass;
}
