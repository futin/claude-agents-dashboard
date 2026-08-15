/**
 * settings.ts — the per-device settings behind the Settings section.
 *
 * Everything here lives in `localStorage['dashboard.settings']` and never
 * reaches the server. That is the design, not laziness: a phone propped on the
 * desk wants 5 rows in a light theme and a slow poll; the laptop wants 20 rows,
 * the dark theme and 3 seconds. Sharing them would make one device wrong.
 *
 * The three scan knobs (maxSessions / lookbackHours / activeWindowMin) do reach
 * the server, but as query params on the poll it already makes — request input,
 * not stored state. See `server/api.ts` `scanOverrides`.
 *
 * ⚠️ Keep this object FLAT. `usePersistedState` shallow-merges a stored value
 * over the defaults (`{ ...fallback, ...parsed }`), which is one level deep — a
 * nested object written by an older release would never gain a newly-added
 * inner field's default.
 *
 * See `docs/subsystems/settings.md`.
 */

import type { Section } from '../components/SideRail';

export const THEMES = [
  { id: 'midnight', label: 'Midnight Radar', hint: 'the original — deep navy scope room' },
  { id: 'graphite', label: 'Graphite', hint: 'neutral dark, no blue cast' },
  { id: 'amber', label: 'Amber CRT', hint: 'black glass and amber phosphor' },
  { id: 'nightshift', label: 'Nightshift', hint: 'deep green radar scope' },
  { id: 'daylight', label: 'Daylight Strip', hint: 'light manila paper, dark ink' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type Density = 'comfortable' | 'compact';
/** Which section opens on load. `last` restores whatever you were on. */
export type Landing = Section | 'last';

export interface Settings {
  theme: ThemeId;
  density: Density;
  /** Percent. Applied as a `zoom` factor on <body>. */
  fontScale: number;
  /** Poll interval for the live views, in ms. */
  refreshMs: number;
  maxSessions: number;
  lookbackHours: number;
  activeWindowMin: number;
  landing: Landing;
  alertsEnabled: boolean;
  alertsSound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  density: 'comfortable',
  fontScale: 100,
  refreshMs: 3000,
  maxSessions: 10,
  lookbackHours: 24,
  activeWindowMin: 5,
  landing: 'last',
  alertsEnabled: false,
  alertsSound: false
};

/**
 * Allowed ranges. The upper bounds mirror the server's own caps in
 * `api.ts` `SCAN_CAPS` — a value the server would clamp anyway should never be
 * offered here, or the UI would show a number the rows don't reflect.
 */
export const LIMITS = {
  fontScale: { min: 80, max: 130 },
  refreshMs: { min: 1000, max: 60_000 },
  maxSessions: { min: 1, max: 50 },
  lookbackHours: { min: 1, max: 168 },
  activeWindowMin: { min: 1, max: 120 }
} as const;

export const REFRESH_CHOICES = [1000, 2000, 3000, 5000, 10_000, 30_000];
export const FONT_SCALES = [90, 100, 110, 120];

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function pickOne<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const THEME_IDS = THEMES.map(t => t.id);
const LANDINGS: Landing[] = ['last', 'sessions', 'management', 'analytics', 'settings'];

/**
 * Coerce anything (a stored blob from an older release, a hand-edited
 * localStorage value) into usable settings. Pure — every field falls back
 * independently, so one bad key can't discard the rest.
 */
export function clampSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    theme: pickOne(s.theme, THEME_IDS, DEFAULT_SETTINGS.theme),
    density: pickOne(s.density, ['comfortable', 'compact'] as const, DEFAULT_SETTINGS.density),
    fontScale: clampNumber(s.fontScale, DEFAULT_SETTINGS.fontScale, LIMITS.fontScale.min, LIMITS.fontScale.max),
    refreshMs: clampNumber(s.refreshMs, DEFAULT_SETTINGS.refreshMs, LIMITS.refreshMs.min, LIMITS.refreshMs.max),
    maxSessions: clampNumber(s.maxSessions, DEFAULT_SETTINGS.maxSessions, LIMITS.maxSessions.min, LIMITS.maxSessions.max),
    lookbackHours: clampNumber(s.lookbackHours, DEFAULT_SETTINGS.lookbackHours, LIMITS.lookbackHours.min, LIMITS.lookbackHours.max),
    activeWindowMin: clampNumber(s.activeWindowMin, DEFAULT_SETTINGS.activeWindowMin, LIMITS.activeWindowMin.min, LIMITS.activeWindowMin.max),
    landing: pickOne(s.landing, LANDINGS, DEFAULT_SETTINGS.landing),
    alertsEnabled: typeof s.alertsEnabled === 'boolean' ? s.alertsEnabled : DEFAULT_SETTINGS.alertsEnabled,
    alertsSound: typeof s.alertsSound === 'boolean' ? s.alertsSound : DEFAULT_SETTINGS.alertsSound
  };
}

/** The scan knobs as the query string `GET /api/sessions` takes. */
export function scanQuery(s: Settings): string {
  return `?limit=${s.maxSessions}&lookback=${s.lookbackHours}&active=${s.activeWindowMin}`;
}

/** "3s" / "500ms" — for the footer's live-refresh note. */
export function formatInterval(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
