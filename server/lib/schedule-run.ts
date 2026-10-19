/**
 * schedule-run.ts — Run now and Stop for one schedule job. Run now launches the same installed wrapper the OS job does, detached, through `spawn.ts`'s
 * seam, and reads the run id back from the machine's run log; Stop signals the wrapper named in the job's lock, but only after the same command-line
 * check the wrapper itself uses, since a pid alone can be reused by an unrelated process.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.js';
import { machineName, scheduleDirs, scheduleEnv } from './schedule-config.js';
import { installedWrapper } from './schedule-reconcile.js';
import { bootId, createProbe, readJobs, wrapperAlive } from './schedule-store.js';
import type { Probe } from './schedule-store.js';
import { spawnProcess } from './spawn.js';

export type RunResult =
  | { status: 202; run: string | null }
  | { status: 404 }
  | { status: 409; error: 'already-running' | 'no-plugin' | 'invalid' | 'not-this-machine' }
  | { status: 500; error: 'spawn-failed' };

export type StopResult = { status: 204 } | { status: 409; error: 'not-running' };

/** How long Run now waits for the wrapper's `start` record before answering without a run id. */
export const READBACK_MS = 2000;
const POLL_MS = 40;

const SAFE_NAME = /^[a-z0-9-]+$/;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The pid in `<locks>/<name>.lock` when that wrapper is live for this job from this boot, else null. Unreadable command lines count as not live: never signal on a guess. */
function liveLockPid(config: Config, name: string, probe: Probe): number | null {
  let held: { pid?: unknown; bootId?: unknown };
  try { held = JSON.parse(fs.readFileSync(path.join(scheduleDirs(config).locks, `${name}.lock`), 'utf8')); } catch { return null; }
  const pid = held?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const mine = bootId();
  if (held.bootId != null && mine != null && held.bootId !== mine) return null;
  return wrapperAlive(pid, name, probe) === true ? pid : null;
}

/** Each call reads only the log bytes appended since the last one and returns the run id of a manual `start` record for `job` at or after `since`, else null. */
function createStartWatcher(file: string, job: string, since: number): () => string | null {
  let offset = 0;
  let ino: number | null = null;
  let pending = '';
  try { const st = fs.statSync(file); offset = st.size; ino = st.ino; } catch { /* no log yet */ }
  return () => {
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
      if (rec.kind === 'start' && rec.job === job && rec.trigger === 'manual' && typeof rec.run === 'string' && Date.parse(String(rec.at)) >= since) return rec.run;
    }
    return null;
  };
}

/**
 * Launch `name` now, as `--trigger manual`. A paused job runs too: that is how a new job is tried before its toggle installs it. The child's environment is
 * exactly `scheduleEnv(config)`, not the server's. `run` is null when the wrapper wrote no `start` within 2 s (it refused, or is slow); the spawn still happened.
 */
export async function runJob(config: Config, name: string, only?: string[], probe: Probe = createProbe()): Promise<RunResult> {
  const stored = SAFE_NAME.test(name) ? readJobs(scheduleDirs(config).schedules).find(j => j.name === name) : undefined;
  if (!stored) return { status: 404 };
  // The wrapper would refuse both of these and a 2 s wait for a log line that never comes would then read as a slow success.
  if (!stored.job) return { status: 409, error: 'invalid' };
  const machine = machineName(config).name;
  if (!stored.job.machines.includes(machine)) return { status: 409, error: 'not-this-machine' };
  if (liveLockPid(config, name, probe) !== null) return { status: 409, error: 'already-running' };
  const wrapper = installedWrapper();
  if (!wrapper) return { status: 409, error: 'no-plugin' };

  const args = [wrapper, name, '--trigger', 'manual'];
  if (only && only.length > 0) args.push('--only', ...only);
  const since = Date.now();
  const watch = createStartWatcher(path.join(scheduleDirs(config).runs, `${machine}.jsonl`), name, since);
  try {
    const child = spawnProcess(process.execPath, args, { env: scheduleEnv(config), detached: true, stdio: 'ignore' });
    // An async spawn failure is an 'error' event; unhandled it would take the server down.
    child.once('error', () => { /* the read-back below times out and answers run: null */ });
    child.unref();
  } catch {
    return { status: 500, error: 'spawn-failed' };
  }

  const end = since + READBACK_MS;
  for (;;) {
    const run = watch();
    if (run !== null) return { status: 202, run };
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
