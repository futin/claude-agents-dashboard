/**
 * settings.ts — the server-side half of the Settings page.
 *
 * Almost every knob the Settings page offers is per-device and lives in the
 * browser's localStorage: a phone showing 5 rows in the light theme while the
 * laptop shows 20 in the dark one is the point, not drift. Only settings that a
 * *separate process* has to agree on can live there, and there is exactly one
 * today:
 *
 *   `idleSecs` — how long you must be away from the keyboard before the
 *   remote-answer hooks stop handing questions to the terminal. A web app can't
 *   set an environment variable inside Claude Code's process, so the hooks read
 *   it off `GET /api/health` — a request they already make as their reachability
 *   probe, before the idle check. Zero added latency, no new hook round trip.
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
import type { IdleOverride, ServerSettings } from '../../shared/types.js';

/** Gitignored, repo-local — never inside `~/.claude` (read-only under Docker). */
export const SETTINGS_FILE = '.dashboard-settings.json';

/** Matches the hooks' own fallback, so an unreachable server behaves identically. */
export const DEFAULT_IDLE_SECS = 60;
/** An hour of idle is already absurd; past that it's a typo, not an intent. */
export const MAX_IDLE_SECS = 3600;

let cached: number | null = null;
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

/** The stored value, or null when there's nothing usable on disk. */
function readStored(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return clampIdleSecs(raw.idleSecs);
  } catch {
    return null; // absent / unreadable / malformed — fall back to the default
  }
}

/**
 * Is an exported `CLAUDE_DASHBOARD_IDLE_SECS` going to beat what we store?
 *
 * The hooks resolve `${CLAUDE_DASHBOARD_IDLE_SECS:-<from health>}`, so an
 * env var set anywhere in Claude Code's environment wins — and the user would
 * change the number here and see nothing happen. We can't read that process's
 * environment, but the two realistic sources are visible from here: the `env`
 * block of `~/.claude/settings.json` (which the CLI injects into every hook),
 * and this server's own shell, which in practice comes from the same profile.
 *
 * Detection only. The app never edits `~/.claude` — the UI just names the file
 * so the fix is one line away. Read fresh each call, not cached: the point is to
 * stop warning the moment the user removes it.
 */
export function detectIdleOverride(homeDir?: string): IdleOverride | null {
  try {
    const raw = fs.readFileSync(path.join(claudeHome(homeDir), 'settings.json'), 'utf8');
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> } | null)?.env;
    const value = env?.CLAUDE_DASHBOARD_IDLE_SECS;
    if (value !== undefined && value !== null && String(value) !== '') {
      return { value: String(value), source: 'settings.json' };
    }
  } catch {
    /* absent / unreadable / malformed — nothing to warn about */
  }
  const fromShell = process.env.CLAUDE_DASHBOARD_IDLE_SECS;
  if (fromShell) return { value: fromShell, source: 'environment' };
  return null;
}

/** Current settings. The value is resolved from disk once; the override is live. */
export function getSettings(homeDir?: string): ServerSettings {
  if (cached === null) cached = readStored() ?? DEFAULT_IDLE_SECS;
  return { idleSecs: cached, persisted, idleOverride: detectIdleOverride(homeDir) };
}

/**
 * Apply a patch. Returns null when the body carries nothing usable, which the
 * handler turns into a 400 — silently keeping the old value would leave the UI
 * showing a number the server never accepted.
 */
export function setSettings(patch: unknown): ServerSettings | null {
  const body = patch as { idleSecs?: unknown } | null;
  if (!body || typeof body !== 'object') return null;
  const idleSecs = clampIdleSecs(body.idleSecs);
  if (idleSecs === null) return null;

  cached = idleSecs;
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ idleSecs }) + '\n', 'utf8');
    persisted = true;
  } catch {
    persisted = false; // read-only fs / container — the value still holds this run
  }
  return getSettings();
}

/** Test seam: forget the cached value so the next read re-resolves it. */
export function resetSettings(): void {
  cached = null;
  persisted = true;
}
