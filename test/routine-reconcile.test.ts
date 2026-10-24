/**
 * server/lib/routine-reconcile.ts — rendering, the plan and the apply. `HOME` is a tmpdir per case, so LaunchAgents, `installed_plugins.json` and the
 * state root all land in it; a fake runner stands in for launchd and cron (it records every `launchctl` / `crontab` / `pgrep` call and answers from its own
 * loaded set and crontab text), so no case touches the real launchd or crontab. The one real launch is `sh -n` over a rendered crontab line.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Config } from '../server/lib/config.js';
import {
  applyReconcile, CRON_END, CRON_LINE_MAX, CRON_START, LABEL_PREFIX, PLUGIN_ID, lastReconcile, planReconcile, renderCronEnv, renderCronLine, renderPlist,
  scheduled, setReconcileHost, setRoutineRunner, LEGACY_CRON_END, LEGACY_CRON_START, LEGACY_LABEL_PREFIX
} from '../server/lib/routine-reconcile.js';
import type { ReconcilePaths, ReconcileReport } from '../server/lib/routine-reconcile.js';
import { claimOwner, releaseOwner } from '../server/lib/routine-store.js';
import type { Probe } from '../server/lib/routine-store.js';
import { parseJob } from '../shared/routine-file.js';
import type { RoutineJob } from '../shared/types.js';
import { PLUGIN_ID as SYNC_PLUGIN_ID } from '../scripts/sync-plugin.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const UID = 501;
const NODE = '/opt/node/bin/node';
const SEVEN = ['PATH', 'HOME', 'CLAUDE_BIN', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE', 'ROUTINE_MACHINE', 'ROUTINES_DIR'];

const SHELL = (machines = 'mac, wsl', extra: string[] = []): string =>
  ['---', 'cron: "0 7 * * 1-5"', `machines: [${machines}]`, 'run: shell', ...extra, '---', '```bash', 'echo hi', '```', ''].join('\n');
const MANUAL = ['---', 'cron: manual', 'machines: [mac, wsl]', 'run: shell', '---', '```bash', 'echo hi', '```', ''].join('\n');
const CLAUDE = ['---', 'cron: "0 9 * * *"', 'machines: [mac, wsl]', 'run: claude', '---', '/git-sync', ''].join('\n');

function job(name: string, text: string): RoutineJob {
  const p = parseJob(name, text);
  assert.ok(p.job, `fixture ${name} should parse: ${JSON.stringify(p.errors)}`);
  return p.job;
}

interface Call { cmd: string; args: string[]; input?: string }

/** launchd and cron in miniature: `loaded` labels, one crontab text (null = none), and a pgrep answer. Every call is recorded. */
class FakeOs {
  calls: Call[] = [];
  loaded = new Set<string>();
  crontab: string | null = null;
  cronPids = '123\n';
  bootstrapFails = false;
  /** Called with the plist path as `bootstrap` runs, to look at the disk at that moment. */
  onBootstrap: ((file: string) => void) | null = null;
  /** Exit code `bootout` gives for a loaded label (null = success); an unloaded one always answers 3, as real launchctl does. */
  bootoutLoadedCode: number | null = null;
  /** `crontab -l` failing with this stderr instead of answering (null = answer from `crontab`). */
  listError: string | null = null;
  /** Per-call delay, so two overlapping applies would interleave if nothing serialized them. */
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;

  run = async (cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    this.calls.push(input === undefined ? { cmd, args } : { cmd, args, input });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      return this.answer(cmd, args, input);
    } finally { this.inFlight--; }
  };

  private answer(cmd: string, args: string[], input?: string): { code: number; stdout: string; stderr: string } {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (cmd === 'launchctl') {
      const [verb, target, file] = args;
      const label = (target ?? '').split('/').pop() ?? '';
      if (verb === 'print') return this.loaded.has(label) ? ok('state = waiting') : { code: 113, stdout: '', stderr: 'Could not find service' };
      if (verb === 'bootout') {
        if (!this.loaded.has(label)) return { code: 3, stdout: '', stderr: 'No such process' };
        if (this.bootoutLoadedCode !== null) return { code: this.bootoutLoadedCode, stdout: '', stderr: 'Boot-out failed: 150: Operation not permitted' };
        this.loaded.delete(label);
        return ok();
      }
      if (verb === 'bootstrap') {
        this.onBootstrap?.(file);
        if (this.bootstrapFails) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        this.loaded.add(path.basename(file, '.plist'));
        return ok();
      }
    }
    if (cmd === 'crontab' && args[0] === '-l' && this.listError !== null) return { code: 1, stdout: '', stderr: this.listError };
    if (cmd === 'crontab' && args[0] === '-l') return this.crontab === null ? { code: 1, stdout: '', stderr: 'no crontab for u' } : ok(this.crontab);
    if (cmd === 'crontab' && args[0] === '-') { this.crontab = input ?? ''; return ok(); }
    if (cmd === 'pgrep') return this.cronPids ? ok(this.cronPids) : { code: 1, stdout: '', stderr: '' };
    throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
  }

  verbs(): string[] { return this.calls.map((c) => `${c.cmd} ${c.args[0]}`); }
}

