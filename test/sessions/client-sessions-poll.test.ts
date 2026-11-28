import assert from 'node:assert';

import { acceptSessions } from '../../client/src/lib/sessionsPoll.js';
import type { LaunchingSession, Session, SessionsResponse } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const launch: LaunchingSession = {
  sessionId: 'l1', projectName: 'p', projectPath: '/p', prompt: 'go', startedAtMs: 1, state: 'launching'
};

// The rows are only carried, never read, so a stand-in object per row is enough.
const row = (id: string): Session => ({ id } as unknown as Session);

function good(over: Partial<SessionsResponse> = {}): SessionsResponse {
  return {
    generatedAt: '2026-11-28T10:00:00.000Z', activeWindowMin: 60, maxSessions: 30, runningClaudeProcs: 2,
    totals: { shown: 2, active: 1 }, sessions: [row('a'), row('b')], projects: ['p'], ...over
  };
}

function failed(over: Partial<SessionsResponse> = {}): SessionsResponse {
  return {
    error: true, generatedAt: '2026-11-28T10:05:00.000Z', activeWindowMin: 60, maxSessions: 30, runningClaudeProcs: null,
    totals: { shown: 0, active: 0 }, sessions: [], launching: [launch], usage: null, usageStatus: 'ok', ...over
  };
}

export function run(): number {
  console.log('\n=== sessions poll: a failed scan keeps the last good snapshot (client logic) ===\n');
  const results: boolean[] = [];
  const t = (name: string, fn: () => void): void => { results.push(test(name, fn)); };

  t('a good body with nothing before it is taken as is', () => {
    const body = good();
    assert.strictEqual(acceptSessions(null, body), body);
  });

  t('a good body replaces the previous one outright, not merged', () => {
    const prev = good({ projects: ['old'] });
    const body = good({ sessions: [row('c')], projects: undefined });
    assert.strictEqual(acceptSessions(prev, body), body);
  });

  t('an error body with nothing before it leaves the board in its pre-first-answer state', () => {
    assert.strictEqual(acceptSessions(null, failed()), null);
  });

  t('an error body keeps the previous rows and takes launching, usage and usageStatus from the new body', () => {
    const prev = good({ launching: [], usageStatus: 'unavailable' });
    const r = acceptSessions(prev, failed());
    assert.ok(r);
    assert.deepStrictEqual(r.sessions.map(s => s.id), ['a', 'b']);
    assert.deepStrictEqual(r.totals, prev.totals);
    assert.strictEqual(r.generatedAt, prev.generatedAt);
    assert.deepStrictEqual(r.projects, ['p']);
    assert.strictEqual(r.runningClaudeProcs, 2);
    assert.strictEqual(r.launching?.length, 1);
    assert.strictEqual(r.usage, null);
    assert.strictEqual(r.usageStatus, 'ok');
    assert.strictEqual('error' in r, false);
  });

  t('mirror: an emptier launching list on the error body still wins over the previous one', () => {
    const prev = good({ launching: [launch] });
    const r = acceptSessions(prev, failed({ launching: [] }));
    assert.ok(r);
    assert.deepStrictEqual(r.launching, []);
  });

  const failedCount = results.filter(r => !r).length;
  console.log('\n  ' + (results.length - failedCount) + ' passed, ' + failedCount + ' failed');
  return failedCount;
}
