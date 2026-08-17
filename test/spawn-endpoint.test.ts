/**
 * The two runtime rails around `POST /api/spawn` — the ones that live in the
 * handler rather than in `server/lib/spawn.ts`, so the store's own tests can't
 * see them:
 *
 *   1. the remote-answer toggle gate (the app's only runtime kill switch —
 *      spawn used to be the one write path it did not cover), and
 *   2. `MAX_LAUNCHING`, the concurrency cap that answers 429.
 *
 * Both are exercised against the real handler over a real socket. No test here
 * spawns a `claude` binary: the launch store is pre-filled through `launch()`
 * with the `setSpawner` fake, and every request either stops at a gate or dies
 * on a deliberately malformed body — so nothing reaches `resolveProject`, the
 * filesystem, or a child process.
 */

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { serveSpawn, serveSpawnStop } from '../server/api.js';
import { loadConfig } from '../server/lib/config.js';
import { resetState } from '../server/lib/remoteState.js';
import {
  MAX_LAUNCHING, adoptLaunched, launch, listLaunching, resetLaunches, resetSpawnProbe, setSpawner
} from '../server/lib/spawn.js';
import type { Spawner } from '../server/lib/spawn.js';
import type { ChildProcess } from 'node:child_process';
import type { ProjectRef } from '../shared/types.js';

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Reply = { status: number; json: { error?: string; stopped?: boolean } | null };

/**
 * POST `body` to a one-shot server running `handler`, and return the reply.
 * Same shape (and same `settle`-exactly-once guard) as `api-body.test.ts`'s
 * helper: a refused body is answered while the client may still be uploading,
 * so the request stream can legitimately error after the response was read in
 * full, and a bare `http.request` has no default `'error'` listener — that late
 * error would otherwise kill the whole `pnpm test` process.
 */
function post(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, body: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      srv.close();
      fn();
    };
    srv.on('error', e => settle(() => reject(e)));
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      const req = http.request(
        { port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } },
        res => {
          let raw = '';
          res.on('data', c => { raw += c; });
          res.on('end', () => {
            const json = (() => { try { return JSON.parse(raw); } catch { return null; } })();
            settle(() => resolve({ status: res.statusCode || 0, json }));
          });
          res.on('error', e => settle(() => reject(e)));
        }
      );
      req.on('error', e => settle(() => reject(e)));
      req.end(body);
    });
  });
}

/**
 * Config from a throwaway `.env` (so a developer's real one can't leak in),
 * with cwd moved to a throwaway directory: `remoteState.getState` resolves the
 * toggle from `.remote-answer.json` in cwd, and the repo's own file must not
 * decide the outcome of a test.
 */
