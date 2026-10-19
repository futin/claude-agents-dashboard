/**
 * codegraph-store.ts — the status cache and the Sync / Reindex runs behind `GET /api/codegraph` and `POST /api/codegraph/run`.
 *
 * Design: `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` §Source, §Cost, §API, §Levels. State is per graph root, not per pin: a repo pin and its
 * subdirectory pin share one cache entry, one `run` and one `lastRun`. Pid files are read on every GET (cheap); only `codegraph status --json` is cached. There
 * is no timer: a stale entry is refreshed by the GET that finds it stale, so a closed tab costs nothing.
 */
import path from 'node:path';

import { archivedSessionIds } from './archived.js';
import {
  LOCK_LOSS_TEXT,
  currentCodegraphRunner,
  findGraphRoot,
  isDirectory,
  lastLine,
  livePid,
  readCodegraphStatus,
} from './codegraph.js';
import type { StatusRead } from './codegraph.js';
import type { Config } from './config.js';
import { listPinRows } from './management.js';
import { getPinnedProjects } from './settings.js';
import type {
  CodegraphLastRun,
  CodegraphRepo,
  CodegraphResponse,
  CodegraphRun,
  CodegraphRunKind,
  CodegraphStats,
  PinRow,
} from '../../shared/types.js';

/** How long a status read answers GETs before a background refresh starts. */
export const CODEGRAPH_TTL_MS = 25_000;

/** Status reads in flight at once across repos; the slowest repo measured 2.3 s on 2026-10-19, so a cold poll of a dozen is still seconds. */
export const CODEGRAPH_CONCURRENCY = 2;

/** `lastRun.message` for a sync that lost the file lock to the watcher: the watcher is already doing the work, so it is not a failure. */
export const WATCHER_SYNCING_TEXT = 'watcher is syncing it';

let clock: () => number = Date.now;

/** Swaps the clock for tests; null restores `Date.now`. A real wait cannot reach a 25 s TTL. */
export function setCodegraphClock(now: (() => number) | null): void {
  clock = now ?? Date.now;
}

interface Entry { read: StatusRead; atMs: number }
interface OwnRun extends CodegraphRun { watchingAtLaunch: boolean }

const cache = new Map<string, Entry>();
/** The last `ok` stats per root, kept apart from the cache because a failed read replaces the cache entry but a live rebuild still wants the old numbers. */
const lastOk = new Map<string, CodegraphStats>();
/** Reads in flight per root; also how a read knows it was superseded (see {@link dropEntry}). */
const reading = new Map<string, Promise<StatusRead>>();
const runs = new Map<string, OwnRun>();
const lastRuns = new Map<string, CodegraphLastRun>();
/** Roots whose `rebuild.pid` was live on the last GET: one now dead means the rebuild just ended. */
const seenRebuild = new Set<string>();
/** dirNames between `startCodegraphRun`'s entry and its recording step. */
const launching = new Set<string>();
const pending = new Set<Promise<unknown>>();

/** Forgets everything in memory (test seam). Runs already launched still finish, into an empty store. */
export function resetCodegraph(): void {
  cache.clear();
  lastOk.clear();
  reading.clear();
  runs.clear();
  lastRuns.clear();
  seenRebuild.clear();
  launching.clear();
  pending.clear();
}

/** Resolves when every launched run and every status read (cold or background) has ended (test seam). */
export async function codegraphRunsSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  const done = (): void => { pending.delete(p); };
  p.then(done, done);
  return p;
}

// A slot is handed straight to the next waiter instead of being freed and re-taken, so a caller arriving in between cannot jump the queue past the cap.
let active = 0;
const waiters: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CODEGRAPH_CONCURRENCY) await new Promise<void>(resolve => waiters.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next(); else active--;
  }
}

/** A root's status is stale once its cache entry goes, and a read that started before that must not put its answer back. */
function dropEntry(root: string): void {
  cache.delete(root);
  reading.delete(root);
}

function startRead(root: string, pin: PinRow): Promise<StatusRead> {
  const inFlight = reading.get(root);
  if (inFlight) return inFlight;
  const mine: Promise<StatusRead> = limited(() => readCodegraphStatus(pin, currentCodegraphRunner())).then(read => {
    if (reading.get(root) === mine) {
      reading.delete(root);
      cache.set(root, { read, atMs: clock() });
      if (read.kind === 'ok') lastOk.set(root, read.stats);
    }
    return read;
  });
  reading.set(root, mine);
  track(mine);
  return mine;
}

