/**
 * `pollFetch` (`client/src/lib/pollSeq.ts`): a guarded poll's request has a bound, because the guard stays shut until the request settles. Run against real
 * sockets, since what it has to survive is a server that goes quiet: before the headers, or halfway through the body.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPollGate } from '../client/src/lib/gitClock.js';
import { createPollSeq, pollFetch } from '../client/src/lib/pollSeq.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Long enough that only a request with no bound at all reaches it. */
const GUARD_MS = 2000;

async function test(name: string, fn: () => Promise<void> | void): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** How `work` ended, or `hung` once the guard ran out. */
async function outcome(work: Promise<unknown>): Promise<'resolved' | 'rejected' | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), GUARD_MS); });
  const settled = work.then(() => 'resolved' as const, () => 'rejected' as const);
  try { return await Promise.race([settled, guard]); }
  finally { clearTimeout(timer); }
}

/** A server on port 0 for the length of `fn`. It holds sockets open by design, so teardown has to cut them or the run never exits. */
async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>): Promise<void> {
  const srv = http.createServer(handler);
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
  } finally {
    srv.closeAllConnections();
    await new Promise(resolve => srv.close(resolve));
  }
}

const silent: http.RequestListener = () => {};

export async function run(): Promise<number> {
  console.log('\n=== pollFetch ===\n');
  let p = 0, f = 0;

  if (await test('a server that never answers: the request rejects at its bound', () => withServer(silent, async url => {
    assert.strictEqual(await outcome(pollFetch(url, 50)), 'rejected');
  }))) p++; else f++;

  // 250ms, not 50: the headers have to beat the bound on a loaded machine for this case to reach the part it pins, the stalled body.
  if (await test('a server that stalls mid-body: the response arrives and reading it rejects at the bound', () => withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
  }, async url => {
    const res = await pollFetch(url, 250);
    assert.strictEqual(await outcome(res.json()), 'rejected');
  }))) p++; else f++;

  if (await test('an answer in time is untouched', () => withServer((_req, res) => {
    setTimeout(() => res.end('{"ok":true}'), 10);
  }, async url => {
    const res = await pollFetch(url, 500);
    assert.deepStrictEqual(await res.json(), { ok: true });
  }))) p++; else f++;

  if (await test('a hung request frees the poll guard once its bound runs out', () => withServer(silent, async url => {
    const seq = createPollSeq();
    const n = seq.next(false);
    assert.strictEqual(typeof n, 'number');
    assert.strictEqual(seq.next(false), null, 'ticks are skipped while the request is out');
    assert.strictEqual(await outcome(pollFetch(url, 50)), 'rejected');
    assert.strictEqual(seq.settle(n!), true);
    assert.strictEqual(typeof seq.next(false), 'number');
  }))) p++; else f++;

  // The Git and CodeGraph views' gate reopens only in a request's `.finally`, so a hung request kept it shut for good (#406).
  if (await test('a hung request frees the poll gate once its bound runs out', () => withServer(silent, async url => {
    const gate = createPollGate();
    assert.strictEqual(gate.request(), 'run');
    assert.strictEqual(gate.request(), 'queued');
    assert.strictEqual(gate.request(), 'dropped', 'later polls are dropped while the request is out');
    assert.strictEqual(await outcome(pollFetch(url, 50)), 'rejected');
    assert.strictEqual(gate.end(), true, 'the queued poll runs');
    assert.strictEqual(gate.end(), false);
    assert.strictEqual(gate.request(), 'run');
  }))) p++; else f++;

  const hooks = ['useSessions', 'usePullRequest', 'useRoutines', 'useRoutineRuns', 'useSessionChat', 'useGitStats', 'useCodegraph', 'usePendingReply'];
  for (const hook of hooks) {
    if (await test(`${hook} polls through pollFetch, never a bare fetch`, () => {
      const source = fs.readFileSync(path.join(REPO, 'client/src/hooks', `${hook}.ts`), 'utf8');
      assert.ok(source.includes('pollFetch('), 'no pollFetch call');
      assert.doesNotMatch(source, /\bfetch\(/);
    })) p++; else f++;
  }

  // The skip and the stale-answer drop need a DOM to exercise; the repo has no hook harness, so the source pins that both are wired.
  if (await test('usePendingReply polls through createPollSeq', () => {
    const source = fs.readFileSync(path.join(REPO, 'client/src/hooks/usePendingReply.ts'), 'utf8');
    assert.ok(source.includes('createPollSeq('), 'no createPollSeq call');
    assert.ok(source.includes('.settle('), 'no settle call');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
