/**
 * server/lib/schedule-boot.ts — what a server does for scheduled workflows on listen and on a signal, driven with a fake `deps` so nothing here sweeps,
 * reconciles or watches for real; plus the pins hook in `servePinsWrite` / `servePinsOrder`, through the real router.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { testAsync, userRecord, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import type { Config } from '../server/lib/config.js';
import { encodeProjectDir, overrideClaudeRoots } from '../server/lib/management.js';
import { defaultDeps, ownerStatus, resetScheduleBoot, startSchedules, stopSchedules } from '../server/lib/schedule-boot.js';
import type { ScheduleDeps } from '../server/lib/schedule-boot.js';
import { claimOwner, releaseOwner } from '../server/lib/schedule-store.js';
import type { Probe } from '../server/lib/schedule-store.js';
import { resetSettings } from '../server/lib/settings.js';
import type { ScheduleRun } from '../shared/types.js';

const NO_PROBE: Probe = { alive: () => false, command: () => null };

const runOf = (id: string): ScheduleRun => ({
  id, job: 'x', machine: 'mac', trigger: 'schedule', startedAt: '2026-10-19T09:00:00.000Z', endedAt: '2026-10-19T09:00:01.000Z', ms: 1000, late: false,
  state: 'failed', ok: 0, failed: 1, skipped: 0, total: 1, stopped: false, error: null, why: null, steps: []
});

interface Fake {
  deps: ScheduleDeps;
  calls: string[];
  sent: string[];
  /** The runs watcher's callback, once `watch` was called. */
  fire: () => void;
  setRuns: (runs: ScheduleRun[]) => void;
}

function fakeDeps(claim: 'owner' | { ownedBy: string } = 'owner'): Fake {
  const calls: string[] = [];
  const sent: string[] = [];
  let runs: ScheduleRun[] = [runOf('r1')];
  let onChange: (() => void) | null = null;
  const rec = (name: string) => (): void => { calls.push(name); };
  const deps: ScheduleDeps = {
    claimOwner: () => { calls.push('claimOwner'); return claim; },
    sweepLocks: () => { calls.push('sweepLocks'); return []; },
    writePinsSnapshot: rec('writePinsSnapshot'),
    rotateIfLarge: () => { calls.push('rotateIfLarge'); return []; },
    applyReconcile: async () => { calls.push('applyReconcile'); return { state: 'in-sync', changes: [], unchanged: 0, error: null, at: '' }; },
    startReconcileWatchers: rec('startReconcileWatchers'),
    stopReconcileWatchers: rec('stopReconcileWatchers'),
    createLogReader: () => {
      calls.push('createLogReader');
      return {
        read: () => runs,
        watch: (cb: () => void) => { calls.push('watch'); onChange = cb; return () => { calls.push('unwatch'); }; }
      };
    },
    seedScheduleNotify: () => { calls.push('seedScheduleNotify'); return 0; },
    // The real fold pushes each new pushable run through `send`; this one pushes every run it is handed, to prove `send` is the deps' one.
    notifyScheduleRuns: (config, rs, send = defaultDeps.sendScheduleEvent) => {
      calls.push('notifyScheduleRuns');
      for (const r of rs) send({ run: r, title: r.id, body: '' }, config);
      return rs.length;
    },
    sendScheduleEvent: (event) => { sent.push(event.run.id); return true; },
    releaseOwner: rec('releaseOwner')
  };
  return { deps, calls, sent, fire: () => onChange?.(), setRuns: (r) => { runs = r; } };
}

/** A config with its own `$HOME`, so `scheduleDirs` resolves somewhere harmless even though every call is faked. */
function withHome(owner: boolean, fn: (config: Config) => Promise<void> | void): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-boot-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  resetScheduleBoot();
  const config = { port: 4173, schedulesDir: '~/schedules', scheduleMachine: 'mac', schedulesOwner: owner, schedulesStateRoot: '' } as Config;
  return Promise.resolve()
    .then(() => fn(config))
    .finally(() => {
      stopSchedules();
      resetScheduleBoot();
      if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    });
}

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\nSCHEDULES_DIR=~/schedules\nSCHEDULE_MACHINE=mac\n';

