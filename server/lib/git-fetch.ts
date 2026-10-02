/**
 * git-fetch.ts — runs `git fetch origin` over the pinned repos, once per common dir, and remembers how each one went.
 *
 * Design: `docs/superpowers/specs/2026-10-02-git-fetch-design.md` §1. Node built-ins only. This is a second git process per repo by design (D13): Git Stats'
 * "one git process per repo" rule is about its reader's own calls, and the reader stays read-only. Nothing here pulls, pushes, prunes or prompts.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { FetchClock, FetchError, RepoLastFetch } from '../../shared/types.js';
import { archivedSessionIds } from './archived.js';
import type { Config } from './config.js';
import { listPinRows } from './management.js';
import { getGitFetchSecs, getPinnedProjects } from './settings.js';

/**
 * Exit code and output of one git call. `env` is an overlay the runner spreads over `process.env`. Resolves on any exit, `timedOut` when the group was killed;
 * rejects only when the process could not be spawned.
 */
export type FetchRunner = (cwd: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;

export const FETCH_TIMEOUT_MS = 30_000;

/**
 * The flags make the "refs only" guarantee hold against a user's `fetch.prune` / `remote.origin.prune` / `fetch.recurseSubmodules`; the hooks path keeps a repo's
 * `reference-transaction` hook from running unattended every interval; `--no-auto-maintenance` needs git ≥ 2.29 (D4).
 */
export const FETCH_ARGS: readonly string[] = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', 'fetch', 'origin', '--quiet', '--no-prune', '--no-recurse-submodules', '--no-auto-maintenance',
]);

/** Overlay for the read-only calls (`rev-parse`, `remote`, `config`): one language to parse, and no `index.lock` taken under the user's own git. */
const READ_ENV: Record<string, string> = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

/**
 * Never prompt (D5): git consults an askpass before `GIT_TERMINAL_PROMPT`, and an empty one falls through to the disabled terminal prompt; ssh has an askpass
 * of its own.
 */
const FETCH_ENV: Record<string, string> = { ...READ_ENV, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };

const SSH_BATCH = 'ssh -o BatchMode=yes';

/** Kills the child's whole process group, so an ssh grandchild dies with git; falls back to the child alone when the group is not reachable. */
function killGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** The real runner, with knobs only tests turn: a short timeout, or a `bin` that is not git. Never a shell. */
export function makeFetchRunner(opts: { timeoutMs?: number; bin?: string } = {}): FetchRunner {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const bin = opts.bin ?? 'git';
  return (cwd, args, env) =>
    new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        // Detached with stdin ignored: no controlling terminal for git or ssh to ask on, and a group of its own to kill on a timeout.
        child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout!.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
      child.stderr!.setEncoding('utf8').on('data', (d: string) => { stderr += d; });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killGroup(child);
        resolve({ code: -1, stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.on('error', e => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(e);
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
      });
    });
}

let runner: FetchRunner = makeFetchRunner();

/** Test seam: route every call through `run`, or back to the real runner with `null`. */
export function overrideFetchRunner(run: FetchRunner | null): void {
  runner = run ?? makeFetchRunner();
}

type Classified = Exclude<FetchError, 'timeout' | 'other'>;

