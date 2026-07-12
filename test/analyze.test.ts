import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeSession } from '../server/lib/analyze.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

function fixture(records: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-analyze-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n'));
  return file;
}

/** Assistant record carrying a usage block (a "turn"). */
function usageRec(
  usage: Record<string, unknown>,
  iso: string,
  opts: { model?: string; content?: unknown[]; sidechain?: boolean } = {}
) {
  return {
    ...(opts.sidechain ? { isSidechain: true } : {}),
    timestamp: iso,
    message: { role: 'assistant', model: opts.model ?? 'claude-opus-4-8', usage, content: opts.content ?? [] }
  };
}
/** Assistant record emitting tool_use blocks (optionally with usage). */
function toolUseRec(blocks: unknown[], iso: string, usage?: Record<string, unknown>) {
  return {
    timestamp: iso,
    message: { role: 'assistant', model: 'claude-opus-4-8', ...(usage ? { usage } : {}), content: blocks }
  };
}
function tu(id: string, name: string, input: Record<string, unknown> = {}) {
  return { type: 'tool_use', id, name, input };
}
/** User record answering a tool_use. */
function resultRec(toolUseId: string, iso: string, opts: { isError?: boolean; content?: string; toolUseResult?: unknown } = {}) {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: toolUseId, content: opts.content ?? 'ok' };
  if (opts.isError) block.is_error = true;
  return {
    timestamp: iso,
    ...(opts.toolUseResult !== undefined ? { toolUseResult: opts.toolUseResult } : {}),
    message: { role: 'user', content: [block] }
  };
}
/** Human-typed user turn. */
function humanRec(text: string, iso: string) {
  return { timestamp: iso, message: { role: 'user', content: text } };
}
function taskRec(id: string, type: string, iso: string) {
  return { timestamp: iso, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: 'do' } }] } };
}

export function run(): number {
  console.log('\n=== analyze.ts ===\n');
  let p = 0, f = 0;

  if (test('four-field totals + billableApprox excludes cacheRead', () => {
    const file = fixture([
      usageRec({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 900 }, '2026-07-01T10:00:00Z')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.input, 100);
    assert.strictEqual(a.totals.output, 50);
    assert.strictEqual(a.totals.cacheCreation, 10);
    assert.strictEqual(a.totals.cacheRead, 900);
    assert.strictEqual(a.totals.combined, 1060);
    assert.strictEqual(a.totals.billableApprox, 160); // excludes the 900 cacheRead
  })) p++; else f++;

  if (test('totals sum across turns; perTurn max + index', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z'),
      usageRec({ input_tokens: 500 }, '2026-07-01T10:01:00Z'),
      usageRec({ input_tokens: 200 }, '2026-07-01T10:02:00Z')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.combined, 800);
    assert.strictEqual(a.perTurn.count, 3);
    assert.strictEqual(a.perTurn.maxCombined, 500);
    assert.strictEqual(a.perTurn.maxTurnIndex, 1);
    assert.strictEqual(a.perTurn.avgCombined, 267); // round(800/3)
  })) p++; else f++;

  if (test('sidechain usage excluded from totals but Task shows in bySubagent', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z'),                       // main
      usageRec({ input_tokens: 999 }, '2026-07-01T10:00:10Z', { sidechain: true }),  // subagent-internal
      taskRec('t1', 'Explore', '2026-07-01T10:00:20Z'),
      resultRec('t1', '2026-07-01T10:00:50Z', { toolUseResult: { status: 'completed', totalTokens: 5000, totalToolUseCount: 3, totalDurationMs: 30000 } })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.combined, 100);         // 999 sidechain NOT counted
    assert.strictEqual(a.bySubagent.length, 1);
    assert.strictEqual(a.bySubagent[0].tokens, 5000);
    assert.strictEqual(a.subagentTotals.count, 1);
    assert.strictEqual(a.subagentTotals.tokens, 5000);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 0);
  })) p++; else f++;

  if (test('per-tool even-split approxOutputTokens', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash', { command: 'ls' }), tu('r1', 'Read', { file_path: '/x' })], '2026-07-01T10:00:00Z', { output_tokens: 100 })
    ]);
    const a = analyzeSession(file)!;
    const bash = a.byTool.find(t => t.tool === 'Bash')!;
    const read = a.byTool.find(t => t.tool === 'Read')!;
    assert.strictEqual(bash.approxOutputTokens, 50);
    assert.strictEqual(read.approxOutputTokens, 50);
    assert.strictEqual(bash.count, 1);
  })) p++; else f++;

  if (test('toolErrors counts both is_error and <tool_use_error>', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z'),
      resultRec('b1', '2026-07-01T10:00:01Z', { isError: true }),
      toolUseRec([tu('r1', 'Read')], '2026-07-01T10:00:02Z'),
      resultRec('r1', '2026-07-01T10:00:03Z', { content: '<tool_use_error>boom</tool_use_error>' })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.errorSignals.toolErrors, 2);
    assert.strictEqual(a.byTool.find(t => t.tool === 'Bash')!.errors, 1);
  })) p++; else f++;

  if (test('retries: a tool re-invoked after it errored', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z'),
      resultRec('b1', '2026-07-01T10:00:01Z', { isError: true }),
      toolUseRec([tu('b2', 'Bash')], '2026-07-01T10:00:02Z'),
      resultRec('b2', '2026-07-01T10:00:03Z')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.errorSignals.retries, 1);
  })) p++; else f++;

  if (test('userCorrections counts human turns, ignores tool_result + task-notification', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z'),
      resultRec('b1', '2026-07-01T10:00:01Z'),                                 // tool_result-only user turn
      humanRec('No, that is wrong — revert it', '2026-07-01T10:00:02Z'),       // correction
      humanRec('<task-notification><status>completed</status> no</task-notification>', '2026-07-01T10:00:03Z'), // ignored
      humanRec('great, continue', '2026-07-01T10:00:04Z')                      // not a correction
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.errorSignals.userCorrections, 1);
  })) p++; else f++;

  if (test('unknown-token subagent → unknownTokenCount + note', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z'),
      taskRec('t1', 'Plan', '2026-07-01T10:00:10Z')   // launched, never completed → tokens null
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.count, 1);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 1);
    assert.ok(a.notes.some(n => /unknown token/i.test(n)));
  })) p++; else f++;

  if (test('multi-model models[]', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z', { model: 'claude-opus-4-8' }),
      usageRec({ input_tokens: 100 }, '2026-07-01T10:01:00Z', { model: 'claude-haiku-4-5-20251001' })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.models.length, 2);
    assert.ok(a.models.includes('claude-opus-4-8'));
    assert.ok(a.models.includes('claude-haiku-4-5-20251001'));
  })) p++; else f++;

  if (test('serverTools + duration span', () => {
    const file = fixture([
      usageRec({ input_tokens: 100, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }, '2026-07-01T10:00:00Z'),
      usageRec({ input_tokens: 100 }, '2026-07-01T10:05:00Z')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.serverTools.webSearch, 2);
    assert.strictEqual(a.serverTools.webFetch, 1);
    assert.strictEqual(a.durationMs, 5 * 60 * 1000);
  })) p++; else f++;

  if (test('missing file → null', () => {
    assert.strictEqual(analyzeSession('/no/such/transcript.jsonl'), null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
