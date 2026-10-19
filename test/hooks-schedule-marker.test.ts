/**
 * The user-global hook scripts ignore a scheduled run (`CLAUDE_DASHBOARD_SCHEDULE`, stamped by `plugin/lib/run-schedule.mjs`).
 *
 * Each script runs the way the CLI runs it (`CLAUDECODE=1`, one payload on stdin) against an in-process dashboard that answers `/api/health` with remote
 * answering on and records every request, GETs included. The unmarked case per script is what makes the marked one mean anything: a script that never reaches
 * the dashboard for some other reason would pass the marked case too, so each must record at least one request without the marker.
 *
 * Async `spawn`, never `spawnSync`: the dashboard answers from this process's own event loop, which a sync child would block.
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

/** Per script: a payload that carries it past every guard before its first dashboard call. */
const HOOKS: { script: string; payload: Record<string, unknown> }[] = [
  { script: 'stop-notify-hook.sh', payload: { session_id: 's1', stop_hook_active: false, permission_mode: 'auto' } },
  { script: 'ask-remote-hook.sh', payload: { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, permission_mode: 'auto' } },
  { script: 'remote-decision-hook.sh', payload: { session_id: 's1', hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' } },
  { script: 'plan-remote-hook.sh', payload: { session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' }, permission_mode: 'plan' } },
  { script: 'permission-notify-hook.sh', payload: { session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', permission_mode: 'auto' } },
];

/** A dashboard that says remote answering is on, answers every other request `timeout`, and records the lot. */
async function fakeDashboard(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ remoteAnswer: true, answerSecs: 1 }) : JSON.stringify({ status: 'timeout' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function runHook(script: string, payload: Record<string, unknown>, url: string, home: string, marker: string | undefined): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  for (const k of ['BM_ORCH_RUN', 'CLAUDE_DASHBOARD_ONESHOT', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT', 'CLAUDE_DASHBOARD_SCHEDULE']) delete env[k];
  if (marker !== undefined) env.CLAUDE_DASHBOARD_SCHEDULE = marker;
  const child = spawn('bash', [path.join(REPO, 'scripts', script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== hook scripts: CLAUDE_DASHBOARD_SCHEDULE ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hooks exit before deciding without it. These cases did not run.`);
      return 0;
    }
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-schedule-'));
  try {
    for (const { script, payload } of HOOKS) {
      if (await ok(`${script}: unmarked reaches the dashboard`, async () => {
        const dash = await fakeDashboard();
        try {
          await runHook(script, payload, dash.url, home, undefined);
          assert.ok(dash.requests.length >= 1, 'an unmarked run must record a request, or the marked case below proves nothing');
        } finally { await dash.close(); }
      })) p++; else f++;

      if (await ok(`${script}: CLAUDE_DASHBOARD_SCHEDULE set exits 0, silent, with no request`, async () => {
        const dash = await fakeDashboard();
        try {
          const r = await runHook(script, payload, dash.url, home, 'x');
          assert.strictEqual(r.code, 0);
          assert.strictEqual(r.stdout, '');
          assert.deepStrictEqual(dash.requests, []);
        } finally { await dash.close(); }
      })) p++; else f++;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