/** Walked in order, first match wins (§1). */
const CLASSIFIERS: ReadonlyArray<readonly [Classified, readonly RegExp[]]> = [
  ['auth', [/Permission denied \(publickey/i, /Authentication failed/i, /could not read Username/i, /terminal prompts disabled/i, /Host key verification failed/i]],
  ['offline', [
    /Could not resolve host/i, /Network is unreachable/i, /Connection refused/i, /Connection timed out/i, /Could not connect/i, /Couldn't connect to server/i,
    /Failed to connect to/i, /No route to host/i,
  ]],
  ['lock', [/cannot lock ref/i, /\.lock': File exists/i, /Unable to create .*\.lock/i]],
];

/** Why a failed fetch failed, as far as its stderr says. `timedOut` wins over whatever stderr held when the group was killed. */
export function classifyFetchError(stderr: string, timedOut: boolean): FetchError {
  if (timedOut) return 'timeout';
  for (const [kind, patterns] of CLASSIFIERS) if (patterns.some(p => p.test(stderr))) return kind;
  return 'other';
}

let now: () => number = Date.now;

/** Test seam: the clock `fetchAll` stamps with, or the real one with `null`. */
export function overrideFetchClock(fn: (() => number) | null): void {
  now = fn ?? Date.now;
}

// Module state. `nextAtMs` is only ever set by the schedule (the timer rules), which is not in this file yet; `fetchAll` leaves it null.
const lastFetch = new Map<string, RepoLastFetch>();
let runningSinceMs: number | null = null;
let lastEndedMs: number | null = null;
let nextAtMs: number | null = null;
let inFlight: Promise<FetchClock> | null = null;

/** The verdict of the last fetch of the repo whose toplevel is `toplevel`; null before one ran, after its group was skipped, or once it is unpinned. */
export function lastFetchFor(toplevel: string): RepoLastFetch | null {
  const hit = lastFetch.get(toplevel);
  return hit ? { ...hit } : null;
}

export function getFetchClock(): FetchClock {
  return { intervalSecs: getGitFetchSecs(), nextAtMs, runningSinceMs, lastEndedMs };
}

/** Test seam: wait out a fetch in flight (it would otherwise write its clock into the next case), then forget everything. */
export async function resetGitFetch(): Promise<void> {
  if (inFlight) await inFlight.catch(() => undefined);
  inFlight = null;
  lastFetch.clear();
  runningSinceMs = null;
  lastEndedMs = null;
  nextAtMs = null;
}

/**
 * Fetches every pinned repo's `origin` now. A call while one runs gets that run's promise (D6), timer and button alike. Always resolves, with the clock as it
 * stands when the run ends.
 */
export function fetchAll(config: Partial<Config>): Promise<FetchClock> {
  if (inFlight) return inFlight;
  const p = runFetch(config).finally(() => { if (inFlight === p) inFlight = null; });
  inFlight = p;
  return p;
}

async function runFetch(config: Partial<Config>): Promise<FetchClock> {
  runningSinceMs = now();
  try {
    await fetchGroups(config, runner);
  } catch {
    // A failure outside one group's own handling (the pin listing) must not lose the clock below or reject the caller.
  } finally {
    runningSinceMs = null;
    lastEndedMs = now();
  }
  return getFetchClock();
}

interface Resolved { toplevel: string; commonDir: string }

/** The same pin rows `readGitStats` builds, so a pin resolves to the same path in both (git-stats.ts `readAll`). */
async function resolvePins(config: Partial<Config>, run: FetchRunner): Promise<Resolved[]> {
  const pinned = getPinnedProjects();
  const pins = listPinRows(config, pinned, { archivedIds: archivedSessionIds(), pinnedDirs: new Set(pinned) });
  const found = await Promise.all(pins.map(async (pin): Promise<Resolved | null> => {
    if (pin.path === null) return null;
    try {
      const r = await run(pin.path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], READ_ENV);
      if (r.code !== 0) return null;
      const [toplevel, commonDir] = r.stdout.split('\n').map(l => l.trim());
      return toplevel && commonDir ? { toplevel, commonDir } : null;
    } catch {
      return null;
    }
  }));
  return found.filter((r): r is Resolved => r !== null);
}

async function fetchGroups(config: Partial<Config>, run: FetchRunner): Promise<void> {
  const resolved = await resolvePins(config, run);

  // Pin order is preserved: the group's cwd is its first toplevel, and a repeated toplevel (two pins in one repo) is one entry.
  const groups = new Map<string, string[]>();
  for (const { toplevel, commonDir } of resolved) {
    const tops = groups.get(commonDir) ?? [];
    if (!tops.includes(toplevel)) tops.push(toplevel);
    groups.set(commonDir, tops);
  }

  // A repo no pin resolved to this run keeps no verdict, so re-pinning it later cannot resurrect a stale "needs auth".
  const live = new Set([...groups.values()].flat());
  for (const key of [...lastFetch.keys()]) if (!live.has(key)) lastFetch.delete(key);

  await Promise.all([...groups.values()].map(tops => fetchGroup(tops, run)));
}

/** One group, never rejecting: whatever goes wrong is this group's entry, not the others'. */
async function fetchGroup(toplevels: string[], run: FetchRunner): Promise<void> {
  const cwd = toplevels[0];
  const skip = (): void => { for (const t of toplevels) lastFetch.delete(t); };
  let error: FetchError | null;
  try {
    const remotes = await run(cwd, ['remote'], READ_ENV);
    if (remotes.code !== 0 || !remotes.stdout.split('\n').some(l => l.trim() === 'origin')) return skip();

    // 0 is set, 1 is unset; anything else is git failing, which is a skip rather than a guess about the user's ssh.
    const sshCommand = await run(cwd, ['config', '--get', 'core.sshCommand'], READ_ENV);
    if (sshCommand.code !== 0 && sshCommand.code !== 1) return skip();

    // The user's own ssh, however they chose it, is left exactly as set; otherwise BatchMode for the cleaner error (D5).
    const userSsh = sshCommand.code === 0 || process.env.GIT_SSH_COMMAND !== undefined || process.env.GIT_SSH !== undefined;
    const env = userSsh ? FETCH_ENV : { ...FETCH_ENV, GIT_SSH_COMMAND: SSH_BATCH };

    try {
      const r = await run(cwd, [...FETCH_ARGS], env);
      error = r.code === 0 && !r.timedOut ? null : classifyFetchError(r.stderr, r.timedOut);
    } catch {
      error = 'other';
    }
  } catch {
    return skip();
  }
  const atMs = now();
  for (const t of toplevels) lastFetch.set(t, { atMs, error });
}
