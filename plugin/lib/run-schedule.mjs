#!/usr/bin/env node
/**
 * run-schedule.mjs — the one process that runs scheduled jobs: launchd, cron and the dashboard's Run now all launch it, and it writes the run log
 * (`~/.claude/schedules/runs/<machine>.jsonl`) the server folds. Plain Node, built-ins only, nothing from `server/` (the plugin installs it alone).
 * Spec: docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md §The wrapper, §The run log.
 *
 *   run-schedule <job> [--trigger schedule|manual] [--only <pin>...]
 *
 * Exit 0 every step ok (or a refusal), 1 a step failed or the run failed before its first step, 75 the job's lock is held by a live wrapper,
 * 143 SIGTERM (130 SIGINT, 129 SIGHUP, handled the same way), 64 a usage error. The environment is exactly what reconcile bakes: PATH, HOME,
 * CLAUDE_BIN, SPAWN_MAX_PERMISSION, SYNC_PERMISSION_MODE, SCHEDULE_MACHINE, SCHEDULES_DIR. `RUN_SCHEDULE_GRACE_MS` (not baked) is a test seam for the
 * 10 s TERM→KILL grace.
 *
 * An error thrown mid-run (a full disk under `append`) exits 1 without an `end` record; the server's fold reads that run as lost, which is the truth.
 *
 * Boot id (lock files, and the server's owner.json — keep both readers on this one form): mac = the `sec` of `sysctl -n kern.boottime`,
 * wsl = `/proc/sys/kernel/random/boot_id` trimmed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { lastBefore, parseCron } from './cron.mjs';
import { parseJob } from './schedule-file.mjs';

const NAME_RE = /^[a-z0-9-]+$/;
const EXIT_USAGE = 64;
const EXIT_RUNNING = 75;
const SIGNAL_EXITS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 };
const TAIL_LINES = 20;
const TAIL_MAX_CHARS = 8192;
const WHY_MAX_CHARS = 300;
const KILL_GRACE_MS = Number(process.env.RUN_SCHEDULE_GRACE_MS) > 0 ? Number(process.env.RUN_SCHEDULE_GRACE_MS) : 10_000;
// setTimeout clamps anything above 2^31-1 ms to 1 ms; a timeout that long is "never" in practice.
const MAX_TIMER_MS = 2 ** 31 - 1;
const GROUP_POLL_MS = 50;
const LATE_MS = 10 * 60_000;
// spawn.ts PERMISSION_MODES minus bypassPermissions, which a schedule never runs under whatever the file or the baked env says.
const PERMISSION_MODES = ['plan', 'acceptEdits', 'auto'];

function usage(msg) {
  process.stderr.write(`run-schedule: ${msg}\nusage: run-schedule <job> [--trigger schedule|manual] [--only <pin>...]\n`);
  process.exit(EXIT_USAGE);
}

function parseArgs(argv) {
  const [job, ...rest] = argv;
  if (job === undefined || !NAME_RE.test(job)) usage(`job name must match [a-z0-9-]+`);
  // launchd's ProgramArguments carry the job name only, so no flag means the OS fired it.
  let trigger = 'schedule';
  let only = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--trigger') {
      trigger = rest[++i];
      if (trigger !== 'schedule' && trigger !== 'manual') usage('--trigger takes schedule or manual');
    } else if (rest[i] === '--only') {
      only ??= [];
      const before = only.length;
      while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) only.push(rest[++i]);
      if (only.length === before) usage('--only takes at least one pin name');
    } else usage(`unknown argument ${rest[i]}`);
  }
  return { job, trigger, only };
}

function resolveMachine() {
  const v = process.env.SCHEDULE_MACHINE;
  if (v === 'mac' || v === 'wsl') return v;
  if (os.type() === 'Darwin') return 'mac';
  // Same as ~/claude-global/bootstrap.sh: /proc/version naming microsoft is wsl, and so is anything else.
  return 'wsl';
}

function bootId() {
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

const home = () => process.env.HOME || os.homedir();
const expandHome = (p) => (p === '~' ? home() : p.startsWith('~/') ? path.join(home(), p.slice(2)) : p);

/** True when `pid` is alive and its command line has a `run-schedule.mjs` element followed by exactly `job` (`git-sync` never matches `git-sync-all`). */
function isWrapperFor(pid, job) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  let cmd;
  try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return false; }
  // Whitespace split: an install path with a space in it would read as stale. ~/.claude/plugins/… has none.
  const tokens = cmd.trim().split(/\s+/);
  return tokens.some((t, i) => path.basename(t) === 'run-schedule.mjs' && tokens[i + 1] === job);
}

