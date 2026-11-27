/**
 * `readSubagentFacts` (#588): the facts a subagent row gets from the subagent's own meta file and transcript tail. Records are shaped like the real
 * ones quoted in the plan's D1 (rate-limit API errors, measured 2026-11-27).
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetSubagentFactsMemo, readSubagentFacts } from '../../server/lib/subagent-facts.js';

function test(name: string, fn: () => void): boolean {
  _resetSubagentFactsMemo();
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

/** A main transcript path and its `subagents/` dir (created). */
function session(): { main: string; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-subfacts-'));
  const main = path.join(root, 'sess.jsonl');
  fs.writeFileSync(main, '');
  const dir = path.join(root, 'sess', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  return { main, dir };
}

const jsonl = (recs: unknown[]): string => recs.map(r => JSON.stringify(r)).join('\n') + '\n';
const assistantTool = (name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-' + name, name, input }] } });
const assistantText = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const rejected = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true,
    content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." }] }
};
const rateLimit = assistantText("You've hit your session limit · resets 5:30pm", { isApiErrorMessage: true, error: 'rate_limit' });

export function run(): number {
  console.log('\n=== subagent-facts.ts ===\n');
  let p = 0, f = 0;

  if (test('9: meta background/model — requestShape and model, then pickedEffortModel, else null; malformed and missing read as absent', () => {
    const cases: [string | null, { background: boolean | null; model: string | null }][] = [
      [JSON.stringify({ requestShape: 'background', model: 'm1' }), { background: true, model: 'm1' }],
      [JSON.stringify({ requestShape: 'foreground', pickedEffortModel: 'm2' }), { background: false, model: 'm2' }],
      [JSON.stringify({ agentType: 'x' }), { background: null, model: null }],
      ['{not json', { background: null, model: null }],
      [null, { background: null, model: null }]
    ];
    for (const [meta, want] of cases) {
      _resetSubagentFactsMemo();
      const { main, dir } = session();
      fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), jsonl([assistantText('hi')]));
      if (meta !== null) fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), meta);
      const got = readSubagentFacts(main, 'a1', true);
      assert.deepStrictEqual({ background: got.background, model: got.model }, want, String(meta));
    }
  })) p++; else f++;

  if (test('10: lastWriteAt is the transcript mtime; a missing transcript nulls all three file facts', () => {
    const { main, dir } = session();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, jsonl([assistantTool('Read', { file_path: '/a' })]));
    const when = new Date('2026-11-27T10:00:00.000Z');
    fs.utimesSync(file, when, when);
    assert.strictEqual(readSubagentFacts(main, 'a1', true).lastWriteAt, new Date(fs.statSync(file).mtimeMs).toISOString());
    assert.strictEqual(readSubagentFacts(main, 'a1', true).lastWriteAt, '2026-11-27T10:00:00.000Z');
    const none = readSubagentFacts(main, 'nope', true);
    assert.deepStrictEqual([none.lastWriteAt, none.lastTool, none.blockedReason], [null, null, null]);
  })) p++; else f++;

  if (test('11: lastTool is the newest tool_use as Name(label), cut to 80 with …; none → null', () => {
    const { main, dir } = session();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, jsonl([assistantTool('Read', { file_path: '/a/b.ts' }), assistantTool('Bash', { command: 'pnpm test' }), userText('ok')]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).lastTool, 'Bash(pnpm test)');
    _resetSubagentFactsMemo();
    const long = 'x'.repeat(200);
    fs.writeFileSync(file, jsonl([assistantTool('Bash', { command: long })]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).lastTool, 'Bash(' + 'x'.repeat(79) + '…)');
    _resetSubagentFactsMemo();
    fs.writeFileSync(file, jsonl([assistantTool('SubagentHandback', { report: 'APPROVE\n\n  [I] a.ts:1' })]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).lastTool, 'SubagentHandback(APPROVE [I] a.ts:1)', 'whitespace runs collapse to one space');
    _resetSubagentFactsMemo();
    fs.writeFileSync(file, jsonl([assistantTool('TodoWrite', {})]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).lastTool, 'TodoWrite', 'an empty label gives the bare name');
    _resetSubagentFactsMemo();
    fs.writeFileSync(file, jsonl([assistantText('no tools here'), userText('fine')]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).lastTool, null);
  })) p++; else f++;

  if (test('12: blockedReason on a running subagent, one case per last record (D1)', () => {
    const cases: [unknown[], string | null, string][] = [
      [[rateLimit], 'rate-limit', 'error: rate_limit'],
      [[assistantText('API Error: 429 {"type":"error"}', { isApiErrorMessage: true })], 'rate-limit', '429 text on an API error'],
      [[assistantText('the rate limit is fine')], null, 'an ordinary reply mentioning rate limit'],
      [[assistantText('API Error: 500 overloaded', { isApiErrorMessage: true, error: 'server_error' })], null, 'server_error'],
      [[rejected], 'rejected', 'rejected tool use'],
      [[userText('[Request interrupted by user]')], 'interrupted', 'interrupted'],
      [[rateLimit, { type: 'attachment', attachment: { type: 'x' } }, { type: 'api-request', requestId: 'r' }], 'rate-limit', 'non-message records skipped']
    ];
    for (const [recs, want, label] of cases) {
      _resetSubagentFactsMemo();
      const { main, dir } = session();
      fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), jsonl(recs));
      assert.strictEqual(readSubagentFacts(main, 'a1', true).blockedReason, want, label);
    }
  })) p++; else f++;

  if (test('13: a finished subagent gets blockedReason null, rate-limit tail or not', () => {
    const { main, dir } = session();
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), jsonl([rateLimit]));
    assert.strictEqual(readSubagentFacts(main, 'a1', false).blockedReason, null);
    assert.strictEqual(readSubagentFacts(main, 'a1', true).blockedReason, 'rate-limit', 'mirror: the same memo entry answers running');
  })) p++; else f++;

  if (test('14: memo — an unchanged file is not re-read; a size change is', () => {
    const { main, dir } = session();
    const file = path.join(dir, 'agent-a1.jsonl');
    fs.writeFileSync(file, jsonl([assistantTool('Read', { file_path: '/a' })]));
    const pinned = new Date('2026-11-27T10:00:00.000Z');
    fs.utimesSync(file, pinned, pinned);
    const first = readSubagentFacts(main, 'a1', true);
    assert.deepStrictEqual(readSubagentFacts(main, 'a1', true), first);
    fs.chmodSync(file, 0o000);
    try {
      assert.deepStrictEqual(readSubagentFacts(main, 'a1', true), first, 'a memo hit never opens the file');
    } finally { fs.chmodSync(file, 0o644); }
    fs.appendFileSync(file, jsonl([assistantTool('Grep', { pattern: 'needle' })]));
    fs.utimesSync(file, pinned, pinned); // only the size moved
    assert.strictEqual(readSubagentFacts(main, 'a1', true).lastTool, 'Grep(needle)');
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
