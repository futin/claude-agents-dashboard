import assert from 'node:assert';

import {
  dashboardOpen, focusPageHtml, notePoll, requestFocus, resetFocus, takeFocus,
  FOCUS_TTL_MS, POLL_FRESH_MS
} from '../server/lib/focus.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const SID = 'abc12345-0000-1111-2222-333333333333';

export async function run(): Promise<number> {
  console.log('\n=== focus.ts ===\n');
  let p = 0, f = 0;

  if (test('a fresh store has nothing to claim', () => {
    resetFocus();
    assert.strictEqual(takeFocus(), null);
  })) p++; else f++;

  if (test('a recorded tap is returned once and only once', () => {
    resetFocus();
    requestFocus(SID);
    assert.strictEqual(takeFocus(), SID);
    assert.strictEqual(takeFocus(), null, 'consume-once — a second poll must not reopen it');
  })) p++; else f++;

  // Two taps in a row mean you want the second one; a queue would open a drawer
  // you have already moved past.
  if (test('a second tap replaces the first rather than queueing', () => {
    resetFocus();
    requestFocus('aaaaaaaa-1111');
    requestFocus('bbbbbbbb-2222');
    assert.strictEqual(takeFocus(), 'bbbbbbbb-2222');
    assert.strictEqual(takeFocus(), null, 'the replaced tap must not surface afterwards');
  })) p++; else f++;

  if (test('a tap survives right up to the TTL and not past it', () => {
    resetFocus();
    requestFocus(SID, 0);
    assert.strictEqual(takeFocus(FOCUS_TTL_MS - 1), SID);
    resetFocus();
    requestFocus(SID, 0);
    assert.strictEqual(takeFocus(FOCUS_TTL_MS), null, 'the boundary is exclusive');
    resetFocus();
    requestFocus(SID, 0);
    assert.strictEqual(takeFocus(FOCUS_TTL_MS + 1), null);
  })) p++; else f++;

  // The expired entry must be cleared, not merely withheld — otherwise it would
  // still be sitting there for a poll that happens to arrive inside the window
  // of a *later* clock reading.
  if (test('an expired tap is dropped, not withheld', () => {
    resetFocus();
    requestFocus(SID, 0);
    assert.strictEqual(takeFocus(FOCUS_TTL_MS + 1), null);
    assert.strictEqual(takeFocus(1), null, 'the stale entry must be gone, not merely unripe');
  })) p++; else f++;

  // This is what makes the redirect branch testable without waiting out 90s: a
  // fresh process is "no dashboard open" by construction.
  if (test('nothing has polled a fresh store', () => {
    resetFocus();
    assert.strictEqual(dashboardOpen(), false);
  })) p++; else f++;

  if (test('a poll counts as open right up to the freshness window', () => {
    resetFocus();
    notePoll(0);
    assert.strictEqual(dashboardOpen(POLL_FRESH_MS - 1), true);
    assert.strictEqual(dashboardOpen(POLL_FRESH_MS), false, 'the boundary is exclusive');
    assert.strictEqual(dashboardOpen(POLL_FRESH_MS + 1), false);
  })) p++; else f++;

  if (test('the throwaway page closes itself and degrades to a message', () => {
    const html = focusPageHtml();
    assert.match(html, /window\.close\(\)/);
    assert.match(html, /You can close this tab\./);
    assert.doesNotMatch(html, new RegExp(SID), 'the page must carry no session id');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
