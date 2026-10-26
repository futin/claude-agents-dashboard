/**
 * Settings › Reset's reach into live `usePersistedState` holders.
 *
 * Removing a key from localStorage is not enough on its own: a mounted holder (the always-mounted `ConfigsScopeProvider`, `App`'s section) keeps its
 * in-memory value, draws it until reload, and writes it back on its next change. Each holder subscribes to its key here, and a reset tells it to fall
 * back to its default.
 */

const listeners = new Map<string, Set<() => void>>();

/** Run `fn` whenever `key` is reset. Returns the unsubscribe. */
export function onPersistedReset(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (set === undefined) listeners.set(key, set = new Set());
  set.add(fn);
  return () => { set.delete(fn); };
}

/** Remove each key from localStorage, then tell every mounted holder of it to return to its default. */
export function resetPersisted(keys: readonly string[]): void {
  for (const key of keys) {
    try { localStorage.removeItem(key); } catch { /* private mode — ignore */ }
  }
  for (const key of keys) {
    for (const fn of [...(listeners.get(key) ?? [])]) fn();
  }
}
