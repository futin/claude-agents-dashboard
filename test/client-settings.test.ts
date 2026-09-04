import assert from 'node:assert';

import {
  DEFAULT_SETTINGS, LANDING_OPTIONS, LIMITS, THEMES,
  chatQuery, clampSettings, formatInterval, scanQuery
} from '../client/src/lib/settings.js';
import { SECTIONS, isSection } from '../client/src/lib/sections.js';
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

  // task-12: `landing` had zero coverage while the picker and the validator
  // each carried their own hand-written list — they disagreed in both
  // directions ('usage' in neither, 'settings' validating but unpickable).
  if (test('the landing preference accepts usage, the section it used to drop', () => {
    assert.strictEqual(clampSettings({ landing: 'usage' }).landing, 'usage');
  })) p++; else f++;

  if (test('every rail section is an accepted landing', () => {
    for (const s of SECTIONS) {
      assert.strictEqual(clampSettings({ landing: s.id }).landing, s.id, s.id);
    }
  })) p++; else f++;

  if (test('last used is still accepted and still the default', () => {
    assert.strictEqual(clampSettings({ landing: 'last' }).landing, 'last');
    assert.strictEqual(clampSettings({}).landing, 'last');
    assert.strictEqual(DEFAULT_SETTINGS.landing, 'last');
  })) p++; else f++;

  if (test('junk and removed sections fall back to last used', () => {
    assert.strictEqual(clampSettings({ landing: 'guides' }).landing, 'last', 'a removed tab');
    assert.strictEqual(clampSettings({ landing: 42 }).landing, 'last');
    assert.strictEqual(clampSettings({ landing: '' }).landing, 'last');
  })) p++; else f++;

  // Spelled out literally, not derived from SECTIONS: a test that reads the
  // same array as the code under test passes whatever either one says. This
  // fails if a section joins the rail without a decision about landing on it.
  if (test('the picker offers exactly the six intended choices', () => {
    assert.deepStrictEqual(
      LANDING_OPTIONS.map(o => o.value),
      ['last', 'sessions', 'management', 'analytics', 'usage', 'settings']
    );
    assert.strictEqual(LANDING_OPTIONS.length, 6);
  })) p++; else f++;

  if (test('each landing option carries the rail\'s own label', () => {
    const label = (v: string) => LANDING_OPTIONS.find(o => o.value === v)?.label;
    assert.strictEqual(label('usage'), 'Usage');
    assert.strictEqual(label('settings'), 'Settings');
    assert.strictEqual(label('last'), 'Last used');
  })) p++; else f++;

  // 'last' returning false is load-bearing: App.tsx leans on it never being
  // treated as a renderable section.
  if (test('isSection answers the rail, and last is not a section', () => {
    for (const s of SECTIONS) assert.ok(isSection(s.id), s.id);
    for (const v of ['last', 'guides', '', undefined, 42]) {
      assert.ok(!isSection(v), String(v));
    }
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

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
