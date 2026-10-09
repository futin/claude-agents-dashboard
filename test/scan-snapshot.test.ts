/**
 * `scanSnapshot` is the scan half of `GET /api/sessions`, lifted out so the hub's sessions widget reads the same rows the board does (hub-widgets spec §4).
 * The first case pins the route's shape across the extraction — it was written and run green against the code before `scanSnapshot` existed.
 */

import assert from 'node:assert';

import { testAsync, withServer } from './api-harness.js';
import { scanSnapshot } from '../server/api.js';
import type { SessionsResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const KEYS = ['activeWindowMin', 'generatedAt', 'launching', 'maxSessions', 'runningClaudeProcs', 'sessions', 'totals'];

export async function run(): Promise<number> {
  console.log('\n=== scanSnapshot (api.ts) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  check(await testAsync('GET /api/sessions keeps its top-level keys and its one planted row', async () => {
    await withServer(ENV, async h => {
      h.plant('snap-1');
      const reply = await h.req('/api/sessions');
      assert.equal(reply.status, 200);
      assert.deepStrictEqual(Object.keys(reply.json ?? {}).sort(), KEYS);
      assert.equal((reply.json?.sessions as unknown[]).length, 1);
    });
  }));

  check(await testAsync('scanSnapshot returns the same row ids GET /api/sessions serves', async () => {
    await withServer(ENV, async h => {
      h.plant('snap-1');
      h.plant('snap-2');
      const served = (await h.req('/api/sessions')).json as unknown as SessionsResponse;
      const ids = scanSnapshot(h.cfg).sessions.map(s => s.id);
      assert.equal(ids.length, 2);
      assert.deepStrictEqual(ids, served.sessions.map(s => s.id));
    });
  }));

  console.log(`\nscanSnapshot: ${ok}/${total} passed`);
  return total - ok;
}
