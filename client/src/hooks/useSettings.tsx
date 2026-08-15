import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { usePersistedState } from './usePersistedState';
import { clampSettings, DEFAULT_SETTINGS, type Settings } from '../lib/settings';

interface SettingsControl {
  settings: Settings;
  /** Merge a partial change. Always re-clamped, so no caller can store a bad value. */
  update: (patch: Partial<Settings>) => void;
  /** Back to defaults, and clear the other view-state keys with it. */
  reset: () => void;
}

const SettingsContext = createContext<SettingsControl | null>(null);

/** View-state keys the Reset button clears alongside the settings themselves. */
const OWNED_KEYS = [
  'dashboard.view', 'dashboard.section', 'dashboard.chatFilter',
  'dashboard.analyticsView', 'management.scope', 'management.collapsed'
];

/**
 * Per-device settings for the whole app.
 *
 * A context rather than props because the consumers are scattered and deep: four
 * polling hooks want `refreshMs`, the sessions poll wants the scan knobs, and
 * the alert hook wants two booleans. Prop-drilling that through
 * App → SessionsView → ChatDrawer would touch every component in between for no
 * gain.
 *
 * Storage is the existing `usePersistedState`, which already shallow-merges the
 * stored blob over the defaults — so a value written before a field existed
 * still picks that field's default up. `clampSettings` runs on top of the merge
 * to bound anything hand-edited or left over from an older release.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = usePersistedState<Settings>('dashboard.settings', DEFAULT_SETTINGS);
  const settings = useMemo(() => clampSettings(stored), [stored]);

  const update = useCallback(
    (patch: Partial<Settings>) => setStored(clampSettings({ ...settings, ...patch })),
    [settings, setStored]
  );

  const reset = useCallback(() => {
    for (const key of OWNED_KEYS) {
      try { localStorage.removeItem(key); } catch { /* private mode — ignore */ }
    }
    setStored(DEFAULT_SETTINGS);
  }, [setStored]);

  // Theme and density are pure CSS: everything downstream keys off these two
  // attributes, so no component re-renders when they change. The same attribute
  // is stamped pre-paint by the inline script in index.html — this effect keeps
  // it in step afterwards.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.density = settings.density;
    root.style.setProperty('--font-scale', String(settings.fontScale / 100));
  }, [settings.theme, settings.density, settings.fontScale]);

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/**
 * The current settings. Falls back to the defaults outside a provider so a
 * component rendered in isolation (or a test) still works — the settings are a
 * preference layer, never a precondition.
 */
export function useSettings(): SettingsControl {
  const ctx = useContext(SettingsContext);
  return ctx ?? { settings: DEFAULT_SETTINGS, update: () => {}, reset: () => {} };
}
