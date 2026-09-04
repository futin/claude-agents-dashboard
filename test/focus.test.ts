import assert from 'node:assert';

import {
  focusPageHtml, focusPending, requestFocus, resetFocus, takeFocus, FOCUS_TTL_MS
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

  // What the throwaway page reads to decide its own fate. A peek must never
  // consume — the dashboard's poll is the single consumer.
  if (test('focusPending peeks without consuming', () => {
    resetFocus();
    assert.strictEqual(focusPending(), false, 'nothing tapped yet');
    requestFocus(SID);
    assert.strictEqual(focusPending(), true);
    assert.strictEqual(focusPending(), true, 'peeking twice must not have eaten it');
    assert.strictEqual(takeFocus(), SID, 'the real consumer still gets it');
    assert.strictEqual(focusPending(), false, 'and now it is gone');
  })) p++; else f++;

  if (test('focusPending reports an expired tap as gone', () => {
    resetFocus();
    requestFocus(SID, 0);
    assert.strictEqual(focusPending(FOCUS_TTL_MS - 1), true);
    assert.strictEqual(focusPending(FOCUS_TTL_MS), false, 'the boundary is exclusive');
  })) p++; else f++;

  if (test('the throwaway page closes when claimed and navigates when not', () => {
    const html = focusPageHtml(SID);
    assert.match(html, /window\.close\(\)/, 'claimed -> close');
    assert.match(html, /location\.replace/, 'unclaimed -> become the dashboard');
    assert.match(html, /You can close this tab\./, 'and a fallback if close is refused');
    assert.match(html, /api\/focus\/claimed/, 'it must actually ask');
    assert.ok(html.includes(SID), 'the id is needed for the navigate branch');
  })) p++; else f++;

  // Interpolated into a script literal, so a hostile id must not escape it.
  // `serveFocus` shape-checks first, but this pins the encoding regardless.
  if (test('the page JSON-encodes the id rather than pasting it', () => {
    const html = focusPageHtml('</script><script>alert(1)</script>');
    assert.doesNotMatch(html, /<script>alert\(1\)/, 'must not break out of the string');
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
