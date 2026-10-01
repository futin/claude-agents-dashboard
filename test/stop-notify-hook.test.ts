/**
 * `scripts/stop-notify-hook.sh` — the `CLAUDE_DASHBOARD_ONESHOT` exemption.
 *
 * A session the dashboard launched as one-shot (the Git Sync button, or the spawn form's "Close when done") must end when its last turn does, instead of
 * sitting in the reply hold for `answerSecs`. The hook is driven the way the CLI drives it — one Stop payload on stdin, `CLAUDECODE=1` — against an
 * in-process fake dashboard that records every POST. The complement cases (flag unset, flag empty) are what make the first case mean anything: without them a
 * hook that never holds would pass too.
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'scripts', 'stop-notify-hook.sh');

interface Recorded { path: string; body: Record<string, unknown>; }

/** A fake dashboard: health per `remoteAnswer`, every POST recorded, every wait answered `timeout` at once. */
async function fakeDashboard(remoteAnswer: boolean): Promise<{ url: string; posts: Recorded[]; close: () => Promise<void> }> {
  const posts: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/health') {
        res.end(JSON.stringify({ remoteAnswer, answerSecs: 1 }));
        return;
      }
      posts.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.end(req.url === '/api/messages/wait' ? JSON.stringify({ status: 'timeout' }) : '{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, posts, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Run the hook once. `oneShot` undefined leaves the variable out of the env entirely. */
async function runHook(url: string, home: string, oneShot: string | undefined, stopHookActive = false): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  delete env.BM_ORCH_RUN;
  delete env.CLAUDE_DASHBOARD_ONESHOT;
  delete env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT;
  if (oneShot !== undefined) env.CLAUDE_DASHBOARD_ONESHOT = oneShot;
  const child = spawn('bash', [HOOK], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify({ session_id: 's1', stop_hook_active: stopHookActive, permission_mode: 'auto' }));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

const count = (posts: Recorded[], p: string): number => posts.filter(r => r.path === p).length;

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== stop-notify-hook.sh: CLAUDE_DASHBOARD_ONESHOT ===\n');
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
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
