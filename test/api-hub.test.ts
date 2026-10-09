/**
 * The Lookout hub routes mounted in the real route table (hub-widgets spec §4): catalog and data served by `lookout-widgets`, the POST action paths
 * answering 404 whatever the body (no actions are declared), and every path the hub declines falling through to the table unchanged.
 */

import assert from 'node:assert';

import { testAsync, withServer } from './api-harness.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

export async function run(): Promise<number> {
  console.log('\n=== hub routes (index.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('GET /api/hub/widgets serves contract 1 with sessions and git when usage is off', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/hub/widgets');
      assert.equal(reply.status, 200);
      assert.equal(reply.json?.contract, 1);
      assert.deepStrictEqual((reply.json?.widgets as { id: string }[]).map(w => w.id), ['sessions', 'git']);
    });
  }));

  check(await testAsync('GET /api/hub/widgets/git with no pins serves no rows and a parseable updatedAt', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/hub/widgets/git');
      assert.equal(reply.status, 200);
      assert.deepStrictEqual(reply.json?.rows, []);
      assert.ok(!Number.isNaN(Date.parse(String(reply.json?.updatedAt))));
    });
  }));

  check(await testAsync('GET /api/hub/widgets/sessions serves the one planted row with a parseable updatedAt', async () => {
    await withServer(ENV, async h => {
      h.plant('hub-1');
      const reply = await h.req('/api/hub/widgets/sessions');
      assert.equal(reply.status, 200);
      assert.ok(Array.isArray(reply.json?.rows));
      assert.equal((reply.json?.rows as unknown[]).length, 1);
      assert.ok(!Number.isNaN(Date.parse(String(reply.json?.updatedAt))));
    });
  }));

  check(await testAsync('an unknown widget and the switched-off usage widget are 404 with an error', async () => {
    await withServer(ENV, async h => {
      for (const p of ['/api/hub/widgets/nope', '/api/hub/widgets/usage']) {
        const reply = await h.req(p);
        assert.equal(reply.status, 404, p);
        assert.equal(typeof reply.json?.error, 'string', p);
      }
    });
  }));

  for (const [name, body] of [['a non-JSON body', 'not json'], ['an empty body', ''], ['a body over the cap', 'x'.repeat(64 * 1024 + 1)]] as const) {
    check(await testAsync(`POST to an action path with ${name} is 404 and the server keeps answering`, async () => {
      await withServer(ENV, async h => {
        const reply = await h.req('/api/hub/widgets/sessions/actions/x', { method: 'POST', body });
        assert.equal(reply.status, 404);
        assert.equal((await h.req('/api/sessions')).status, 200);
      });
    }));
  }

  check(await testAsync('paths the hub declines reach the old table: /api/sessions, and /api/hub/other answers as /api/nonexistent does', async () => {
    await withServer(ENV, async h => {
      const sessions = await h.req('/api/sessions');
      assert.equal(sessions.status, 200);
      assert.ok(Array.isArray(sessions.json?.sessions));
      const other = await h.req('/api/hub/other');
      const none = await h.req('/api/nonexistent');
      assert.deepStrictEqual([other.status, other.headers['content-type']], [none.status, none.headers['content-type']]);
    });
  }));

  console.log(`\nhub routes: ${ok}/${total} passed`);
  return total - ok;
}
