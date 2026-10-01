/**
 * git-stats.ts — read-only local git state of each pinned project, for the Management tab's Git sub-view.
 *
 * Design: `docs/superpowers/specs/2026-10-01-git-stats-design.md` §2. Node built-ins only, and git runs against local refs only: no fetch, no push, no `gh`,
 * nothing that writes to a repo (D4). This is the server's own reader, not git-sync's engine (§1): nothing under `plugin/` is imported here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PinRow, RepoGitStats } from '../../shared/types.js';

/** Exit code and output of one git call. Rejects only when git could not be spawned or outlived its timeout; a non-zero exit resolves. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `rev-list --left-right --count` result, keyed by `memoKey`. */
export type AheadBehind = { ahead: number; behind: number };

/** Ahead/behind counts keyed by `` `${toplevel}\0${branchSha}\0${baseSha}` ``, so a count is only recomputed when a sha moves. */
export type GitMemo = Map<string, AheadBehind>;

export const GIT_TIMEOUT_MS = 5000;

/**
 * Added over `process.env` for every call. `GIT_OPTIONAL_LOCKS=0` keeps `git status` from taking `index.lock` while the user runs git in the same repo;
 * `LC_ALL=C` keeps the output we parse in one language.
 */
export const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } as const;

/** A git call killed by its timeout. `code` is what `readRepo` keys on, so a test runner can raise it without this class. */
export class GitTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(readonly timeoutMs: number) {
    super(`git timed out after ${timeoutMs}ms`);
  }
}

/** The real runner, with knobs only tests turn: a short timeout, or a `bin` that is not git. */
export function makeGitRunner(opts: { timeoutMs?: number; bin?: string } = {}): GitRunner {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const bin = opts.bin ?? 'git';
  return (cwd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd, timeout: timeoutMs, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
          if (e.killed) return reject(new GitTimeoutError(timeoutMs));
          reject(err);
        },
      );
    });
}

export const defaultGitRunner: GitRunner = makeGitRunner();

/** The memo's keys, in insertion order. Tests observe the memo only through this. */
export function memoKeys(memo: GitMemo): string[] {
  return [...memo.keys()];
}

/** A non-zero exit no caller expected. Carries the message the repo's `error` state shows. */
class GitCallError extends Error {}

/**
 * D7, copied from git-sync's `trunkOf` (never imported, §1): the branch `origin/HEAD` points at, else `main`, else `master`, each candidate's
 * remote-tracking ref checked before its local one. Null where git-sync would refuse with `no-trunk`.
 */
export async function trunkOf(run: GitRunner, cwd: string): Promise<string | null> {
  const symbolic = await run(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (symbolic.code === 0) {
    // The whole name after the prefix, never the last segment: a trunk may be `release/x`.
    const ref = symbolic.stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
  }
  for (const name of ['main', 'master']) {
    if ((await refExists(run, cwd, `refs/remotes/origin/${name}`)) || (await refExists(run, cwd, `refs/heads/${name}`))) return name;
  }
  return null;
}

async function refExists(run: GitRunner, cwd: string, ref: string): Promise<boolean> {
  return (await run(cwd, ['show-ref', '--verify', '--quiet', ref])).code === 0;
}

/**
 * Entries of `status --porcelain=v1 -z`, counted the way `git status` lists them. A rename or copy carries its source path as one extra NUL-separated field,
 * which is skipped rather than counted as a second entry.
 */
function countStatusEntries(z: string): number {
  const fields = z.split('\0');
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue; // the trailing empty field after the last NUL
    n++;
    if (/[RC]/.test(f.slice(0, 2))) i++;
  }
  return n;
}

/** One local branch, as `for-each-ref refs/heads` reports it. */
interface LocalRef {
  name: string;
  sha: string;
  committedMs: number;
  /** Set for a branch checked out in any worktree, the main one included. */
  worktreePath: string | null;
}

const LOCAL_REF_FORMAT = '%(refname)%00%(objectname)%00%(committerdate:unix)%00%(worktreepath)';

