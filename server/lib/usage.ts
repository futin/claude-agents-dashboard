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
import http from 'node:http';
import https from 'node:https';

import type { UsageLimits, RateLimit, UsageStatus } from '../../shared/types.js';

/** Outcome of looking for a stored OAuth token. */
export type TokenState =
  | { state: 'ok'; token: string }
  | { state: 'expired' }
  | { state: 'missing' };

const USAGE_PATH = '/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Base URL for the usage endpoint. This is an Anthropic first-party API keyed to
 * the account's OAuth token, so it must always hit api.anthropic.com — NOT
 * `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_API_BASE_URL`, which point model inference at
 * a proxy/gateway (Bedrock, Vertex, Ollama, LiteLLM) that has no /api/oauth/usage.
 * `CLAUDE_USAGE_BASE_URL` is a narrow escape hatch for tests only.
 */
function baseUrl(): string {
  return process.env.CLAUDE_USAGE_BASE_URL || 'https://api.anthropic.com';
}

/**
 * Read the OAuth access token. Tries the macOS keychain first (where the CLI
 * stores it on macOS), then the `~/.claude/.credentials.json` fallback file.
 * `missing` on any failure. NOTE: the first keychain read by this process
 * triggers a macOS access prompt ("… wants to use your confidential
 * information") — approve once with "Always Allow".
 */
export function readToken(): TokenState {
  let sawExpired = false;

  // 1. macOS keychain.
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const t = tokenFromCredsBlob(out);
    if (t.state === 'ok') return t;
    if (t.state === 'expired') sawExpired = true;
  } catch {
    /* no keychain item / not macOS / access denied — try the file */
  }

  // 2. ~/.claude/.credentials.json fallback.
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const t = tokenFromCredsBlob(raw);
    if (t.state === 'ok') return t;
    if (t.state === 'expired') sawExpired = true;
  } catch {
    /* no file — give up */
  }

  return { state: sawExpired ? 'expired' : 'missing' };
}

/**
 * The keychain/file payload is JSON `{ claudeAiOauth: { accessToken, expiresAt, ... } }`.
 * Distinguishes a usable token from an expired one so the client can offer
 * recovery (see token-refresh.ts). We still never refresh creds ourselves.
 */
export function tokenFromCredsBlob(blob: string, now = Date.now()): TokenState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { state: 'missing' };
  }
  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
  if (!token) return { state: 'missing' };
  if (typeof oauth!.expiresAt === 'number' && oauth!.expiresAt <= now) return { state: 'expired' };
  return { state: 'ok', token };
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
    // Base URL may be http (e.g. a local proxy/gateway via ANTHROPIC_BASE_URL).
    const client = url.protocol === 'http:' ? http : https;
    const req = client.request(
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
let cachedStatus: UsageStatus = 'unavailable';
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

export interface UsageState {
  usage: UsageLimits | null;
  status: UsageStatus;
}

/** One fetch cycle: token → endpoint → cache. Single-flight via `refreshing`. */
function refreshNow(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const t = readToken();
      if (t.state !== 'ok') {
        cached = null;
        cachedStatus = t.state === 'expired' ? 'token-expired' : 'unavailable';
        return;
      }
      const limits = await fetchUsage(t.token);
      cached = limits;
      cachedStatus = limits ? 'ok' : 'unavailable';
    } finally {
      cachedAt = Date.now();
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Current usage snapshot + status (synchronous). Returns the last fetched value
 * and triggers a non-blocking background refresh when stale. The very first
 * call returns `unavailable` until the first fetch lands (next poll picks it up).
 */
export function getCachedUsageState(): UsageState {
  if (!refreshing && (cachedAt === 0 || Date.now() - cachedAt > CACHE_TTL_MS)) void refreshNow();
  return { usage: cached, status: cachedStatus };
}

/**
 * Bypass the TTL and fetch now — used after a token refresh so the new token is
 * picked up immediately. Awaits any in-flight cycle first (it may have started
 * with the old token), then runs a fresh one.
 */
export async function forceUsageRefresh(): Promise<UsageState> {
  if (refreshing) await refreshing;
  await refreshNow();
  return { usage: cached, status: cachedStatus };
}
