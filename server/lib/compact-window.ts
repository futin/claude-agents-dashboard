/**
 * compact-window.ts — the auto-compact window a monitored session runs under,
 * read from that session's own settings files.
 *
 * Claude Code resolves its compaction window as `min(modelMax, configured)`,
 * so a `[1m]` session with `"autoCompactWindow": 200000` compacts near 170k
 * while `resolveWindow` would otherwise measure it against 1M. `configured` is,
 * first hit wins: the session's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env (floored
 * at 100k), then the `autoCompactWindow` setting — both ignored when
 * `autoCompactEnabled` is `false`, because then nothing compacts at all.
 *
 * Settings merge lowest precedence first, later wins key by key (and `env`
 * key by key within itself): `~/.claude/settings.json` →
 * `<project>/.claude/settings.json` → `<project>/.claude/settings.local.json`
 * → the managed file. `<project>` is the session's launch directory, since
 * Claude Code loads project settings once, from where it started.
 *
 * Not recoverable from disk, so not read: `--settings` flag settings, a
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` exported in the shell that launched the
 * session, and the server-side `clientdata` / experiment windows.
 *
 * A session reads these files once, at start, so `frozenCompactWindow` pins
 * each transcript to the value seen the first time the dashboard resolved it
 * (#159) — a later edit moves only sessions first seen after it. What the files
 * said at a session's start is not recoverable either: a session the dashboard
 * first sees after an edit, or after a server restart (the pins live in memory),
 * gets the value current at that first sight.
 *
 * Every file is cached by `mtimeMs` + `size`: one `stat` per file per poll in
 * the steady state. A missing, unreadable or malformed file contributes nothing
 * and never throws.
 */

import fs from 'node:fs';
import path from 'node:path';

import { claudeHome } from './management.js';

/** Claude Code clamps an env-supplied window up to this floor. */
export const ENV_WINDOW_FLOOR = 100000;

const MANAGED_PATH = process.platform === 'darwin'
  ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : '/etc/claude-code/managed-settings.json';

interface Entry { mtimeMs: number; size: number; value: Record<string, any> | null }

const cache = new Map<string, Entry>();
const frozen = new Map<string, { size: number; value: number | null }>();
let reads = 0;
let homeOverride: string | null = null;
let managedOverride: string | null = null;

/** Parsed JSON object at `file`, or null — re-read only when its stat changes. */
function readSettings(file: string): Record<string, any> | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value: Record<string, any> | null = null;
  reads++;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch { /* unreadable or malformed — contributes nothing */ }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The configured compact window for a session launched in `projectDir`, or
 * null when nothing caps it (no setting, or auto-compact switched off).
 *
 * @param projectDir the session's launch cwd (`originCwd`); null reads only the user and managed files
 * @param homeDir    test seam — the home whose `.claude/settings.json` is read
 */
export function sessionCompactWindow(projectDir: string | null, homeDir?: string): number | null {
  const files = [path.join(claudeHome(homeDir || homeOverride || undefined), 'settings.json')];
  if (projectDir) {
    files.push(path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json'));
  }
  files.push(managedOverride || MANAGED_PATH);

  const merged: Record<string, any> = {};
  const env: Record<string, unknown> = {};
  for (const file of files) {
    const s = readSettings(file);
    if (!s) continue;
    Object.assign(merged, s);
    if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) Object.assign(env, s.env);
  }

  if (merged.autoCompactEnabled === false) return null;
  const fromEnv = positiveInt(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (fromEnv !== null) return Math.max(ENV_WINDOW_FLOOR, fromEnv);
  return typeof merged.autoCompactWindow === 'number' ? positiveInt(merged.autoCompactWindow) : null;
}

/**
 * `sessionCompactWindow` for the session whose transcript is `filePath`, pinned
 * at the first answer. A transcript that shrank was rotated or truncated, so it
 * is re-resolved, the same rule as `record-cache.ts`.
 *
 * @param size the transcript's current size
 */
export function frozenCompactWindow(filePath: string, size: number, projectDir: string | null): number | null {
  const hit = frozen.get(filePath);
  if (hit && size >= hit.size) {
    hit.size = size;
    return hit.value;
  }
  const value = sessionCompactWindow(projectDir);
  frozen.set(filePath, { size, value });
  return value;
}

/** Test seam: the home `sessionCompactWindow` reads when no `homeDir` is passed (null restores `os.homedir()`). */
export function setCompactWindowHome(dir: string | null): void {
  homeOverride = dir;
}

/** Test seam: the managed-settings path (null restores the platform default). */
export function setManagedSettingsPath(file: string | null): void {
  managedOverride = file;
}

/** Test seam: forget every cached settings file and every pinned session. */
export function resetCompactWindowCache(): void {
  cache.clear();
  frozen.clear();
  reads = 0;
}

/** Test seam: how many times a settings file was actually read off disk. */
export function compactWindowStats(): { entries: number; reads: number } {
  return { entries: cache.size, reads };
}
