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

import { SECTIONS, type Section } from './sections';
import { EFFORTS, MODELS } from './spawnOptions';

export const THEMES = [
  { id: 'midnight', label: 'Midnight Radar', hint: 'the original — deep navy scope room' },
  { id: 'graphite', label: 'Graphite', hint: 'neutral dark, no blue cast' },
  { id: 'amber', label: 'Amber CRT', hint: 'black glass and amber phosphor' },
  { id: 'nightshift', label: 'Nightshift', hint: 'deep green radar scope' },
  { id: 'daylight', label: 'Daylight Strip', hint: 'light manila paper, dark ink' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export type Density = 'comfortable' | 'compact';
/** Which sub-view the Usage section opens on. */
export type UsageTab = 'forecast' | 'rates';
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
  /**
   * Ask the server for whole messages instead of the capped ones. Off by
   * default — the drawer is a monitor. Truncation is server-side, so this has
   * to travel as `?full=1` on the chat request; the drawer can't undo a cut
   * that happened before the JSON was written.
   */
  chatFullText: boolean;
  /** Preselected in the launch panel's model picker. '' = leave it on "default" (the `claude` CLI's own choice). */
  spawnDefaultModel: SpawnDefaultModel;
  /** Same as `spawnDefaultModel`, for the effort picker. */
  spawnDefaultEffort: SpawnDefaultEffort;
  /**
   * Show an OS banner + beep in this browser when a dashboard-spawned session
   * starts needing you. Per device on purpose: permission is granted per
   * browser, and the tab has to be open on Sessions for the poll to see it.
   */
  notifyBrowser: boolean;
  /**
   * Which Usage sub-tab is showing. Per device like everything else here: the
   * phone on the desk watches the forecast, the laptop checks token value.
   */
  usageTab: UsageTab;
}

export type SpawnDefaultModel = '' | (typeof MODELS)[number];
export type SpawnDefaultEffort = '' | (typeof EFFORTS)[number];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'midnight',
  density: 'comfortable',
  fontScale: 100,
  refreshMs: 3000,
  maxSessions: 5,
  lookbackHours: 24,
  activeWindowMin: 5,
  landing: 'last',
  chatFullText: false,
  spawnDefaultModel: '',
  spawnDefaultEffort: '',
  notifyBrowser: false,
  usageTab: 'forecast'
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

/** Strict: a stored `"true"` from a hand-edit is not a boolean, so it falls back. */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * What the "Opens on" picker offers, derived from the rail so the picker and
 * the validator below cannot drift apart — every section you can navigate to
 * is a section you can land on.
 */
export const LANDING_OPTIONS: { value: Landing; label: string }[] = [
  { value: 'last', label: 'Last used' },
  ...SECTIONS.map(s => ({ value: s.id as Landing, label: s.label }))
];

const THEME_IDS = THEMES.map(t => t.id);
const LANDINGS: Landing[] = LANDING_OPTIONS.map(o => o.value);
const SPAWN_MODELS: SpawnDefaultModel[] = ['', ...MODELS];
const SPAWN_EFFORTS: SpawnDefaultEffort[] = ['', ...EFFORTS];
const USAGE_TABS: UsageTab[] = ['forecast', 'rates'];

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
    chatFullText: pickBool(s.chatFullText, DEFAULT_SETTINGS.chatFullText),
    spawnDefaultModel: pickOne(s.spawnDefaultModel, SPAWN_MODELS, DEFAULT_SETTINGS.spawnDefaultModel),
    spawnDefaultEffort: pickOne(s.spawnDefaultEffort, SPAWN_EFFORTS, DEFAULT_SETTINGS.spawnDefaultEffort),
    notifyBrowser: pickBool(s.notifyBrowser, DEFAULT_SETTINGS.notifyBrowser),
    usageTab: pickOne(s.usageTab, USAGE_TABS, DEFAULT_SETTINGS.usageTab)
  };
}

/** The scan knobs as the query string `GET /api/sessions` takes. */
export function scanQuery(s: Settings): string {
  return `?limit=${s.maxSessions}&lookback=${s.lookbackHours}&active=${s.activeWindowMin}`;
}

/**
 * The query string `GET /api/sessions/:id/chat` takes. `cursor` is the paging
 * param the caller already has (`after=…` / `before=…`, empty for the tail);
 * this only adds the truncation flag on top, so every one of the drawer's three
 * request shapes stays consistent.
 *
 * Narrowed to the one field it reads, so the drawer's fetch callback depends on
 * that boolean alone — a theme change must not re-tail an open chat.
 */
export function chatQuery(s: Pick<Settings, 'chatFullText'>, cursor = ''): string {
  const parts = [cursor, s.chatFullText ? 'full=1' : ''].filter(Boolean);
  return parts.length ? '?' + parts.join('&') : '';
}

/** "3s" / "500ms" — for the footer's live-refresh note. */
export function formatInterval(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
