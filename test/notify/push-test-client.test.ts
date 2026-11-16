/**
 * Settings › Shared's "send test push" line (`client/src/lib/pushTest.ts`): what each `postWrite` result reads as. The write goes through `postWrite` like
 * every other write, so a 403 shows the shared refusal text rather than the server's raw string, and a reply that is not JSON reads as an answer, not as
 * silence (#436).
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { postWrite, type WriteResult } from '../../client/src/lib/postWrite.js';
import { PUSH_TEST_NEEDS_TOKEN, pushTestText } from '../../client/src/lib/pushTest.js';
import { READ_ONLY_TEXT } from '../../client/src/lib/writeRefusal.js';

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const result = (status: number, body: unknown, refusal: WriteResult['refusal'] = null): WriteResult =>
  ({ status, ok: status >= 200 && status < 300, refusal, body });

export async function run(): Promise<number> {
  console.log('\n=== pushTest.ts (client) ===\n');
  let p = 0, f = 0;
  const tally = (ok: boolean): void => { if (ok) p++; else f++; };

  tally(await test('403 read-only → READ_ONLY_TEXT, never the raw server string', () => {
    const text = pushTestText(result(403, { error: 'read-only from this network' }, 'read-only'));
    assert.strictEqual(text, READ_ONLY_TEXT);
  }));

  tally(await test('403 bad token → the token hint, never the raw server string', () => {
    const text = pushTestText(result(403, { error: 'bad token' }, 'token'));
    assert.strictEqual(text, PUSH_TEST_NEEDS_TOKEN);
    assert.strictEqual(PUSH_TEST_NEEDS_TOKEN, 'Test push needs the Answer token — set it under Settings › Local › Connection.');
    assert.ok(!text.includes('bad token'));
  }));

  tally(await test('status 0 → the dashboard did not answer', () => {
    assert.strictEqual(pushTestText(result(0, undefined)), 'the dashboard did not answer');
  }));

  tally(await test('200 with an outcome → that outcome', () => {
    assert.strictEqual(pushTestText(result(200, { outcome: 'sent' })), 'sent');
  }));

  tally(await test('502 with no JSON body → the dashboard answered 502, not "did not answer"', () => {
    assert.strictEqual(pushTestText(result(502, undefined)), 'the dashboard answered 502');
  }));

  tally(await test('500 with an error → the status and the error', () => {
    assert.strictEqual(pushTestText(result(500, { error: 'boom' })), 'the dashboard answered 500: boom');
  }));

  tally(await test('end to end: a proxy HTML 502 through the real postWrite reads as an answer', async () => {
    const fetchImpl = (async () => ({
      status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    })) as unknown as typeof fetch;
    const res = await postWrite('/api/notify/test', { token: 't', fetchImpl });
    assert.strictEqual(pushTestText(res), 'the dashboard answered 502');
  }));

  tally(await test('SettingsView.tsx: the test push is sent by postWrite and read by pushTestText, with no fetch of its own', () => {
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/components/settings/SettingsView.tsx'), 'utf8');
    const at = src.indexOf('async function sendTestPush');
    assert.ok(at >= 0, 'sendTestPush was not found');
    const fn = src.slice(at, src.indexOf('\n  }\n', at));
    assert.match(fn, /pushTestText\(await postWrite\('\/api\/notify\/test'/);
    assert.ok(!/\bfetch\(/.test(fn), 'sendTestPush calls fetch directly');
  }));

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
