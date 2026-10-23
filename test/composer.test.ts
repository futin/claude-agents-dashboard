import assert from 'node:assert';

import { composerKey, latestSuggestion, type ComposerKeyEvent } from '../client/src/lib/composer.js';
import type { ChatMessage, ChatToolCall } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function msg(uuid: string, role: 'user' | 'assistant', tools: ChatToolCall[] = []): ChatMessage {
  return { uuid, role, ts: null, text: uuid, textTruncated: false, tools };
}
const wrap = (suggestion?: string): ChatToolCall => ({ name: 'mcp__ccd_turn__wrap_up', detail: 'recap', ...(suggestion ? { suggestion } : {}) });

function key(k: string, mods: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
  return { key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...mods };
}
const DESK = { touch: false, empty: false, suggestion: null };

export function run(): number {
  console.log('\n=== composer.ts ===\n');
  let p = 0, f = 0;

  /* ------------------------------------------------------ latestSuggestion */

  if (test('suggestion of the last turn, read past its closing text message', () => {
    const page = [msg('u1', 'user'), msg('a1', 'assistant', [{ name: 'Bash', detail: '' }, wrap('Open the PR.')]), msg('a2', 'assistant')];
    assert.strictEqual(latestSuggestion(page), 'Open the PR.');
  })) p++; else f++;

  if (test('a user message after the wrap_up makes it stale', () => {
    const page = [msg('a1', 'assistant', [wrap('Open the PR.')]), msg('u1', 'user'), msg('a2', 'assistant')];
    assert.strictEqual(latestSuggestion(page), null);
  })) p++; else f++;

  if (test('newest wrap_up of the turn wins; one without a suggestion is passed over', () => {
    assert.strictEqual(latestSuggestion([msg('a1', 'assistant', [wrap('old')]), msg('a2', 'assistant', [wrap('new')])]), 'new');
    assert.strictEqual(latestSuggestion([msg('a1', 'assistant', [wrap('kept')]), msg('a2', 'assistant', [wrap()])]), 'kept');
  })) p++; else f++;

  if (test('no wrap_up, or an empty page → null', () => {
    assert.strictEqual(latestSuggestion([]), null);
    assert.strictEqual(latestSuggestion([msg('u1', 'user'), msg('a1', 'assistant', [{ name: 'Read', detail: '' }])]), null);
  })) p++; else f++;

  /* ----------------------------------------------------------- composerKey */

  if (test('Enter sends on a desktop keyboard, Ctrl/Cmd+Enter too', () => {
    assert.strictEqual(composerKey(key('Enter'), DESK), 'send');
    assert.strictEqual(composerKey(key('Enter', { metaKey: true }), DESK), 'send');
    assert.strictEqual(composerKey(key('Enter', { ctrlKey: true }), DESK), 'send');
  })) p++; else f++;

  if (test('Shift+Enter and Alt+Enter leave the newline to the browser', () => {
    assert.strictEqual(composerKey(key('Enter', { shiftKey: true }), DESK), null);
    assert.strictEqual(composerKey(key('Enter', { altKey: true }), DESK), null);
  })) p++; else f++;

  if (test('Enter on a touch device is a newline', () => {
    assert.strictEqual(composerKey(key('Enter'), { ...DESK, touch: true }), null);
  })) p++; else f++;

  if (test('IME composition swallows nothing — not Enter, not Tab', () => {
    assert.strictEqual(composerKey(key('Enter', { isComposing: true }), DESK), null);
    assert.strictEqual(composerKey(key('Tab', { isComposing: true }), { touch: false, empty: true, suggestion: 's' }), null);
  })) p++; else f++;

  if (test('Tab accepts only an offered suggestion into an empty box', () => {
    assert.strictEqual(composerKey(key('Tab'), { touch: false, empty: true, suggestion: 's' }), 'accept');
    assert.strictEqual(composerKey(key('Tab'), { touch: false, empty: false, suggestion: 's' }), null);
    assert.strictEqual(composerKey(key('Tab'), { touch: false, empty: true, suggestion: null }), null);
  })) p++; else f++;

  if (test('Shift+Tab (and modified Tab) keeps moving focus', () => {
    for (const mod of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) {
      assert.strictEqual(composerKey(key('Tab', { [mod]: true }), { touch: false, empty: true, suggestion: 's' }), null, mod);
    }
  })) p++; else f++;

  if (test('other keys do nothing', () => {
    assert.strictEqual(composerKey(key('a'), { touch: false, empty: true, suggestion: 's' }), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
