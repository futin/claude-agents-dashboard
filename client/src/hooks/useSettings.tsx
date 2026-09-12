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

/**
 * View-state keys the Reset button clears alongside the settings themselves.
 *
 * Every `usePersistedState` key in the app except `dashboard.answerToken`,
 * which is a credential rather than a view state: Reset is a "put the board
 * back the way it shipped" button, not a sign-out, and clearing the token would
 * silently disarm every write path (see remote-answer.md).
 */
export const OWNED_KEYS = [
  'dashboard.view', 'dashboard.layout', 'dashboard.section', 'dashboard.chatFilter',
  'dashboard.analyticsView', 'management.scope', 'management.type', 'management.collapsed'
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

  // Theme, density and width are pure CSS: everything downstream keys off these
  // attributes, so no component re-renders when they change. The same attributes
  // are stamped pre-paint by the inline script in index.html — this effect keeps
  // them in step afterwards.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.density = settings.density;
    root.dataset.width = settings.contentWidth;
    root.style.setProperty('--font-scale', String(settings.fontScale / 100));
  }, [settings.theme, settings.density, settings.contentWidth, settings.fontScale]);

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
