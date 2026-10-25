/**
 * The chat drawer's paging bookkeeping (`client/src/lib/chatPaging.ts`), apart from React: one tail poll at a time, so a slow `?after=` cannot be asked
 * twice with the same cursor and appended twice; and an epoch per (re)tail, so a page fetched for the old transcript is dropped instead of merged into the
 * new one.
 */
import assert from 'node:assert';

import { createChatPaging } from '../client/src/lib/chatPaging.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const page = (over: { cursor?: number; headOffset?: number; reset?: boolean; error?: boolean } = {}) => ({ cursor: 0, headOffset: 0, ...over });

export function run(): number {
  console.log('\n=== chatPaging.ts ===\n');
  let p = 0, f = 0;

  if (test('no poll before the first page lands (?after=0 would ship the whole file)', () => {
    const c = createChatPaging();
    c.retail();
    assert.strictEqual(c.beginPoll(), null);
  })) p++; else f++;

  if (test('a tick while a poll is out is skipped, so the same cursor is never fetched twice', () => {
    const c = createChatPaging();
    const ep = c.retail();
    assert.strictEqual(c.tailLanded(ep, page({ cursor: 100, headOffset: 40 })), true);
    const first = c.beginPoll();
    assert.deepStrictEqual(first && first.after, 100);
    assert.strictEqual(c.beginPoll(), null);
    assert.strictEqual(c.endPoll(first!, page({ cursor: 180 })), 'append');
    const second = c.beginPoll();
    assert.strictEqual(second && second.after, 180);
  })) p++; else f++;

  if (test('a failed or errored poll frees the slot and keeps the cursor', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100 }));
    assert.strictEqual(c.endPoll(c.beginPoll()!, null), 'drop');
    assert.strictEqual(c.endPoll(c.beginPoll()!, page({ cursor: 999, error: true })), 'drop');
    assert.strictEqual(c.beginPoll()!.after, 100);
  })) p++; else f++;

  if (test('a reset poll asks for a re-tail and polls stop until it lands', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100 }));
    assert.strictEqual(c.endPoll(c.beginPoll()!, page({ reset: true })), 'reset');
    assert.strictEqual(c.beginPoll(), null);
  })) p++; else f++;

  if (test('a poll from before a re-tail is dropped and does not touch the new cursor or slot', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100 }));
    const stale = c.beginPoll()!;
    const ep = c.retail();
    c.tailLanded(ep, page({ cursor: 20 }));
    const fresh = c.beginPoll()!;
    assert.strictEqual(c.endPoll(stale, page({ cursor: 180 })), 'drop');
    assert.strictEqual(c.beginPoll(), null, 'the stale end must not free the fresh poll\'s slot');
    assert.strictEqual(c.endPoll(fresh, page({ cursor: 30 })), 'append');
    assert.strictEqual(c.beginPoll()!.after, 30);
  })) p++; else f++;

  if (test('a tail page from an older epoch is not applied', () => {
    const c = createChatPaging();
    const old = c.retail();
    c.retail();
    assert.strictEqual(c.tailLanded(old, page({ cursor: 100 })), false);
    assert.strictEqual(c.beginPoll(), null);
  })) p++; else f++;

  if (test('load older: one at a time, from headOffset, and nothing above offset 0', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100, headOffset: 40 }));
    const t = c.beginOlder()!;
    assert.strictEqual(t.before, 40);
    assert.strictEqual(c.beginOlder(), null);
    assert.strictEqual(c.endOlder(t, page({ headOffset: 0 })), 'prepend');
    assert.strictEqual(c.beginOlder(), null, 'headOffset 0 = no history above');
  })) p++; else f++;

  if (test('load older: a failed page frees the slot and keeps headOffset', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100, headOffset: 40 }));
    assert.strictEqual(c.endOlder(c.beginOlder()!, null), 'drop');
    assert.strictEqual(c.endOlder(c.beginOlder()!, page({ headOffset: 0, error: true })), 'drop');
    assert.strictEqual(c.beginOlder()!.before, 40);
  })) p++; else f++;

  if (test('load older: a page fetched before a re-tail is stale — not prepended, and the new epoch\'s slot is left alone', () => {
    const c = createChatPaging();
    c.tailLanded(c.retail(), page({ cursor: 100, headOffset: 40 }));
    const stale = c.beginOlder()!;
    c.tailLanded(c.retail(), page({ cursor: 50, headOffset: 10 }));
    const fresh = c.beginOlder()!;
    assert.strictEqual(fresh.before, 10);
    assert.strictEqual(c.endOlder(stale, page({ headOffset: 0 })), 'stale');
    assert.strictEqual(c.beginOlder(), null, 'fresh request still owns the slot');
    assert.strictEqual(c.endOlder(fresh, page({ headOffset: 0 })), 'prepend');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
