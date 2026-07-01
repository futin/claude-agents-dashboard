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

export async function run(): Promise<number> {
  console.log('\n=== token-refresh.ts ===\n');
  let p = 0, f = 0;

  if (await test('success: exit 0 → ok, cwd created, claude -p invoked', async () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const spawner: tr.Spawner = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return Promise.resolve({ code: 0 });
    };
    const cwd = tmpCwd();
    const out = await tr.runTokenRefresh(spawner, cwd);
    assert.deepStrictEqual(out, { ok: true });
    assert.ok(fs.existsSync(cwd), 'refresh cwd created');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'claude');
    assert.deepStrictEqual(calls[0].args, ['-p', 'ok', '--model', 'haiku']);
    assert.strictEqual(calls[0].cwd, cwd);
  })) p++; else f++;

  if (await test('non-zero exit → 502 with message', async () => {
    const spawner: tr.Spawner = () => Promise.resolve({ code: 1, error: 'claude exited with code 1' });
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.match(out.error, /exited/);
    }
  })) p++; else f++;

  if (await test('ENOENT (claude not on PATH) → 502 with clear message', async () => {
    const spawner: tr.Spawner = () => Promise.resolve({ code: null, error: 'claude CLI not found on PATH' });
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) {
      assert.strictEqual(out.httpStatus, 502);
      assert.match(out.error, /not found/);
    }
  })) p++; else f++;

  if (await test('spawner rejection → 502, in-flight flag released', async () => {
    const spawner: tr.Spawner = () => Promise.reject(new Error('boom'));
    const out = await tr.runTokenRefresh(spawner, tmpCwd());
    assert.strictEqual(out.ok, false);
    if (!out.ok) assert.strictEqual(out.httpStatus, 502);
    // flag released → a following call runs (doesn't 409)
    const again = await tr.runTokenRefresh(() => Promise.resolve({ code: 0 }), tmpCwd());
    assert.deepStrictEqual(again, { ok: true });
  })) p++; else f++;

  if (await test('concurrent call while one runs → 409; first still succeeds', async () => {
    let release!: () => void;
    const gate = new Promise<tr.SpawnResult>((resolve) => { release = () => resolve({ code: 0 }); });
    const slow: tr.Spawner = () => gate;
    const cwd = tmpCwd();
    const first = tr.runTokenRefresh(slow, cwd);          // not awaited — in flight
    const second = await tr.runTokenRefresh(slow, cwd);   // must bounce
    assert.strictEqual(second.ok, false);
    if (!second.ok) assert.strictEqual(second.httpStatus, 409);
    release();
    assert.deepStrictEqual(await first, { ok: true });
  })) p++; else f++;

  const { serveUsageRefresh } = await import('../server/api.js');

  interface FakeRes { code: number; body: string }
  function fakeRes(): FakeRes & { res: unknown } {
    const state = { code: 0, body: '' } as FakeRes & { res: unknown };
    state.res = {
      writeHead(code: number) { state.code = code; },
      end(body: string) { state.body = body; }
    };
    return state;
  }
  const cfg = (showUsage: boolean) => ({ showUsage }) as import('../server/lib/config.js').Config;

  if (await test('serveUsageRefresh: SHOW_USAGE off → 404', async () => {
    const r = fakeRes();
    await serveUsageRefresh(cfg(false), r.res as never, {});
    assert.strictEqual(r.code, 404);
    assert.strictEqual(JSON.parse(r.body).ok, false);
  })) p++; else f++;

  if (await test('serveUsageRefresh: spawn ok → 200 with fresh usage snapshot', async () => {
    const r = fakeRes();
    await serveUsageRefresh(cfg(true), r.res as never, {
      spawner: () => Promise.resolve({ code: 0 }),
      cwd: tmpCwd(),
      refreshUsage: () => Promise.resolve({
        usage: { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: { utilization: 30, resetsAt: null } },
        status: 'ok' as const
      })
    });
    assert.strictEqual(r.code, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.usageStatus, 'ok');
    assert.strictEqual(body.usage.fiveHour.utilization, 12);
  })) p++; else f++;

  if (await test('serveUsageRefresh: spawn fails → 502, no usage fetch', async () => {
    const r = fakeRes();
    let fetched = false;
    await serveUsageRefresh(cfg(true), r.res as never, {
      spawner: () => Promise.resolve({ code: null, error: 'claude CLI not found on PATH' }),
      cwd: tmpCwd(),
      refreshUsage: () => { fetched = true; return Promise.resolve({ usage: null, status: 'unavailable' as const }); }
    });
    assert.strictEqual(r.code, 502);
    assert.match(JSON.parse(r.body).error, /not found/);
    assert.strictEqual(fetched, false);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()) > 0 ? 1 : 0);
