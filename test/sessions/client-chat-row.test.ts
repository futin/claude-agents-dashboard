import assert from 'node:assert';

import { chatDrawerSession, chatRowAction } from '../../client/src/lib/chatRow.js';
import type { LaunchingSession, Session, SessionsResponse } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** Only the fields the helpers read; the rest of a `Session` never reaches them. */
function row(id: string, over: Partial<Session> = {}): Session {
  return { id, status: 'idle', ...over } as Session;
}

function launch(sessionId: string): LaunchingSession {
  return { sessionId, projectName: 'x', projectPath: '/x', prompt: '', startedAtMs: 0, state: 'launching' };
}

function payload(ids: string[], launching: string[] = []): Pick<SessionsResponse, 'sessions' | 'launching'> {
  return { sessions: ids.map(id => row(id)), launching: launching.map(launch) };
}

export function run(): number {
  console.log('\n=== client/lib/chatRow.ts ===\n');
  let p = 0, f = 0;

  if (test('no chatId: no fetch and no drawer session', () => {
    assert.strictEqual(chatRowAction({ chatId: null, data: payload(['a']), fetchedId: null }), 'none');
    assert.strictEqual(chatDrawerSession(null, payload(['a']), row('a')), null);
  })) p++; else f++;

  if (test('chatId in the poll: no fetch, and the live row wins over a stale fetched row for the same id', () => {
    const data = payload(['a']);
    assert.strictEqual(chatRowAction({ chatId: 'a', data, fetchedId: null }), 'none');
    const fetched = row('a', { status: 'working' });
    assert.strictEqual(chatDrawerSession('a', data, fetched), data.sessions[0]);
  })) p++; else f++;

  if (test('chatId missing from the poll and nothing fetched: fetch', () => {
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a']), fetchedId: null }), 'fetch');
  })) p++; else f++;

  if (test('fetched row already for chatId: no second fetch, and the drawer shows it', () => {
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a']), fetchedId: 'b' }), 'none');
    const fetched = row('b');
    assert.strictEqual(chatDrawerSession('b', payload(['a']), fetched), fetched);
  })) p++; else f++;

  if (test('fetched row for another id: never shown under chatId, and chatId is fetched', () => {
    assert.strictEqual(chatDrawerSession('b', payload(['a']), row('c')), null);
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a']), fetchedId: 'c' }), 'fetch');
  })) p++; else f++;

  if (test('404 while the id is still launching: keep; 404 with no launch: clear', () => {
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a'], ['b']), fetchedId: null, status: 404 }), 'keep');
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a'], ['c']), fetchedId: null, status: 404 }), 'clear');
    assert.strictEqual(chatRowAction({ chatId: 'b', data: { sessions: [] }, fetchedId: null, status: 404 }), 'clear');
  })) p++; else f++;

  if (test('500 or a thrown fetch: keep, so the next payload retries', () => {
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a']), fetchedId: null, status: 500 }), 'keep');
    assert.strictEqual(chatRowAction({ chatId: 'b', data: payload(['a']), fetchedId: null, status: 'error' }), 'keep');
  })) p++; else f++;

  if (test('no payload yet: no fetch, and no drawer session', () => {
    assert.strictEqual(chatRowAction({ chatId: 'b', data: null, fetchedId: null }), 'none');
    assert.strictEqual(chatDrawerSession('b', null, null), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed\n`);
  return f;
}
