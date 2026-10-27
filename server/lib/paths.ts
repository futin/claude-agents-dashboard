/**
 * paths.ts — where Claude keeps its own files on this machine: `~/.claude`, `~/.claude.json`, and the roots Claude makes working dirs under. A leaf on
 * purpose (Node built-ins only): `scan.ts`, `management.ts`, `compact-window.ts` and the rest all need these, and while they lived in `management.ts`
 * every importer closed an import cycle back through it. `test/import-cycles.test.ts` keeps them broken.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeHome(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude');
}

/** `~/.claude.json` — a sibling of {@link claudeHome}, not inside it. Read for its `mcpServers` only; never servable. */
export function claudeJsonPath(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude.json');
}

let claudeRootsOverride: readonly string[] | null = null;

/**
 * Test seam: replace {@link defaultClaudeRoots} process-wide, null to restore. The
 * API suites need it — their `$HOME`, and so every project they plant, is a tmpdir.
 */
export function overrideClaudeRoots(roots: readonly string[] | null): void {
  claudeRootsOverride = roots;
}

/**
 * Where Claude itself makes working dirs, never offered for pinning: the temp
 * dirs (`os.tmpdir()` and its realpath — macOS hands out a `/var` symlink —
 * `/tmp`, `/private/tmp`) that hold session scratchpads, `~/.claude`, and the
 * desktop app's data dir, which holds its scratch workspaces. Not
 * platform-gated: a root that does not exist hides nothing.
 */
export function defaultClaudeRoots(homeDir?: string): readonly string[] {
  if (claudeRootsOverride) return claudeRootsOverride;
  const home = homeDir || os.homedir();
  const roots = [os.tmpdir(), '/tmp', '/private/tmp', claudeHome(homeDir), path.join(home, 'Library', 'Application Support', 'Claude')];
  try { roots.push(fs.realpathSync(os.tmpdir())); } catch { /* keep the literal */ }
  return roots;
}

/** Whether `p` is `root` itself or lies inside it, by path alone — no symlink is resolved. */
export function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Whether `p` is at or under one of `roots` ({@link defaultClaudeRoots}). */
export function isClaudeOwned(p: string, roots: readonly string[]): boolean {
  return roots.some(root => isUnder(p, root));
}
