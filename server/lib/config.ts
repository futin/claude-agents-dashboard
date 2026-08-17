/**
 * config.ts — zero-dependency config loader.
 * Precedence: process.env > .env file > defaults.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  /** Vite dev-server port (the `pnpm dev` UI). Only vite.config.ts reads it. */
  webPort: number;
  maxSessions: number;
  activeWindowMin: number;
  lookbackHours: number;
  showUsage: boolean;
  skipProcScan: boolean;
  /** How many generated analytics reports the Analytics tab shows (newest-first). */
  analyticsKeep: number;
  /** Feature toggle for the Analytics section. */
  showAnalytics: boolean;
  /** Feature toggle for remote answers (the only write path). Off → the wait endpoint 404s. */
  remoteAnswer: boolean;
  /**
   * Shared secret for the two remote-answer POSTs. Empty (default) leaves them
   * open, like the rest of the dashboard; set it on a LAN you share.
   */
  answerToken: string;
  /**
   * ntfy topic for push notifications. Empty (default) disables pushes outright,
   * the same way `REMOTE_ANSWER=false` disables remote answers. Kept in `.env`
   * and never returned by an endpoint: ntfy topics are unauthenticated, so the
   * string is both the address and the credential.
   */
  ntfyTopic: string;
  /** Base URL of the ntfy server. Override for a self-hosted instance. */
  ntfyServer: string;
  /**
   * How a phone reaches this dashboard, used for the notification's tap-through
   * link. Cannot be inferred: a push is not triggered by a browser request, so
   * there is no Host header to read. Set it to the tailnet hostname.
   *
   * Empty when unset, and deliberately so. This used to fall back to
   * `http://localhost:<port>` "so the link at least works at the desk", but a
   * push exists to reach the device you are *not* sitting at, and the fallback
   * made two guards unreachable: `clickUrl` could never omit the Click header,
   * and `sendTest` could never warn that taps would go nowhere — it reported the
   * synthesized localhost URL as though someone had configured it. An absent
   * value must stay distinguishable from a chosen one.
   */
  publicUrl: string;
  /**
   * Path to a GGML whisper model. Empty (the default) disables dictation
   * outright, the same way an empty `NTFY_TOPIC` disables pushes — one
   * "unset means off" rule rather than a separate boolean.
   */
  whisperModel: string;
  /** whisper.cpp CLI. Override for a non-PATH install. */
  whisperBin: string;
  /** ffmpeg, used to make whisper-readable 16kHz mono WAV from browser audio. */
  ffmpegBin: string;
  /**
   * The `claude` CLI to spawn for a new headless session. Empty (the default)
   * disables the whole spawn-a-session feature outright — the same "unset
   * means off" rule `NTFY_TOPIC` and `WHISPER_MODEL` already use, rather than
   * a separate boolean.
   */
  claudeBin: string;
  /**
   * The permission mode ceiling every spawn request is clamped to
   * (`clampPermission` in `server/lib/spawn.ts`), no matter what the launch
   * form asks for.
   */
  spawnMaxPermission: string;
}

export const DEFAULTS = {
  PORT: 4173,
  WEB_PORT: 5173,
  MAX_SESSIONS: 10,
  ACTIVE_WINDOW_MIN: 5,
  LOOKBACK_HOURS: 24,
  SHOW_USAGE: true,
  ANALYTICS_KEEP: 5,
  SHOW_ANALYTICS: true,
  REMOTE_ANSWER: true,
  ANSWER_TOKEN: '',
  NTFY_TOPIC: '',
  NTFY_SERVER: 'https://ntfy.sh',
  DASHBOARD_PUBLIC_URL: '',
  WHISPER_MODEL: '',
  WHISPER_BIN: 'whisper-cli',
  FFMPEG_BIN: 'ffmpeg',
  CLAUDE_BIN: '',
  SPAWN_MAX_PERMISSION: 'auto'
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
    webPort: toPosInt(src('WEB_PORT'), DEFAULTS.WEB_PORT),
    maxSessions: toPosInt(src('MAX_SESSIONS'), DEFAULTS.MAX_SESSIONS),
    activeWindowMin: toPosInt(src('ACTIVE_WINDOW_MIN'), DEFAULTS.ACTIVE_WINDOW_MIN),
    lookbackHours: toPosInt(src('LOOKBACK_HOURS'), DEFAULTS.LOOKBACK_HOURS),
    showUsage: toBool(src('SHOW_USAGE'), DEFAULTS.SHOW_USAGE),
    skipProcScan: toBool(src('SKIP_PROC_SCAN'), isDockerContainer()),
    analyticsKeep: toPosInt(src('ANALYTICS_KEEP'), DEFAULTS.ANALYTICS_KEEP),
    showAnalytics: toBool(src('SHOW_ANALYTICS'), DEFAULTS.SHOW_ANALYTICS),
    remoteAnswer: toBool(src('REMOTE_ANSWER'), DEFAULTS.REMOTE_ANSWER),
    answerToken: (src('ANSWER_TOKEN') || DEFAULTS.ANSWER_TOKEN).trim(),
    ntfyTopic: (src('NTFY_TOPIC') || DEFAULTS.NTFY_TOPIC).trim(),
    ntfyServer: (src('NTFY_SERVER') || DEFAULTS.NTFY_SERVER).trim().replace(/\/+$/, ''),
    // Empty when unset — deliberately NOT defaulted to localhost. See the field's
    // doc comment: a synthesized default is indistinguishable from a real one.
    publicUrl: (src('DASHBOARD_PUBLIC_URL') || DEFAULTS.DASHBOARD_PUBLIC_URL).trim().replace(/\/+$/, ''),
    whisperModel: (src('WHISPER_MODEL') || DEFAULTS.WHISPER_MODEL).trim(),
    whisperBin: (src('WHISPER_BIN') || DEFAULTS.WHISPER_BIN).trim(),
    ffmpegBin: (src('FFMPEG_BIN') || DEFAULTS.FFMPEG_BIN).trim(),
    claudeBin: (src('CLAUDE_BIN') || DEFAULTS.CLAUDE_BIN).trim(),
    spawnMaxPermission: (src('SPAWN_MAX_PERMISSION') || DEFAULTS.SPAWN_MAX_PERMISSION).trim()
  };
}
