/**
 * The hooks' side of the dashboard token (backlog bug-6): `remote-decision-hook.sh` says "NOT armed" instead of the away-mode banner when the server wants a
 * token this machine does not have, and every POSTing hook sends `Authorization: Bearer <token>` exactly when the token file exists — at
 * `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/dashboard-token`, the path the installer writes (#415). The custom dir wins outright: a token left only under
 * `$HOME/.claude` is not a fallback. The token reaches curl through a file descriptor (`-H @<fd>`), never its argv, where any local `ps` could read it.
 *
 * The server half (`tokenRequired` on `/api/health`, the 403 on an untokened write) is pinned by api-remote-toggle and api-write-trust; nothing there would
 * notice a hook that dropped the banner or stopped sending the header, and the user would believe remote answers were armed while every write was refused.
 *
 * Each script runs the way the CLI runs it (`CLAUDECODE=1`, one payload on stdin) with HOME (and, when a case sets it, CLAUDE_CONFIG_DIR) pointed at temp
 * dirs, so a case seeds or omits the token file in either place,
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

/** Every hook that POSTs to a token-gated endpoint, with a payload that reaches that POST and the path it posts to. */
const POSTING_HOOKS: { script: string; payload: Record<string, unknown>; postPath: string }[] = [
  { script: 'ask-remote-hook.sh', payload: ASK_PAYLOAD, postPath: '/api/questions/wait' },
  { script: 'plan-remote-hook.sh', payload: { session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' }, permission_mode: 'plan' },
    postPath: '/api/plans/wait' },
  { script: 'stop-notify-hook.sh', payload: { session_id: 's1', stop_hook_active: false, permission_mode: 'auto' }, postPath: '/api/messages/wait' },
  { script: 'permission-notify-hook.sh', payload: { session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', permission_mode: 'auto' },
    postPath: '/api/permissions/notify' },
];

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

/** Where a case puts the token: under `$HOME/.claude/hooks`, and/or in a CLAUDE_CONFIG_DIR that is unset, empty, or holds it. */
interface TokenAt { home: boolean; configDir?: 'empty' | 'token' }

/** A dir holding `hooks/dashboard-token` = TOKEN plus the trailing newline the installer writes, when `withToken`. */
function makeClaudeDir(parent: string, withToken: boolean): void {
  if (!withToken) { fs.mkdirSync(parent, { recursive: true }); return; }
  fs.mkdirSync(path.join(parent, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'hooks', 'dashboard-token'), TOKEN + '\n');
}

/** A fresh HOME (and CLAUDE_CONFIG_DIR when `at.configDir` is set) seeded per `at`; `env` is what the hook should see for CLAUDE_CONFIG_DIR. */
function makeDirs(at: TokenAt): { home: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-token-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  if (at.home) makeClaudeDir(path.join(home, '.claude'), true);
  const env: NodeJS.ProcessEnv = {};
  if (at.configDir) {
    env.CLAUDE_CONFIG_DIR = path.join(root, 'custom-claude');
    makeClaudeDir(env.CLAUDE_CONFIG_DIR, at.configDir === 'token');
  }
  return { home, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Runs `script` the way the CLI does. CLAUDE_CONFIG_DIR is cleared unless `extra` sets it, so a developer shell that exports it cannot change results. */
async function runHook(script: string, payload: Record<string, unknown>, url: string, home: string, extra: NodeJS.ProcessEnv = {}):
  Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  for (const k of ['BM_ORCH_RUN', 'CLAUDE_DASHBOARD_ONESHOT', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT', 'CLAUDE_DASHBOARD_ROUTINE',
    'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_DASHBOARD_DECISION_MODES', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR']) delete env[k];
  Object.assign(env, extra);
  const child = spawn('bash', [path.join(REPO, 'scripts', script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

/** Runs `script` once against a dashboard answering `health`, with the token placed per `at`; cleans everything up. */
async function scenario(script: string, payload: Record<string, unknown>, health: Record<string, unknown>, at: TokenAt | boolean):
  Promise<{ code: number | null; stdout: string; requests: Recorded[] }> {
  const dirs = makeDirs(typeof at === 'boolean' ? { home: at } : at);
  const dash = await fakeDashboard(health);
  try {
    const r = await runHook(script, payload, dash.url, dirs.home, dirs.env);
    return { ...r, requests: dash.requests };
  } finally {
    await dash.close();
    dirs.cleanup();
  }
}

/**
 * Runs `script` with a fake `curl` first on PATH that logs its argv, and the contents of every `-H @<path>` file, then answers `/api/health` with
 * `health` and fails everything else. What a real `ps` would show is exactly that argv.
 */
async function argvScenario(script: string, payload: Record<string, unknown>, health: Record<string, unknown>):
  Promise<{ argv: string; headers: string }> {
  const dirs = makeDirs({ home: true });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-token-bin-'));
  const argvLog = path.join(bin, 'argv.log');
  const hdrLog = path.join(bin, 'headers.log');
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/bash',
    'printf \'%s\\n\' "$@" >> "$FAKE_ARGV_LOG"',
    'prev=; last=',
    'for a in "$@"; do',
    '  if [ "$prev" = "-H" ]; then case "$a" in @*) cat "${a#@}" >> "$FAKE_HDR_LOG" ;; esac; fi',
    '  prev=$a; last=$a',
    'done',
    'case "$last" in */api/health) printf \'%s\' "$FAKE_HEALTH"; exit 0 ;; esac',
    'exit 22',
    '',
  ].join('\n'), { mode: 0o755 });
  try {
    await runHook(script, payload, 'http://127.0.0.1:9', dirs.home, {
      PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_ARGV_LOG: argvLog, FAKE_HDR_LOG: hdrLog, FAKE_HEALTH: JSON.stringify(health),
    });
    const read = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    return { argv: read(argvLog), headers: read(hdrLog) };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    dirs.cleanup();
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

  if (await ok('remote-decision-hook.sh: tokenRequired with the token only under CLAUDE_CONFIG_DIR prints the away-mode banner, not the warning', async () => {
    const r = await scenario('remote-decision-hook.sh', DECISION_PAYLOAD, { ...health, tokenRequired: true }, { home: false, configDir: 'token' });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes(ARMED), `expected the away-mode banner, got:\n${r.stdout}`);
    assert.ok(!r.stdout.includes(NOT_ARMED), `the token under CLAUDE_CONFIG_DIR is the one the installer wrote, got:\n${r.stdout}`);
  })) p++; else f++;

  if (await ok('remote-decision-hook.sh: tokenRequired with CLAUDE_CONFIG_DIR set and no token anywhere still warns', async () => {
    const r = await scenario('remote-decision-hook.sh', DECISION_PAYLOAD, { ...health, tokenRequired: true }, { home: false, configDir: 'empty' });
    assert.strictEqual(r.code, 0);
    assert.ok(r.stdout.includes(NOT_ARMED), `expected the NOT armed banner, got:\n${r.stdout}`);
  })) p++; else f++;

  for (const h of POSTING_HOOKS) {
    const sent = (requests: Recorded[]) => {
      const post = requests.find(q => q.method === 'POST' && q.url === h.postPath);
      assert.ok(post, `expected a POST ${h.postPath}, got: ${requests.map(q => `${q.method} ${q.url}`).join(', ') || 'none'}`);
      return post;
    };

    if (await ok(`${h.script}: token under $HOME/.claude/hooks, CLAUDE_CONFIG_DIR unset → Authorization: Bearer <token>`, async () => {
      const r = await scenario(h.script, h.payload, { ...health, tokenRequired: true }, { home: true });
      assert.strictEqual(sent(r.requests).headers.authorization, `Bearer ${TOKEN}`);
    })) p++; else f++;

    if (await ok(`${h.script}: token only under CLAUDE_CONFIG_DIR/hooks → Authorization: Bearer <token>`, async () => {
      const r = await scenario(h.script, h.payload, { ...health, tokenRequired: true }, { home: false, configDir: 'token' });
      assert.strictEqual(sent(r.requests).headers.authorization, `Bearer ${TOKEN}`, 'the hook must read the file the installer wrote');
    })) p++; else f++;

    if (await ok(`${h.script}: CLAUDE_CONFIG_DIR set without a token, token only under $HOME/.claude → no Authorization (no fallback)`, async () => {
      const r = await scenario(h.script, h.payload, { ...health, tokenRequired: true }, { home: true, configDir: 'empty' });
      assert.strictEqual(sent(r.requests).headers.authorization, undefined);
    })) p++; else f++;

    if (await ok(`${h.script}: the token never appears in curl's argv, only in the -H @<fd> header it reads`, async () => {
      const r = await argvScenario(h.script, h.payload, { ...health, tokenRequired: true });
      assert.ok(r.argv.length > 0, 'the fake curl was never run');
      assert.ok(r.argv.includes(h.postPath), `expected a curl call for ${h.postPath}, got argv:\n${r.argv}`);
      assert.ok(!r.argv.includes(TOKEN), `the token is on curl's argv:\n${r.argv}`);
      assert.ok(r.headers.includes(`Authorization: Bearer ${TOKEN}`), `expected the header in the -H @file contents, got:\n${r.headers || '(none)'}`);
    })) p++; else f++;
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
