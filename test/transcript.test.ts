import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as tr from '../server/lib/transcript.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function fixture(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-tr-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, records.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  return file;
}

export function run(): number {
  console.log('\n=== transcript.ts ===\n');
  let p = 0, f = 0;

  if (test('usageTokens sums input + cache read + cache create', () => {
    assert.strictEqual(tr.usageTokens({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } }), 105);
    assert.strictEqual(tr.usageTokens({ message: {} }), 0);
    assert.strictEqual(tr.usageTokens({}), 0);
  })) p++; else f++;

  if (test('resolveWindow: default 200k, sonnet/opus 1M, [1m] marker, env override, overflow', () => {
    assert.strictEqual(tr.resolveWindow(1000, 'claude-haiku-4-5-20251001', {}), 200000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-opus-4-8', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-sonnet-5', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'claude-sonnet-5[1m]', {}), 1000000);
    assert.strictEqual(tr.resolveWindow(1000, 'x', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }), 400000);
    assert.strictEqual(tr.resolveWindow(250000, 'x', {}), 1000000);
  })) p++; else f++;

  if (test('windowLabel formats k / M', () => {
    assert.strictEqual(tr.windowLabel(200000), '200k');
    assert.strictEqual(tr.windowLabel(1000000), '1M');
  })) p++; else f++;

  if (test('describeTool per tool type', () => {
    assert.strictEqual(tr.describeTool({ name: 'Task', input: { subagent_type: 'Explore', description: 'find' } }), 'Explore: find');
    assert.strictEqual(tr.describeTool({ name: 'Bash', input: { description: 'run', command: 'x' } }), 'run');
    assert.strictEqual(tr.describeTool({ name: 'Edit', input: { file_path: '/a.js' } }), '/a.js');
    assert.strictEqual(tr.describeTool({ name: 'Grep', input: { pattern: 'foo' } }), 'foo');
  })) p++; else f++;

  if (test('readTranscript extracts tokens, model, activity, meta', () => {
    const file = fixture([
      { cwd: '/Users/me/proj', gitBranch: 'main', version: '2.1.0', timestamp: '2026-07-01T09:00:00Z', type: 'user' },
      { message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, cache_read_input_tokens: 900 } } },
      { message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.js' } }] } }
    ]);
    const s = tr.readTranscript(file)!;
    assert.strictEqual(s.tokens, 1000);
    assert.strictEqual(s.model, 'claude-opus-4-8');
    assert.strictEqual(s.contextWindow, 1000000);
    assert.strictEqual(s.contextPct, 0.1);
    assert.strictEqual(s.activity!.tool, 'Edit');
    assert.strictEqual(s.activity!.detail, '/a/b.js');
    assert.strictEqual(s.cwd, '/Users/me/proj');
    assert.strictEqual(s.gitBranch, 'main');
    assert.strictEqual(s.version, '2.1.0');
    assert.strictEqual(s.sessionName, null);
  })) p++; else f++;

  if (test('readTranscript extracts custom-title as sessionName', () => {
    const s = tr.readTranscript(fixture([
      { message: { role: 'user', content: 'hi' }, timestamp: '2026-07-01T09:00:00Z' },
      { type: 'custom-title', customTitle: 'My work', sessionId: 'x' }
    ]))!;
    assert.strictEqual(s.sessionName, 'My work');
  })) p++; else f++;

  if (test('readTranscript treats "New session" placeholder as unnamed', () => {
    const s = tr.readTranscript(fixture([
      { message: { role: 'user', content: 'hi' }, timestamp: '2026-07-01T09:00:00Z' },
      { type: 'custom-title', customTitle: 'New session', sessionId: 'x' }
    ]))!;
    assert.strictEqual(s.sessionName, null);
  })) p++; else f++;

  if (test('readTranscript returns null for missing file', () => {
    assert.strictEqual(tr.readTranscript('/no/such.jsonl'), null);
  })) p++; else f++;

  if (test('turnComplete/waitingOnQuestion from newest message record', () => {
    const done = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
    ]))!;
    assert.strictEqual(done.turnComplete, true);
    assert.strictEqual(done.waitingOnQuestion, false);

    const pending = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
    ]))!;
    assert.strictEqual(pending.turnComplete, false);
    assert.strictEqual(pending.waitingOnQuestion, false);

    const asking = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } }] } }
    ]))!;
    assert.strictEqual(asking.waitingOnQuestion, true);

    // Newest record is the user's tool_result → question answered, turn still open.
    const answered = tr.readTranscript(fixture([
      { message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }
    ]))!;
    assert.strictEqual(answered.waitingOnQuestion, false);
    assert.strictEqual(answered.turnComplete, false);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
