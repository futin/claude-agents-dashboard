import assert from 'node:assert';

import { usableProfile, usableRates } from '../../client/src/lib/usageBody.js';
import { blankUsageProfile, emptyRates } from '../../server/lib/usage-shape.js';
import type { UsageProfileResponse, UsageRatesResponse } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const NOW = Date.parse('2026-11-28T10:00:00Z');

export function run(): number {
  console.log('\n=== usage bodies: an error-shaped 200 reads as "could not be read" (client logic) ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('usableRates: a normal body is kept', () => {
    const body: UsageRatesResponse = { ...emptyRates(NOW, true), models: [] };
    assert.strictEqual(usableRates(body), body);
  });

  t('usableRates: the fail-open error body is refused', () => {
    assert.strictEqual(usableRates(emptyRates(NOW, false, true)), null);
  });

  t('usableRates: mirror — recording off is not an error, so its body is kept', () => {
    const body = emptyRates(NOW, false);
    assert.strictEqual(usableRates(body), body);
  });

  t('usableRates: a body with no models array, or no body at all, is refused', () => {
    assert.strictEqual(usableRates({} as UsageRatesResponse), null);
    assert.strictEqual(usableRates(null), null);
  });

  t('usableProfile: a 168-cell body is kept', () => {
    const body = blankUsageProfile(0);
    body.recording = true;
    assert.strictEqual(usableProfile(body), body);
  });

  t('usableProfile: the fail-open error body is refused', () => {
    assert.strictEqual(usableProfile(blankUsageProfile(0, true)), null);
  });

  t('usableProfile: mirror — the recording-off blank body is kept', () => {
    const body = blankUsageProfile(0);
    assert.strictEqual(usableProfile(body), body);
  });

  t('usableProfile: a short grid is refused', () => {
    const body: UsageProfileResponse = { ...blankUsageProfile(0), cells: blankUsageProfile(0).cells.slice(1) };
    assert.strictEqual(body.cells.length, 167);
    assert.strictEqual(usableProfile(body), null);
  });

  const failedCount = results.filter(r => !r).length;
  console.log('\n  ' + (results.length - failedCount) + ' passed, ' + failedCount + ' failed');
  return failedCount;
}
