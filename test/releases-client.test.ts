/**
 * The release chip and drawer's decisions (`client/src/lib/releases.ts`): version order, the chip's label, the unseen dot with its first-visit seed, the
 * badges, the display title and the date. Storage sits behind a `SeenStore` port, so every case runs without a DOM; the real localStorage adapter is
 * exercised once against a stubbed global.
 */
import assert from 'node:assert';

import {
  badges, chipLabel, cmpVersion, displayTitle, formatReleaseDate, localSeenStore, markSeen, newestVersion, parseVersion, unseen,
} from '../client/src/lib/releases.js';
import type { SeenStore } from '../client/src/lib/releases.js';
import type { Release } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function memStore(initial: string | null = null): SeenStore & { value: string | null } {
  const s = {
    value: initial,
    get: () => s.value,
    set: (v: string) => { s.value = v; },
  };
  return s;
}

const throwing: SeenStore = {
  get: () => { throw new Error('blocked'); },
  set: () => { throw new Error('blocked'); },
};

function rel(over: Partial<Release>): Release {
  return { version: '0.2.0', date: '2026-10-16T12:00:00Z', title: 'x', type: 'feat', breaking: false, notes: '', ...over };
}

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

export function run(): number {
  console.log('\n=== releases (client logic) ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('parseVersion reads X.Y.Z digits and nothing else', () => {
    assert.deepStrictEqual(parseVersion('0.10.0'), [0, 10, 0]);
    for (const bad of ['v0.1.0', '0.1', '0.1.0-rc1', '', 'garbage']) assert.strictEqual(parseVersion(bad), null, bad);
  });

  t('cmpVersion compares numerically per part', () => {
    assert.ok(cmpVersion('0.10.0', '0.9.0') > 0);
    assert.ok(cmpVersion('1.0.0', '0.99.99') > 0);
    assert.strictEqual(cmpVersion('0.2.0', '0.2.0'), 0);
    assert.ok(cmpVersion('0.2.0', '0.2.1') < 0);
  });

  t('chipLabel: none, on a tag, ahead of one', () => {
    assert.strictEqual(chipLabel(null), null);
    assert.strictEqual(chipLabel({ version: '0.5.0', ahead: 0 }), 'v0.5.0');
    assert.strictEqual(chipLabel({ version: '0.5.0', ahead: 3 }), 'v0.5.0+3');
  });

  t('newestVersion is the first release, a baseline included', () => {
    assert.strictEqual(newestVersion([]), null);
    assert.strictEqual(newestVersion([rel({ version: '0.1.0', type: 'baseline' })]), '0.1.0');
    assert.strictEqual(newestVersion([rel({ version: '0.3.0' }), rel({ version: '0.2.0' })]), '0.3.0');
  });

  t('unseen with no newest release is false and leaves the store alone', () => {
    const s = memStore('0.2.0');
    assert.strictEqual(unseen(null, s), false);
    assert.strictEqual(s.value, '0.2.0');
  });

  t('unseen on a first visit is false and seeds the store with the newest', () => {
    const s = memStore();
    assert.strictEqual(unseen('0.3.0', s), false);
    assert.strictEqual(s.value, '0.3.0');
  });

  t('unseen treats a stored value that is not a version as missing', () => {
    const s = memStore('garbage');
    assert.strictEqual(unseen('0.3.0', s), false);
    assert.strictEqual(s.value, '0.3.0');
  });

  t('unseen is true for a newer release, and does not mark it seen', () => {
    const s = memStore('0.2.0');
    assert.strictEqual(unseen('0.3.0', s), true);
    assert.strictEqual(s.value, '0.2.0');
  });

  t('unseen compares numerically: seen 0.10.0, newest 0.9.0 is not new', () => {
    assert.strictEqual(unseen('0.9.0', memStore('0.10.0')), false);
    assert.strictEqual(unseen('0.3.0', memStore('0.3.0')), false);
  });

  t('unseen with a throwing store is false and does not throw', () => {
    assert.strictEqual(unseen('0.3.0', throwing), false);
  });

  t('markSeen writes the newest, skips null, survives a throwing store', () => {
    const s = memStore('0.1.0');
    markSeen(null, s);
    assert.strictEqual(s.value, '0.1.0');
    markSeen('0.3.0', s);
    assert.strictEqual(s.value, '0.3.0');
    assert.doesNotThrow(() => markSeen('0.3.0', throwing));
  });

  t('localSeenStore swallows a localStorage that throws', () => {
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
    withLocalStorage(blocked, () => {
      const s = localSeenStore();
      assert.strictEqual(s.get(), null);
      assert.doesNotThrow(() => s.set('0.1.0'));
    });
  });

  t('localSeenStore copes with no localStorage at all', () => {
    withLocalStorage(undefined, () => {
      const s = localSeenStore();
      assert.strictEqual(s.get(), null);
      assert.doesNotThrow(() => s.set('0.1.0'));
    });
  });

  t('localSeenStore round-trips through dashboard.releases.lastSeen', () => {
    const data = new Map<string, string>();
    const ls = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    withLocalStorage(ls, () => {
      const s = localSeenStore();
      s.set('0.2.0');
      assert.strictEqual(data.get('dashboard.releases.lastSeen'), '0.2.0');
      assert.strictEqual(s.get(), '0.2.0');
    });
  });

  t('badges: one per type, Breaking after the type, none for the baseline', () => {
    const labels = (r: Release) => badges(r).map(b => `${b.kind}:${b.label}`);
    assert.deepStrictEqual(labels(rel({ type: 'feat' })), ['feat:Feature']);
    assert.deepStrictEqual(labels(rel({ type: 'fix' })), ['fix:Fix']);
    assert.deepStrictEqual(labels(rel({ type: 'perf' })), ['perf:Performance']);
    assert.deepStrictEqual(labels(rel({ type: 'feat', breaking: true })), ['feat:Feature', 'breaking:Breaking']);
    assert.deepStrictEqual(labels(rel({ type: 'baseline' })), []);
  });

  t('displayTitle strips a Conventional Commits prefix and nothing else', () => {
    assert.strictEqual(displayTitle('feat(releases): version chip'), 'version chip');
    assert.strictEqual(displayTitle('fix!: drop x'), 'drop x');
    assert.strictEqual(displayTitle('perf(scan-cache)!: skip unchanged'), 'skip unchanged');
    assert.strictEqual(displayTitle('Baseline — versioning starts here'), 'Baseline — versioning starts here');
    assert.strictEqual(displayTitle('feat: '), '');
  });

  t('formatReleaseDate is day, short month, year; garbage passes through', () => {
    assert.strictEqual(formatReleaseDate('2026-10-16T12:00:00Z'), '16 Oct 2026');
    assert.strictEqual(formatReleaseDate('nope'), 'nope');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
