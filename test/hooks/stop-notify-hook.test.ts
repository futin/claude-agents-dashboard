/**
 * `scripts/stop-notify-hook.sh` — the `CLAUDE_DASHBOARD_ONESHOT` and `BM_ORCH_RUN` (#504) exemptions, the `CLAUDE_DASHBOARD_REFRESH` exit (#178), the
 * background-work gate (#568), and the HEADLESS classification with the idle gate it feeds (#417).
 *
 * A session the dashboard launched as one-shot (the Git Sync button, or the spawn form's "Close when done") must end when its last turn does, instead of
 * sitting in the reply hold for `answerSecs`. The hook is driven the way the CLI drives it — one Stop payload on stdin, `CLAUDECODE=1` — against an
 * in-process fake dashboard that records every POST. The complement cases (flag unset, flag empty) are what make the first case mean anything: without them a
 * hook that never holds would pass too.
 *
 * The HEADLESS cases put a fake `ps` and a fake `ioreg` first on PATH, so the TTY the hook reads and the keyboard idle it measures are the case's, not the
 * machine's: under `claude -p` the real `ps` prints `??` and in a terminal it prints a tty name, so without the fake these cases would pass in one place only.
 * Every other case here pins `CLAUDE_DASHBOARD_IDLE_SECS=0`, which skips the idle gate outright; these set a real threshold.
 *
 * Async `spawn`, never `spawnSync`: the fake dashboard answers from this process's own event loop, which a sync child would block.
 */

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(REPO, 'scripts', 'stop-notify-hook.sh');

interface Recorded { path: string; body: Record<string, unknown>; }

/** A fake dashboard: health per `remoteAnswer` and `answerSecs`, every POST recorded, every wait answered `timeout` at once with HTTP `waitStatus`. */
async function fakeDashboard(
  remoteAnswer: boolean, { answerSecs = 1, waitStatus = 200 }: { answerSecs?: number; waitStatus?: number } = {}
): Promise<{ url: string; posts: Recorded[]; close: () => Promise<void> }> {
  const posts: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/health') {
        res.end(JSON.stringify({ remoteAnswer, answerSecs }));
        return;
      }
      posts.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      if (req.url === '/api/messages/wait') { res.statusCode = waitStatus; res.end(JSON.stringify({ status: 'timeout' })); }
      else res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, posts, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Run the hook once. `oneShot` undefined leaves the variable out of the env entirely; `extra` adds env on top. */
async function runHook(
  url: string, home: string, oneShot: string | undefined, stopHookActive = false, extra: NodeJS.ProcessEnv = {}, payload: Record<string, unknown> = {}
): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  // Every marker the hook reads is cleared, so a suite run from inside a routine or a desktop session sees the case's env, not its own.
  for (const k of ['BM_ORCH_RUN', 'CLAUDE_DASHBOARD_ONESHOT', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ROUTINE',
    'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR']) delete env[k];
  if (oneShot !== undefined) env.CLAUDE_DASHBOARD_ONESHOT = oneShot;
  Object.assign(env, extra);
  const child = spawn('bash', [HOOK], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify({ session_id: 's1', stop_hook_active: stopHookActive, permission_mode: 'auto', ...payload }));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

/** A directory holding a `ps` that prints `tty` and an `ioreg` that reports `idleSecs` of keyboard idle, in `ioreg`'s nanoseconds. */
function fakeBin(root: string, name: string, tty: string, idleSecs: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ps'), `#!/bin/sh\nprintf '%s\\n' '${tty}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ioreg'), `#!/bin/sh\nprintf '%s\\n' '    |   |   "HIDIdleTime" = ${idleSecs}000000000'\n`, { mode: 0o755 });
  return dir;
}

