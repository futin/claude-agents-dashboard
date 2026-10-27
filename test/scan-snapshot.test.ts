/**
 * `scanSnapshot` is the scan half of `GET /api/sessions`, lifted out so the hub's sessions widget reads the same rows the board does (hub-widgets spec §4).
 * The first case pins the route's shape across the extraction — it was written and run green against the code before `scanSnapshot` existed.
 */

import assert from 'node:assert';

import { testAsync, userRecord, withServer } from './api-harness.js';
import { scanSnapshot } from '../server/api.js';
import { pendingSessionIds, register as registerQuestion } from '../server/lib/pending.js';
import { planSessionIds, register as registerPlan } from '../server/lib/plans.js';
import type { SessionsResponse } from '../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
const KEYS = ['activeWindowMin', 'generatedAt', 'launching', 'maxSessions', 'projects', 'runningClaudeProcs', 'sessions', 'totals'];

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

  check(await testAsync('GET /api/sessions?project= serves only that project, and still lists every project', async () => {
    await withServer(ENV, async h => {
      h.plant('p-a', [userRecord('a-u1', 'hello', '/x/alpha')]);
      h.plant('p-b', [userRecord('b-u1', 'hello', '/x/beta')]);
      const all = (await h.req('/api/sessions')).json as unknown as SessionsResponse;
      assert.deepStrictEqual(all.sessions.map(s => s.project).sort(), ['alpha', 'beta']);
      const one = (await h.req('/api/sessions?project=beta')).json as unknown as SessionsResponse;
      assert.deepStrictEqual(one.sessions.map(s => s.id), ['p-b']);
      assert.deepStrictEqual(one.projects, ['alpha', 'beta']);
    });
  }));

  check(await testAsync('held waits on two sessions whose transcripts moved on are both swept, and neither row is flagged', async () => {
    await withServer(ENV, async h => {
      const later = new Date(Date.now() + 60_000).toISOString();
      const moved = (id: string, cwd: string) => [{ ...(userRecord(`${id}-u1`, 'hello', cwd) as object), timestamp: later }];
      h.plant('held-q', moved('held-q', '/x/alpha'));
      h.plant('held-p', moved('held-p', '/x/beta'));
      registerQuestion('held-q', [], 60_000, () => {});
      registerPlan('held-p', 'plan', 60_000, () => {});
      const snap = scanSnapshot(h.cfg);
      assert.equal(pendingSessionIds().size, 0);
      assert.equal(planSessionIds().size, 0);
      const rows = snap.sessions.filter(s => s.id === 'held-q' || s.id === 'held-p');
      assert.equal(rows.length, 2);
      for (const r of rows) {
        assert.equal(r.remoteQuestion, false, r.id);
        assert.equal(r.remotePlan, false, r.id);
      }
    });
  }));

  console.log(`\nscanSnapshot: ${ok}/${total} passed`);
  return total - ok;
}
