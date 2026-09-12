import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SETTINGS, LANDING_OPTIONS, LAYOUT_OPTIONS, LIMITS, THEMES,
  chatQuery, clampSettings, formatInterval, resolveLayout, scanQuery
} from '../client/src/lib/settings.js';
import { DEFAULT_LAYOUT, LAYOUTS } from '../client/src/lib/filterSort.js';
import { SECTIONS, isSection } from '../client/src/lib/sections.js';
import { DEFAULTS } from '../server/lib/config.js';
import { OWNED_KEYS } from '../client/src/hooks/useSettings.js';

const CLIENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src');

/** Every `usePersistedState` key the client actually writes, read off the source. */
function persistedKeys(dir: string, found = new Set<string>()): Set<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) { persistedKeys(path, found); continue; }
    if (!/\.tsx?$/.test(e.name)) continue;
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/usePersistedState\s*(?:<[^>]*>)?\s*\(\s*'([^']+)'/g)) found.add(m[1]);
  }
  return found;
}

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

  // The Settings section is two pages, Local and Shared, picked the same way
  // the Usage sub-views are — so the field mirrors `usageTab` in every respect.
  if (test('the Settings scope defaults to local and rejects anything else', () => {
    assert.strictEqual(DEFAULT_SETTINGS.settingsTab, 'local');
    assert.strictEqual(clampSettings({ settingsTab: 'shared' }).settingsTab, 'shared');
    assert.strictEqual(clampSettings({ settingsTab: 'nonsense' }).settingsTab, 'local');
    assert.strictEqual(clampSettings({ settingsTab: 7 }).settingsTab, 'local');
  })) p++; else f++;

  // The shape the sessions list opens in. It used to live in the persisted
  // `dashboard.view`, which made the toolbar's choice sticky forever; it is a
  // setting now, with a `last` sentinel that opts back into the switcher's own
  // remembered shape — the same pair `landing` / `dashboard.section` make.
  if (test('the default session view defaults to last used, like Opens on', () => {
    assert.strictEqual(DEFAULT_SETTINGS.defaultLayout, 'last', 'sibling of `landing`, same default');
    assert.strictEqual(clampSettings({ defaultLayout: 'last' }).defaultLayout, 'last');
    assert.strictEqual(clampSettings({}).defaultLayout, 'last');
  })) p++; else f++;

  if (test('the default session view rejects anything the switcher cannot draw', () => {
    assert.strictEqual(clampSettings({ defaultLayout: 'triage' }).defaultLayout, 'triage');
    assert.strictEqual(clampSettings({ defaultLayout: 'rows' }).defaultLayout, 'last', 'a shape no build draws');
    assert.strictEqual(clampSettings({ defaultLayout: 3 }).defaultLayout, 'last');
    assert.strictEqual(clampSettings({ defaultLayout: 42 }).defaultLayout, 'last');
    assert.strictEqual(clampSettings({ defaultLayout: null }).defaultLayout, 'last');
    assert.strictEqual(clampSettings({ defaultLayout: { key: 'board' } }).defaultLayout, 'last');
    assert.strictEqual(clampSettings({ defaultLayout: '' }).defaultLayout, 'last');
  })) p++; else f++;

  if (test('one bad sibling cannot discard the default session view', () => {
    const s = clampSettings({ defaultLayout: 'tiles', theme: 'chartreuse', landing: 42 });
    assert.strictEqual(s.defaultLayout, 'tiles');
    assert.strictEqual(s.theme, DEFAULT_SETTINGS.theme);
    assert.strictEqual(clampSettings({ defaultLayout: 'rows', maxSessions: 7 }).maxSessions, 7);
  })) p++; else f++;

  // No regression for a value stored by the current release, where the field
  // could only ever be one of the five.
  if (test('every shape the switcher offers is an accepted default', () => {
    for (const l of LAYOUTS) {
      assert.strictEqual(clampSettings({ defaultLayout: l.key }).defaultLayout, l.key, l.key);
    }
  })) p++; else f++;

  // Spelled out literally, not derived from LAYOUTS — a test reading the same
  // array as the code under test passes whatever either one says.
  if (test('the view picker offers last used first, then the switcher\'s five', () => {
    assert.deepStrictEqual(
      LAYOUT_OPTIONS.map(o => o.value),
      ['last', 'board', 'list', 'split', 'tiles', 'triage']
    );
    assert.strictEqual(LAYOUT_OPTIONS.length, 6);
    assert.strictEqual(LAYOUT_OPTIONS[0].label, 'Last used');
  })) p++; else f++;

  // ⚠️ The regression this whole shape exists to prevent: `last` is a *setting*
  // value, and LAYOUTS is the toolbar's button list. Growing it would ship a
  // sixth switcher button that draws nothing.
  if (test('LAYOUTS stays the five switcher buttons and never gains `last`', () => {
    assert.deepStrictEqual(LAYOUTS.map(l => l.key), ['board', 'list', 'split', 'tiles', 'triage']);
    assert.strictEqual(LAYOUTS.length, 5);
    assert.ok(!LAYOUTS.some(l => (l.key as string) === 'last'), 'no sixth toolbar button');
  })) p++; else f++;

  // The pure resolver the board seeds its shape from.
  if (test('resolveLayout: last used replays the stored shape', () => {
    for (const l of LAYOUTS) {
      assert.strictEqual(resolveLayout('last', l.key), l.key, l.key);
    }
  })) p++; else f++;

  if (test('resolveLayout: a concrete default wins whatever is stored', () => {
    assert.strictEqual(resolveLayout('tiles', 'triage'), 'tiles');
    assert.strictEqual(resolveLayout('tiles', 'board'), 'tiles');
    assert.strictEqual(resolveLayout('tiles', undefined), 'tiles');
    assert.strictEqual(resolveLayout('tiles', 'nonsense'), 'tiles');
  })) p++; else f++;

  if (test('resolveLayout: last used with nothing stored lands on the board', () => {
    assert.strictEqual(DEFAULT_LAYOUT, 'board');
    assert.strictEqual(resolveLayout('last', undefined), 'board');
    assert.strictEqual(resolveLayout('last', null), 'board');
    assert.strictEqual(resolveLayout('last', 'rows'), 'board', 'a hand-edited key');
    assert.strictEqual(resolveLayout('last', 'last'), 'board', 'the sentinel is never a shape');
  })) p++; else f++;

  // `fixed` is the drawn measure, so it has to be the default: `full` changes
  // the width of every section at once.
  if (test('content width defaults to fixed and rejects anything else', () => {
    assert.strictEqual(DEFAULT_SETTINGS.contentWidth, 'fixed');
    assert.strictEqual(clampSettings({ contentWidth: 'full' }).contentWidth, 'full');
    assert.strictEqual(clampSettings({ contentWidth: 'wide' }).contentWidth, 'fixed');
    assert.strictEqual(clampSettings({ contentWidth: true }).contentWidth, 'fixed');
  })) p++; else f++;

  if (test('one bad sibling cannot discard the Settings scope', () => {
    assert.strictEqual(clampSettings({ settingsTab: 'shared', theme: 'chartreuse' }).settingsTab, 'shared');
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
      ['last', 'sessions', 'usage', 'management', 'analytics', 'settings']
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

  if (test('Reset clears every persisted view-state key the client writes', () => {
    // Scanned off the source rather than listed here, so a key added in a new
    // component fails this test instead of quietly surviving Reset — which is
    // how `dashboard.layout` and then `management.type` each got missed.
    const keys = persistedKeys(CLIENT_SRC);
    assert.ok(keys.has('dashboard.layout') && keys.has('management.type'), 'the scan found the keys');
    // The settings blob is reset by writing the defaults, not by removal; the
    // answer token is a credential and Reset is not a sign-out.
    const exempt = new Set(['dashboard.settings', 'dashboard.answerToken']);
    const missed = [...keys].filter(k => !exempt.has(k) && !OWNED_KEYS.includes(k));
    assert.deepStrictEqual(missed, [], 'keys Reset would leave behind');
    const stale = OWNED_KEYS.filter(k => !keys.has(k));
    assert.deepStrictEqual(stale, [], 'keys nothing writes any more');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
