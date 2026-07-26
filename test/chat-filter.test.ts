import assert from 'node:assert';

import { CHAT_FILTERS, filterMessages, isChatFilter } from '../client/src/lib/chatFilter.js';
import type { ChatMessage } from '../shared/types.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function msg(uuid: string, role: 'user' | 'assistant', text: string, tools: string[] = []): ChatMessage {
  return { uuid, role, ts: null, text, textTruncated: false, tools: tools.map(name => ({ name, detail: '' })) };
}

/** The shape the user complained about: prose, then a run of tool-only turns. */
const PAGE: ChatMessage[] = [
  msg('u1', 'user', 'add a filter'),
  msg('a1', 'assistant', 'Now verify in the browser:'),
  msg('a2', 'assistant', '', ['Edit']),
  msg('a3', 'assistant', '', ['Edit']),
  msg('a4', 'assistant', '', ['Bash']),
  msg('a5', 'assistant', 'Done — tests pass.', ['Bash']),
  msg('u2', 'user', '', ['nothing'])
];

export function run(): number {
  console.log('\n=== chatFilter.ts ===\n');
  let p = 0, f = 0;

  if (test('all → untouched, same array identity', () => {
    assert.strictEqual(filterMessages(PAGE, 'all'), PAGE);
  })) p++; else f++;

  if (test('text → drops tool-only turns, keeps text+tool turns', () => {
    assert.deepStrictEqual(filterMessages(PAGE, 'text').map(m => m.uuid), ['u1', 'a1', 'a5']);
  })) p++; else f++;

  if (test('prompts → user turns only, even tool-only ones', () => {
    assert.deepStrictEqual(filterMessages(PAGE, 'prompts').map(m => m.uuid), ['u1', 'u2']);
  })) p++; else f++;

  if (test('filtering never reorders or mutates', () => {
    const before = PAGE.map(m => m.uuid);
    const out = filterMessages(PAGE, 'text');
    assert.deepStrictEqual(PAGE.map(m => m.uuid), before);
    assert.deepStrictEqual(out.map(m => m.uuid), out.map(m => m.uuid).slice().sort((a, b) => before.indexOf(a) - before.indexOf(b)));
  })) p++; else f++;

  if (test('empty input is empty for every filter', () => {
    for (const { key } of CHAT_FILTERS) assert.deepStrictEqual(filterMessages([], key), []);
  })) p++; else f++;

  if (test('isChatFilter guards stale/garbage persisted values', () => {
    for (const { key } of CHAT_FILTERS) assert.strictEqual(isChatFilter(key), true);
    for (const bad of ['tools', '', null, undefined, 7, {}]) assert.strictEqual(isChatFilter(bad), false);
  })) p++; else f++;

  console.log(`\n  ${p} passed, ${f} failed`);
  return f;
}
