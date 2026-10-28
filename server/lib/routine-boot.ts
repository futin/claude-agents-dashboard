/**
 * routine-boot.ts — what the server does for routines on start and on exit, and the one run-log reader the routes and the push fold share.
 * Only the owning server (spec §Owning server) sweeps locks, writes `pins.json`, rotates the log, reconciles, watches and pushes; every other server
 * gets the read path and nothing else. Every call `startRoutines` makes goes through `deps`, so a test drives the whole start-up with fakes.
 */

import type { RoutineRun } from '../../shared/types.js';
import type { Config } from './config.js';
import { migrateLegacyState, routineDirs } from './routine-config.js';
import { createLogReader, rotateIfLarge } from './routine-log.js';
import { sendRoutineEvent } from './notify.js';
import { notifyRoutineRuns, seedRoutineNotify } from './routine-notify.js';
import { applyReconcile, installedWrapper, startReconcileWatchers, stopReconcileWatchers } from './routine-reconcile.js';
import { claimOwner, createProbe, isOwner, readJobs, releaseOwner, sweepLocks, wrapperAlive, writePinsSnapshot } from './routine-store.js';
import type { Probe } from './routine-store.js';
import { foldTickCaps } from './tick-caps.js';

export interface RoutineDeps {
  migrateLegacyState: typeof migrateLegacyState;
  claimOwner: typeof claimOwner;
  sweepLocks: typeof sweepLocks;
  writePinsSnapshot: typeof writePinsSnapshot;
  rotateIfLarge: typeof rotateIfLarge;
  applyReconcile: typeof applyReconcile;
  startReconcileWatchers: typeof startReconcileWatchers;
  stopReconcileWatchers: typeof stopReconcileWatchers;
  createLogReader: typeof createLogReader;
  seedRoutineNotify: typeof seedRoutineNotify;
  notifyRoutineRuns: typeof notifyRoutineRuns;
  sendRoutineEvent: typeof sendRoutineEvent;
  foldTickCaps: typeof foldTickCaps;
  releaseOwner: typeof releaseOwner;
}

export const defaultDeps: RoutineDeps = {
  // Only once the installed plugin has `run-routine.mjs`: until then the old wrapper still fires and writes to `~/.claude/schedules`, so moving that
  // folder would split the run log in two. Both sides read the old folder while it is the only one, so waiting costs nothing.
  migrateLegacyState: (config) => installedWrapper() !== null && migrateLegacyState(config),
  claimOwner, sweepLocks, writePinsSnapshot, rotateIfLarge, applyReconcile, startReconcileWatchers, stopReconcileWatchers, createLogReader,
  seedRoutineNotify, notifyRoutineRuns, sendRoutineEvent, foldTickCaps, releaseOwner
};

/** The spec's default step timeout. A run of a deleted, unknown or invalid job ages out against it rather than staying `running` for ever. */
export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const TIMEOUTS_TTL_MS = 2000;

type LogReader = ReturnType<typeof createLogReader>;

let probe: Probe = createProbe();
let reader: { dir: string; reader: LogReader } | null = null;
let timeouts: { dir: string; at: number; byJob: Map<string, number> } | null = null;
let claim: 'owner' | { ownedBy: string } | null = null;
let started: { deps: RoutineDeps; unwatch: (() => void) | null } | null = null;

/** Test seam: the probe the run log's liveness check uses (a `start` with no `end` is `running` only while its wrapper is). `null` restores the real one. */
export function setRoutineProbe(p: Probe | null): void {
  probe = p ?? createProbe();
}

/** Test seam: drop the shared reader, the timeout cache and the remembered claim, so the next call starts from disk. */
export function resetRoutineBoot(): void {
  reader = null;
  timeouts = null;
  claim = null;
}

function timeoutMsFor(config: Config): (job: string) => number {
  return (job) => {
    const dir = routineDirs(config).routines;
    const now = Date.now();
    if (!timeouts || timeouts.dir !== dir || now - timeouts.at > TIMEOUTS_TTL_MS) {
      const byJob = new Map<string, number>();
      for (const s of readJobs(dir)) if (s.job) byJob.set(s.name, s.job.timeoutMs);
      timeouts = { dir, at: now, byJob };
    }
    const ms = timeouts.byJob.get(job);
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
  };
}