function pinRows(config: Partial<Config>): PinRow[] {
  // The same options `GET /api/pins` and `readGitStats` build their rows with, so a pin resolves to the same path everywhere.
  const pins = getPinnedProjects();
  return listPinRows(config, pins, { archivedIds: archivedSessionIds(), pinnedDirs: new Set(pins) });
}

interface RootLive {
  watching: boolean;
  watcherSinceMs: number | null;
  rebuildLive: boolean;
  rebuildSinceMs: number | null;
}

async function readRootLive(root: string): Promise<RootLive> {
  const meta = path.join(root, '.codegraph');
  const [daemon, rebuild] = await Promise.all([livePid(path.join(meta, 'daemon.pid')), livePid(path.join(meta, 'rebuild.pid'))]);
  return {
    watching: daemon !== null,
    watcherSinceMs: daemon?.startedAtMs ?? null,
    rebuildLive: rebuild !== null,
    rebuildSinceMs: rebuild?.startedAtMs ?? null,
  };
}

/** The graph root of a listed pin whose folder exists; a deleted folder inside an indexed repo must not read as that repo. */
async function rootOf(pin: PinRow): Promise<string | null> {
  if (pin.path === null || !pin.listed || !(await isDirectory(pin.path))) return null;
  return findGraphRoot(pin.path);
}

const NO_LIVE: RootLive = { watching: false, watcherSinceMs: null, rebuildLive: false, rebuildSinceMs: null };

/**
 * Every pinned project's codegraph state, in pin order. A repo with no cache entry is read now; a stale entry answers as it is while one background refresh
 * runs; a fresh one answers from the cache. The pid files are read on every call.
 */
export async function readCodegraph(config: Partial<Config>): Promise<CodegraphResponse> {
  const pins = pinRows(config);
  const roots = await Promise.all(pins.map(rootOf));

  const live = new Map<string, RootLive>();
  await Promise.all([...new Set(roots.filter((r): r is string => r !== null))].map(async root => { live.set(root, await readRootLive(root)); }));

  // A rebuild that has ended since the last GET leaves pre-rebuild stats in the cache; the next read must be fresh.
  for (const [root, l] of live) {
    if (l.rebuildLive) seenRebuild.add(root);
    else if (seenRebuild.delete(root)) dropEntry(root);
  }

  const repos = await Promise.all(pins.map((pin, i) => repoRow(pin, roots[i], roots[i] ? live.get(roots[i]!) ?? NO_LIVE : NO_LIVE)));
  const cliMissing = repos.some(r => r.cliMissing);
  return { generatedAt: clock(), cli: cliMissing ? 'missing' : 'ok', repos: repos.map(r => r.repo) };
}

async function repoRow(pin: PinRow, root: string | null, l: RootLive): Promise<{ repo: CodegraphRepo; cliMissing: boolean }> {
  const head = { dirName: pin.dirName, name: pin.name, path: pin.path };
  const noRoot = { ...head, watching: false, watcherSinceMs: null, rebuildLive: false, run: null, lastRun: null };

  if (root === null) {
    // No graph, or a dead pin: `readCodegraphStatus` decides which without launching the CLI, so nothing is worth caching.
    const read = await readCodegraphStatus(pin, currentCodegraphRunner());
    return { repo: read.kind === 'missing' ? { ...noRoot, state: 'missing' } : { ...noRoot, state: 'none' }, cliMissing: false };
  }

  let read: StatusRead;
  const entry = cache.get(root);
  if (!entry) {
    read = await startRead(root, pin);
  } else {
    read = entry.read;
    if (clock() - entry.atMs > CODEGRAPH_TTL_MS) void startRead(root, pin);
  }

  const own = runs.get(root);
  const run: CodegraphRun | null = own
    ? { kind: own.kind, startedAtMs: own.startedAtMs }
    : l.rebuildLive ? { kind: 'reindex', startedAtMs: l.rebuildSinceMs ?? clock() } : null;
  const base = {
    ...head,
    watching: l.watching,
    watcherSinceMs: l.watcherSinceMs,
    rebuildLive: l.rebuildLive,
    run,
    lastRun: lastRuns.get(root) ?? null,
  };
  const cliMissing = read.kind === 'cli-missing';

  if (l.rebuildLive && read.kind !== 'ok') {
    // Mid-rebuild the DB is unlinked and recreated, so a read can fail or find nothing; that is the rebuild, not a fault in the repo.
    const stats = lastOk.get(root);
    return { repo: stats ? { ...base, state: 'ok', root, stats } : { ...base, state: 'building', root }, cliMissing };
  }
  switch (read.kind) {
    case 'ok': return { repo: { ...base, state: 'ok', root: read.root, stats: read.stats }, cliMissing };
    case 'error': return { repo: { ...base, state: 'error', root: read.root, message: read.message }, cliMissing };
    case 'missing': return { repo: { ...base, state: 'missing' }, cliMissing };
    case 'none': return { repo: { ...base, state: 'none' }, cliMissing };
    // The page says "not found" once for every repo; a row has no state of its own for it.
    case 'cli-missing': return { repo: { ...base, state: 'error', root, message: 'codegraph not found on PATH' }, cliMissing };
  }
}

