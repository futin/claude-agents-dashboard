/**
 * `remote-decision-hook.sh` injects its away-mode banner once per session, not on every prompt — and never lets the rules silently lapse.
 *
 * The banner is ~2 KB of identical text; on every prompt of a 15-prompt session that was ~10k tokens of copies sitting in the transcript (context-floor
 * audit, 2026-11-13). The hook now keeps a per-session marker of what it last told the model and prints only when that changes: the first prompt, a
 * mode flip either way, and a SessionStart after compaction, resume or /clear, when the earlier copy may have left the context. A marker it cannot read
 * or write must cost tokens, not the rules, so that case prints the full banner every time — the old behaviour.
 *
 * Each case runs the real script the way the CLI does (`CLAUDECODE=1`, one payload on stdin) with HOME in a temp dir, so the marker directory under
 * `$HOME/.claude/hooks/` is the case's own, against an in-process dashboard whose `/api/health` body the case can change between runs. Async `spawn`,
 * never `spawnSync`: the dashboard answers from this process's own event loop, which a sync child would block.
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

/** First line of the full banner, and of the one-line retraction printed when the mode turns off. */
const ARMED = 'REMOTE DECISION MODE — the dashboard is accepting remote answers';
const OFF = 'REMOTE DECISION MODE is OFF';
const NOT_ARMED = 'REMOTE DECISION MODE is NOT armed';

const prompt = (session: string, mode = 'auto') => ({ session_id: session, hook_event_name: 'UserPromptSubmit', permission_mode: mode });
const sessionStart = (session: string, source: string, mode?: string) =>
  ({ session_id: session, hook_event_name: 'SessionStart', source, ...(mode ? { permission_mode: mode } : {}) });

interface Rig { home: string; health: Record<string, unknown> | null; hook: (payload: Record<string, unknown>) => Promise<string>; close: () => Promise<void> }

/** A temp HOME plus a dashboard whose `/api/health` answers whatever `rig.health` holds at the time of the request; `null` answers 500. */
async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-decision-'));
  const r = { home, health: { remoteAnswer: true } as Record<string, unknown> } as Rig;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (r.health === null) { res.statusCode = 500; res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/health' ? r.health : {}));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  r.hook = async payload => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: '1', CLAUDE_DASHBOARD_URL: url, HOME: home };
    for (const k of ['CLAUDE_DASHBOARD_ROUTINE', 'CLAUDE_DASHBOARD_SCHEDULE', 'CLAUDE_DASHBOARD_DECISION_MODES', 'CLAUDE_CONFIG_DIR']) delete env[k];
    const child = spawn('bash', [path.join(REPO, 'scripts', 'remote-decision-hook.sh')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stdin.end(JSON.stringify(payload));
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.strictEqual(code, 0, 'the hook always exits 0 — a non-zero UserPromptSubmit exit would block or warn on the prompt');
    return stdout;
  };
  r.close = () => new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => { fs.rmSync(home, { recursive: true, force: true }); resolve(); });
  });
  return r;
}

const isBanner = (out: string) => out.startsWith(ARMED);