async function withEnv(body: string, fn: (cfg: ReturnType<typeof loadConfig>) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-spawn-ep-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, body);
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    resetState();
    resetLaunches();
    resetSpawnProbe();
    await fn(loadConfig({ envPath }));
  } finally {
    process.chdir(prevCwd);
    resetState();
    resetLaunches();
    resetSpawnProbe();
    setSpawner(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A child that never exits on its own — enough to hold a store slot, to be
 * `kill`ed by `stopLaunch`, and (being an `EventEmitter`) to be *told* to exit
 * so a test can drive an entry into the `failed` state. Exactly the surface
 * `launch`/`stopLaunch` touch; `spawn.test.ts` owns the fuller fake.
 */
class FakeChild extends EventEmitter {
  stdin = new EventEmitter() as EventEmitter & { write(c: string): boolean; end(): void };
  stderr = new EventEmitter();
  constructor() {
    super();
    this.stdin.write = (): boolean => true;
    this.stdin.end = (): void => undefined;
  }
  kill(): boolean { return true; }
  unref(): this { return this; }
}

/** A `Spawner` handing back a fresh {@link FakeChild}, appended to `children`. */
function fakeSpawner(children: FakeChild[] = []): Spawner {
  return () => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  };
}

const REF: ProjectRef = {
  dirName: 'enc-demo', name: 'demo-project', path: os.tmpdir(), lastActiveMs: Date.now()
};

/** Malformed on purpose: every request below must be decided before the body matters. */
const BAD_BODY = '{not json';

export async function run(): Promise<number> {
  console.log('\n=== spawn endpoints (api.ts) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* ------------------------------------------------- the remote-answer toggle */

  check(await testAsync('POST /api/spawn is 404 "remote answers disabled" when the toggle is off', async () => {
    // CLAUDE_BIN is deliberately a working binary here: the feature is fully
    // configured, so the only thing that can produce this answer is the gate.
    await withEnv('CLAUDE_BIN=/bin/echo\nREMOTE_ANSWER=false\n', async cfg => {
      const reply = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(reply.status, 404);
      assert.equal(reply.json?.error, 'remote answers disabled');
    });
  }));

  check(await testAsync('POST /api/spawn/:id/stop is 404 "remote answers disabled" when the toggle is off', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\nREMOTE_ANSWER=false\n', async cfg => {
      const reply = await post((req, res) => serveSpawnStop(cfg, 'no-such-id', req, res), '');
      assert.equal(reply.status, 404);
      // Not the "no live launch" 404 the same request gets with the toggle on —
      // the two are distinguishable, which is what makes this discriminating.
      assert.equal(reply.json?.error, 'remote answers disabled');
    });
  }));

  check(await testAsync('with the toggle on, the same stop request reaches the store (404 "no live launch")', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const reply = await post((req, res) => serveSpawnStop(cfg, 'no-such-id', req, res), '');
      assert.equal(reply.status, 404);
      assert.equal(reply.json?.error, 'no live launch');
    });
  }));

  check(await testAsync('with the toggle on, a live launch is stopped: 200 {stopped:true}', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const id = launch(cfg, REF, { prompt: 'hold a slot', permissionMode: 'auto' });
      const reply = await post((req, res) => serveSpawnStop(cfg, id, req, res), '');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.stopped, true);
      assert.equal(listLaunching().length, 0);
    });
  }));

  /* --------------------------------------------------------- MAX_LAUNCHING cap */

  check(await testAsync('the cap is 4 — the number the ruling fixed, not whatever the code drifts to', async () => {
    assert.equal(MAX_LAUNCHING, 4);
  }));

  check(await testAsync(`${MAX_LAUNCHING - 1} launches in flight: the request is NOT capped`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      for (let i = 0; i < MAX_LAUNCHING - 1; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      assert.equal(listLaunching().length, MAX_LAUNCHING - 1);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      // It fails on the malformed body instead — i.e. it got past the cap.
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'bad body');
    });
  }));

  check(await testAsync(`${MAX_LAUNCHING} launches in flight: 429 "too many launches in flight"`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      assert.equal(listLaunching().length, MAX_LAUNCHING);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(reply.status, 429);
      assert.equal(reply.json?.error, 'too many launches in flight');
    });
  }));

  // The correction to the cap's first cut: `listLaunching()` also returns
  // `failed` rows, which linger for FAIL_TTL_MS (5 min) purely so the UI can
  // explain itself and hold no process at all. Counting them would lock a user
  // out of launching for five minutes after four transient failures, behind a
  // 429 that explains nothing.
  check(await testAsync(`${MAX_LAUNCHING} entries but one has failed: NOT capped — a failed row holds no process`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      children[0].emit('exit', 1, null);

      // Still four rows in the store — the failed one is retained for display.
      assert.equal(listLaunching().length, MAX_LAUNCHING);
      assert.equal(listLaunching().filter(e => e.state === 'failed').length, 1);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(reply.status, 400, 'the failed row must not hold a slot');
      assert.equal(reply.json?.error, 'bad body');
    });
  }));

  check(await testAsync(`all ${MAX_LAUNCHING} failing frees the cap entirely`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      const capped = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(capped.status, 429, 'four live children do cap it');

      for (const child of children) child.emit('exit', 1, null);
      assert.equal(listLaunching().filter(e => e.state === 'launching').length, 0);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(reply.status, 400, 'no live launches left, so nothing to cap');
    });
  }));

  check(await testAsync('the cap frees up as entries leave the store (adopted or stopped)', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const ids: string[] = [];
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        ids.push(launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' }));
      }
      const capped = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(capped.status, 429);

      // One session shows up on disk — the ordinary way an entry leaves.
      assert.equal(listLaunching().length, MAX_LAUNCHING);
      const freed = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(freed.status, 429, 'still capped until something is adopted');

      assert.equal(adoptLaunched([ids[0]]), 1);
      const after = await post((req, res) => void serveSpawn(cfg, req, res), BAD_BODY);
      assert.equal(after.status, 400, 'a freed slot lets the next launch through');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