/**
 * Starts a Sync or Reindex on a pinned repo and returns at once; the run continues in the background and shows up as `run` on the next GET.
 *
 * Async, since it reads pid files, so the per-dirName mark is taken before its first await. The run itself is recorded per graph root, in the same synchronous
 * step as the last check, so a repo pin racing its subdirectory pin launches once.
 */
export async function startCodegraphRun(
  config: Partial<Config>,
  dirName: string,
  kind: CodegraphRunKind,
): Promise<'started' | 'not-pinned' | 'not-indexed' | 'busy'> {
  if (launching.has(dirName)) return 'busy';
  launching.add(dirName);
  try {
    const pin = pinRows(config).find(p => p.dirName === dirName);
    // As `serveOpenFolder` refuses: a pin that is not listed is not one the user can see.
    if (!pin || !pin.listed) return 'not-pinned';
    if (pin.path === null) return 'not-indexed';
    const root = await rootOf(pin);
    if (root === null) return 'not-indexed';

    const meta = path.join(root, '.codegraph');
    const [rebuild, lock, daemon] = await Promise.all([
      livePid(path.join(meta, 'rebuild.pid')),
      livePid(path.join(meta, 'codegraph.lock')),
      livePid(path.join(meta, 'daemon.pid')),
    ]);
    // With a watcher the lock is the watcher's own write and a sync is allowed (the lock-loss rule); without one it is a terminal's sync.
    if (rebuild || (lock && !daemon)) return 'busy';

    // No await from the check to the record.
    if (runs.has(root)) return 'busy';
    const startedAtMs = clock();
    const watchingAtLaunch = daemon !== null;
    const record: OwnRun = { kind, startedAtMs, watchingAtLaunch };
    runs.set(root, record);
    track(launch(root, record));
    return 'started';
  } finally {
    launching.delete(dirName);
  }
}

// Argv is exactly `sync` / `index`: no path argument (`index <path>` does not walk up) and no `-q`, which would hide the lock-loss line the end of the run keys on.
async function launch(root: string, record: OwnRun): Promise<void> {
  const { kind, watchingAtLaunch } = record;
  let ended: Omit<CodegraphLastRun, 'kind' | 'endedAtMs'>;
  try {
    const res = await currentCodegraphRunner()(root, [kind === 'sync' ? 'sync' : 'index'], null);
    const lockLoss = res.code !== 0 && watchingAtLaunch && `${res.stdout}\n${res.stderr}`.includes(LOCK_LOSS_TEXT);
    ended = lockLoss
      ? { ok: true, message: WATCHER_SYNCING_TEXT }
      : { ok: res.code === 0, message: lastLine(res.stderr) ?? lastLine(res.stdout) ?? `exit ${res.code}` };
  } catch (err) {
    const message = (err as { message?: unknown }).message;
    ended = { ok: false, message: typeof message === 'string' && message ? message : 'codegraph failed to start' };
  }
  // A run that ended after `resetCodegraph` would otherwise write into a store that has moved on.
  if (runs.get(root) !== record) return;
  runs.delete(root);
  lastRuns.set(root, { kind, ...ended, endedAtMs: clock() });
  dropEntry(root);
}
