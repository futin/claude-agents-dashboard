/**
 * server/lib/schedule-run.ts — Run now and Stop. A fake spawner (the `setSpawner` seam) stands in for the wrapper, so nothing here starts a real run; the
 * fake appends `start` records to a fixture run log the way the wrapper would, and a fake `Probe` stands in for every foreign pid.
 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import type { Config } from '../server/lib/config.js';
import { scheduleEnv } from '../server/lib/schedule-config.js';
import { PLUGIN_ID } from '../server/lib/schedule-reconcile.js';
import { runJob, stopJob } from '../server/lib/schedule-run.js';
import { bootId } from '../server/lib/schedule-store.js';
import type { Probe } from '../server/lib/schedule-store.js';
import { setSpawner } from '../server/lib/spawn.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const made: string[] = [];
const HELD = 4_000_001;
const WRAPPER_CMD = (job: string): string => `/opt/node/bin/node /plugin/lib/run-schedule.mjs ${job} --trigger schedule`;

const JOB = (extra: string[] = [], machines = 'mac'): string =>
  ['---', 'cron: "0 9 * * *"', `machines: [${machines}]`, 'run: claude', ...extra, '---', '/git-sync', ''].join('\n');

interface Fixture { home: string; schedules: string; runs: string; locks: string; wrapper: string; config: Config; done: () => void }

/** A tmp HOME with an installed plugin, a schedules folder and a state root; `HOME` is restored by `done()`. */
function fixture(over: { plugin?: boolean; machine?: 'mac' | 'wsl' } = {}): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-run-'));
  made.push(home);
  const saved = process.env.HOME;
  process.env.HOME = home;
  const state = path.join(home, 'state');
  const schedules = path.join(home, 'schedules');
  const install = path.join(home, 'plugin-install');
  const wrapper = path.join(install, 'lib', 'run-schedule.mjs');
  fs.mkdirSync(schedules, { recursive: true });
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
  if (over.plugin !== false) {
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, '// fixture, never run\n');
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  }
  const config = {
    port: 4173, schedulesDir: schedules, scheduleMachine: over.machine ?? 'mac', schedulesOwner: true, schedulesStateRoot: state,
    claudeBin: '/bin/claude', spawnMaxPermission: 'auto', syncPermissionMode: 'acceptEdits'
  } as Config;
  return {
    home, schedules, runs: path.join(state, 'runs'), locks: path.join(state, 'locks'), wrapper, config,
    done: () => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; setSpawner(null); }
  };
}

interface Call { command: string; args: string[]; options: SpawnOptions; unref: number }

/** Installs a recording spawner; `onSpawn` plays the wrapper (writes log lines). The child is an emitter with `unref`, never a process. */
function fakeSpawner(onSpawn?: () => void, throws = false): Call[] {
  const calls: Call[] = [];
  setSpawner((command, args, options) => {
    if (throws) throw new Error('spawn ENOENT');
    const call: Call = { command, args, options, unref: 0 };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), { pid: 99, unref: () => { call.unref++; } });
    onSpawn?.();
    return child as unknown as ChildProcess;
  });
  return calls;
}

const startRec = (run: string, job: string, trigger: string, at: Date): string =>
  JSON.stringify({ kind: 'start', run, job, machine: 'mac', trigger, at: at.toISOString(), steps: 1, pid: 99 }) + '\n';

function fakeProbe(table: Record<number, string | null>): Probe {
  return { alive: pid => pid in table, command: pid => table[pid] ?? null };
}

const writeLock = (fx: Fixture, job: string, pid: number, boot: string | null = bootId()): void =>
  fs.writeFileSync(path.join(fx.locks, `${job}.lock`), JSON.stringify({ pid, bootId: boot, job }));

const later = (ms: number, fn: () => void): void => { setTimeout(fn, ms); };

