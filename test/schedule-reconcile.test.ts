/**
 * server/lib/schedule-reconcile.ts — rendering, the plan and the apply. `HOME` is a tmpdir per case, so LaunchAgents, `installed_plugins.json` and the
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
  applyReconcile, CRON_END, CRON_START, LABEL_PREFIX, PLUGIN_ID, planReconcile, renderCronLine, renderPlist, setReconcileHost, setScheduleRunner,
} from '../server/lib/schedule-reconcile.js';
import type { ReconcilePaths, ReconcileReport } from '../server/lib/schedule-reconcile.js';
import { claimOwner, releaseOwner } from '../server/lib/schedule-store.js';
import type { Probe } from '../server/lib/schedule-store.js';
import { parseJob } from '../shared/schedule-file.js';
import type { ScheduleJob } from '../shared/types.js';
import { PLUGIN_ID as SYNC_PLUGIN_ID } from '../scripts/sync-plugin.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const UID = 501;
const NODE = '/opt/node/bin/node';
const SEVEN = ['PATH', 'HOME', 'CLAUDE_BIN', 'SPAWN_MAX_PERMISSION', 'SYNC_PERMISSION_MODE', 'SCHEDULE_MACHINE', 'SCHEDULES_DIR'];

const SHELL = (machines = 'mac, wsl', extra: string[] = []): string =>
  ['---', 'cron: "0 7 * * 1-5"', `machines: [${machines}]`, 'run: shell', ...extra, '---', '```bash', 'echo hi', '```', ''].join('\n');
const CLAUDE = ['---', 'cron: "0 9 * * *"', 'machines: [mac, wsl]', 'run: claude', '---', '/git-sync', ''].join('\n');

function job(name: string, text: string): ScheduleJob {
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
      if (verb === 'bootout') return this.loaded.delete(label) ? ok() : { code: 3, stdout: '', stderr: 'No such process' };
      if (verb === 'bootstrap') {
        if (this.bootstrapFails) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        this.loaded.add(path.basename(file, '.plist'));
        return ok();
      }
    }
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-reconcile-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  const dir = path.join(home, 'schedules');
  fs.mkdirSync(dir);
  const install = path.join(home, '.claude', 'plugins', 'cache', 'x', '1.0.0');
  const wrapper = path.join(install, 'lib', 'run-schedule.mjs');
  if (opts.plugin !== false) {
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, '// wrapper\n');
  }
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  const cfg = {
    port: 4173, schedulesDir: dir, scheduleMachine: 'mac', schedulesOwner: true, schedulesStateRoot: '', claudeBin: '/usr/local/bin/claude',
    spawnMaxPermission: 'auto', syncPermissionMode: 'plan', ...over
  } as Config;
  const fake = new FakeOs();
  setScheduleRunner(fake.run);
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
    setScheduleRunner(null);
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
  const paths: ReconcilePaths = { node: NODE, wrapper: '/p/lib/run-schedule.mjs', schedules: '/s/schedules', launchd: '/h/.claude/schedules/launchd' };
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
    assert.ok(text.includes(`<key>WorkingDirectory</key><string>/s/schedules</string>`));
    assert.ok(text.includes(`<key>StandardOutPath</key><string>/h/.claude/schedules/launchd/pull-pins.out.log</string>`));
    assert.ok(text.includes(`<key>StandardErrorPath</key><string>/h/.claude/schedules/launchd/pull-pins.err.log</string>`));
    assert.ok(text.includes(`<key>Label</key><string>${LABEL_PREFIX}pull-pins</string>`));
  }));

  check(await test('renderPlist escapes XML in env values', () => {
    const text = renderPlist(job('pull-pins', SHELL()), { ...env, PATH: '/a&b/<c>' }, paths);
    assert.ok(text.includes('<string>/a&amp;b/&lt;c&gt;</string>'));
  }));

  check(await test('renderCronLine: one line, cron first, every env value single-quoted, quote and % escaped, passes sh -n', () => {
    const e = { ...env, PATH: "/c/Program Files (x86)/x:/it's", HOME: '/home/a%b' };
    const line = renderCronLine(job('pull-pins', SHELL()), e, paths);
    assert.ok(!line.includes('\n'));
    assert.ok(line.startsWith('0 7 * * 1-5 '), line);
    assert.ok(line.includes(`PATH='/c/Program Files (x86)/x:/it'\\''s'`), line);
    assert.ok(line.includes(`HOME='/home/a\\%b'`), line);
    assert.ok(!/[^\\]%/.test(line), 'no bare %');
    for (const k of SEVEN) assert.ok(new RegExp(` ${k}='`).test(line), `${k} single-quoted`);
    assert.ok(line.endsWith(` '${NODE}' '${paths.wrapper}' 'pull-pins'`), line);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-cronline-'));
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
      assert.ok(text.includes(`<string>${path.join(w.home, '.claude', 'schedules', 'launchd', 'pull-pins.out.log')}</string>`));
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
    const live = fakeProbe({ 4242: `${NODE} /x/lib/run-schedule.mjs pull-pins --trigger schedule` });
    await withWorld({}, async (w) => {
      await installed(w);
      const locks = path.join(w.home, '.claude', 'schedules', 'locks');
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

  check(await test('SCHEDULE_MACHINE=linux → bad-machine, no calls', async () => {
    await withWorld({ scheduleMachine: 'linux' }, async (w) => {
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'bad-machine');
      assert.strictEqual(r.error, 'bad SCHEDULE_MACHINE');
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

  check(await test('a plist of another label prefix is never read, printed or removed', async () => {
    await withWorld({}, async (w) => {
      fs.mkdirSync(w.agents, { recursive: true });
      const other = path.join(w.agents, 'com.example.other.plist');
      fs.writeFileSync(other, 'x');
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'in-sync');
      assert.deepStrictEqual(w.fake.calls, []);
      assert.ok(fs.existsSync(other));
    });
  }));

  check(await test('wsl: the marker block is replaced and every user line above and below is byte-identical', async () => {
    await withWorld({ scheduleMachine: 'wsl' }, async (w) => {
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

  check(await test('wsl: no crontab at all gets the block appended; removing the last job takes the block out again', async () => {
    await withWorld({ scheduleMachine: 'wsl' }, async (w) => {
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
    await withWorld({ scheduleMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      await applyReconcile(w.cfg);
      w.fake.calls = [];
      assert.strictEqual((await applyReconcile(w.cfg)).state, 'in-sync');
      assert.deepStrictEqual(w.fake.verbs().filter((v) => v === 'crontab -'), []);
    });
  }));

  check(await test('wsl: crontab -l failing for another reason → failed, and nothing is written', async () => {
    await withWorld({ scheduleMachine: 'wsl' }, async (w) => {
      w.write('pull-pins', SHELL());
      setScheduleRunner(async (cmd, args, input) => {
        w.fake.calls.push({ cmd, args, input });
        if (cmd === 'crontab' && args[0] === '-l') return { code: 1, stdout: '', stderr: 'crontab: cannot open /var/spool/cron: Permission denied' };
        return { code: 0, stdout: '1\n', stderr: '' };
      });
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'failed');
      assert.match(r.error ?? '', /Permission denied/);
      assert.ok(!w.fake.calls.some((c) => c.cmd === 'crontab' && c.args[0] === '-'));
    });
  }));

  check(await test('wsl: pgrep -x cron|crond empty → cron-down (the lines are still kept in the block)', async () => {
    await withWorld({ scheduleMachine: 'wsl' }, async (w) => {
      w.fake.cronPids = '';
      w.write('pull-pins', SHELL());
      const r = await applyReconcile(w.cfg);
      assert.strictEqual(r.state, 'cron-down');
      assert.ok(w.fake.calls.some((c) => c.cmd === 'pgrep' && c.args.join(' ') === '-x cron|crond'));
      assert.ok(w.fake.crontab?.includes(`'pull-pins'`));
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

  console.log(`\nschedule-reconcile: ${ok_}/${total} passed`);
  return total - ok_;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
