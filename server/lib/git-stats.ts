/**
 * git-stats.ts — read-only local git state of each pinned project, for the Management tab's Git sub-view.
 *
 * Design: `docs/superpowers/specs/2026-10-01-git-stats-design.md` §2. Node built-ins only, and git runs against local refs only: no fetch, no push, no `gh`,
 * nothing that writes to a repo (D4). This is the server's own reader, not git-sync's engine (§1): nothing under `plugin/` is imported here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { GitBranch, GitStatsResponse, PinRow, RepoGitStats } from '../../shared/types.js';
import { archivedSessionIds } from './archived.js';
import type { Config } from './config.js';
import { listPinRows } from './management.js';
import { getPinnedProjects } from './settings.js';

/** Exit code and output of one git call. Rejects only when git could not be spawned or outlived its timeout; a non-zero exit resolves. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `rev-list --left-right --count <base>...<ref>`: commits only on `<ref>` (ahead) and only on the base (behind). */
export type AheadBehind = { ahead: number; behind: number };

/**
 * A memo value. `merged` is the §2 proof, filled the first time a branch needs it; the trunk's own row stores counts only, and a branch whose shas match
 * that row computes the proof on top of the shared entry.
 */
export type MemoEntry = AheadBehind & { merged?: boolean };

/**
 * Keyed by `` `${toplevel}\0${refSha}\0${baseSha}` ``, so counts and the merged proof are only recomputed when a sha moves. One map may serve many repos:
 * each read replaces only its own toplevel's entries.
 */
export type GitMemo = Map<string, MemoEntry>;

/** The most branches one repo serves; `unmergedTotal` counts the rest. */
export const MAX_BRANCHES = 50;

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
    // A missing cwd fails the spawn with the same ENOENT as a missing git binary, so a folder deleted since the stat would read as "git not found".
    if ((err as { code?: unknown }).code === 'ENOENT' && !(await isDirectory(pin.path))) return { ...base, state: 'missing' };
    return { ...base, state: 'error', message: errorMessage(err) };
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    // A worktree folder deleted without `git worktree prune` is still listed; its recorded path is the best we have.
    return p;
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
  const localTrunk = trunk === null ? undefined : locals.find(r => r.name === trunk);
  const originTrunk = trunk === null ? null : await resolveRef(git, toplevel, `refs/remotes/origin/${trunk}`);

  // Every memo entry this read touches; the repo's other entries are dropped at the end, so the memo never outlives a branch.
  const used = new Map<string, MemoEntry>();
  const keyOf = (refSha: string, baseSha: string) => `${toplevel}\0${refSha}\0${baseSha}`;
  const counts = async (ref: string, refSha: string, b: { ref: string; sha: string }): Promise<MemoEntry> => {
    const key = keyOf(refSha, b.sha);
    let entry = used.get(key) ?? memo.get(key);
    if (!entry) {
      const [behind, ahead] = (await expect0(toplevel, ['rev-list', '--left-right', '--count', `${b.ref}...${ref}`])).trim().split(/\s+/).map(Number);
      entry = { ahead, behind };
    }
    used.set(key, entry);
    return entry;
  };

  let trunkVsOrigin: AheadBehind | null = null;
  if (trunk !== null && hasOrigin && localTrunk && originTrunk) {
    const { ahead, behind } = await counts(`refs/heads/${trunk}`, localTrunk.sha, originTrunk);
    trunkVsOrigin = { ahead, behind };
  }

  // D8: branches are measured against origin's trunk when it exists, else the local one. No base means nothing can be counted or proved merged.
  const baseRef = originTrunk ?? (localTrunk ? { ref: `refs/heads/${localTrunk.name}`, sha: localTrunk.sha } : null);

  const unmerged: { ref: LocalRef; counts: AheadBehind | null }[] = [];
  let mergedCount = 0;
  for (const ref of locals) {
    if (ref.name === trunk) continue;
    if (!baseRef) {
      unmerged.push({ ref, counts: null });
      continue;
    }
    const full = `refs/heads/${ref.name}`;
    const entry = await counts(full, ref.sha, baseRef);
    if (entry.merged === undefined) entry.merged = entry.ahead === 0 || (await patchEquivalent(expect0, toplevel, baseRef.ref, full));
    if (entry.merged) mergedCount++;
    else unmerged.push({ ref, counts: entry });
  }

  for (const key of memo.keys()) if (key.startsWith(`${toplevel}\0`) && !used.has(key)) memo.delete(key);
  for (const [key, entry] of used) memo.set(key, entry);

  // The main worktree is the common dir's parent, not the toplevel: for a pin on a linked worktree the two differ (§2 "Worktree badge").
  const mainWorktree = await realpathOr(path.dirname(commonDir));
  unmerged.sort((a, b) => b.ref.committedMs - a.ref.committedMs || (a.ref.name < b.ref.name ? -1 : a.ref.name > b.ref.name ? 1 : 0));
  const branches: GitBranch[] = [];
  for (const { ref, counts: c } of unmerged.slice(0, MAX_BRANCHES)) {
    const wt = ref.worktreePath === null ? null : await realpathOr(ref.worktreePath);
    branches.push({
      name: ref.name,
      ahead: c ? c.ahead : null,
      behind: c ? c.behind : null,
      lastCommitMs: ref.committedMs,
      worktreePath: wt !== null && wt !== mainWorktree ? wt : null,
    });
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
    trunkRefs: trunk === null ? null : { local: localTrunk !== undefined, origin: originTrunk !== null },
    fetchedAtMs: await newestFetchHead(commonDir),
    branches,
    unmergedTotal: unmerged.length,
    mergedCount,
  };
}

