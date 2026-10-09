/**
 * `ask-remote-hook.sh`, `plan-remote-hook.sh`, `stop-notify-hook.sh` — the autopilot opt-out.
 *
 * While an `autopilot` run is `running` (state file `$HOME/.claude/autopilot/<session_id>.json`, field `status`), the three remote-routing hooks step aside:
 * the run must not ask, and the CLI applies a deny/block only after every hook on the event has returned, so a hook holding for `answerSecs` would idle the
 * run and push a question to the phone for nothing. Every other status, a missing file and an unreadable one leave today's behaviour untouched.
 *
 * Driven the way the CLI drives each hook (one payload on stdin, `CLAUDECODE=1`) against an in-process fake dashboard that records every request except
 * the health probe. `answerSecs` is 1, so the complement cases (a hook that does reach the dashboard) hold for a second at most. Async `spawn`, never
 * `spawnSync`: the fake dashboard answers from this process's own event loop, which a sync child would block.
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
const SID = 'run-1';

interface Recorded { path: string; body: Record<string, unknown>; }
interface Hook { name: string; script: string; stdin: (sessionId: string) => Record<string, unknown>; waitPath: string; }

const HOOKS: Hook[] = [
  {
    name: 'ask-remote',
    script: 'ask-remote-hook.sh',
    waitPath: '/api/questions/wait',
    stdin: sid => ({
      session_id: sid, permission_mode: 'auto',
      tool_input: { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] },
    }),
  },
  {
    name: 'plan-remote',
    script: 'plan-remote-hook.sh',
    waitPath: '/api/plans/wait',
    stdin: sid => ({ session_id: sid, permission_mode: 'auto', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n1. do it' } }),
  },
  {
    name: 'stop-notify',
    script: 'stop-notify-hook.sh',
    waitPath: '/api/messages/wait',
    stdin: sid => ({ session_id: sid, permission_mode: 'auto', stop_hook_active: false }),
  },
];

/** A fake dashboard: remote answers on, every request but the health probe recorded, every wait answered `timeout` at once. */
async function fakeDashboard(): Promise<{ url: string; reqs: Recorded[]; close: () => Promise<void> }> {
  const reqs: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/health') {
        res.end(JSON.stringify({ remoteAnswer: true, answerSecs: 1 }));
        return;
      }
      reqs.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.end(/\/wait$/.test(req.url ?? '') ? JSON.stringify({ status: 'timeout' }) : '{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, reqs, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Run one hook once with `payload` on stdin. */
async function runHook(hook: Hook, url: string, home: string, payload: Record<string, unknown>): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  delete env.BM_ORCH_RUN;
  delete env.CLAUDE_DASHBOARD_ONESHOT;
  delete env.CLAUDE_DASHBOARD_ANSWER_TIMEOUT;
  const child = spawn('bash', [path.join(REPO, 'scripts', hook.script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

/** A fresh HOME whose `.claude/autopilot/` holds `files` (name → content). */
function makeHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-opt-out-'));
  const dir = path.join(home, '.claude', 'autopilot');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return home;
}

const state = (status: string): string => JSON.stringify({ status });

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Run `fn` against a fresh fake dashboard and a HOME holding `files`, cleaning both up. */
async function withEnv(files: Record<string, string>, fn: (dash: Awaited<ReturnType<typeof fakeDashboard>>, home: string) => Promise<void>): Promise<void> {
  const home = makeHome(files);
  const dash = await fakeDashboard();
  try { await fn(dash, home); } finally { await dash.close(); fs.rmSync(home, { recursive: true, force: true }); }
}

export async function run(): Promise<number> {
  console.log('\n=== remote hooks: autopilot opt-out ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hooks exit before deciding`);
      console.log('    without it. These cases did not run.');
      return 0;
    }
  }

  for (const hook of HOOKS) {
    if (await ok(`${hook.name}: status running → silent exit 0, no request at all`, () => withEnv({ [`${SID}.json`]: state('running') }, async (dash, home) => {
      const r = await runHook(hook, dash.url, home, hook.stdin(SID));
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.stdout, '');
      assert.deepStrictEqual(dash.reqs, [], 'a running autopilot session must not reach the dashboard');
    }))) p++; else f++;

    const others: Array<[string, Record<string, string>]> = [
      ['blocked', { [`${SID}.json`]: state('blocked') }],
      ['wrap-up', { [`${SID}.json`]: state('wrap-up') }],
      ['missing file', {}],
      ['malformed file', { [`${SID}.json`]: '{not json' }],
    ];
    for (const [label, files] of others) {
      if (await ok(`${hook.name}: ${label} → today's behaviour (reaches the dashboard)`, () => withEnv(files, async (dash, home) => {
        const r = await runHook(hook, dash.url, home, hook.stdin(SID));
        assert.strictEqual(r.code, 0);
        assert.ok(dash.reqs.length >= 1, 'expected at least one request beyond GET /api/health');
        assert.ok(dash.reqs.some(q => q.path === hook.waitPath), `expected a POST ${hook.waitPath}`);
      }))) p++; else f++;
    }

    // `../autopilot/run-1` resolves, through the path, to a real `running` file — so only the id guard keeps this hook from skipping on it.
    if (await ok(`${hook.name}: a session_id outside [A-Za-z0-9-] skips the check (no path traversal)`, () => withEnv({ [`${SID}.json`]: state('running') }, async (dash, home) => {
      const r = await runHook(hook, dash.url, home, hook.stdin(`../autopilot/${SID}`));
      assert.strictEqual(r.code, 0);
      assert.ok(dash.reqs.some(q => q.path === hook.waitPath), 'a non-matching id must fall through to today\'s behaviour');
    }))) p++; else f++;
  }

  if (await ok('stop-notify: running + stop_hook_active → holds as a first stop (stopHookActive: false)', () => withEnv({ [`${SID}.json`]: state('running') }, async (dash, home) => {
    const stop = HOOKS[2];
    const r = await runHook(stop, dash.url, home, { ...stop.stdin(SID), stop_hook_active: true });
    assert.strictEqual(r.code, 0);
    const waits = dash.reqs.filter(q => q.path === '/api/messages/wait');
    assert.strictEqual(waits.length, 1);
    assert.strictEqual(waits[0].body.stopHookActive, false);
  }))) p++; else f++;

  if (await ok('stop-notify: blocked + stop_hook_active → still reports stopHookActive: true (only running rewrites it)', () => withEnv({ [`${SID}.json`]: state('blocked') }, async (dash, home) => {
    const stop = HOOKS[2];
    await runHook(stop, dash.url, home, { ...stop.stdin(SID), stop_hook_active: true });
    const waits = dash.reqs.filter(q => q.path === '/api/messages/wait');
    assert.strictEqual(waits.length, 1);
    assert.strictEqual(waits[0].body.stopHookActive, true);
  }))) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
