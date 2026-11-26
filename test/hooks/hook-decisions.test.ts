/**
 * The step the remote hooks exist for: turning the dashboard's answer into the decision JSON the CLI reads — plus the fail-closed at-desk rule and the
 * Notification-event filter (#414).
 *
 * Every other hook suite's fake dashboard answers each wait `timeout`, so a drift in the jq output shape or in the `answered`/`rejected` status string would
 * drop every phone answer with all of them green. Here the fake answers each `/wait` with a scripted status, and each decision case has a mirror (the same
 * hook, a status it must ignore, empty stdout) so a hook that printed its decision unconditionally would fail too.
 *
 * The `/wait` body is the other half of that contract (#503): the fake records it and the body cases pin every key, `timeoutMs` in milliseconds included,
 * and one case runs the ask hook against the real route table (`withServer`), so a body the real `serveQuestionWait` refuses fails here too.
 *
 * The at-desk cases put a fake `ioreg` first on PATH. awk always prints a number, so "non-numeric idle" is the one string it can print that is not digits:
 * `inf` (or `+inf` under gawk), from an overflowing `HIDIdleTime`. The away case — the same fake, reporting 100 s idle — is what proves the fake is the
 * `ioreg` the hook ran: without it, an at-desk case would pass for any hook that never reached the wait.
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

import { until, withServer } from '../api-harness.js';
import { pendingSessionIds } from '../../server/lib/pending.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Recorded { method: string; path: string; body: Record<string, unknown>; }

/**
 * A dashboard with remote answering on that answers every `…/wait` POST with `wait` (HTTP `waitStatus`), any other POST `{}`, and records every request —
 * body included, so a case can pin the `/wait` body that is the hook-to-server contract. `answerSecs` is what its health probe reports.
 */
async function fakeDashboard(
  wait: Record<string, unknown> = { status: 'timeout' }, { answerSecs = 1, waitStatus = 200 }: { answerSecs?: number; waitStatus?: number } = {}
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({ method: req.method ?? '', path: url, body: raw ? JSON.parse(raw) : {} });
      res.setHeader('Content-Type', 'application/json');
      if (url === '/api/health') res.end(JSON.stringify({ remoteAnswer: true, answerSecs }));
      else if (url.endsWith('/wait')) { res.statusCode = waitStatus; res.end(JSON.stringify(wait)); }
      else res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** Run one hook the way the CLI does. Idle gate off unless `extra` sets `CLAUDE_DASHBOARD_IDLE_SECS`; `binDir` goes first on PATH. */
async function runHook(
  script: string, payload: Record<string, unknown>, url: string, home: string, extra: NodeJS.ProcessEnv = {}, binDir?: string
): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, CLAUDE_DASHBOARD_IDLE_SECS: '0', HOME: home };
  for (const k of ['BM_ORCH_RUN', 'CLAUDE_DASHBOARD_ONESHOT', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT', 'CLAUDE_DASHBOARD_ROUTINE',
    'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_DASHBOARD_HOOK_LOG', 'CLAUDE_CONFIG_DIR']) delete env[k];
  Object.assign(env, extra);
  if (binDir) env.PATH = `${binDir}:${env.PATH ?? ''}`;
  const child = spawn('bash', [path.join(REPO, 'scripts', script)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

/** A directory holding an `ioreg` that prints `out` (nothing, and exit 1, when `out` is null). */
function fakeIoreg(root: string, name: string, out: string | null): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const body = out === null ? 'exit 1\n' : `printf '%s\\n' '    |   |   "HIDIdleTime" = ${out}'\n`;
  fs.writeFileSync(path.join(dir, 'ioreg'), `#!/bin/sh\n${body}`, { mode: 0o755 });
  return dir;
}

const posts = (requests: Recorded[]) => requests.filter(r => r.method === 'POST');

async function ok(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ASK = { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, permission_mode: 'auto' };
const PLAN = { session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' }, permission_mode: 'plan' };
const STOP = { session_id: 's1', stop_hook_active: false, permission_mode: 'auto' };

/** Per decision hook: the wait it POSTs to, the status it acts on, one it must ignore, and the exact stdout for the acted-on status with reason `R`. */
const DECISIONS = [
  {
    script: 'ask-remote-hook.sh', payload: ASK, waitPath: '/api/questions/wait', acts: 'answered', ignores: 'timeout',
    expected: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'R' } },
  },
  {
    script: 'plan-remote-hook.sh', payload: PLAN, waitPath: '/api/plans/wait', acts: 'rejected', ignores: 'answered',
    expected: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'R' } } },
  },
  {
    script: 'stop-notify-hook.sh', payload: STOP, waitPath: '/api/messages/wait', acts: 'answered', ignores: 'timeout',
    expected: { decision: 'block', reason: 'R' },
  },
];

