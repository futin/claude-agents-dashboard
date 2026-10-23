/**
 * routine-config.ts — the config-derived facts routines need: which machine this is, where the folders live, and the environment baked into
 * every installed job and `/run` spawn. Pure over `Config` plus injectable host reads, so tests never depend on the machine they run on.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.js';

export interface RoutineHost {
  platform: NodeJS.Platform;
  /** Contents of `/proc/version`, or null when unreadable (macOS, a container without procfs). */
  readProcVersion: () => string | null;
  env: Record<string, string | undefined>;
  homedir: () => string;
  /** The login name, for when `USER`/`LOGNAME` are unset (a server started by launchd or a bare `env -i`). */
  username: () => string;
  exists: (p: string) => boolean;
}

function readProcVersion(): string | null {
  try {
    return fs.readFileSync('/proc/version', 'utf8');
  } catch {
    return null;
  }
}

function username(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

const realHost = (): RoutineHost => ({ platform: process.platform, readProcVersion, env: process.env, homedir: os.homedir, username, exists: fs.existsSync });

/** The default job folder, and both default folders' names from before Schedules became Routines (2026-10-23). */
export const DEFAULT_ROUTINES_DIR = '~/claude-global/routines';
const LEGACY_ROUTINES_DIR = '~/claude-global/schedules';
const LEGACY_STATE = path.join('.claude', 'schedules');

/** A default folder under its old name while only that one exists. `orLegacy` in `plugin/lib/run-routine.mjs` picks the same, so both sides agree. */
function orLegacy(next: string, old: string, host: RoutineHost): string {
  return !host.exists(next) && host.exists(old) ? old : next;
}

/** `$HOME` as the wrapper sees it (`process.env.HOME || os.homedir()` in `plugin/lib/run-routine.mjs`), so both sides pick the same folders. */
function homeOf(host: RoutineHost): string {
  return host.env.HOME || host.homedir();
}

/** The login name for `USER` and `LOGNAME`: the server's own `USER`, then `LOGNAME`, then the OS account. */
function userOf(host: RoutineHost): string {
  return host.env.USER || host.env.LOGNAME || host.username();
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/**
 * The machine name `bootstrap.sh` and the wrapper agree on. A `ROUTINE_MACHINE` other than `mac`/`wsl` is an error the caller must surface and act on
 * by installing nothing; `name` then carries the detected value so a chip still has something to show.
 */
export function machineName(config: Config, host: Partial<RoutineHost> = {}): { name: 'mac' | 'wsl'; error: string | null } {
  const h = { ...realHost(), ...host };
  const set = config.routineMachine;
  if (set === 'mac' || set === 'wsl') return { name: set, error: null };
  // Mirrors bootstrap.sh: Darwin is mac, a microsoft kernel is wsl, and anything else is wsl too — the last two agree on purpose, so no host is unnamed.
  const detected = h.platform === 'darwin' ? 'mac' : /microsoft/i.test(h.readProcVersion() ?? '') ? 'wsl' : 'wsl';
  return { name: detected, error: set === '' ? null : 'bad ROUTINE_MACHINE' };
}

export function routineStateRoot(config: Config, host: Partial<RoutineHost> = {}): string {
  const h = { ...realHost(), ...host };
  const home = homeOf(h);
  return config.routinesStateRoot ? expandHome(config.routinesStateRoot, home) : orLegacy(path.join(home, '.claude', 'routines'), path.join(home, LEGACY_STATE), h);
}

/**
 * The owner's one-time move of `~/.claude/schedules` to `~/.claude/routines`, before it claims the folder. Skipped under the seam, once the new folder
 * exists, and while any job holds a lock: a running wrapper would go on writing to the old path. Returns whether it moved.
 */
export function migrateLegacyState(config: Config, host: Partial<RoutineHost> = {}): boolean {
  const h = { ...realHost(), ...host };
  if (config.routinesStateRoot) return false;
  const home = homeOf(h);
  const next = path.join(home, '.claude', 'routines');
  const old = path.join(home, LEGACY_STATE);
  if (h.exists(next) || !h.exists(old)) return false;
  let locks: string[] = [];
  try { locks = fs.readdirSync(path.join(old, 'locks')); } catch { /* no locks folder: nothing running */ }
  if (locks.some((f) => f.endsWith('.lock'))) return false;
  fs.renameSync(old, next);
  return true;
}

export function routineDirs(config: Config, host: Partial<RoutineHost> = {}): { routines: string; state: string; runs: string; locks: string; launchd: string } {
  const h = { ...realHost(), ...host };
  const state = routineStateRoot(config, h);
  return {
    routines: config.routinesDir === DEFAULT_ROUTINES_DIR
      ? orLegacy(expandHome(DEFAULT_ROUTINES_DIR, homeOf(h)), expandHome(LEGACY_ROUTINES_DIR, homeOf(h)), h)
      : expandHome(config.routinesDir, homeOf(h)),
    state,
    runs: path.join(state, 'runs'),
    locks: path.join(state, 'locks'),
    launchd: path.join(state, 'launchd')
  };
}

/**
 * The environment baked into a plist, a crontab line and a `/run` spawn: `.env` values live in `Config`, never in `process.env`, and launchd and cron
 * give a job no shell rc. Exactly these keys — the wrapper's `PATH`/`HOME`/`USER`/`LOGNAME` are the server's own, everything else comes from `Config`.
 * `USER` is load-bearing on macOS: the `claude` CLI finds its claude.ai login in the Keychain by that account name, and without it reports
 * "Not logged in · Please run /login".
 */
export function routineEnv(config: Config, host: Partial<RoutineHost> = {}): Record<string, string> {
  const h = { ...realHost(), ...host };
  return {
    PATH: h.env.PATH ?? '',
    HOME: homeOf(h),
    USER: userOf(h),
    LOGNAME: userOf(h),
    CLAUDE_BIN: config.claudeBin,
    SPAWN_MAX_PERMISSION: config.spawnMaxPermission,
    SYNC_PERMISSION_MODE: config.syncPermissionMode,
    ROUTINE_MACHINE: machineName(config, h).name,
    ROUTINES_DIR: routineDirs(config, h).routines
  };
}
