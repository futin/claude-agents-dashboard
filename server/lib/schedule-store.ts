/**
 * schedule-store.ts — the job folder on disk, the pins snapshot the wrapper reads, the owner lock that lets one server per machine touch `~/.claude/schedules/`,
 * and the start-up sweep of dead wrappers' locks. Callers gate on `isOwner()`; nothing here refuses a write for a non-owner, so a test or the seam can still
 * drive a folder. The wrapper (`plugin/lib/run-schedule.mjs`) owns `locks/` while it runs: `bootId`, `isWrapperCommand` and the lock shape below mirror its own
 * and `test/schedule-store.test.ts` pins them against its source, because the server cannot import the plugin.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parseJob } from '../../shared/schedule-file.js';
import type { JobError, PinSnapshot } from '../../shared/schedule-file.js';
import type { PinRow, ScheduleJob } from '../../shared/types.js';
import { archivedSessionIds } from './archived.js';
import type { Config } from './config.js';
import { listPinRows } from './management.js';
import { scheduleDirs, scheduleStateRoot } from './schedule-config.js';
import { getPinnedProjects } from './settings.js';

export class ScheduleStoreError extends Error {
  constructor(readonly code: 'exists' | 'bad-name', message: string) {
    super(message);
  }
}

/** Path-safety only; reserved names and the rest of the name rules are the validator's. */
const SAFE_NAME = /^[a-z0-9-]+$/;

function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new ScheduleStoreError('bad-name', `bad job name: ${name.slice(0, 60)}`);
}

export interface StoredJob { name: string; text: string; job: ScheduleJob | null; errors: JobError[]; mtimeMs: number }

/** Every `*.md` file in `dir`, sorted by name; a file that does not parse stays in the list with its errors. A missing folder is an empty list. */
export function readJobs(dir: string): StoredJob[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const jobs: StoredJob[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    const full = path.join(dir, file);
    let text: string;
    let mtimeMs: number;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      text = fs.readFileSync(full, 'utf8');
      mtimeMs = st.mtimeMs;
    } catch { continue; }
    const name = file.slice(0, -3);
    const { job, errors } = parseJob(name, text);
    jobs.push({ name, text, job, errors, mtimeMs });
  }
  return jobs;
}

/**
 * Write `<dir>/<name>.md` through a temp file and a rename, so a reader — the wrapper firing mid-save, a git sync — sees the old file or the new one whole.
 * `create` refuses an existing file with `exists`; the temp file is hard-linked into place, which fails on an existing name atomically.
 */
