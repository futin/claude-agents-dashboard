/**
 * `scanSnapshot` is the scan half of `GET /api/sessions`, lifted out so the hub's sessions widget reads the same rows the board does (hub-widgets spec §4).
 * The first case pins the route's shape across the extraction — it was written and run green against the code before `scanSnapshot` existed.
 */

import assert from 'node:assert';

import { testAsync, userRecord, withServer } from '../api-harness.js';
import { resetProcProbeCache, scanSnapshot } from '../../server/lib/scan-snapshot.js';
import { setProbeExec, type ProbeExec } from '../../server/lib/scan.js';
import { markHandOverFailed, resetHandOvers } from '../../server/lib/handover.js';
import { pendingSessionIds, register as registerQuestion } from '../../server/lib/pending.js';
import { planSessionIds, register as registerPlan } from '../../server/lib/plans.js';
import type { SessionsResponse } from '../../shared/types.js';

const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';
// The probe on, for the cases that count its children; every exec is a stub, so none depends on what is running.
const PROBE_ENV = 'SHOW_USAGE=false\n';
const KEYS = ['activeWindowMin', 'generatedAt', 'launching', 'maxSessions', 'projects', 'runningClaudeProcs', 'sessions', 'totals'];

export async function run(): Promise<number> {
  console.log('\n=== scanSnapshot (lib/scan-snapshot.ts) ===\n');
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
      const ids = (await scanSnapshot(h.cfg)).sessions.map(s => s.id);
      assert.equal(ids.length, 2);
      assert.deepStrictEqual(ids, served.sessions.map(s => s.id));
    });
  }));

  check(await testAsync('scanSnapshot passes the failed hand-overs through, so a dashboard row carries handOverFailed', async () => {
    await withServer(ENV, async h => {
      h.plant('hf-1', [{ ...(userRecord('hf-u1', 'hello', '/x/alpha') as object), entrypoint: 'sdk-cli' }]);
      h.plant('hf-2', [{ ...(userRecord('hf-u2', 'hello', '/x/beta') as object), entrypoint: 'sdk-cli' }]);
      markHandOverFailed('hf-1');
      try {
        const rows = (await scanSnapshot(h.cfg)).sessions;
        assert.equal(rows.find(s => s.id === 'hf-1')?.handOverFailed, true);
        assert.equal('handOverFailed' in rows.find(s => s.id === 'hf-2')!, false);
      } finally { resetHandOvers(); }
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
      const snap = await scanSnapshot(h.cfg);
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

  check(await testAsync('two concurrent GET /api/sessions share one process probe', async () => {
    await withServer(PROBE_ENV, async h => {
      h.plant('snap-1');
      const calls = { comm: 0, args: 0, lsof: 0 };
      const exec: ProbeExec = async (bin, args) => {
        const kind = bin === 'lsof' ? 'lsof' : args.includes('pid=,comm=') ? 'comm' : 'args';
        calls[kind]++;
        // A tick of latency, so the second request arrives while the first probe is in flight.
        await new Promise(r => setTimeout(r, 20));
        return { code: 0, signal: null, stdout: kind === 'comm' ? '12 claude\n' : kind === 'lsof' ? `p12\nn${h.home}\n` : '' };
      };
      resetProcProbeCache();
      setProbeExec(exec);
      try {
        const [a, b] = await Promise.all([h.req('/api/sessions'), h.req('/api/sessions')]);
        for (const r of [a, b]) {
          assert.equal(r.status, 200);
          assert.deepStrictEqual(Object.keys(r.json ?? {}).sort(), KEYS);
          assert.equal(r.json?.runningClaudeProcs, 1);
        }
        assert.deepStrictEqual(calls, { comm: 1, args: 1, lsof: 1 });
      } finally { setProbeExec(null); resetProcProbeCache(); }
    });
  }));

  check(await testAsync('a scan that rejects still answers 200 with the error snapshot, and no rejection escapes', async () => {
    await withServer(PROBE_ENV, async h => {
      h.plant('snap-1');
      const escaped: unknown[] = [];
      const onRejection = (r: unknown): void => { escaped.push(r); };
      process.on('unhandledRejection', onRejection);
      // stdout that is not a string breaks the probe's contract, which is the one way it rejects.
      resetProcProbeCache();
      setProbeExec(async () => ({ code: 0, signal: null, stdout: 42 as unknown as string }));
      try {
        // Raced, so a rejection that escapes the handler fails here instead of hanging the suite on a response nobody writes.
        const r = await Promise.race([h.req('/api/sessions'), new Promise<never>((_, no) => setTimeout(() => no(new Error('no response in 2 s')), 2000))]);
        assert.equal(r.status, 200);
        assert.equal(r.json?.error, true);
        assert.deepStrictEqual(r.json?.sessions, []);
        await new Promise(res => setTimeout(res, 20));
        assert.deepStrictEqual(escaped, []);
      } finally { setProbeExec(null); resetProcProbeCache(); process.off('unhandledRejection', onRejection); }
    });
  }));

  console.log(`\nscanSnapshot: ${ok}/${total} passed`);
  return total - ok;
}
