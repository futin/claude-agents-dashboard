import assert from 'node:assert';

import { createPersistedSync, listenPersisted, readPersisted, writePersisted } from '../../client/src/lib/persistedValue.js';
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
 * A storage shared by several tabs, firing `storage` on every OTHER tab's target when a write changes the stored string — what the browser does. Events are
 * queued and drained one by one, so a pair of tabs that keep answering each other shows up as a queue that never empties.
 */
function sharedStorage() {
  const data = new Map<string, string>();
  const targets: EventTarget[] = [];
  const queue: { target: EventTarget; event: Event }[] = [];
  let writer: EventTarget | null = null;
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (data.get(k) === v) return;
      data.set(k, v);
      for (const t of targets) if (t !== writer) queue.push({ target: t, event: storageEvent(k, v) });
    }
  } as unknown as Storage;
  /** Deliver queued events until none is left or `max` were delivered; returns how many were. */
  const drain = (max = 50) => {
    let n = 0;
    while (queue.length > 0 && n < max) { const { target, event } = queue.shift()!; target.dispatchEvent(event); n++; }
    return n;
  };
  return { data, storage, targets, queue, drain, as: (t: EventTarget | null) => { writer = t; } };
}

/**
 * What `usePersistedState` does with the module, without React: one in-memory value per tab, `commit` on every change of it (the write effect), and —
 * while `listen` is on — adopting the value another tab's event re-reads.
 */
function tab<T>(shared: ReturnType<typeof sharedStorage>, key: string, fallback: T, listen = true) {
  const target = new EventTarget();
  shared.targets.push(target);
  const storage = () => shared.storage;
  const sync = createPersistedSync<T>(storage, key);
  const t = { target, value: readPersisted(storage, key, fallback), off: () => {} };
  const change = (v: T, adopt: boolean) => {
    if (adopt) sync.adopt(v);
    if (v === t.value) return; // React bails out on an identical value: no re-render, no effect
    t.value = v;
    shared.as(target); sync.commit(v); shared.as(null);
  };
  shared.as(target); sync.commit(t.value); shared.as(null); // the effect's first run, on mount
  if (listen) t.off = listenPersisted({ target, storage, key, fallback: () => fallback, lastWritten: sync.lastWritten, onValue: v => change(v, true) });
  return { t, set: (v: T) => change(v, false) };
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
    const shared = sharedStorage();
    const a = tab(shared, 'dashboard.settings', fallback);
    const b = tab(shared, 'dashboard.settings', fallback);
    shared.drain();
    a.set({ ...a.t.value, theme: 'dark' });
    shared.drain();
    b.set({ ...b.t.value, fontScale: 125 });
    shared.drain();
    assert.deepStrictEqual(JSON.parse(shared.data.get('dashboard.settings') ?? 'null'), { theme: 'dark', fontScale: 125 });
    assert.deepStrictEqual(a.t.value, { theme: 'dark', fontScale: 125 }, 'tab A follows B’s patch too');
  });

  t('clobber regression, mirror: a tab that does not listen undoes the other tab’s change (what the listener fixes)', () => {
    const fallback = { theme: 'graphite', fontScale: 100 };
    const shared = sharedStorage();
    const a = tab(shared, 'dashboard.settings', fallback, false);
    const b = tab(shared, 'dashboard.settings', fallback, false);
    a.set({ ...a.t.value, theme: 'dark' });
    shared.drain();
    b.set({ ...b.t.value, fontScale: 125 });
    assert.deepStrictEqual(JSON.parse(shared.data.get('dashboard.settings') ?? 'null'), { theme: 'graphite', fontScale: 125 });
  });

  t('two builds whose fallbacks order the keys differently settle after one exchange instead of trading writes', () => {
    const shared = sharedStorage();
    const a = tab(shared, 'k', { a: 1, b: 1 });
    const b = tab(shared, 'k', { a: 1, c: 1, b: 1 });
    shared.drain();
    a.set({ ...a.t.value, a: 2 });
    const delivered = shared.drain();
    assert.strictEqual(shared.queue.length, 0, 'the tabs are still answering each other');
    assert.ok(delivered <= 2, `${delivered} events delivered`);
    assert.strictEqual(b.t.value.a, 2);
    assert.strictEqual(a.t.value.a, 2);
  });

  t('an adopted value is not written back, and the next own change is', () => {
    const s = fakeStorage({ k: '{"b":1,"a":2}' });
    const sync = createPersistedSync<{ a: number; b: number }>(() => s, 'k');
    const v = readPersisted(() => s, 'k', { a: 1, b: 1 });
    sync.adopt(v);
    sync.commit(v);
    assert.strictEqual(s.data.get('k'), '{"b":1,"a":2}', 'the other tab’s string is left as it was');
    assert.strictEqual(sync.lastWritten(), '{"b":1,"a":2}');
    sync.commit({ a: 3, b: 1 });
    assert.strictEqual(s.data.get('k'), '{"a":3,"b":1}');
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