export async function run(): Promise<number> {
  console.log('\n=== hook scripts: decisions, at-desk rule, Notification filter ===\n');
  let p = 0, f = 0;
  const tally = (passed: boolean) => { if (passed) p++; else f++; };

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hooks exit before deciding without it. These cases did not run.`);
      return 0;
    }
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-decisions-'));
  try {
    for (const d of DECISIONS) {
      tally(await ok(`${d.script}: wait → ${d.acts} prints the CLI decision JSON`, async () => {
        const dash = await fakeDashboard({ status: d.acts, reason: 'R' });
        try {
          const r = await runHook(d.script, d.payload, dash.url, home);
          assert.strictEqual(r.code, 0);
          assert.ok(posts(dash.requests).some(q => q.path === d.waitPath), `no POST to ${d.waitPath}: ${JSON.stringify(dash.requests.map(q => q.path))}`);
          assert.deepStrictEqual(JSON.parse(r.stdout), d.expected);
        } finally { await dash.close(); }
      }));

      tally(await ok(`${d.script}: wait → ${d.ignores} prints nothing`, async () => {
        const dash = await fakeDashboard({ status: d.ignores, reason: 'R' });
        try {
          const r = await runHook(d.script, d.payload, dash.url, home);
          assert.strictEqual(r.code, 0);
          assert.ok(posts(dash.requests).some(q => q.path === d.waitPath), `no POST to ${d.waitPath}`);
          assert.strictEqual(r.stdout, '');
        } finally { await dash.close(); }
      }));
    }

    // The `/wait` body is the hook-to-server contract: the fake above answers whatever it is sent, so without these a renamed key, or seconds sent for
    // milliseconds, would keep every case green while the real server answers 400 or clamps the hold (#503).
    for (const d of DECISIONS.slice(0, 2)) {
      tally(await ok(`${d.script}: the ${d.waitPath} body carries sessionId, toolInput, timeoutMs = answerSecs × 1000 and permissionMode`, async () => {
        const dash = await fakeDashboard({ status: d.ignores }, { answerSecs: 30 });
        try {
          const r = await runHook(d.script, d.payload, dash.url, home);
          assert.strictEqual(r.code, 0);
          const waits = posts(dash.requests).filter(q => q.path === d.waitPath);
          assert.strictEqual(waits.length, 1, `expected one POST to ${d.waitPath}: ${JSON.stringify(dash.requests.map(q => q.path))}`);
          const { tool_input, permission_mode } = d.payload as typeof ASK | typeof PLAN;
          assert.deepStrictEqual(waits[0].body, { sessionId: 's1', toolInput: tool_input, timeoutMs: 30_000, permissionMode: permission_mode });
        } finally { await dash.close(); }
      }));
    }

    // Any non-2xx from the wait (feature flipped off mid-flight, server restarted) hands the question back to the terminal dialog: exit 0, nothing printed.
    // The body carries an `answered` status on purpose, so a hook that read the body without checking the status would print a decision and fail.
    for (const waitStatus of [404, 503]) {
      tally(await ok(`ask-remote-hook.sh: wait → HTTP ${waitStatus} exits 0 and prints nothing`, async () => {
        const dash = await fakeDashboard({ status: 'answered', reason: 'R' }, { waitStatus });
        try {
          const r = await runHook('ask-remote-hook.sh', ASK, dash.url, home);
          assert.strictEqual(r.code, 0);
          assert.ok(posts(dash.requests).some(q => q.path === '/api/questions/wait'), 'the hook never reached the wait');
          assert.strictEqual(r.stdout, '');
        } finally { await dash.close(); }
      }));
    }

    tally(await ok('ask-remote-hook.sh: wait → answered with an empty reason prints nothing', async () => {
      const dash = await fakeDashboard({ status: 'answered', reason: '' });
      try {
        const r = await runHook('ask-remote-hook.sh', ASK, dash.url, home);
        assert.strictEqual(r.code, 0);
        assert.ok(posts(dash.requests).some(q => q.path === '/api/questions/wait'), 'the hook never reached the wait');
        assert.strictEqual(r.stdout, '');
      } finally { await dash.close(); }
    }));

    // The fake cannot refuse a body the real `serveQuestionWait` would, so one case runs the hook against the real route table: a body it refuses (a
    // renamed key, no usable questions) is a 400/404 with nothing registered, and `until` below times out instead of finding the held question.
    tally(await ok('ask-remote-hook.sh against the real server: the question is held (2xx), and answering it prints the decision', async () => {
      const ID = '11111111-1111-4111-8111-111111111111';
      const toolInput = { questions: [{ header: 'Pick', question: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] }] };
      await withServer('SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n', async h => {
        h.plant(ID);
        await h.req('/api/health'); // resets the transcript-listing cache, so the hook's own request sees the planted session
        const hook = runHook('ask-remote-hook.sh', { session_id: ID, tool_name: 'AskUserQuestion', tool_input: toolInput, permission_mode: 'auto' },
          h.base, h.home, { CLAUDE_DASHBOARD_ANSWER_TIMEOUT: '30' });
        await until(() => pendingSessionIds().has(ID), 'the real server holds the hook\'s question', 10_000);
        const pending = (await h.req(`/api/sessions/${ID}/question`)).json?.pending as { questionId: string };
        const answer = await h.req(`/api/sessions/${ID}/answer`,
          { method: 'POST', body: JSON.stringify({ questionId: pending.questionId, answers: [{ index: 0, selected: ['left'] }] }) });
        assert.strictEqual(answer.status, 200, answer.raw);
        const r = await hook;
        assert.strictEqual(r.code, 0);
        const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
        assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
        assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('left'), out.hookSpecificOutput.permissionDecisionReason);
      });
    }));

    const bins = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-decisions-bin-'));
    try {
      const IDLE = [
        { label: 'unreadable idle', dir: fakeIoreg(bins, 'unreadable', null), posts: false },
        { label: 'non-numeric idle', dir: fakeIoreg(bins, 'inf', '1e400'), posts: false },
        { label: 'away (100 s idle, control)', dir: fakeIoreg(bins, 'away', '100000000000'), posts: true },
      ];
      for (const { script, payload, waitPath } of DECISIONS.slice(0, 2)) {
        for (const idle of IDLE) {
          tally(await ok(`${script}: ${idle.label} → ${idle.posts ? `POSTs ${waitPath}` : 'exit 0, silent, no POST'}`, async () => {
            const dash = await fakeDashboard();
            try {
              const r = await runHook(script, payload, dash.url, home, { CLAUDE_DASHBOARD_IDLE_SECS: '1' }, idle.dir);
              assert.strictEqual(r.code, 0);
              assert.strictEqual(r.stdout, '');
              if (idle.posts) assert.deepStrictEqual(posts(dash.requests).map(q => q.path), [waitPath]);
              else {
                assert.ok(dash.requests.some(q => q.path === '/api/health'), 'the hook never reached its idle gate');
                assert.deepStrictEqual(posts(dash.requests), []);
              }
            } finally { await dash.close(); }
          }));
        }
      }
    } finally {
      fs.rmSync(bins, { recursive: true, force: true });
    }

    const NOTIFICATIONS: { label: string; payload: Record<string, unknown>; posts: boolean }[] = [
      { label: 'permission_prompt', posts: true,
        payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } },
      { label: 'idle_prompt', posts: false,
        payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } },
      { label: 'another type, even with "permission" in its message', posts: false,
        payload: { notification_type: 'auth_success', message: 'permission granted' } },
      { label: 'legacy payload with "permission" in its message', posts: true,
        payload: { message: 'Claude needs your permission to use Bash' } },
      { label: 'legacy payload without it', posts: false,
        payload: { message: 'Claude is waiting for your input' } },
    ];
    for (const n of NOTIFICATIONS) {
      tally(await ok(`permission-notify-hook.sh: Notification ${n.label} → ${n.posts ? 'POST' : 'no POST'}`, async () => {
        const dash = await fakeDashboard();
        try {
          const r = await runHook('permission-notify-hook.sh', { session_id: 's1', hook_event_name: 'Notification', ...n.payload }, dash.url, home);
          assert.strictEqual(r.code, 0);
          assert.strictEqual(r.stdout, '');
          const sent = posts(dash.requests);
          if (n.posts) {
            assert.deepStrictEqual(sent.map(q => q.path), ['/api/permissions/notify']);
            assert.strictEqual(sent[0].body.message, n.payload.message);
          } else assert.deepStrictEqual(sent, []);
        } finally { await dash.close(); }
      }));
    }

    // The POST body is the hook-to-server contract for the `allow?` pill and its push (#568): `permissionMode` is what `requireAutoMode` reads, and the
    // message is the push's text. Pinned whole, so a dropped or renamed key fails here by name.
    tally(await ok('permission-notify-hook.sh: PermissionRequest → body is exactly {sessionId, message, permissionMode}', async () => {
      const dash = await fakeDashboard();
      try {
        const r = await runHook('permission-notify-hook.sh',
          { session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'auto' }, dash.url, home);
        assert.strictEqual(r.code, 0);
        assert.strictEqual(r.stdout, '', 'display-only: never a decision');
        const sent = posts(dash.requests);
        assert.deepStrictEqual(sent.map(q => q.path), ['/api/permissions/notify']);
        assert.deepStrictEqual(sent[0].body, { sessionId: 's1', message: 'Claude needs your permission to use Bash', permissionMode: 'auto' });
      } finally { await dash.close(); }
    }));

    tally(await ok('permission-notify-hook.sh: PermissionRequest with no tool_name or mode → "a tool", and an empty permissionMode', async () => {
      const dash = await fakeDashboard();
      try {
        const r = await runHook('permission-notify-hook.sh', { session_id: 's1', hook_event_name: 'PermissionRequest' }, dash.url, home);
        assert.strictEqual(r.code, 0);
        const sent = posts(dash.requests);
        assert.deepStrictEqual(sent.map(q => q.body), [{ sessionId: 's1', message: 'Claude needs your permission to use a tool', permissionMode: '' }]);
      } finally { await dash.close(); }
    }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