/** The env for one HEADLESS case: the fake bin first on PATH, a 60 s idle threshold, and `CLAUDE_CODE_ENTRYPOINT` only when `entrypoint` is given. */
function classified(bin: string, entrypoint?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? ''}`, CLAUDE_DASHBOARD_IDLE_SECS: '60' };
  if (entrypoint !== undefined) env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  return env;
}

const count = (posts: Recorded[], p: string): number => posts.filter(r => r.path === p).length;

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== stop-notify-hook.sh: CLAUDE_DASHBOARD_ONESHOT / BM_ORCH_RUN / CLAUDE_DASHBOARD_REFRESH / background work / HEADLESS ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hook exits before deciding`);
      console.log('    without it. These cases did not run.');
      return 0;
    }
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-home-'));
  try {
    if (await ok('one-shot: pushes "finished" once and never opens the reply hold', async () => {
      const dash = await fakeDashboard(true);
      try {
        const r = await runHook(dash.url, home, '1');
        assert.strictEqual(r.code, 0);
        assert.strictEqual(r.stdout, '');
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 0, 'a one-shot session must not hold');
        const events = dash.posts.filter(x => x.path === '/api/notify/event');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].body.sessionId, 's1');
        assert.strictEqual(events[0].body.event, 'stop');
      } finally { await dash.close(); }
    })) p++; else f++;

    if (await ok('one-shot mid-conversation (stop_hook_active): sends nothing at all', async () => {
      const dash = await fakeDashboard(true);
      try {
        const r = await runHook(dash.url, home, '1', true);
        assert.strictEqual(r.code, 0);
        assert.strictEqual(count(dash.posts, '/api/notify/event'), 0);
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 0);
      } finally { await dash.close(); }
    })) p++; else f++;

    if (await ok('flag unset or empty: the session holds, exactly as before', async () => {
      for (const v of [undefined, '']) {
        const dash = await fakeDashboard(true);
        try {
          const r = await runHook(dash.url, home, v);
          assert.strictEqual(r.code, 0);
          assert.strictEqual(count(dash.posts, '/api/messages/wait'), 1, `CLAUDE_DASHBOARD_ONESHOT=${JSON.stringify(v)} must hold`);
        } finally { await dash.close(); }
      }
    })) p++; else f++;

    if (await ok('remote answers off: one-shot changes nothing — one push, no hold', async () => {
      const dash = await fakeDashboard(false);
      try {
        const r = await runHook(dash.url, home, '1');
        assert.strictEqual(r.code, 0);
        assert.strictEqual(count(dash.posts, '/api/notify/event'), 1);
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 0);
      } finally { await dash.close(); }
    })) p++; else f++;

    // #504 — a session an orchestrator run owns (`BM_ORCH_RUN=<runId>`, backlog-manager bug-20) skips the hold and takes notify_fallback, or every
    // unattended item idles for `answerSecs`. runHook clears the variable, so these are the only cases that set it; the unset and empty rows are the mirror
    // that makes the first mean anything.
    if (await ok('orchestrator run (BM_ORCH_RUN set): pushes "finished" once and never opens the reply hold', async () => {
      const dash = await fakeDashboard(true);
      try {
        const r = await runHook(dash.url, home, undefined, false, { BM_ORCH_RUN: 'run-504' });
        assert.strictEqual(r.code, 0);
        assert.strictEqual(r.stdout, '');
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 0, 'a run-owned session must not hold');
        const events = dash.posts.filter(x => x.path === '/api/notify/event');
        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].body.sessionId, 's1');
        assert.strictEqual(events[0].body.event, 'stop');
      } finally { await dash.close(); }
    })) p++; else f++;

    if (await ok('BM_ORCH_RUN unset or empty: the session holds, with no fallback push', async () => {
      for (const v of [undefined, '']) {
        const dash = await fakeDashboard(true);
        try {
          const r = await runHook(dash.url, home, undefined, false, v === undefined ? {} : { BM_ORCH_RUN: v });
          assert.strictEqual(r.code, 0);
          assert.strictEqual(count(dash.posts, '/api/messages/wait'), 1, `BM_ORCH_RUN=${JSON.stringify(v)} must hold`);
          assert.strictEqual(count(dash.posts, '/api/notify/event'), 0, `BM_ORCH_RUN=${JSON.stringify(v)}: no fallback push`);
        } finally { await dash.close(); }
      }
    })) p++; else f++;

    // #503 — the `/wait` body is the hook-to-server contract. The fake answers whatever it is sent, so a renamed key or seconds sent for milliseconds would
    // keep every other case green while the real server clamps the hold to its 5 s floor.
    if (await ok('the /api/messages/wait body carries sessionId, timeoutMs = answerSecs × 1000, permissionMode and stopHookActive', async () => {
      const dash = await fakeDashboard(true, { answerSecs: 30 });
      try {
        const r = await runHook(dash.url, home, undefined);
        assert.strictEqual(r.code, 0);
        const waits = dash.posts.filter(x => x.path === '/api/messages/wait');
        assert.strictEqual(waits.length, 1);
        const { headless, ...rest } = waits[0].body;
        assert.strictEqual(typeof headless, 'boolean', 'headless depends on the TTY this suite runs under, so only its type is pinned here');
        assert.deepStrictEqual(rest, { sessionId: 's1', timeoutMs: 30_000, permissionMode: 'auto', stopHookActive: false });
      } finally { await dash.close(); }
    })) p++; else f++;

    // A non-2xx wait (feature flipped off mid-flight, server restarted) falls back to the plain push, so "finished" never regresses. The 200 row is the
    // mirror: an ordinary `timeout` answer sends no push, so a hook that pushed after every wait would fail it.
    if (await ok('wait → HTTP 404 or 503: exactly one /api/notify/event POST, exit 0; HTTP 200 timeout: none', async () => {
      for (const [waitStatus, events] of [[404, 1], [503, 1], [200, 0]] as const) {
        const dash = await fakeDashboard(true, { waitStatus });
        try {
          const r = await runHook(dash.url, home, undefined);
          assert.strictEqual(r.code, 0, `HTTP ${waitStatus}: exit code`);
          assert.strictEqual(r.stdout, '', `HTTP ${waitStatus}: stdout`);
          assert.strictEqual(count(dash.posts, '/api/messages/wait'), 1, `HTTP ${waitStatus}: the hook never reached the wait`);
          assert.strictEqual(count(dash.posts, '/api/notify/event'), events, `HTTP ${waitStatus}: fallback pushes`);
        } finally { await dash.close(); }
      }
    })) p++; else f++;

    // #178 — the dashboard's own token-renewal turn. Unlike one-shot it gets nothing at all: nobody started it, so even "finished" is noise.
    if (await ok('token-refresh turn (CLAUDE_DASHBOARD_REFRESH=1): no hold and no push, whatever remote answers says', async () => {
      for (const remote of [true, false]) {
        const dash = await fakeDashboard(remote);
        try {
          const r = await runHook(dash.url, home, undefined, false, { CLAUDE_DASHBOARD_REFRESH: '1' });
          assert.strictEqual(r.code, 0);
          assert.strictEqual(r.stdout, '');
          assert.deepStrictEqual(dash.posts.map(x => x.path), [], `remoteAnswer=${remote}: the refresh turn must POST nothing`);
        } finally { await dash.close(); }
      }
    })) p++; else f++;

    // The background-work gate (#568): a turn that ends with background tasks or session crons still running is not finished — they wake it again — so
    // it neither holds nor pushes. The both-empty case is the mirror that proves the payload reached the hook at all.
    for (const [label, extraPayload] of [
      ['non-empty background_tasks', { background_tasks: [{ id: 'b1' }], session_crons: [] }],
      ['non-empty session_crons', { background_tasks: [], session_crons: [{ id: 'c1' }] }],
    ] as const) {
      if (await ok(`${label}: exits 0 with no push and no hold`, async () => {
        const dash = await fakeDashboard(true);
        try {
          const r = await runHook(dash.url, home, undefined, false, {}, extraPayload);
          assert.strictEqual(r.code, 0);
          assert.strictEqual(r.stdout, '');
          assert.deepStrictEqual(dash.posts, [], 'background work pending: nothing reaches the dashboard');
        } finally { await dash.close(); }
      })) p++; else f++;
    }

    if (await ok('background_tasks and session_crons both empty: the normal path — the session holds', async () => {
      const dash = await fakeDashboard(true);
      try {
        const r = await runHook(dash.url, home, undefined, false, {}, { background_tasks: [], session_crons: [] });
        assert.strictEqual(r.code, 0);
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 1);
      } finally { await dash.close(); }
    })) p++; else f++;

    if (await ok('CLAUDE_DASHBOARD_REFRESH empty: an ordinary session, which holds', async () => {
      const dash = await fakeDashboard(true);
      try {
        await runHook(dash.url, home, undefined, false, { CLAUDE_DASHBOARD_REFRESH: '' });
        assert.strictEqual(count(dash.posts, '/api/messages/wait'), 1);
      } finally { await dash.close(); }
    })) p++; else f++;

    // #417 — HEADLESS (:97-113) and the idle gate it feeds (:184). The desktop app runs the CLI with no pty, so on the TTY test alone every desktop turn
    // parked on the dashboard whatever the idle time; the `claude-desktop` entrypoint is what sends it back through the gate.
    const bins = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-bin-'));
    try {
      if (await ok('no TTY (?? or ?), entrypoint absent or unfamiliar: headless — holds at the desk, wait body says headless: true', async () => {
        for (const tty of ['??', '?']) {
          for (const entrypoint of [undefined, 'sdk-cli']) {
            const label = `tty=${tty} entrypoint=${entrypoint ?? '(unset)'}`;
            const bin = fakeBin(bins, `headless-${tty === '?' ? 'q' : 'qq'}-${entrypoint ?? 'none'}`, tty, 0);
            const dash = await fakeDashboard(true);
            try {
              const r = await runHook(dash.url, home, undefined, false, classified(bin, entrypoint));
              assert.strictEqual(r.code, 0);
              const waits = dash.posts.filter(x => x.path === '/api/messages/wait');
              assert.strictEqual(waits.length, 1, `${label}: a headless session skips the idle gate and must hold`);
              assert.strictEqual(waits[0].body.headless, true, `${label}: wait body headless`);
              assert.strictEqual(count(dash.posts, '/api/notify/event'), 0, `${label}: no fallback push`);
            } finally { await dash.close(); }
          }
        }
      })) p++; else f++;

      if (await ok('no TTY + CLAUDE_CODE_ENTRYPOINT=claude-desktop, idle below the threshold: at the desk — one push, no hold', async () => {
        const dash = await fakeDashboard(true);
        try {
          const r = await runHook(dash.url, home, undefined, false, classified(fakeBin(bins, 'desktop-desk', '??', 5), 'claude-desktop'));
          assert.strictEqual(r.code, 0);
          assert.strictEqual(r.stdout, '');
          assert.strictEqual(count(dash.posts, '/api/messages/wait'), 0, 'a desktop turn with you at the keyboard must not park on the dashboard');
          assert.strictEqual(count(dash.posts, '/api/notify/event'), 1);
        } finally { await dash.close(); }
      })) p++; else f++;

      if (await ok('no TTY + CLAUDE_CODE_ENTRYPOINT=claude-desktop, idle above the threshold: away — holds, wait body says headless: false', async () => {
        const dash = await fakeDashboard(true);
        try {
          const r = await runHook(dash.url, home, undefined, false, classified(fakeBin(bins, 'desktop-away', '??', 120), 'claude-desktop'));
          assert.strictEqual(r.code, 0);
          const waits = dash.posts.filter(x => x.path === '/api/messages/wait');
          assert.strictEqual(waits.length, 1, 'away from the keyboard the desktop turn must reach the dashboard');
          assert.strictEqual(waits[0].body.headless, false);
          assert.strictEqual(count(dash.posts, '/api/notify/event'), 0);
        } finally { await dash.close(); }
      })) p++; else f++;

      // Control: the fake `ps` is the one the hook ran. A real tty name, no entrypoint, goes through the same gate both ways.
      if (await ok('terminal TTY: idle below → one push, no hold; idle above → holds with headless: false', async () => {
        for (const [idle, holds] of [[5, false], [120, true]] as const) {
          const dash = await fakeDashboard(true);
          try {
            const r = await runHook(dash.url, home, undefined, false, classified(fakeBin(bins, `tty-${idle}`, 'ttys003', idle)));
            assert.strictEqual(r.code, 0);
            const waits = dash.posts.filter(x => x.path === '/api/messages/wait');
            assert.strictEqual(waits.length, holds ? 1 : 0, `idle ${idle}s: hold`);
            assert.strictEqual(count(dash.posts, '/api/notify/event'), holds ? 0 : 1, `idle ${idle}s: fallback push`);
            if (holds) assert.strictEqual(waits[0].body.headless, false);
          } finally { await dash.close(); }
        }
      })) p++; else f++;
    } finally {
      fs.rmSync(bins, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
