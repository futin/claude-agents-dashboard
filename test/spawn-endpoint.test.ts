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

import { serveSessionStop, serveSpawn, serveSpawnStop } from '../server/api.js';
import { loadConfig } from '../server/lib/config.js';
import { register as registerMessage, resetStore as resetMessages } from '../server/lib/messages.js';
import { resetState } from '../server/lib/remoteState.js';
import {
  LAUNCH_TTL_MS, MAX_LAUNCHING, adoptLaunched, launch, listLaunching, resetLaunches,
  resetSpawnProbe, setGroupKiller, setSpawner
} from '../server/lib/spawn.js';
import { withServer } from './api-harness.js';
import type { Spawner } from '../server/lib/spawn.js';
import type { ChildProcess } from 'node:child_process';
import type { ProjectRef } from '../shared/types.js';

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

type Reply = { status: number; json: { error?: string; stopped?: boolean; stopping?: boolean } | null };

/**
 * POST `body` to a one-shot server running `handler`, and return the reply.
 * Same shape (and same `settle`-exactly-once guard) as `api-body.test.ts`'s
 * helper: a refused body is answered while the client may still be uploading,
 * so the request stream can legitimately error after the response was read in
 * full, and a bare `http.request` has no default `'error'` listener — that late
 * error would otherwise kill the whole `pnpm test` process.
 */
