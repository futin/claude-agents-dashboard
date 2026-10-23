/**
 * notifyRows.ts — the Settings page's push-event rows: their copy, and when a row is disabled and what its hint says instead.
 */
import assert from 'node:assert';

import { NOTIFY_EVENT_ROWS, notifyRowState } from '../client/src/lib/notifyRows.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const RECORDING = 'Turn on Record usage history under Usage forecast to use this.';
const HIDDEN = 'Usage is hidden (SHOW_USAGE=false) on this server.';
const ON = { notifyAvailable: true, usageAvailable: true, recordUsageHistory: true };

export function run(): number {
  let p = 0, f = 0;
  console.log('\n=== notifyRows.ts ===\n');

  if (test('the two usage rows follow Routine failed, copy verbatim', () => {
    const keys = NOTIFY_EVENT_ROWS.map(r => r.key);
    assert.deepStrictEqual(keys.slice(keys.indexOf('routine-failed')), ['routine-failed', 'usage-limit', 'usage-reset']);
    const [limit, reset] = NOTIFY_EVENT_ROWS.slice(-2);
    assert.deepStrictEqual({ name: limit.name, hint: limit.hint }, {
      name: 'Usage limit reached',
      hint: 'Your 5-hour usage window hit 100%. Ignores the three conditions below. Needs Record usage history (Usage forecast).'
    });
    assert.deepStrictEqual({ name: reset.name, hint: reset.hint }, {
      name: 'Usage limit reset',
      hint: 'The 5-hour window you hit has reset. Ignores the three conditions below. Needs Record usage history (Usage forecast).'
    });
  })) p++; else f++;

  if (test('a session row is disabled only by a missing topic, never by usage', () => {
    assert.deepStrictEqual(notifyRowState('question', ON), { disabled: false, note: null });
    assert.deepStrictEqual(notifyRowState('question', { ...ON, notifyAvailable: false }), { disabled: true, note: null });
    assert.deepStrictEqual(notifyRowState('routine-failed', { notifyAvailable: true, usageAvailable: false, recordUsageHistory: false }),
      { disabled: false, note: null });
  })) p++; else f++;

  if (test('a usage row: every combination', () => {
    for (const key of ['usage-limit', 'usage-reset'] as const) {
      assert.deepStrictEqual(notifyRowState(key, ON), { disabled: false, note: null });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, recordUsageHistory: false }), { disabled: true, note: RECORDING });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, usageAvailable: false }), { disabled: true, note: HIDDEN });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, usageAvailable: false, recordUsageHistory: false }), { disabled: true, note: HIDDEN });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, notifyAvailable: false }), { disabled: true, note: null });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, notifyAvailable: false, recordUsageHistory: false }), { disabled: true, note: null });
      assert.deepStrictEqual(notifyRowState(key, { ...ON, notifyAvailable: false, usageAvailable: false }), { disabled: true, note: HIDDEN });
    }
  })) p++; else f++;

  console.log(`  ${p} passed, ${f} failed`);
  return f;
}
