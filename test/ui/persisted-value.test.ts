import assert from 'node:assert';

import { listenPersisted, readPersisted, writePersisted } from '../../client/src/lib/persistedValue.js';
import { historyDays } from '../../client/src/lib/usageHistory.js';
import { gitInboxFilter } from '../../client/src/lib/gitLevels.js';
import { codegraphInboxFilter } from '../../client/src/lib/codegraphLevels.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A Map-backed stand-in for `localStorage` — only the two methods the module calls. */
function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }
  } as unknown as Storage & { data: Map<string, string> };
}

/** A `storage` event as the browser fires it on another tab's `window`. */
function storageEvent(key: string | null, newValue: string | null): Event {
  return Object.assign(new Event('storage'), { key, newValue });
}

/**
 * What `usePersistedState` does with the module, without React: one in-memory value per holder, written through on every change, and — while `listen`
 * is on — following the stored value when another tab's event arrives on this holder's own `window`.
 */
function holder<T>(storage: Storage, key: string, fallback: T, listen = true) {
  const target = new EventTarget();
  const h = { target, value: readPersisted(() => storage, key, fallback), last: null as string | null, off: () => {} };
  const write = (v: T) => { h.value = v; h.last = writePersisted(() => storage, key, v); };
  if (listen) h.off = listenPersisted({ target, storage: () => storage, key, fallback: () => fallback, lastWritten: () => h.last, onValue: v => { h.value = v; } });
  return { ...h, h, write };
}

