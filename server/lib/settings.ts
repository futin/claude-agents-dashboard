/**
 * settings.ts — the server-side half of the Settings page.
 *
 * Almost every knob the Settings page offers is per-device and lives in the
 * browser's localStorage: a phone showing 5 rows in the light theme while the
 * laptop shows 20 in the dark one is the point, not drift. Only settings that a
 * *separate process* has to agree on can live here, and there are two:
 *
 *   `idleSecs`   — how long you must be away from the keyboard before the
 *                  remote-answer hooks stop handing questions to the terminal.
 *   `answerSecs` — how long a question (or plan) then stays answerable in the
 *                  dashboard before the hook gives up and the terminal dialog
 *                  appears instead. The hooks' wait window.
 *
 * A web app can't set an environment variable inside Claude Code's process, so
 * the hooks read both off `GET /api/health` — a request they already make as
 * their reachability probe, before the idle check. Zero added latency, no new
 * hook round trip.
 *
 * Deliberately shaped like `remoteState.ts` (module cache, fail-open read,
 * `persisted` flag, `reset*` test seam) — this is the same kind of store with a
 * different payload, and the second and last thing the app writes to disk.
 *
 * See `docs/subsystems/settings.md`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { claudeHome } from './management.js';
import type { EnvOverride, NotifyEvent, NotifyPolicy, ServerSettings } from '../../shared/types.js';

/** Gitignored, repo-local — never inside `~/.claude` (read-only under Docker). */
export const SETTINGS_FILE = '.dashboard-settings.json';

/** Matches the hooks' own fallback, so an unreachable server behaves identically. */
export const DEFAULT_IDLE_SECS = 60;
/** An hour of idle is already absurd; past that it's a typo, not an intent. */
export const MAX_IDLE_SECS = 3600;

/** Matches the hooks' `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` fallback, and `pending.ts`. */
export const DEFAULT_ANSWER_SECS = 600;
/** Mirrors `MIN_TIMEOUT_MS` / `MAX_TIMEOUT_MS` in `pending.ts` — the same window. */
export const MIN_ANSWER_SECS = 5;
export const MAX_ANSWER_SECS = 1800;

/** The env vars whose presence in the hooks' environment beats what we store. */
const IDLE_ENV = 'CLAUDE_DASHBOARD_IDLE_SECS';
const ANSWER_ENV = 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT';

/** Every switch off. Pushes are opt-in — nothing leaves the machine unasked. */
export const DEFAULT_NOTIFY: NotifyPolicy = {
  enabled: false,
  events: { question: false, stop: false, permission: false, plan: false },
  requireRemoteAnswer: false,
  requireAfk: false,
  requireAutoMode: false
};

const NOTIFY_EVENTS: readonly NotifyEvent[] = ['question', 'stop', 'permission', 'plan'];

/** Off by default — recording makes the server poll Anthropic unattended. */
export const DEFAULT_RECORD_USAGE_HISTORY = false;

interface Stored {
  idleSecs: number;
  answerSecs: number;
  notify: NotifyPolicy;
  recordUsageHistory: boolean;
}

let cached: Stored | null = null;
let persisted = true;

function statePath(): string {
  return path.join(process.cwd(), SETTINGS_FILE);
}

/** Coerce to a whole second count inside the allowed range, or null if unusable. */
export function clampIdleSecs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_IDLE_SECS, Math.max(0, Math.round(n)));
}

/**
 * Same shape as `clampIdleSecs`, but the floor is 5s rather than 0: there is no
 * "skip it" value for a wait window — a zero-length wait is just the hook not
 * running, which is what turning the toggle off already means.
 */
export function clampAnswerSecs(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_ANSWER_SECS, Math.max(MIN_ANSWER_SECS, Math.round(n)));
}

/**
 * Merge a partial notify patch over the current policy.
 *
 * Returns `null` when any present key is unusable — the caller turns that into a
 * 400 for the whole patch, because a half-applied save is the one outcome the UI
 * cannot report honestly. Absent keys keep their current value, so the UI can
 * send a single changed checkbox rather than the whole policy.
 */
export function mergeNotify(current: NotifyPolicy, patch: unknown): NotifyPolicy | null {
  if (!patch || typeof patch !== 'object') return null;
  const p = patch as Record<string, unknown>;
  const next: NotifyPolicy = { ...current, events: { ...current.events } };

  for (const key of ['enabled', 'requireRemoteAnswer', 'requireAfk', 'requireAutoMode'] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== 'boolean') return null;
    next[key] = p[key] as boolean;
  }

  if (p.events !== undefined) {
    if (!p.events || typeof p.events !== 'object') return null;
    for (const [name, value] of Object.entries(p.events as Record<string, unknown>)) {
      if (!NOTIFY_EVENTS.includes(name as NotifyEvent)) return null;
      if (typeof value !== 'boolean') return null;
      next.events[name as NotifyEvent] = value;
    }
  }
  return next;
}