export function writeJob(dir: string, name: string, text: string, mode: 'create' | 'replace' = 'replace'): void {
  assertSafeName(name);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name}.md`);
  // A dotfile without the `.md` suffix, so `readJobs` and a folder watcher never mistake it for a job.
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  try {
    if (mode === 'create') {
      try { fs.linkSync(tmp, target); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ScheduleStoreError('exists', `${name} already exists`);
        throw e;
      }
    } else {
      fs.renameSync(tmp, target);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed away, or never written */ }
  }
}

/** False when there was no such file. */
export function deleteJob(dir: string, name: string): boolean {
  assertSafeName(name);
  try { fs.unlinkSync(path.join(dir, `${name}.md`)); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * `<state>/pins.json`: the pin rows the Projects tiles show, in pin order, cut to what the wrapper matches `foreach:` against. `rows` is a seam; by default
 * they are built the way `GET /api/pins` builds them, so a pin resolves to the same path here as everywhere else.
 */
export function writePinsSnapshot(config: Config, rows?: readonly PinRow[]): void {
  const pins = getPinnedProjects();
  const list = rows ?? listPinRows(config, pins, { archivedIds: archivedSessionIds(), pinnedDirs: new Set(pins) });
  const snapshot: PinSnapshot[] = list.map(r => ({ dirName: r.dirName, name: r.name, path: r.path, listed: r.listed }));
  writeAtomic(path.join(scheduleStateRoot(config), 'pins.json'), JSON.stringify(snapshot, null, 2) + '\n');
}

/**
 * The boot id exactly as the wrapper computes it (`bootId()` in `plugin/lib/run-schedule.mjs`): the `sec` of `sysctl -n kern.boottime` on macOS, the trimmed
 * `/proc/sys/kernel/random/boot_id` elsewhere, null when neither reads. A lock or owner file from another boot is stale whatever pid it names.
 */
export function bootId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
      const m = out.match(/sec = (\d+)/);
      return m ? m[1] : out.trim();
    }
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}

/** The wrapper's own rule: a boot id missing on either side counts as the same boot, so a host that cannot read one never reads every lock as stale. */
const sameBoot = (held: unknown, mine: string | null): boolean => held == null || mine == null || held === mine;

/** The process seam: tests pass a fake, never a real foreign pid. */
export interface Probe {
  alive(pid: number): boolean;
  /** The full command line of `pid`, or null when it cannot be read (no `ps`, or the process just went). */
  command(pid: number): string | null;
}

export function createProbe(): Probe {
  return {
    alive(pid) {
      try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    },
    command(pid) {
      try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return null; }
    }
  };
}

/** `run-schedule.mjs` followed by exactly `job` as whitespace-split elements, the wrapper's `isWrapperFor` test (`git-sync` never matches `git-sync-all`). */
export function isWrapperCommand(command: string, job: string): boolean {
  const tokens = command.trim().split(/\s+/);
  return tokens.some((t, i) => path.basename(t) === 'run-schedule.mjs' && tokens[i + 1] === job);
}

/** Whether `pid` is a live wrapper for `job`; null when its command line cannot be read, which the callers treat as "do not act". */
export function wrapperAlive(pid: number, job: string, probe: Probe = createProbe()): boolean | null {
  if (!probe.alive(pid)) return false;
  const cmd = probe.command(pid);
  return cmd === null ? null : isWrapperCommand(cmd, job);
}

function readJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const validPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * Remove `file` when `isStale(text)` says so, using the wrapper's takeover: rename aside, then check the renamed text is the text judged, because another
 * process may have replaced the file between the read and the rename — if so it is linked back and left. True only when a stale file was removed.
 */
function removeIfStale(file: string, isStale: (text: string) => boolean): boolean {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (!isStale(text)) return false;
  const aside = `${file}.${process.pid}.stale`;
  try { fs.renameSync(file, aside); } catch { return false; }
  let removed = true;
  try {
    if (fs.readFileSync(aside, 'utf8') !== text) {
      removed = false;
      try { fs.linkSync(aside, file); } catch { /* a third process holds it now; theirs stands */ }
    }
  } finally {
    try { fs.unlinkSync(aside); } catch { /* gone */ }
  }
  return removed;
}

/**
 * Delete the lock of every wrapper that is gone: its pid is dead, from another boot, or reused by some other command. Only the server, on start, writes under
 * `locks/`; the wrapper's own takeover does the same on its next fire. A lock whose pid is alive but whose command line cannot be read is kept — removing a
 * live wrapper's lock lets a second one start, while a stale one costs only a `running` row until the next fire takes it over. Returns the job names swept.
 */
export function sweepLocks(config: Config, probe: Probe = createProbe()): string[] {
  const dir = scheduleDirs(config).locks;
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const mine = bootId();
  const swept: string[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.lock')) continue;
    const job = file.slice(0, -5);
    const stale = (text: string): boolean => {
      const held = readJson(text);
      if (!held || !validPid(held.pid) || !sameBoot(held.bootId, mine)) return true;
      return wrapperAlive(held.pid, job, probe) === false;
    };
    if (removeIfStale(path.join(dir, file), stale)) swept.push(job);
  }
  return swept;
}

let owned: { file: string } | null = null;
let exitHooked = false;

export function isOwner(): boolean {
  return owned !== null;
}

/**
 * Take `<state>/owner.json` (`{ pid, bootId, cwd, port, at }`) when this server opted in and the file is absent or names a dead pid or another boot. Returns
 * `{ ownedBy: '<cwd>:<port>' }` of a live owner, which is what the chip reads. A server that never opted in, or runs under the `SCHEDULES_STATE_ROOT` seam
 * (the wrapper does not carry the seam, so such a server must never install jobs), answers `{ ownedBy: '' }` / `{ ownedBy: 'seam' }` and writes nothing.
 */
export function claimOwner(config: Config, probe: Probe = createProbe()): 'owner' | { ownedBy: string } {
  if (!config.schedulesOwner) return { ownedBy: '' };
  if (config.schedulesStateRoot) return { ownedBy: 'seam' };
  const file = path.join(scheduleStateRoot(config), 'owner.json');
  const mine = bootId();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, bootId: mine, cwd: process.cwd(), port: config.port, at: new Date().toISOString() }));
  const liveForeign = (text: string): Record<string, unknown> | null => {
    const held = readJson(text);
    if (!held || !validPid(held.pid) || held.pid === process.pid || !sameBoot(held.bootId, mine)) return null;
    return probe.alive(held.pid) ? held : null;
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, file);
        owned = { file };
        if (!exitHooked) { exitHooked = true; process.once('exit', releaseOwner); }
        return 'owner';
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const held = liveForeign(text);
      if (held) return { ownedBy: `${String(held.cwd ?? '?')}:${String(held.port ?? '?')}` };
      removeIfStale(file, t => liveForeign(t) === null);
    }
    let held: Record<string, unknown> | null = null;
    try { held = readJson(fs.readFileSync(file, 'utf8')); } catch { /* gone again; the next start settles it */ }
    return { ownedBy: `${String(held?.cwd ?? '?')}:${String(held?.port ?? '?')}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Clean exit: give the file back, only if it still names this pid. */
export function releaseOwner(): void {
  const mine = owned;
  owned = null;
  if (!mine) return;
  try {
    if (readJson(fs.readFileSync(mine.file, 'utf8'))?.pid === process.pid) fs.unlinkSync(mine.file);
  } catch { /* already gone */ }
}
