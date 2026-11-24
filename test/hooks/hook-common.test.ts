/**
 * `scripts/hook-common.sh` — the preamble the five dashboard hooks source (DASH, TOKEN_FILE, dash_curl, autopilot_running).
 *
 * Three things are pinned here. No hook keeps its own copy of a shared function, so the next edit is made once. `autopilot_running` answers the same over
 * fixture state files as the per-hook copies did, its `--blocked-unasked` opt-in included (stop-notify's case). And each hook finds the file beside its own
 * real path — run directly, through an absolute symlink (what install-hooks.sh makes) and through a relative one — and exits 0 silently when the file is
 * not there, the same fail-open as a missing hook. The other suites under test/hooks/ are the behaviour proof for DASH, TOKEN_FILE and dash_curl.
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
const SCRIPTS = path.join(REPO, 'scripts');
const COMMON = path.join(SCRIPTS, 'hook-common.sh');
const HOOKS = ['ask-remote-hook.sh', 'plan-remote-hook.sh', 'permission-notify-hook.sh', 'stop-notify-hook.sh', 'remote-decision-hook.sh'];

/** One payload per hook that, with a reachable dashboard, makes it send a request — the visible sign it got past the preamble. */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  'ask-remote-hook.sh': { session_id: 's1', permission_mode: 'auto', tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
  'plan-remote-hook.sh': { session_id: 's1', permission_mode: 'auto', tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } },
  'permission-notify-hook.sh': { session_id: 's1', permission_mode: 'auto', hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
  'stop-notify-hook.sh': { session_id: 's1', permission_mode: 'auto', stop_hook_active: false },
  'remote-decision-hook.sh': { session_id: 's1', permission_mode: 'auto', hook_event_name: 'UserPromptSubmit' }
};

