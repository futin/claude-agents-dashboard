import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tr from '../server/lib/token-refresh.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function tmpCwd(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-refresh-')), 'dashboard-refresh');
}

/** A probe that reports `false` until the Nth spawn has happened. */
function probeAfter(calls: { length: number }, n: number): () => boolean {
  return () => calls.length >= n;
}

const ok0: tr.Spawner = () => Promise.resolve({ code: 0 });

export async function run(): Promise<number> {
  console.log('\n=== token-refresh.ts ===\n');
  let p = 0, f = 0;

  // ---- pure gate ----

  if (await test('backoffMs doubles per consecutive failure and caps at an hour', () => {
    assert.strictEqual(tr.backoffMs(0), 0);
    assert.strictEqual(tr.backoffMs(1), 5 * 60_000);
    assert.strictEqual(tr.backoffMs(2), 10 * 60_000);
    assert.strictEqual(tr.backoffMs(3), 20 * 60_000);
    assert.strictEqual(tr.backoffMs(4), 40 * 60_000);
    assert.strictEqual(tr.backoffMs(5), 60 * 60_000);
    assert.strictEqual(tr.backoffMs(50), 60 * 60_000);
  })) p++; else f++;

  if (await test('shouldAutoRefresh: never attempted → true', () => {
    assert.strictEqual(
      tr.shouldAutoRefresh({ inFlight: false, lastAttempt: 0, failures: 0, disabled: false }, 1_000),
      true
    );
  })) p++; else f++;

  if (await test('shouldAutoRefresh: in-flight → false', () => {
    assert.strictEqual(
      tr.shouldAutoRefresh({ inFlight: true, lastAttempt: 0, failures: 0, disabled: false }, 1_000),
      false
    );
  })) p++; else f++;

  if (await test('shouldAutoRefresh: disabled (no CLI on this host) → false forever', () => {
    assert.strictEqual(
      tr.shouldAutoRefresh({ inFlight: false, lastAttempt: 0, failures: 0, disabled: true }, 9e12),
      false
    );
  })) p++; else f++;

  if (await test('shouldAutoRefresh: one failure holds for 5 min, then releases', () => {
    const g = { inFlight: false, lastAttempt: 1_000_000, failures: 1, disabled: false };
    assert.strictEqual(tr.shouldAutoRefresh(g, 1_000_000 + 4 * 60_000), false);
    assert.strictEqual(tr.shouldAutoRefresh(g, 1_000_000 + 5 * 60_000), true);
  })) p++; else f++;

  if (await test('shouldAutoRefresh: three failures hold for 20 min', () => {
    const g = { inFlight: false, lastAttempt: 1_000_000, failures: 3, disabled: false };
    assert.strictEqual(tr.shouldAutoRefresh(g, 1_000_000 + 19 * 60_000), false);
    assert.strictEqual(tr.shouldAutoRefresh(g, 1_000_000 + 20 * 60_000), true);
  })) p++; else f++;

  // ---- runner: the zero-token path ----

  if (await test('token already usable → no spawn at all', async () => {
    const calls: string[][] = [];
    const spawner: tr.Spawner = (_c, args) => { calls.push(args); return Promise.resolve({ code: 0 }); };
    const out = await tr.runTokenRefresh({ spawner, cwd: tmpCwd(), probe: () => true });
    assert.deepStrictEqual(out, { ok: true, step: 'already-ok' });
    assert.strictEqual(calls.length, 0);
  })) p++; else f++;

  if (await test('`claude auth status` alone renews it → one spawn, no turn burned', async () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const spawner: tr.Spawner = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return Promise.resolve({ code: 0 });
    };
    const cwd = tmpCwd();
    const out = await tr.runTokenRefresh({ spawner, cwd, probe: probeAfter(calls, 1) });
    assert.deepStrictEqual(out, { ok: true, step: 'auth-status' });
    assert.strictEqual(calls.length, 1, 'must not burn a turn once the free path worked');
    assert.strictEqual(calls[0].cmd, 'claude');
    assert.deepStrictEqual(calls[0].args, ['auth', 'status']);
    assert.ok(fs.existsSync(cwd), 'refresh cwd created before the first spawn');
  })) p++; else f++;

  // ---- runner: the fallback path ----

  if (await test('auth status does not renew → falls back to one haiku turn', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const spawner: tr.Spawner = (_cmd, args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return Promise.resolve({ code: 0 });
    };
    const cwd = tmpCwd();
    const out = await tr.runTokenRefresh({ spawner, cwd, probe: probeAfter(calls, 2) });
    assert.deepStrictEqual(out, { ok: true, step: 'spawn-turn' });
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].args, ['auth', 'status']);
    assert.deepStrictEqual(calls[1].args, ['-p', 'ok', '--model', 'haiku']);
    assert.strictEqual(calls[1].cwd, cwd, 'the turn runs in the filtered cwd');
  })) p++; else f++;

  if (await test('auth status exits non-zero → still tries the turn', async () => {
    const calls: string[][] = [];
    const spawner: tr.Spawner = (_c, args) => {
      calls.push(args);
      return Promise.resolve(args[0] === 'auth' ? { code: 1, error: 'nope' } : { code: 0 });
    };
    const out = await tr.runTokenRefresh({ spawner, cwd: tmpCwd(), probe: probeAfter(calls, 2) });
    assert.deepStrictEqual(out, { ok: true, step: 'spawn-turn' });
    assert.strictEqual(calls.length, 2);
  })) p++; else f++;

  if (await test('a spawn that renews then hangs is caught by the probe poll, not the timeout', async () => {
    // Measured on macOS 2026-08-27: `claude -p` finishes its turn and renews the
    // token, then does not exit for 90s+ (unchanged by --strict-mcp-config or
    // --no-session-persistence). Waiting for the process would serve
    // `token-expired` for a minute after the token was already good.
    let renewed = false;
    const never = new Promise<tr.SpawnResult>(() => { /* never settles */ });
    const spawner: tr.Spawner = () => {
      // the CLI renews out-of-band, then the process hangs instead of exiting
      setTimeout(() => { renewed = true; }, 20);
      return never;
    };
    const t0 = Date.now();
    const out = await tr.runTokenRefresh({
      spawner,
      cwd: tmpCwd(),
      probe: () => renewed,
      probePollMs: 5
    });
    assert.deepStrictEqual(out, { ok: true, step: 'auth-status' });
    assert.ok(Date.now() - t0 < 2_000, 'must not wait on a process that never exits');
  })) p++; else f++;

  // ---- runner: failure modes ----

  if (await test('exit 0 but the token is STILL expired → 502, not a false success', async () => {
    const out = await tr.runTokenRefresh({ spawner: ok0, cwd: tmpCwd(), probe: () => false });
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.match(out.error, /still/i);
      assert.notStrictEqual(out.cliMissing, true);
    }
  })) p++; else f++;

  if (await test('ENOENT on both steps → 502 and cliMissing (Docker / no CLI)', async () => {
    const spawner: tr.Spawner = () => Promise.resolve({ code: null, error: 'claude CLI not found on PATH', notFound: true });
    const out = await tr.runTokenRefresh({ spawner, cwd: tmpCwd(), probe: () => false });
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.strictEqual(out.cliMissing, true);
      assert.match(out.error, /not found/);
    }
  })) p++; else f++;

  if (await test('spawner rejection → 502, in-flight flag released', async () => {
    const boom: tr.Spawner = () => Promise.reject(new Error('boom'));
    const out = await tr.runTokenRefresh({ spawner: boom, cwd: tmpCwd(), probe: () => false });
    assert.strictEqual(out.ok, false);
    if (!out.ok) assert.strictEqual(out.httpStatus, 502);
    const again = await tr.runTokenRefresh({ spawner: ok0, cwd: tmpCwd(), probe: () => true });
    assert.deepStrictEqual(again, { ok: true, step: 'already-ok' });
  })) p++; else f++;

  if (await test('concurrent call while one runs → 409; first still succeeds', async () => {
    let release!: () => void;
    let renewed = false;
    const gate = new Promise<tr.SpawnResult>((resolve) => { release = () => resolve({ code: 0 }); });
    // Must stay genuinely in flight: neither `already-ok` nor a probe that goes
    // true would hold the flight long enough for the second call to contend.
    const slow: tr.Spawner = () => gate;
    const first = tr.runTokenRefresh({ spawner: slow, cwd: tmpCwd(), probe: () => renewed, probePollMs: 5 });
    // give the first call a tick to claim the flight
    await new Promise((r) => setImmediate(r));
    const second = await tr.runTokenRefresh({ spawner: ok0, cwd: tmpCwd(), probe: () => false });
    assert.strictEqual(second.ok, false);
    if (!second.ok) assert.strictEqual(second.httpStatus, 409);
    renewed = true;
    release();
    const out = await first;
    assert.strictEqual(out.ok, true);
  })) p++; else f++;

  // ---- cwd ----

  // ---- autoRenew: the fire-and-forget state machine usage.ts drives ----

  if (await test('autoRenew: first call runs; a failure then holds it for the backoff', async () => {
    tr.resetAutoRenew();
    let runs = 0;
    const run = async (): Promise<tr.RefreshOutcome> => {
      runs++;
      return { ok: false, httpStatus: 502, error: 'nope' };
    };
    await tr.autoRenew({ probe: () => false, run, now: 1_000_000 });
    assert.strictEqual(runs, 1);
    assert.strictEqual(tr.autoRenewGate().failures, 1);
    // 4 min later: still held.
    await tr.autoRenew({ probe: () => false, run, now: 1_000_000 + 4 * 60_000 });
    assert.strictEqual(runs, 1, 'must not respawn inside the backoff');
    // 5 min later: released.
    await tr.autoRenew({ probe: () => false, run, now: 1_000_000 + 5 * 60_000 });
    assert.strictEqual(runs, 2);
    assert.strictEqual(tr.autoRenewGate().failures, 2);
  })) p++; else f++;

  if (await test('autoRenew: success resets the failure count and fires onRenewed', async () => {
    tr.resetAutoRenew();
    let renewed = 0;
    await tr.autoRenew({
      probe: () => false,
      run: async () => ({ ok: false, httpStatus: 502, error: 'nope' }),
      now: 1_000_000
    });
    assert.strictEqual(tr.autoRenewGate().failures, 1);
    await tr.autoRenew({
      probe: () => false,
      run: async () => ({ ok: true, step: 'auth-status' }),
      now: 1_000_000 + 10 * 60_000,
      onRenewed: () => { renewed++; }
    });
    assert.strictEqual(renewed, 1);
    assert.strictEqual(tr.autoRenewGate().failures, 0);
  })) p++; else f++;

  if (await test('autoRenew: cliMissing disables it permanently (Docker)', async () => {
    tr.resetAutoRenew();
    let runs = 0;
    const run = async (): Promise<tr.RefreshOutcome> => {
      runs++;
      return { ok: false, httpStatus: 502, error: 'claude CLI not found on PATH', cliMissing: true };
    };
    await tr.autoRenew({ probe: () => false, run, now: 1_000_000 });
    assert.strictEqual(runs, 1);
    assert.strictEqual(tr.autoRenewGate().disabled, true);
    // A day later it still refuses — retrying a missing binary is pure waste.
    await tr.autoRenew({ probe: () => false, run, now: 1_000_000 + 24 * 3_600_000 });
    assert.strictEqual(runs, 1);
  })) p++; else f++;

  if (await test('autoRenew: a 409 is not counted as a failure', async () => {
    tr.resetAutoRenew();
    await tr.autoRenew({
      probe: () => false,
      run: async () => ({ ok: false, httpStatus: 409, error: 'refresh already running' }),
      now: 1_000_000
    });
    assert.strictEqual(tr.autoRenewGate().failures, 0, 'losing a race is not a failure');
    assert.strictEqual(tr.autoRenewGate().disabled, false);
  })) p++; else f++;

  if (await test('autoRenew: a throwing runner counts as a failure, never escapes', async () => {
    tr.resetAutoRenew();
    await tr.autoRenew({
      probe: () => false,
      run: async () => { throw new Error('boom'); },
      now: 1_000_000
    });
    assert.strictEqual(tr.autoRenewGate().failures, 1);
    assert.strictEqual(tr.autoRenewGate().inFlight, false, 'flight released after a throw');
  })) p++; else f++;

  if (await test('refreshCwd is a dedicated dir under the given home', () => {
    assert.strictEqual(tr.refreshCwd('/h'), path.join('/h', '.claude', 'dashboard-refresh'));
  })) p++; else f++;

  console.log(`\ntoken-refresh: ${p} passed, ${f} failed`);
  return f;
}
