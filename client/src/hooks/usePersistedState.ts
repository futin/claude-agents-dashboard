import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { onPersistedReset } from '../lib/persistedReset';
import { createPersistedSync, listenPersisted, readPersisted } from '../lib/persistedValue';

const browserStorage = () => (typeof localStorage === 'undefined' ? undefined : localStorage);

/**
 * useState backed by localStorage. Reads + parses the stored value on mount (lazy
 * init), writes JSON on every change. Fail-open: missing/bad JSON or a throwing
 * localStorage (private mode / quota) falls back to `fallback` and never crashes
 * render. Objects are shallow-merged over `fallback` so a stored value written by
 * an older release still gains any newly-added field's default. Another tab's
 * write to the key, or its clear, is followed and not written back
 * (`lib/persistedValue.ts`), so the last tab to write no longer undoes the
 * others. Settings › Reset puts a mounted holder back on `fallback`
 * (`lib/persistedReset.ts`).
 */
export function usePersistedState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readPersisted(browserStorage, key, fallback));

  // A ref, so a caller passing a fresh object literal each render does not re-subscribe.
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const sync = useMemo(() => createPersistedSync<T>(browserStorage, key), [key]);
  useEffect(() => onPersistedReset(key, () => setValue(fallbackRef.current)), [key]);
  useEffect(() => listenPersisted({
    target: typeof window === 'undefined' ? undefined : window,
    storage: browserStorage,
    key,
    fallback: () => fallbackRef.current,
    lastWritten: sync.lastWritten,
    onValue: v => {
      sync.adopt(v);
      setValue(v);
    }
  }), [key, sync]);

  useEffect(() => {
    sync.commit(value);
  }, [sync, value]);

  return [value, setValue];
}