/** A pinnable project under the harness `$HOME`. */
function plantProject(h: Harness, name: string): string {
  const cwd = path.join(h.home, 'projs', name);
  fs.mkdirSync(cwd, { recursive: true });
  const dirName = encodeProjectDir(cwd);
  const dir = path.join(h.home, '.claude', 'projects', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-1.jsonl`), JSON.stringify(userRecord(`${name}-u1`, 'hi', cwd)) + '\n');
  return dirName;
}

async function withPinsServer(owner: boolean, fn: (h: Harness, pinsFile: string) => Promise<void>): Promise<void> {
  overrideClaudeRoots([]);
  try {
    await withServer(ENV + (owner ? 'SCHEDULES_OWNER=true\n' : ''), async h => {
      resetSettings();
      if (owner) assert.strictEqual(claimOwner(h.cfg, NO_PROBE), 'owner');
      try { await fn(h, path.join(h.home, '.claude', 'schedules', 'pins.json')); } finally { releaseOwner(); resetSettings(); }
    });
  } finally {
    overrideClaudeRoots(null);
  }
}

export async function run(): Promise<number> {
  console.log('\n=== schedule boot (startSchedules / stopSchedules, pins hook) ===\n');
  let p = 0;
  let f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(await testAsync('owner: the seven calls in order (pins before reconcile), then the runs watcher folds and pushes through the deps', async () => {
    await withHome(true, async config => {
      const fake = fakeDeps();
      startSchedules(config, fake.deps);
      assert.deepStrictEqual(fake.calls, [
        'claimOwner', 'sweepLocks', 'writePinsSnapshot', 'rotateIfLarge', 'applyReconcile', 'startReconcileWatchers',
        'createLogReader', 'seedScheduleNotify', 'notifyScheduleRuns', 'watch'
      ]);
      assert.deepStrictEqual(fake.sent, ['r1']);
      fake.setRuns([runOf('r1'), runOf('r2')]);
      fake.fire();
      assert.deepStrictEqual(fake.calls.slice(-1), ['notifyScheduleRuns'], 'a write to runs/ folds again');
      assert.deepStrictEqual(fake.sent, ['r1', 'r1', 'r2']);
    });
  }));

  tally(await testAsync('SCHEDULES_OWNER unset: zero calls, and ownerStatus reads { ownedBy: "" }', async () => {
    await withHome(false, config => {
      const fake = fakeDeps();
      startSchedules(config, fake.deps);
      assert.deepStrictEqual(fake.calls, []);
      assert.deepStrictEqual(ownerStatus(), { ownedBy: '' });
      stopSchedules();
      assert.deepStrictEqual(fake.calls, [], 'stop on a non-owner touches nothing');
    });
  }));

  tally(await testAsync('SCHEDULES_OWNER=true but the claim is lost: claimOwner is the only call; ownerStatus names the holder', async () => {
    await withHome(true, config => {
      const fake = fakeDeps({ ownedBy: 'pid 4242 on :5174' });
      startSchedules(config, fake.deps);
      assert.deepStrictEqual(fake.calls, ['claimOwner']);
      assert.deepStrictEqual(ownerStatus(), { ownedBy: 'pid 4242 on :5174' });
      stopSchedules();
      assert.deepStrictEqual(fake.calls, ['claimOwner']);
    });
  }));

  tally(await testAsync('stopSchedules: the runs watcher and reconcile watchers off, the owner file released; a second stop is a no-op', async () => {
    await withHome(true, config => {
      const fake = fakeDeps();
      startSchedules(config, fake.deps);
      fake.calls.length = 0;
      stopSchedules();
      assert.deepStrictEqual(fake.calls, ['unwatch', 'stopReconcileWatchers', 'releaseOwner']);
      stopSchedules();
      assert.strictEqual(fake.calls.length, 3);
    });
  }));

  tally(await testAsync('a step that throws is logged and the rest still run', async () => {
    await withHome(true, config => {
      const fake = fakeDeps();
      fake.deps.sweepLocks = () => { fake.calls.push('sweepLocks'); throw new Error('boom'); };
      const err = console.error;
      console.error = () => {};
      try { startSchedules(config, fake.deps); } finally { console.error = err; }
      assert.ok(fake.calls.includes('applyReconcile') && fake.calls.includes('watch'), fake.calls.join(','));
    });
  }));

  tally(await testAsync('a pins write through servePinsWrite and servePinsOrder rewrites pins.json on the owner', async () => {
    await withPinsServer(true, async (h, pinsFile) => {
      const a = plantProject(h, 'alpha');
      const b = plantProject(h, 'beta');
      assert.strictEqual((await h.req('/api/pins', { method: 'POST', body: JSON.stringify({ dirName: a, pinned: true }) })).status, 200);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(pinsFile, 'utf8')).map((r: { dirName: string }) => r.dirName), [a]);
      await h.req('/api/pins', { method: 'POST', body: JSON.stringify({ dirName: b, pinned: true }) });
      const order = await h.req('/api/pins/order', { method: 'POST', body: JSON.stringify({ order: [b, a] }) });
      assert.strictEqual(order.status, 200, order.raw);
      const snap = JSON.parse(fs.readFileSync(pinsFile, 'utf8')) as Array<{ dirName: string; name: string; listed: boolean }>;
      assert.deepStrictEqual(snap.map(r => r.dirName), [b, a]);
      assert.deepStrictEqual(snap.map(r => [r.name, r.listed]), [['beta', true], ['alpha', true]]);
    });
  }));

  tally(await testAsync('a pins write on a non-owner leaves pins.json alone', async () => {
    await withPinsServer(false, async (h, pinsFile) => {
      const a = plantProject(h, 'alpha');
      assert.strictEqual((await h.req('/api/pins', { method: 'POST', body: JSON.stringify({ dirName: a, pinned: true }) })).status, 200);
      assert.ok(!fs.existsSync(pinsFile));
    });
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