function post(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  body: string,
  headers: Record<string, string> = {}
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
        { port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', ...headers } },
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
 * `kill`ed by `stopSession`, and (being an `EventEmitter`) to be *told* to exit
 * so a test can drive an entry into the `failed` state. Exactly the surface
 * `launch`/`stopSession` touch; `spawn.test.ts` owns the fuller fake.
 */
class FakeChild extends EventEmitter {
  stdin = new EventEmitter() as EventEmitter & { write(c: string): boolean; end(): void };
  stderr = new EventEmitter();
  /** The three fields the store's signal guard reads; see `spawn.test.ts`'s fuller fake. */
  pid: number | undefined = FAKE_PID;
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor() {
    super();
    this.stdin.write = (): boolean => true;
    this.stdin.end = (): void => undefined;
  }
  kill(): boolean { return true; }
  unref(): this { return this; }
}

/** A plausible pid for a fake child. Never reaches the real `process.kill` — every stop test installs `setGroupKiller`. */
const FAKE_PID = 4242;

/** One recorded group signal: pid as `process.kill` would receive it (negated), and the signal. */
interface KillCall { pid: number; signal: string; }

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

  /* --------------------------------------------------------------- resume */

  // A fixed uuid pair for the resume fixtures below.
  const RES_ID = '22222222-2222-4222-8222-222222222222';
  const LOCAL_ID = '33333333-3333-4333-8333-333333333333';

  /**
   * Point `projectsRoot()` (which reads `os.homedir()`, and POSIX node reads
   * `$HOME`) at a throwaway home containing exactly the transcripts a test
   * plants: RES_ID as a dashboard (`sdk-cli`) session whose cwd is the fake
   * home itself, LOCAL_ID as a terminal (`cli`) one.
   */
  async function withResumeHome(
    envBody: string, fn: (cfg: ReturnType<typeof loadConfig>) => Promise<void>
  ): Promise<void> {
    await withEnv(envBody, async cfg => {
      const home = process.cwd(); // withEnv already chdir'd to a fresh tmpdir
      const proj = path.join(home, '.claude', 'projects', '-fake-proj');
      fs.mkdirSync(proj, { recursive: true });
      const rec = (entrypoint: string): string => JSON.stringify({
        entrypoint, cwd: home, timestamp: '2026-08-22T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      }) + '\n';
      fs.writeFileSync(path.join(proj, `${RES_ID}.jsonl`), rec('sdk-cli'));
      fs.writeFileSync(path.join(proj, `${LOCAL_ID}.jsonl`), rec('cli'));
      const prevHome = process.env.HOME;
      try {
        process.env.HOME = home;
        resetMessages();
        await fn(cfg);
      } finally {
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        resetMessages();
      }
    });
  }

  check(await testAsync('resume of an unknown session id is 400 — never a fresh launch in disguise', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const body = JSON.stringify({ prompt: 'continue', resume: '44444444-4444-4444-8444-444444444444' });
      const reply = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'unknown session');
      assert.equal(listLaunching().length, 0, 'nothing may have spawned');
    });
  }));

  check(await testAsync('resume of a terminal (non-dashboard) session is 400 — terminal sessions stay terminal-owned', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const body = JSON.stringify({ prompt: 'continue', resume: LOCAL_ID });
      const reply = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'only dashboard sessions can be resumed');
      assert.equal(listLaunching().length, 0);
    });
  }));

  check(await testAsync('resume while the session still holds a reply window is 409 — it is alive, not stale', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      registerMessage(RES_ID, 60_000, () => undefined);
      const body = JSON.stringify({ prompt: 'continue', resume: RES_ID });
      const reply = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(reply.status, 409);
      assert.equal(reply.json?.error, 'session is still running');
      assert.equal(listLaunching().length, 0);
    });
  }));

  check(await testAsync('a second resume of the same session while one is launching is 409', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const body = JSON.stringify({ prompt: 'continue', resume: RES_ID });
      const first = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(first.status, 200);
      const second = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(second.status, 409);
      assert.equal(second.json?.error, 'already resuming');
    });
  }));

  check(await testAsync('resume of an adopted, still-live session is 409 — a held socket is not the only way to be alive', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      // Drive the session to exactly the state the UI offers resume in: adopted,
      // holding no question/plan/reply socket, but with a live child — a session
      // mid-tool-call, or lingering after its turn (measured at 90s+), which the
      // row shows as `incomplete` and `resumeEligible` accepts.
      const id = launch(cfg, REF, { prompt: 'a long job', permissionMode: 'auto' }, RES_ID);
      assert.equal(id, RES_ID);
      listLaunching(Date.now() + LAUNCH_TTL_MS + 1);   // resumes reach `running` via the TTL
      assert.equal(children.length, 1);

      const reply = await post(
        (req, res) => void serveSpawn(cfg, req, res),
        JSON.stringify({ prompt: 'continue', resume: RES_ID })
      );
      assert.equal(reply.status, 409);
      assert.equal(reply.json?.error, 'session is still running');
      // The refusal has to actually stop the work: a second child would both put
      // two writers on one transcript and replace the store entry, dropping the
      // first child's kill handle.
      assert.equal(children.length, 1, 'no second child may be spawned');
    });
  }));

  check(await testAsync('resume happy path: 200 with the SAME session id, child spawned with --resume in the session cwd', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
      setSpawner(((command: string, args: string[], options: object) => {
        calls.push({ args: args.slice(), options: { ...options } });
        const child = new FakeChild();
        return child as unknown as ChildProcess;
      }) as Spawner);
      const body = JSON.stringify({ prompt: 'pick it back up', resume: RES_ID });
      const reply = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(reply.status, 200);
      assert.equal((reply.json as { sessionId?: string })?.sessionId, RES_ID);
      assert.deepEqual(calls[0].args.slice(0, 3), ['-p', '--resume', RES_ID]);
      assert.equal(calls[0].options.cwd, process.cwd(), "child cwd is the session transcript's cwd");
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

  /* ------------------------------------- POST /api/sessions/:id/stop (task-19) */

  /** Launch a fake session and adopt it, so the store holds a `running` entry with a live handle. */
  function adoptedSession(cfg: ReturnType<typeof loadConfig>, calls: KillCall[]): string {
    setSpawner(fakeSpawner());
    setGroupKiller((pid, signal) => { calls.push({ pid, signal }); });
    const id = launch(cfg, REF, { prompt: 'a long job', permissionMode: 'auto' });
    assert.equal(adoptLaunched([id]), 1);
    return id;
  }

  check(await testAsync('POST /api/sessions/:id/stop is 404 "remote answers disabled" when the toggle is off', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\nREMOTE_ANSWER=false\n', async cfg => {
      const reply = await post((req, res) => void serveSessionStop(cfg, 'no-such-id', req, res), '');
      assert.equal(reply.status, 404);
      // Distinguishable from the "no live session" 404 the same request gets
      // with the toggle on — which is what makes this discriminating.
      assert.equal(reply.json?.error, 'remote answers disabled');
    });
  }));

  check(await testAsync('POST /api/sessions/:id/stop is 403 for a wrong bearer token', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\nANSWER_TOKEN=the-real-token\n', async cfg => {
      const calls: KillCall[] = [];
      const id = adoptedSession(cfg, calls);
      try {
        const reply = await post(
          (req, res) => void serveSessionStop(cfg, id, req, res), '', { Authorization: 'Bearer wrong-token' }
        );
        assert.equal(reply.status, 403);
        assert.equal(reply.json?.error, 'bad token');
        // The gate is only worth anything if nothing behind it ran.
        assert.equal(calls.length, 0, 'a refused request must not signal anything');
      } finally { setGroupKiller(null); }
    });
  }));

  check(await testAsync('an id the server never spawned is 404 "no live session"', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const reply = await post((req, res) => void serveSessionStop(cfg, 'never-spawned', req, res), '');
      assert.equal(reply.status, 404);
      assert.equal(reply.json?.error, 'no live session');
    });
  }));

  check(await testAsync('a bare POST with no body at all is a graceful stop, not a 400', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const calls: KillCall[] = [];
      const id = adoptedSession(cfg, calls);
      try {
        // The common request from the row button. An empty body must not 400.
        const reply = await post((req, res) => void serveSessionStop(cfg, id, req, res), '');
        assert.equal(reply.status, 200);
        assert.equal(reply.json?.stopping, true);
        assert.deepEqual(calls, [{ pid: -FAKE_PID, signal: 'SIGTERM' }]);
      } finally { setGroupKiller(null); }
    });
  }));

  check(await testAsync('{"force":true} SIGKILLs; {"force":"yes"} does not — the flag is strict === true', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const calls: KillCall[] = [];
      const id = adoptedSession(cfg, calls);
      try {
        const forced = await post((req, res) => void serveSessionStop(cfg, id, req, res), '{"force":true}');
        assert.equal(forced.status, 200);
        assert.equal(forced.json?.stopped, true);
        assert.deepEqual(calls[0], { pid: -FAKE_PID, signal: 'SIGKILL' });
      } finally { setGroupKiller(null); }
    });

    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const calls: KillCall[] = [];
      const id = adoptedSession(cfg, calls);
      try {
        // A truthy string is not evidence the caller meant to skip the grace
        // window and SIGKILL, so it routes to the graceful path.
        const soft = await post((req, res) => void serveSessionStop(cfg, id, req, res), '{"force":"yes"}');
        assert.equal(soft.status, 200);
        assert.equal(soft.json?.stopping, true);
        assert.deepEqual(calls[0], { pid: -FAKE_PID, signal: 'SIGTERM' });
      } finally { setGroupKiller(null); }
    });
  }));

  check(await testAsync('a present-but-unparseable body IS a 400 — only an absent one is forgiven', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const calls: KillCall[] = [];
      const id = adoptedSession(cfg, calls);
      try {
        const reply = await post((req, res) => void serveSessionStop(cfg, id, req, res), BAD_BODY);
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error, 'bad body');
        assert.equal(calls.length, 0);
      } finally { setGroupKiller(null); }
    });
  }));

  check(await testAsync('POST /api/spawn/:id/stop still answers 200 {stopped:true} for a launching entry', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      // Unchanged from before task-19: the two handlers now share one store
      // operation, and this route's documented behaviour is part of that.
      setSpawner(fakeSpawner());
      const id = launch(cfg, REF, { prompt: 'hold a slot', permissionMode: 'auto' });
      const reply = await post((req, res) => serveSpawnStop(cfg, id, req, res), '');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.stopped, true);
      assert.equal(listLaunching().length, 0);
    });
  }));

  /* ------------------------------------ the same route through the real router */

  /** The route table, the method guard and `decodePath` only exist above the handler. */
  const ROUTER_ENV = 'SKIP_PROC_SCAN=true\nSHOW_USAGE=false\nCLAUDE_BIN=/bin/echo\n';

  check(await testAsync('GET /api/sessions/:id/stop is 405 with an Allow: POST header', async () => {
    await withServer(ROUTER_ENV, async h => {
      const reply = await h.req('/api/sessions/some-id/stop');
      assert.equal(reply.status, 405);
      assert.equal(reply.headers['allow'], 'POST');
    });
  }));

  check(await testAsync('POST /api/sessions/%ZZ/stop is 400 and the server keeps answering', async () => {
    await withServer(ROUTER_ENV, async h => {
      // `decodeURIComponent` throws a URIError on a lone `%ZZ`, synchronously
      // inside the request listener — `decodePath` is what keeps that from
      // taking the whole dashboard down.
      const reply = await h.req('/api/sessions/%ZZ/stop', { method: 'POST', body: '' });
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'bad path encoding');
      const after = await h.req('/api/sessions/some-id/stop', { method: 'POST', body: '' });
      assert.equal(after.status, 404, 'the process survived the malformed path');
    });
  }));

  check(await testAsync('GET /api/sessions carries stopState on the adopted spawned row and omits it elsewhere', async () => {
    await withServer(ROUTER_ENV, async h => {
      resetLaunches();
      setSpawner(fakeSpawner());
      try {
        const spawned = launch(h.cfg, REF, { prompt: 'a long job', permissionMode: 'auto' });
        h.plant(spawned);
        h.plant('11111111-2222-4333-8444-555555555555');

        // Poll 1 scans, *then* adopts — so the field is not there yet. This
        // ordering is deliberate (a launch must not be reported as both a
        // `launching` row and a real one in the same response), and the one
        // poll of latency it costs is worth pinning rather than rediscovering.
        const first = await h.req('/api/sessions');
        assert.equal(first.status, 200);
        const firstRows = first.json?.sessions as { id: string; stopState?: string }[];
        assert.equal(firstRows.find(r => r.id === spawned)?.stopState, undefined);

        const second = await h.req('/api/sessions');
        const rows = second.json?.sessions as { id: string; stopState?: string }[];
        assert.equal(rows.length, 2);
        assert.equal(rows.find(r => r.id === spawned)?.stopState, 'ready');
        // Absent, not false: a row nothing here can signal carries no field.
        const other = rows.find(r => r.id !== spawned)!;
        assert.equal('stopState' in other, false, 'a non-spawned row must omit the field entirely');
      } finally { setSpawner(null); resetLaunches(); }
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
