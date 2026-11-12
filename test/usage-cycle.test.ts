/**
 * The usage fetch cycle (`refreshNow` / `fetchUsage`) against a local HTTP server. `CLAUDE_USAGE_BASE_URL` points the request at it, and
 * `setUsageCycleDeps` replaces the keychain read and the renewal spawn, so nothing here touches the real keychain, `claude`, or the network.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import * as usage from '../server/lib/usage.js';
import type { TokenState } from '../server/lib/usage.js';
import type { AutoRenewOptions } from '../server/lib/token-refresh.js';
import { resetSettings } from '../server/lib/settings.js';
import { resetPaceStore } from '../server/lib/usage-pace.js';

async function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A request the fake endpoint is holding; the test decides when and how it is answered. */
interface Held {
  token: string;
  res: http.ServerResponse;
}

function body(fiveHour: number): string {
  return JSON.stringify({ five_hour: { utilization: fiveHour, resets_at: null }, seven_day: { utilization: 1, resets_at: null } });
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

/** Rejects if `p` has not settled within `ms` — so a hang reads as a failure instead of a stuck suite. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms}ms`)), ms); });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

export async function run(): Promise<number> {
  console.log('\n=== usage.ts fetch cycle ===\n');
  let p = 0, f = 0;

  // Every request lands here; `onRequest` scripts the reply, and `waitForRequests` lets a test hold replies back.
  const held: Held[] = [];
  let onRequest: (h: Held) => void = (h) => held.push(h);
  let waiters: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    onRequest({ token: auth.replace(/^Bearer /, ''), res });
    const w = waiters; waiters = []; w.forEach((fn) => fn());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const waitForRequests = (n: number): Promise<void> => new Promise((resolve) => {
    const check = () => { if (held.length >= n) resolve(); else waiters.push(check); };
    check();
  });

  const prevBase = process.env.CLAUDE_USAGE_BASE_URL;
  process.env.CLAUDE_USAGE_BASE_URL = `http://127.0.0.1:${port}`;
  // Settings resolve from the cwd: an empty dir keeps `recordUsageHistory` at its default (off), so no cycle writes a history or ledger file.
  const prevCwd = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cycle-')));
  resetSettings();
  const realNow = Date.now;

  // Each test starts from boot state with a token source of its own; a renewal is recorded, never spawned.
  let renewals: AutoRenewOptions[] = [];
  let reads = 0;
  const setup = (tokens: (() => TokenState)) => {
    usage.resetUsageCache();
    held.length = 0;
    onRequest = (h) => held.push(h);
    renewals = [];
    reads = 0;
    usage.setUsageCycleDeps({
      readToken: () => { reads++; return tokens(); },
      autoRenew: async (o) => { renewals.push(o); }
    });
    usage.setUsageAutoRefresh(true);
  };

  try {
    if (await test('fetchUsage: 2xx JSON → mapped limits, with the bearer token sent', async () => {
      setup(() => ({ state: 'missing' }));
      onRequest = (h) => { held.push(h); reply(h.res, 200, body(17)); };
      const u = await within(usage.fetchUsage('tok-x'), 2000, 'fetchUsage');
      assert.strictEqual(u?.fiveHour.utilization, 17);
      assert.strictEqual(held[0].token, 'tok-x');
    })) p++; else f++;

    if (await test('fetchUsage: non-2xx → null, even when the body is a valid usage payload', async () => {
      setup(() => ({ state: 'missing' }));
      for (const status of [500, 429, 401]) {
        onRequest = (h) => reply(h.res, status, body(42));
        assert.strictEqual(await within(usage.fetchUsage('tok'), 2000, `status ${status}`), null, `status ${status}`);
      }
    })) p++; else f++;

    if (await test('fetchUsage: 2xx with a body that is not JSON → null', async () => {
      setup(() => ({ state: 'missing' }));
      onRequest = (h) => reply(h.res, 200, '<html>gateway</html>');
      assert.strictEqual(await within(usage.fetchUsage('tok'), 2000, 'fetchUsage'), null);
    })) p++; else f++;

    if (await test('fetchUsage: an endpoint that never answers times out → null', async () => {
      setup(() => ({ state: 'missing' }));
      // Held and never answered: only the request timeout can settle the promise.
      assert.strictEqual(await within(usage.fetchUsage('tok', 100), 2000, 'fetchUsage'), null);
    })) p++; else f++;

    if (await test('refreshNow: overlapping cycles — the older settling last does not overwrite the newer', async () => {
      let n = 0;
      setup(() => ({ state: 'ok', token: n++ === 0 ? 'tok-old' : 'tok-new' }));
      const old = usage.refreshNow(true);
      await waitForRequests(1);
      // Past the stall window, the gate abandons the old cycle and lets a new one start.
      const start = realNow();
      Date.now = () => start + 50_000;
      const fresh = usage.refreshNow(true);
      await waitForRequests(2);
      const byToken = (t: string) => held.find((h) => h.token === t)!;
      reply(byToken('tok-new').res, 200, body(10));
      await within(fresh, 2000, 'new cycle');
      reply(byToken('tok-old').res, 200, body(99));
      await within(old, 2000, 'old cycle');
      const state = usage.getCachedUsageState();
      assert.strictEqual(state.status, 'ok');
      assert.strictEqual(state.usage?.fiveHour.utilization, 10, 'the abandoned cycle must not write the cache');
    })) p++; else f++;
    Date.now = realNow;

    if (await test('refreshNow: a cycle that settles synchronously is released, so the next one starts', async () => {
      setup(() => ({ state: 'missing' }));
      await within(usage.refreshNow(true), 2000, 'first cycle');
      assert.strictEqual(reads, 1);
      await within(usage.refreshNow(true), 2000, 'second cycle');
      assert.strictEqual(reads, 2, 'a settled cycle left pinned as in-flight blocks the next one');
      assert.strictEqual(usage.getCachedUsageState().status, 'unavailable');
    })) p++; else f++;

    if (await test('refreshNow: an expired token reports token-expired and asks for one renewal', async () => {
      setup(() => ({ state: 'expired' }));
      await within(usage.refreshNow(true), 2000, 'cycle');
      assert.strictEqual(usage.getCachedUsageState().status, 'token-expired');
      assert.strictEqual(renewals.length, 1);
      assert.strictEqual(held.length, 0, 'no request goes out without a usable token');
    })) p++; else f++;

    if (await test('refreshNow: no renewal for a valid, missing or signed-out token, nor with auto-refresh off', async () => {
      setup(() => ({ state: 'ok', token: 'tok' }));
      onRequest = (h) => reply(h.res, 200, body(5));
      await within(usage.refreshNow(true), 2000, 'ok cycle');
      assert.strictEqual(usage.getCachedUsageState().status, 'ok');
      assert.strictEqual(renewals.length, 0, 'valid token');

      for (const state of ['missing', 'signed-out'] as const) {
        setup(() => ({ state }));
        await within(usage.refreshNow(true), 2000, `${state} cycle`);
        assert.strictEqual(renewals.length, 0, state);
      }

      setup(() => ({ state: 'expired' }));
      usage.setUsageAutoRefresh(false);
      await within(usage.refreshNow(true), 2000, 'expired cycle, auto-refresh off');
      assert.strictEqual(renewals.length, 0, 'auto-refresh off');
    })) p++; else f++;

    if (await test('refreshNow: a non-2xx reply leaves the cache empty and unavailable', async () => {
      setup(() => ({ state: 'ok', token: 'tok' }));
      onRequest = (h) => reply(h.res, 503, body(42));
      await within(usage.refreshNow(true), 2000, 'cycle');
      assert.deepStrictEqual(usage.getCachedUsageState(), { usage: null, status: 'unavailable' });
    })) p++; else f++;
  } finally {
    Date.now = realNow;
    usage.setUsageCycleDeps(null);
    usage.setUsageAutoRefresh(true);
    usage.resetUsageCache();
    resetPaceStore();
    resetSettings();
    process.chdir(prevCwd);
    if (prevBase === undefined) delete process.env.CLAUDE_USAGE_BASE_URL;
    else process.env.CLAUDE_USAGE_BASE_URL = prevBase;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${p} passed, ${f} failed`);
  return f;
}
