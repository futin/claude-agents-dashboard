/**
 * schedule-reconcile.ts — files in, OS jobs out (spec `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` §Reconcile). The desired set is every
 * valid, enabled job file naming this machine; the installed set is this feature's launchd plists (mac) or the lines of its crontab marker block (wsl).
 * `planReconcile` diffs them without writing; `applyReconcile` applies the diff, one reconcile at a time. Every `launchctl`, `crontab` and `pgrep` goes
 * through the runner seam, and only labels and lines carrying this feature's prefix or markers are ever written or removed.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCron, toCalendarIntervals } from '../../shared/cron.js';
import type { CalendarInterval } from '../../shared/cron.js';
import type { ScheduleJob } from '../../shared/types.js';
import type { Config } from './config.js';
import { machineName, scheduleDirs, scheduleEnv } from './schedule-config.js';
import { createProbe, isOwner, readJobs, wrapperAlive } from './schedule-store.js';
import type { Probe, StoredJob } from './schedule-store.js';

export const LABEL_PREFIX = 'com.claude-dashboard.schedule.';
export const CRON_START = '# >>> claude-dashboard schedules >>>';
export const CRON_END = '# <<< claude-dashboard schedules <<<';
/** `scripts/sync-plugin.ts` `PLUGIN_ID`; `test/schedule-reconcile.test.ts` pins the two together, since the server does not import a script. */
export const PLUGIN_ID = 'claude-agents-dashboard@claude-agents-dashboard-marketplace';

export type ReconcileState = 'in-sync' | 'drift' | 'failed' | 'pending' | 'not-owner' | 'no-plugin' | 'cron-down' | 'bad-machine' | 'no-claude';
export interface ReconcileChange { name: string; action: 'install' | 'update' | 'remove' | 'pending'; why: string }
export interface ReconcileReport { state: ReconcileState; changes: ReconcileChange[]; unchanged: number; error: string | null; at: string }

/** The absolute paths baked into an installed job. */
export interface ReconcilePaths { node: string; wrapper: string; schedules: string; launchd: string }

export type ScheduleRunner = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const RUN_TIMEOUT_MS = 15_000;

/** The real runner: no shell, `input` on stdin, a spawn failure answered as exit 127 rather than thrown. */
function realRunner(): ScheduleRunner {
  return (cmd, args, input) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code: number): void => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `${cmd} timed out`; }, RUN_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (e) => { stderr += e.message; done(127); });
    child.on('close', (code) => done(code ?? 1));
    if (input !== undefined) child.stdin?.end(input);
  });
}

let runner: ScheduleRunner = realRunner();

/** Test seam: route every `launchctl` / `crontab` / `pgrep` through `run`, or back to the real runner with `null`. */
export function setScheduleRunner(run: ScheduleRunner | null): void {
  runner = run ?? realRunner();
}

interface ReconcileHost { uid: number; nodePath: string; probe: Probe }
const realHost = (): ReconcileHost => ({ uid: process.getuid?.() ?? 0, nodePath: process.execPath, probe: createProbe() });
let host: ReconcileHost = realHost();

/** Test seam for what is not a launch: the gui domain's uid, the node baked into a job, and the probe judging a job lock's holder. */
export function setReconcileHost(over: Partial<ReconcileHost> | null): void {
  host = { ...realHost(), ...(over ?? {}) };
}

const home = (): string => process.env.HOME || os.homedir();
const launchAgentsDir = (): string => path.join(home(), 'Library', 'LaunchAgents');
const installedPluginsPath = (): string => path.join(home(), '.claude', 'plugins', 'installed_plugins.json');
const plistPath = (name: string): string => path.join(launchAgentsDir(), `${LABEL_PREFIX}${name}.plist`);