function parseLocalRefs(out: string): LocalRef[] {
  const refs: LocalRef[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [refname, sha, unix, wt] = line.split('\0');
    refs.push({ name: refname.replace(/^refs\/heads\//, ''), sha, committedMs: Number(unix) * 1000, worktreePath: wt || null });
  }
  return refs;
}

/** Newest mtime of `FETCH_HEAD` across every worktree: a fetch inside a linked worktree writes only `<common-dir>/worktrees/<name>/FETCH_HEAD`. */
async function newestFetchHead(commonDir: string): Promise<number | null> {
  const candidates = [path.join(commonDir, 'FETCH_HEAD')];
  try {
    for (const name of await fs.promises.readdir(path.join(commonDir, 'worktrees'))) candidates.push(path.join(commonDir, 'worktrees', name, 'FETCH_HEAD'));
  } catch {
    // No linked worktrees.
  }
  let newest: number | null = null;
  for (const file of candidates) {
    try {
      const { mtimeMs } = await fs.promises.stat(file);
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // Never fetched from this worktree.
    }
  }
  return newest;
}

/**
 * One pin's git state. Never rejects: a git failure becomes that repo's `error` state so the other repos in the response are unaffected. The folder is
 * stat'd before any git runs, and calls run strictly one after another, so a pinned repo never has more than one git process alive on its behalf.
 */
export async function readRepo(pin: PinRow, run: GitRunner, memo: GitMemo): Promise<RepoGitStats> {
  const base = { dirName: pin.dirName, name: pin.name, path: pin.path };
  if (pin.path === null) return { ...base, state: 'missing' };
  try {
    if (!(await fs.promises.stat(pin.path)).isDirectory()) return { ...base, state: 'missing' };
  } catch {
    return { ...base, state: 'missing' };
  }

  try {
    return await readGitFacts(base, pin.path, run, memo);
  } catch (err) {
    return { ...base, state: 'error', message: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  const e = err as { code?: unknown; timeoutMs?: unknown; message?: unknown; args?: string[] };
  const sub = e.args?.[0] ?? 'call';
  if (e.code === 'ENOENT') return 'git not found';
  if (e.code === 'ETIMEDOUT') {
    const ms = typeof e.timeoutMs === 'number' ? e.timeoutMs : GIT_TIMEOUT_MS;
    return `git ${sub} timed out after ${ms / 1000}s`;
  }
  return typeof e.message === 'string' && e.message ? e.message : `git ${sub} failed`;
}

async function readGitFacts(base: { dirName: string; name: string; path: string | null }, cwd: string, run: GitRunner, memo: GitMemo): Promise<RepoGitStats> {
  // Tags a rejection with the args it came from, so a timeout message can name the subcommand.
  const git = async (dir: string, args: string[]) => {
    try {
      return await run(dir, args);
    } catch (err) {
      if (err && typeof err === 'object') Object.assign(err, { args });
      throw err;
    }
  };
  const expect0 = async (dir: string, args: string[]) => {
    const r = await git(dir, args);
    if (r.code !== 0) throw new GitCallError(`git ${args[0]} exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`);
    return r.stdout;
  };

  // `--path-format` applies to the options after it; `--show-toplevel` is absolute anyway.
  const where = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (where.code !== 0) return { ...base, state: 'not-git' };
  const [toplevel, commonDir] = where.stdout.split('\n');
  if (!toplevel || !commonDir) throw new GitCallError('git rev-parse printed no toplevel');

  // Every later call runs from the toplevel: the pin may be a subdirectory, and `status` paths are toplevel-relative either way.
  let branch: string | null = null;
  let detachedSha: string | null = null;
  const head = await git(toplevel, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head.code === 0) branch = head.stdout.trim();
  else if (head.code === 1) detachedSha = (await expect0(toplevel, ['rev-parse', '--short', 'HEAD'])).trim();
  else throw new GitCallError(`git symbolic-ref exited ${head.code}`);

  // Untracked mode pinned to `normal` (the default) so a user's `status.showUntrackedFiles=all` cannot turn one untracked directory into one per file.
  const uncommitted = countStatusEntries(await expect0(toplevel, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']));

  const locals = parseLocalRefs(await expect0(toplevel, ['for-each-ref', `--format=${LOCAL_REF_FORMAT}`, 'refs/heads']));
  const hasOrigin = (await expect0(toplevel, ['remote'])).split('\n').includes('origin');
  const trunk = await trunkOf(git, toplevel);

  // The local trunk comes from the for-each-ref list, so a trunk that exists only as `origin/<trunk>` is never named as `refs/heads/<trunk>` (§2).
  let trunkVsOrigin: AheadBehind | null = null;
  const localTrunk = trunk === null ? undefined : locals.find(r => r.name === trunk);
  if (trunk !== null && hasOrigin && localTrunk) {
    const originRef = `refs/remotes/origin/${trunk}`;
    if (await refExists(git, toplevel, originRef)) {
      const counts = (await expect0(toplevel, ['rev-list', '--left-right', '--count', `${originRef}...refs/heads/${trunk}`])).trim().split(/\s+/);
      trunkVsOrigin = { ahead: Number(counts[1]), behind: Number(counts[0]) };
    }
  }

  return {
    ...base,
    state: 'ok',
    toplevel,
    branch,
    detachedSha,
    onTrunk: branch !== null && branch === trunk,
    uncommitted,
    trunk,
    hasOrigin,
    trunkVsOrigin,
    fetchedAtMs: await newestFetchHead(commonDir),
    branches: [],
    unmergedTotal: 0,
    mergedCount: 0,
  };
}
