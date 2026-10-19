/**
 * server/lib/schedule-store.ts — the job folder, the pins snapshot, the owner lock and the lock sweep. Fixtures are tmpdirs; `HOME` is pointed at one so
 * `scheduleStateRoot` lands there, and a fake `Probe` stands in for every foreign process (never a real foreign pid). One case runs the real wrapper to pin
 * the boot id, lock shape and command-line match against what it actually writes.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PinRow } from '../shared/types.js';
import type { Config } from '../server/lib/config.js';
import {
  bootId, claimOwner, createProbe, deleteJob, isOwner, isWrapperCommand, readJobs, releaseOwner, sweepLocks, wrapperAlive, writeJob, writePinsSnapshot, ScheduleStoreError
} from '../server/lib/schedule-store.js';
import type { Probe } from '../server/lib/schedule-store.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(REPO, 'plugin', 'lib', 'run-schedule.mjs');
const made: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-store-'));
  made.push(d);
  return d;
}

/** A tmp HOME the state root resolves under, restored by `done()`. */
function homed(): { home: string; state: string; done: () => void } {
  const home = tmp();
  const saved = process.env.HOME;
  process.env.HOME = home;
  return { home, state: path.join(home, '.claude', 'schedules'), done: () => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; } };
}

function config(over: Partial<Config> = {}): Config {
  return { port: 4173, schedulesDir: '~/claude-global/schedules', scheduleMachine: 'mac', schedulesOwner: true, schedulesStateRoot: '', ...over } as Config;
}

const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function waitFor(cond: () => boolean, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; sleepMs(25); }
  return cond();
}

const GOOD = ['---', 'cron: "0 9 * * *"', 'machines: [mac]', 'run: claude', '---', '/git-sync', ''].join('\n');
const SHELL = (body: string): string => ['---', 'cron: "0 9 * * *"', 'machines: [mac]', 'run: shell', '---', '```bash', body, '```', ''].join('\n');

/** A probe over a table: pid -> command line (null = alive but unreadable); a pid absent from the table is dead. */
function fakeProbe(table: Record<number, string | null>): Probe {
  return { alive: pid => pid in table, command: pid => table[pid] ?? null };
}

const FOREIGN = 4_000_001;
const lockText = (pid: number, boot: string | null, job = 'x'): string => JSON.stringify({ pid, bootId: boot, job });

