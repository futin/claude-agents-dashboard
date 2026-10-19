/**
 * The scheduled-workflows routes and `GET /api/sessions/:id/row`, driven through the real route table (spec §HTTP). Nothing here reaches the OS: the
 * reconcile runner is a recorder that fails the case if anything calls it, the liveness probe is a table, the plugin is never installed (so Run now
 * answers `no-plugin` before any spawn), and Finder is `overrideOpenFolder`.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness, Reply } from './api-harness.js';
import { installedFrom } from '../server/api.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { overrideOpenFolder } from '../server/lib/open-folder.js';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resetScheduleBoot, setScheduleProbe } from '../server/lib/schedule-boot.js';
import { PLUGIN_ID, setReconcileHost, setScheduleRunner } from '../server/lib/schedule-reconcile.js';
import { claimOwner, releaseOwner } from '../server/lib/schedule-store.js';
import type { Probe } from '../server/lib/schedule-store.js';
import { resetSettings, setPinned } from '../server/lib/settings.js';
import { setSpawner } from '../server/lib/spawn.js';
import type { ReconcileChange, ReconcileReport, ScheduleFile, ScheduleRunsResponse, SchedulesResponse, Session } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nSCHEDULES_DIR=~/schedules\nSCHEDULE_MACHINE=mac\nNTFY_TOPIC=\n';
const OWNER = 'SCHEDULES_OWNER=true\n';
const UNTRUSTED = { 'X-Forwarded-For': '192.168.1.5' };
const DAY = 24 * 3600_000;
const LIVE_PID = 4343;

const NO_PROBE: Probe = { alive: () => false, command: () => null };
/** `LIVE_PID` is a live wrapper for job `x`; nothing else is alive. */
const RUN_PROBE: Probe = {
  alive: (pid) => pid === LIVE_PID,
  command: (pid) => (pid === LIVE_PID ? '/usr/local/bin/node /p/lib/run-schedule.mjs x' : null)
};

const job = (o: { run?: 'claude' | 'shell'; enabled?: boolean; machines?: string; extra?: string[] } = {}): string => [
  '---', 'cron: "0 9 * * *"', `machines: [${o.machines ?? 'mac'}]`, `run: ${o.run ?? 'claude'}`, `enabled: ${o.enabled ?? true}`, ...(o.extra ?? []), '---',
  ...(o.run === 'shell' ? ['```bash', 'echo hi', '```'] : ['/git-sync']), ''
].join('\n');

interface Ctx {
  h: Harness;
  schedules: string;
  runs: string;
  /** Every reconcile launch; a case that reaches one fails at the end. */
  launches: string[];
}

const dirsOf = (h: Harness) => ({ schedules: path.join(h.home, 'schedules'), runs: path.join(h.home, '.claude', 'schedules', 'runs') });

/** A server with a fresh schedules folder; owner when `owner`, released after. */
async function withSchedules(env: string, owner: boolean, fn: (c: Ctx) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withServer(ENV + (owner ? OWNER : '') + env, async h => {
      resetSettings();
      resetScheduleBoot();
      setScheduleProbe(NO_PROBE);
      setReconcileHost({ probe: NO_PROBE });
      const launches: string[] = [];
      setScheduleRunner(async (cmd, args) => { launches.push([cmd, ...args].join(' ')); return { code: 1, stdout: '', stderr: 'fake' }; });
      const { schedules, runs } = dirsOf(h);
      fs.mkdirSync(schedules, { recursive: true });
      fs.mkdirSync(runs, { recursive: true });
      if (owner) assert.strictEqual(claimOwner(h.cfg, NO_PROBE), 'owner');
      try {
        await fn({ h, schedules, runs, launches });
        assert.deepStrictEqual(launches, [], 'no launchctl / crontab / pgrep from these routes without a plugin');
      } finally {
        releaseOwner();
        setScheduleRunner(null);
        setReconcileHost(null);
        setScheduleProbe(null);
        resetScheduleBoot();
        overrideOpenFolder({ run: null, platform: null });
        resetSettings();
      }
    });
  } finally {
    overrideClaudeRoots(null);
  }
}

