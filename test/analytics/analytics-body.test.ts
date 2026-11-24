/** `analyticsBodyKind` / `analyticsStaleReload` (analyticsFilterSort.ts): a failed ↻ never hides reports already loaded (#519). */
import assert from 'node:assert';

import { settleAnalytics } from '../../client/src/hooks/useAnalytics.js';
import { analyticsBodyKind, analyticsStaleReload } from '../../client/src/lib/analyticsFilterSort.js';
import type { AnalyticsReport, AnalyticsResponse } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== analyticsBodyKind ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('first load in flight shows loading', () => {
    assert.strictEqual(analyticsBodyKind({ loading: true, error: false, total: 0, shown: 0 }), 'loading');
  });
  t('a failure with nothing loaded shows the error', () => {
    assert.strictEqual(analyticsBodyKind({ loading: false, error: true, total: 0, shown: 0 }), 'error');
    assert.strictEqual(analyticsStaleReload({ error: true, total: 0 }), false);
  });
  t('a failed reload over loaded reports keeps the list and flags it stale', () => {
    assert.strictEqual(analyticsBodyKind({ loading: false, error: true, total: 3, shown: 3 }), 'list');
    assert.strictEqual(analyticsStaleReload({ error: true, total: 3 }), true);
  });
  t('a failed reload whose filters hide every report still says no-match', () => {
    assert.strictEqual(analyticsBodyKind({ loading: false, error: true, total: 3, shown: 0 }), 'no-match');
  });
  t('a reload in flight never blanks a loaded list', () => {
    assert.strictEqual(analyticsBodyKind({ loading: true, error: false, total: 3, shown: 3 }), 'list');
    assert.strictEqual(analyticsStaleReload({ error: false, total: 3 }), false);
  });
  t('a successful empty log shows the empty state', () => {
    assert.strictEqual(analyticsBodyKind({ loading: false, error: false, total: 0, shown: 0 }), 'empty');
  });

  // The server answers a failed listing with 200 `{ reports: [], error: true }`, not a network error — that answer must not replace the loaded list either.
  const loaded: AnalyticsResponse = { generatedAt: 't1', keep: 5, reports: [{ sessionId: 'a' } as unknown as AnalyticsReport] };
  const failed: AnalyticsResponse = { generatedAt: 't2', keep: 5, reports: [], error: true };
  t('a server-reported failure keeps the reports already loaded', () => {
    assert.deepStrictEqual(settleAnalytics(loaded, failed), { data: loaded, loading: false, error: true });
  });
  t('a server-reported failure on first load keeps its own (empty) answer', () => {
    assert.deepStrictEqual(settleAnalytics(null, failed), { data: failed, loading: false, error: true });
  });
  t('a successful answer replaces whatever was loaded', () => {
    const next: AnalyticsResponse = { generatedAt: 't3', keep: 5, reports: [] };
    assert.deepStrictEqual(settleAnalytics(loaded, next), { data: next, loading: false, error: false });
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