export async function run(): Promise<number> {
  let total = 0;
  let ok_ = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };
  const NO_PROBE = fakeProbe({});

  check(await test('argv is [node, wrapper, name, --trigger, manual]; env is scheduleEnv exactly; detached, stdio ignored, unref called', async () => {
    const fx = fixture();
    const savedEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const log = path.join(fx.runs, 'mac.jsonl');
      const calls = fakeSpawner(() => later(30, () => fs.appendFileSync(log, startRec('r-1', 'git-sync', 'manual', new Date()))));
      const r = await runJob(fx.config, 'git-sync', undefined, NO_PROBE);
      assert.deepStrictEqual(r, { status: 202, run: 'r-1' });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].command, process.execPath);
      assert.deepStrictEqual(calls[0].args, [fx.wrapper, 'git-sync', '--trigger', 'manual']);
      assert.deepStrictEqual(calls[0].options.env, scheduleEnv(fx.config));
      assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in (calls[0].options.env ?? {})));
      assert.strictEqual(calls[0].options.detached, true);
      assert.strictEqual(calls[0].options.stdio, 'ignore');
      assert.strictEqual(calls[0].unref, 1);
    } finally {
      if (savedEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntry;
      fx.done();
    }
  }));

  check(await test('--only a b is appended after --trigger manual; an empty list adds nothing', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB(['foreach: pinned']));
      const calls = fakeSpawner(() => later(10, () => fs.appendFileSync(path.join(fx.runs, 'mac.jsonl'), startRec('r-2', 'git-sync', 'manual', new Date()))));
      await runJob(fx.config, 'git-sync', ['a', 'b'], NO_PROBE);
      assert.deepStrictEqual(calls[0].args, [fx.wrapper, 'git-sync', '--trigger', 'manual', '--only', 'a', 'b']);
      await runJob(fx.config, 'git-sync', [], NO_PROBE);
      assert.deepStrictEqual(calls[1].args, [fx.wrapper, 'git-sync', '--trigger', 'manual']);
    } finally { fx.done(); }
  }));

  check(await test('only a manual start for this job at or after the spawn counts; older, scheduled and other-job records are skipped', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const log = path.join(fx.runs, 'mac.jsonl');
      const old = new Date(Date.now() - 60_000);
      fs.writeFileSync(log, startRec('old-manual', 'git-sync', 'manual', old));
      fakeSpawner(() => later(20, () => {
        fs.appendFileSync(log, startRec('sched', 'git-sync', 'schedule', new Date()));
        fs.appendFileSync(log, startRec('other', 'other-job', 'manual', new Date()));
        fs.appendFileSync(log, startRec('mine', 'git-sync', 'manual', new Date()));
      }));
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: 'mine' });
    } finally { fx.done(); }
  }));

  check(await test('a record written in two chunks is read once its line is whole; a log rotated mid-wait is read from the top', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const log = path.join(fx.runs, 'mac.jsonl');
      fs.writeFileSync(log, 'x'.repeat(5000) + '\n');
      const line = startRec('chunked', 'git-sync', 'manual', new Date(Date.now() + 10_000));
      fakeSpawner(() => {
        later(20, () => fs.appendFileSync(log, line.slice(0, 20)));
        later(120, () => fs.appendFileSync(log, line.slice(20)));
      });
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: 'chunked' });

      fs.writeFileSync(log, 'y'.repeat(5000) + '\n');
      fakeSpawner(() => later(20, () => { fs.rmSync(log); fs.writeFileSync(log, startRec('rotated', 'git-sync', 'manual', new Date())); }));
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: 'rotated' });
    } finally { fx.done(); }
  }));

  check(await test('no start record within 2 s answers 202 with run null, and the wrapper was spawned', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const calls = fakeSpawner();
      const t0 = Date.now();
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: null });
      const waited = Date.now() - t0;
      assert.ok(waited >= 1900 && waited < 3500, `waited ${waited} ms`);
      assert.strictEqual(calls.length, 1);
    } finally { fx.done(); }
  }));

  check(await test('a lock held by a live wrapper for the job is 409 already-running and nothing spawns', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      writeLock(fx, 'git-sync', HELD);
      const calls = fakeSpawner();
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') })), { status: 409, error: 'already-running' });
      assert.strictEqual(calls.length, 0);
    } finally { fx.done(); }
  }));

  check(await test('a stale lock (dead pid, pid reused by another command, another boot, torn file) does not block; an unreadable command line is not "running" either', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const log = path.join(fx.runs, 'mac.jsonl');
      const calls = fakeSpawner(() => later(5, () => fs.appendFileSync(log, startRec('r', 'git-sync', 'manual', new Date()))));
      const lock = path.join(fx.locks, 'git-sync.lock');
      const cases: Array<[string, () => void, Probe]> = [
        ['dead pid', () => writeLock(fx, 'git-sync', HELD), NO_PROBE],
        ['reused pid', () => writeLock(fx, 'git-sync', HELD), fakeProbe({ [HELD]: '/usr/bin/vim notes.md' })],
        ['git-sync-all is not git-sync', () => writeLock(fx, 'git-sync', HELD), fakeProbe({ [HELD]: WRAPPER_CMD('git-sync-all') })],
        ['another boot', () => writeLock(fx, 'git-sync', HELD, 'a-different-boot'), fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') })],
        ['torn lock', () => fs.writeFileSync(lock, '{"pid":'), fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') })],
        ['unreadable command', () => writeLock(fx, 'git-sync', HELD), fakeProbe({ [HELD]: null })]
      ];
      for (const [label, setup, probe] of cases) {
        setup();
        const r = await runJob(fx.config, 'git-sync', undefined, probe);
        assert.strictEqual(r.status, 202, label);
      }
      assert.strictEqual(calls.length, cases.length);
    } finally { fx.done(); }
  }));

  check(await test('unknown name and path-shaped names are 404 and nothing spawns', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const calls = fakeSpawner();
      for (const name of ['nope', '../git-sync', 'Git-Sync', '']) assert.deepStrictEqual(await runJob(fx.config, name, undefined, NO_PROBE), { status: 404 }, name);
      assert.strictEqual(calls.length, 0);
    } finally { fx.done(); }
  }));

  check(await test('a paused (enabled: false) job runs on demand', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB(['enabled: false']));
      const calls = fakeSpawner(() => later(5, () => fs.appendFileSync(path.join(fx.runs, 'mac.jsonl'), startRec('paused', 'git-sync', 'manual', new Date()))));
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: 'paused' });
      assert.strictEqual(calls.length, 1);
    } finally { fx.done(); }
  }));

  check(await test('a file that does not parse, or does not name this machine, is 409 without spawning (the wrapper would only log refused)', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'broken.md'), '---\ncron: nonsense\n---\nx\n');
      fs.writeFileSync(path.join(fx.schedules, 'elsewhere.md'), JOB([], 'wsl'));
      const calls = fakeSpawner();
      assert.deepStrictEqual(await runJob(fx.config, 'broken', undefined, NO_PROBE), { status: 409, error: 'invalid' });
      assert.deepStrictEqual(await runJob(fx.config, 'elsewhere', undefined, NO_PROBE), { status: 409, error: 'not-this-machine' });
      assert.strictEqual(calls.length, 0);
    } finally { fx.done(); }
  }));

  check(await test('no installed plugin is 409 no-plugin and nothing spawns', async () => {
    const fx = fixture({ plugin: false });
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      const calls = fakeSpawner();
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 409, error: 'no-plugin' });
      assert.strictEqual(calls.length, 0);
    } finally { fx.done(); }
  }));

  check(await test('a spawner that throws is 500 spawn-failed; an async child error event does not escape', async () => {
    const fx = fixture();
    try {
      fs.writeFileSync(path.join(fx.schedules, 'git-sync.md'), JOB());
      fakeSpawner(undefined, true);
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 500, error: 'spawn-failed' });

      setSpawner(() => {
        const child = Object.assign(new EventEmitter(), { pid: 1, unref: () => undefined });
        setImmediate(() => child.emit('error', new Error('boom')));
        return child as unknown as ChildProcess;
      });
      fs.appendFileSync(path.join(fx.runs, 'mac.jsonl'), '');
      later(100, () => fs.appendFileSync(path.join(fx.runs, 'mac.jsonl'), startRec('e', 'git-sync', 'manual', new Date())));
      assert.deepStrictEqual(await runJob(fx.config, 'git-sync', undefined, NO_PROBE), { status: 202, run: 'e' });
    } finally { fx.done(); }
  }));

  check(await test('stopJob: SIGTERM to the lock pid only when its command line is this job\'s wrapper', () => {
    const fx = fixture();
    try {
      const sent: Array<[number, string]> = [];
      const kill = (pid: number, sig: string): void => { sent.push([pid, sig]); };
      writeLock(fx, 'git-sync', HELD);
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') }), kill), { status: 204 });
      assert.deepStrictEqual(sent, [[HELD, 'SIGTERM']]);
    } finally { fx.done(); }
  }));

  check(await test('stopJob is 409 not-running and signals nothing for: no lock, dead pid, reused pid, another job\'s wrapper, unreadable command, other boot, torn lock, bad name', () => {
    const fx = fixture();
    try {
      const sent: number[] = [];
      const kill = (pid: number): void => { sent.push(pid); };
      const notRunning = { status: 409, error: 'not-running' };
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', NO_PROBE, kill), notRunning, 'no lock');
      writeLock(fx, 'git-sync', HELD);
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', NO_PROBE, kill), notRunning, 'dead pid');
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: '/usr/bin/vim x' }), kill), notRunning, 'reused pid');
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('git-sync-all') }), kill), notRunning, 'other job');
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: null }), kill), notRunning, 'unreadable');
      writeLock(fx, 'git-sync', HELD, 'a-different-boot');
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') }), kill), notRunning, 'other boot');
      fs.writeFileSync(path.join(fx.locks, 'git-sync.lock'), '{"pid":');
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') }), kill), notRunning, 'torn');
      assert.deepStrictEqual(stopJob(fx.config, '../git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('../git-sync') }), kill), notRunning, 'bad name');
      assert.deepStrictEqual(sent, []);
    } finally { fx.done(); }
  }));

  check(await test('stopJob: a pid that vanishes between the check and the signal is 409, not a throw', () => {
    const fx = fixture();
    try {
      writeLock(fx, 'git-sync', HELD);
      const kill = (): void => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
      assert.deepStrictEqual(stopJob(fx.config, 'git-sync', fakeProbe({ [HELD]: WRAPPER_CMD('git-sync') }), kill), { status: 409, error: 'not-running' });
    } finally { fx.done(); }
  }));

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\nschedule-run: ${ok_} passed, ${total - ok_} failed`);
  return total - ok_;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