async function ok(name: string, fn: (r: Rig) => Promise<void>): Promise<boolean> {
  const r = await rig();
  try { await fn(r); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  finally { await r.close(); }
}

export async function run(): Promise<number> {
  console.log('\n=== remote-decision-hook.sh: banner once per session ===\n');
  let p = 0, f = 0;

  for (const tool of ['jq', 'curl']) {
    if (spawnSync(tool, ['--version']).status !== 0) {
      console.log(`  ⚠ SKIPPED — ${tool} is not installed, and the hook exits before deciding without it. These cases did not run.`);
      return 0;
    }
  }

  if (await ok('first prompt prints the full banner; the second prompt of the same session prints nothing', async r => {
    const first = await r.hook(prompt('s1'));
    assert.ok(isBanner(first), `expected the full banner, got:\n${first}`);
    assert.strictEqual(await r.hook(prompt('s1')), '');
    assert.strictEqual(await r.hook(prompt('s1')), '', 'a third prompt is silent too — the marker is not one-shot');
  })) p++; else f++;

  if (await ok('a new session id prints the full banner even after another session was told', async r => {
    await r.hook(prompt('s1'));
    const other = await r.hook(prompt('s2'));
    assert.ok(isBanner(other), `expected the full banner for a new session, got:\n${other}`);
  })) p++; else f++;

  if (await ok('a switch between two auto-ish modes is not a flip: the banner does not repeat', async r => {
    await r.hook(prompt('s1', 'auto'));
    assert.strictEqual(await r.hook(prompt('s1', 'bypassPermissions')), '');
  })) p++; else f++;

  for (const source of ['compact', 'resume', 'clear']) {
    if (await ok(`SessionStart source=${source} re-prints the full banner, and the next prompt stays silent`, async r => {
      await r.hook(prompt('s1'));
      const again = await r.hook(sessionStart('s1', source, 'auto'));
      assert.ok(isBanner(again), `expected the full banner after ${source}, got:\n${again}`);
      assert.strictEqual(await r.hook(prompt('s1')), '');
    })) p++; else f++;
  }

  if (await ok('SessionStart without permission_mode in its payload falls back to the mode the marker recorded', async r => {
    await r.hook(prompt('s1', 'bypassPermissions'));
    const again = await r.hook(sessionStart('s1', 'compact'));
    assert.ok(isBanner(again), `expected the full banner from the recorded mode, got:\n${again}`);
  })) p++; else f++;

  if (await ok('SessionStart source=startup prints nothing — the first prompt does that', async r => {
    assert.strictEqual(await r.hook(sessionStart('s1', 'startup', 'auto')), '');
    assert.ok(isBanner(await r.hook(prompt('s1'))));
  })) p++; else f++;

  if (await ok('SessionStart compact for a session that was never armed prints nothing', async r => {
    r.health = { remoteAnswer: false };
    await r.hook(prompt('s1'));
    assert.strictEqual(await r.hook(sessionStart('s1', 'compact', 'auto')), '');
  })) p++; else f++;

  if (await ok('remote answers turned off prints one OFF line once; turned back on prints the full banner again', async r => {
    await r.hook(prompt('s1'));
    r.health = { remoteAnswer: false };
    const off = await r.hook(prompt('s1'));
    assert.ok(off.startsWith(OFF), `expected the OFF line, got:\n${off}`);
    assert.strictEqual(off.trim().split('\n').length, 1, `the OFF notice is one line, got:\n${off}`);
    assert.strictEqual(await r.hook(prompt('s1')), '', 'the OFF line is not repeated');
    r.health = { remoteAnswer: true };
    assert.ok(isBanner(await r.hook(prompt('s1'))), 'turning remote answers back on re-arms the full banner');
    assert.strictEqual(await r.hook(prompt('s1')), '');
  })) p++; else f++;

  if (await ok('permission mode leaving the auto-ish set prints the OFF line; returning prints the full banner', async r => {
    await r.hook(prompt('s1', 'auto'));
    const off = await r.hook(prompt('s1', 'default'));
    assert.ok(off.startsWith(OFF), `expected the OFF line, got:\n${off}`);
    assert.ok(isBanner(await r.hook(prompt('s1', 'auto'))));
  })) p++; else f++;

  if (await ok('the health probe failing after the banner counts as off: the OFF line, not silence', async r => {
    await r.hook(prompt('s1'));
    r.health = null;
    assert.ok((await r.hook(prompt('s1'))).startsWith(OFF));
  })) p++; else f++;

  if (await ok('a session that was never armed prints nothing when off, and writes no marker', async r => {
    r.health = { remoteAnswer: false };
    assert.strictEqual(await r.hook(prompt('s1')), '');
    assert.strictEqual(await r.hook(prompt('s1', 'default')), '');
    assert.ok(!fs.existsSync(path.join(r.home, '.claude', 'hooks', '.remote-decision', 's1')), 'an off session leaves nothing on disk');
  })) p++; else f++;

  if (await ok('the NOT armed notice is also once per session, and fixing the token prints the full banner', async r => {
    r.health = { remoteAnswer: true, tokenRequired: true };
    assert.ok((await r.hook(prompt('s1'))).startsWith(NOT_ARMED));
    assert.strictEqual(await r.hook(prompt('s1')), '');
    fs.writeFileSync(path.join(r.home, '.claude', 'hooks', 'dashboard-token'), 'tok\n');
    assert.ok(isBanner(await r.hook(prompt('s1'))));
  })) p++; else f++;

  if (await ok('an unwritable marker directory prints the full banner on every prompt (fail safe)', async r => {
    // A plain file where the marker directory should be: mkdir and every write under it fail, even for root, which a chmod would not stop.
    fs.mkdirSync(path.join(r.home, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(r.home, '.claude', 'hooks', '.remote-decision'), '');
    assert.ok(isBanner(await r.hook(prompt('s1'))));
    assert.ok(isBanner(await r.hook(prompt('s1'))), 'without a marker the second prompt must still carry the rules');
  })) p++; else f++;

  if (await ok('an unreadable or garbled marker prints the full banner (fail safe)', async r => {
    await r.hook(prompt('s1'));
    fs.writeFileSync(path.join(r.home, '.claude', 'hooks', '.remote-decision', 's1'), 'garbage\n');
    assert.ok(isBanner(await r.hook(prompt('s1'))));
  })) p++; else f++;

  if (await ok('a session id outside [A-Za-z0-9_-] is never used as a path: full banner every prompt, nothing written', async r => {
    assert.ok(isBanner(await r.hook(prompt('../escape'))));
    assert.ok(isBanner(await r.hook(prompt('../escape'))));
    assert.ok(!fs.existsSync(path.join(r.home, '.claude', 'hooks', 'escape')));
  })) p++; else f++;

  if (await ok('markers older than 7 days are pruned when a marker is written', async r => {
    await r.hook(prompt('old'));
    const old = path.join(r.home, '.claude', 'hooks', '.remote-decision', 'old');
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    await r.hook(prompt('new'));
    assert.ok(!fs.existsSync(old), 'the stale marker should be gone');
    assert.ok(fs.existsSync(path.join(r.home, '.claude', 'hooks', '.remote-decision', 'new')));
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
