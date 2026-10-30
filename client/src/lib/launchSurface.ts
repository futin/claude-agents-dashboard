import type { LaunchSurface } from '../../../shared/types';

/** Dashboard-first, so a host that offers both lists the long-standing choice on the left. */
const ORDER: LaunchSurface[] = ['dashboard', 'desktop'];

/**
 * The surfaces the launch form offers. Each flag is `HealthResponse`'s, absent until the poll answers or on an older server, so only a literal `true` counts: a
 * surface that might not work is not offered.
 */
export function offeredSurfaces(spawnAvailable: boolean | undefined, desktopAvailable: boolean | undefined): LaunchSurface[] {
  const on: Record<LaunchSurface, boolean> = { dashboard: spawnAvailable === true, desktop: desktopAvailable === true };
  return ORDER.filter(s => on[s]);
}

/** The surface the form starts on: the server's default setting when the host offers it, else the first one offered; null when none is. */
export function initialSurface(offered: LaunchSurface[], preferred: LaunchSurface | undefined): LaunchSurface | null {
  if (preferred && offered.includes(preferred)) return preferred;
  return offered[0] ?? null;
}

/** Whether New session has anything to open — the two entry points hide it otherwise. */
export const canOpenLaunchForm = (spawnAvailable: boolean | undefined, desktopAvailable: boolean | undefined): boolean =>
  offeredSurfaces(spawnAvailable, desktopAvailable).length > 0;

// Spec decision 12: fixed copy, since the dashboard has no toast and each line shows where the action was taken.
/** The line over the session list after a launch-form desktop launch. */
export const DESKTOP_LAUNCHED_TEXT = 'Opened in the desktop app — the row appears in a few seconds.';
/** Beside a hand-over action once the app was opened. */
export const DESKTOP_OPENED_TEXT = 'Opened in the desktop app.';
/** Where the success line would show, on a 500 `open failed`. */
export const DESKTOP_FAILED_TEXT = "Couldn't open the desktop app.";
/** Beside the disabled hand-over button while the session is alive. */
export const DESKTOP_STOP_FIRST_TEXT = 'Stop it first';
/** Beside the disabled hand-over button once the app already holds the session. */
export const DESKTOP_OWNED_TEXT = 'Already open in the desktop app';
/** Under the launch-form controls a desktop launch ignores. */
export const DESKTOP_DEFAULTS_NOTE = "The desktop app's own defaults apply to these.";
