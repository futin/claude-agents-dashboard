/**
 * schedule-boot.ts — what the server does for scheduled workflows on start and on exit, and the one run-log reader the routes and the push fold share.
 * Only the owning server (spec §Owning server) sweeps locks, writes `pins.json`, rotates the log, reconciles, watches and pushes; every other server
 * gets the read path and nothing else. Every call `startSchedules` makes goes through `deps`, so a test drives the whole start-up with fakes.
 */

import type { ScheduleRun } from '../../shared/types.js';
import type { Config } from './config.js';
import { scheduleDirs } from './schedule-config.js';
import { createLogReader, rotateIfLarge } from './schedule-log.js';
import { sendScheduleEvent } from './notify.js';
import { notifyScheduleRuns, seedScheduleNotify } from './schedule-notify.js';
import { applyReconcile, startReconcileWatchers, stopReconcileWatchers } from './schedule-reconcile.js';
import { claimOwner, createProbe, isOwner, readJobs, releaseOwner, sweepLocks, wrapperAlive, writePinsSnapshot } from './schedule-store.js';
import type { Probe } from './schedule-store.js';

export interface ScheduleDeps {
  claimOwner: typeof claimOwner;
  sweepLocks: typeof sweepLocks;
  writePinsSnapshot: typeof writePinsSnapshot;
  rotateIfLarge: typeof rotateIfLarge;
  applyReconcile: typeof applyReconcile;
  startReconcileWatchers: typeof startReconcileWatchers;
  stopReconcileWatchers: typeof stopReconcileWatchers;
  createLogReader: typeof createLogReader;
  seedScheduleNotify: typeof seedScheduleNotify;
  notifyScheduleRuns: typeof notifyScheduleRuns;
  sendScheduleEvent: typeof sendScheduleEvent;
  releaseOwner: typeof releaseOwner;
}

export const defaultDeps: ScheduleDeps = {
  claimOwner, sweepLocks, writePinsSnapshot, rotateIfLarge, applyReconcile, startReconcileWatchers, stopReconcileWatchers, createLogReader,
  seedScheduleNotify, notifyScheduleRuns, sendScheduleEvent, releaseOwner
};

/** The spec's default step timeout. A run of a deleted, unknown or invalid job ages out against it rather than staying `running` for ever. */
export const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const TIMEOUTS_TTL_MS = 2000;

type LogReader = ReturnType<typeof createLogReader>;

let probe: Probe = createProbe();
let reader: { dir: string; reader: LogReader } | null = null;
let timeouts: { dir: string; at: number; byJob: Map<string, number> } | null = null;
let claim: 'owner' | { ownedBy: string } | null = null;
let started: { deps: ScheduleDeps; unwatch: (() => void) | null } | null = null;

/** Test seam: the probe the run log's liveness check uses (a `start` with no `end` is `running` only while its wrapper is). `null` restores the real one. */
export function setScheduleProbe(p: Probe | null): void {
  probe = p ?? createProbe();
}

/** Test seam: drop the shared reader, the timeout cache and the remembered claim, so the next call starts from disk. */
export function resetScheduleBoot(): void {
  reader = null;
  timeouts = null;
  claim = null;
}

function timeoutMsFor(config: Config): (job: string) => number {
  return (job) => {
    const dir = scheduleDirs(config).schedules;
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
  const dir = scheduleDirs(config).runs;
  if (reader && reader.dir === dir) return reader.reader;
  const r = create(dir, (pid, job) => wrapperAlive(pid, job, probe), timeoutMsFor(config));
  reader = { dir, reader: r };
  return r;
}

/** What `SchedulesResponse.owner` reads: `owner` while this server holds the file, else the last claim's answer, else `{ ownedBy: '' }` (never opted in). */
export function ownerStatus(): 'owner' | { ownedBy: string } {
  if (isOwner()) return 'owner';
  return claim && claim !== 'owner' ? claim : { ownedBy: '' };
}

/** Fold the log and push what is new. A no-op for a non-owner (`notifyScheduleRuns` checks), so the routes call it on every poll. */
export function foldForPush(config: Config, runs: ScheduleRun[], deps: ScheduleDeps = started?.deps ?? defaultDeps): void {
  try { deps.notifyScheduleRuns(config, runs, deps.sendScheduleEvent); } catch (e) {
    console.error('[dashboard] schedule push fold failed:', (e as Error).message);
  }
}

/**
 * On listen. Without `SCHEDULES_OWNER` nothing is called at all; with it, a lost claim stops right there. The owner sweeps dead wrappers' locks, writes
 * `pins.json` before the first reconcile (a fan-out job firing straight after reads it), rotates an oversized log, reconciles, watches, and folds the
 * log once now and again on every write to `runs/`.
 */
export function startSchedules(config: Config, deps: ScheduleDeps = defaultDeps): void {
  if (!config.schedulesOwner) return;
  // An unwritable state root throws here; the server still serves everything but schedules, so this must not take `listen` down with it.
  try {
    claim = deps.claimOwner(config);
  } catch (e) {
    console.error('[dashboard] schedules owner claim failed:', (e as Error).message);
    claim = { ownedBy: '' };
    return;
  }
  if (claim !== 'owner') return;
  started = { deps, unwatch: null };
  const step = (what: string, fn: () => void): void => {
    try { fn(); } catch (e) { console.error(`[dashboard] schedules ${what} failed:`, (e as Error).message); }
  };
  step('lock sweep', () => { deps.sweepLocks(config); });
  step('pins snapshot', () => { deps.writePinsSnapshot(config); });
  step('log rotation', () => { deps.rotateIfLarge(scheduleDirs(config).runs); });
  step('reconcile', () => {
    void deps.applyReconcile(config).catch((e: unknown) => { console.error('[dashboard] schedules reconcile failed:', (e as Error).message); });
  });
  step('reconcile watchers', () => { deps.startReconcileWatchers(config); });
  step('runs watcher', () => {
    const r = runsReader(config, deps.createLogReader);
    const runs = r.read();
    deps.seedScheduleNotify(config, runs);
    foldForPush(config, runs, deps);
    const unwatch = r.watch(() => {
      try { foldForPush(config, r.read(), deps); } catch (e) { console.error('[dashboard] schedule log read failed:', (e as Error).message); }
    });
    if (started) started.unwatch = unwatch;
  });
}

/** On SIGINT / SIGTERM: watchers off and the owner file given back (`claimOwner` hooks only `exit`, which a signal skips). A no-op for a non-owner. */
export function stopSchedules(): void {
  const s = started;
  started = null;
  if (!s) return;
  s.unwatch?.();
  try { s.deps.stopReconcileWatchers(); } catch { /* exiting anyway */ }
  try { s.deps.releaseOwner(); } catch { /* exiting anyway */ }
}
