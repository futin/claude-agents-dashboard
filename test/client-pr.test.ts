import assert from 'node:assert';

import {
  acceptPrAnswer, bandLine, checkSegments, checksRow, endedLine, mergeRow, reviewRow, stateLabel,
} from '../client/src/lib/pr.js';
import type { PrChecks, SessionPrInfo, SessionPrLive } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const ago = (): string => '2h';
const checks = (passed: number, failed: number, running: number, total: number): PrChecks => ({ passed, failed, running, total });

function live(over: Partial<SessionPrLive> = {}): SessionPrLive {
  return {
    state: 'open', title: 'Fix: a', head: 'fix/a', base: 'main', checks: null, review: 'none', merge: 'clean', endedAt: null, ...over,
  };
}

function info(l: SessionPrLive | null): SessionPrInfo {
  return { url: 'https://github.com/o/r/pull/7', number: 7, repo: 'o/r', title: 'Fix: a', live: l, unavailable: l ? null : 'gh failed' };
}

export function run(): number {
  console.log('\n=== client pr ===\n');
  let p = 0, f = 0;

  if (test('C1. checksRow: first matching rule, with its tone', () => {
    assert.deepStrictEqual(checksRow(null), { text: 'None', tone: 'dim' });
    assert.deepStrictEqual(checksRow(checks(3, 1, 0, 4)), { text: '1 failed · 3 passed', tone: 'bad' });
    assert.deepStrictEqual(checksRow(checks(2, 1, 1, 4)), { text: '1 failed · 2 passed · 1 running', tone: 'bad' });
    assert.deepStrictEqual(checksRow(checks(3, 0, 1, 4)), { text: '3 of 4 passed · 1 running', tone: 'run' });
    assert.deepStrictEqual(checksRow(checks(4, 0, 0, 4)), { text: '4 of 4 passed', tone: 'ok' });
  })) p++; else f++;

  if (test('C2. checkSegments: failed, then running, then passed; none for null', () => {
    assert.deepStrictEqual(checkSegments(checks(2, 1, 1, 4)), ['bad', 'run', 'ok', 'ok']);
    assert.deepStrictEqual(checkSegments(null), []);
  })) p++; else f++;

  if (test('C3. reviewRow copy and tones', () => {
    assert.deepStrictEqual(reviewRow('approved'), { text: 'Approved', tone: 'ok' });
    assert.deepStrictEqual(reviewRow('changes'), { text: 'Changes requested', tone: 'bad' });
    assert.deepStrictEqual(reviewRow('required'), { text: 'Required', tone: 'dim' });
    assert.deepStrictEqual(reviewRow('none'), { text: 'Not requested', tone: 'dim' });
  })) p++; else f++;

  if (test('C4. mergeRow copy and tones, naming the base', () => {
    assert.deepStrictEqual(mergeRow('clean', 'main'), { text: 'No conflicts', tone: 'ok' });
    assert.deepStrictEqual(mergeRow('conflicts', 'main'), { text: 'Conflicts with main', tone: 'bad' });
    assert.deepStrictEqual(mergeRow('unknown', 'main'), { text: 'Checking…', tone: 'dim' });
  })) p++; else f++;

  if (test('C5. stateLabel', () => {
    assert.deepStrictEqual((['open', 'draft', 'merged', 'closed'] as const).map(stateLabel), ['Open', 'Draft', 'Merged', 'Closed']);
  })) p++; else f++;

  if (test('C6. endedLine: merged names the base, closed says not merged, no time without endedAt', () => {
    assert.strictEqual(endedLine(live({ state: 'merged', endedAt: '2026-10-24T10:00:00Z' }), ago), 'into main · 2h');
    assert.strictEqual(endedLine(live({ state: 'closed', endedAt: '2026-10-24T10:00:00Z' }), ago), 'not merged · 2h');
    assert.strictEqual(endedLine(live({ state: 'merged', endedAt: null }), ago), 'into main');
  })) p++; else f++;

  if (test('C7. bandLine for every state', () => {
    assert.strictEqual(bandLine(info(live({ checks: checks(3, 0, 1, 4), review: 'required' })), ago), '3/4 checks · review required');
    assert.strictEqual(bandLine(info(live({ state: 'draft', checks: checks(2, 1, 0, 3), review: 'changes' })), ago), '1 failed · changes requested');
    assert.strictEqual(bandLine(info(live({ checks: null, review: 'none' })), ago), 'no checks · no review');
    assert.strictEqual(bandLine(info(live({ checks: checks(4, 0, 0, 4), review: 'approved' })), ago), '4/4 checks · approved');
    assert.strictEqual(bandLine(info(live({ state: 'merged', endedAt: '2026-10-24T10:00:00Z' })), ago), 'into main · 2h');
    assert.strictEqual(bandLine(info(live({ state: 'closed', endedAt: '2026-10-24T10:00:00Z' })), ago), 'not merged · 2h');
    assert.strictEqual(bandLine(info(null), ago), 'status unavailable');
  })) p++; else f++;

  if (test('C8. acceptPrAnswer keeps prev for another id or an error, else takes the answer', () => {
    const prev = info(live());
    const next = info(live({ state: 'merged' }));
    assert.strictEqual(acceptPrAnswer('a', { id: 'b', pr: next }, prev), prev);
    assert.strictEqual(acceptPrAnswer('a', { id: 'a', pr: null, error: true }, prev), prev);
    assert.strictEqual(acceptPrAnswer('a', { id: 'a', pr: null }, prev), null);
    assert.strictEqual(acceptPrAnswer('a', { id: 'a', pr: next }, prev), next);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
