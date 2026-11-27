/**
 * plugin-trim.ts — the settings file behind a plugin-trimmed headless launch (`SpawnRequest.trimPlugins`). It switches off every enabled plugin that is not
 * on backlog-manager's headless allowlist plus the request's `keepPlugins`, and is passed to the child as `--settings <file>`. Never throws: every failure
 * is "no trim" plus at most one `console.warn`, because a trim missing a needed plugin breaks the session while a skipped trim only costs tokens.
 * The four decisions behind it, and the measurement, are in docs/subsystems/spawn.md §Plugin trim.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { stateDir } from './paths.js';
import type { Config } from './config.js';
import type { ProjectRef } from '../../shared/types.js';

/** backlog-manager's own default for an absent `headless.json` (futin/backlog-manager#625); the dashboard uses the same one. */
export const HEADLESS_DEFAULT: HeadlessConfig = { enabled: true, plugins: ['backlog-manager', 'superpowers'] };

/** `headless.json`'s shape. backlog-manager is its one writer; this module only reads it. */
export interface HeadlessConfig {
  enabled: boolean;
  plugins: string[];
}

/** One `claude plugin list --json` entry, as far as the deny map reads it. */
export interface PluginEntry {
  id: string;
  enabled: boolean;
}

/** #625's cap on a plugin list, shared by `headless.json`'s `plugins` and the request's `keepPlugins`. */
export const PLUGIN_LIST_MAX = 32;
/** A bare plugin name, or a full `<name>@<marketplace>` id. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

/** How long one project's inventory is reused. Installs are rare; a stale entry only misses trimming a just-installed plugin. */
export const INVENTORY_TTL_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 5_000;
/** A trim file older than this is pruned: a resume that late runs on a cold cache anyway, and simply goes untrimmed. */
export const TRIM_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const TRIM_DIR = '.plugin-trim';
/** The id charset a trim file is named by — `RESUME_ID_RE` in spawn.ts, so an id can never become a path segment it should not. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/** A plugin list under #625's rule — an array of at most 32 names of the right shape, duplicates dropped — or `null` for anything else. */
export function parsePluginList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > PLUGIN_LIST_MAX) return null;
  if (!value.every(v => typeof v === 'string' && PLUGIN_NAME_RE.test(v))) return null;
  return [...new Set(value as string[])];
}

/** `$BM_HEADLESS_FILE` when set, read per call — the override backlog-manager honours — else `~/.backlog-manager/settings/headless.json`. */
export function headlessFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BM_HEADLESS_FILE?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.backlog-manager', 'settings', 'headless.json');
}

/** The allowlist config: {@link HEADLESS_DEFAULT} when the file is absent, `null` (and one warn naming the file) when it is unreadable or malformed. */
export function readHeadlessConfig(env: NodeJS.ProcessEnv = process.env): HeadlessConfig | null {
  const file = headlessFile(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return HEADLESS_DEFAULT;
    console.warn(`[dashboard] plugin trim off: cannot read ${file}: ${(e as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const o = parsed as { enabled?: unknown; plugins?: unknown } | null;
  const plugins = o && typeof o === 'object' ? parsePluginList(o.plugins) : null;
  if (!o || typeof o.enabled !== 'boolean' || !plugins) {
    console.warn(`[dashboard] plugin trim off: ${file} is not { enabled: boolean, plugins: string[] }`);
    return null;
  }
  return { enabled: o.enabled, plugins };
}

/**
 * The `enabledPlugins` entries that switch plugins off: every enabled inventory entry, unless its id ends in `@builtin` (by suffix, never by scope — the
 * desktop app's security and privacy plugins stay on), its bare name is `backlog-manager` (the session's own skills), or an `allow` entry equals its full
 * id or its bare name. Already-disabled plugins are not written, so an allowlisted plugin keeps whatever the other settings sources say.
 */
export function denyMap(inventory: readonly PluginEntry[], allow: readonly string[]): Record<string, false> {
  const out: Record<string, false> = {};
  for (const p of inventory) {
    if (!p.enabled || p.id.endsWith('@builtin')) continue;
    const bare = p.id.split('@')[0];
    if (bare === 'backlog-manager' || allow.includes(p.id) || allow.includes(bare)) continue;
    out[p.id] = false;
  }
  return out;
}

/** Runs `claude plugin list --json` and resolves its stdout; rejects on a non-zero exit or a timeout. */
export type PluginLister = (bin: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

const execLister: PluginLister = (bin, cwd, env) => new Promise((resolve, reject) => {
  execFile(bin, ['plugin', 'list', '--json'], { cwd, env, encoding: 'utf8', timeout: LIST_TIMEOUT_MS }, (err, stdout) => {
    if (err) reject(err); else resolve(stdout);
  });
});

let lister: PluginLister | null = null;
/** Test seam: replace the `claude plugin list` call, null to restore. Also empties the inventory cache. */
export function setPluginLister(fn: PluginLister | null): void {
  lister = fn;
  inventoryCache.clear();
}

/** Per project path. The promise is cached, not the result, so two launches racing on a cold entry share one `claude` child. */
const inventoryCache = new Map<string, { at: number; inventory: Promise<PluginEntry[] | null> }>();

function parseInventory(stdout: string): PluginEntry[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((p): p is { id: string; enabled?: unknown } => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
    .map(p => ({ id: p.id, enabled: p.enabled === true }));
}

/** The project's plugin inventory, or `null` (one warn) when the CLI failed. A failure is not cached, so the next launch asks again. */
function inventoryFor(config: Config, cwd: string, env: NodeJS.ProcessEnv, now: number): Promise<PluginEntry[] | null> {
  const hit = inventoryCache.get(cwd);
  if (hit && now - hit.at < INVENTORY_TTL_MS) return hit.inventory;
  const inventory = (lister ?? execLister)(config.claudeBin, cwd, env).then(
    stdout => {
      const list = parseInventory(stdout);
      if (!list) console.warn('[dashboard] plugin trim off: `claude plugin list --json` did not print a JSON array');
      return list;
    },
    (e: unknown) => {
      console.warn(`[dashboard] plugin trim off: \`claude plugin list --json\` failed: ${(e as Error)?.message ?? e}`);
      return null;
    }
  ).then(list => {
    if (!list && inventoryCache.get(cwd)?.inventory === inventory) inventoryCache.delete(cwd);
    return list;
  });
  inventoryCache.set(cwd, { at: now, inventory });
  return inventory;
}

