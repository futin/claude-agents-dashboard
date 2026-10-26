import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { onPersistedReset } from '../lib/persistedReset';

/**
 * useState backed by localStorage. Reads + parses the stored value once (lazy
 * init), writes JSON on every change. Fail-open: missing/bad JSON or a throwing
 * localStorage (private mode / quota) falls back to `fallback` and never crashes
 * render. Objects are shallow-merged over `fallback` so a stored value written by
 * an older release still gains any newly-added field's default. Settings › Reset
 * puts a mounted holder back on `fallback` (`lib/persistedReset.ts`).
 */
export function usePersistedState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...fallback, ...parsed }
        : parsed;
    } catch {
      return fallback;
    }
  });

  // A ref, so a caller passing a fresh object literal each render does not re-subscribe.
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => onPersistedReset(key, () => setValue(fallbackRef.current)), [key]);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore: private mode / quota */
    }
  }, [key, value]);

  return [value, setValue];
}
