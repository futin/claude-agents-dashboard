import assert from 'node:assert';

import { postWrite } from '../client/src/lib/postWrite.js';

function test(name: string, fn: () => Promise<void>): Promise<boolean> {
  return fn().then(
    () => { console.log('  ✓ ' + name); return true; },
    e => { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
  );
}

interface Call { url: string; init: RequestInit }

/** A `fetch` that records its arguments and answers `status` with `json` as the body's parse. */
function stub(status: number, json: () => Promise<unknown>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const replying = (status: number, body: unknown) => stub(status, async () => body);

export async function run(): Promise<number> {
  console.log('\n=== postWrite.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(await test('200 → ok, no refusal, the parsed body', async () => {
    const { fetchImpl } = replying(200, { sessionId: 's1' });
    assert.deepStrictEqual(await postWrite('/api/x', { token: '', body: {}, fetchImpl }),
      { status: 200, ok: true, refusal: null, body: { sessionId: 's1' } });
  }));

  tally(await test('403 read-only body → refusal read-only', async () => {
    const { fetchImpl } = replying(403, { error: 'read-only from this network' });
    assert.strictEqual((await postWrite('/api/x', { token: '', body: {}, fetchImpl })).refusal, 'read-only');
  }));

  tally(await test('403 bad token → refusal token', async () => {
    const { fetchImpl } = replying(403, { error: 'bad token' });
    assert.strictEqual((await postWrite('/api/x', { token: '', body: {}, fetchImpl })).refusal, 'token');
  }));

  tally(await test('403 whose json() rejects → refusal token, body undefined, no throw', async () => {
    const { fetchImpl } = stub(403, () => Promise.reject(new SyntaxError('not json')));
    const result = await postWrite('/api/x', { token: '', body: {}, fetchImpl });
    assert.strictEqual(result.refusal, 'token');
    assert.strictEqual(result.body, undefined);
    assert.ok(!('error' in result));
  }));

  tally(await test('500 → not ok, no refusal, body carries the error', async () => {
    const { fetchImpl } = replying(500, { error: 'boom' });
    const result = await postWrite('/api/x', { token: '', body: {}, fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.refusal, null);
    assert.strictEqual((result.body as { error: string }).error, 'boom');
  }));

  tally(await test('fetch rejects → status 0, the network shape', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    assert.deepStrictEqual(await postWrite('/api/x', { token: 't', body: {}, fetchImpl }),
      { status: 0, ok: false, refusal: null, body: undefined });
  }));

  tally(await test('headers: token and body → exact JSON headers, POST, stringified body; no token → no Authorization; no body → no Content-Type', async () => {
    const withBoth = replying(200, {});
    await postWrite('/api/x', { token: 't', body: { a: 1 }, fetchImpl: withBoth.fetchImpl });
    assert.strictEqual(withBoth.calls[0].url, '/api/x');
    assert.deepStrictEqual(withBoth.calls[0].init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer t' });
    assert.strictEqual(withBoth.calls[0].init.method, 'POST');
    assert.strictEqual(withBoth.calls[0].init.body, JSON.stringify({ a: 1 }));

    const noToken = replying(200, {});
    await postWrite('/api/x', { token: '', body: { a: 1 }, fetchImpl: noToken.fetchImpl });
    assert.deepStrictEqual(noToken.calls[0].init.headers, { 'Content-Type': 'application/json' });

    const noBody = replying(200, {});
    await postWrite('/api/x', { token: 't', fetchImpl: noBody.fetchImpl });
    assert.deepStrictEqual(noBody.calls[0].init.headers, { Authorization: 'Bearer t' });
    assert.strictEqual(noBody.calls[0].init.body, undefined);
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
