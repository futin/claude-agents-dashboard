/**
 * management.ts — read-only scanner over Claude config on disk, powering
 * GET /api/management*. Enumerates skills/agents/commands/rules/hooks/memory/
 * settings for the global scope (~/.claude, including every installed
 * plugin's subtree) and for individual project scopes (<cwd>/.claude).
 *
 * Everything fails open: a missing directory, unreadable file, or malformed
 * JSON yields empty arrays/nulls — a scope is always a complete shape.
 *
 * Security: the file-content endpoint may only serve paths that appear in
 * the set built by `collectServablePaths` — exact membership over paths this
 * module itself enumerated, never prefix checks (~/.claude also holds
 * history/credentials; project roots hold .env).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter } from '../../shared/frontmatter.js';
import { listTranscripts } from './scan.js';
import { readTranscript } from './transcript.js';
import type { Config } from './config.js';
import type {
  ConfigItem, FileContent, HookInfo, PluginInfo, ProjectRef, ScopeConfig, SettingsFileInfo
} from '../../shared/types.js';

/** Max bytes served per file by GET /api/management/file. */
export const FILE_CONTENT_CAP = 256 * 1024;

export function claudeHome(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude');
}

interface ProjectsOptions {
  root?: string;
  now?: number;
  homeDir?: string;
}

/* ---------------------------------------------------------------- helpers */

async function readTextIfFile(p: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(p);
    if (!stat.isFile()) return null;
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonIfFile(p: string): Promise<unknown | null> {
  const text = await readTextIfFile(p);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Skill dirs: each subdir containing a SKILL.md. */
export async function readSkillsDir(dir: string, source: string): Promise<ConfigItem[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
    const file = path.join(dir, e.name, 'SKILL.md');
    const text = await readTextIfFile(file);
    if (text === null) return null;
    const fm = parseFrontmatter(text).data;
    return {
      name: fm.name || e.name,
      description: fm.description || null,
      path: file,
      source
    } as ConfigItem;
  }));
  return items.filter((i): i is ConfigItem => i !== null);
}

const TOML_DESC_RE = /^description\s*=\s*"([^"]*)"/m;

/**
 * Flat + one-level-nested `*.md` files (commands can be namespaced in
 * subdirs), plus `*.toml` (plugin command defs; name = stem, description
 * from a trivially greppable `description = "…"` line).
 */
export async function readMdDir(dir: string, source: string, depth = 2): Promise<ConfigItem[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = await Promise.all(entries.map(async (e): Promise<ConfigItem[]> => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      return depth > 1 ? readMdDir(full, source, depth - 1) : [];
    }
    if (!e.isFile()) return [];
    const stem = e.name.replace(/\.(md|toml)$/, '');
    if (e.name.endsWith('.md')) {
      const text = await readTextIfFile(full);
      if (text === null) return [];
      const fm = parseFrontmatter(text).data;
      return [{ name: fm.name || stem, description: fm.description || null, path: full, source }];
    }
    if (e.name.endsWith('.toml')) {
      const text = await readTextIfFile(full);
      if (text === null) return [];
      const m = text.match(TOML_DESC_RE);
      return [{ name: stem, description: m ? m[1] : null, path: full, source }];
    }
    return [];
  }));
  return items.flat();
}

/**
 * Resolve a hook command to the script file it runs, when that script lives
 * inside one of the allowed roots. Tries the whole command, then its first
 * whitespace token, quotes stripped.
 */
