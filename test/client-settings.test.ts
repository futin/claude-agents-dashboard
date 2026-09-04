import assert from 'node:assert';

import {
  DEFAULT_SETTINGS, LIMITS, THEMES,
  chatQuery, clampSettings, formatInterval, scanQuery
} from '../client/src/lib/settings.js';
import { DEFAULTS } from '../server/lib/config.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
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

  if (test('the Usage sub-tab defaults to the forecast and rejects anything else', () => {
    assert.strictEqual(DEFAULT_SETTINGS.usageTab, 'forecast');
    assert.strictEqual(clampSettings({ usageTab: 'rates' }).usageTab, 'rates');
    assert.strictEqual(clampSettings({ usageTab: 'nonsense' }).usageTab, 'forecast');
    assert.strictEqual(clampSettings({ usageTab: 7 }).usageTab, 'forecast');
  })) p++; else f++;

  if (test('scanQuery carries all three knobs', () => {
    assert.strictEqual(
      scanQuery(clampSettings({ maxSessions: 3, lookbackHours: 48, activeWindowMin: 15 })),
      '?limit=3&lookback=48&active=15'
    );
  })) p++; else f++;

  if (test('full chat text is off by default and coerces to a boolean', () => {
    assert.strictEqual(DEFAULT_SETTINGS.chatFullText, false, 'today\'s behaviour stays the default');
    assert.strictEqual(clampSettings({ chatFullText: true }).chatFullText, true);
    assert.strictEqual(clampSettings({ chatFullText: 'yes' }).chatFullText, false, 'a non-boolean falls back');
  })) p++; else f++;

  if (test('chatQuery adds full=1 only when the toggle is on', () => {
    const off = clampSettings({});
    const on = clampSettings({ chatFullText: true });
    assert.strictEqual(chatQuery(off), '');
    assert.strictEqual(chatQuery(off, 'after=42'), '?after=42');
    assert.strictEqual(chatQuery(on), '?full=1');
    assert.strictEqual(chatQuery(on, 'before=42'), '?before=42&full=1');
  })) p++; else f++;

  if (test('intervals read as humans write them', () => {
    assert.strictEqual(formatInterval(3000), '3s');
    assert.strictEqual(formatInterval(30_000), '30s');
    assert.strictEqual(formatInterval(1500), '1500ms');
  })) p++; else f++;

  // bug-4: this default is not cosmetic — `scanQuery` sends it as `?limit=` on
  // every poll, unconditionally, so a browser with nothing stored overrides the
  // server's own default rather than inheriting it. The two must agree or the
  // documented server default is never the one anybody sees.
  if (test('the fresh-browser session cap matches the server default', () => {
    assert.strictEqual(DEFAULT_SETTINGS.maxSessions, DEFAULTS.MAX_SESSIONS);
    assert.ok(
      scanQuery(DEFAULT_SETTINGS).startsWith(`?limit=${DEFAULTS.MAX_SESSIONS}&`),
      `a fresh browser polls with ${scanQuery(DEFAULT_SETTINGS)}`
    );
  })) p++; else f++;

  // task-16: the browser-notify switch is per device and off until someone asks
  // for it — a banner nobody consented to is worse than none.
  if (test('browser notifications start off', () => {
    assert.strictEqual(DEFAULT_SETTINGS.notifyBrowser, false);
  })) p++; else f++;

  if (test('a hand-edited string is not a boolean', () => {
    assert.strictEqual(clampSettings({ notifyBrowser: 'true' }).notifyBrowser, false);
  })) p++; else f++;

  if (test('one bad sibling cannot discard the browser-notify switch', () => {
    assert.strictEqual(clampSettings({ notifyBrowser: true, theme: 'chartreuse' }).notifyBrowser, true);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