/** The sha `ref` points at, or null when it does not exist. */
async function resolveRef(run: GitRunner, cwd: string, ref: string): Promise<{ ref: string; sha: string } | null> {
  const r = await run(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  return r.code === 0 && r.stdout.trim() ? { ref, sha: r.stdout.trim() } : null;
}

/**
 * git-sync's M2 proof (`patchEquivalence`), re-implemented: every commit on `ref` past `base` has a patch-equivalent commit in `base`. Cherry skips merge
 * commits, so any merge in the range refuses the proof, since a merge can carry real work cherry never sees. An empty cherry list never proves anything.
 * Cherry runs first: an unmerged branch almost always fails it, and that saves the merges walk.
 */
async function patchEquivalent(expect0: (dir: string, args: string[]) => Promise<string>, cwd: string, base: string, ref: string): Promise<boolean> {
  const lines = (await expect0(cwd, ['cherry', base, ref])).split('\n').filter(Boolean);
  if (lines.length === 0 || lines.some(l => !l.startsWith('-'))) return false;
  return (await expect0(cwd, ['rev-list', '--merges', `${base}..${ref}`])).trim() === '';
}

/** The runner every API read uses. Process-wide, like `overrideClaudeRoots`: the API suites build their server from `createRequestListener(cfg)` alone. */
let runner: GitRunner = defaultGitRunner;

/** Test seam: replace the runner behind `GET /api/git-stats` process-wide; null restores {@link defaultGitRunner}. */
export function overrideGitRunner(run: GitRunner | null): void {
  runner = run ?? defaultGitRunner;
}

/** The memo that outlives one API read, so a poll with no sha moved makes only the cheap calls. */
const memo: GitMemo = new Map();

/** The module memo's keys. Test-only: the API suites observe the memo through this and nothing else. */
export function gitStatsMemoKeys(): string[] {
  return memoKeys(memo);
}

let inFlight: Promise<GitStatsResponse> | null = null;

/**
 * Every pinned project's git state, in pin order. A call that arrives while a read is in flight gets that read's promise, so a slow cold poll is never
 * doubled by a second tab or the ↻ button. Repos run in parallel; each keeps its own calls strictly sequential (see {@link readRepo}).
 */
export function readGitStats(config: Partial<Config>): Promise<GitStatsResponse> {
  if (inFlight) return inFlight;
  const read = readAll(config).finally(() => { inFlight = null; });
  inFlight = read;
  return read;
}

async function readAll(config: Partial<Config>): Promise<GitStatsResponse> {
  // The same options `GET /api/pins` builds its `pinned` rows with, so a pin resolves to the same path in both.
  const pins = listPinRows(config, getPinnedProjects(), { archivedIds: archivedSessionIds(), pinnedDirs: new Set(getPinnedProjects()) });
  const run = runner;
  const repos = await Promise.all(pins.map(pin => readRepo(pin, run, memo)));

  // `readRepo` replaces the entries of the repo it reads, so only a repo that is no longer read is left to drop. When a repo errored its toplevel is
  // unknown, and dropping on a guess would throw away a healthy repo's entries, so that read keeps everything and the next clean one prunes.
  if (repos.every(r => r.state !== 'error')) {
    const live = new Set(repos.flatMap(r => (r.state === 'ok' ? [r.toplevel] : [])));
    for (const key of memo.keys()) if (!live.has(key.slice(0, key.indexOf('\0')))) memo.delete(key);
  }
  return { repos, generatedAt: Date.now() };
}