function resolveScriptPath(command: string, allowedRoots: string[]): string | null {
  const subbed = command.trim();
  const candidates = [subbed, subbed.split(/\s+/)[0]]
    .map(c => c.replace(/^["']|["']$/g, ''))
    .filter(c => path.isAbsolute(c));
  for (const c of candidates) {
    const norm = path.normalize(c);
    const inRoot = allowedRoots.some(r => norm === r || norm.startsWith(r + path.sep));
    if (!inRoot) continue;
    try {
      if (fs.statSync(norm).isFile()) return norm;
    } catch { /* not a file — try next candidate */ }
  }
  return null;
}

/**
 * Flatten a `hooks` config object ({ Event: [{ matcher?, hooks: [{type,
 * command}] }] }) into HookInfo rows. Handles both settings.json's `hooks`
 * key and a plugin's hooks/hooks.json (pass `pluginRoot` to substitute
 * `${CLAUDE_PLUGIN_ROOT}` and allow scripts under the plugin).
 */
export function readHooksConfig(
  hooksObj: unknown,
  source: string,
  declaredIn: string,
  scriptRoots: string[],
  pluginRoot?: string
): HookInfo[] {
  if (!hooksObj || typeof hooksObj !== 'object') return [];
  const out: HookInfo[] = [];
  for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const matcher = typeof (group as any).matcher === 'string' ? (group as any).matcher : null;
      const hooks = Array.isArray((group as any).hooks) ? (group as any).hooks : [];
      for (const h of hooks) {
        if (!h || typeof h !== 'object' || typeof (h as any).command !== 'string') continue;
        const command: string = (h as any).command;
        const resolved = pluginRoot ? command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : command;
        out.push({
          event,
          matcher,
          command,
          source,
          declaredIn,
          scriptPath: resolveScriptPath(resolved, scriptRoots)
        });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- plugins */

interface PluginScan {
  info: PluginInfo;
  skills: ConfigItem[];
  agents: ConfigItem[];
  commands: ConfigItem[];
  rules: ConfigItem[];
  hooks: HookInfo[];
}

async function readPlugin(key: string, installPath: string, version: string | null, enabled: boolean): Promise<PluginScan> {
  const at = key.lastIndexOf('@');
  const keyName = at > 0 ? key.slice(0, at) : key;
  const marketplace = at > 0 ? key.slice(at + 1) : '';
  const source = `plugin:${keyName}`;

  const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
  const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
  const [manifest, hooksJson, skills, agents, commands, rules] = await Promise.all([
    readJsonIfFile(manifestPath) as Promise<Record<string, unknown> | null>,
    readJsonIfFile(hooksPath) as Promise<Record<string, unknown> | null>,
    readSkillsDir(path.join(installPath, 'skills'), source),
    readMdDir(path.join(installPath, 'agents'), source, 1),
    readMdDir(path.join(installPath, 'commands'), source),
    readMdDir(path.join(installPath, 'rules'), source, 1)
  ]);

  const hooks = hooksJson
    ? readHooksConfig(hooksJson.hooks ?? hooksJson, source, hooksPath, [installPath], installPath)
    : [];

  return {
    info: {
      key,
      name: (manifest && typeof manifest.name === 'string' && manifest.name) || keyName,
      marketplace,
      version: (manifest && typeof manifest.version === 'string' && manifest.version) || version,
      description: (manifest && typeof manifest.description === 'string' && manifest.description) || null,
      installPath,
      enabled,
      manifestPath: manifest ? manifestPath : null,
      counts: { skills: skills.length, agents: agents.length, commands: commands.length, rules: rules.length, hooks: hooks.length }
    },
    skills, agents, commands, rules, hooks
  };
}

async function readPlugins(home: string, enabledMap: Record<string, unknown>): Promise<PluginScan[]> {
  const reg = await readJsonIfFile(path.join(home, 'plugins', 'installed_plugins.json')) as Record<string, unknown> | null;
  const plugins = reg && typeof reg.plugins === 'object' && reg.plugins ? reg.plugins as Record<string, unknown> : {};
  return Promise.all(Object.entries(plugins).map(([key, entries]) => {
    const arr = Array.isArray(entries) ? entries : [];
    const entry = (arr.find(e => e && (e as any).scope === 'user') || arr[0] || {}) as Record<string, unknown>;
    const installPath = typeof entry.installPath === 'string' ? entry.installPath : '';
    const version = typeof entry.version === 'string' ? entry.version : null;
    return readPlugin(key, installPath, version, enabledMap[key] !== false);
  }));
}

/* ----------------------------------------------------------------- scopes */

function settingsInfo(dir: string, existing: Set<string>): SettingsFileInfo[] {
  return ['settings.json', 'settings.local.json'].map(label => {
    const p = path.join(dir, label);
    return { label, path: p, exists: existing.has(p) };
  });
}

async function memoryItems(paths: string[], source: string): Promise<ConfigItem[]> {
  const found = await Promise.all(paths.map(async p => {
    try {
      return (await fsp.stat(p)).isFile() ? p : null;
    } catch {
      return null;
    }
  }));
  return found.filter((p): p is string => p !== null)
    .map(p => ({ name: path.basename(p), description: null, path: p, source }));
}

async function settingsHooks(dir: string, source: string, scriptRoots: string[]): Promise<{ hooks: HookInfo[]; existing: Set<string> }> {
  const files = ['settings.json', 'settings.local.json'].map(l => path.join(dir, l));
  const parsed = await Promise.all(files.map(readJsonIfFile));
  const existing = new Set<string>();
  const hooks: HookInfo[] = [];
  parsed.forEach((json, i) => {
    if (json === null) return;
    existing.add(files[i]);
    hooks.push(...readHooksConfig((json as Record<string, unknown>).hooks, source, files[i], scriptRoots));
  });
  return { hooks, existing };
}

export async function readGlobalScope(homeDir?: string): Promise<ScopeConfig> {
  const home = claudeHome(homeDir);
  const hooksDir = path.join(home, 'hooks');

  const settingsJson = await readJsonIfFile(path.join(home, 'settings.json')) as Record<string, unknown> | null;
  const enabledMap = settingsJson && typeof settingsJson.enabledPlugins === 'object' && settingsJson.enabledPlugins
    ? settingsJson.enabledPlugins as Record<string, unknown> : {};

  const [skills, agents, commands, rules, memory, plugins, { hooks, existing }] = await Promise.all([
    readSkillsDir(path.join(home, 'skills'), 'user'),
    readMdDir(path.join(home, 'agents'), 'user', 1),
    readMdDir(path.join(home, 'commands'), 'user'),
    readMdDir(path.join(home, 'rules'), 'user', 1),
    memoryItems([path.join(home, 'CLAUDE.md')], 'user'),
    readPlugins(home, enabledMap),
    settingsHooks(home, 'user', [hooksDir])
  ]);

  return {
    scope: 'global',
    root: home,
    skills: skills.concat(plugins.flatMap(p => p.skills)),
    agents: agents.concat(plugins.flatMap(p => p.agents)),
    commands: commands.concat(plugins.flatMap(p => p.commands)),
    rules: rules.concat(plugins.flatMap(p => p.rules)),
    hooks: hooks.concat(plugins.flatMap(p => p.hooks)),
    memory,
    settings: settingsInfo(home, existing),
    plugins: plugins.map(p => p.info)
  };
}

export async function readProjectScope(projectPath: string, dirName?: string, homeDir?: string): Promise<ScopeConfig> {
  const dir = path.join(projectPath, '.claude');
  // The file-based memory store lives outside the project tree, under the
  // transcript dir: ~/.claude/projects/<dirName>/memory/*.md. Scan it when the
  // encoded dirName is known (both callers pass it; the security path set and
  // the served scope stay in sync because both go through here).
  const memoryDir = dirName ? path.join(claudeHome(homeDir), 'projects', dirName, 'memory') : null;
  const [skills, agents, commands, rules, claudeMd, memoryStore, { hooks, existing }] = await Promise.all([
    readSkillsDir(path.join(dir, 'skills'), 'project'),
    readMdDir(path.join(dir, 'agents'), 'project', 1),
    readMdDir(path.join(dir, 'commands'), 'project'),
    readMdDir(path.join(dir, 'rules'), 'project', 1),
    memoryItems([path.join(projectPath, 'CLAUDE.md'), path.join(dir, 'CLAUDE.md')], 'project'),
    memoryDir ? readMdDir(memoryDir, 'project', 1) : Promise.resolve([]),
    settingsHooks(dir, 'project', [dir])
  ]);
  return {
    scope: 'project',
    root: projectPath,
    skills, agents, commands, rules, hooks,
    memory: claudeMd.concat(memoryStore),
    settings: settingsInfo(dir, existing),
    plugins: []
  };
}

/* --------------------------------------------------------------- projects */

/**
 * Recently-active projects for the management side-menu: per project dir the
 * newest transcript within the lookback window, its cwd tail-read from the
 * transcript; deduped by cwd (newest wins), newest-first.
 */
export function listRecentProjects(config: Partial<Config>, options: ProjectsOptions = {}): ProjectRef[] {
  const lookbackHours = (config.lookbackHours ?? 0) > 0 ? (config.lookbackHours as number) : 24;
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const root = options.root || path.join(claudeHome(options.homeDir), 'projects');
  const lookbackMs = lookbackHours * 60 * 60 * 1000;

  // Newest transcript per project dir, inside the lookback window.
  const newestPerDir = new Map<string, { file: string; mtimeMs: number }>();
  for (const t of listTranscripts(root)) {
    if (now - t.mtimeMs > lookbackMs) continue;
    const cur = newestPerDir.get(t.dirName);
    if (!cur || t.mtimeMs > cur.mtimeMs) newestPerDir.set(t.dirName, { file: t.file, mtimeMs: t.mtimeMs });
  }

  // Extract cwd; dedupe by cwd keeping the most recent dirName.
  const byCwd = new Map<string, ProjectRef>();
  for (const [dirName, t] of newestPerDir) {
    const parsed = readTranscript(t.file);
    if (!parsed || !parsed.cwd) continue;
    const cur = byCwd.get(parsed.cwd);
    if (cur && cur.lastActiveMs >= t.mtimeMs) continue;
    byCwd.set(parsed.cwd, {
      dirName,
      name: path.basename(parsed.cwd) || parsed.cwd,
      path: parsed.cwd,
      lastActiveMs: t.mtimeMs
    });
  }

  return [...byCwd.values()].sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

/** Resolve a dirName to its recent ProjectRef by membership, or null. */
export function resolveProject(config: Partial<Config>, dirName: string, options: ProjectsOptions = {}): ProjectRef | null {
  return listRecentProjects(config, options).find(r => r.dirName === dirName) || null;
}

/* --------------------------------------------------------------- security */

/**
 * Authoritative set of file paths GET /api/management/file may serve: every
 * path this scanner itself enumerated across the global scope and all recent
 * project scopes. Exact membership only — secrets under the same roots
 * (~/.claude/.credentials.json, history.jsonl, project .env) are never
 * members because no scanner emits them.
 */
export async function collectServablePaths(config: Partial<Config>, options: ProjectsOptions = {}): Promise<Set<string>> {
  const projects = listRecentProjects(config, options);
  const scopes = await Promise.all([
    readGlobalScope(options.homeDir),
    ...projects.map(p => readProjectScope(p.path, p.dirName, options.homeDir))
  ]);

  const allowed = new Set<string>();
  for (const scope of scopes) {
    for (const item of [...scope.skills, ...scope.agents, ...scope.commands, ...scope.rules, ...scope.memory]) {
      allowed.add(item.path);
    }
    for (const hook of scope.hooks) {
      allowed.add(hook.declaredIn);
      if (hook.scriptPath) allowed.add(hook.scriptPath);
    }
    for (const s of scope.settings) {
      if (s.exists) allowed.add(s.path);
    }
    for (const plugin of scope.plugins) {
      if (plugin.manifestPath) allowed.add(plugin.manifestPath);
    }
  }
  return allowed;
}

/**
 * Serve one enumerated file. Null on any rejection (relative path, `..`
 * survivor, non-member, unreadable) — the API layer distinguishes 403 vs 404
 * by re-checking membership itself.
 */
export async function readServableFile(p: string, allowed: Set<string>, cap = FILE_CONTENT_CAP): Promise<FileContent | null> {
  if (!path.isAbsolute(p) || path.normalize(p) !== p) return null;
  if (!allowed.has(p)) return null;
  try {
    const stat = await fsp.stat(p);
    if (!stat.isFile()) return null;
    if (stat.size <= cap) {
      return { path: p, content: await fsp.readFile(p, 'utf8'), size: stat.size, truncated: false };
    }
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(cap);
      const { bytesRead } = await fh.read(buf, 0, cap, 0);
      return { path: p, content: buf.subarray(0, bytesRead).toString('utf8'), size: stat.size, truncated: true };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