/** The stored values, each falling back independently to its default. */
function readStored(): Stored {
  const fallback: Stored = {
    idleSecs: DEFAULT_IDLE_SECS,
    answerSecs: DEFAULT_ANSWER_SECS,
    notify: DEFAULT_NOTIFY,
    recordUsageHistory: DEFAULT_RECORD_USAGE_HISTORY
  };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      idleSecs: clampIdleSecs(raw.idleSecs) ?? fallback.idleSecs,
      answerSecs: clampAnswerSecs(raw.answerSecs) ?? fallback.answerSecs,
      notify: mergeNotify(DEFAULT_NOTIFY, raw.notify) ?? DEFAULT_NOTIFY,
      recordUsageHistory:
        typeof raw.recordUsageHistory === 'boolean'
          ? raw.recordUsageHistory
          : fallback.recordUsageHistory
    };
  } catch {
    return fallback; // absent / unreadable / malformed — fall back to the defaults
  }
}

/**
 * Is an exported `CLAUDE_DASHBOARD_*` var going to beat what we store?
 *
 * The hooks resolve `${VAR:-<from health>}`, so a var set anywhere in Claude
 * Code's environment wins — and the user would change the number here and see
 * nothing happen. We can't read that process's environment, but the two
 * realistic sources are visible from here: the `env` block of
 * `~/.claude/settings.json` (which the CLI injects into every hook), and this
 * server's own shell, which in practice comes from the same profile.
 *
 * Detection only. The app never edits `~/.claude` — the UI just names the file
 * so the fix is one line away. Read fresh each call, not cached: the point is to
 * stop warning the moment the user removes it.
 */
export function detectEnvOverride(name: string, homeDir?: string): EnvOverride | null {
  try {
    const raw = fs.readFileSync(path.join(claudeHome(homeDir), 'settings.json'), 'utf8');
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> } | null)?.env;
    const value = env?.[name];
    if (value !== undefined && value !== null && String(value) !== '') {
      return { value: String(value), source: 'settings.json' };
    }
  } catch {
    /* absent / unreadable / malformed — nothing to warn about */
  }
  const fromShell = process.env[name];
  if (fromShell) return { value: fromShell, source: 'environment' };
  return null;
}

/** `detectEnvOverride` for the idle threshold. */
export function detectIdleOverride(homeDir?: string): EnvOverride | null {
  return detectEnvOverride(IDLE_ENV, homeDir);
}

/** `detectEnvOverride` for the answer window. */
export function detectAnswerOverride(homeDir?: string): EnvOverride | null {
  return detectEnvOverride(ANSWER_ENV, homeDir);
}

/** Current settings. The values are resolved from disk once; overrides are live. */
export function getSettings(homeDir?: string): ServerSettings {
  if (cached === null) cached = readStored();
  return {
    ...cached,
    persisted,
    idleOverride: detectIdleOverride(homeDir),
    answerOverride: detectAnswerOverride(homeDir),
    // Both overwritten by the API layer, which is where Config — and therefore
    // NTFY_TOPIC and the .env baseline — is available. This module never reads
    // config.
    notifyAvailable: false,
    staleEnvKeys: []
  };
}

/**
 * Apply a patch — either key, or both. Returns null when the body carries
 * nothing usable, which the handler turns into a 400: silently keeping the old
 * value would leave the UI showing a number the server never accepted. A key
 * that is *present but unusable* rejects the whole patch for the same reason —
 * a half-applied save is the one outcome the UI can't report honestly.
 */
export function setSettings(patch: unknown): ServerSettings | null {
  const body = patch as {
    idleSecs?: unknown;
    answerSecs?: unknown;
    notify?: unknown;
    recordUsageHistory?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return null;

  const next: Partial<Stored> = {};
  if (body.idleSecs !== undefined) {
    const idleSecs = clampIdleSecs(body.idleSecs);
    if (idleSecs === null) return null;
    next.idleSecs = idleSecs;
  }
  if (body.answerSecs !== undefined) {
    const answerSecs = clampAnswerSecs(body.answerSecs);
    if (answerSecs === null) return null;
    next.answerSecs = answerSecs;
  }
  if (body.notify !== undefined) {
    if (cached === null) cached = readStored();
    const notify = mergeNotify(cached.notify, body.notify);
    if (notify === null) return null;
    next.notify = notify;
  }
  if (body.recordUsageHistory !== undefined) {
    if (typeof body.recordUsageHistory !== 'boolean') return null;
    next.recordUsageHistory = body.recordUsageHistory;
  }
  if (Object.keys(next).length === 0) return null;

  if (cached === null) cached = readStored();
  cached = { ...cached, ...next };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(cached) + '\n', 'utf8');
    persisted = true;
  } catch {
    persisted = false; // read-only fs / container — the values still hold this run
  }
  return getSettings();
}

/** Test seam: forget the cached values so the next read re-resolves them. */
export function resetSettings(): void {
  cached = null;
  persisted = true;
}
