/**
 * persistedValue.ts — the storage half of `usePersistedState`, with no React in it so the tests can drive it without a DOM.
 *
 * The hook used to read its key once on mount and only write after, so two tabs holding one key each kept their own copy and the last to write won the
 * whole key: tab B, still holding the old `dashboard.settings`, put tab A's theme back on its next change (#520). `listenPersisted` follows the `storage`
 * event the browser fires in every other tab, so a holder's value is the stored one before it patches it. `storage` is a getter because Node has no
 * `localStorage` at import time, the way `createAnswerTokenStore` takes it.
 */

type GetStorage = () => Storage | undefined;

/**
 * Parse `key` out of storage. Fail-open: missing or bad JSON, or a throwing storage (private mode), gives `fallback`. A stored object is shallow-merged
 * over `fallback`, so a value written by an older release still gains any newly-added field's default; arrays and scalars come back as they are.
 */
export function readPersisted<T>(storage: GetStorage, key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...fallback, ...parsed }
      : parsed;
  } catch {
    return fallback;
  }
}

/** Store `value` as JSON and return that JSON, which is what `listenPersisted`'s `lastWritten` compares against. A throwing storage is ignored. */
export function writePersisted<T>(storage: GetStorage, key: string, value: T): string {
  const json = JSON.stringify(value);
  try {
    storage()?.setItem(key, json);
  } catch {
    /* ignore: private mode / quota */
  }
  return json;
}

export interface ListenOptions<T> {
  /** Where `storage` events arrive: `window` in the browser. */
  target: EventTarget | undefined;
  storage: GetStorage;
  key: string;
  fallback: () => T;
  /** The JSON this holder last wrote; an event carrying exactly that is our own value coming back, and changes nothing. */
  lastWritten: () => string | null;
  onValue: (value: T) => void;
}

/**
 * Re-read `key` whenever another tab changes it, or clears the whole storage (an event with `key` null), and hand the value to `onValue`. Events for other
 * keys are ignored. Returns the unsubscribe.
 */
export function listenPersisted<T>({ target, storage, key, fallback, lastWritten, onValue }: ListenOptions<T>): () => void {
  const onStorage = (e: Event) => {
    const { key: changed, newValue } = e as StorageEvent;
    if (changed !== null && changed !== key) return;
    if (newValue !== null && newValue === lastWritten()) return;
    onValue(readPersisted(storage, key, fallback()));
  };
  target?.addEventListener('storage', onStorage);
  return () => target?.removeEventListener('storage', onStorage);
}

export interface PersistedSync<T> {
  /** The JSON last written by this holder, or last adopted from another tab — `listenPersisted`'s `lastWritten`. */
  lastWritten(): string | null;
  /** A value `listenPersisted` re-read from another tab: the holder is about to show it, and `commit` must not write it back. */
  adopt(value: T): void;
  /** Run on every change of the holder's value; writes it unless it is the value just adopted. */
  commit(value: T): void;
}

/**
 * The write side of one holder. An adopted value is never written back: `readPersisted` merges it over THIS tab's fallback, so a tab on another build,
 * whose fallback orders the keys differently, would read our write-back as a change and answer with its own, and the two would trade writes forever.
 */
export function createPersistedSync<T>(storage: GetStorage, key: string): PersistedSync<T> {
  let last: string | null = null;
  let adopted: { value: T } | null = null;
  return {
    lastWritten: () => last,
    adopt(value) {
      adopted = { value };
      try {
        last = storage()?.getItem(key) ?? null;
      } catch {
        last = null;
      }
    },
    commit(value) {
      const skip = adopted !== null && adopted.value === value;
      adopted = null;
      if (!skip) last = writePersisted(storage, key, value);
    }
  };
}