function clampPermission(requested, ceiling) {
  const idx = (v) => { const i = PERMISSION_MODES.indexOf(v); return i === -1 ? PERMISSION_MODES.indexOf('auto') : i; };
  return PERMISSION_MODES[Math.min(idx(requested), idx(ceiling))];
}

const lines = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
const firstLine = (s) => lines(s)[0] ?? '';
// A CLI's error is its last stderr line; anything above it is usually a banner or a stack.
const lastLine = (s) => lines(s).pop() ?? '';
const short = (s) => (s.length > WHY_MAX_CHARS ? s.slice(0, WHY_MAX_CHARS - 1) + '…' : s);

function tailOf(text) {
  const lines = text.replace(/\n+$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_MAX_CHARS ? lines.slice(-TAIL_MAX_CHARS) : lines;
}

class Wrapper {
  constructor(args) {
    Object.assign(this, args);
    this.machine = resolveMachine();
    this.dir = process.env.SCHEDULES_DIR ? expandHome(process.env.SCHEDULES_DIR) : path.join(home(), 'claude-global', 'schedules');
    this.state = path.join(home(), '.claude', 'schedules');
    this.logPath = path.join(this.state, 'runs', `${this.machine}.jsonl`);
    this.lockPath = path.join(this.state, 'locks', `${this.job}.lock`);
    this.bootId = bootId();
    this.stopping = false;
    this.child = null;
  }

  append(rec) {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    // One write per record with O_APPEND, so a concurrent reader sees whole lines or a torn last one, never interleaving.
    fs.appendFileSync(this.logPath, JSON.stringify(rec) + '\n');
  }

  refuse(why, extra = {}) {
    this.append({ kind: 'refused', job: this.job, at: new Date().toISOString(), trigger: this.trigger, why, ...extra });
  }

  /** The job, or a refusal reason when the OS job outlived its file (see spec step 1). */
  load() {
    let text;
    try { text = fs.readFileSync(path.join(this.dir, `${this.job}.md`), 'utf8'); } catch (e) {
      return { why: e.code === 'ENOENT' ? 'file gone' : `invalid: 0: ${e.code ?? 'unreadable'}` };
    }
    const { job, errors } = parseJob(this.job, text);
    if (!job) return { why: `invalid: ${errors[0].line}: ${errors[0].message}` };
    if (!job.machines.includes(this.machine)) return { why: 'not this machine' };
    if (!job.enabled && this.trigger === 'schedule') return { why: 'disabled' };
    return { job };
  }

  /** The pid in lock text `text` when it is a live wrapper for this job from this boot, else null (stale). */
  liveHolder(text) {
    let held = null;
    try { held = JSON.parse(text); } catch { /* torn or unreadable: stale */ }
    const pid = Number(held?.pid);
    const sameBoot = held?.bootId == null || this.bootId == null || held.bootId === this.bootId;
    return Number.isInteger(pid) && pid > 0 && sameBoot && isWrapperFor(pid, this.job) ? pid : null;
  }

  /**
   * Take the lock, or return the live holder's pid. Anything but a live wrapper for this job from this boot is stale. The lock appears by `link` of a
   * complete temp file, so no reader ever sees it empty; a stale one is renamed aside and checked, since another wrapper may have replaced it between
   * the read and the rename.
   */
  lock() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const tmp = `${this.lockPath}.${process.pid}.tmp`;
    const aside = `${this.lockPath}.${process.pid}.stale`;
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, bootId: this.bootId, job: this.job }));
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { fs.linkSync(tmp, this.lockPath); return null; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        let text;
        try { text = fs.readFileSync(this.lockPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const holder = this.liveHolder(text);
        if (holder !== null) return holder;
        try { fs.renameSync(this.lockPath, aside); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (fs.readFileSync(aside, 'utf8') !== text) {
          try { fs.linkSync(aside, this.lockPath); } catch { /* a third wrapper holds it now; the next attempt reads theirs */ }
        }
        fs.unlinkSync(aside);
      }
      // Lost the takeover race every time: whoever holds it now is live.
      try { return Number(JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).pid) || 0; } catch { return 0; }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
  }

  unlock() {
    try {
      if (JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).pid === process.pid) fs.unlinkSync(this.lockPath);
    } catch { /* already gone */ }
  }

  /** Steps for the run, or `{ error }` when it cannot start (spec §The run log, `end.error`). */
  plan(job) {
    if (job.run === 'claude' && !process.env.CLAUDE_BIN) return { error: 'claude cli not configured' };
    if (job.foreach === null) {
      const cwd = job.cwd ? expandHome(job.cwd) : path.dirname(this.dir);
      return { steps: [{ repo: null, cwd }] };
    }
    let pins;
    try {
      pins = JSON.parse(fs.readFileSync(path.join(this.state, 'pins.json'), 'utf8'));
      if (!Array.isArray(pins)) throw new Error('not a list');
    } catch {
      return { error: 'no pins snapshot' };
    }
    const usable = (p) => p.listed && typeof p.path === 'string' && p.path !== '';
    const candidates = job.foreach === 'pinned'
      ? pins.map((pin) => ({ entry: pin.name, pin, skip: usable(pin) ? null : 'pin unlisted' }))
      : job.foreach.map((entry) => this.resolve(entry, pins, usable));
    const wanted = this.only === null ? candidates : candidates.filter((c) => [c.entry, c.pin?.name, c.pin?.dirName].some((v) => v != null && this.only.includes(v)));
    const ambiguous = wanted.find((c) => c.ambiguous);
    if (ambiguous) return { error: `ambiguous pin ${ambiguous.entry}` };
    return { steps: wanted.map((c) => ({ repo: c.pin?.name ?? c.entry, cwd: c.pin?.path ?? null, skip: c.skip })) };
  }

  /**
   * One `foreach:` entry against the pins: listed by name, then by dirName; an unlisted match is skipped, no match is not pinned. Ambiguity counts
   * listed pins whatever their path, as `checkPins` does, so the wrapper never runs a file the server's validation calls ambiguous.
   */
  resolve(entry, pins, usable) {
    const listed = pins.filter((p) => p.listed);
    const byName = listed.filter((p) => p.name === entry);
    const byDir = listed.filter((p) => p.dirName === entry);
    const pick = byName.length === 1 ? byName[0] : byDir[0];
    if (pick) return { entry, pin: pick, skip: usable(pick) ? null : 'pin unlisted' };
    if (byName.length > 1) return { entry, ambiguous: true };
    const hidden = pins.find((p) => p.name === entry || p.dirName === entry);
    if (hidden) return { entry, pin: hidden, skip: 'pin unlisted' };
    return { entry, pin: null, skip: 'not pinned' };
  }

  async run() {
    const loaded = this.load();
    if (loaded.why) { this.refuse(loaded.why); return 0; }
    const { job } = loaded;
    const holder = this.lock();
    if (holder !== null) { this.refuse('running', { heldBy: holder }); return EXIT_RUNNING; }
    try {
      return await this.runLocked(job);
    } finally {
      this.unlock();
    }
  }

  async runLocked(job) {
    const runId = randomUUID();
    const t0 = Date.now();
    const planned = this.plan(job);
    const steps = planned.steps ?? [];
    const start = { kind: 'start', run: runId, job: this.job, machine: this.machine, trigger: this.trigger, at: new Date(t0).toISOString() };
    let late = false;
    if (this.trigger === 'schedule') {
      const parsed = parseCron(job.cron);
      // The fire may land anywhere inside its slot minute, so the slot is the last one strictly before the next minute.
      const slot = parsed.ok ? lastBefore(parsed.cron, new Date(t0 + 60_000)) : null;
      if (slot) { start.slot = slot.toISOString(); late = t0 - slot.getTime() > LATE_MS; }
    }
    Object.assign(start, { late, steps: steps.length, pid: process.pid });
    this.append(start);
    const counts = { ok: 0, failed: 0, skipped: 0 };
    const finish = (extra) => {
      const at = Date.now();
      this.append({ kind: 'end', run: runId, at: new Date(at).toISOString(), ms: at - t0, ...counts, stopped: this.stopping, ...extra });
    };
    if (planned.error) { finish({ error: planned.error }); return 1; }
    for (let i = 0; i < steps.length && !this.stopping; i++) {
      const step = steps[i];
      const session = job.run === 'claude' && !step.skip ? randomUUID() : undefined;
      const s0 = Date.now();
      this.append({ kind: 'step-start', run: runId, step: i, repo: step.repo, cwd: step.cwd, at: new Date(s0).toISOString(), ...(session ? { session } : {}) });
      const result = step.skip ? { exit: null, outcome: 'skipped', why: step.skip } : await this.launch(job, step.cwd, session);
      const at = Date.now();
      this.append({ kind: 'step-end', run: runId, step: i, at: new Date(at).toISOString(), ms: at - s0, ...result });
      if (result.outcome === 'ok') counts.ok++;
      else if (result.outcome === 'skipped') counts.skipped++;
      else counts.failed++;
    }
    finish({});
    if (this.stopping) return this.stopExit;
    return counts.failed > 0 ? 1 : 0;
  }

  async launch(job, cwd, session) {
    if (!fs.existsSync(cwd)) return { exit: null, outcome: 'failed', why: short(`no such cwd ${cwd}`) };
    const env = { ...process.env, CLAUDE_DASHBOARD_SCHEDULE: this.job };
    if (job.run === 'shell') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-schedule-'));
      const file = path.join(tmp, `${this.job}.sh`);
      fs.writeFileSync(file, job.script + '\n', { mode: 0o600 });
      try {
        const r = await this.spawnStep('bash', ['-e', file], { cwd, env }, null, job.timeoutMs, true);
        const tail = tailOf(r.combined);
        if (r.outcome) return { exit: r.code, outcome: r.outcome, why: r.outcome, tail };
        if (r.code === 0) return { exit: 0, outcome: 'ok', tail };
        return { exit: r.code, outcome: 'failed', why: r.code === null ? `signal ${r.signal}` : `exit ${r.code}`, tail };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const args = ['-p', '--output-format', 'json', '--session-id', session];
    if (job.model) args.push('--model', job.model);
    if (job.effort) args.push('--effort', job.effort);
    args.push('--permission-mode', clampPermission(job.permissionMode ?? process.env.SYNC_PERMISSION_MODE, process.env.SPAWN_MAX_PERMISSION));
    // Joined into one value: the CLI's variadic flag would otherwise swallow the flags after it.
    if (job.allowedTools && job.allowedTools.length > 0) args.push('--allowed-tools', job.allowedTools.join(','));
    args.push('--disallowed-tools', 'AskUserQuestion');
    if (job.maxTurns) args.push('--max-turns', String(job.maxTurns));
    const r = await this.spawnStep(process.env.CLAUDE_BIN, args, { cwd, env }, job.body, job.timeoutMs, false);
    if (r.outcome) return { exit: r.code, outcome: r.outcome, why: r.outcome };
    let res = null;
    try { res = JSON.parse(r.stdout); } catch { /* not a result: the CLI refused its arguments or crashed */ }
    if (!res || typeof res !== 'object') {
      return { exit: r.code, outcome: 'failed', why: short(lastLine(r.stderr) || lastLine(r.stdout) || (r.code === null ? `signal ${r.signal}` : `exit ${r.code}`)) };
    }
    const u = res.usage ?? {};
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const models = Object.entries(res.modelUsage ?? {}).sort((a, b) => num(b[1]?.costUSD) - num(a[1]?.costUSD));
    const numbers = {
      cost: num(res.total_cost_usd),
      tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
      tokensOut: num(u.output_tokens),
      turns: num(res.num_turns),
      model: models[0]?.[0] ?? job.model ?? null,
    };
    if (res.is_error === false) return { exit: r.code, outcome: 'ok', ...numbers };
    return { exit: r.code, outcome: 'failed', why: short(firstLine(res.result) || String(res.subtype ?? 'is_error')), ...numbers };
  }

  /**
   * Run one step's child in its own process group, so a timeout or a SIGTERM reaches whatever the script backgrounded too. `outcome` is set only
   * when the wrapper ended it: `timeout` or `stopped`. Once it has, the step does not settle until the whole group is gone — a member that traps
   * TERM outlives its leader — or the grace runs out and the group is SIGKILLed; only then may the lock go.
   */
  spawnStep(cmd, args, opts, input, timeoutMs, combine) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '', combined = '';
      let outcome = null;
      let leader = null;
      let settled = false;
      let deadline = 0;
      let killTimer = null;
      const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const keep = (s, chunk) => { const t = s + chunk; return combine && t.length > 1_000_000 ? t.slice(-500_000) : t; };
      child.stdout.on('data', (c) => { const s = c.toString(); stdout = keep(stdout, s); combined = keep(combined, s); });
      child.stderr.on('data', (c) => { const s = c.toString(); stderr = keep(stderr, s); combined = keep(combined, s); });
      child.stdin.on('error', () => { /* the child exited without reading its prompt */ });
      child.stdin.end(input ?? '');
      const groupAlive = () => {
        if (!child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
      };
      const end = (why) => {
        // A step whose leader already exited on its own keeps its result; only the wait for its pipes was left.
        if (outcome || settled || leader || child.exitCode !== null) return;
        outcome = why;
        deadline = Date.now() + KILL_GRACE_MS;
        this.killGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => this.killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      };
      child.endStep = end;
      const timer = setTimeout(() => end('timeout'), Math.min(timeoutMs, MAX_TIMER_MS));
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        this.child = null;
        resolve({ ...leader, stdout, stderr, combined, outcome });
      };
      const settle = (code, signal) => {
        if (leader) return;
        leader = { code, signal };
        if (!outcome) return finish();
        const poll = () => {
          if (!groupAlive()) return finish();
          if (Date.now() >= deadline) { this.killGroup(child, 'SIGKILL'); return finish(); }
          setTimeout(poll, GROUP_POLL_MS);
        };
        poll();
      };
      child.on('error', (e) => { stderr += `${e.message}\n`; combined += `${e.message}\n`; settle(null, null); });
      // 'close' waits for every holder of the pipes; a backgrounded grandchild may hold them long after the child exits.
      child.on('exit', (code, signal) => {
        if (outcome) settle(code, signal);
        else setTimeout(() => settle(code, signal), 1000).unref();
      });
      child.on('close', (code, signal) => settle(code, signal));
    });
  }

  killGroup(child, sig) {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
  }

  stop(signal) {
    if (!this.stopping) this.stopExit = SIGNAL_EXITS[signal];
    this.stopping = true;
    if (this.child) this.child.endStep('stopped');
  }
}

const wrapper = new Wrapper(parseArgs(process.argv.slice(2)));
for (const sig of Object.keys(SIGNAL_EXITS)) process.on(sig, () => wrapper.stop(sig));
wrapper.run().then(
  (code) => process.exit(code),
  (e) => { process.stderr.write(`run-schedule: ${e?.stack ?? e}\n`); wrapper.unlock(); process.exit(1); },
);
