import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  addSubscriber, resetAlertStream, statusMap, subscriberCount, transitions
} from '../server/lib/alertStream.js';
import type { Session, SessionsResponse } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function session(id: string, status: Session['status'], project = 'proj'): Session {
  return {
    id, project, projectPath: `/tmp/${project}`, sessionName: null, gitBranch: null,
    model: 'claude-opus-5', tokens: 0, contextWindow: 200_000, contextWindowLabel: '200k',
    contextPct: 0, status, remoteQuestion: false, remotePlan: false, permissionWait: false
  } as Session;
}

function snapshot(sessions: Session[]): SessionsResponse {
  return {
    generatedAt: '2026-08-16T00:00:00.000Z',
    activeWindowMin: 5, maxSessions: 10, runningClaudeProcs: 1,
    totals: { shown: sessions.length, active: 0 },
    sessions
  };
}

const AT = '2026-08-16T00:00:00.000Z';

export async function run(): Promise<number> {
  console.log('\n=== alertStream.ts ===\n');
  let p = 0, f = 0;

  if (test('only needs-you statuses push', () => {
    const prev = statusMap([session('a', 'idle'), session('b', 'idle'), session('c', 'idle')]);
    const out = transitions(prev, [session('a', 'working'), session('b', 'question'), session('c', 'incomplete')], AT);
    assert.deepStrictEqual(out.map(e => e.id), ['b', 'c']);
  })) p++; else f++;

  if (test('a session already waiting does not re-push every tick', () => {
    const prev = statusMap([session('a', 'question')]);
    assert.deepStrictEqual(transitions(prev, [session('a', 'question')], AT), []);
  })) p++; else f++;

  if (test('moving between two needs-you statuses is still news', () => {
    const prev = statusMap([session('a', 'incomplete')]);
    assert.strictEqual(transitions(prev, [session('a', 'question')], AT).length, 1);
  })) p++; else f++;

  if (test('the event carries the label and the tick timestamp', () => {
    const named = { ...session('a', 'question'), sessionName: 'refactor scan' };
    const [event] = transitions(new Map(), [named], AT);
    assert.strictEqual(event.label, 'refactor scan');
    assert.strictEqual(event.at, AT);
    assert.strictEqual(event.status, 'question');
  })) p++; else f++;

  // The decay that makes a poll-only client miss the alert entirely: a finished
  // session goes quiet, `incomplete` becomes `idle`, and the pair a throttled
  // tab observes is `working → idle` — correctly ignored, which is the bug.
  if (test('working → idle spans a lost incomplete and pushes nothing', () => {
    const prev = statusMap([session('a', 'working')]);
    assert.deepStrictEqual(transitions(prev, [session('a', 'idle')], AT), [],
      'exactly why detection cannot live on the client timer');
  })) p++; else f++;

  if (await testAsync('a connecting client seeds a baseline and is told nothing', async () => {
    resetAlertStream();
    const { url, close, frames } = await harness(() => snapshot([session('a', 'question')]));
    try {
      await consume(url, 150, frames);
      assert.strictEqual(frames.join('').includes('event: alert'), false,
        'a session already waiting when you connect is not news');
    } finally { await close(); }
  })) p++; else f++;

  if (await testAsync('a transition after connect is pushed as an SSE alert event', async () => {
    resetAlertStream();
    let current = snapshot([session('a', 'working')]);
    const { url, close, frames } = await harness(() => current);
    try {
      const done = consume(url, 4200, frames);
      setTimeout(() => { current = snapshot([session('a', 'incomplete')]); }, 200);
      await done;
      const body = frames.join('');
      assert.ok(body.includes('event: alert'), `no alert frame in: ${body}`);
      const line = body.split('\n').find(l => l.startsWith('data: '));
      assert.ok(line, 'no data line');
      const event = JSON.parse(line.slice(6));
      assert.strictEqual(event.id, 'a');
      assert.strictEqual(event.status, 'incomplete');
    } finally { await close(); }
  })) p++; else f++;

  if (await testAsync('the last disconnect stops the scan — no daemon left behind', async () => {
    resetAlertStream();
    const { url, close, frames } = await harness(() => snapshot([session('a', 'idle')]));
    try {
      assert.strictEqual(subscriberCount(), 0, 'nothing subscribed before connecting');
      const reading = consume(url, 400, frames);
      await waitFor(() => subscriberCount() === 1, 'subscriber registered while connected');
      await reading;
      // The server's own 'close' lands a tick after the client hangs up.
      await waitFor(() => subscriberCount() === 0, 'subscriber dropped on socket close');
    } finally { await close(); }
  })) p++; else f++;

  resetAlertStream();
  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

/** Poll a condition rather than sleeping a guessed interval. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** A throwaway server exposing only the stream, on an ephemeral port. */
async function harness(scan: () => SessionsResponse): Promise<{
  url: string; close: () => Promise<void>; frames: string[];
}> {
  const frames: string[] = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n');
    const detach = addSubscriber(res, scan);
    req.on('close', detach);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/alerts/stream`,
    frames,
    close: () => new Promise<void>(r => server.close(() => r()))
  };
}

/** Read the stream for `ms`, collecting frames, then hang up like a closed tab. */
function consume(url: string, ms: number, frames: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get(url, res => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => frames.push(chunk));
      setTimeout(() => { req.destroy(); resolve(); }, ms);
    });
    req.on('error', err => {
      // destroy() after we already resolved surfaces here — ignore.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}