function writeLock(state: string, job: string, text: string): string {
  const dir = path.join(state, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${job}.lock`);
  fs.writeFileSync(f, text);
  return f;
}

export function run(): number {
  let p = 0, f = 0;
  const t = (name: string, fn: () => void): void => { if (test(name, fn)) p++; else f++; };

  t('readJobs: two valid files, one invalid, a .txt ignored, sorted by name with mtime', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'b-job.md'), GOOD);
    fs.writeFileSync(path.join(dir, 'a-job.md'), GOOD);
    fs.writeFileSync(path.join(dir, 'broken.md'), 'no frontmatter at all');
    fs.writeFileSync(path.join(dir, 'notes.txt'), GOOD);
    fs.writeFileSync(path.join(dir, '.hidden.md'), GOOD);
    fs.mkdirSync(path.join(dir, 'sub.md'));
    const jobs = readJobs(dir);
    assert.deepStrictEqual(jobs.map(j => j.name), ['a-job', 'b-job', 'broken']);
    assert.strictEqual(jobs.filter(j => j.job !== null).length, 2);
    const bad = jobs[2];
    assert.strictEqual(bad.job, null);
    assert.ok(bad.errors.length > 0);
    assert.strictEqual(bad.text, 'no frontmatter at all');
    assert.ok(jobs[0].mtimeMs > 0);
    assert.strictEqual(jobs[0].job?.name, 'a-job');
  });

  t('readJobs: a missing folder is an empty list', () => {
    assert.deepStrictEqual(readJobs(path.join(tmp(), 'nope')), []);
  });

  t('writeJob: replaces, leaves no temp file, creates the folder', () => {
    const dir = path.join(tmp(), 'new', 'schedules');
    writeJob(dir, 'nightly', GOOD);
    writeJob(dir, 'nightly', GOOD + 'more\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'nightly.md'), 'utf8'), GOOD + 'more\n');
    assert.deepStrictEqual(fs.readdirSync(dir), ['nightly.md']);
  });

  t('writeJob create: an existing name is `exists` and the file is untouched', () => {
    const dir = tmp();
    writeJob(dir, 'nightly', GOOD, 'create');
    assert.throws(() => writeJob(dir, 'nightly', 'other', 'create'), (e: unknown) => e instanceof ScheduleStoreError && e.code === 'exists');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'nightly.md'), 'utf8'), GOOD);
    assert.deepStrictEqual(fs.readdirSync(dir), ['nightly.md']);
  });

  t('writeJob / deleteJob refuse a name that could leave the folder', () => {
    const dir = tmp();
    for (const bad of ['../x', 'a/b', 'A', '', 'x.md', '.']) {
      assert.throws(() => writeJob(dir, bad, GOOD), (e: unknown) => e instanceof ScheduleStoreError && e.code === 'bad-name', bad);
      assert.throws(() => deleteJob(dir, bad), (e: unknown) => e instanceof ScheduleStoreError && e.code === 'bad-name', bad);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  t('deleteJob: true when removed, false when absent', () => {
    const dir = tmp();
    writeJob(dir, 'gone', GOOD);
    assert.strictEqual(deleteJob(dir, 'gone'), true);
    assert.strictEqual(deleteJob(dir, 'gone'), false);
    assert.deepStrictEqual(readJobs(dir), []);
  });

  t('writeJob: a reader in another process never sees a partial 1 MB file', () => {
    const dir = tmp();
    const A = 'a'.repeat(1_000_000);
    const B = 'b'.repeat(1_000_000);
    writeJob(dir, 'big', A);
    const done = path.join(dir, '.done');
    const script = path.join(tmp(), 'writer.ts');
    fs.writeFileSync(script, [
      `import fs from 'node:fs';`,
      `import { writeJob } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'server', 'lib', 'schedule-store.ts')).href)};`,
      `const [dir, done] = process.argv.slice(2);`,
      `const A = 'a'.repeat(1_000_000), B = 'b'.repeat(1_000_000);`,
      `for (let i = 0; i < 300; i++) writeJob(dir, 'big', i % 2 ? A : B);`,
      `fs.writeFileSync(done, 'x');`
    ].join('\n'));
    const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), [script, dir, done], { cwd: REPO, stdio: 'ignore' });
    try {
      let reads = 0, sawB = false;
      const deadline = Date.now() + 60_000;
      while (!fs.existsSync(done) && Date.now() < deadline) {
        const text = fs.readFileSync(path.join(dir, 'big.md'), 'utf8');
        assert.ok(text === A || text === B, `partial read of ${text.length} chars`);
        if (text === B) sawB = true;
        reads++;
      }
      assert.ok(fs.existsSync(done), 'writer did not finish');
      assert.ok(sawB && reads > 10, `reader overlapped the writer too little (${reads} reads)`);
      assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
    } finally {
      if (child.pid) try { process.kill(child.pid, 'SIGKILL'); } catch { /* exited */ }
    }
  });

  t('writePinsSnapshot: [{dirName,name,path,listed}] in pin order, extra fields dropped', () => {
    const h = homed();
    try {
      const rows: PinRow[] = [
        { dirName: '-r-zeta', name: 'zeta', path: '/r/zeta', lastActiveMs: 5, listed: true },
        { dirName: '-r-alpha', name: 'alpha', path: null, lastActiveMs: null, listed: false }
      ];
      writePinsSnapshot(config(), rows);
      const written = JSON.parse(fs.readFileSync(path.join(h.state, 'pins.json'), 'utf8'));
      assert.deepStrictEqual(written, [
        { dirName: '-r-zeta', name: 'zeta', path: '/r/zeta', listed: true },
        { dirName: '-r-alpha', name: 'alpha', path: null, listed: false }
      ]);
      assert.deepStrictEqual(fs.readdirSync(h.state), ['pins.json']);
    } finally { h.done(); }
  });

  t('writePinsSnapshot: with no rows given it reads the stored pin list (none stored -> [])', () => {
    const h = homed();
    const cwd = process.cwd();
    process.chdir(tmp());
    try {
      writePinsSnapshot(config());
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.state, 'pins.json'), 'utf8')), []);
    } finally { process.chdir(cwd); h.done(); }
  });

  t('claimOwner: no file -> owner; the file holds this pid, boot id, cwd and port', () => {
    const h = homed();
    try {
      assert.strictEqual(claimOwner(config({ port: 4999 }), fakeProbe({})), 'owner');
      assert.strictEqual(isOwner(), true);
      const rec = JSON.parse(fs.readFileSync(path.join(h.state, 'owner.json'), 'utf8'));
      assert.deepStrictEqual([rec.pid, rec.bootId, rec.cwd, rec.port], [process.pid, bootId(), process.cwd(), 4999]);
      assert.ok(!Number.isNaN(Date.parse(rec.at)));
      releaseOwner();
      assert.strictEqual(isOwner(), false);
      assert.strictEqual(fs.existsSync(path.join(h.state, 'owner.json')), false);
    } finally { releaseOwner(); h.done(); }
  });

  t('claimOwner: a live foreign pid keeps the file and reports <cwd>:<port>', () => {
    const h = homed();
    try {
      fs.mkdirSync(h.state, { recursive: true });
      const text = JSON.stringify({ pid: FOREIGN, bootId: bootId(), cwd: '/work/tree', port: 4273, at: 'x' });
      fs.writeFileSync(path.join(h.state, 'owner.json'), text);
      assert.deepStrictEqual(claimOwner(config(), fakeProbe({ [FOREIGN]: 'node server' })), { ownedBy: '/work/tree:4273' });
      assert.strictEqual(isOwner(), false);
      assert.strictEqual(fs.readFileSync(path.join(h.state, 'owner.json'), 'utf8'), text);
      assert.deepStrictEqual(fs.readdirSync(h.state), ['owner.json']);
    } finally { releaseOwner(); h.done(); }
  });

  t('claimOwner: a dead pid, another boot, or an unreadable file is taken over', () => {
    const cases: Array<[string, string, Probe]> = [
      ['dead pid', JSON.stringify({ pid: FOREIGN, bootId: bootId(), cwd: '/x', port: 1 }), fakeProbe({})],
      ['another boot', JSON.stringify({ pid: FOREIGN, bootId: 'not-this-boot', cwd: '/x', port: 1 }), fakeProbe({ [FOREIGN]: 'node' })],
      ['torn file', '{"pid": 4000', fakeProbe({ [FOREIGN]: 'node' })],
      ['no pid', JSON.stringify({ cwd: '/x', port: 1 }), fakeProbe({})]
    ];
    for (const [label, text, probe] of cases) {
      const h = homed();
      try {
        fs.mkdirSync(h.state, { recursive: true });
        fs.writeFileSync(path.join(h.state, 'owner.json'), text);
        assert.strictEqual(claimOwner(config(), probe), 'owner', label);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.state, 'owner.json'), 'utf8')).pid, process.pid, label);
        assert.deepStrictEqual(fs.readdirSync(h.state), ['owner.json'], label);
      } finally { releaseOwner(); h.done(); }
    }
  });

  t('claimOwner: a server without SCHEDULES_OWNER never claims and leaves the file alone', () => {
    const h = homed();
    try {
      const text = JSON.stringify({ pid: FOREIGN, bootId: 'old', cwd: '/x', port: 1 });
      fs.mkdirSync(h.state, { recursive: true });
      fs.writeFileSync(path.join(h.state, 'owner.json'), text);
      assert.deepStrictEqual(claimOwner(config({ schedulesOwner: false }), fakeProbe({})), { ownedBy: '' });
      assert.strictEqual(isOwner(), false);
      assert.strictEqual(fs.readFileSync(path.join(h.state, 'owner.json'), 'utf8'), text);
      fs.unlinkSync(path.join(h.state, 'owner.json'));
      claimOwner(config({ schedulesOwner: false }), fakeProbe({}));
      assert.deepStrictEqual(fs.readdirSync(h.state), []);
    } finally { releaseOwner(); h.done(); }
  });

  t('claimOwner: under the SCHEDULES_STATE_ROOT seam it is never the owner and writes nothing', () => {
    const h = homed();
    const seam = path.join(tmp(), 'seam');
    try {
      assert.deepStrictEqual(claimOwner(config({ schedulesStateRoot: seam }), fakeProbe({})), { ownedBy: 'seam' });
      assert.strictEqual(isOwner(), false);
      assert.strictEqual(fs.existsSync(seam), false);
      assert.strictEqual(fs.existsSync(h.state), false);
    } finally { releaseOwner(); h.done(); }
  });

  t('releaseOwner: leaves a file another server has since taken', () => {
    const h = homed();
    try {
      assert.strictEqual(claimOwner(config(), fakeProbe({})), 'owner');
      const taken = JSON.stringify({ pid: FOREIGN, bootId: bootId(), cwd: '/y', port: 2 });
      fs.writeFileSync(path.join(h.state, 'owner.json'), taken);
      releaseOwner();
      assert.strictEqual(fs.readFileSync(path.join(h.state, 'owner.json'), 'utf8'), taken);
    } finally { releaseOwner(); h.done(); }
  });

  t('isWrapperCommand: run-schedule.mjs followed by exactly the job', () => {
    assert.strictEqual(isWrapperCommand('node /p/lib/run-schedule.mjs git-sync-all --trigger schedule', 'git-sync-all'), true);
    assert.strictEqual(isWrapperCommand('node /p/lib/run-schedule.mjs git-sync-all --trigger schedule', 'git-sync'), false);
    assert.strictEqual(isWrapperCommand('node /p/lib/run-schedule.mjs git-sync', 'git-sync-all'), false);
    assert.strictEqual(isWrapperCommand('  /usr/bin/node   /p/lib/run-schedule.mjs   x  ', 'x'), true);
    assert.strictEqual(isWrapperCommand('vim run-schedule.mjs', 'x'), false);
    assert.strictEqual(isWrapperCommand('node /p/other.mjs git-sync', 'git-sync'), false);
  });

  t('wrapperAlive: dead -> false, live match -> true, live mismatch -> false, unreadable command -> null', () => {
    const probe = fakeProbe({ 10: 'node /p/run-schedule.mjs j', 11: 'bash', 12: null });
    assert.deepStrictEqual([10, 11, 12, 13].map(pid => wrapperAlive(pid, 'j', probe)), [true, false, null, false]);
  });

  t('sweepLocks: dead pid removed; live matching wrapper kept; same command for another job removed; something else removed; another boot removed', () => {
    const h = homed();
    try {
      const boot = bootId();
      const probe = fakeProbe({
        101: 'node /p/lib/run-schedule.mjs git-sync-all --trigger schedule',
        102: 'node /p/lib/run-schedule.mjs git-sync-all --trigger schedule',
        103: '/bin/zsh -l',
        104: 'node /p/lib/run-schedule.mjs on-other-boot --trigger schedule'
      });
      writeLock(h.state, 'dead', lockText(999, boot));
      writeLock(h.state, 'git-sync-all', lockText(101, boot));
      writeLock(h.state, 'git-sync', lockText(102, boot));
      writeLock(h.state, 'reused', lockText(103, boot));
      writeLock(h.state, 'on-other-boot', lockText(104, 'a-previous-boot'));
      const swept = sweepLocks(config(), probe);
      assert.deepStrictEqual(swept.sort(), ['dead', 'git-sync', 'on-other-boot', 'reused']);
      assert.deepStrictEqual(fs.readdirSync(path.join(h.state, 'locks')), ['git-sync-all.lock']);
    } finally { h.done(); }
  });

  t('sweepLocks: a torn lock is removed; a live pid whose command cannot be read is kept; stray files and a missing folder are left alone', () => {
    const h = homed();
    try {
      assert.deepStrictEqual(sweepLocks(config(), fakeProbe({})), []);
      const boot = bootId();
      writeLock(h.state, 'torn', '{"pid": 5');
      writeLock(h.state, 'blind', lockText(105, boot));
      fs.writeFileSync(path.join(h.state, 'locks', 'blind.lock.77.tmp'), 'x');
      fs.writeFileSync(path.join(h.state, 'locks', 'readme.txt'), 'x');
      assert.deepStrictEqual(sweepLocks(config(), fakeProbe({ 105: null })), ['torn']);
      assert.deepStrictEqual(fs.readdirSync(path.join(h.state, 'locks')).sort(), ['blind.lock', 'blind.lock.77.tmp', 'readme.txt']);
    } finally { h.done(); }
  });

  t('sweepLocks: a lock replaced between the read and the rename is put back, not swept', () => {
    const h = homed();
    try {
      const boot = bootId();
      const file = writeLock(h.state, 'raced', lockText(999, boot));
      const live = lockText(106, boot, 'raced');
      let swapped = false;
      // The probe is called while the sweep judges the first text; replacing the file then models a wrapper taking over mid-sweep.
      const probe: Probe = {
        alive: pid => { if (!swapped) { swapped = true; fs.writeFileSync(file, live); } return pid === 106; },
        command: () => 'node /p/lib/run-schedule.mjs raced'
      };
      assert.deepStrictEqual(sweepLocks(config(), probe), []);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), live);
      assert.deepStrictEqual(fs.readdirSync(path.join(h.state, 'locks')), ['raced.lock']);
    } finally { h.done(); }
  });

  t('the wrapper itself: its lock carries this boot id and shape, and a live one survives sweepLocks with the real probe', () => {
    const h = homed();
    const dir = path.join(h.home, 'claude-global', 'schedules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hold.md'), SHELL('sleep 20'));
    const env = { PATH: process.env.PATH, HOME: h.home, SCHEDULE_MACHINE: 'mac', SCHEDULES_DIR: dir, SPAWN_MAX_PERMISSION: 'auto', SYNC_PERMISSION_MODE: 'auto', CLAUDE_BIN: '' };
    const child = spawn(process.execPath, [WRAPPER, 'hold', '--trigger', 'manual'], { env, stdio: 'ignore' });
    const lock = path.join(h.state, 'locks', 'hold.lock');
    try {
      assert.ok(waitFor(() => fs.existsSync(lock), 10_000), 'wrapper never took its lock');
      const rec = JSON.parse(fs.readFileSync(lock, 'utf8'));
      assert.deepStrictEqual(Object.keys(rec).sort(), ['bootId', 'job', 'pid']);
      assert.deepStrictEqual([rec.pid, rec.job, rec.bootId], [child.pid, 'hold', bootId()]);
      assert.notStrictEqual(rec.bootId, null);
      assert.strictEqual(wrapperAlive(rec.pid, 'hold', createProbe()), true);
      assert.strictEqual(wrapperAlive(rec.pid, 'hol', createProbe()), false);
      assert.deepStrictEqual(sweepLocks(config(), createProbe()), []);
      assert.ok(fs.existsSync(lock));
    } finally {
      // TERM, not KILL: the wrapper forwards it to its step group and releases its lock, so no `sleep` outlives the suite.
      if (child.pid) try { process.kill(child.pid, 'SIGTERM'); } catch { /* exited */ }
      if (!waitFor(() => !fs.existsSync(lock), 15_000) && child.pid) try { process.kill(child.pid, 'SIGKILL'); } catch { /* exited */ }
      h.done();
    }
  });

  t('drift guard: the wrapper source still holds the boot id, command-line and lock-shape expressions this module mirrors', () => {
    const src = fs.readFileSync(WRAPPER, 'utf8');
    for (const needle of [
      `execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' })`,
      'out.match(/sec = (\\d+)/)',
      `m ? m[1] : out.trim()`,
      `fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()`,
      `execFileSync('ps', ['-o', 'command=', '-p', String(pid)]`,
      'cmd.trim().split(/\\s+/)',
      `path.basename(t) === 'run-schedule.mjs' && tokens[i + 1] === job`,
      `JSON.stringify({ pid: process.pid, bootId: this.bootId, job: this.job })`,
      `held?.bootId == null || this.bootId == null || held.bootId === this.bootId`
    ]) assert.ok(src.includes(needle), `wrapper no longer contains: ${needle}`);
  });

  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\nschedule-store: ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
