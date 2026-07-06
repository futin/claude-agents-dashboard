import { useEffect, useState } from 'react';

/**
 * useState backed by localStorage. Reads + parses the stored value once (lazy
 * init), writes JSON on every change. Fail-open: missing/bad JSON or a throwing
 * localStorage (private mode / quota) falls back to `fallback` and never crashes
 * render. Objects are shallow-merged over `fallback` so a stored value written by
 * an older release still gains any newly-added field's default.
 */
export function usePersistedState<T>(key: string, fallback: T): [T, (v: T) => void] {
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

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore: private mode / quota */
    }
  }, [key, value]);

  return [value, setValue];
}
