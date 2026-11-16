/** `nextDetail` (`client/src/lib/sessionDetail.ts`): which subagent-detail poll answers replace the snapshot on screen and which keep it. */
import assert from 'node:assert';

import { EMPTY_DETAIL, nextDetail, type DetailState } from '../../client/src/lib/sessionDetail.js';
import type { SessionDetail } from '../../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const good = (running: number): SessionDetail => ({ id: 's1', agents: [], running, finished: 0 });
const errorBody: SessionDetail = { id: 's1', agents: [], running: 0, finished: 0, error: true };

export function run(): number {
  console.log('\n=== sessionDetail.ts (subagent-detail poll) ===\n');
  let p = 0, f = 0;

  if (test('an ok body replaces the snapshot, first answer or later', () => {
    assert.deepStrictEqual(nextDetail(EMPTY_DETAIL, true, good(1)), { detail: good(1), failed: false });
    const prev: DetailState = { detail: good(1), failed: false };
    assert.deepStrictEqual(nextDetail(prev, true, good(2)), { detail: good(2), failed: false });
  })) p++; else f++;

  if (test('an error: true body keeps a previous good detail, untouched', () => {
    const prev: DetailState = { detail: good(3), failed: false };
    assert.strictEqual(nextDetail(prev, false, errorBody), prev);
    assert.strictEqual(nextDetail(prev, true, errorBody), prev, 'error: true wins over a 2xx status');
  })) p++; else f++;

  if (test('an error: true body with no previous detail is the failed state', () => {
    assert.deepStrictEqual(nextDetail(EMPTY_DETAIL, false, errorBody), { detail: null, failed: true });
  })) p++; else f++;

  if (test('a non-ok status with a non-error body still keeps the previous one', () => {
    const prev: DetailState = { detail: good(4), failed: false };
    assert.strictEqual(nextDetail(prev, false, good(9)), prev);
  })) p++; else f++;

  if (test('a failed fetch or an unreadable body keeps the previous one, or fails a first answer', () => {
    const prev: DetailState = { detail: good(5), failed: false };
    for (const body of [null, 'x', 42, { id: 's1' }]) assert.strictEqual(nextDetail(prev, true, body), prev, JSON.stringify(body));
    assert.deepStrictEqual(nextDetail(EMPTY_DETAIL, false, null), { detail: null, failed: true });
  })) p++; else f++;

  if (test('a good answer after a failed first one clears the failure', () => {
    assert.deepStrictEqual(nextDetail({ detail: null, failed: true }, true, good(1)), { detail: good(1), failed: false });
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
