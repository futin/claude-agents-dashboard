import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ANSWER_TOKEN_KEY, authHeaders, createAnswerTokenStore } from '../client/src/lib/answerToken.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A Map-backed stand-in for `localStorage` — only the two methods the store calls. */
function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); }
  } as unknown as Storage & { data: Map<string, string> };
}

/** A `storage` event as another tab (or devtools) fires it on `window`. */
function storageEvent(key: string | null): Event {
  return Object.assign(new Event('storage'), { key });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

export function run(): number {
  console.log('answer-token');
  let failed = 0;
  const t = (name: string, fn: () => void) => { if (!test(name, fn)) failed++; };

  t('reads the JSON-encoded value usePersistedState wrote under the same key', () => {
    const store = createAnswerTokenStore(() => fakeStorage({ [ANSWER_TOKEN_KEY]: '"abc"' }));
    assert.strictEqual(store.get(), 'abc');
  });

  t('missing, malformed or non-string stored values read as no token', () => {
    assert.strictEqual(createAnswerTokenStore(() => fakeStorage()).get(), '');
    assert.strictEqual(createAnswerTokenStore(() => fakeStorage({ [ANSWER_TOKEN_KEY]: '{oops' })).get(), '');
    assert.strictEqual(createAnswerTokenStore(() => fakeStorage({ [ANSWER_TOKEN_KEY]: '42' })).get(), '');
    assert.strictEqual(createAnswerTokenStore(() => undefined).get(), '');
  });

  t('a throwing localStorage reads as no token and set still updates in memory', () => {
    const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } } as unknown as Storage;
    const store = createAnswerTokenStore(() => boom);
    assert.strictEqual(store.get(), '');
    store.set('t1');
    assert.strictEqual(store.get(), 't1');
  });

  t('a token set by one consumer is what every sibling subscriber reads next', () => {
    const storage = fakeStorage();
    const store = createAnswerTokenStore(() => storage);
    const seen: string[] = [];
    const a = store.subscribe(() => seen.push('a:' + store.get()));
    const b = store.subscribe(() => seen.push('b:' + store.get()));
    assert.strictEqual(store.get(), '');
    store.set('fresh');
    assert.deepStrictEqual(seen, ['a:fresh', 'b:fresh']);
    assert.strictEqual(storage.data.get(ANSWER_TOKEN_KEY), '"fresh"');
    a(); b();
  });

  t('setting the same value again notifies nobody', () => {
    const store = createAnswerTokenStore(() => fakeStorage({ [ANSWER_TOKEN_KEY]: '"same"' }));
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    store.set('same');
    assert.strictEqual(calls, 0);
    off();
  });

  t('an unsubscribed listener is not called', () => {
    const store = createAnswerTokenStore(() => fakeStorage());
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    off();
    store.set('x');
    assert.strictEqual(calls, 0);
  });

  t('a storage event for the key re-reads localStorage and notifies', () => {
    const storage = fakeStorage();
    const target = new EventTarget();
    const store = createAnswerTokenStore(() => storage, target);
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    assert.strictEqual(store.get(), '');
    storage.data.set(ANSWER_TOKEN_KEY, '"from-other-tab"');
    target.dispatchEvent(storageEvent(ANSWER_TOKEN_KEY));
    assert.strictEqual(store.get(), 'from-other-tab');
    assert.strictEqual(calls, 1);
    off();
  });

  t('a storage event for another key is ignored; a cleared storage (key null) is re-read', () => {
    const storage = fakeStorage({ [ANSWER_TOKEN_KEY]: '"kept"' });
    const target = new EventTarget();
    const store = createAnswerTokenStore(() => storage, target);
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    assert.strictEqual(store.get(), 'kept');
    target.dispatchEvent(storageEvent('dashboard.settings'));
    assert.strictEqual(calls, 0);
    storage.data.clear();
    target.dispatchEvent(storageEvent(null));
    assert.strictEqual(store.get(), '');
    assert.strictEqual(calls, 1);
    off();
  });

  t('the storage listener is dropped once the last subscriber leaves', () => {
    const storage = fakeStorage();
    const target = new EventTarget();
    const store = createAnswerTokenStore(() => storage, target);
    let calls = 0;
    store.subscribe(() => { calls++; })();
    storage.data.set(ANSWER_TOKEN_KEY, '"late"');
    target.dispatchEvent(storageEvent(ANSWER_TOKEN_KEY));
    assert.strictEqual(calls, 0);
  });

  t('authHeaders adds a Bearer header only when there is a token, keeping the rest', () => {
    assert.deepStrictEqual(authHeaders(''), {});
    assert.deepStrictEqual(authHeaders('', { 'Content-Type': 'application/json' }), { 'Content-Type': 'application/json' });
    assert.deepStrictEqual(authHeaders('tok', { 'Content-Type': 'application/json' }),
      { 'Content-Type': 'application/json', Authorization: 'Bearer tok' });
  });

  t('no client file keeps its own answer-token copy or builds a Bearer header by hand', () => {
    const root = join(import.meta.dirname, '..', 'client', 'src');
    const offenders = walk(root).filter((p) => {
      if (p.endsWith(join('lib', 'answerToken.ts'))) return false;
      const src = readFileSync(p, 'utf8');
      return /usePersistedState[^(]*\(\s*'dashboard\.answerToken'/.test(src) || /`Bearer \$\{/.test(src);
    });
    assert.deepStrictEqual(offenders, []);
  });

  return failed;
}