async function ok(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** The env a hook sees from the CLI, minus every marker that makes it exit early — this suite may itself run under a routine or a tick. */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_IDLE_SECS: '0', ...extra };
  for (const k of ['CLAUDE_DASHBOARD_ROUTINE', 'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_DASHBOARD_REFRESH', 'CLAUDE_DASHBOARD_ONESHOT', 'BM_ORCH_RUN',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_DASHBOARD_ANSWER_TIMEOUT']) delete env[k];
  return env;
}

/** `autopilot_running <sid> [flag]` with HOME at `home`, sourced from the real file: true when it returns 0. */
function autopilotRunning(home: string, sid: string, flag?: string): boolean {
  const script = `. ${JSON.stringify(COMMON)}; autopilot_running "$1" ${flag ?? ''}`;
  return spawnSync('bash', ['-c', script, 'bash', sid], { env: { ...process.env, HOME: home } }).status === 0;
}

/** A dashboard that records every request path and answers health with remote answers off, so a hook that probes stops right after. */
async function fakeDashboard(): Promise<{ url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url === '/api/health' ? JSON.stringify({ remoteAnswer: false, answerSecs: 1 }) : '{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, paths, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** Run `file` (a hook, a link to one, or a copy) once with `payload` on stdin. Async: the fake dashboard answers from this event loop. */
async function runHook(file: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  const child = spawn('bash', [file], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout };
}

export async function run(): Promise<number> {
  console.log('\n=== hook-common.sh ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hooks exit before deciding without it. These cases did not run.`);
      return 0;
    }
  }

  if (await ok('no hook defines dash_curl or autopilot_running itself, and each sources hook-common.sh', () => {
    for (const hook of HOOKS) {
      const src = fs.readFileSync(path.join(SCRIPTS, hook), 'utf8');
      assert.ok(!/^\s*(function\s+)?dash_curl\s*\(\)/m.test(src), `${hook} defines dash_curl`);
      assert.ok(!/^\s*(function\s+)?autopilot_running\s*\(\)/m.test(src), `${hook} defines autopilot_running`);
      assert.ok(!/^DASH=/m.test(src), `${hook} sets DASH itself`);
      assert.match(src, /^\. .*\/hook-common\.sh"/m, `${hook} does not source hook-common.sh`);
    }
  })) p++; else f++;

  if (await ok('hook-common.sh defines DASH, TOKEN_FILE, dash_curl and autopilot_running and never exits', () => {
    const src = fs.readFileSync(COMMON, 'utf8');
    for (const re of [/^DASH=/m, /^TOKEN_FILE=/m, /^dash_curl\(\) \{/m, /^autopilot_running\(\) \{/m]) assert.match(src, re);
    assert.ok(!/\bexit\b/.test(src.replace(/^#.*$/gm, '')), 'a sourced file that exits would end the hook');
  })) p++; else f++;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-common-'));
  const dir = path.join(home, '.claude', 'autopilot');
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    running: JSON.stringify({ status: 'running' }),
    'blocked-0': JSON.stringify({ status: 'blocked', blockPasses: 0 }),
    'blocked-1': JSON.stringify({ status: 'blocked', blockPasses: 1 }),
    blocked: JSON.stringify({ status: 'blocked' }),
    done: JSON.stringify({ status: 'done' }),
    malformed: '{ not json'
  };
  for (const [sid, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${sid}.json`), text);
  // A file a crafted id would reach by walking out of the state dir: `running`, so only the id check keeps it from counting.
  fs.writeFileSync(path.join(home, '.claude', 'escaped.json'), JSON.stringify({ status: 'running' }));

  try {
    const cases: [string, string, boolean, boolean][] = [
      // sid, why, without the flag, with --blocked-unasked
      ['running', 'running', true, true],
      ['blocked-0', 'blocked with blockPasses 0', false, true],
      ['blocked-1', 'blocked with blockPasses 1', false, false],
      ['blocked', 'blocked with no blockPasses', false, false],
      ['done', 'any other status', false, false],
      ['missing', 'a missing file', false, false],
      ['malformed', 'malformed JSON', false, false],
      ['../escaped', 'a session id with `/`', false, false],
      ['', 'an empty session id', false, false]
    ];
    for (const [sid, why, plain, flagged] of cases) {
      if (await ok(`autopilot_running: ${why} → ${plain} plain, ${flagged} with --blocked-unasked`, () => {
        assert.strictEqual(autopilotRunning(home, sid), plain, 'without the flag');
        assert.strictEqual(autopilotRunning(home, sid, '--blocked-unasked'), flagged, 'with --blocked-unasked');
      })) p++; else f++;
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // realpath: on macOS the tmpdir sits behind /var → /private/var, and a relative link has to be computed between real paths.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-common-run-')));
  const dash = await fakeDashboard();
  try {
    const env = hookEnv({ CLAUDE_DASHBOARD_URL: dash.url, HOME: work });
    for (const hook of HOOKS) {
      const name = hook.replace(/-hook\.sh$/, '');
      if (await ok(`${name}: run directly, through an absolute link and through a relative link, it sources the file and reaches the dashboard`, async () => {
        const abs = path.join(work, `${name}.sh`);
        fs.symlinkSync(path.join(SCRIPTS, hook), abs);
        const relDir = path.join(work, 'rel');
        fs.mkdirSync(relDir, { recursive: true });
        const rel = path.join(relDir, `${name}.sh`);
        fs.symlinkSync(path.relative(relDir, path.join(SCRIPTS, hook)), rel);
        for (const file of [path.join(SCRIPTS, hook), abs, rel]) {
          dash.paths.length = 0;
          const r = await runHook(file, PAYLOADS[hook], env);
          assert.strictEqual(r.code, 0, `${file} exit code`);
          assert.ok(dash.paths.length > 0, `${file} never reached the dashboard`);
        }
      })) p++; else f++;

      if (await ok(`${name}: with hook-common.sh missing beside it, exits 0 and prints nothing`, async () => {
        const lone = fs.mkdtempSync(path.join(work, 'lone-'));
        const copy = path.join(lone, hook);
        fs.copyFileSync(path.join(SCRIPTS, hook), copy);
        dash.paths.length = 0;
        const r = await runHook(copy, PAYLOADS[hook], env);
        assert.deepStrictEqual([r.code, r.stdout, dash.paths], [0, '', []]);
      })) p++; else f++;
    }
  } finally {
    await dash.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