/** The installed copy's wrapper — the user-scope record, else the first, as `readInstall` picks — or null when the plugin or its `lib/` is absent. */
export function installedWrapper(): string | null {
  try {
    const entries: unknown = JSON.parse(fs.readFileSync(installedPluginsPath(), 'utf8'))?.plugins?.[PLUGIN_ID];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const rec = (entries.find((e) => e?.scope === 'user') ?? entries[0]) as { installPath?: unknown };
    if (typeof rec?.installPath !== 'string') return null;
    const wrapper = path.join(rec.installPath, 'lib', 'run-schedule.mjs');
    return fs.existsSync(wrapper) ? wrapper : null;
  } catch {
    return null;
  }
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (s: string): string => `<string>${xml(s)}</string>`;

function intervalDict(iv: CalendarInterval, indent: string): string {
  const keys = (['Minute', 'Hour', 'Day', 'Month', 'Weekday'] as const).filter((k) => iv[k] !== undefined);
  if (keys.length === 0) return `${indent}<dict/>`;
  return [`${indent}<dict>`, ...keys.map((k) => `${indent}  <key>${k}</key><integer>${iv[k]}</integer>`), `${indent}</dict>`].join('\n');
}

/** The whole plist for `job`; the text compared byte for byte against the installed one, so any change in cron, paths or env is an update. */
export function renderPlist(job: ScheduleJob, env: Record<string, string>, paths: ReconcilePaths): string {
  const parsed = parseCron(job.cron);
  const intervals = parsed.ok ? toCalendarIntervals(parsed.cron) : null;
  // The validator refuses both cases for any file naming mac, so a job reaching here with either is a caller bug, not a file error.
  if (!intervals) throw new Error(`${job.name}: cron has no launchd form`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(LABEL_PREFIX + job.name)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[paths.node, paths.wrapper, job.name].map((a) => `    ${str(a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    '  </dict>',
    `  <key>WorkingDirectory</key>${str(paths.schedules)}`,
    `  <key>StandardOutPath</key>${str(path.join(paths.launchd, `${job.name}.out.log`))}`,
    `  <key>StandardErrorPath</key>${str(path.join(paths.launchd, `${job.name}.err.log`))}`,
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...intervals.map((iv) => intervalDict(iv, '    ')),
    '  </array>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One crontab line: the cron, then the env inline on the command (lines of their own would leak into the user's entries below the block), every value
 * single-quoted, and `%` escaped because cron turns a bare one into a newline. Ends in the quoted job name, which is how an installed line is read back.
 */
export function renderCronLine(job: ScheduleJob, env: Record<string, string>, paths: ReconcilePaths): string {
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`);
  const command = [...assigns, sq(paths.node), sq(paths.wrapper), sq(job.name)].join(' ');
  return `${job.cron.trim()} ${command.replace(/%/g, '\\%')}`;
}

const CRON_NAME = / '([a-z0-9-]+)'$/;

/** Splits a crontab into the text around the marker block and the block's lines; no complete block means `before` is the whole text and `lines` is null. */
function splitCrontab(text: string): { before: string; lines: string[] | null; after: string } {
  const all = text.split('\n');
  const s = all.indexOf(CRON_START);
  const e = s === -1 ? -1 : all.indexOf(CRON_END, s + 1);
  if (s === -1 || e === -1) return { before: text, lines: null, after: '' };
  return { before: all.slice(0, s).map((l) => l + '\n').join(''), lines: all.slice(s + 1, e).filter((l) => l !== ''), after: all.slice(e + 1).join('\n') };
}

function joinCrontab(parts: { before: string; after: string }, lines: string[]): string {
  const block = lines.length === 0 ? '' : [CRON_START, ...lines, CRON_END, ''].join('\n');
  const before = block && parts.before !== '' && !parts.before.endsWith('\n') ? parts.before + '\n' : parts.before;
  return before + block + parts.after;
}

type Desired = { name: string; text: string };

interface PlanContext {
  report: ReconcileReport;
  machine: 'mac' | 'wsl';
  desired: Map<string, Desired>;
  crontab: string | null;
}

const now = (): string => new Date().toISOString();
const bare = (state: ReconcileState, error: string | null = null): ReconcileReport => ({ state, changes: [], unchanged: 0, error, at: now() });
const lastLine = (s: string): string => s.trim().split('\n').pop()?.trim() ?? '';

/** Why a file that exists is not desired on `machine`, or null when it is. */
function notDesired(stored: StoredJob, machine: 'mac' | 'wsl', claudeBin: string): string | null {
  const job = stored.job;
  if (!job || stored.errors.length > 0) return 'invalid';
  if (!job.enabled) return 'disabled';
  if (!job.machines.includes(machine)) return 'not this machine';
  if (job.run === 'claude' && claudeBin === '') return 'claude cli not configured';
  return null;
}

/** Whether `name`'s lock is held by a live wrapper; an unreadable holder counts as live, because acting on it would bootout a running job. */
function lockHeld(locks: string, name: string): boolean {
  let pid: unknown;
  try { pid = JSON.parse(fs.readFileSync(path.join(locks, `${name}.lock`), 'utf8'))?.pid; } catch { return false; }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  return wrapperAlive(pid, name, host.probe) !== false;
}

async function plan(config: Config): Promise<PlanContext | ReconcileReport> {
  if (!isOwner()) return bare('not-owner');
  const machine = machineName(config);
  if (machine.error) return bare('bad-machine', machine.error);
  const wrapper = installedWrapper();
  if (!wrapper) return bare('no-plugin', 'plugin not installed');

  const dirs = scheduleDirs(config);
  const env = scheduleEnv(config);
  const paths: ReconcilePaths = { node: host.nodePath, wrapper, schedules: dirs.schedules, launchd: dirs.launchd };
  const render = machine.name === 'mac' ? renderPlist : renderCronLine;

  const desired = new Map<string, Desired>();
  const skipped = new Map<string, string>();
  for (const stored of readJobs(dirs.schedules)) {
    const why = notDesired(stored, machine.name, config.claudeBin);
    if (why) skipped.set(stored.name, why);
    else desired.set(stored.name, { name: stored.name, text: render(stored.job as ScheduleJob, env, paths) });
  }

  // name -> installed text, plus whether launchd has it loaded (always true for a crontab line: cron reads the file).
  const installed = new Map<string, { text: string; loaded: boolean }>();
  const unknown: string[] = [];
  let crontab: string | null = null;
  let cronDown = false;
  if (machine.name === 'mac') {
    let files: string[] = [];
    try { files = fs.readdirSync(launchAgentsDir()); } catch { /* no LaunchAgents yet */ }
    for (const file of files.sort()) {
      if (!file.startsWith(LABEL_PREFIX) || !file.endsWith('.plist')) continue;
      const name = file.slice(LABEL_PREFIX.length, -'.plist'.length);
      let text: string;
      try { text = fs.readFileSync(path.join(launchAgentsDir(), file), 'utf8'); } catch { continue; }
      const print = await runner('launchctl', ['print', `gui/${host.uid}/${LABEL_PREFIX}${name}`]);
      installed.set(name, { text, loaded: print.code === 0 });
    }
  } else {
    cronDown = (await runner('pgrep', ['-x', 'cron|crond'])).stdout.trim() === '';
    const list = await runner('crontab', ['-l']);
    if (list.code === 0) crontab = list.stdout;
    else if (/no crontab/i.test(list.stderr)) crontab = '';
    // Anything else and the user's crontab is unknown: writing a block into it would clobber their entries.
    else return bare('failed', `crontab -l: ${lastLine(list.stderr) || `exit ${list.code}`}`);
    for (const line of splitCrontab(crontab).lines ?? []) {
      const m = CRON_NAME.exec(line);
      if (m) installed.set(m[1], { text: line, loaded: true });
      else unknown.push(line);
    }
  }

  const changes: ReconcileChange[] = [];
  let unchanged = 0;
  const running = (name: string): boolean => machine.name === 'mac' && lockHeld(dirs.locks, name);
  for (const d of desired.values()) {
    const have = installed.get(d.name);
    if (!have) changes.push({ name: d.name, action: 'install', why: 'new' });
    else if (!have.loaded) changes.push({ name: d.name, action: 'install', why: 'not loaded' });
    else if (have.text !== d.text) changes.push(running(d.name) ? { name: d.name, action: 'pending', why: 'running' } : { name: d.name, action: 'update', why: 'changed' });
    else unchanged++;
  }
  for (const name of installed.keys()) {
    if (desired.has(name)) continue;
    const why = skipped.get(name) ?? 'file gone';
    changes.push(running(name) ? { name, action: 'pending', why: 'running' } : { name, action: 'remove', why });
  }
  for (const [name, why] of skipped) {
    if (why === 'claude cli not configured' && !installed.has(name)) changes.push({ name, action: 'pending', why });
  }
  if (unknown.length > 0) changes.push({ name: '', action: 'remove', why: `${unknown.length} unrecognised line(s) in the marker block` });

  const acts = changes.some((c) => c.action !== 'pending');
  const state: ReconcileState = cronDown ? 'cron-down'
    : acts ? 'drift'
      : changes.some((c) => c.why === 'running') ? 'pending'
        : changes.length > 0 ? 'no-claude'
          : 'in-sync';
  return { report: { state, changes, unchanged, error: null, at: now() }, machine: machine.name, desired, crontab };
}

const isReport = (p: PlanContext | ReconcileReport): p is ReconcileReport => 'state' in p;

let lastReport: ReconcileReport | null = null;

/** The diff between the job files and what the OS has installed, read fresh from the OS; writes nothing. */
export async function planReconcile(config: Config): Promise<ReconcileReport> {
  const p = await plan(config);
  lastReport = isReport(p) ? p : p.report;
  return lastReport;
}

/** Atomic write: launchd may read the plist the moment `bootstrap` names it. */
function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function applyMac(ctx: PlanContext, errors: string[]): Promise<void> {
  const domain = `gui/${host.uid}`;
  for (const c of ctx.report.changes) {
    if (c.action === 'pending') continue;
    const label = `${LABEL_PREFIX}${c.name}`;
    const file = plistPath(c.name);
    try {
      if (c.action === 'remove') {
        await runner('launchctl', ['bootout', `${domain}/${label}`]);
        fs.rmSync(file, { force: true });
        continue;
      }
      const want = ctx.desired.get(c.name);
      if (!want) continue;
      writeFileAtomic(file, want.text);
      // Not loaded is the normal answer for an install; only bootstrap's verdict counts.
      await runner('launchctl', ['bootout', `${domain}/${label}`]);
      const boot = await runner('launchctl', ['bootstrap', domain, file]);
      if (boot.code !== 0) errors.push(`${c.name}: launchctl bootstrap: ${lastLine(boot.stderr) || `exit ${boot.code}`}`);
    } catch (e) {
      errors.push(`${c.name}: ${(e as Error).message}`);
    }
  }
}

async function applyWsl(ctx: PlanContext, errors: string[]): Promise<void> {
  if (!ctx.report.changes.some((c) => c.action !== 'pending') || ctx.crontab === null) return;
  const parts = splitCrontab(ctx.crontab);
  const lines = [...ctx.desired.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => d.text);
  const res = await runner('crontab', ['-'], joinCrontab(parts, lines));
  if (res.code !== 0) errors.push(`crontab -: ${lastLine(res.stderr) || `exit ${res.code}`}`);
}

async function applyOnce(config: Config): Promise<ReconcileReport> {
  const p = await plan(config);
  if (isReport(p)) { lastReport = p; return p; }
  const errors: string[] = [];
  if (p.machine === 'mac') await applyMac(p, errors);
  else await applyWsl(p, errors);
  const after = await planReconcile(config);
  lastReport = errors.length > 0 ? { ...after, state: 'failed', error: errors.join('; ') } : after;
  return lastReport;
}

let current: Promise<ReconcileReport> | null = null;
let queued: Promise<ReconcileReport> | null = null;
let queuedConfig: Config | null = null;

function start(config: Config): Promise<ReconcileReport> {
  const p: Promise<ReconcileReport> = applyOnce(config)
    .catch((e: unknown) => (lastReport = bare('failed', (e as Error).message)))
    .finally(() => { if (current === p) current = null; });
  current = p;
  return p;
}

/**
 * Apply the diff. One reconcile runs at a time: a call during a run queues exactly one trailing run (later calls share it, with the newest config), so the
 * crontab read-modify-write and the bootout/bootstrap pairs never interleave.
 */
export function applyReconcile(config: Config): Promise<ReconcileReport> {
  queuedConfig = config;
  if (queued) return queued;
  if (!current) return start(config);
  queued = current.then(() => {
    const cfg = queuedConfig ?? config;
    queued = null;
    queuedConfig = null;
    return start(cfg);
  });
  return queued;
}

/** The last report a plan or apply produced, or null before the first. */
export function lastReconcile(): ReconcileReport | null {
  return lastReport;
}

const DEBOUNCE_MS = 500;
let watchers: fs.FSWatcher[] = [];
let debounce: NodeJS.Timeout | null = null;

function watch(dir: string, onChange: (file: string | null) => void): void {
  try {
    const w = fs.watch(dir, (_event, file) => onChange(file === null ? null : String(file)));
    w.on('error', () => { /* the folder went away; the next server start re-watches */ });
    watchers.push(w);
  } catch { /* missing folder: nothing to watch until it exists and the server restarts */ }
}

/**
 * Re-run reconcile on: the schedules folder (a `sync.sh pull` lands several files, hence the debounce), `installed_plugins.json` (a plugin reinstall moves
 * the baked wrapper path), and the runs folder while a change is pending on a running job (its `end` record means the lock has gone). The caller runs the
 * start-up reconcile itself.
 */
export function startReconcileWatchers(config: Config): void {
  stopReconcileWatchers();
  const trigger = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void applyReconcile(config); }, DEBOUNCE_MS);
  };
  const dirs = scheduleDirs(config);
  watch(dirs.schedules, trigger);
  watch(path.dirname(installedPluginsPath()), (file) => { if (file === null || file === 'installed_plugins.json') trigger(); });
  // The wrapper creates runs/ on its first fire; making it here lets a fresh machine's first run end a pending change.
  if (isOwner()) try { fs.mkdirSync(dirs.runs, { recursive: true }); } catch { /* watch below just fails */ }
  watch(dirs.runs, () => { if (lastReport?.changes.some((c) => c.why === 'running')) trigger(); });
}

export function stopReconcileWatchers(): void {
  for (const w of watchers) w.close();
  watchers = [];
  if (debounce) clearTimeout(debounce);
  debounce = null;
}
