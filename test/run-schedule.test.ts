/**
 * The schedule wrapper, `plugin/lib/run-schedule.mjs`, driven as launchd and cron drive it: a child process with an explicit environment (the keys
 * reconcile bakes, plus `FAKE_*` for the fake `claude`), `HOME` a tmpdir, and the run log read back from `~/.claude/schedules/runs/<machine>.jsonl`.
 * Spec: docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md §The wrapper, §The run log.
 */
import assert from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'lib', 'run-schedule.mjs');
const UUID_RE = /^[0-9a-f-]{36}$/;

// Records its argv (one per line), stdin and env, then prints FAKE_RESULT — the CLI's `--output-format json` result.
const FAKE_CLAUDE = [
  '#!/bin/bash',
  'printf "%s\\n" "$@" > "$FAKE_REC/argv"',
  'cat > "$FAKE_REC/stdin"',
  'env > "$FAKE_REC/env"',
  'printf "%s" "$FAKE_RESULT"',
  'exit "${FAKE_EXIT:-0}"',
  '',
].join('\n');

const OK_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'done', session_id: 'x', total_cost_usd: 0.25,
  usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 50 },
  modelUsage: { 'claude-opus-4-5': { costUSD: 0.25 } },
});

interface Fx { home: string; dir: string; state: string; rec: string; claude: string }
const fixtures: string[] = [];

function setup(): Fx {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-schedule-'));
  fixtures.push(home);
  const dir = path.join(home, 'claude-global', 'schedules');
  const state = path.join(home, '.claude', 'schedules');
  const rec = path.join(home, 'rec');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(rec);
  const claude = path.join(home, 'fake-claude');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  return { home, dir, state, rec, claude };
}

function envFor(fx: Fx, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: fx.home, CLAUDE_BIN: fx.claude, SPAWN_MAX_PERMISSION: 'auto', SYNC_PERMISSION_MODE: 'auto',
    SCHEDULE_MACHINE: 'mac', SCHEDULES_DIR: fx.dir, FAKE_REC: fx.rec, FAKE_RESULT: OK_RESULT, ...extra,
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env as NodeJS.ProcessEnv;
}

function writeJob(fx: Fx, name: string, fm: string[], body: string): void {
  fs.writeFileSync(path.join(fx.dir, `${name}.md`), ['---', ...fm, '---', body, ''].join('\n'));
}

function shellJob(fx: Fx, name: string, script: string, fm: string[] = []): void {
  writeJob(fx, name, ['cron: "0 22 * * *"', 'machines: [mac]', 'run: shell', ...fm], ['```bash', script, '```'].join('\n'));
}

function claudeJob(fx: Fx, name: string, fm: string[] = [], body = 'Do the thing.\nThen stop.'): void {
  writeJob(fx, name, ['cron: "0 22 * * *"', 'machines: [mac]', 'run: claude', ...fm], body);
}

function writePins(fx: Fx, pins: Array<{ dirName: string; name: string; path: string | null; listed: boolean }>): void {
  fs.mkdirSync(fx.state, { recursive: true });
  fs.writeFileSync(path.join(fx.state, 'pins.json'), JSON.stringify(pins));
}

