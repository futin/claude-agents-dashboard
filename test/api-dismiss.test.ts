/**
 * `GET /api/dismiss`, driven through the real route table.
 *
 * There is almost nothing to it, which is the point: the desk push carries no
 * deep link, so a tap only has to make the tab ntfy opened go away. What is worth
 * pinning is that it stays that way — a page that stopped closing itself, or a
 * handler that grew parameters or state, would both be regressions of a decision
 * rather than bugs a type would catch.
 */

import assert from 'node:assert';

import { testAsync, withServer } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

export async function run(): Promise<number> {
  console.log('\n=== /api/dismiss (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('serves a page whose only job is to close the tab', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/dismiss');
      assert.equal(reply.status, 200);
      assert.match(String(reply.headers['content-type']), /^text\/html/);
      assert.match(reply.raw, /window\.close\(\)/);
      assert.match(reply.raw, /You can close this tab\./, 'fallback if close is refused');
      assert.equal(reply.headers['cache-control'], 'no-store');
    });
  }));

  // The desk push deliberately has no deep link. If a session id ever appears
  // here again, that decision was reversed by accident.
  check(await testAsync('takes no parameters and leaks no session id', async () => {
    await withServer(ENV, async h => {
      const withParam = await h.req('/api/dismiss?session=11111111-1111-4111-8111-111111111111');
      const plain = await h.req('/api/dismiss');
      assert.equal(withParam.status, 200);
      assert.equal(withParam.raw, plain.raw, 'the response must not vary with the query string');
      assert.doesNotMatch(withParam.raw, /11111111/, 'nothing echoes a caller-supplied id');
    });
  }));

  check(await testAsync('does not navigate anywhere', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/dismiss');
      assert.doesNotMatch(reply.raw, /location\.replace|location\.href/, 'dismiss means dismiss');
      assert.equal(reply.headers['location'], undefined, 'and no redirect either');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
