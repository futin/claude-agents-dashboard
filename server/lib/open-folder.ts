/**
 * open-folder.ts — reveal a pinned project's folder in Finder via macOS `open` (management redesign spec §6.3).
 *
 * The route that calls this is reachable over LAN and the tailnet, so the path goes to `execFile` as one argv entry and never through a shell: a path with
 * spaces, quotes or `;` is a file name, not a command line. The membership gate lives in `api.ts`; this module only runs the command.
 */

import { execFile } from 'node:child_process';

/** Runs `cmd` with `args`, resolving when it exits 0 and rejecting with the error otherwise. */
export type OpenRunner = (cmd: string, args: string[]) => Promise<void>;

// The timeout keeps a hung `open` (a stalled LaunchServices) from holding the request open forever.
const defaultRun: OpenRunner = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 5000 }, err => (err ? reject(err) : resolve()));
});

let run: OpenRunner = defaultRun;
let platform: string | null = null;

/** The platform the gate checks: the test override, else `process.platform`. */
export function openFolderPlatform(): string {
  return platform ?? process.platform;
}

/** `open <path>` through the current runner. */
export function openFolder(path: string): Promise<void> {
  return run('open', [path]);
}

/** `open -R <path>`: Finder opens the enclosing folder with the file selected, rather than opening the file in its default app. */
export function revealFile(path: string): Promise<void> {
  return run('open', ['-R', path]);
}

/**
 * Test seam. A field left `undefined` leaves that seam alone; `null` restores the default — the runner that really launches `open`, and `process.platform`.
 */
export function overrideOpenFolder(o: { run?: OpenRunner | null; platform?: string | null }): void {
  if (o.run !== undefined) run = o.run ?? defaultRun;
  if (o.platform !== undefined) platform = o.platform;
}