/**
 * The deny map a trimmed launch in `ref` would write, or `null` for no trim: `headless.json` switched off or malformed, the inventory unreadable, or
 * nothing to switch off. `env` is the env the child itself will get (`spawnEnv` in spawn.ts) — `CLAUDE_CODE_PLUGIN_DIRS` there decides the `@inline`
 * entries. The one await in a trimmed launch, so `serveSpawn` runs it before the launch cap is counted.
 */
export async function trimMap(
  config: Config, ref: Pick<ProjectRef, 'path'>, keep: readonly string[], env: NodeJS.ProcessEnv, now: number = Date.now()
): Promise<Record<string, false> | null> {
  const headless = readHeadlessConfig(env);
  if (!headless || !headless.enabled) return null;
  const inventory = await inventoryFor(config, ref.path, env, now);
  if (!inventory) return null;
  const map = denyMap(inventory, [...headless.plugins, ...keep]);
  return Object.keys(map).length > 0 ? map : null;
}

/** `<stateDir>/.plugin-trim`, the directory every trim file lives in. */
export function trimDir(): string {
  return path.join(stateDir(process.cwd()), TRIM_DIR);
}

/** Delete trim files older than {@link TRIM_FILE_MAX_AGE_MS}. Best effort: a file that vanished or cannot be read is skipped. */
function prune(dir: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > TRIM_FILE_MAX_AGE_MS) fs.unlinkSync(file);
    } catch { /* gone already */ }
  }
}

/** Write `{ enabledPlugins: map }` for `sessionId` and return its absolute path, pruning old files first; `null` (one warn) when the write fails. */
export function writeTrimFile(sessionId: string, map: Record<string, false>, now: number = Date.now()): string | null {
  if (!ID_RE.test(sessionId)) return null;
  const dir = trimDir();
  const file = path.join(dir, `${sessionId}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, now);
    writeFileAtomic(file, JSON.stringify({ enabledPlugins: map }, null, 2) + '\n');
    return file;
  } catch (e) {
    console.warn(`[dashboard] plugin trim off: cannot write ${file}: ${(e as Error).message}`);
    return null;
  }
}

/** {@link trimMap} then {@link writeTrimFile}: the trim file for a fresh launch, or `null`. */
export async function resolveTrimFile(
  config: Config, ref: Pick<ProjectRef, 'path'>, sessionId: string, keep: readonly string[], env: NodeJS.ProcessEnv, now: number = Date.now()
): Promise<string | null> {
  const map = await trimMap(config, ref, keep, env, now);
  return map ? writeTrimFile(sessionId, map, now) : null;
}

/**
 * The trim file a resumed session was launched with, its mtime refreshed so the prune keeps it, or `null`. A resume passes it again whatever the
 * request says, and never gains one: changing a session's plugin set mid-session changes its system prompt, losing the cached prefix and the skills
 * earlier turns used.
 */
export function existingTrimFile(sessionId: string, now: number = Date.now()): string | null {
  if (!ID_RE.test(sessionId)) return null;
  const file = path.join(trimDir(), `${sessionId}.json`);
  try {
    const at = new Date(now);
    fs.utimesSync(file, at, at);
    return file;
  } catch {
    return null;
  }
}