function send(h: Harness, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return h.req(pathname, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), headers });
}

const writeJob = (c: Ctx, name: string, text: string): string => {
  const file = path.join(c.schedules, `${name}.md`);
  fs.writeFileSync(file, text);
  return file;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** One finished run of `jobName`, `msAgo` before now; `failed` steps make it a failed run. */
function logRun(c: Ctx, id: string, jobName: string, msAgo: number, failed = 0, pid = 4242): void {
  const at = Date.now() - msAgo;
  const lines = [
    { kind: 'start', run: id, job: jobName, machine: 'mac', trigger: 'schedule', at: iso(at), late: false, steps: 1, pid },
    { kind: 'end', run: id, at: iso(at + 500), ms: 500, ok: failed ? 0 : 1, failed, skipped: 0, stopped: false }
  ];
  fs.appendFileSync(path.join(c.runs, 'mac.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function logStart(c: Ctx, id: string, jobName: string, msAgo: number, pid: number): void {
  const line = { kind: 'start', run: id, job: jobName, machine: 'mac', trigger: 'manual', at: iso(Date.now() - msAgo), late: false, steps: 1, pid };
  fs.appendFileSync(path.join(c.runs, 'mac.jsonl'), JSON.stringify(line) + '\n');
}

/** Two pins whose folders share the basename `repo`, so `foreach: [repo]` is ambiguous. */
function plantAmbiguousPins(h: Harness): void {
  for (const parent of ['a', 'b']) {
    const cwd = path.join(h.home, 'projs', parent, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const dirName = encodeProjectDir(cwd);
    const dir = path.join(h.home, '.claude', 'projects', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${parent}-1.jsonl`), JSON.stringify(userRecord(`${parent}-u1`, 'hi', cwd)) + '\n');
    assert.notStrictEqual(setPinned(dirName, true), null);
  }
}

const listing = (dir: string): string[] => fs.readdirSync(dir).sort();

/** An installed plugin under the harness HOME and a recording spawner that plays the wrapper's `start` line, so Run now answers without its 2 s wait. */
function installAndSpawn(c: Ctx): string[][] {
  const install = path.join(c.h.home, 'plugin-install');
  fs.mkdirSync(path.join(install, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(install, 'lib', 'run-schedule.mjs'), '// fixture, never run\n');
  fs.mkdirSync(path.join(c.h.home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(c.h.home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  const calls: string[][] = [];
  setSpawner((_command, args) => {
    calls.push(args);
    logStart(c, `r-${calls.length}`, 'x', 0, 99);
    return Object.assign(new EventEmitter(), { pid: 99, unref: () => {} }) as unknown as ChildProcess;
  });
  return calls;
}

export async function run(): Promise<number> {
  console.log('\n=== schedules endpoints (api.ts via the router) ===\n');
  let p = 0;
  let f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(await testAsync('GET /api/schedules: the ledger shape on the owner, nextAt only for a job due here, last and running off the log', async () => {
    await withSchedules('', true, async c => {
      setScheduleProbe(RUN_PROBE);
      writeJob(c, 'x', job());
      writeJob(c, 'paused', job({ enabled: false }));
      writeJob(c, 'elsewhere', job({ machines: 'wsl' }));
      writeJob(c, 'broken', '---\ncron: nonsense\n---\nx\n');
      logRun(c, 'r-old', 'x', 2 * DAY);
      logRun(c, 'r-new', 'x', DAY, 1);
      logStart(c, 'r-live', 'x', 60_000, LIVE_PID);
      const r = await send(c.h, 'GET', '/api/schedules');
      assert.strictEqual(r.status, 200);
      const body = r.json as unknown as SchedulesResponse;
      assert.strictEqual(body.machine, 'mac');
      assert.strictEqual(body.dir, c.schedules);
      assert.strictEqual(body.owner, 'owner');
      assert.strictEqual(body.reconcile.state, 'no-plugin');
      assert.deepStrictEqual(body.jobs.map(j => j.name), ['broken', 'elsewhere', 'paused', 'x']);
      const by = new Map(body.jobs.map(j => [j.name, j]));
      const x = by.get('x')!;
      assert.strictEqual(x.onThisMachine, true);
      assert.strictEqual(x.installed, false, 'a no-plugin report knows nothing is installed');
      assert.ok(x.nextAt && Date.parse(x.nextAt) > Date.now(), `nextAt ${x.nextAt}`);
      assert.strictEqual(new Date(x.nextAt).getMinutes(), 0);
      assert.strictEqual(x.last?.id, 'r-new');
      assert.strictEqual(x.last?.state, 'failed');
      assert.strictEqual(x.running?.id, 'r-live');
      assert.strictEqual(by.get('paused')!.nextAt, null);
      assert.strictEqual(by.get('elsewhere')!.onThisMachine, false);
      assert.strictEqual(by.get('elsewhere')!.nextAt, null);
      const broken = by.get('broken')!;
      assert.strictEqual(broken.job, null);
      assert.ok(broken.errors.length > 0);
      assert.strictEqual(broken.onThisMachine, false);
    });
  }));

  tally(await testAsync('installedFrom: read off the planned changes; a bare report (not owner, no plugin, bad machine, failed early) is false', async () => {
    const report = (state: ReconcileReport['state'], changes: ReconcileChange[] = [], unchanged = 0): ReconcileReport =>
      ({ state, changes, unchanged, error: null, at: '' });
    const one = (action: ReconcileChange['action'], why = ''): ReconcileReport => report('drift', [{ name: 'x', action, why }]);
    assert.strictEqual(installedFrom(one('install'), 'x', true), false);
    assert.strictEqual(installedFrom(one('update'), 'x', true), true);
    assert.strictEqual(installedFrom(one('remove'), 'x', false), true);
    assert.strictEqual(installedFrom(one('pending', 'running'), 'x', false), true, 'a removal deferred behind a live run is still installed');
    assert.strictEqual(installedFrom(one('pending', 'no claude'), 'x', true), false);
    assert.strictEqual(installedFrom(report('in-sync', [], 1), 'x', true), true, 'no change for a wanted job: it is installed');
    assert.strictEqual(installedFrom(report('in-sync', [], 1), 'x', false), false);
    for (const bare of ['not-owner', 'no-plugin', 'bad-machine'] as const) assert.strictEqual(installedFrom(report(bare), 'x', true), false, bare);
    assert.strictEqual(installedFrom(report('failed'), 'x', true), false, 'failed before planning');
    assert.strictEqual(installedFrom(report('failed', [], 2), 'x', true), true, 'failed applying, but planned');
  }));

  tally(await testAsync('GET /api/schedules on a non-owner: owner { ownedBy: "" }, reconcile not-owner, installed false', async () => {
    await withSchedules('', false, async c => {
      writeJob(c, 'x', job());
      const body = (await send(c.h, 'GET', '/api/schedules')).json as unknown as SchedulesResponse;
      assert.deepStrictEqual(body.owner, { ownedBy: '' });
      assert.strictEqual(body.reconcile.state, 'not-owner');
      assert.strictEqual(body.jobs[0].installed, false);
    });
  }));

  tally(await testAsync('GET /api/schedules/runs?days=7&job=x&outcome=failed&runner=claude filters; stats keep every outcome of the scope', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'x', job());
      writeJob(c, 'y', job({ run: 'shell' }));
      logRun(c, 'x-ancient', 'x', 20 * DAY, 1);
      logRun(c, 'x-ok', 'x', 2 * DAY);
      logRun(c, 'x-fail', 'x', DAY, 1);
      logRun(c, 'y-fail', 'y', DAY / 2, 1);
      const r = await send(c.h, 'GET', '/api/schedules/runs?days=7&job=x&outcome=failed&runner=claude');
      assert.strictEqual(r.status, 200);
      const body = r.json as unknown as ScheduleRunsResponse;
      assert.deepStrictEqual(body.runs.map(x => x.id), ['x-fail']);
      assert.strictEqual(body.stats.byDay.length, 7);
      assert.strictEqual(body.stats.runs, 2, 'x-ok and x-fail: the outcome filter narrows the list, not the stats');

      const shell = (await send(c.h, 'GET', '/api/schedules/runs?days=7&runner=shell')).json as unknown as ScheduleRunsResponse;
      assert.deepStrictEqual(shell.runs.map(x => x.id), ['y-fail']);
      const month = (await send(c.h, 'GET', '/api/schedules/runs?days=30')).json as unknown as ScheduleRunsResponse;
      assert.deepStrictEqual(month.runs.map(x => x.id), ['y-fail', 'x-fail', 'x-ok', 'x-ancient'], 'newest first, the 30-day window');
      const odd = (await send(c.h, 'GET', '/api/schedules/runs?days=12')).json as unknown as ScheduleRunsResponse;
      assert.strictEqual(odd.stats.byDay.length, 30, 'a window outside 7 | 30 | 90 reads as 30');
      const bad = await send(c.h, 'GET', '/api/schedules/runs?outcome=bogus');
      assert.deepStrictEqual([bad.status, bad.json], [400, { error: 'bad outcome' }], 'an unknown outcome is refused, never read as no filter');
      const del = await send(c.h, 'DELETE', '/api/schedules/runs');
      assert.deepStrictEqual([del.status, del.headers.allow], [405, 'GET']);
    });
  }));

  tally(await testAsync('a run of a deleted job whose wrapper cannot be judged ages out against the default timeout, never running for ever', async () => {
    await withSchedules('', true, async c => {
      // Alive but unreadable: the liveness check answers null, so only the age rule can end the run.
      setScheduleProbe({ alive: () => true, command: () => null });
      logStart(c, 'gone-old', 'gone', 3 * 3600_000, 5555);
      logStart(c, 'gone-new', 'gone', 60_000, 5556);
      const body = (await send(c.h, 'GET', '/api/schedules/runs?job=gone')).json as unknown as ScheduleRunsResponse;
      assert.deepStrictEqual(body.runs.map(r => [r.id, r.state]), [['gone-new', 'running'], ['gone-old', 'lost']]);
    });
  }));

  tally(await testAsync('GET /api/schedules/runs is the runs list even with a runs.md on disk, never a job lookup', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'runs', job());
      const r = await send(c.h, 'GET', '/api/schedules/runs');
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.json?.runs) && r.json?.stats, JSON.stringify(r.json));
      assert.strictEqual(r.json?.text, undefined);
    });
  }));

  tally(await testAsync('GET /api/schedules/:name: the raw file and its parse; 404 for no file, 400 for a bad name', async () => {
    await withSchedules('', false, async c => {
      const text = job();
      writeJob(c, 'x', text);
      const r = await send(c.h, 'GET', '/api/schedules/x');
      assert.strictEqual(r.status, 200);
      const body = r.json as unknown as ScheduleFile;
      assert.strictEqual(body.text, text);
      assert.strictEqual(body.job?.name, 'x');
      assert.strictEqual((await send(c.h, 'GET', '/api/schedules/nope')).status, 404);
      assert.strictEqual((await send(c.h, 'GET', '/api/schedules/X')).status, 400);
    });
  }));

  tally(await testAsync('PUT: an invalid file → 422 { errors: [{ line, message }] } and the file is untouched; a valid one → 200 { job, reconcile }', async () => {
    await withSchedules('', true, async c => {
      const text = job();
      const file = writeJob(c, 'x', text);
      const bad = await send(c.h, 'PUT', '/api/schedules/x', { text: '---\ncron: nonsense\nmachines: [mac]\nrun: claude\n---\nhi\n' });
      assert.strictEqual(bad.status, 422);
      const errors = bad.json?.errors as Array<{ line: number; message: string }>;
      assert.ok(errors.length > 0 && errors.every(e => typeof e.line === 'number' && typeof e.message === 'string'), JSON.stringify(errors));
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text);

      const next = job({ extra: ['model: sonnet'] });
      const ok = await send(c.h, 'PUT', '/api/schedules/x', { text: next });
      assert.strictEqual(ok.status, 200, ok.raw);
      assert.strictEqual((ok.json?.job as { model?: string }).model, 'sonnet');
      assert.strictEqual((ok.json?.reconcile as { state?: string }).state, 'no-plugin');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), next);

      assert.strictEqual((await send(c.h, 'PUT', '/api/schedules/ghost', { text: next })).status, 404, 'PUT never creates');
      assert.ok(!fs.existsSync(path.join(c.schedules, 'ghost.md')));
      assert.strictEqual((await send(c.h, 'PUT', '/api/schedules/x', { nope: 1 })).status, 400);
    });
  }));

  tally(await testAsync('PUT, POST and /validate run checkPins against the current pins: an ambiguous foreach name is a 422 / an error', async () => {
    await withSchedules('', true, async c => {
      plantAmbiguousPins(c.h);
      const text = job({ extra: ['foreach: [repo]'] });
      const original = job();
      const file = writeJob(c, 'x', original);
      const put = await send(c.h, 'PUT', '/api/schedules/x', { text });
      assert.strictEqual(put.status, 422, put.raw);
      assert.match(JSON.stringify(put.json?.errors), /repo is ambiguous/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
      const post = await send(c.h, 'POST', '/api/schedules', { name: 'y', text });
      assert.strictEqual(post.status, 422);
      assert.ok(!fs.existsSync(path.join(c.schedules, 'y.md')));
      const v = await send(c.h, 'POST', '/api/schedules/validate', { text });
      assert.strictEqual(v.status, 200);
      assert.match(JSON.stringify(v.json?.errors), /repo is ambiguous/);
      assert.strictEqual(v.json?.summary, null);
    });
  }));

  tally(await testAsync('a name `../x` or `Runs` on PUT, PATCH, DELETE, /run, /stop and /reveal → 400 bad name, nothing on disk touched', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'x', job());
      fs.writeFileSync(path.join(c.h.home, 'x.md'), 'outside');
      const before = listing(c.schedules);
      for (const name of ['../x', 'Runs']) {
        const seg = encodeURIComponent(name);
        const cases: Array<[string, string, unknown]> = [
          ['PUT', `/api/schedules/${seg}`, { text: job() }],
          ['PATCH', `/api/schedules/${seg}`, { enabled: false }],
          ['DELETE', `/api/schedules/${seg}`, undefined],
          ['POST', `/api/schedules/${seg}/run`, {}],
          ['POST', `/api/schedules/${seg}/stop`, undefined],
          ['POST', '/api/schedules/reveal', { name }]
        ];
        for (const [method, url, body] of cases) {
          const r = await send(c.h, method, url, body);
          assert.strictEqual(r.status, 400, `${method} ${url}: ${r.raw}`);
          assert.deepStrictEqual(r.json, { error: 'bad name' }, `${method} ${url}`);
        }
      }
      assert.deepStrictEqual(listing(c.schedules), before);
      assert.strictEqual(fs.readFileSync(path.join(c.h.home, 'x.md'), 'utf8'), 'outside');
    });
  }));

  tally(await testAsync('POST: { name: "runs" } → 422 name is reserved; an existing name → 409; a new one is written', async () => {
    await withSchedules('', true, async c => {
      const reserved = await send(c.h, 'POST', '/api/schedules', { name: 'runs', text: job() });
      assert.strictEqual(reserved.status, 422, reserved.raw);
      assert.deepStrictEqual(reserved.json?.errors, [{ line: 0, message: 'name is reserved' }]);
      assert.ok(!fs.existsSync(path.join(c.schedules, 'runs.md')));

      const text = job();
      const made = await send(c.h, 'POST', '/api/schedules', { name: 'x', text });
      assert.strictEqual(made.status, 200, made.raw);
      assert.strictEqual(fs.readFileSync(path.join(c.schedules, 'x.md'), 'utf8'), text);
      const again = await send(c.h, 'POST', '/api/schedules', { name: 'x', text: job({ enabled: false }) });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(fs.readFileSync(path.join(c.schedules, 'x.md'), 'utf8'), text);
      assert.strictEqual((await send(c.h, 'POST', '/api/schedules', { name: 'y' })).status, 400);
    });
  }));

  tally(await testAsync('PATCH { enabled: false }: the file diff is exactly the enabled: line', async () => {
    await withSchedules('', true, async c => {
      const text = job({ extra: ['# keep me', 'model: sonnet'] });
      const file = writeJob(c, 'x', text);
      const r = await send(c.h, 'PATCH', '/api/schedules/x', { enabled: false });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual((r.json?.job as { enabled?: boolean }).enabled, false);
      const before = text.split('\n');
      const after = fs.readFileSync(file, 'utf8').split('\n');
      assert.strictEqual(after.length, before.length);
      const changed = before.map((l, i) => [l, after[i]] as const).filter(([a, b]) => a !== b);
      assert.deepStrictEqual(changed, [['enabled: true', 'enabled: false']]);
      assert.strictEqual((await send(c.h, 'PATCH', '/api/schedules/x', { enabled: 'no' })).status, 400);
      assert.strictEqual((await send(c.h, 'PATCH', '/api/schedules/ghost', { enabled: true })).status, 404);
      const broken = '---\ncron: nonsense\nenabled: true\n---\nx\n';
      const brokenFile = writeJob(c, 'broken', broken);
      const unparsed = await send(c.h, 'PATCH', '/api/schedules/broken', { enabled: false });
      assert.strictEqual(unparsed.status, 422, unparsed.raw);
      assert.ok((unparsed.json?.errors as unknown[]).length > 0);
      assert.strictEqual(fs.readFileSync(brokenFile, 'utf8'), broken, 'a file that does not parse is left as it was');
    });
  }));

  tally(await testAsync('DELETE removes the file and the log rows remain', async () => {
    await withSchedules('', true, async c => {
      const file = writeJob(c, 'x', job());
      logRun(c, 'x-1', 'x', DAY);
      const r = await send(c.h, 'DELETE', '/api/schedules/x');
      assert.strictEqual(r.status, 200, r.raw);
      assert.ok(!fs.existsSync(file));
      const runs = (await send(c.h, 'GET', '/api/schedules/runs?job=x')).json as unknown as ScheduleRunsResponse;
      assert.deepStrictEqual(runs.runs.map(x => x.id), ['x-1']);
      assert.strictEqual((await send(c.h, 'DELETE', '/api/schedules/x')).status, 404);
    });
  }));

  tally(await testAsync('POST /api/schedules/validate is reachable without write trust and writes nothing', async () => {
    await withSchedules('ANSWER_TOKEN=s3cret\n', false, async c => {
      const r = await send(c.h, 'POST', '/api/schedules/validate', { text: job() }, UNTRUSTED);
      assert.strictEqual(r.status, 200, r.raw);
      assert.deepStrictEqual(r.json?.errors, []);
      assert.match(String(r.json?.summary), /claude/);
      assert.deepStrictEqual(listing(c.schedules), []);
      const bad = await send(c.h, 'POST', '/api/schedules/validate', { text: '---\ncron: x\n---\n' }, UNTRUSTED);
      assert.strictEqual(bad.json?.summary, null);
      assert.ok((bad.json?.errors as unknown[]).length > 0);
    });
  }));

  const writes = (name: string): Array<[string, string, unknown]> => [
    ['POST', '/api/schedules', { name: 'y', text: job() }],
    ['PUT', `/api/schedules/${name}`, { text: job() }],
    ['PATCH', `/api/schedules/${name}`, { enabled: false }],
    ['DELETE', `/api/schedules/${name}`, undefined],
    ['POST', '/api/schedules/reconcile', { apply: true }],
    ['POST', `/api/schedules/${name}/run`, {}],
    ['POST', `/api/schedules/${name}/stop`, undefined],
    ['POST', '/api/schedules/reveal', {}]
  ];

  tally(await testAsync('every other schedule write → 403 without trust, on the owner too, and nothing changes', async () => {
    await withSchedules('ANSWER_TOKEN=s3cret\n', true, async c => {
      const text = job();
      const file = writeJob(c, 'x', text);
      for (const [method, url, body] of writes('x')) {
        const r = await send(c.h, method, url, body, UNTRUSTED);
        assert.strictEqual(r.status, 403, `${method} ${url}: ${r.raw}`);
        assert.strictEqual(r.json?.error, 'bad token', `${method} ${url}`);
      }
      assert.deepStrictEqual(listing(c.schedules), ['x.md']);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
    });
  }));

  tally(await testAsync('every other schedule write → 409 not-owner on a trusted non-owner, and nothing changes', async () => {
    await withSchedules('', false, async c => {
      overrideOpenFolder({ platform: 'darwin', run: async () => { throw new Error('must not open'); } });
      const text = job();
      const file = writeJob(c, 'x', text);
      for (const [method, url, body] of writes('x')) {
        const r = await send(c.h, method, url, body);
        assert.strictEqual(r.status, 409, `${method} ${url}: ${r.raw}`);
        assert.deepStrictEqual(r.json, { error: 'not-owner' }, `${method} ${url}`);
      }
      assert.deepStrictEqual(listing(c.schedules), ['x.md']);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
    });
  }));

  tally(await testAsync('POST /reconcile: the plan, or the applied report with apply: true', async () => {
    await withSchedules('', true, async c => {
      const planned = await send(c.h, 'POST', '/api/schedules/reconcile', {});
      assert.strictEqual(planned.status, 200, planned.raw);
      assert.strictEqual(planned.json?.state, 'no-plugin');
      const applied = await send(c.h, 'POST', '/api/schedules/reconcile', { apply: true });
      assert.strictEqual(applied.status, 200);
      assert.strictEqual(applied.json?.state, 'no-plugin');
    });
  }));

  tally(await testAsync('POST /reveal → 501 off darwin; on darwin the folder, or `open -R` on a named job file; 404 for no file or no folder', async () => {
    await withSchedules('', true, async c => {
      const opened: string[][] = [];
      overrideOpenFolder({ platform: 'linux', run: async (cmd, args) => { opened.push([cmd, ...args]); } });
      const off = await send(c.h, 'POST', '/api/schedules/reveal', {});
      assert.strictEqual(off.status, 501, off.raw);
      overrideOpenFolder({ platform: 'darwin' });
      const folder = await send(c.h, 'POST', '/api/schedules/reveal', {});
      assert.strictEqual(folder.status, 200, folder.raw);
      const file = writeJob(c, 'x', job());
      const named = await send(c.h, 'POST', '/api/schedules/reveal', { name: 'x' });
      assert.strictEqual(named.status, 200, named.raw);
      assert.deepStrictEqual(opened, [['open', c.schedules], ['open', '-R', file]]);
      assert.deepStrictEqual([(await send(c.h, 'POST', '/api/schedules/reveal', { name: 'ghost' })).status, opened.length], [404, 2]);
      assert.deepStrictEqual([(await send(c.h, 'POST', '/api/schedules/reveal', { name: 7 })).status, opened.length], [400, 2]);
      fs.rmSync(c.schedules, { recursive: true });
      assert.strictEqual((await send(c.h, 'POST', '/api/schedules/reveal', {})).status, 404);
      assert.strictEqual(opened.length, 2);
    });
  }));

  tally(await testAsync('POST /:name/run fails closed: malformed JSON, an over-cap body, a non-object body and `only: []` → 400 and nothing is spawned', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'x', job());
      const calls = installAndSpawn(c);
      try {
        const malformed = await send(c.h, 'POST', '/api/schedules/x/run', '{"only":');
        assert.strictEqual(malformed.status, 400, malformed.raw);
        const big = await send(c.h, 'POST', '/api/schedules/x/run', JSON.stringify({ only: ['a'], pad: 'x'.repeat(70 * 1024) }));
        assert.strictEqual(big.status, 400, big.raw);
        assert.strictEqual((await send(c.h, 'POST', '/api/schedules/x/run', [1])).status, 400);
        assert.strictEqual((await send(c.h, 'POST', '/api/schedules/x/run', 'null')).status, 400);
        const empty = await send(c.h, 'POST', '/api/schedules/x/run', { only: [] });
        assert.deepStrictEqual([empty.status, empty.json], [400, { error: 'bad-only' }]);
        assert.deepStrictEqual(calls, [], 'a refused body never reaches the spawner');
      } finally {
        setSpawner(null);
      }
    });
  }));

  tally(await testAsync('POST /:name/run: an empty body or one without `only` is a whole run; `only` passes through as --only', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'x', job());
      const calls = installAndSpawn(c);
      try {
        const bare = await send(c.h, 'POST', '/api/schedules/x/run');
        assert.deepStrictEqual([bare.status, bare.json], [202, { run: 'r-1' }], bare.raw);
        assert.strictEqual((await send(c.h, 'POST', '/api/schedules/x/run', {})).status, 202);
        const some = await send(c.h, 'POST', '/api/schedules/x/run', { only: ['repo-a'] });
        assert.strictEqual(some.status, 202, some.raw);
        assert.strictEqual(calls.length, 3);
        assert.ok(!calls[0].includes('--only') && !calls[1].includes('--only'), calls[0].join(' '));
        assert.deepStrictEqual(calls[2].slice(-2), ['--only', 'repo-a']);
      } finally {
        setSpawner(null);
      }
    });
  }));

  tally(await testAsync('POST /:name/run maps runJob: 409 no-plugin before any spawn, 400 for an over-long only, 404 for no file; /stop → 409 not-running', async () => {
    await withSchedules('', true, async c => {
      writeJob(c, 'x', job());
      const r = await send(c.h, 'POST', '/api/schedules/x/run', {});
      assert.strictEqual(r.status, 409, r.raw);
      assert.deepStrictEqual(r.json, { error: 'no-plugin' });
      const long = await send(c.h, 'POST', '/api/schedules/x/run', { only: Array.from({ length: 201 }, (_, i) => `p${i}`) });
      assert.deepStrictEqual([long.status, long.json], [400, { error: 'bad-only' }]);
      assert.strictEqual((await send(c.h, 'POST', '/api/schedules/ghost/run', {})).status, 404);
      const stop = await send(c.h, 'POST', '/api/schedules/x/stop');
      assert.deepStrictEqual([stop.status, stop.json], [409, { error: 'not-running' }]);
      assert.strictEqual((await send(c.h, 'GET', '/api/schedules/x/run')).status, 405);
    });
  }));

  tally(await testAsync('/api/schedules/:name answers 405 with its Allow list for any other method', async () => {
    await withSchedules('', true, async c => {
      const r = await send(c.h, 'POST', '/api/schedules/x', {});
      assert.strictEqual(r.status, 405);
      assert.strictEqual(r.headers.allow, 'GET, PUT, PATCH, DELETE');
    });
  }));

  tally(await testAsync('GET /api/sessions/:id/row: a transcript older than the lookback still answers a Session; unknown id 404; commandOnly not 404', async () => {
    await withSchedules('', false, async c => {
      const file = c.h.plant('old-run', [
        userRecord('u1', 'run the sync', c.h.home),
        {
          type: 'assistant', timestamp: '2026-07-01T10:00:05Z',
          message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10 } }
        }
      ]);
      const at = (Date.now() - 30 * DAY) / 1000;
      fs.utimesSync(file, at, at);
      const listed = await send(c.h, 'GET', '/api/sessions');
      assert.ok(!(listed.json?.sessions as Session[]).some(s => s.id === 'old-run'), 'the list leaves it out');
      const r = await send(c.h, 'GET', '/api/sessions/old-run/row');
      assert.strictEqual(r.status, 200, r.raw);
      const row = r.json as unknown as Session;
      assert.strictEqual(row.id, 'old-run');
      assert.strictEqual(row.status, 'idle');
      assert.strictEqual((await send(c.h, 'GET', '/api/sessions/nope/row')).status, 404);

      c.h.plant('login-only', [{ type: 'user', timestamp: '2026-07-01T10:00:00Z', cwd: c.h.home, message: { role: 'user', content: '<command-name>/login</command-name>' } }]);
      const cmd = await send(c.h, 'GET', '/api/sessions/login-only/row');
      assert.strictEqual(cmd.status, 200, cmd.raw);
      assert.strictEqual((cmd.json as unknown as Session).id, 'login-only');
    });
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
