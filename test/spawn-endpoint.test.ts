/**
 * The two runtime rails around `POST /api/spawn` — the ones that live in the
 * handler rather than in `server/lib/spawn.ts`, so the store's own tests can't
 * see them:
 *
 *   1. the remote-answer toggle gate (the app's only runtime kill switch —
 *      spawn used to be the one session write path it did not cover), and
 *   2. `MAX_LAUNCHING`, the concurrency cap that answers 429.
 *
 * Both are exercised against the real handler over a real socket. No test here
 * spawns a `claude` binary or runs `open`: the launch store is pre-filled through
 * `launch()` with the `setSpawner` fake, and the desktop app's opener is a recording
 * fake (`overrideDesktop`). The body is read and parsed before the cap is counted
 * (the chosen surface picks the rail), so a cap case posts a well-formed body naming
 * a project that does not exist: past the cap it can only become 400 `unknown project`.
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
  LAUNCH_TTL_MS, MAX_LAUNCHING, adoptLaunched, launch, listLaunching, probeSpawn, resetLaunches,
  resetSpawnProbe, setGroupKiller, setSpawner
} from '../server/lib/spawn.js';
import { setPsRunner } from '../server/lib/scan.js';
import { resetArchivedCache } from '../server/lib/archived.js';
import { overrideDesktop, resetDesktopProbe, resetDesktopRail } from '../server/lib/desktop.js';
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
  const prevHome = process.env.HOME;
  try {
    process.chdir(dir);
    // HOME too: a request past the gates resolves projects under `os.homedir()`, and the developer's real transcripts must not decide a case.
    process.env.HOME = dir;
    resetState();
    resetLaunches();
    resetSpawnProbe();
    await fn(loadConfig({ envPath }));
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
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

/** Malformed on purpose: the toggle cases must be decided before the body matters. */
const BAD_BODY = '{not json';