function repo(fx: Fx, name: string): string {
  const p = path.join(fx.home, 'repos', name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function wrap(fx: Fx, args: string[], extra: Record<string, string | undefined> = {}): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [WRAPPER, ...args], { env: envFor(fx, extra), encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stderr: r.stderr };
}

function log(fx: Fx, machine = 'mac'): any[] {
  const p = path.join(fx.state, 'runs', `${machine}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
}

const kinds = (recs: any[]): string[] => recs.map((r) => r.kind);
const ofKind = (recs: any[], kind: string): any[] => recs.filter((r) => r.kind === kind);
const argvOf = (fx: Fx): string[] => fs.readFileSync(path.join(fx.rec, 'argv'), 'utf8').split('\n').filter((l) => l !== '');
const after = (argv: string[], flag: string): string | undefined => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };

function bootId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
      const m = out.match(/sec = (\d+)/);
      return m ? m[1] : out.trim();
    }
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch { return null; }
}

function writeLock(fx: Fx, job: string, lock: Record<string, unknown>): void {
  fs.mkdirSync(path.join(fx.state, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(fx.state, 'locks', `${job}.lock`), JSON.stringify(lock));
}

/** A long-lived process whose command line reads `node -e … /x/run-schedule.mjs <job>`, so the wrapper's command-line check sees a wrapper. */
function fakeWrapper(job: string): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)', '/x/run-schedule.mjs', job], { stdio: 'ignore' });
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A zombie answers kill(0) until reaped, so "gone" is polled briefly. */
async function gone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    if (st === '' || st.startsWith('Z')) return true;
    await sleepMs(50);
  }
  return false;
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await sleepMs(25);
  }
}

function readPid(p: string): number { return Number(fs.readFileSync(p, 'utf8').trim()); }

export async function run(): Promise<number> {
  console.log('\n=== run-schedule wrapper ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };
  const kids: ChildProcess[] = [];

  tally(await test('shell `echo hi` → start (steps 1), step-start, step-end exit 0 ok tail "hi", end ok 1; exit 0', () => {
    const fx = setup();
    shellJob(fx, 'hello', 'echo hi');
    const r = wrap(fx, ['hello', '--trigger', 'manual']);
    assert.strictEqual(r.code, 0, r.stderr);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'step-start', 'step-end', 'end']);
    const [start, ss, se, end] = recs;
    assert.strictEqual(start.steps, 1);
    assert.strictEqual(start.job, 'hello');
    assert.strictEqual(start.machine, 'mac');
    assert.strictEqual(start.trigger, 'manual');
    assert.strictEqual(start.late, false);
    assert.ok(!('slot' in start), 'manual has no slot');
    assert.match(start.run, UUID_RE);
    assert.strictEqual(typeof start.pid, 'number');
    assert.ok(!Number.isNaN(Date.parse(start.at)));
    for (const rec of [ss, se, end]) assert.strictEqual(rec.run, start.run);
    assert.strictEqual(ss.step, 0);
    assert.strictEqual(ss.repo, null);
    assert.ok(!('session' in ss), 'shell step has no session');
    assert.strictEqual(se.exit, 0);
    assert.strictEqual(se.outcome, 'ok');
    assert.ok(se.tail.endsWith('hi'), `tail ${JSON.stringify(se.tail)}`);
    assert.strictEqual(typeof se.ms, 'number');
    assert.strictEqual(end.ok, 1);
    assert.strictEqual(end.failed, 0);
    assert.strictEqual(end.skipped, 0);
    assert.strictEqual(end.stopped, false);
    assert.ok(!('error' in end));
    assert.ok(!fs.existsSync(path.join(fx.state, 'locks', 'hello.lock')), 'lock released');
  }));

  tally(await test('shell `exit 3` → outcome failed, exit 3, end.failed 1; wrapper exits 1', () => {
    const fx = setup();
    shellJob(fx, 'boom', 'echo before\nexit 3');
    const r = wrap(fx, ['boom', '--trigger', 'manual']);
    assert.strictEqual(r.code, 1);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'failed');
    assert.strictEqual(se.exit, 3);
    assert.strictEqual(se.why, 'exit 3');
    assert.ok(se.tail.endsWith('before'));
    const end = ofKind(log(fx), 'end')[0];
    assert.strictEqual(end.failed, 1);
    assert.strictEqual(end.ok, 0);
  }));

  tally(await test('bash -e: a failing command mid-script stops the script', () => {
    const fx = setup();
    shellJob(fx, 'strict', 'echo one\nfalse\necho two');
    assert.strictEqual(wrap(fx, ['strict', '--trigger', 'manual']).code, 1);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'failed');
    assert.ok(!se.tail.includes('two'));
  }));

  tally(await test('tail keeps the last 20 lines of combined stdout+stderr', () => {
    const fx = setup();
    shellJob(fx, 'noisy', 'for i in $(seq 1 30); do echo "out $i"; done\necho "err last" >&2');
    assert.strictEqual(wrap(fx, ['noisy', '--trigger', 'manual']).code, 0);
    const lines = ofKind(log(fx), 'step-end')[0].tail.split('\n');
    assert.strictEqual(lines.length, 20);
    assert.strictEqual(lines[0], 'out 12');
    assert.strictEqual(lines[19], 'err last');
  }));

  tally(await test('no foreach: cwd defaults to the schedules folder\'s parent; `cwd: ~/x` expands HOME', () => {
    const fx = setup();
    shellJob(fx, 'here', 'true');
    shellJob(fx, 'there', 'true', ['cwd: ~/proj']);
    fs.mkdirSync(path.join(fx.home, 'proj'));
    assert.strictEqual(wrap(fx, ['here', '--trigger', 'manual']).code, 0);
    assert.strictEqual(wrap(fx, ['there', '--trigger', 'manual']).code, 0);
    const cwds = ofKind(log(fx), 'step-start').map((r) => r.cwd);
    assert.deepStrictEqual(cwds, [path.dirname(fx.dir), path.join(fx.home, 'proj')]);
  }));

  tally(await test('a cwd that does not exist fails the step, not the wrapper', () => {
    const fx = setup();
    shellJob(fx, 'nowhere', 'true', ['cwd: ~/missing']);
    assert.strictEqual(wrap(fx, ['nowhere', '--trigger', 'manual']).code, 1);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'failed');
    assert.match(se.why, /cwd/);
  }));

  tally(await test('foreach: pinned over 3 pins (one listed:false) → 3 step-starts with the pins\' cwds, the unlisted one skipped "pin unlisted"', () => {
    const fx = setup();
    const [a, b, c] = ['a', 'b', 'c'].map((n) => repo(fx, n));
    writePins(fx, [
      { dirName: '-r-a', name: 'a', path: a, listed: true },
      { dirName: '-r-b', name: 'b', path: b, listed: false },
      { dirName: '-r-c', name: 'c', path: c, listed: true },
    ]);
    shellJob(fx, 'fan', 'pwd', ['foreach: pinned']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 0);
    const recs = log(fx);
    assert.strictEqual(recs[0].steps, 3);
    const ss = ofKind(recs, 'step-start');
    assert.deepStrictEqual(ss.map((r) => [r.step, r.repo, r.cwd]), [[0, 'a', a], [1, 'b', b], [2, 'c', c]]);
    const se = ofKind(recs, 'step-end');
    assert.deepStrictEqual(se.map((r) => r.outcome), ['ok', 'skipped', 'ok']);
    assert.strictEqual(se[1].why, 'pin unlisted');
    assert.ok(se[0].tail.endsWith(path.basename(a)));
    const end = ofKind(recs, 'end')[0];
    assert.deepStrictEqual([end.ok, end.failed, end.skipped], [2, 0, 1]);
  }));

  tally(await test('a pin whose path is null is skipped "pin unlisted"', () => {
    const fx = setup();
    writePins(fx, [{ dirName: '-r-a', name: 'a', path: null, listed: true }]);
    shellJob(fx, 'fan', 'true', ['foreach: [a]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 0);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'skipped');
    assert.strictEqual(se.why, 'pin unlisted');
  }));

  tally(await test('foreach: [a] with no pins.json → start then end.error "no pins snapshot", no steps; exit 1', () => {
    const fx = setup();
    shellJob(fx, 'fan', 'true', ['foreach: [a]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 1);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'end']);
    assert.strictEqual(recs[0].steps, 0);
    assert.strictEqual(recs[1].error, 'no pins snapshot');
  }));

  tally(await test('--only b on a 3-pin job → one step, b', () => {
    const fx = setup();
    writePins(fx, ['a', 'b', 'c'].map((n) => ({ dirName: `-r-${n}`, name: n, path: repo(fx, n), listed: true })));
    shellJob(fx, 'fan', 'true', ['foreach: pinned']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual', '--only', 'b']).code, 0);
    const recs = log(fx);
    assert.strictEqual(recs[0].steps, 1);
    assert.deepStrictEqual(ofKind(recs, 'step-start').map((r) => r.repo), ['b']);
  }));

  tally(await test('--only takes several names, and a repeated --only adds to them', () => {
    const fx = setup();
    writePins(fx, ['a', 'b', 'c'].map((n) => ({ dirName: `-r-${n}`, name: n, path: repo(fx, n), listed: true })));
    shellJob(fx, 'fan', 'true', ['foreach: [a, b, c]']);
    assert.strictEqual(wrap(fx, ['fan', '--only', 'a', 'c', '--trigger', 'manual']).code, 0);
    assert.strictEqual(wrap(fx, ['fan', '--only', 'b', '--only', 'c', '--trigger', 'manual']).code, 0);
    assert.deepStrictEqual(ofKind(log(fx), 'step-start').map((r) => r.repo), ['a', 'c', 'b', 'c']);
  }));

  tally(await test('two listed pins named lookout, foreach: [lookout] → start then end.error "ambiguous pin lookout", no steps; exit 1', () => {
    const fx = setup();
    writePins(fx, [
      { dirName: '-Users-me-a-lookout', name: 'lookout', path: repo(fx, 'a/lookout'), listed: true },
      { dirName: '-Users-me-b-lookout', name: 'lookout', path: repo(fx, 'b/lookout'), listed: true },
    ]);
    shellJob(fx, 'fan', 'true', ['foreach: [lookout]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 1);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'end']);
    assert.strictEqual(recs[1].error, 'ambiguous pin lookout');
  }));

  tally(await test('mirror: the same two pins, foreach naming one dirName → one step in that pin\'s path', () => {
    const fx = setup();
    const b = repo(fx, 'b/lookout');
    writePins(fx, [
      { dirName: '-Users-me-a-lookout', name: 'lookout', path: repo(fx, 'a/lookout'), listed: true },
      { dirName: '-Users-me-b-lookout', name: 'lookout', path: b, listed: true },
    ]);
    shellJob(fx, 'fan', 'true', ['foreach: [-Users-me-b-lookout]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 0);
    assert.deepStrictEqual(ofKind(log(fx), 'step-start').map((r) => [r.repo, r.cwd]), [['lookout', b]]);
    assert.deepStrictEqual(ofKind(log(fx), 'step-end').map((r) => r.outcome), ['ok']);
  }));

  tally(await test('a second, unlisted pin of the same name does not make it ambiguous', () => {
    const fx = setup();
    const a = repo(fx, 'a/lookout');
    writePins(fx, [
      { dirName: '-Users-me-a-lookout', name: 'lookout', path: a, listed: true },
      { dirName: '-Users-me-b-lookout', name: 'lookout', path: repo(fx, 'b/lookout'), listed: false },
    ]);
    shellJob(fx, 'fan', 'true', ['foreach: [lookout]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 0);
    assert.deepStrictEqual(ofKind(log(fx), 'step-start').map((r) => r.cwd), [a]);
    assert.deepStrictEqual(ofKind(log(fx), 'step-end').map((r) => r.outcome), ['ok']);
  }));

  tally(await test('foreach: [ghost] with no such pin → step-start for it, then step-end skipped "not pinned"; exit 0', () => {
    const fx = setup();
    writePins(fx, [{ dirName: '-r-a', name: 'a', path: repo(fx, 'a'), listed: true }]);
    shellJob(fx, 'fan', 'true', ['foreach: [ghost]']);
    assert.strictEqual(wrap(fx, ['fan', '--trigger', 'manual']).code, 0);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'step-start', 'step-end', 'end']);
    assert.strictEqual(recs[1].repo, 'ghost');
    assert.strictEqual(recs[1].cwd, null);
    assert.strictEqual(recs[2].outcome, 'skipped');
    assert.strictEqual(recs[2].why, 'not pinned');
    assert.strictEqual(recs[3].skipped, 1);
  }));

  tally(await test('a held lock with a live pid running `run-schedule.mjs <job>` → refused why running heldBy, exit 75, log otherwise unchanged', async () => {
    const fx = setup();
    shellJob(fx, 'held', 'echo ran');
    const kid = fakeWrapper('held');
    kids.push(kid);
    await waitFor(() => spawnSync('ps', ['-o', 'command=', '-p', String(kid.pid)], { encoding: 'utf8' }).stdout.includes('run-schedule.mjs'));
    writeLock(fx, 'held', { pid: kid.pid, bootId: bootId(), job: 'held' });
    const r = wrap(fx, ['held', '--trigger', 'schedule']);
    assert.strictEqual(r.code, 75);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['refused']);
    assert.deepStrictEqual([recs[0].why, recs[0].heldBy, recs[0].job, recs[0].trigger], ['running', kid.pid, 'held', 'schedule']);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.state, 'locks', 'held.lock'), 'utf8')).pid, kid.pid, 'lock left alone');
    kid.kill('SIGKILL');
  }));

  tally(await test('token match: a live `run-schedule.mjs git-sync-all` does not hold the git-sync lock — taken over', async () => {
    const fx = setup();
    shellJob(fx, 'git-sync', 'echo ran');
    const kid = fakeWrapper('git-sync-all');
    kids.push(kid);
    await waitFor(() => spawnSync('ps', ['-o', 'command=', '-p', String(kid.pid)], { encoding: 'utf8' }).stdout.includes('run-schedule.mjs'));
    writeLock(fx, 'git-sync', { pid: kid.pid, bootId: bootId(), job: 'git-sync' });
    assert.strictEqual(wrap(fx, ['git-sync', '--trigger', 'manual']).code, 0);
    assert.deepStrictEqual(kinds(log(fx)), ['start', 'step-start', 'step-end', 'end']);
    kid.kill('SIGKILL');
  }));

  tally(await test('a lock with a dead pid, a live non-wrapper pid, or another boot id is stale and taken over', async () => {
    const fx = setup();
    shellJob(fx, 'stale', 'true');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeLock(fx, 'stale', { pid: Number(dead), bootId: bootId(), job: 'stale' });
    assert.strictEqual(wrap(fx, ['stale', '--trigger', 'manual']).code, 0);
    writeLock(fx, 'stale', { pid: process.pid, bootId: bootId(), job: 'stale' });
    assert.strictEqual(wrap(fx, ['stale', '--trigger', 'manual']).code, 0);
    const kid = fakeWrapper('stale');
    kids.push(kid);
    await waitFor(() => spawnSync('ps', ['-o', 'command=', '-p', String(kid.pid)], { encoding: 'utf8' }).stdout.includes('run-schedule.mjs'));
    writeLock(fx, 'stale', { pid: kid.pid, bootId: 'another-boot', job: 'stale' });
    assert.strictEqual(wrap(fx, ['stale', '--trigger', 'manual']).code, 0);
    kid.kill('SIGKILL');
    assert.strictEqual(ofKind(log(fx), 'end').length, 3);
    assert.strictEqual(ofKind(log(fx), 'refused').length, 0);
    assert.ok(!fs.existsSync(path.join(fx.state, 'locks', 'stale.lock')));
  }));

  tally(await test('the lock holds { pid, bootId, job } while the step runs', async () => {
    const fx = setup();
    shellJob(fx, 'peek', 'cat "$HOME/.claude/schedules/locks/peek.lock"');
    assert.strictEqual(wrap(fx, ['peek', '--trigger', 'manual']).code, 0);
    const recs = log(fx);
    const lock = JSON.parse(ofKind(recs, 'step-end')[0].tail);
    assert.deepStrictEqual(lock, { pid: recs[0].pid, bootId: bootId(), job: 'peek' });
  }));

  // The refusal matrix: each a `refused` record, no `start`, exit 0.
  const refusals: Array<[string, 'schedule' | 'manual', (fx: Fx) => void, string | RegExp]> = [
    ['file deleted', 'schedule', () => {}, 'file gone'],
    ['invalid file', 'schedule', (fx) => writeJob(fx, 'job', ['cron: "0 22 * * *"', 'machines: [mac]', 'run: bogus'], 'x'), 'invalid: 4: run must be shell or claude'],
    ['disabled', 'schedule', (fx) => shellJob(fx, 'job', 'true', ['enabled: false']), 'disabled'],
    ['machines: [wsl] on mac', 'schedule', (fx) => writeJob(fx, 'job', ['cron: "0 22 * * *"', 'machines: [wsl]', 'run: shell'], '```bash\ntrue\n```'), 'not this machine'],
    ['file deleted', 'manual', () => {}, 'file gone'],
    ['invalid file', 'manual', (fx) => writeJob(fx, 'job', ['cron: "0 22 * * *"', 'machines: [mac]', 'run: bogus'], 'x'), 'invalid: 4: run must be shell or claude'],
    ['machines: [wsl] on mac', 'manual', (fx) => writeJob(fx, 'job', ['cron: "0 22 * * *"', 'machines: [wsl]', 'run: shell'], '```bash\ntrue\n```'), 'not this machine'],
  ];
  for (const [what, trigger, make, why] of refusals) {
    tally(await test(`${trigger} + ${what} → refused why "${why}", no start, exit 0`, () => {
      const fx = setup();
      make(fx);
      const r = wrap(fx, ['job', '--trigger', trigger]);
      assert.strictEqual(r.code, 0, r.stderr);
      const recs = log(fx);
      assert.deepStrictEqual(kinds(recs), ['refused']);
      assert.strictEqual(recs[0].job, 'job');
      assert.strictEqual(recs[0].trigger, trigger);
      assert.strictEqual(recs[0].why, why);
      assert.ok(!('heldBy' in recs[0]));
    }));
  }

  tally(await test('no --trigger means schedule (launchd passes only the job name): a disabled file is refused', () => {
    const fx = setup();
    shellJob(fx, 'job', 'true', ['enabled: false']);
    assert.strictEqual(wrap(fx, ['job']).code, 0);
    assert.deepStrictEqual(log(fx).map((r) => [r.kind, r.trigger, r.why]), [['refused', 'schedule', 'disabled']]);
  }));

  tally(await test('manual + disabled → runs (Run now on a paused job)', () => {
    const fx = setup();
    shellJob(fx, 'job', 'echo paused-but-ran', ['enabled: false']);
    assert.strictEqual(wrap(fx, ['job', '--trigger', 'manual']).code, 0);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'step-start', 'step-end', 'end']);
    assert.ok(recs[2].tail.endsWith('paused-but-ran'));
  }));

  tally(await test('claude job: argv, session id, env marker and stdin as specified; step-end carries the result\'s numbers', () => {
    const fx = setup();
    claudeJob(fx, 'think', ['permission-mode: acceptEdits', 'max-turns: 60']);
    const r = wrap(fx, ['think', '--trigger', 'manual']);
    assert.strictEqual(r.code, 0, r.stderr);
    const argv = argvOf(fx);
    assert.ok(argv.includes('-p'), argv.join(' '));
    assert.strictEqual(after(argv, '--output-format'), 'json');
    const session = after(argv, '--session-id')!;
    assert.match(session, UUID_RE);
    assert.strictEqual(after(argv, '--permission-mode'), 'acceptEdits');
    assert.strictEqual(after(argv, '--disallowed-tools'), 'AskUserQuestion');
    assert.strictEqual(after(argv, '--max-turns'), '60');
    assert.ok(!argv.includes('--model') && !argv.includes('--effort') && !argv.includes('--allowed-tools'), 'absent keys are not passed');
    const env = fs.readFileSync(path.join(fx.rec, 'env'), 'utf8').split('\n');
    assert.ok(env.includes('CLAUDE_DASHBOARD_SCHEDULE=think'));
    assert.strictEqual(fs.readFileSync(path.join(fx.rec, 'stdin'), 'utf8'), 'Do the thing.\nThen stop.');
    const recs = log(fx);
    const ss = ofKind(recs, 'step-start')[0];
    assert.strictEqual(ss.session, session);
    const se = ofKind(recs, 'step-end')[0];
    assert.strictEqual(se.outcome, 'ok');
    assert.strictEqual(se.exit, 0);
    assert.deepStrictEqual([se.cost, se.tokensIn, se.tokensOut, se.turns, se.model], [0.25, 150, 50, 4, 'claude-opus-4-5']);
  }));

  tally(await test('claude job: model, effort and allowed-tools pass through', () => {
    const fx = setup();
    claudeJob(fx, 'think', ['model: opus', 'effort: medium', 'allowed-tools: [Bash, Read]']);
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual']).code, 0);
    const argv = argvOf(fx);
    assert.strictEqual(after(argv, '--model'), 'opus');
    assert.strictEqual(after(argv, '--effort'), 'medium');
    assert.strictEqual(after(argv, '--allowed-tools'), 'Bash,Read');
  }));

  tally(await test('no permission-mode + SYNC_PERMISSION_MODE=acceptEdits → --permission-mode acceptEdits', () => {
    const fx = setup();
    claudeJob(fx, 'think');
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual'], { SYNC_PERMISSION_MODE: 'acceptEdits' }).code, 0);
    assert.strictEqual(after(argvOf(fx), '--permission-mode'), 'acceptEdits');
  }));

  tally(await test('permission-mode: auto + SPAWN_MAX_PERMISSION=plan → --permission-mode plan (clamped)', () => {
    const fx = setup();
    claudeJob(fx, 'think', ['permission-mode: auto']);
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual'], { SPAWN_MAX_PERMISSION: 'plan' }).code, 0);
    assert.strictEqual(after(argvOf(fx), '--permission-mode'), 'plan');
  }));

  tally(await test('a baked SYNC_PERMISSION_MODE=bypassPermissions is never passed — clamped to auto at most', () => {
    const fx = setup();
    claudeJob(fx, 'think');
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual'], { SYNC_PERMISSION_MODE: 'bypassPermissions', SPAWN_MAX_PERMISSION: 'bypassPermissions' }).code, 0);
    assert.strictEqual(after(argvOf(fx), '--permission-mode'), 'auto');
  }));

  tally(await test('fake result is_error: true → outcome failed, why from the result; exit 1', () => {
    const fx = setup();
    claudeJob(fx, 'think');
    const bad = JSON.stringify({ ...JSON.parse(OK_RESULT), is_error: true, subtype: 'error_max_turns', result: 'ran out of turns' });
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual'], { FAKE_RESULT: bad }).code, 1);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'failed');
    assert.strictEqual(se.why, 'ran out of turns');
    assert.strictEqual(ofKind(log(fx), 'end')[0].failed, 1);
  }));

  tally(await test('a CLI that prints no JSON fails the step with its stderr as why', () => {
    const fx = setup();
    claudeJob(fx, 'think', ['model: nope']);
    fs.writeFileSync(fx.claude, '#!/bin/bash\necho "error: unknown model nope" >&2\nexit 1\n', { mode: 0o755 });
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual']).code, 1);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'failed');
    assert.strictEqual(se.why, 'error: unknown model nope');
  }));

  tally(await test('permission-mode: bypassPermissions → refused why "invalid: <line>: …", no start, nothing launched', () => {
    const fx = setup();
    claudeJob(fx, 'think', ['permission-mode: bypassPermissions']);
    for (const trigger of ['schedule', 'manual']) assert.strictEqual(wrap(fx, ['think', '--trigger', trigger]).code, 0);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['refused', 'refused']);
    for (const rec of recs) assert.strictEqual(rec.why, 'invalid: 5: permission-mode must be plan, acceptEdits or auto');
    assert.ok(!fs.existsSync(path.join(fx.rec, 'argv')), 'claude never launched');
  }));

  tally(await test('CLAUDE_BIN unset + claude job → start then end.error "claude cli not configured"; exit 1', () => {
    const fx = setup();
    claudeJob(fx, 'think');
    assert.strictEqual(wrap(fx, ['think', '--trigger', 'manual'], { CLAUDE_BIN: undefined }).code, 1);
    const recs = log(fx);
    assert.deepStrictEqual(kinds(recs), ['start', 'end']);
    assert.strictEqual(recs[1].error, 'claude cli not configured');
    assert.ok(!fs.existsSync(path.join(fx.rec, 'argv')));
  }));

  tally(await test('timeout: 1s on `sleep 30` → outcome timeout, the step\'s whole process group gone', async () => {
    const fx = setup();
    shellJob(fx, 'slow', 'sleep 30 &\necho $! > "$FAKE_REC/sleep.pid"\nwait', ['timeout: 1s']);
    const t0 = Date.now();
    assert.strictEqual(wrap(fx, ['slow', '--trigger', 'manual']).code, 1);
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
    const se = ofKind(log(fx), 'step-end')[0];
    assert.strictEqual(se.outcome, 'timeout');
    assert.ok(await gone(readPid(path.join(fx.rec, 'sleep.pid'))), 'sleep still alive');
    assert.strictEqual(ofKind(log(fx), 'end')[0].failed, 1);
  }));

  tally(await test('SIGTERM mid-step → step-end stopped, end.stopped true, exit 143, child gone; a second wrapper meanwhile gets 75', async () => {
    const fx = setup();
    shellJob(fx, 'long', 'sleep 10 &\necho $! > "$FAKE_REC/sleep.pid"\nwait');
    const kid = spawn(process.execPath, [WRAPPER, 'long', '--trigger', 'manual'], { env: envFor(fx), stdio: 'ignore' });
    kids.push(kid);
    const exited = new Promise<number | null>((r) => kid.on('exit', (code) => r(code)));
    const pidFile = path.join(fx.rec, 'sleep.pid');
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const second = wrap(fx, ['long', '--trigger', 'manual']);
    assert.strictEqual(second.code, 75);
    assert.strictEqual(ofKind(log(fx), 'refused')[0].heldBy, kid.pid);
    kid.kill('SIGTERM');
    assert.strictEqual(await exited, 143);
    const recs = log(fx).filter((r) => r.kind !== 'refused');
    assert.deepStrictEqual(kinds(recs), ['start', 'step-start', 'step-end', 'end']);
    assert.strictEqual(recs[2].outcome, 'stopped');
    assert.strictEqual(recs[3].stopped, true);
    assert.strictEqual(recs[3].failed, 1);
    assert.ok(await gone(readPid(pidFile)), 'sleep still alive');
    assert.ok(!fs.existsSync(path.join(fx.state, 'locks', 'long.lock')), 'lock released');
  }));

  tally(await test('--trigger schedule 20 min after the slot → start.late true, start.slot the slot\'s ISO', () => {
    const fx = setup();
    const slot = new Date(Date.now() - 20 * 60_000);
    slot.setSeconds(0, 0);
    writeJob(fx, 'late', [`cron: "${slot.getMinutes()} ${slot.getHours()} * * *"`, 'machines: [mac]', 'run: shell'], '```bash\ntrue\n```');
    assert.strictEqual(wrap(fx, ['late', '--trigger', 'schedule']).code, 0);
    const start = log(fx)[0];
    assert.strictEqual(start.trigger, 'schedule');
    assert.strictEqual(start.slot, slot.toISOString());
    assert.strictEqual(start.late, true);
  }));

  tally(await test('mirror: --trigger schedule on time → slot set, late false', () => {
    const fx = setup();
    writeJob(fx, 'prompt', ['cron: "* * * * *"', 'machines: [mac]', 'run: shell'], '```bash\ntrue\n```');
    assert.strictEqual(wrap(fx, ['prompt', '--trigger', 'schedule']).code, 0);
    const start = log(fx)[0];
    assert.ok(!Number.isNaN(Date.parse(start.slot)));
    assert.strictEqual(start.late, false);
  }));

  tally(await test('machine: detected when SCHEDULE_MACHINE is unset or not mac|wsl; SCHEDULES_DIR defaults to ~/claude-global/schedules', () => {
    const fx = setup();
    const detected = process.platform === 'darwin' ? 'mac' : 'wsl';
    writeJob(fx, 'both', ['cron: "0 22 * * *"', 'machines: [mac, wsl]', 'run: shell'], '```bash\ntrue\n```');
    assert.strictEqual(wrap(fx, ['both', '--trigger', 'manual'], { SCHEDULE_MACHINE: undefined, SCHEDULES_DIR: undefined }).code, 0);
    assert.strictEqual(wrap(fx, ['both', '--trigger', 'manual'], { SCHEDULE_MACHINE: 'linux' }).code, 0);
    const recs = log(fx, detected);
    assert.deepStrictEqual(ofKind(recs, 'start').map((r) => r.machine), [detected, detected]);
  }));

  tally(await test('SCHEDULE_MACHINE=wsl writes runs/wsl.jsonl and refuses a mac-only file there', () => {
    const fx = setup();
    shellJob(fx, 'maconly', 'true');
    assert.strictEqual(wrap(fx, ['maconly', '--trigger', 'manual'], { SCHEDULE_MACHINE: 'wsl' }).code, 0);
    assert.deepStrictEqual(log(fx, 'wsl').map((r) => r.why), ['not this machine']);
    assert.deepStrictEqual(log(fx, 'mac'), []);
  }));

  tally(await test('a job name outside [a-z0-9-]+ is a usage error: exit 64, nothing logged, no path touched', () => {
    const fx = setup();
    for (const bad of ['../evil', 'Upper', '']) {
      assert.strictEqual(wrap(fx, [bad]).code, 64);
    }
    assert.strictEqual(wrap(fx, []).code, 64);
    assert.strictEqual(wrap(fx, ['ok', '--trigger', 'sometimes']).code, 64);
    assert.ok(!fs.existsSync(path.join(fx.state, 'runs')));
  }));

  for (const kid of kids) if (kid.exitCode === null && kid.signalCode === null) kid.kill('SIGKILL');
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
