import assert from 'node:assert';

import { heldBodyUuid } from '../client/src/lib/heldBody.js';
import type { ChatMessage, ChatToolCall } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function msg(uuid: string, tools: ChatToolCall[], role: 'user' | 'assistant' = 'assistant'): ChatMessage {
  return { uuid, role, ts: null, text: '', textTruncated: false, tools };
}

const ask = (q: string): ChatToolCall => ({ name: 'AskUserQuestion', detail: q, body: `**Pick**\n\n${q}` });
const plan: ChatToolCall = { name: 'ExitPlanMode', detail: '# Plan', body: '# Plan\n\n- step' };

/** Two asks loaded: the first already answered, the second the one being held. */
const TWO_ASKS: ChatMessage[] = [
  msg('u1', [], 'user'),
  msg('a1', [ask('First?')]),
  msg('a2', [{ name: 'Bash', detail: 'ls' }]),
  msg('a3', [ask('Second?')]),
  msg('a4', [{ name: 'Read', detail: 'x.ts' }])
];

export function run(): number {
  console.log('\n=== heldBody.ts ===\n');
  let p = 0, f = 0;

  if (test('null when nothing is held', () => {
    assert.strictEqual(heldBodyUuid(TWO_ASKS, 'AskUserQuestion', false), null);
  })) p++; else f++;

  if (test('newest AskUserQuestion message wins when two asks are loaded', () => {
    assert.strictEqual(heldBodyUuid(TWO_ASKS, 'AskUserQuestion', true), 'a3');
  })) p++; else f++;

  if (test('null when the held ask has not reached the transcript yet', () => {
    // the first ~1s of the hold: the tool_use record is not written yet
    assert.strictEqual(heldBodyUuid([msg('u1', [], 'user'), msg('a1', [{ name: 'Bash', detail: 'ls' }])], 'AskUserQuestion', true), null);
  })) p++; else f++;

  if (test('ignores an AskUserQuestion with no body', () => {
    const page = [msg('a1', [ask('Real?')]), msg('a2', [{ name: 'AskUserQuestion', detail: 'bare' }])];
    assert.strictEqual(heldBodyUuid(page, 'AskUserQuestion', true), 'a1');
  })) p++; else f++;

  if (test('a held question ignores ExitPlanMode, and a held plan ignores AskUserQuestion', () => {
    const page = [msg('a1', [ask('Q?')]), msg('a2', [plan])];
    assert.strictEqual(heldBodyUuid(page, 'AskUserQuestion', true), 'a1');
    assert.strictEqual(heldBodyUuid(page, 'ExitPlanMode', true), 'a2');
    assert.strictEqual(heldBodyUuid([msg('a2', [plan])], 'AskUserQuestion', true), null);
  })) p++; else f++;

  if (test('mirror: the same messages yield null once the hold clears', () => {
    assert.strictEqual(heldBodyUuid(TWO_ASKS, 'AskUserQuestion', true), 'a3');
    assert.strictEqual(heldBodyUuid(TWO_ASKS, 'AskUserQuestion', false), null);
  })) p++; else f++;

  if (test('empty page is null', () => {
    assert.strictEqual(heldBodyUuid([], 'AskUserQuestion', true), null);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
