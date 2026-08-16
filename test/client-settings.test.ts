import assert from 'node:assert';

import {
  DEFAULT_SETTINGS, LIMITS, THEMES,
  clampSettings, formatInterval, scanQuery
} from '../client/src/lib/settings.js';
import { alertText, dedupe, diffAlerts, statusMap, titleWithCount } from '../client/src/lib/alerts.js';
import type { Session } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A session row reduced to the fields the alert logic reads. */
function session(id: string, status: Session['status'], project = 'proj'): Session {
  return { id, status, project, sessionName: null } as Session;
}

export function run(): number {
  console.log('\n=== client/lib/settings.ts ===\n');
  let p = 0, f = 0;

  if (test('anything unusable falls back to the defaults', () => {
    for (const raw of [null, undefined, 'nope', 42, []]) {
      assert.deepStrictEqual(clampSettings(raw), DEFAULT_SETTINGS, JSON.stringify(raw ?? String(raw)));
    }
  })) p++; else f++;

  if (test('one bad field cannot discard the rest', () => {
    const s = clampSettings({ theme: 'chartreuse', density: 'compact', maxSessions: 7 });
    assert.strictEqual(s.theme, DEFAULT_SETTINGS.theme, 'an unknown theme falls back');
    assert.strictEqual(s.density, 'compact', 'the good fields still survive');
    assert.strictEqual(s.maxSessions, 7);
  })) p++; else f++;

  if (test('numbers are clamped to the offered range', () => {
    assert.strictEqual(clampSettings({ maxSessions: 9999 }).maxSessions, LIMITS.maxSessions.max);
    assert.strictEqual(clampSettings({ maxSessions: 0 }).maxSessions, LIMITS.maxSessions.min);
    assert.strictEqual(clampSettings({ refreshMs: 10 }).refreshMs, LIMITS.refreshMs.min);
    assert.strictEqual(clampSettings({ fontScale: 400 }).fontScale, LIMITS.fontScale.max);
    assert.strictEqual(clampSettings({ lookbackHours: 'soon' }).lookbackHours, DEFAULT_SETTINGS.lookbackHours);
  })) p++; else f++;

  if (test('the client caps match the server caps', () => {
    // If these drift, the UI offers a number the rows will never reflect —
    // the server clamps it back and the two disagree silently.
    assert.strictEqual(LIMITS.maxSessions.max, 50);
    assert.strictEqual(LIMITS.lookbackHours.max, 168);
    assert.strictEqual(LIMITS.activeWindowMin.max, 120);
  })) p++; else f++;

  if (test('every advertised theme is a distinct id', () => {
    const ids = THEMES.map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(ids.includes(DEFAULT_SETTINGS.theme), 'the default must be one of them');
    assert.strictEqual(ids.length, 5);
  })) p++; else f++;

  if (test('scanQuery carries all three knobs', () => {
    assert.strictEqual(
      scanQuery(clampSettings({ maxSessions: 3, lookbackHours: 48, activeWindowMin: 15 })),
      '?limit=3&lookback=48&active=15'
    );
  })) p++; else f++;

  if (test('intervals read as humans write them', () => {
    assert.strictEqual(formatInterval(3000), '3s');
    assert.strictEqual(formatInterval(30_000), '30s');
    assert.strictEqual(formatInterval(1500), '1500ms');
  })) p++; else f++;

  console.log('\n=== client/lib/alerts.ts ===\n');

  if (test('only needs-you statuses alert', () => {
    const prev = statusMap([session('a', 'idle'), session('b', 'idle'), session('c', 'idle')]);
    const fired = diffAlerts(prev, [session('a', 'working'), session('b', 'question'), session('c', 'incomplete')]);
    assert.deepStrictEqual(fired.map(t => t.id), ['b', 'c'], 'working is not something you have to act on');
  })) p++; else f++;

  if (test('a session already waiting does not re-alert every poll', () => {
    const prev = statusMap([session('a', 'question')]);
    assert.deepStrictEqual(diffAlerts(prev, [session('a', 'question')]), []);
  })) p++; else f++;

  if (test('moving between two needs-you statuses is still news', () => {
    const prev = statusMap([session('a', 'incomplete')]);
    const fired = diffAlerts(prev, [session('a', 'question')]);
    assert.strictEqual(fired.length, 1, 'a finished turn becoming a question is a new thing to do');
  })) p++; else f++;

  if (test('re-entering a needs-you status after working alerts again', () => {
    let prev = statusMap([session('a', 'question')]);
    assert.deepStrictEqual(diffAlerts(prev, [session('a', 'working')]), []);
    prev = statusMap([session('a', 'working')]);
    assert.strictEqual(diffAlerts(prev, [session('a', 'question')]).length, 1);
  })) p++; else f++;

  if (test('a brand-new session that arrives waiting alerts', () => {
    const prev = statusMap([session('a', 'idle')]);
    const fired = diffAlerts(prev, [session('a', 'idle'), session('b', 'question')]);
    assert.deepStrictEqual(fired.map(t => t.id), ['b']);
  })) p++; else f++;

  if (test('an empty baseline still diffs (the caller decides to skip it)', () => {
    // The hook skips the first snapshot; this stays a pure diff so the rule
    // lives in one place instead of being baked in twice.
    assert.strictEqual(diffAlerts(new Map(), [session('a', 'question')]).length, 1);
  })) p++; else f++;

  if (test('the label prefers a custom session name over the project', () => {
    const named = { ...session('a', 'question'), sessionName: 'refactor scan' };
    assert.strictEqual(diffAlerts(new Map(), [named])[0].label, 'refactor scan');
    assert.strictEqual(diffAlerts(new Map(), [session('a', 'question', 'dash')])[0].label, 'dash');
  })) p++; else f++;

  if (test('alert text says which kind of waiting it is', () => {
    assert.match(alertText({ id: 'a', label: 'dash', status: 'question' }), /needs an answer/);
    assert.match(alertText({ id: 'a', label: 'dash', status: 'incomplete' }), /your turn/);
  })) p++; else f++;

  if (test('the tab title carries the count, and drops it at zero', () => {
    assert.strictEqual(titleWithCount('Claude Sessions', 2), '(2) Claude Sessions');
    assert.strictEqual(titleWithCount('Claude Sessions', 0), 'Claude Sessions');
  })) p++; else f++;

  if (test('the poll and the push stream cannot both announce one transition', () => {
    const ledger = new Map<string, number>();
    const target = { id: 'a', label: 'dash', status: 'question' as const };
    assert.strictEqual(dedupe([target], ledger, 1000, 60_000).length, 1, 'first producer wins');
    assert.strictEqual(dedupe([target], ledger, 1200, 60_000).length, 0, 'second producer is a no-op');
  })) p++; else f++;

  if (test('the same session entering a different status is still news', () => {
    const ledger = new Map<string, number>();
    dedupe([{ id: 'a', label: 'dash', status: 'question' }], ledger, 1000, 60_000);
    const later = dedupe([{ id: 'a', label: 'dash', status: 'incomplete' }], ledger, 1200, 60_000);
    assert.strictEqual(later.length, 1);
  })) p++; else f++;

  if (test('the ledger evicts past the window, so a long-lived tab cannot grow it forever', () => {
    const ledger = new Map<string, number>();
    dedupe([{ id: 'a', label: 'dash', status: 'question' }], ledger, 1000, 60_000);
    const again = dedupe([{ id: 'a', label: 'dash', status: 'question' }], ledger, 1000 + 60_001, 60_000);
    assert.strictEqual(again.length, 1, 'stale entry expired');
    assert.strictEqual(ledger.size, 1, 'and did not accumulate');
  })) p++; else f++;

  if (test('deduping a batch keeps distinct sessions and drops in-batch repeats', () => {
    const ledger = new Map<string, number>();
    const fired = dedupe([
      { id: 'a', label: 'one', status: 'question' },
      { id: 'b', label: 'two', status: 'question' },
      { id: 'a', label: 'one', status: 'question' }
    ], ledger, 1000, 60_000);
    assert.deepStrictEqual(fired.map(t => t.id), ['a', 'b']);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
