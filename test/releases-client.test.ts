/**
 * The release chip and drawer's app side. The decisions themselves — version order, the chip's label, the unseen dot and its first-visit seed, badges,
 * titles, dates — are ui-kit's and tested there; what is left here is what this app owns: the `localStorage` key, the wiring that hands it to
 * `useWhatsNew`, the chip's `rel-chip` class and the drawer's back gesture. There is no DOM renderer in this suite, so the hook's seed step is driven
 * through the same ui-kit exports `useWhatsNew` composes (`readLastSeen`, `dotState`, `writeLastSeen`), and the wiring is read off the source text.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { dotState, readLastSeen, writeLastSeen } from 'ui-kit';

import { LAST_SEEN_KEY } from '../client/src/lib/releases.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const src = (rel: string): string => readFileSync(new URL('../client/src/' + rel, import.meta.url), 'utf8');

/** Run `fn` with `globalThis.localStorage` replaced by `value`, restoring the original property afterwards. */
function withLocalStorage(value: unknown, fn: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, 'localStorage');
  const prev = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { value, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (had && prev) Object.defineProperty(g, 'localStorage', prev);
    else delete g.localStorage;
  }
}

function memLocalStorage(initial: Record<string, string> = {}): { data: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

/** One pass of `useWhatsNew`'s seed step under the app's key: read what is stored, ask `dotState`, write the seed if it names one. */
function settle(newest: string | null, open: boolean): { dot: boolean } {
  const { dot, seed } = dotState(newest, readLastSeen(LAST_SEEN_KEY), open);
  if (seed !== null) writeLastSeen(LAST_SEEN_KEY, seed);
  return { dot };
}

export function run(): number {
  console.log('\n=== releases (client wiring) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('the last-seen key is still dashboard.releases.lastSeen', () => {
    assert.strictEqual(LAST_SEEN_KEY, 'dashboard.releases.lastSeen');
  });

  t('App reads the chip, dot and drawer from useWhatsNew under LAST_SEEN_KEY', () => {
    const app = src('App.tsx');
    assert.match(app, /import \{ useWhatsNew \} from 'ui-kit'/);
    assert.match(app, /useWhatsNew\(\{ storageKey: LAST_SEEN_KEY \}\)/);
  });

  t('the key round-trips through ui-kit storage as a raw version string', () => {
    const ls = memLocalStorage();
    withLocalStorage(ls, () => {
      writeLastSeen(LAST_SEEN_KEY, '0.2.0');
      assert.strictEqual(ls.data.get('dashboard.releases.lastSeen'), '0.2.0');
      assert.strictEqual(readLastSeen(LAST_SEEN_KEY), '0.2.0');
    });
  });

  // D17: a checkout behind the one last opened must not write its lower newest back. Deliberately duplicates ui-kit's own hook case, as app-level proof
  // that the fix reached this app — do not delete it as a duplicate.
  t('stored 0.9.0, newest 0.5.0, open → storage stays 0.9.0', () => {
    const ls = memLocalStorage({ 'dashboard.releases.lastSeen': '0.9.0' });
    withLocalStorage(ls, () => {
      assert.strictEqual(settle('0.5.0', true).dot, false);
      assert.strictEqual(ls.data.get('dashboard.releases.lastSeen'), '0.9.0');
    });
  });

  t('stored 0.5.0, newest 0.9.0: a dot while closed, and opening stores 0.9.0', () => {
    const ls = memLocalStorage({ 'dashboard.releases.lastSeen': '0.5.0' });
    withLocalStorage(ls, () => {
      assert.strictEqual(settle('0.9.0', false).dot, true);
      assert.strictEqual(ls.data.get('dashboard.releases.lastSeen'), '0.5.0');
      assert.strictEqual(settle('0.9.0', true).dot, false);
      assert.strictEqual(ls.data.get('dashboard.releases.lastSeen'), '0.9.0');
    });
  });

  t('the rail renders ui-kit VersionChip with the rel-chip class', () => {
    assert.match(src('components/SideRail.tsx'), /<VersionChip [^>]*className="rel-chip"/);
  });

  t('the drawer wrapper keeps the back-gesture close and the app Markdown notes', () => {
    const d = src('components/ReleasesDrawer.tsx');
    assert.match(d, /useBackClose\(onClose\)/);
    assert.match(d, /narrow=\{useNarrow\(\)\}/);
    assert.match(d, /renderNotes=\{t => <Markdown text=\{t\} \/>\}/);
  });

  t('the client entry imports ui-kit styles before its own sheet', () => {
    const main = src('main.tsx');
    const kit = main.indexOf("import 'ui-kit/styles.css';");
    assert.ok(kit >= 0, 'ui-kit/styles.css not imported');
    assert.ok(kit < main.indexOf("import './styles.css';"), 'ui-kit/styles.css must come before ./styles.css');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