const fakeProbe = (table: Record<number, string>): Probe => ({ alive: (pid) => pid in table, command: (pid) => table[pid] ?? null });

interface World {
  home: string;
  dir: string;
  wrapper: string;
  fake: FakeOs;
  cfg: Config;
  write: (name: string, text: string) => void;
  agents: string;
  plist: (name: string) => string;
}

/** A tmp HOME with the plugin installed and an owner lock taken; everything is put back afterwards whatever `fn` throws. */
async function withWorld(over: Partial<Config>, fn: (w: World) => Promise<void>, opts: { plugin?: boolean; owner?: boolean; probe?: Probe; node?: string } = {}): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-reconcile-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const dir = path.join(home, 'routines');
  fs.mkdirSync(dir);
  const install = path.join(home, '.claude', 'plugins', 'cache', 'x', '1.0.0');
  const wrapper = path.join(install, 'lib', 'run-routine.mjs');
  if (opts.plugin !== false) {
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, '// wrapper\n');
  }
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  const cfg = {
    port: 4173, routinesDir: dir, routineMachine: 'mac', routinesOwner: true, routinesStateRoot: '', claudeBin: '/usr/local/bin/claude',
    spawnMaxPermission: 'auto', syncPermissionMode: 'plan', ...over
  } as Config;
  const fake = new FakeOs();
  setRoutineRunner(fake.run);
  setReconcileHost({ uid: UID, nodePath: opts.node ?? NODE, probe: opts.probe ?? fakeProbe({}) });
  const agents = path.join(home, 'Library', 'LaunchAgents');
  try {
    if (opts.owner !== false) assert.strictEqual(claimOwner(cfg, fakeProbe({})), 'owner');
    await fn({
      home, dir, wrapper, fake, cfg, agents,
      write: (name, text) => fs.writeFileSync(path.join(dir, `${name}.md`), text),
      plist: (name) => path.join(agents, `${LABEL_PREFIX}${name}.plist`),
    });
  } finally {
    releaseOwner();
    setRoutineRunner(null);
    setReconcileHost(null);
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const actions = (r: ReconcileReport): string[] => r.changes.map((c) => `${c.name}:${c.action}:${c.why}`);

/** Installs `pull-pins` through a first apply and resets the call log, so the case starts from a loaded, identical job. */
async function installed(w: World): Promise<void> {
  w.write('pull-pins', SHELL());
  const r = await applyReconcile(w.cfg);
  assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
  w.fake.calls = [];
}

export async function run(): Promise<number> {
  let total = 0;
  let ok_ = 0;
  const check = (r: boolean): void => { total++; if (r) ok_++; };
  const paths: ReconcilePaths = {
    node: NODE, wrapper: '/p/lib/run-routine.mjs', routines: '/s/routines', launchd: '/h/.claude/routines/launchd', cronEnv: '/h/.claude/routines/cron.env'
  };
  const env = Object.fromEntries(SEVEN.map((k) => [k, `v-${k}`]));

  check(await test('PLUGIN_ID matches scripts/sync-plugin.ts', () => {
    assert.strictEqual(PLUGIN_ID, SYNC_PLUGIN_ID);
  }));

  check(await test('renderPlist: five calendar dicts, three program arguments, the seven env keys, working dir and logs under launchd/', () => {
    const text = renderPlist(job('pull-pins', SHELL()), env, paths);
    const intervals = text.slice(text.indexOf('<key>StartCalendarInterval</key>'));
    const dicts = [...intervals.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((m) => m[1].replace(/\s+/g, ''));
    assert.deepStrictEqual(dicts, [1, 2, 3, 4, 5].map((d) => `<key>Minute</key><integer>0</integer><key>Hour</key><integer>7</integer><key>Weekday</key><integer>${d}</integer>`));
    const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    assert.deepStrictEqual([...args.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]), [NODE, paths.wrapper, 'pull-pins']);
    const envDict = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? '';
    assert.deepStrictEqual([...envDict.matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]), SEVEN);
    assert.ok(text.includes(`<key>WorkingDirectory</key><string>/s/routines</string>`));
    assert.ok(text.includes(`<key>StandardOutPath</key><string>/h/.claude/routines/launchd/pull-pins.out.log</string>`));
    assert.ok(text.includes(`<key>StandardErrorPath</key><string>/h/.claude/routines/launchd/pull-pins.err.log</string>`));
    assert.ok(text.includes(`<key>Label</key><string>${LABEL_PREFIX}pull-pins</string>`));
  }));

  check(await test('renderPlist escapes XML in env values', () => {
    const text = renderPlist(job('pull-pins', SHELL()), { ...env, PATH: '/a&b/<c>' }, paths);
    assert.ok(text.includes('<string>/a&amp;b/&lt;c&gt;</string>'));
  }));

  check(await test('renderCronLine: one short line that sources the env file and execs the wrapper, paths quoted, % escaped, passes sh -n', () => {
    const odd = { ...paths, wrapper: "/p/it's/lib%x/run-routine.mjs" };
    const line = renderCronLine(job('pull-pins', SHELL()), odd);
    assert.strictEqual(line, `0 7 * * 1-5 . '/h/.claude/routines/cron.env' && exec '${NODE}' '/p/it'\\''s/lib\\%x/run-routine.mjs' 'pull-pins'`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cronline-'));
    try {
      // The line as written, and the command as cron hands it to sh (`\%` back to `%`, the five fields gone).
      const command = line.split(' ').slice(5).join(' ').replace(/\\%/g, '%');
      for (const [i, text] of [line, command].entries()) {
        const f = path.join(tmp, `l${i}.sh`);
        fs.writeFileSync(f, text + '\n');
        const r = spawnSync('sh', ['-n', f], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `sh -n failed on ${text}: ${r.stderr}`);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }));

  check(await test('renderCronEnv: one export per key, single-quoted, and sh sources it back to the same values', () => {
    const e = { ...env, PATH: "/c/Program Files (x86)/x:/it's", HOME: '/home/a%b $x `y`' };
    const text = renderCronEnv(e);
    assert.deepStrictEqual(text.split('\n').filter(Boolean).map((l) => l.split('=')[0]), SEVEN.map((k) => `export ${k}`));
    assert.ok(text.includes(`export PATH='/c/Program Files (x86)/x:/it'\\''s'\n`), text);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cronenv-'));
    try {
      const f = path.join(tmp, 'cron.env');
      fs.writeFileSync(f, text);
      const r = spawnSync('/bin/sh', ['-c', `. '${f}' && printf '%s\\n%s' "$PATH" "$HOME"`], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, `${e.PATH}\n${e.HOME}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }));

  check(await test('mac: a new file plans install; apply writes the plist, then bootout + bootstrap gui/<uid>', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      const plan = await planReconcile(w.cfg);
      assert.strictEqual(plan.state, 'drift');
      assert.deepStrictEqual(actions(plan), ['pull-pins:install:new']);
      assert.deepStrictEqual(w.fake.calls, [], 'nothing on disk yet, so nothing to print');
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.strictEqual(r.unchanged, 1);
      const label = `${LABEL_PREFIX}pull-pins`;
      assert.deepStrictEqual(w.fake.calls, [
        { cmd: 'launchctl', args: ['bootout', `gui/${UID}/${label}`] },
        { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, w.plist('pull-pins')] },
        { cmd: 'launchctl', args: ['print', `gui/${UID}/${label}`] },
      ]);
      const text = fs.readFileSync(w.plist('pull-pins'), 'utf8');
      assert.ok(text.includes(`<string>${w.wrapper}</string>`), 'the installed plugin copy is the wrapper');
      assert.ok(text.includes(`<string>${path.join(w.home, '.claude', 'routines', 'launchd', 'pull-pins.out.log')}</string>`));
    });
  }));

  check(await test('mac: the launchd/ log dir exists by the time bootstrap names the plist (launchd never creates a log path\'s parent)', async () => {
    await withWorld({}, async (w) => {
      const logs = path.join(w.home, '.claude', 'routines', 'launchd');
      fs.rmSync(logs, { recursive: true, force: true });
      const seen: boolean[] = [];
      w.fake.onBootstrap = () => seen.push(fs.statSync(logs, { throwIfNoEntry: false })?.isDirectory() === true);
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
      assert.deepStrictEqual(seen, [true]);
    });
  }));

  check(await test('mac: plist present, print exit 0 and identical text → unchanged, in-sync, only a print call', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      const r = await planReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.deepStrictEqual(r.changes, []);
      assert.strictEqual(r.unchanged, 1);
      assert.deepStrictEqual(w.fake.verbs(), ['launchctl print']);
    });
  }));

  check(await test('mac: plist on disk but print exit 1 (launchd refused it) → drift', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      w.fake.loaded.clear();
      const r = await planReconcile(w.cfg);
      assert.strictEqual(r.state, 'drift');
      assert.deepStrictEqual(actions(r), ['pull-pins:install:not loaded']);
    });
  }));

  check(await test('mac: bootstrap failing leaves drift behind and reports failed with the error', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      w.fake.bootstrapFails = true;
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.match(r.error ?? '', /pull-pins: launchctl bootstrap: Bootstrap failed: 5/);
      assert.deepStrictEqual(actions(r), ['pull-pins:install:not loaded']);
    });
  }));

  check(await test('mac: a disabled file → remove; apply boots it out and deletes the plist', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      w.write('pull-pins', SHELL('mac, wsl', ['enabled: false']));
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:disabled']);
      w.fake.calls = [];
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.ok(!fs.existsSync(w.plist('pull-pins')));
      assert.deepStrictEqual(w.fake.verbs(), ['launchctl print', 'launchctl bootout']);
    });
  }));

  check(await test('mac: a manual file is never installed, and one installed from a scheduled version is removed with the reason "manual"', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', MANUAL);
      const plan = actions(await planReconcile(w.cfg));
      assert.ok(!plan.some((a) => a.startsWith('pull-pins:')), `no change for a manual file: ${plan.join(', ')}`);
      w.write('pull-pins', SHELL());
      await applyReconcile(w.cfg);
      assert.ok(fs.existsSync(w.plist('pull-pins')));
      w.write('pull-pins', MANUAL);
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:manual']);
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.ok(!fs.existsSync(w.plist('pull-pins')));
    });
  }));

  check(await test('wsl: a job turned manual loses its crontab line', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      await applyReconcile(w.cfg);
      assert.ok(w.fake.crontab?.includes('pull-pins'));
      w.write('pull-pins', MANUAL);
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:manual']);
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.ok(!(w.fake.crontab ?? '').includes('pull-pins'));
    });
  }));

  check(await test('scheduled: enabled and not manual', () => {
    assert.strictEqual(scheduled(job('a', SHELL())), true);
    assert.strictEqual(scheduled(job('a', SHELL('mac, wsl', ['enabled: false']))), false);
    assert.strictEqual(scheduled(job('a', MANUAL)), false);
    assert.strictEqual(scheduled(job('a', MANUAL.replace('run: shell', 'run: shell\nenabled: false'))), false);
  }));

  check(await test('mac: a file naming only wsl → remove (not this machine); a deleted file → remove (file gone)', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      w.write('pull-pins', SHELL('wsl'));
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:not this machine']);
      fs.rmSync(path.join(w.dir, 'pull-pins.md'));
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:file gone']);
    });
  }));

  check(await test('mac: a changed node path → update; apply rewrites the plist with the new node', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      setReconcileHost({ uid: UID, nodePath: '/opt/node-22/bin/node', probe: fakeProbe({}) });
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:update:changed']);
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.ok(fs.readFileSync(w.plist('pull-pins'), 'utf8').includes('<string>/opt/node-22/bin/node</string>'));
    });
  }));

  check(await test('mac: an update of a job whose lock a live wrapper holds → pending · running, no bootout; a dead holder updates', async () => {
    const live = fakeProbe({ 4242: `${NODE} /x/lib/run-routine.mjs pull-pins --trigger schedule` });
    await withWorld({}, async (w) => {
      await installed(w);
      const locks = path.join(w.home, '.claude', 'routines', 'locks');
      fs.mkdirSync(locks, { recursive: true });
      fs.writeFileSync(path.join(locks, 'pull-pins.lock'), JSON.stringify({ pid: 4242, bootId: null, job: 'pull-pins' }));
      w.write('pull-pins', SHELL().replace('0 7 * * 1-5', '30 7 * * 1-5'));
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'pending');
      assert.deepStrictEqual(actions(r), ['pull-pins:pending:running']);
      assert.ok(!w.fake.verbs().includes('launchctl bootout'), w.fake.verbs().join(','));
      setReconcileHost({ uid: UID, nodePath: NODE, probe: fakeProbe({}) });
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
    }, { probe: live });
  }));

  check(await test('installed plugin missing → no-plugin, plugin not installed, no calls', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'no-plugin');
      assert.strictEqual(r.error, 'plugin not installed');
      assert.deepStrictEqual(w.fake.calls, []);
      assert.ok(!fs.existsSync(w.agents));
    }, { plugin: false });
  }));

  check(await test('CLAUDE_BIN empty: the claude job is listed "claude cli not configured" and not installed; the shell job installs', async () => {
    await withWorld({ claudeBin: '' }, async (w) => {
      w.write('pull-pins', SHELL());
      w.write('git-sync-all', CLAUDE);
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'no-claude');
      assert.deepStrictEqual(actions(r), ['git-sync-all:pending:claude cli not configured']);
      assert.ok(fs.existsSync(w.plist('pull-pins')));
      assert.ok(!fs.existsSync(w.plist('git-sync-all')));
    });
  }));

  check(await test('ROUTINE_MACHINE=linux → bad-machine, no calls', async () => {
    await withWorld({ routineMachine: 'linux' }, async (w) => {
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'bad-machine');
      assert.strictEqual(r.error, 'bad ROUTINE_MACHINE');
      assert.deepStrictEqual(w.fake.calls, []);
    });
  }));

  check(await test('non-owner → not-owner, no calls, nothing written', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      assert.strictEqual((await planReconcile(w.cfg)).state, 'not-owner');
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'not-owner');
      assert.deepStrictEqual(w.fake.calls, []);
      assert.ok(!fs.existsSync(w.agents));
    }, { owner: false });
  }));

  check(await test('a foreach job whose pin is absent still installs (the wrapper skips it at run time)', async () => {
    await withWorld({}, async (w) => {
      w.write('lookout-pull', SHELL('mac', ['foreach: [lookout]']));
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
      assert.ok(fs.existsSync(w.plist('lookout-pull')));
    });
  }));

  check(await test('an invalid file is not installed, and its old job is removed', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      w.write('pull-pins', '---\ncron: "nope"\n---\n');
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:remove:invalid']);
    });
  }));

  check(await test('mac: a job installed under the old label moves: the old one booted out and deleted, the new one bootstrapped, once', async () => {
    await withWorld({}, async (w) => {
      fs.mkdirSync(w.agents, { recursive: true });
      const old = path.join(w.agents, `${LEGACY_LABEL_PREFIX}pull-pins.plist`);
      fs.writeFileSync(old, '<plist/>');
      w.fake.loaded.add(`${LEGACY_LABEL_PREFIX}pull-pins`);
      w.write('pull-pins', SHELL());
      const plan = await planReconcile(w.cfg);
      assert.strictEqual(plan.state, 'drift');
      assert.deepStrictEqual(actions(plan), ['pull-pins:install:new', 'pull-pins:remove:old label']);
      w.fake.calls = [];
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
      assert.ok(!fs.existsSync(old));
      assert.ok(fs.existsSync(w.plist('pull-pins')));
      assert.ok(!w.fake.loaded.has(`${LEGACY_LABEL_PREFIX}pull-pins`));
      assert.ok(w.fake.loaded.has(`${LABEL_PREFIX}pull-pins`));
      const bootouts = w.fake.calls.filter((c) => c.args[0] === 'bootout').map((c) => c.args[1]);
      assert.deepStrictEqual(bootouts, [`gui/${UID}/${LEGACY_LABEL_PREFIX}pull-pins`, `gui/${UID}/${LABEL_PREFIX}pull-pins`]);
    });
  }));

  check(await test('mac: an old-label job with no file left is still booted out; mirror: one mid-run waits as pending · running', async () => {
    const live = fakeProbe({ 4242: `${NODE} /x/lib/run-schedule.mjs nightly --trigger schedule` });
    await withWorld({}, async (w) => {
      fs.mkdirSync(w.agents, { recursive: true });
      fs.writeFileSync(path.join(w.agents, `${LEGACY_LABEL_PREFIX}gone.plist`), '<plist/>');
      fs.writeFileSync(path.join(w.agents, `${LEGACY_LABEL_PREFIX}nightly.plist`), '<plist/>');
      const locks = path.join(w.home, '.claude', 'routines', 'locks');
      fs.mkdirSync(locks, { recursive: true });
      fs.writeFileSync(path.join(locks, 'nightly.lock'), JSON.stringify({ pid: 4242, bootId: null, job: 'nightly' }));
      const r = await applyReconcile(w.cfg);
      assert.deepStrictEqual(actions(r), ['nightly:pending:running']);
      assert.ok(!fs.existsSync(path.join(w.agents, `${LEGACY_LABEL_PREFIX}gone.plist`)));
      assert.ok(fs.existsSync(path.join(w.agents, `${LEGACY_LABEL_PREFIX}nightly.plist`)), 'booting out a running job would kill it');
      setReconcileHost({ uid: UID, nodePath: NODE, probe: fakeProbe({}) });
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.ok(!fs.existsSync(path.join(w.agents, `${LEGACY_LABEL_PREFIX}nightly.plist`)));
    }, { probe: live });
  }));

  check(await test('a plist of another label prefix, or with a name outside [a-z0-9-], is never read, printed or removed', async () => {
    await withWorld({}, async (w) => {
      fs.mkdirSync(w.agents, { recursive: true });
      const other = path.join(w.agents, 'com.example.other.plist');
      fs.writeFileSync(other, 'x');
      fs.writeFileSync(path.join(w.agents, `${LABEL_PREFIX}Bad_Name.plist`), 'x');
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.deepStrictEqual(w.fake.calls, []);
      assert.ok(fs.existsSync(other));
    });
  }));

  check(await test('wsl: the marker block is replaced and every user line above and below is byte-identical', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      const above = '# my jobs\nMAILTO=""\n*/5 * * * * echo "50%" >> /tmp/x\n';
      const below = '\n0 3 * * * /usr/bin/backup   --flag\n# trailing comment';
      w.fake.crontab = `${above}${CRON_START}\n0 1 * * * old-line 'stale-job'\n${CRON_END}\n${below}`;
      w.write('pull-pins', SHELL());
      const plan = await planReconcile(w.cfg);
      assert.strictEqual(plan.state, 'drift');
      assert.deepStrictEqual(actions(plan), ['pull-pins:install:new', 'stale-job:remove:file gone']);
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
      const write = w.fake.calls.find((c) => c.cmd === 'crontab' && c.args[0] === '-');
      assert.ok(write?.input !== undefined, 'crontab - was called with the new text');
      assert.ok(write.input.startsWith(above + CRON_START + '\n0 7 * * 1-5 '), write.input);
      assert.ok(write.input.endsWith(`'pull-pins'\n${CRON_END}\n${below}`), write.input);
      assert.strictEqual(write.input.split('\n').filter((l) => l.startsWith('0 7 * * 1-5 ')).length, 1);
      assert.ok(!write.input.includes('stale-job'));
    });
  }));

  check(await test('wsl: a block under the old markers is replaced in place by the new block, user lines byte-identical', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      const above = '# my jobs\n*/5 * * * * echo hi\n';
      const below = '\n0 3 * * * /usr/bin/backup\n';
      w.fake.crontab = `${above}${LEGACY_CRON_START}\n0 7 * * 1-5 . '/h/.claude/schedules/cron.env' && exec node '/p/run-schedule.mjs' 'pull-pins'\n${LEGACY_CRON_END}\n${below}`;
      w.write('pull-pins', SHELL());
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:update:changed']);
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      const text = w.fake.crontab ?? '';
      assert.ok(text.startsWith(above + CRON_START + '\n0 7 * * 1-5 '), text);
      assert.ok(text.endsWith(`'pull-pins'\n${CRON_END}\n${below}`), text);
      assert.ok(!text.includes(LEGACY_CRON_START) && !text.includes(LEGACY_CRON_END) && !text.includes('run-schedule.mjs'), text);
    });
  }));

  check(await test('wsl: no crontab at all gets the block appended; removing the last job takes the block out again', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.ok(w.fake.crontab?.startsWith(CRON_START + '\n'));
      assert.ok(w.fake.crontab?.endsWith(CRON_END + '\n'));
      w.fake.crontab = 'keep me\n' + w.fake.crontab;
      fs.rmSync(path.join(w.dir, 'pull-pins.md'));
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.strictEqual(w.fake.crontab, 'keep me\n');
    });
  }));

  check(await test('wsl: an in-sync crontab is read, never written', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      await applyReconcile(w.cfg);
      w.fake.calls = [];
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.deepStrictEqual(w.fake.verbs().filter((v) => v === 'crontab -'), []);
    });
  }));

  check(await test('wsl: crontab -l failing for another reason → failed, and nothing is written', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      w.fake.listError = 'crontab: cannot open /var/spool/cron: Permission denied';
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.match(r.error ?? '', /Permission denied/);
      assert.ok(!w.fake.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'));
    });
  }));

  check(await test('wsl: pgrep -x cron|crond empty → cron-down (the lines are still kept in the block)', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.fake.cronPids = '';
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'cron-down');
      assert.ok(w.fake.calls.some((c) => c.cmd === 'pgrep' && c.args.join(' ') === '-x cron|crond'));
      assert.ok(w.fake.crontab?.includes(`'pull-pins'`));
    });
  }));

  check(await test('wsl: a 1500-character PATH stays in the 0600 env file and the crontab line stays short', async () => {
    const saved = process.env.PATH;
    try {
      await withWorld({ routineMachine: 'wsl' }, async (w) => {
        const long = Array.from({ length: 60 }, (_, i) => `/mnt/c/Program Files (x86)/Vendor${String(i).padStart(2, '0')}/bin`).join(':').slice(0, 1500);
        assert.strictEqual(long.length, 1500);
        process.env.PATH = long;
        w.write('pull-pins', SHELL());
        const r = await applyReconcile(w.cfg);
        assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
        const line = (w.fake.crontab ?? '').split('\n').find((l) => l.startsWith('0 7 * * 1-5 ')) ?? '';
        assert.ok(line.length > 0 && Buffer.byteLength(line) < CRON_LINE_MAX, `line is ${line.length} bytes`);
        assert.ok(!line.includes('Vendor'), 'the PATH is not inline');
        const envFile = path.join(w.home, '.claude', 'routines', 'cron.env');
        assert.ok(line.includes(`. '${envFile}' && exec `), line);
        assert.ok(fs.readFileSync(envFile, 'utf8').includes(`export PATH='${long}'\n`));
        assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
      });
    } finally { process.env.PATH = saved; }
  }));

  check(await test('wsl: an env change alone rewrites the env file and never calls crontab -', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      await applyReconcile(w.cfg);
      const envFile = path.join(w.home, '.claude', 'routines', 'cron.env');
      assert.ok(fs.readFileSync(envFile, 'utf8').includes(`export CLAUDE_BIN='/usr/local/bin/claude'`));
      w.fake.calls = [];
      w.cfg = { ...w.cfg, claudeBin: '/opt/claude/bin/claude' };
      assert.deepStrictEqual(actions(await planReconcile(w.cfg)), ['pull-pins:update:env changed']);
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync', JSON.stringify(r));
      assert.ok(fs.readFileSync(envFile, 'utf8').includes(`export CLAUDE_BIN='/opt/claude/bin/claude'`));
      assert.ok(!w.fake.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'), w.fake.verbs().join(','));
    });
  }));

  check(await test('wsl: a rendered line still over the cap is refused: failed, pending · crontab line too long, not installed', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.strictEqual(r.error, 'crontab line too long: pull-pins');
      assert.deepStrictEqual(actions(r), ['pull-pins:pending:crontab line too long']);
      assert.ok(!w.fake.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'));
    }, { node: '/opt/' + 'n'.repeat(1000) + '/node' });
  }));

  for (const machine of ['wsl', 'mac'] as const) {
    check(await test(`${machine}: a newline in PATH → failed, bad value in PATH, no runner call at all`, async () => {
      const saved = process.env.PATH;
      await withWorld({ routineMachine: machine }, async (w) => {
        w.write('pull-pins', SHELL());
        process.env.PATH = '/usr/bin\n* * * * * rm -rf ~';
        try {
          const r = await applyReconcile(w.cfg);
          assert.strictEqual(r.state, 'failed');
          assert.strictEqual(r.error, 'bad value in PATH');
          assert.deepStrictEqual(w.fake.calls, []);
          assert.ok(!fs.existsSync(w.agents));
        } finally { process.env.PATH = saved; }
      });
    }));
  }

  check(await test('a control character or a cron-bound \\% in a baked path is refused by name', async () => {
    await withWorld({ routineMachine: 'mac' }, async (w) => {
      w.write('pull-pins', SHELL());
      assert.strictEqual((await applyReconcile(w.cfg)).error, 'bad value in node path');
      assert.deepStrictEqual(w.fake.calls, []);
    }, { node: '/opt/no\rde' });
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      assert.strictEqual((await applyReconcile(w.cfg)).error, 'bad value in node path');
      assert.deepStrictEqual(w.fake.calls, []);
    }, { node: '/opt/a\\%b/node' });
  }));

  check(await test('mac: a bootout that fails on a loaded job keeps its plist and reports failed', async () => {
    await withWorld({}, async (w) => {
      await installed(w);
      fs.rmSync(path.join(w.dir, 'pull-pins.md'));
      w.fake.bootoutLoadedCode = 150;
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.match(r.error ?? '', /pull-pins: launchctl bootout: Boot-out failed: 150/);
      assert.ok(fs.existsSync(w.plist('pull-pins')));
      assert.deepStrictEqual(actions(r), ['pull-pins:remove:file gone']);
    });
  }));

  check(await test('mac: a not-loaded job whose lock a live wrapper holds is pending, not booted out', async () => {
    const live = fakeProbe({ 4242: `${NODE} /x/lib/run-routine.mjs pull-pins` });
    await withWorld({}, async (w) => {
      await installed(w);
      w.fake.loaded.clear();
      const locks = path.join(w.home, '.claude', 'routines', 'locks');
      fs.mkdirSync(locks, { recursive: true });
      fs.writeFileSync(path.join(locks, 'pull-pins.lock'), JSON.stringify({ pid: 4242, bootId: null, job: 'pull-pins' }));
      const r = await applyReconcile(w.cfg);
      assert.deepStrictEqual(actions(r), ['pull-pins:pending:running']);
      assert.ok(!w.fake.verbs().includes('launchctl bootout'));
    }, { probe: live });
  }));

  check(await test('wsl: a start marker with no end marker → failed, and the crontab is not written', async () => {
    await withWorld({ routineMachine: 'wsl' }, async (w) => {
      w.fake.crontab = `${CRON_START}\n0 1 * * * x 'a'\n# user line\n`;
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.match(r.error ?? '', /no "# <<< claude-dashboard routines <<<"/);
      assert.ok(!w.fake.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'));
    });
  }));

  check(await test('planReconcile leaves the last apply report, failed error included, in place', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      w.fake.bootstrapFails = true;
      await applyReconcile(w.cfg);
      assert.strictEqual((await planReconcile(w.cfg)).state, 'drift');
      assert.strictEqual(lastReconcile()?.state, 'failed');
      assert.match(lastReconcile()?.error ?? '', /bootstrap/);
    });
  }));

  check(await test('three applyReconcile calls at once → one run, then one shared trailing run, never interleaved', async () => {
    await withWorld({}, async (w) => {
      w.write('pull-pins', SHELL());
      w.write('other-job', SHELL('mac'));
      w.fake.delayMs = 5;
      const a = applyReconcile(w.cfg);
      const b = applyReconcile(w.cfg);
      const c = applyReconcile(w.cfg);
      assert.strictEqual(b, c, 'later callers share the one trailing run');
      assert.notStrictEqual(a, b);
      const [ra, rb] = await Promise.all([a, b]);
      assert.strictEqual(ra.state, 'in-sync');
      assert.strictEqual(rb.state, 'in-sync');
      assert.strictEqual(w.fake.maxInFlight, 1, 'no two runner calls overlapped');
      // First run: bootout+bootstrap per job, then the re-plan's two prints. Trailing run: plan's two prints, nothing to apply, re-plan's two prints.
      assert.deepStrictEqual(w.fake.verbs(), [
        'launchctl bootout', 'launchctl bootstrap', 'launchctl bootout', 'launchctl bootstrap', 'launchctl print', 'launchctl print',
        'launchctl print', 'launchctl print', 'launchctl print', 'launchctl print',
      ]);
      w.fake.calls = [];
      await applyReconcile(w.cfg);
      assert.strictEqual(w.fake.verbs().length, 4, 'after both settle, a new call starts a fresh run');
    });
  }));

  console.log(`\nroutine-reconcile: ${ok_}/${total} passed`);
  return total - ok_;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
