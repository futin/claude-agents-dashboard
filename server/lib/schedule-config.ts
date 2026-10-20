/**
 * schedule-config.ts — the config-derived facts scheduled workflows need: which machine this is, where the folders live, and the environment baked into
 * every installed job and `/run` spawn. Pure over `Config` plus injectable host reads, so tests never depend on the machine they run on.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from './config.js';

export interface ScheduleHost {
  platform: NodeJS.Platform;
  /** Contents of `/proc/version`, or null when unreadable (macOS, a container without procfs). */
  readProcVersion: () => string | null;
  env: Record<string, string | undefined>;
  homedir: () => string;
}

function readProcVersion(): string | null {
  try {
    return fs.readFileSync('/proc/version', 'utf8');
  } catch {
    return null;
  }
}

const realHost = (): ScheduleHost => ({ platform: process.platform, readProcVersion, env: process.env, homedir: os.homedir });

/** `$HOME` as the wrapper sees it (`process.env.HOME || os.homedir()` in `plugin/lib/run-schedule.mjs`), so both sides pick the same folders. */
function homeOf(host: ScheduleHost): string {
  return host.env.HOME || host.homedir();
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/**
 * The machine name `bootstrap.sh` and the wrapper agree on. A `SCHEDULE_MACHINE` other than `mac`/`wsl` is an error the caller must surface and act on
 * by installing nothing; `name` then carries the detected value so a chip still has something to show.
 */
export function machineName(config: Config, host: Partial<ScheduleHost> = {}): { name: 'mac' | 'wsl'; error: string | null } {
  const h = { ...realHost(), ...host };
  const set = config.scheduleMachine;
  if (set === 'mac' || set === 'wsl') return { name: set, error: null };
  // Mirrors bootstrap.sh: Darwin is mac, a microsoft kernel is wsl, and anything else is wsl too — the last two agree on purpose, so no host is unnamed.
  const detected = h.platform === 'darwin' ? 'mac' : /microsoft/i.test(h.readProcVersion() ?? '') ? 'wsl' : 'wsl';
  return { name: detected, error: set === '' ? null : 'bad SCHEDULE_MACHINE' };
}

export function scheduleStateRoot(config: Config, host: Partial<ScheduleHost> = {}): string {
  const h = { ...realHost(), ...host };
  const home = homeOf(h);
  return config.schedulesStateRoot ? expandHome(config.schedulesStateRoot, home) : path.join(home, '.claude', 'schedules');
}

export function scheduleDirs(config: Config, host: Partial<ScheduleHost> = {}): { schedules: string; state: string; runs: string; locks: string; launchd: string } {
  const h = { ...realHost(), ...host };
  const state = scheduleStateRoot(config, h);
  return {
    schedules: expandHome(config.schedulesDir, homeOf(h)),
    state,
    runs: path.join(state, 'runs'),
    locks: path.join(state, 'locks'),
    launchd: path.join(state, 'launchd')
  };
}

/**
 * The environment baked into a plist, a crontab line and a `/run` spawn: `.env` values live in `Config`, never in `process.env`, and launchd and cron
 * give a job no shell rc. Exactly these keys — the wrapper's `PATH`/`HOME` are the server's own, everything else comes from `Config`.
 */
export function scheduleEnv(config: Config, host: Partial<ScheduleHost> = {}): Record<string, string> {
  const h = { ...realHost(), ...host };
  return {
    PATH: h.env.PATH ?? '',
    HOME: homeOf(h),
    CLAUDE_BIN: config.claudeBin,
    SPAWN_MAX_PERMISSION: config.spawnMaxPermission,
    SYNC_PERMISSION_MODE: config.syncPermissionMode,
    SCHEDULE_MACHINE: machineName(config, h).name,
    SCHEDULES_DIR: scheduleDirs(config, h).schedules
  };
}
