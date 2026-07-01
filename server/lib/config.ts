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
    showUsage: toBool(src('SHOW_USAGE'), DEFAULTS.SHOW_USAGE)
  };
}
