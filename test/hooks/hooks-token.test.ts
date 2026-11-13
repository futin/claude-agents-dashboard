/**
 * The hooks' side of the dashboard token (backlog bug-6): `remote-decision-hook.sh` says "NOT armed" instead of the away-mode banner when the server wants a
 * token this machine does not have, and `ask-remote-hook.sh` sends `Authorization: Bearer <token>` exactly when `$HOME/.claude/hooks/dashboard-token` exists.
 *
 * The server half (`tokenRequired` on `/api/health`, the 403 on an untokened write) is pinned by api-remote-toggle and api-write-trust; nothing there would
 * notice a hook that dropped the banner or stopped sending the header, and the user would believe remote answers were armed while every write was refused.
 *
 * Each script runs the way the CLI runs it (`CLAUDECODE=1`, one payload on stdin) with HOME pointed at a temp dir, so a case seeds or omits the token file,
 * against an in-process dashboard whose `/api/health` body the case chooses and which records every request's headers. Async `spawn`, never `spawnSync`: the
 * dashboard answers from this process's own event loop, which a sync child would block.
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
const TOKEN = 'tok-416-secret';

const DECISION_PAYLOAD = { session_id: 's1', hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' };
const ASK_PAYLOAD = { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, permission_mode: 'auto' };

/** The first line of each banner remote-decision-hook.sh can print. */
const NOT_ARMED = 'REMOTE DECISION MODE is NOT armed';
const ARMED = 'REMOTE DECISION MODE — the dashboard is accepting remote answers';

interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders }

/** A dashboard whose `/api/health` answers `health`, every other request `timeout`, recording each request with its headers. */
async function fakeDashboard(health: Record<string, unknown>): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/health' ? health : { status: 'timeout' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A fresh HOME, with `.claude/hooks/dashboard-token` holding TOKEN (plus the trailing newline the installer writes) when `withToken`. */
function makeHome(withToken: boolean): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-token-'));
  if (withToken) {
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'hooks', 'dashboard-token'), TOKEN + '\n');
  }
  return home;
}

async function runHook(script: string, payload: Record<string, unknown>, url: string, home: string): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  for (const k of ['BM_ORCH_RUN', 'CLAUDE_DASHBOARD_ONESHOT', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT', 'CLAUDE_DASHBOARD_ROUTINE',
    'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_DASHBOARD_DECISION_MODES']) delete env[k];
  const child = spawn('bash', [path.join(REPO, 'scripts', script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

/** Runs `script` once against a dashboard answering `health`, in a HOME with or without the token file; cleans both up. */
async function scenario(script: string, payload: Record<string, unknown>, health: Record<string, unknown>, withToken: boolean):
  Promise<{ code: number | null; stdout: string; requests: Recorded[] }> {
  const home = makeHome(withToken);
  const dash = await fakeDashboard(health);
  try {
    const r = await runHook(script, payload, dash.url, home);
    return { ...r, requests: dash.requests };
  } finally {
    await dash.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

export async function run(): Promise<number> {
  console.log('\n=== hook scripts: dashboard token (tokenRequired banner, Bearer header) ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hooks exit before deciding without it. These cases did not run.`);
      return 0;
    }
  }

  const health = { remoteAnswer: true, answerSecs: 1 };

  if (await ok('remote-decision-hook.sh: tokenRequired with no token file prints the NOT armed banner, not the away-mode one', async () => {
    const r = await scenario('remote-decision-hook.sh', DECISION_PAYLOAD, { ...health, tokenRequired: true }, false);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes(NOT_ARMED), `expected the NOT armed banner, got:\n${r.stdout}`);
    assert.ok(r.stdout.includes('dashboard-token is missing'), `the banner must name the missing file, got:\n${r.stdout}`);
    assert.ok(!r.stdout.includes(ARMED), `the away-mode banner must not follow the NOT armed one, got:\n${r.stdout}`);
  })) p++; else f++;

  if (await ok('remote-decision-hook.sh: tokenRequired with the token file present prints the away-mode banner', async () => {
    const r = await scenario('remote-decision-hook.sh', DECISION_PAYLOAD, { ...health, tokenRequired: true }, true);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes(ARMED), `expected the away-mode banner, got:\n${r.stdout}`);
    assert.ok(!r.stdout.includes(NOT_ARMED), `no NOT armed banner when the token file exists, got:\n${r.stdout}`);
  })) p++; else f++;

  if (await ok('remote-decision-hook.sh: no tokenRequired field (an older server) with no token file prints the away-mode banner', async () => {
    const r = await scenario('remote-decision-hook.sh', DECISION_PAYLOAD, health, false);
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes(ARMED), `expected the away-mode banner, got:\n${r.stdout}`);
    assert.ok(!r.stdout.includes(NOT_ARMED), `a server that never asked for a token must not trigger the warning, got:\n${r.stdout}`);
  })) p++; else f++;

  if (await ok('ask-remote-hook.sh: with the token file present the question POST carries Authorization: Bearer <token>', async () => {
    const r = await scenario('ask-remote-hook.sh', ASK_PAYLOAD, { ...health, tokenRequired: true }, true);
    const post = r.requests.find(q => q.method === 'POST' && q.url === '/api/questions/wait');
    assert.ok(post, `expected a POST /api/questions/wait, got: ${r.requests.map(q => `${q.method} ${q.url}`).join(', ') || 'none'}`);
    assert.strictEqual(post.headers.authorization, `Bearer ${TOKEN}`, 'the trailing newline is stripped and the token sent verbatim');
  })) p++; else f++;

  if (await ok('ask-remote-hook.sh: with no token file the question POST carries no Authorization header', async () => {
    const r = await scenario('ask-remote-hook.sh', ASK_PAYLOAD, health, false);
    const post = r.requests.find(q => q.method === 'POST' && q.url === '/api/questions/wait');
    assert.ok(post, `expected a POST /api/questions/wait, got: ${r.requests.map(q => `${q.method} ${q.url}`).join(', ') || 'none'}`);
    assert.strictEqual(post.headers.authorization, undefined);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