/** Well-formed, naming no project: a request that gets past the cap ends in 400 `unknown project`, one that doesn't in 429. */
const CAP_BODY = JSON.stringify({ prompt: 'x', project: 'no-such-project' });

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

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
      // It fails on the unknown project instead — i.e. it got past the cap.
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'unknown project: no-such-project');
    });
  }));

  check(await testAsync(`${MAX_LAUNCHING} launches in flight: 429 "too many launches in flight"`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      assert.equal(listLaunching().length, MAX_LAUNCHING);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
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

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
      assert.equal(reply.status, 400, 'the failed row must not hold a slot');
      assert.equal(reply.json?.error, 'unknown project: no-such-project');
    });
  }));

  check(await testAsync(`all ${MAX_LAUNCHING} failing frees the cap entirely`, async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' });
      }
      const capped = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
      assert.equal(capped.status, 429, 'four live children do cap it');

      for (const child of children) child.emit('exit', 1, null);
      assert.equal(listLaunching().filter(e => e.state === 'launching').length, 0);

      const reply = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
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

  // The mirror of the case above: a `failed` row lingers for FAIL_TTL_MS so the
  // UI can explain itself, but it holds no process, so it must not block a retry.
  check(await testAsync('a resume retried after the previous resume failed is NOT 409 — a failed row holds no process', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      const body = JSON.stringify({ prompt: 'continue', resume: RES_ID });
      const first = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(first.status, 200);
      children[0].emit('exit', 1, null);
      assert.equal(listLaunching().find(e => e.sessionId === RES_ID)?.state, 'failed');

      const retry = await post((req, res) => void serveSpawn(cfg, req, res), body);
      assert.equal(retry.status, 200, 'the failed row must not read as a resume in flight');
      assert.equal(children.length, 2);
      assert.equal(listLaunching().find(e => e.sessionId === RES_ID)?.state, 'launching');
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

  check(await testAsync('resume of a live session this server never spawned is 409 — the ps probe, not the store', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      // The empty store is load-bearing: `hasLiveChild` answers false for a
      // session spawned before the last restart or by any other launcher, so a
      // 409 here can only have come from the argv probe.
      assert.equal(listLaunching().length, 0, 'the store must know nothing about this id');
      setPsRunner(() => `  4242 /usr/local/bin/claude -p --resume ${RES_ID}\n`);
      try {
        const reply = await post(
          (req, res) => void serveSpawn(cfg, req, res),
          JSON.stringify({ prompt: 'continue', resume: RES_ID })
        );
        assert.equal(reply.status, 409);
        assert.equal(reply.json?.error, 'session is still running');
        assert.equal(children.length, 0, 'no second child may be spawned');
      } finally { setPsRunner(null); }
    });
  }));

  check(await testAsync('a probe naming other sessions still lets this one resume — "always refuse" is not a fix', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      setPsRunner(() => '  4242 /usr/local/bin/claude -p --resume 99999999-9999-4999-8999-999999999999\n');
      try {
        const reply = await post(
          (req, res) => void serveSpawn(cfg, req, res),
          JSON.stringify({ prompt: 'continue', resume: RES_ID })
        );
        assert.equal(reply.status, 200);
        assert.equal((reply.json as { sessionId?: string })?.sessionId, RES_ID);
      } finally { setPsRunner(null); }
    });
  }));

  check(await testAsync('a probe that cannot run does not refuse a legal resume — null means "no answer", not "alive"', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      setPsRunner(() => { throw new Error('ps: command not found'); });
      try {
        const reply = await post(
          (req, res) => void serveSpawn(cfg, req, res),
          JSON.stringify({ prompt: 'continue', resume: RES_ID })
        );
        assert.equal(reply.status, 200);
        assert.equal((reply.json as { sessionId?: string })?.sessionId, RES_ID);
      } finally { setPsRunner(null); }
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
      assert.deepEqual(reply.json, { surface: 'dashboard', sessionId: RES_ID });
      assert.deepEqual(calls[0].args.slice(0, 3), ['-p', '--resume', RES_ID]);
      assert.equal(calls[0].options.cwd, process.cwd(), "child cwd is the session transcript's cwd");
      assert.ok(!calls[0].args.includes('--effort'), 'a transcript with no recorded effort adds no flag');
    });
  }));

  /**
   * Append assistant records to RES_ID's planted transcript, oldest first, and
   * resume it with `body` — returning the argv the child was spawned with.
   */
  async function resumeArgsAfter(
    cfg: ReturnType<typeof loadConfig>, records: object[], body: object = {}
  ): Promise<string[]> {
    const file = path.join(process.cwd(), '.claude', 'projects', '-fake-proj', `${RES_ID}.jsonl`);
    for (const r of records) {
      fs.appendFileSync(file, JSON.stringify({
        type: 'assistant', entrypoint: 'sdk-cli', cwd: process.cwd(), timestamp: '2026-08-22T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, ...r
      }) + '\n');
    }
    const calls: string[][] = [];
    setSpawner(((_command: string, args: string[]) => {
      calls.push(args.slice());
      return new FakeChild() as unknown as ChildProcess;
    }) as Spawner);
    const reply = await post((req, res) => void serveSpawn(cfg, req, res), JSON.stringify({ prompt: 'go on', resume: RES_ID, ...body }));
    assert.equal(reply.status, 200);
    return calls[0];
  }
  const effortFlag = (args: string[]): string | undefined => {
    const i = args.indexOf('--effort');
    return i === -1 ? undefined : args[i + 1];
  };

  check(await testAsync('a resume with no effort keeps the effort the session last ran at — not the CLI default', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const args = await resumeArgsAfter(cfg, [{ effort: 'xhigh' }, { effort: 'high' }]);
      assert.equal(effortFlag(args), 'high', 'the newest record wins over an older one');
    });
  }));

  check(await testAsync('an effort the resume request names wins over the transcript', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const args = await resumeArgsAfter(cfg, [{ effort: 'high' }], { effort: 'low' });
      assert.equal(effortFlag(args), 'low');
    });
  }));

  check(await testAsync('a subagent record or an unknown effort value is ignored, never passed to the CLI', async () => {
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const args = await resumeArgsAfter(cfg, [{ effort: 'medium' }, { effort: 'max', isSidechain: true }]);
      assert.equal(effortFlag(args), 'medium', 'a sidechain record is a subagent turn, not the session');
    });
    await withResumeHome('CLAUDE_BIN=/bin/echo\n', async cfg => {
      const args = await resumeArgsAfter(cfg, [{ effort: 'turbo' }]);
      assert.equal(effortFlag(args), undefined);
    });
  }));

  /* ---------------------------------------------------------- surface: desktop */

  /** What the fake opener saw, and a switch that makes its next calls reject. */
  interface DesktopSeam { calls: Array<{ cmd: string; args: string[] }>; reject: boolean; }

  /**
   * {@link withResumeHome} plus the desktop app's seams: a recording opener in place of `open`, the given platform, and an app path that exists (the
   * fixture HOME itself), so `desktopAvailable` answers from `platform` alone. Rail, probe memo and registry cache start empty and are put back after.
   */
  async function withDesktop(
    envBody: string, platform: string, fn: (cfg: ReturnType<typeof loadConfig>, d: DesktopSeam) => Promise<void>
  ): Promise<void> {
    await withResumeHome(envBody, async cfg => {
      const d: DesktopSeam = { calls: [], reject: false };
      overrideDesktop({
        run: async (cmd, args) => {
          d.calls.push({ cmd, args: args.slice() });
          if (d.reject) throw new Error('LSOpenURLsWithRole() failed');
        },
        platform,
        appPath: process.cwd()
      });
      resetDesktopRail();
      resetDesktopProbe();
      resetArchivedCache();
      try { await fn(cfg, d); } finally {
        overrideDesktop({ run: null, platform: null, appPath: null });
        resetDesktopRail();
        resetDesktopProbe();
        resetArchivedCache();
      }
    });
  }

  /** A non-archived desktop-app registry record naming `id`, where `appSessionsRoot()` looks under the fixture HOME. */
  function plantRegistry(id: string): void {
    const dir = path.join(process.cwd(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'inst', 'acct');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'local_aaaa.json'), JSON.stringify({ cliSessionId: id, isArchived: false }));
  }

  const spawnReq = (cfg: ReturnType<typeof loadConfig>, body: object): Promise<Reply> =>
    post((req, res) => void serveSpawn(cfg, req, res), JSON.stringify(body));
  const HAND_OVER = { resume: RES_ID, surface: 'desktop' };

  check(await testAsync('desktop fresh launch: 200 {surface:"desktop"}, one `open` of a link carrying the project path and the prompt', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      const reply = await spawnReq(cfg, { project: '-fake-proj', prompt: 'build the thing', surface: 'desktop' });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json, { surface: 'desktop' });
      assert.equal(d.calls.length, 1);
      assert.equal(d.calls[0].cmd, 'open');
      assert.equal(d.calls[0].args.length, 1, 'the link is one argv entry');
      const url = new URL(d.calls[0].args[0]);
      assert.equal(url.protocol, 'claude:');
      assert.equal(url.searchParams.get('folder'), process.cwd());
      assert.equal(url.searchParams.get('q'), 'build the thing');
      assert.equal(children.length, 0, 'no headless child');
      assert.equal(listLaunching().length, 0, 'a desktop launch never enters the launch store');
    });
  }));

  check(await testAsync('desktop off macOS is 501 "desktop app unavailable", and nothing is opened', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'linux', async (cfg, d) => {
      const reply = await spawnReq(cfg, { project: '-fake-proj', prompt: 'x', surface: 'desktop' });
      assert.equal(reply.status, 501);
      assert.equal(reply.json?.error, 'desktop app unavailable');
      assert.equal(d.calls.length, 0);
    });
  }));

  check(await testAsync('the headless probe does not gate desktop: no claude CLI, desktop still 200, headless 404', async () => {
    await withDesktop('', 'darwin', async (cfg, d) => {
      assert.equal(probeSpawn(cfg), false, 'the fixture must have no spawnable CLI');
      const desk = await spawnReq(cfg, { project: '-fake-proj', prompt: 'x', surface: 'desktop' });
      assert.equal(desk.status, 200);
      assert.equal(d.calls.length, 1);
      const head = await spawnReq(cfg, { project: '-fake-proj', prompt: 'x' });
      assert.equal(head.status, 404);
      assert.equal(head.json?.error, 'spawn unavailable');
    });
  }));

  check(await testAsync('headless while the desktop app is unavailable is unaffected: 200 {surface:"dashboard", sessionId}', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'linux', async (cfg, d) => {
      setSpawner(fakeSpawner());
      const reply = await spawnReq(cfg, { project: '-fake-proj', prompt: 'x' });
      assert.equal(reply.status, 200);
      const json = reply.json as { surface?: string; sessionId?: string } | null;
      assert.equal(json?.surface, 'dashboard');
      assert.equal(typeof json?.sessionId, 'string');
      assert.equal(d.calls.length, 0);
    });
  }));

  check(await testAsync('the desktop rail: four fresh launches back to back are 200, the fifth 429 "too many launches in flight"', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const statuses: number[] = [];
      let last: Reply | null = null;
      for (let i = 0; i < 5; i++) {
        last = await spawnReq(cfg, { project: '-fake-proj', prompt: `go ${i}`, surface: 'desktop' });
        statuses.push(last.status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
      assert.equal(last?.json?.error, 'too many launches in flight');
      assert.equal(d.calls.length, 4, 'the refused launch opens nothing');
    });
  }));

  check(await testAsync('hand-over twice back to back: 200, then 409 "already resuming"; one `open` of the resume link', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const first = await spawnReq(cfg, HAND_OVER);
      assert.equal(first.status, 200);
      assert.deepEqual(first.json, { surface: 'desktop' });
      const second = await spawnReq(cfg, HAND_OVER);
      assert.equal(second.status, 409);
      assert.equal(second.json?.error, 'already resuming');
      assert.deepEqual(d.calls.map(c => c.args), [[`claude://resume?session=${RES_ID}`]]);
    });
  }));

  check(await testAsync('a headless resume of a session just handed over is 409 "already resuming" — the mark, not the launch store', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async cfg => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      assert.equal((await spawnReq(cfg, HAND_OVER)).status, 200);
      const reply = await spawnReq(cfg, { prompt: 'continue', resume: RES_ID });
      assert.equal(reply.status, 409);
      assert.equal(reply.json?.error, 'already resuming');
      assert.equal(children.length, 0, 'no second writer');
    });
  }));

  check(await testAsync('a failed `open` is 500 "open failed" and gives back its slot and mark: the retry is 200', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      d.reject = true;
      const prevError = console.error;
      const logged: unknown[][] = [];
      console.error = (...a: unknown[]) => { logged.push(a); };
      const failed = await spawnReq(cfg, HAND_OVER).finally(() => { console.error = prevError; });
      assert.equal(failed.status, 500);
      assert.equal(failed.json?.error, 'open failed');
      assert.equal(logged.length, 1, 'one log line');
      d.reject = false;
      const retry = await spawnReq(cfg, HAND_OVER);
      assert.equal(retry.status, 200, 'the failed attempt must not hold the mark');
      assert.equal(d.calls.length, 2);
    });
  }));

  check(await testAsync('a session the desktop app holds is 409 "session is open in the desktop app", for a hand-over and a headless resume', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const children: FakeChild[] = [];
      setSpawner(fakeSpawner(children));
      plantRegistry(RES_ID);
      resetArchivedCache();
      const over = await spawnReq(cfg, HAND_OVER);
      assert.equal(over.status, 409);
      assert.equal(over.json?.error, 'session is open in the desktop app');
      const head = await spawnReq(cfg, { prompt: 'continue', resume: RES_ID });
      assert.equal(head.status, 409);
      assert.equal(head.json?.error, 'session is open in the desktop app');
      assert.equal(d.calls.length, 0);
      assert.equal(children.length, 0);
    });
  }));

  check(await testAsync('a hand-over keeps the resume validation: a terminal session is 400, an unknown one 400', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const term = await spawnReq(cfg, { resume: LOCAL_ID, surface: 'desktop' });
      assert.equal(term.status, 400);
      assert.equal(term.json?.error, 'only dashboard sessions can be resumed');
      const unknown = await spawnReq(cfg, { resume: '44444444-4444-4444-8444-444444444444', surface: 'desktop' });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.json?.error, 'unknown session');
      assert.equal(d.calls.length, 0);
    });
  }));

  check(await testAsync('fields a desktop launch ignores are accepted, not refused', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const reply = await spawnReq(cfg, {
        project: '-fake-proj', prompt: 'x', surface: 'desktop', name: 'my run', model: 'opus', oneShot: true, remoteControl: true
      });
      assert.equal(reply.status, 200);
      assert.equal(d.calls.length, 1);
    });
  }));

  check(await testAsync('an unknown surface is 400 "bad surface"', async () => {
    await withDesktop('CLAUDE_BIN=/bin/echo\n', 'darwin', async (cfg, d) => {
      const reply = await spawnReq(cfg, { project: '-fake-proj', prompt: 'x', surface: 'nope' });
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'bad surface');
      assert.equal(d.calls.length, 0);
    });
  }));

  check(await testAsync('the cap frees up as entries leave the store (adopted or stopped)', async () => {
    await withEnv('CLAUDE_BIN=/bin/echo\n', async cfg => {
      setSpawner(fakeSpawner());
      const ids: string[] = [];
      for (let i = 0; i < MAX_LAUNCHING; i++) {
        ids.push(launch(cfg, REF, { prompt: `slot ${i}`, permissionMode: 'auto' }));
      }
      const capped = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
      assert.equal(capped.status, 429);

      // One session shows up on disk — the ordinary way an entry leaves.
      assert.equal(listLaunching().length, MAX_LAUNCHING);
      const freed = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
      assert.equal(freed.status, 429, 'still capped until something is adopted');

      assert.equal(adoptLaunched([ids[0]]), 1);
      const after = await post((req, res) => void serveSpawn(cfg, req, res), CAP_BODY);
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
          (req, res) => void serveSessionStop(cfg, id, req, res), '', { Authorization: 'Bearer wrong-token', 'X-Forwarded-For': '192.168.1.5' }
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

  /* ------------------------------------ SYNC_PERMISSION_MODE on /api/health */

  const syncMode = async (env: string): Promise<unknown> => {
    let mode: unknown;
    await withServer(ROUTER_ENV + env, async h => {
      const reply = await h.req('/api/health');
      assert.equal(reply.status, 200);
      mode = reply.json?.syncPermissionMode;
    });
    return mode;
  };

  check(await testAsync('health reports syncPermissionMode auto when SYNC_PERMISSION_MODE is unset', async () => {
    assert.equal(await syncMode(''), 'auto');
  }));

  check(await testAsync('SYNC_PERMISSION_MODE=plan is reported as plan', async () => {
    assert.equal(await syncMode('SYNC_PERMISSION_MODE=plan\n'), 'plan');
  }));

  check(await testAsync('SYNC_PERMISSION_MODE above the default auto ceiling is reported as auto', async () => {
    assert.equal(await syncMode('SYNC_PERMISSION_MODE=bypassPermissions\n'), 'auto');
  }));

  check(await testAsync('SYNC_PERMISSION_MODE=bypassPermissions under a bypassPermissions ceiling is kept', async () => {
    assert.equal(await syncMode('SYNC_PERMISSION_MODE=bypassPermissions\nSPAWN_MAX_PERMISSION=bypassPermissions\n'), 'bypassPermissions');
  }));

  check(await testAsync('an unrecognized SYNC_PERMISSION_MODE falls back to auto', async () => {
    assert.equal(await syncMode('SYNC_PERMISSION_MODE=Plan\n'), 'auto');
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
