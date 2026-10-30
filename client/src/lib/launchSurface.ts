import type { LaunchSurface } from '../../../shared/types';

/** Dashboard-first, so a host that offers both lists the long-standing choice on the left. */
const ORDER: LaunchSurface[] = ['dashboard', 'desktop'];

/**
 * The surfaces the launch form offers. Each flag is `HealthResponse`'s, absent until the poll answers or on an older server, so only a literal `true` counts: a
 * surface that might not work is not offered. Desktop needs both: its first turn runs headless before the session moves to the app.
 */
export function offeredSurfaces(spawnAvailable: boolean | undefined, desktopAvailable: boolean | undefined): LaunchSurface[] {
  const on: Record<LaunchSurface, boolean> = { dashboard: spawnAvailable === true, desktop: spawnAvailable === true && desktopAvailable === true };
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
export const DESKTOP_LAUNCHED_TEXT = 'Running here first — it moves to the desktop app when its first turn ends.';
/** Beside a hand-over action once the app was opened. */
export const DESKTOP_OPENED_TEXT = 'Opened in the desktop app.';
/** Where the success line would show, on a 500 `open failed`. */
export const DESKTOP_FAILED_TEXT = "Couldn't open the desktop app.";
/** Beside the disabled hand-over button while the session is alive. */
export const DESKTOP_STOP_FIRST_TEXT = 'Stop it first';
/** Beside the disabled hand-over button once the app already holds the session. */
export const DESKTOP_OWNED_TEXT = 'Already open in the desktop app';
/** Under the launch-form toggles a desktop launch fixes: remote control off, close when done on. */
export const DESKTOP_HANDOVER_NOTE = 'The first turn runs here, then the session moves to the desktop app.';

/** Settings row hint, first sentence — the default is the server's, so every device's launch form starts on it. */
export const LAUNCH_DEFAULT_HINT = 'Preselects the launch form on every device.';
/** Settings row hint, second sentence when the Mac running the dashboard has the app. */
export const LAUNCH_DEFAULT_DESKTOP_NOTE = 'The desktop app is only on this Mac.';
/** Replaces the second sentence when the health poll does not report the app; the row stays because the setting is shared. */
export const LAUNCH_DEFAULT_DESKTOP_MISSING = 'The desktop app was not found on the Mac running this dashboard.';
