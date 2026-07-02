/**
 * config.ts — zero-dependency config loader.
 * Precedence: process.env > .env file > defaults.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  maxSessions: number;
  activeWindowMin: number;
  lookbackHours: number;
  showUsage: boolean;
  skipProcScan: boolean;
}

export const DEFAULTS = {
  PORT: 4173,
  MAX_SESSIONS: 10,
  ACTIVE_WINDOW_MIN: 5,
  LOOKBACK_HOURS: 24,
  SHOW_USAGE: true
} as const;

/** Parse a .env file body into a flat key/value object. Tolerant, minimal. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof text !== 'string') return out;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Coerce to a positive integer, or fall back. */
export function toPosInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(value as string, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Coerce to a boolean. Accepts false/0/no/off (case-insensitive); else fallback. */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  return fallback;
}

/**
 * True inside a Docker container (standard `/.dockerenv` marker file). The
 * process-liveness gate (`scan.ts` `liveCwds`) shells out to `lsof`/`ps` to
 * find running `claude` processes — but a containerized dashboard only sees
 * its own container's process namespace, never the host's. Since the whole
 * point of that gate is watching for the host session's CLI process, it can
 * never see anything there and would force every session to `idle`. So
 * containerized runs default the gate off (same as "probe unavailable").
 */
export function isDockerContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Load config from an optional .env file (defaults to <cwd>/.env), overlaid by
 * process.env, over hard defaults.
 */
export function loadConfig(options: { envPath?: string } = {}): Config {
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    /* no .env — fine */
  }

  const src = (key: string): string | undefined =>
    (process.env[key] !== undefined ? process.env[key] : fileEnv[key]);

  return {
    port: toPosInt(src('PORT'), DEFAULTS.PORT),
    maxSessions: toPosInt(src('MAX_SESSIONS'), DEFAULTS.MAX_SESSIONS),
    activeWindowMin: toPosInt(src('ACTIVE_WINDOW_MIN'), DEFAULTS.ACTIVE_WINDOW_MIN),
    lookbackHours: toPosInt(src('LOOKBACK_HOURS'), DEFAULTS.LOOKBACK_HOURS),
    showUsage: toBool(src('SHOW_USAGE'), DEFAULTS.SHOW_USAGE),
    skipProcScan: toBool(src('SKIP_PROC_SCAN'), isDockerContainer())
  };
}
