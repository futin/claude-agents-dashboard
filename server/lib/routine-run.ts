/**
 * routine-run.ts — Run now and Stop for one routine job. Run now launches the same installed wrapper the OS job does, detached, through `spawn.ts`'s
 * seam, and reads the run id back from the machine's run log; Stop signals the wrapper named in the job's lock, but only after the same command-line
 * check the wrapper itself uses, since a pid alone can be reused by an unrelated process.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { RoutineRunConflict } from '../../shared/types.js';
import type { Config } from './config.js';
import { machineName, routineDirs, routineEnv } from './routine-config.js';
import { installedWrapper } from './routine-reconcile.js';
import { bootId, createProbe, readJobs, wrapperAlive } from './routine-store.js';
import type { Probe } from './routine-store.js';
import { spawnProcess } from './spawn.js';

export type RunResult =
  | { status: 202; run: string | null }
  | { status: 400; error: 'bad-only' }
  | { status: 404 }
  | { status: 409; error: RoutineRunConflict }
  | { status: 500; error: 'spawn-failed' };

/** What the run log can answer for one spawned wrapper. */
type ReadBack = Extract<RunResult, { status: 202 | 409 }>;

export type StopResult = { status: 204 } | { status: 409; error: 'not-running' };

/** How long Run now waits for the wrapper's `start` record before answering without a run id. */
export const READBACK_MS = 2000;
const POLL_MS = 40;

const SAFE_NAME = /^[a-z0-9-]+$/;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The pid in `<locks>/<name>.lock` when that wrapper is live for this job from this boot, else null. Unreadable command lines count as not live: never signal on a guess. */
function liveLockPid(config: Config, name: string, probe: Probe): number | null {
  let held: { pid?: unknown; bootId?: unknown };
  try { held = JSON.parse(fs.readFileSync(path.join(routineDirs(config).locks, `${name}.lock`), 'utf8')); } catch { return null; }
  const pid = held?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const mine = bootId();
  if (held.bootId != null && mine != null && held.bootId !== mine) return null;
  return wrapperAlive(pid, name, probe) === true ? pid : null;
}

/**
 * Each call reads only the log bytes appended since the last one and answers from a manual record for `job` at or after `since` written by `pid`, the wrapper
 * this request spawned: its `start` is the run, its `refused` for `running` means it lost the lock to an overlapping request. Any other record, another
 * wrapper's above all, answers nothing, and neither does anything at all without a pid. Created before the spawn so its offset predates the child.
 */
function createStartWatcher(file: string, job: string, since: number): (pid: number | undefined) => ReadBack | null {
  let offset = 0;
  let ino: number | null = null;
  let pending = '';
  try { const st = fs.statSync(file); offset = st.size; ino = st.ino; } catch { /* no log yet */ }
  return pid => {
    if (pid === undefined) return null;
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try {
      const st = fs.fstatSync(fd);
      // Rotation or truncation: the new file is all ours.
      if ((ino !== null && st.ino !== ino) || st.size < offset) { offset = 0; pending = ''; }
      ino = st.ino;
      if (st.size === offset) return null;
      const buf = Buffer.alloc(st.size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      pending += buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      let rec: Record<string, unknown>;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.job !== job || rec.pid !== pid || rec.trigger !== 'manual' || !(Date.parse(String(rec.at)) >= since)) continue;
      if (rec.kind === 'start' && typeof rec.run === 'string') return { status: 202, run: rec.run };
      if (rec.kind === 'refused' && rec.why === 'running') return { status: 409, error: 'already-running' };
    }
    return null;
  };
}

/**
 * The wrapper's `--only` parser ends its list at the first element starting with `--` and reads it as a flag, so `['--trigger', 'schedule']` would flip the
 * run's trigger. A pin name never starts with `-`, so any such element, an empty one, a non-string or a control character refuses the whole call.
 */
function validOnly(only: unknown): only is string[] {
  return Array.isArray(only) && only.every(p => typeof p === 'string' && p !== '' && !p.startsWith('-') && !/[\u0000-\u001f\u007f]/.test(p));
}

/**
 * Launch `name` now, as `--trigger manual`. A paused job runs too: that is how a new job is tried before its toggle installs it. The child's environment is
 * exactly `routineEnv(config)`, not the server's. `run` is null when the wrapper wrote no `start` within 2 s (it refused for a reason other than `running`, or
 * is slow); the spawn still happened. An overlapping request can pass the lock check above, since a wrapper locks only once it is up: the one that loses the
 * lock answers 409 `already-running`, read from its own `refused` record, or `run: null` against a wrapper too old to name itself on that record.
 */
export async function runJob(config: Config, name: string, only?: unknown, probe: Probe = createProbe()): Promise<RunResult> {
  const pins = only === undefined ? [] : validOnly(only) ? only : null;
  if (pins === null) return { status: 400, error: 'bad-only' };
  const machine = machineName(config).name;
  const stored = SAFE_NAME.test(name) ? readJobs(routineDirs(config).routines, machine).find(j => j.name === name) : undefined;
  if (!stored) return { status: 404 };
  // The wrapper would refuse both of these and a 2 s wait for a log line that never comes would then read as a slow success.
  if (!stored.job) return { status: 409, error: 'invalid' };
  if (liveLockPid(config, name, probe) !== null) return { status: 409, error: 'already-running' };
  const wrapper = installedWrapper();
  if (!wrapper) return { status: 409, error: 'no-plugin' };

  const args = [wrapper, name, '--trigger', 'manual'];
  if (pins.length > 0) args.push('--only', ...pins);
  const since = Date.now();
  const watch = createStartWatcher(path.join(routineDirs(config).runs, `${machine}.jsonl`), name, since);
  let pid: number | undefined;
  try {
    const child = spawnProcess(process.execPath, args, { env: routineEnv(config), detached: true, stdio: 'ignore' });
    // An async spawn failure is an 'error' event; unhandled it would take the server down.
    child.once('error', () => { /* the read-back below times out and answers run: null */ });
    child.unref();
    pid = child.pid;
  } catch {
    return { status: 500, error: 'spawn-failed' };
  }

  const end = since + READBACK_MS;
  for (;;) {
    const answer = watch(pid);
    if (answer !== null) return answer;
    if (Date.now() >= end) return { status: 202, run: null };
    await sleep(POLL_MS);
  }
}

/** SIGTERM the wrapper holding `name`'s lock — it forwards to its child and ends the run `stopped`. `kill` and `probe` are test seams. */
export function stopJob(
  config: Config,
  name: string,
  probe: Probe = createProbe(),
  kill: (pid: number, signal: 'SIGTERM') => void = (pid, signal) => { process.kill(pid, signal); }
): StopResult {
  if (!SAFE_NAME.test(name)) return { status: 409, error: 'not-running' };
  const pid = liveLockPid(config, name, probe);
  if (pid === null) return { status: 409, error: 'not-running' };
  try { kill(pid, 'SIGTERM'); } catch { return { status: 409, error: 'not-running' }; }
  return { status: 204 };
}
