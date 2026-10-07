/**
 * sync-plugin.ts — reinstall the dashboard plugin so the installed copy matches the pushed repo.
 *
 *   pnpm plugin:sync
 *
 * A plugin install is a copy, not a link: an edit under plugin/ changes nothing for a running session until the plugin is reinstalled. And the cache is keyed
 * by the version in plugin.json, so `claude plugin update` stops at "already at the latest version" however far the commits behind it have moved — hence
 * uninstall + install rather than update. The marketplace is the GitHub repo, so the installer sees pushed `main` and nothing else; this script refuses any
 * tree that is less than that rather than reinstalling stale code and reporting success. Ported from backlog-manager's `scripts/sync-plugin.mjs`, minus its
 * sparse-checkout and version-pruning halves: this plugin is a subfolder, so neither problem exists here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETPLACE = 'claude-agents-dashboard-marketplace';
export const PLUGIN_ID = `claude-agents-dashboard@${MARKETPLACE}`;
export const MARKETPLACE_SOURCE = 'futin/claude-agents-dashboard';

/** What a session loads from the install. Anything else in the install dir (`.in_use`, `.orphaned_at`) is Claude Code's bookkeeping. */
export const PUBLISHED_PATHS = ['.claude-plugin', 'hooks', 'skills'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(REPO_ROOT, 'plugin');
const INSTALLED = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

export interface InstallRecord {
  scope?: string;
  installPath: string;
  version?: string;
  gitCommitSha?: string;
}

/**
 * The engine writes the hooks module's type declarations into `.claude-plugin/types/` whenever it loads the mod, on both sides of an install — never
 * published, and never drift.
 */
const GENERATED_DIRS = [path.join('.claude-plugin', 'types')];

/** sha256 over every file's relative path and bytes, so a rename or deletion moves it too. '' for a root that does not exist. */
export function hashTree(root: string): string {
  if (!fs.existsSync(root)) return '';
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!GENERATED_DIRS.some((g) => full.endsWith(path.sep + g))) walk(full); }
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(path.relative(root, file).split(path.sep).join('/'));
    digest.update('\0');
    digest.update(fs.readFileSync(file));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function publishedDigests(pluginRoot: string): Record<string, string> {
  return Object.fromEntries(PUBLISHED_PATHS.map((p) => [p, hashTree(path.join(pluginRoot, p))]));
}

export function driftedPaths(repo: Record<string, string>, installed: Record<string, string>): string[] {
  return PUBLISHED_PATHS.filter((p) => repo[p] !== installed[p]);
}

/** Why this tree cannot be published, or undefined when it can. Most fundamental first: off main, every later answer is about the wrong branch. */
export function publishBlocker({ branch, dirty, ahead, behind }: { branch: string; dirty: string[]; ahead: number; behind: number }): string | undefined {
  if (branch !== 'main') {
    return `on branch ${branch}, but the marketplace installs main — merge to main and sync from there.`;
  }
  if (dirty.length > 0) {
    return `uncommitted changes under plugin/ or .claude-plugin/:\n${dirty.map((l) => `  ${l}`).join('\n')}\n`
      + 'The installer reads GitHub, not the working tree — commit and push these first.';
  }
  if (ahead > 0) return `main is ${ahead} commit(s) ahead of origin/main. The marketplace clones from GitHub, so push first:\n  git push`;
  if (behind > 0) return `main is ${behind} commit(s) behind origin/main — pull first, or the install would not match this checkout:\n  git pull --ff-only`;
  return undefined;
}

/** The user-scope install record for this plugin, else its first record; undefined when it is not installed. */
export function readInstall(installedPath = INSTALLED): InstallRecord | undefined {
  if (!fs.existsSync(installedPath)) return undefined;
  const entries = JSON.parse(fs.readFileSync(installedPath, 'utf8'))?.plugins?.[PLUGIN_ID];
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  return entries.find((e: InstallRecord) => e.scope === 'user') ?? entries[0];
}

const git = (args: string[]): string => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const short = (sha?: string): string => sha?.slice(0, 7) ?? '?';

function main(): void {
  const install = readInstall();
  if (!install) {
    console.error(`${PLUGIN_ID} is not installed. Install it once, then this script keeps it current:`);
    console.error(`  claude plugin marketplace add ${MARKETPLACE_SOURCE} --sparse .claude-plugin plugin`);
    console.error(`  claude plugin install ${PLUGIN_ID}`);
    process.exit(1);
  }

  const repo = publishedDigests(PLUGIN_ROOT);
  const drifted = driftedPaths(repo, publishedDigests(install.installPath));
  // Digests only, not the install's commit: most commits never touch plugin/, and reinstalling identical bytes after each would be noise.
  if (drifted.length === 0) {
    console.log(`in sync — installed v${install.version} @ ${short(install.gitCommitSha)} carries the same ${PUBLISHED_PATHS.join(', ')} as plugin/`);
    return;
  }
  console.log(`reinstalling — ${drifted.join(', ')} differ(s) from plugin/`);

  // Fetch first, or a stale origin/main makes a pushed tree look unpushed.
  git(['fetch', '--quiet', 'origin', 'main']);
  const blocker = publishBlocker({
    branch: git(['branch', '--show-current']).trim(),
    dirty: git(['status', '--porcelain', '--', 'plugin', '.claude-plugin']).split('\n').filter(Boolean),
    ahead: Number(git(['rev-list', '--count', 'origin/main..HEAD']).trim()),
    behind: Number(git(['rev-list', '--count', 'HEAD..origin/main']).trim()),
  });
  if (blocker) {
    console.error(blocker);
    process.exit(1);
  }

  const claude = (args: string[]): void => { execFileSync('claude', args, { stdio: 'inherit' }); };
  claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
  claude(['plugin', 'uninstall', PLUGIN_ID]);
  try {
    claude(['plugin', 'install', PLUGIN_ID]);
  } catch (error) {
    // The uninstall already ran, so this machine now has no plugin at all — say so rather than let a stack trace imply a smaller mess.
    console.error(`install failed after the uninstall — ${PLUGIN_ID} is NOT installed right now. Fix with:`);
    console.error(`  claude plugin install ${PLUGIN_ID}`);
    throw error;
  }

  const after = readInstall();
  if (!after) {
    console.error(`${PLUGIN_ID} is not installed after the reinstall`);
    process.exit(1);
  }
  const still = driftedPaths(repo, publishedDigests(after.installPath));
  if (still.length > 0) {
    console.error(`installed ${still.join(', ')} still differ(s) from plugin/ at ${after.installPath} (installed commit ${short(after.gitCommitSha)})`);
    console.error('The cache is keyed by the version in plugin/.claude-plugin/plugin.json — if the bytes did not move, a version bump is the lever.');
    process.exit(1);
  }
  console.log(`installed v${after.version} @ ${short(after.gitCommitSha)} → ${after.installPath}`);
  console.log('restart Claude Code for the new skills to load');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