/** The one incremental reader over `<state>/runs/`, built on first use with `create` (the boot passes its own), rebuilt only if the folder moves. */
export function runsReader(config: Config, create: typeof createLogReader = createLogReader): LogReader {
  const dir = routineDirs(config).runs;
  if (reader && reader.dir === dir) return reader.reader;
  const r = create(dir, (pid, job) => wrapperAlive(pid, job, probe), timeoutMsFor(config));
  reader = { dir, reader: r };
  return r;
}

/** What `RoutinesResponse.owner` reads: `owner` while this server holds the file, else the last claim's answer, else `{ ownedBy: '' }` (never opted in). */
export function ownerStatus(): 'owner' | { ownedBy: string } {
  if (isOwner()) return 'owner';
  return claim && claim !== 'owner' ? claim : { ownedBy: '' };
}

/**
 * Fold the log and push what is new, then check the backlog ticks' plan-review caps (a tick routine's run ending is when `decide` has just written
 * `last-decide.json`). A no-op for a non-owner (both folds check), so the routes call it on every poll. Each fold is caught on its own, so one failing
 * never stops the other.
 */
export function foldForPush(config: Config, runs: RoutineRun[], deps: RoutineDeps = started?.deps ?? defaultDeps): void {
  try { deps.notifyRoutineRuns(config, runs, deps.sendRoutineEvent); } catch (e) {
    console.error('[dashboard] routine push fold failed:', (e as Error).message);
  }
  try { deps.foldTickCaps(config); } catch (e) {
    console.error('[dashboard] tick-cap push fold failed:', (e as Error).message);
  }
}

/**
 * On listen. Without `ROUTINES_OWNER` nothing is called at all; with it, a lost claim stops right there. The owner sweeps dead wrappers' locks, writes
 * `pins.json` before the first reconcile (a fan-out job firing straight after reads it), rotates an oversized log, reconciles, watches, and folds the
 * log once now and again on every write to `runs/`.
 */
export function startRoutines(config: Config, deps: RoutineDeps = defaultDeps): void {
  if (!config.routinesOwner) return;
  // Before the claim, which writes `owner.json` into the folder being moved.
  try {
    if (deps.migrateLegacyState(config)) console.log('[dashboard] routines: moved ~/.claude/schedules to ~/.claude/routines');
  } catch (e) {
    console.error('[dashboard] routines state move failed:', (e as Error).message);
  }
  // An unwritable state root throws here; the server still serves everything but routines, so this must not take `listen` down with it.
  try {
    claim = deps.claimOwner(config);
  } catch (e) {
    console.error('[dashboard] routines owner claim failed:', (e as Error).message);
    claim = { ownedBy: '' };
    return;
  }
  if (claim !== 'owner') return;
  started = { deps, unwatch: null };
  const step = (what: string, fn: () => void): void => {
    try { fn(); } catch (e) { console.error(`[dashboard] routines ${what} failed:`, (e as Error).message); }
  };
  step('lock sweep', () => { deps.sweepLocks(config); });
  step('pins snapshot', () => { deps.writePinsSnapshot(config); });
  step('log rotation', () => { deps.rotateIfLarge(routineDirs(config).runs); });
  step('reconcile', () => {
    void deps.applyReconcile(config).catch((e: unknown) => { console.error('[dashboard] routines reconcile failed:', (e as Error).message); });
  });
  step('reconcile watchers', () => { deps.startReconcileWatchers(config); });
  step('runs watcher', () => {
    const r = runsReader(config, deps.createLogReader);
    const runs = r.read();
    deps.seedRoutineNotify(config, runs);
    foldForPush(config, runs, deps);
    const unwatch = r.watch(() => {
      try { foldForPush(config, r.read(), deps); } catch (e) { console.error('[dashboard] routine log read failed:', (e as Error).message); }
    });
    if (started) started.unwatch = unwatch;
  });
}

/** On SIGINT / SIGTERM: watchers off and the owner file given back (`claimOwner` hooks only `exit`, which a signal skips). A no-op for a non-owner. */
export function stopRoutines(): void {
  const s = started;
  started = null;
  if (!s) return;
  s.unwatch?.();
  try { s.deps.stopReconcileWatchers(); } catch { /* exiting anyway */ }
  try { s.deps.releaseOwner(); } catch { /* exiting anyway */ }
}