export function run(): number {
  console.log('\n=== persistedValue.ts ===\n');
  let p = 0, f = 0;
  const t = (name: string, fn: () => void) => { if (test(name, fn)) p++; else f++; };

  t('parse: a missing key, bad JSON and a throwing storage all read as the fallback', () => {
    assert.strictEqual(readPersisted(() => fakeStorage(), 'k', 7), 7);
    assert.strictEqual(readPersisted(() => fakeStorage({ k: '{oops' }), 'k', 7), 7);
    const boom = { getItem() { throw new Error('denied'); } } as unknown as Storage;
    assert.strictEqual(readPersisted(() => boom, 'k', 7), 7);
    assert.strictEqual(readPersisted(() => undefined, 'k', 7), 7);
  });

  t('parse: a stored object is shallow-merged over the fallback object', () => {
    assert.deepStrictEqual(readPersisted(() => fakeStorage({ k: '{"a":2}' }), 'k', { a: 1, b: 1 }), { a: 2, b: 1 });
  });

  t('parse: a stored array and a stored scalar are returned as they are', () => {
    assert.deepStrictEqual(readPersisted(() => fakeStorage({ k: '[1,2]' }), 'k', { a: 1 } as unknown), [1, 2]);
    assert.strictEqual(readPersisted(() => fakeStorage({ k: '30' }), 'k', 7), 30);
    assert.strictEqual(readPersisted(() => fakeStorage({ k: '"x"' }), 'k', 'y'), 'x');
  });

  t('write: stores the JSON and returns it; a throwing storage returns it too and does not throw', () => {
    const s = fakeStorage();
    assert.strictEqual(writePersisted(() => s, 'k', { a: 1 }), '{"a":1}');
    assert.strictEqual(s.data.get('k'), '{"a":1}');
    const boom = { setItem() { throw new Error('quota'); } } as unknown as Storage;
    assert.strictEqual(writePersisted(() => boom, 'k', 3), '3');
  });

  t('listener: an event for the key delivers the re-read value', () => {
    const s = fakeStorage({ k: '"x"' });
    const target = new EventTarget();
    const got: unknown[] = [];
    const off = listenPersisted({ target, storage: () => s, key: 'k', fallback: () => 'd', lastWritten: () => null, onValue: v => got.push(v) });
    target.dispatchEvent(storageEvent('k', '"x"'));
    assert.deepStrictEqual(got, ['x']);
    off();
  });

  t('listener: a cleared storage (key null) with the key absent delivers the fallback', () => {
    const s = fakeStorage();
    const target = new EventTarget();
    const got: unknown[] = [];
    const off = listenPersisted({ target, storage: () => s, key: 'k', fallback: () => 'd', lastWritten: () => '"x"', onValue: v => got.push(v) });
    target.dispatchEvent(storageEvent(null, null));
    assert.deepStrictEqual(got, ['d']);
    off();
  });

  t('listener: an event for another key delivers nothing', () => {
    const s = fakeStorage({ k: '"x"' });
    const target = new EventTarget();
    const got: unknown[] = [];
    const off = listenPersisted({ target, storage: () => s, key: 'k', fallback: () => 'd', lastWritten: () => null, onValue: v => got.push(v) });
    target.dispatchEvent(storageEvent('other', '"y"'));
    assert.deepStrictEqual(got, []);
    off();
  });

  t('listener: an event whose newValue is what this holder last wrote delivers nothing', () => {
    const s = fakeStorage({ k: '"x"' });
    const target = new EventTarget();
    const got: unknown[] = [];
    const off = listenPersisted({ target, storage: () => s, key: 'k', fallback: () => 'd', lastWritten: () => '"x"', onValue: v => got.push(v) });
    target.dispatchEvent(storageEvent('k', '"x"'));
    assert.deepStrictEqual(got, []);
    off();
  });

  t('listener: after the unsubscribe an event for the key delivers nothing', () => {
    const s = fakeStorage({ k: '"x"' });
    const target = new EventTarget();
    const got: unknown[] = [];
    const off = listenPersisted({ target, storage: () => s, key: 'k', fallback: () => 'd', lastWritten: () => null, onValue: v => got.push(v) });
    off();
    target.dispatchEvent(storageEvent('k', '"x"'));
    assert.deepStrictEqual(got, []);
  });

  t('clobber regression: a patch in tab B lands on tab A’s latest settings instead of undoing them', () => {
    const fallback = { theme: 'graphite', fontScale: 100 };
    const storage = fakeStorage();
    const a = holder(storage, 'dashboard.settings', fallback);
    const b = holder(storage, 'dashboard.settings', fallback);
    a.write({ ...a.h.value, theme: 'dark' });
    b.h.target.dispatchEvent(storageEvent('dashboard.settings', storage.data.get('dashboard.settings') ?? null));
    b.write({ ...b.h.value, fontScale: 125 });
    assert.deepStrictEqual(JSON.parse(storage.data.get('dashboard.settings') ?? 'null'), { theme: 'dark', fontScale: 125 });
    a.h.off(); b.h.off();
  });

  t('clobber regression, mirror: a holder that does not listen undoes the other tab’s change (what the listener fixes)', () => {
    const fallback = { theme: 'graphite', fontScale: 100 };
    const storage = fakeStorage();
    const a = holder(storage, 'dashboard.settings', fallback, false);
    const b = holder(storage, 'dashboard.settings', fallback, false);
    a.write({ ...a.h.value, theme: 'dark' });
    b.h.target.dispatchEvent(storageEvent('dashboard.settings', storage.data.get('dashboard.settings') ?? null));
    b.write({ ...b.h.value, fontScale: 125 });
    assert.deepStrictEqual(JSON.parse(storage.data.get('dashboard.settings') ?? 'null'), { theme: 'graphite', fontScale: 125 });
  });

  t('validators: an unknown stored value reads as the default, a valid one is kept', () => {
    assert.strictEqual(historyDays(45), 7);
    assert.strictEqual(historyDays('bogus'), 7);
    assert.strictEqual(historyDays('30'), 7, 'a string is not a range');
    assert.strictEqual(historyDays(30), 30);
    assert.strictEqual(historyDays(90), 90);
    assert.strictEqual(gitInboxFilter(45), 'all');
    assert.strictEqual(gitInboxFilter('bogus'), 'all');
    assert.strictEqual(gitInboxFilter('needs'), 'needs');
    assert.strictEqual(gitInboxFilter('dead'), 'dead');
    assert.strictEqual(gitInboxFilter('all'), 'all');
    assert.strictEqual(codegraphInboxFilter(45), 'all');
    assert.strictEqual(codegraphInboxFilter('bogus'), 'all');
    assert.strictEqual(codegraphInboxFilter('dead'), 'all', 'dead is Git’s level, not CodeGraph’s');
    assert.strictEqual(codegraphInboxFilter('none'), 'none');
    assert.strictEqual(codegraphInboxFilter('look'), 'look');
  });

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
