/**
 * desktop.ts — launch work in the Claude desktop app through its `claude://` links (desktop-launch spec).
 *
 * The routes that call this are reachable over LAN and the tailnet, so a link goes to `open` as one argv entry via `execFile` and never through a shell.
 * Two small gates sit here too, both in memory and both bounded by a few seconds: the rail caps how many launches the app is handed at once, and a
 * per-session mark stops a second hand-over of the same session while the first is still in flight.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

import type { OpenRunner } from './open-folder.js';

/** At most this many launches inside one window; the desktop app opens a window per link, so an unbounded burst would flood the screen. */
export const DESKTOP_RAIL_MAX = 4;
/** How long a launch (or a hand-over mark) counts as in flight. */
export const DESKTOP_WINDOW_MS = 5000;

const DEFAULT_APP_PATH = '/Applications/Claude.app';

// The timeout keeps a hung `open` (a stalled LaunchServices) from holding the request open forever.
const defaultRun: OpenRunner = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 5000 }, err => (err ? reject(err) : resolve()));
});

let run: OpenRunner = defaultRun;
let platform: string | null = null;
let appPath: string = DEFAULT_APP_PATH;
let probed: boolean | null = null;

/**
 * `claude://code/new?folder=…&q=…` opens a fresh desktop session in `folder` with `prompt` prefilled.
 *
 * The app cuts `q` at 14336 characters (app 4.4212.0, `app.asar`, read 2026-10-29); `PROMPT_CAP` (4000) must stay below it. These links are undocumented
 * (`docs/subsystems/session-surfaces.md`), so this module is the one place to fix a change in them.
 */
export function newSessionUrl(folder: string, prompt: string): string {
  return 'claude://code/new?' + new URLSearchParams([['folder', folder], ['q', prompt]]).toString();
}

/** `claude://resume?session=<id>` reopens an existing session in the desktop app. */
export function resumeUrl(sessionId: string): string {
  return 'claude://resume?' + new URLSearchParams([['session', sessionId]]).toString();
}

/** True on macOS when the app bundle exists. A `stat`, not `open -Ra`: the probe must launch nothing. Memoised; `resetDesktopProbe` drops it. */
export function desktopAvailable(): boolean {
  if (probed === null) {
    probed = (platform ?? process.platform) === 'darwin' && (() => {
      try { statSync(appPath); return true; } catch { return false; }
    })();
  }
  return probed;
}

export function resetDesktopProbe(): void {
  probed = null;
}

/** `open <url>` through the current runner. */
export function openDesktopUrl(url: string): Promise<void> {
  return run('open', [url]);
}

/**
 * Test seam. A field left `undefined` leaves that seam alone; `null` restores the default — the runner that really launches `open`, `process.platform` and
 * `/Applications/Claude.app`. Moving the platform or the app path drops the probe's memo.
 */
export function overrideDesktop(o: { run?: OpenRunner | null; platform?: string | null; appPath?: string | null }): void {
  if (o.run !== undefined) run = o.run ?? defaultRun;
  if (o.platform !== undefined) { platform = o.platform; probed = null; }
  if (o.appPath !== undefined) { appPath = o.appPath ?? DEFAULT_APP_PATH; probed = null; }
}

type Mark = { at: number; id: string | null };
let marks: Mark[] = [];

function prune(now: number): void {
  marks = marks.filter(m => now - m.at <= DESKTOP_WINDOW_MS);
}

/**
 * Takes a place on the rail for one launch. `handOverId` names the session being handed over (null for a fresh launch). `in-flight` is checked before
 * `rail-full`, so a repeat hand-over reads as "already resuming" rather than as load. On `ok`, `at` is the key to give back to `releaseDesktopLaunch`.
 */
export function reserveDesktopLaunch(handOverId: string | null, now: number = Date.now()): { status: 'ok'; at: number } | { status: 'rail-full' | 'in-flight' } {
  prune(now);
  if (handOverId !== null && marks.some(m => m.id === handOverId)) return { status: 'in-flight' };
  if (marks.length >= DESKTOP_RAIL_MAX) return { status: 'rail-full' };
  marks.push({ at: now, id: handOverId });
  return { status: 'ok', at: now };
}

/** Gives back the one place taken at `at` for `handOverId` (when `open` failed). Entries sharing the `at` but not the id are left alone. */
export function releaseDesktopLaunch(handOverId: string | null, at: number): void {
  const i = marks.findIndex(m => m.at === at && m.id === handOverId);
  if (i >= 0) marks.splice(i, 1);
}

/** A live mark exists for this session: its hand-over is still inside the window. */
export function handOverInFlight(id: string, now: number = Date.now()): boolean {
  return marks.some(m => m.id === id && now - m.at <= DESKTOP_WINDOW_MS);
}

export function resetDesktopRail(): void {
  marks = [];
}
