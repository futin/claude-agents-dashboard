/**
 * The write gate: loopback and (behind `trustTailnet`) tailnet peers write with no token; `ANSWER_TOKEN` is a pass from any address; anyone else is
 * refused, with a body that says whether a token would help. See docs/superpowers/specs/2026-10-16-tailnet-write-trust-design.md.
 *
 * The harness listens on 127.0.0.1, so every request here has a loopback socket. A remote peer is played the way a local proxy delivers one, with an
 * `X-Forwarded-For` the proxy would have appended. The one case a loopback harness cannot produce, a non-loopback socket, calls `refuseWrite` directly.
 */

import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { refuseWrite, writeAccessFor } from '../server/api.js';
import { loadConfig } from '../server/lib/config.js';
import { resetSettings } from '../server/lib/settings.js';
import type { ConnectionOrigin, WriteAccess } from '../shared/types.js';
import { testAsync, withServer } from './api-harness.js';
import type { Harness, Reply } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const TOKEN = 'tok-123';
const WITH_TOKEN = `${ENV}ANSWER_TOKEN=${TOKEN}\n`;
const LAN = { 'X-Forwarded-For': '192.168.1.5' };
const TAILNET = { 'X-Forwarded-For': '100.101.102.103' };

const READ_ONLY = 'read-only from this network';

function write(h: Harness, headers: Record<string, string> = {}): Promise<Reply> {
  return h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: true }), headers });
}

function setTrust(h: Harness, on: boolean, headers: Record<string, string> = {}): Promise<Reply> {
  return h.req('/api/settings', { method: 'POST', body: JSON.stringify({ trustTailnet: on }), headers });
}

/** A fresh settings cache per server: the harness runs in this process, so the cache would otherwise leak across modules. */
async function serve(env: string, fn: (h: Harness) => Promise<void>): Promise<void> {
  resetSettings();
  try { await withServer(env, fn); } finally { resetSettings(); }
}

export async function run(): Promise<number> {
  console.log('\n=== write gate: loopback, tailnet, token ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('local with no token set writes', () => serve(ENV, async h => {
    assert.equal((await write(h)).status, 200);
  })));

  check(await testAsync('local with a token set writes without sending it', () => serve(WITH_TOKEN, async h => {
    assert.equal((await write(h)).status, 200);
  })));

  check(await testAsync('tailnet with the switch on (default) and no token set writes', () => serve(ENV, async h => {
    assert.equal((await write(h, TAILNET)).status, 200);
  })));

  check(await testAsync('tailnet with the switch off: bad token without a bearer, 200 with the right one', () => serve(WITH_TOKEN, async h => {
    assert.equal((await setTrust(h, false)).status, 200);
    const refused = await write(h, TAILNET);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, 'bad token');
    assert.equal((await write(h, { ...TAILNET, Authorization: `Bearer ${TOKEN}` })).status, 200);
  })));

  check(await testAsync('tailnet with the switch off and no token set is read-only', () => serve(ENV, async h => {
    assert.equal((await setTrust(h, false)).status, 200);
    const refused = await write(h, TAILNET);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, READ_ONLY);
  })));

  check(await testAsync('lan with a token set: the right bearer writes, a wrong or missing one is bad token', () => serve(WITH_TOKEN, async h => {
    assert.equal((await write(h, { ...LAN, Authorization: `Bearer ${TOKEN}` })).status, 200);
    for (const headers of [{ ...LAN, Authorization: 'Bearer wrong' }, LAN]) {
      const refused = await write(h, headers);
      assert.equal(refused.status, 403);
      assert.equal(refused.json?.error, 'bad token');
    }
  })));

  check(await testAsync('lan with no token set is read-only (the behaviour change)', () => serve(ENV, async h => {
    const refused = await write(h, LAN);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, READ_ONLY);
  })));

  check(await testAsync('POST /api/settings from lan with no token set is refused and changes nothing', () => serve(ENV, async h => {
    const refused = await setTrust(h, false, LAN);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, READ_ONLY);
    assert.equal((await h.req('/api/settings')).json?.trustTailnet, true);
  })));

  check(await testAsync('a tailnet device that turns the switch off is refused from its next write on', () => serve(ENV, async h => {
    assert.equal((await setTrust(h, false, TAILNET)).status, 200, 'the request that turns it off was allowed when it arrived');
    const refused = await write(h, TAILNET);
    assert.equal(refused.status, 403);
    assert.equal(refused.json?.error, READ_ONLY);
    assert.equal((await setTrust(h, true)).status, 200, 'this machine can always turn it back on');
    assert.equal((await write(h, TAILNET)).status, 200);
  })));

  check(await testAsync('GET /api/health reports writeAccess and tokenRequired for the calling peer', async () => {
    const health = async (h: Harness, headers: Record<string, string> = {}): Promise<unknown> => {
      const j = (await h.req('/api/health', { headers })).json as Record<string, unknown>;
      return [j.writeAccess, j.tokenRequired, j.origin];
    };
    await serve(WITH_TOKEN, async h => {
      assert.deepStrictEqual(await health(h), ['open', false, 'local']);
      assert.deepStrictEqual(await health(h, TAILNET), ['open', false, 'tailnet']);
      assert.deepStrictEqual(await health(h, LAN), ['token', true, 'lan']);
      assert.deepStrictEqual(await health(h, { ...LAN, Authorization: `Bearer ${TOKEN}` }), ['token', true, 'lan'], 'health never checks the bearer');
      assert.equal((await setTrust(h, false)).status, 200);
      assert.deepStrictEqual(await health(h, TAILNET), ['token', true, 'tailnet']);
    });
    await serve(ENV, async h => {
      assert.deepStrictEqual(await health(h, TAILNET), ['open', false, 'tailnet']);
      assert.deepStrictEqual(await health(h, LAN), ['none', false, 'lan']);
    });
  }));

  check(await testAsync('a non-loopback socket ignores a forged tailnet X-Forwarded-For', async () => {
    resetSettings();
    const req = {
      method: 'POST', url: '/api/remote-answer',
      socket: { remoteAddress: '192.168.1.5' },
      headers: { 'x-forwarded-for': '100.101.102.103' }
    } as unknown as IncomingMessage;
    let status = 0, body = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(chunk?: string) { body = chunk ?? ''; return this; }
    } as unknown as ServerResponse;
    const cfg = loadConfig({ envPath: '/nonexistent/.env' });
    assert.equal(refuseWrite(cfg, req, res), true);
    assert.equal(status, 403);
    assert.equal(JSON.parse(body).error, READ_ONLY);
  }));

  check(await testAsync('writeAccessFor follows the rule table; unknown behaves as lan', async () => {
    const rows: [ConnectionOrigin, boolean, boolean, WriteAccess][] = [
      ['local', false, false, 'open'], ['local', true, true, 'open'],
      ['tailnet', true, false, 'open'], ['tailnet', true, true, 'open'],
      ['tailnet', false, true, 'token'], ['tailnet', false, false, 'none'],
      ['lan', true, true, 'token'], ['lan', true, false, 'none'],
      ['unknown', true, true, 'token'], ['unknown', true, false, 'none']
    ];
    for (const [peer, trust, tokenSet, want] of rows) {
      assert.equal(writeAccessFor(peer, trust, tokenSet), want, `${peer} trust=${trust} token=${tokenSet}`);
    }
  }));

  console.log(`\nwrite gate: ${ok}/${total} passed`);
  return total - ok;
}
