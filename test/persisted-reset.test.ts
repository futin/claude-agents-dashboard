import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onPersistedReset, resetPersisted } from '../client/src/lib/persistedReset.js';

const CLIENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src');

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export function run(): number {
  console.log('\n=== persistedReset.ts ===\n');
  let p = 0, f = 0;

  if (test('resetPersisted notifies only the holders of the listed keys', () => {
    const hits: string[] = [];
    const offA = onPersistedReset('t.a', () => hits.push('a'));
    const offB = onPersistedReset('t.b', () => hits.push('b'));
    const offA2 = onPersistedReset('t.a', () => hits.push('a2'));
    resetPersisted(['t.a', 't.none']);
    assert.deepStrictEqual(hits.sort(), ['a', 'a2']);
    offA(); offB(); offA2();
  })) p++; else f++;

  if (test('an unsubscribed holder is not notified', () => {
    const hits: string[] = [];
    const off = onPersistedReset('t.c', () => hits.push('c'));
    off();
    resetPersisted(['t.c']);
    assert.deepStrictEqual(hits, []);
  })) p++; else f++;

  if (test('resetPersisted removes each key from localStorage before notifying', () => {
    const store = new Map<string, string>([['t.d', '"x"'], ['t.keep', '"y"']]);
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { removeItem: (k: string) => { store.delete(k); } };
    try {
      let seen: boolean | null = null;
      const off = onPersistedReset('t.d', () => { seen = store.has('t.d'); });
      resetPersisted(['t.d']);
      off();
      assert.strictEqual(seen, false);
      assert.ok(store.has('t.keep'));
    } finally { g.localStorage = prev; }
  })) p++; else f++;

  // The wiring is two React hooks, which this runner cannot mount; the source is what can be pinned.
  if (test('usePersistedState subscribes to the reset, and Settings › Reset goes through resetPersisted', () => {
    const hook = readFileSync(resolve(CLIENT_SRC, 'hooks', 'usePersistedState.ts'), 'utf8');
    assert.match(hook, /onPersistedReset\(key,/);
    const settings = readFileSync(resolve(CLIENT_SRC, 'hooks', 'useSettings.tsx'), 'utf8');
    assert.match(settings, /resetPersisted\(OWNED_KEYS\)/);
  })) p++; else f++;

  console.log(`\npersistedReset: ${p} passed, ${f} failed`);
  return f;
}
