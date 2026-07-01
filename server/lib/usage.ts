/**
 * usage.ts — account rate-limit usage (5-hour + weekly), the same numbers
 * Claude Code's `/usage` shows. These are NOT on disk: they're fetched live
 * from Anthropic's private OAuth usage endpoint using the CLI's stored token.
 *
 * Zero runtime deps (Node built-ins only): `https` for the request,
 * `child_process`/`fs` to read the OAuth token from the macOS keychain or the
 * `~/.claude/.credentials.json` fallback.
 *
 * Everything fails open: any missing token / network error / bad payload
 * yields `null`, so the dashboard never breaks when usage is unavailable.
 *
 * ⚠️ The endpoint is private/undocumented — a CLI-minted OAuth token used
 * outside its intended path. Anthropic may change it between CLI versions.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

import type { UsageLimits, RateLimit } from '../../shared/types.js';

const USAGE_PATH = '/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Base URL, overridable to match the CLI's own env knobs. */
function baseUrl(): string {
  return (
    process.env.CLAUDE_CODE_API_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    'https://api.anthropic.com'
  );
}

/**
 * Read the OAuth access token. Tries the macOS keychain first (where the CLI
 * stores it on macOS), then the `~/.claude/.credentials.json` fallback file.
 * Returns null on any failure. NOTE: the first keychain read by this process
 * triggers a macOS access prompt ("… wants to use your confidential
 * information") — approve once with "Always Allow".
 */
export function readToken(): string | null {
  // 1. macOS keychain.
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const token = tokenFromCredsBlob(out);
    if (token) return token;
  } catch {
    /* no keychain item / not macOS / access denied — try the file */
  }

  // 2. ~/.claude/.credentials.json fallback.
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const token = tokenFromCredsBlob(raw);
    if (token) return token;
  } catch {
    /* no file — give up */
  }

  return null;
}

/**
 * The keychain/file payload is JSON `{ claudeAiOauth: { accessToken, expiresAt, ... } }`.
 * Returns the access token, or null if absent or already expired.
 */
function tokenFromCredsBlob(blob: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
  if (!token) return null;
  // Skip clearly-expired tokens; we don't refresh (would mutate creds).
  if (typeof oauth!.expiresAt === 'number' && oauth!.expiresAt <= Date.now()) return null;
  return token;
}

/** One window from the raw `rate_limits` payload → our RateLimit shape. */
function toRateLimit(win: unknown): RateLimit {
  const w = (win || {}) as { utilization?: unknown; resets_at?: unknown };
  return {
    utilization: typeof w.utilization === 'number' ? w.utilization : null,
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null
  };
}

/**
 * Map the endpoint's JSON body to {@link UsageLimits}. Pure — no I/O — so it's
 * unit-testable with a fixture. The live endpoint returns the windows at the top
 * level (`{ five_hour, seven_day, … }`); we also accept a `{ rate_limits: {…} }`
 * wrapper defensively. Returns null when neither window is present.
 */
export function mapUsage(payload: unknown): UsageLimits | null {
  const root = (payload || {}) as { rate_limits?: unknown; five_hour?: unknown; seven_day?: unknown };
  const limits = (root.rate_limits || root) as { five_hour?: unknown; seven_day?: unknown };
  if (limits.five_hour == null && limits.seven_day == null) return null;
  return {
    fiveHour: toRateLimit(limits.five_hour),
    sevenDay: toRateLimit(limits.seven_day)
  };
}

/** GET the usage endpoint with the OAuth headers the CLI uses. Fails open to null. */
export function fetchUsage(token: string): Promise<UsageLimits | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: UsageLimits | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    const url = new URL(USAGE_PATH, baseUrl());
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // drain
          return done(null);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            done(mapUsage(JSON.parse(body)));
          } catch {
            done(null);
          }
        });
      }
    );
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.end();
  });
}

// ── Cache: serve a synchronous snapshot; refresh in the background on TTL ──
let cached: UsageLimits | null = null;
let cachedAt = 0;
let refreshing = false;

/** Kick off a background refresh if the cache is stale and none is in flight. */
function maybeRefresh(): void {
  if (refreshing) return;
  if (Date.now() - cachedAt <= CACHE_TTL_MS && cachedAt !== 0) return;
  refreshing = true;
  const token = readToken();
  const settle = (v: UsageLimits | null) => {
    cached = v;
    cachedAt = Date.now();
    refreshing = false;
  };
  if (!token) {
    settle(null);
    return;
  }
  fetchUsage(token).then(settle, () => settle(null));
}

/**
 * Current usage snapshot (synchronous). Returns the last fetched value and
 * triggers a non-blocking background refresh when stale. The very first call
 * returns null until the first fetch lands (picked up by the next poll).
 */
export function getCachedUsage(): UsageLimits | null {
  maybeRefresh();
  return cached;
}
