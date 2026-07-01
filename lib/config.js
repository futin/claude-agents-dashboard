'use strict';

/**
 * config.js — zero-dependency config loader.
 * Precedence: process.env > .env file > defaults.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  PORT: 4173,
  MAX_SESSIONS: 5,
  ACTIVE_WINDOW_MIN: 5,
  LOOKBACK_HOURS: 24
};

/** Parse a .env file body into a flat key/value object. Tolerant, minimal. */
function parseEnv(text) {
  const out = {};
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
function toPosInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load config from an optional .env file (defaults to <cwd>/.env), overlaid by
 * process.env, over hard defaults.
 */
function loadConfig(options = {}) {
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  let fileEnv = {};
  try {
    fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    /* no .env — fine */
  }

  const src = key => (process.env[key] !== undefined ? process.env[key] : fileEnv[key]);

  return {
    port: toPosInt(src('PORT'), DEFAULTS.PORT),
    maxSessions: toPosInt(src('MAX_SESSIONS'), DEFAULTS.MAX_SESSIONS),
    activeWindowMin: toPosInt(src('ACTIVE_WINDOW_MIN'), DEFAULTS.ACTIVE_WINDOW_MIN),
    lookbackHours: toPosInt(src('LOOKBACK_HOURS'), DEFAULTS.LOOKBACK_HOURS)
  };
}

module.exports = { DEFAULTS, parseEnv, toPosInt, loadConfig };
