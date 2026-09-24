import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

/**
 * Assistant record carrying a usage block. NOTE: one `message.id` is one *turn*,
 * and Claude Code writes one record per content block — so several records can
 * share an id and each carries a full copy of that turn's usage. Pass `id` to
 * model a split turn; omit it to model an old/malformed transcript.
 */
function usageRec(
  usage: Record<string, unknown>,
  iso: string,
  opts: { model?: string; content?: unknown[]; sidechain?: boolean; id?: string } = {}
) {
  return {
    ...(opts.sidechain ? { isSidechain: true } : {}),
    timestamp: iso,
    message: {
      role: 'assistant',
      ...(opts.id ? { id: opts.id } : {}),
      model: opts.model ?? 'claude-opus-4-8',
      usage,
      content: opts.content ?? []
    }
  };
}
/** Assistant record emitting tool_use blocks (optionally with usage + a turn id). */
function toolUseRec(blocks: unknown[], iso: string, usage?: Record<string, unknown>, id?: string) {
  return {
    timestamp: iso,
    message: {
      role: 'assistant',
      ...(id ? { id } : {}),
      model: 'claude-opus-4-8',
      ...(usage ? { usage } : {}),
      content: blocks
    }
  };
}
/** A thinking block — the record that most often precedes a turn's tool_use records. */
function think(text = 'hmm') {
  return { type: 'thinking', thinking: text };
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
/**
 * Write a subagent transcript where the CLI puts it: `<sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl`,
 * plus the `.meta.json` sidecar when `meta` is given.
 */
function subagentFile(mainFile: string, agentId: string, records: unknown[], meta?: Record<string, unknown>): void {
  const dir = path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), records.map(r => JSON.stringify({ isSidechain: true, ...(r as object) })).join('\n'));
  if (meta) fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
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

  // --- split turns (bug-1) -------------------------------------------------
  // Claude Code writes one record per content block, each with a full copy of
  // the turn's usage under the same message.id. Summing per record double-counts.

  if (test('a turn split across records sharing one message.id counts once', () => {
    const u = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 900 };
    const file = fixture([
      usageRec(u, '2026-07-01T10:00:00Z', { id: 'msg_a', content: [think()] }),
      usageRec(u, '2026-07-01T10:00:01Z', { id: 'msg_a', content: [tu('b1', 'Bash')] })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.input, 100);
    assert.strictEqual(a.totals.output, 50);
    assert.strictEqual(a.totals.cacheCreation, 10);
    assert.strictEqual(a.totals.cacheRead, 900);
    assert.strictEqual(a.totals.combined, 1060);
    assert.strictEqual(a.totals.billableApprox, 160);
    assert.strictEqual(a.perTurn.count, 1);
    assert.strictEqual(a.perTurn.avgCombined, 1060);
  })) p++; else f++;

  if (test('parallel tool_use in separate records split that turn\'s output once', () => {
    const u = { output_tokens: 100 };
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z', u, 'msg_a'),
      toolUseRec([tu('r1', 'Read')], '2026-07-01T10:00:01Z', u, 'msg_a')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.output, 100);
    assert.strictEqual(a.byTool.find(t => t.tool === 'Bash')!.approxOutputTokens, 50);
    assert.strictEqual(a.byTool.find(t => t.tool === 'Read')!.approxOutputTokens, 50);
    assert.strictEqual(a.byTool.find(t => t.tool === 'Bash')!.count, 1);
    assert.strictEqual(a.byTool.find(t => t.tool === 'Read')!.count, 1);
  })) p++; else f++;

  if (test('same tool across three records of one turn: count 3, one turn\'s output', () => {
    const u = { output_tokens: 90 };
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z', u, 'msg_a'),
      toolUseRec([tu('b2', 'Bash')], '2026-07-01T10:00:01Z', u, 'msg_a'),
      toolUseRec([tu('b3', 'Bash')], '2026-07-01T10:00:02Z', u, 'msg_a')
    ]);
    const a = analyzeSession(file)!;
    const bash = a.byTool.find(t => t.tool === 'Bash')!;
    assert.strictEqual(bash.count, 3);              // three real calls
    assert.strictEqual(bash.approxOutputTokens, 90); // but one turn's output
  })) p++; else f++;

  if (test('maxTurnIndex indexes deduped turns, not records', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z', { id: 'msg_a', content: [think()] }),
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:01Z', { id: 'msg_a', content: [tu('b1', 'Bash')] }),
      usageRec({ input_tokens: 500 }, '2026-07-01T10:01:00Z', { id: 'msg_b', content: [think()] }),
      usageRec({ input_tokens: 500 }, '2026-07-01T10:01:01Z', { id: 'msg_b', content: [tu('b2', 'Bash')] }),
      usageRec({ input_tokens: 200 }, '2026-07-01T10:02:00Z', { id: 'msg_c' })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.combined, 800);
    assert.strictEqual(a.perTurn.count, 3);
    assert.strictEqual(a.perTurn.maxCombined, 500);
    assert.strictEqual(a.perTurn.maxTurnIndex, 1);   // 2nd deduped turn, not the 2nd record
  })) p++; else f++;

  if (test('records with no message.id each still count (fail-open)', () => {
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z'),
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:01Z')
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.combined, 200);
    assert.strictEqual(a.perTurn.count, 2);
  })) p++; else f++;

  if (test('a split sidechain turn stays fully excluded', () => {
    const u = { input_tokens: 999 };
    const file = fixture([
      usageRec({ input_tokens: 100 }, '2026-07-01T10:00:00Z', { id: 'msg_a' }),
      usageRec(u, '2026-07-01T10:00:01Z', { id: 'msg_s', sidechain: true, content: [think()] }),
      usageRec(u, '2026-07-01T10:00:02Z', { id: 'msg_s', sidechain: true, content: [tu('x1', 'Grep')] })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.totals.combined, 100);
    assert.strictEqual(a.perTurn.count, 1);
    assert.strictEqual(a.byTool.length, 0);
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

  // ── Subagent spend is read from the subagents' own transcripts (bug-27) ──
  // The harness figure (toolUseResult.totalTokens / <subagent_tokens>) is the
  // subagent's FINAL context size, not what it spent; it survives only as the
  // fallback for a subagent whose transcript is missing or incomplete.

  if (test('subagent files, zero harness figures → the transcripts\' real total, split by class', () => {
    const file = fixture([
      taskRec('t1', 'Explore', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z', { toolUseResult: { status: 'completed', agentId: 'aOne' } }),
      taskRec('t2', 'Plan', '2026-07-01T10:01:00Z'),
      resultRec('t2', '2026-07-01T10:01:01Z', { content: 'Async agent launched successfully.\nagentId: aTwo (internal)' }),
      humanRec('<task-notification>\n<task-id>aTwo</task-id>\n<status>completed</status>\n</task-notification>', '2026-07-01T10:02:00Z')
    ]);
    // aOne: two turns, the second split across two records (one usage copy each).
    const u2 = { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 };
    subagentFile(file, 'aOne', [
      usageRec({ input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 }, '2026-07-01T10:00:05Z', { id: 'msg_1' }),
      usageRec(u2, '2026-07-01T10:00:06Z', { id: 'msg_2', content: [think()] }),
      usageRec(u2, '2026-07-01T10:00:07Z', { id: 'msg_2', content: [tu('g1', 'Grep')] })
    ]);
    subagentFile(file, 'aTwo', [
      usageRec({ input_tokens: 2, output_tokens: 30, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 }, '2026-07-01T10:01:30Z', { id: 'msg_3' })
    ]);
    const a = analyzeSession(file)!;
    assert.deepStrictEqual(a.subagentTotals.usage, {
      input: 8, output: 60, cacheCreation: 600, cacheRead: 3000, combined: 3668, billableApprox: 668
    });
    assert.strictEqual(a.subagentTotals.tokens, 3668);
    assert.strictEqual(a.subagentTotals.fallbackCount, 0);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 0);
    const byId = new Map(a.bySubagent.map(s => [s.id, s.tokens]));
    assert.strictEqual(byId.get('t1'), 1536);
    assert.strictEqual(byId.get('t2'), 2132);
    // The subagents' turns never leak into the main-agent totals.
    assert.strictEqual(a.totals.combined, 0);
  })) p++; else f++;

  if (test('harness figure on some dispatches only → transcript wins where present, no double count', () => {
    const file = fixture([
      taskRec('t1', 'Explore', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z', { toolUseResult: { status: 'completed', agentId: 'aTagged', totalTokens: 500 } }),
      taskRec('t2', 'Explore', '2026-07-01T10:01:00Z'),
      resultRec('t2', '2026-07-01T10:01:30Z', { toolUseResult: { status: 'completed', agentId: 'aBare' } }),
      taskRec('t3', 'Explore', '2026-07-01T10:02:00Z'),
      resultRec('t3', '2026-07-01T10:02:30Z', { toolUseResult: { status: 'completed', agentId: 'aNoFile', totalTokens: 700 } })
    ]);
    subagentFile(file, 'aTagged', [usageRec({ input_tokens: 3000 }, '2026-07-01T10:00:10Z', { id: 'msg_a' })]);
    subagentFile(file, 'aBare', [usageRec({ input_tokens: 2000 }, '2026-07-01T10:01:10Z', { id: 'msg_b' })]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.usage.combined, 5000);
    assert.strictEqual(a.subagentTotals.tokens, 5700);    // 3000 + 2000 from files, 700 fallback
    assert.strictEqual(a.subagentTotals.fallbackCount, 1);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 0);
    const byId = new Map(a.bySubagent.map(s => [s.id, s.tokens]));
    assert.deepStrictEqual([byId.get('t1'), byId.get('t2'), byId.get('t3')], [3000, 2000, 700]);
  })) p++; else f++;

  if (test('mid-write subagent file → falls back to the harness figure; running subagent stays unknown', () => {
    const file = fixture([
      taskRec('t1', 'Explore', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z', { toolUseResult: { status: 'completed', agentId: 'aPartial', totalTokens: 10000 } }),
      taskRec('t2', 'Explore', '2026-07-01T10:01:00Z'),
      resultRec('t2', '2026-07-01T10:01:01Z', { content: 'Async agent launched successfully.\nagentId: aRunning (internal)' })
    ]);
    // Final context was 10000, so a complete transcript sums to at least that;
    // 4000 means the file has not caught up yet.
    subagentFile(file, 'aPartial', [usageRec({ input_tokens: 4000 }, '2026-07-01T10:00:10Z', { id: 'msg_p' })]);
    subagentFile(file, 'aRunning', [usageRec({ input_tokens: 900 }, '2026-07-01T10:01:10Z', { id: 'msg_r' })]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.tokens, 10000);
    assert.strictEqual(a.subagentTotals.usage.combined, 0);
    assert.strictEqual(a.subagentTotals.fallbackCount, 1);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 1);
    assert.strictEqual(a.bySubagent.find(s => s.id === 't2')!.tokens, null);
  })) p++; else f++;

  if (test('no agentId in the result → matched through the file\'s meta.json toolUseId', () => {
    const file = fixture([
      taskRec('toolu_m', 'Explore', '2026-07-01T10:00:00Z'),
      resultRec('toolu_m', '2026-07-01T10:00:30Z', { toolUseResult: { status: 'completed', totalTokens: 100 } })
    ]);
    subagentFile(file, 'aMeta', [usageRec({ input_tokens: 800 }, '2026-07-01T10:00:10Z', { id: 'msg_m' })], { toolUseId: 'toolu_m' });
    subagentFile(file, 'aStray', [usageRec({ input_tokens: 99999 }, '2026-07-01T10:00:10Z', { id: 'msg_s' })]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.tokens, 800);     // the stray, unmatched file is not a launch
    assert.strictEqual(a.subagentTotals.fallbackCount, 0);
  })) p++; else f++;

  if (test('no subagents dir → harness figure as before, counted as fallback', () => {
    const file = fixture([
      taskRec('t1', 'Explore', '2026-07-01T10:00:20Z'),
      resultRec('t1', '2026-07-01T10:00:50Z', { toolUseResult: { status: 'completed', totalTokens: 5000 } })
    ]);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.tokens, 5000);
    assert.strictEqual(a.subagentTotals.usage.combined, 0);
    assert.strictEqual(a.subagentTotals.fallbackCount, 1);
    assert.ok(a.notes.some(n => /lower bound/i.test(n)));
  })) p++; else f++;

  if (test('vendored kaizen.mjs reports the same subagent figures as analyzeSession', () => {
    const file = fixture([
      taskRec('t1', 'Explore', '2026-07-01T10:00:00Z'),
      resultRec('t1', '2026-07-01T10:00:30Z', { toolUseResult: { status: 'completed', agentId: 'aK1', totalTokens: 50 } }),
      taskRec('t2', 'Explore', '2026-07-01T10:01:00Z'),
      resultRec('t2', '2026-07-01T10:01:30Z', { toolUseResult: { status: 'completed', totalTokens: 70 } }),
      taskRec('t3', 'Explore', '2026-07-01T10:02:00Z'),
      resultRec('t3', '2026-07-01T10:02:30Z', { toolUseResult: { status: 'completed', totalTokens: 1 } }),
      // Async, completed by a notification absorbed mid-turn: no `message`, payload in top-level `content`.
      taskRec('t4', 'Explore', '2026-07-01T10:03:00Z'),
      resultRec('t4', '2026-07-01T10:03:01Z', { content: 'Async agent launched successfully.\nagentId: aK4 (internal)' }),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-01T10:04:00Z',
        content: '<task-notification>\n<task-id>aK4</task-id>\n<status>completed</status>\n</task-notification>' }
    ]);
    subagentFile(file, 'aK4', [usageRec({ input_tokens: 9 }, '2026-07-01T10:03:10Z', { id: 'msg_k4' })]);
    subagentFile(file, 'aK1', [usageRec({ input_tokens: 5, cache_read_input_tokens: 600 }, '2026-07-01T10:00:10Z', { id: 'msg_k' })]);
    subagentFile(file, 'aK3', [usageRec({ output_tokens: 40 }, '2026-07-01T10:02:10Z', { id: 'msg_k3' })], { toolUseId: 't3' });
    const kaizen = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../.claude/skills/kaizen/kaizen.mjs');
    const r = spawnSync(process.execPath, [kaizen, file], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const k = JSON.parse(r.stdout);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.subagentTotals.tokens, 724);
    assert.strictEqual(a.subagentTotals.unknownTokenCount, 0);
    assert.deepStrictEqual(k.subagentTotals, a.subagentTotals);
    assert.deepStrictEqual(k.bySubagent.map((s: any) => [s.id, s.agentId, s.tokens]), a.bySubagent.map(s => [s.id, s.agentId, s.tokens]));
  })) p++; else f++;

  if (test('resultTokens: one 30k-char Read outweighs ten 500-char Bash calls and sorts first', () => {
    const recs: unknown[] = [
      toolUseRec([tu('r1', 'Read', { file_path: '/big' })], '2026-07-01T10:00:00Z', { output_tokens: 10 }, 'msg_r'),
      resultRec('r1', '2026-07-01T10:00:01Z', { content: 'x'.repeat(30000) })
    ];
    for (let i = 0; i < 10; i++) {
      // Each Bash turn carries far more output than the Read turn — the old sort key would rank Bash first.
      recs.push(toolUseRec([tu(`b${i}`, 'Bash', { command: 'ls' })], `2026-07-01T10:01:${String(i * 2).padStart(2, '0')}Z`, { output_tokens: 200 }, `msg_b${i}`));
      recs.push(resultRec(`b${i}`, `2026-07-01T10:01:${String(i * 2 + 1).padStart(2, '0')}Z`, { content: 'y'.repeat(500) }));
    }
    const a = analyzeSession(fixture(recs))!;
    const read = a.byTool.find(t => t.tool === 'Read')!;
    const bash = a.byTool.find(t => t.tool === 'Bash')!;
    assert.strictEqual(read.resultTokens, 7500);
    assert.strictEqual(bash.resultTokens, 1250);
    assert.ok(read.resultTokens > bash.resultTokens);
    assert.ok(bash.approxOutputTokens > read.approxOutputTokens); // output ranks the other way
    assert.strictEqual(a.byTool[0].tool, 'Read');                  // context contributor leads
    assert.ok(a.notes.some(n => /resultTokens/.test(n) && /injected into context/.test(n)));
  })) p++; else f++;

  if (test('resultTokens counts is_error text, and errors still increments independently', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:00Z'),
      resultRec('b1', '2026-07-01T10:00:01Z', { isError: true, content: 'e'.repeat(400) })
    ]);
    const bash = analyzeSession(file)!.byTool.find(t => t.tool === 'Bash')!;
    assert.strictEqual(bash.errors, 1);
    assert.strictEqual(bash.resultTokens, 100);
  })) p++; else f++;

  if (test('resultTokens is per call, not split across a shared message.id like approxOutputTokens', () => {
    const u = { output_tokens: 100 };
    const file = fixture([
      toolUseRec([tu('r1', 'Read')], '2026-07-01T10:00:00Z', u, 'msg_a'),
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:01Z', u, 'msg_a'),
      resultRec('r1', '2026-07-01T10:00:02Z', { content: 'r'.repeat(4000) }),
      resultRec('b1', '2026-07-01T10:00:03Z', { content: 'b'.repeat(40) })
    ]);
    const a = analyzeSession(file)!;
    const read = a.byTool.find(t => t.tool === 'Read')!;
    const bash = a.byTool.find(t => t.tool === 'Bash')!;
    assert.strictEqual(read.approxOutputTokens, 50);  // the turn's output, split evenly
    assert.strictEqual(bash.approxOutputTokens, 50);
    assert.strictEqual(read.resultTokens, 1000);      // each call's own result, unsplit
    assert.strictEqual(bash.resultTokens, 10);
  })) p++; else f++;

  if (test('resultTokens: no tool calls → byTool empty, no crash', () => {
    const a = analyzeSession(fixture([usageRec({ input_tokens: 5 }, '2026-07-01T10:00:00Z'), humanRec('hi', '2026-07-01T10:00:01Z')]))!;
    assert.deepStrictEqual(a.byTool, []);
  })) p++; else f++;

  if (test('resultTokens: malformed tool_result content is skipped without throwing', () => {
    const file = fixture([
      toolUseRec([tu('b1', 'Bash'), tu('b2', 'Bash'), tu('b3', 'Bash')], '2026-07-01T10:00:00Z'),
      { timestamp: '2026-07-01T10:00:01Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'b1', content: { weird: true } },
        { type: 'tool_result', tool_use_id: 'b2', content: [null, 7, { type: 'image', source: {} }, { type: 'text', text: 'abcd' }] },
        { type: 'tool_result', tool_use_id: 'b3', content: 42 }
      ] } }
    ]);
    const bash = analyzeSession(file)!.byTool.find(t => t.tool === 'Bash')!;
    assert.strictEqual(bash.count, 3);
    assert.strictEqual(bash.resultTokens, 1); // only the one text block counts
  })) p++; else f++;

  if (test('vendored kaizen.mjs reports the same byTool as analyzeSession', () => {
    const file = fixture([
      toolUseRec([tu('r1', 'Read')], '2026-07-01T10:00:00Z', { output_tokens: 30 }, 'msg_a'),
      toolUseRec([tu('b1', 'Bash')], '2026-07-01T10:00:01Z', { output_tokens: 30 }, 'msg_a'),
      resultRec('r1', '2026-07-01T10:00:02Z', { content: 'r'.repeat(8000) }),
      resultRec('b1', '2026-07-01T10:00:03Z', { isError: true, content: 'b'.repeat(90) })
    ]);
    const kaizen = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../.claude/skills/kaizen/kaizen.mjs');
    const r = spawnSync(process.execPath, [kaizen, file], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const k = JSON.parse(r.stdout);
    const a = analyzeSession(file)!;
    assert.strictEqual(a.byTool[0].resultTokens, 2000);
    assert.deepStrictEqual(k.byTool, a.byTool);
    assert.deepStrictEqual(k.notes, a.notes);
  })) p++; else f++;

  // --- never-compacted inference (task-27) --------------------------------
  // A turn's combined is its whole context, so it only grows between compactions. One record per turn at
  // each size models that growth; the threshold is 250k and a compaction is a fall below half the running peak.
  const ctx = (sizes: number[]) => fixture(sizes.map((n, i) => usageRec({ cache_read_input_tokens: n }, `2026-07-01T10:${String(i).padStart(2, '0')}:00Z`)));

  if (test('neverCompacted: a session that grows to ~600k reads true', () => {
    const a = analyzeSession(ctx([20_000, 150_000, 400_000, 600_000]))!;
    assert.strictEqual(a.perTurn.maxCombined, 600_000);
    assert.strictEqual(a.perTurn.neverCompacted, true);
  })) p++; else f++;

  if (test('neverCompacted: a session peaking at ~140k reads false', () => {
    assert.strictEqual(analyzeSession(ctx([20_000, 90_000, 140_000]))!.perTurn.neverCompacted, false);
  })) p++; else f++;

  if (test('neverCompacted: the 250k boundary is exclusive — 250,000 false, 250,001 true', () => {
    assert.strictEqual(analyzeSession(ctx([100_000, 250_000]))!.perTurn.neverCompacted, false);
    assert.strictEqual(analyzeSession(ctx([100_000, 250_001]))!.perTurn.neverCompacted, true);
  })) p++; else f++;

  if (test('neverCompacted: a big early peak followed by a compaction drop reads false', () => {
    // The shape compaction leaves: peak, then a fall well below half of it, then regrowth. `max > threshold` alone says true.
    const a = analyzeSession(ctx([100_000, 600_000, 40_000, 80_000]))!;
    assert.strictEqual(a.perTurn.maxCombined, 600_000);
    assert.strictEqual(a.perTurn.maxTurnIndex, 1);
    assert.strictEqual(a.perTurn.neverCompacted, false);
  })) p++; else f++;

  if (test('neverCompacted: a compaction before the peak still reads false — the session did compact', () => {
    assert.strictEqual(analyzeSession(ctx([150_000, 30_000, 600_000]))!.perTurn.neverCompacted, false);
  })) p++; else f++;

  if (test('neverCompacted: one turn, and no usage at all, read false rather than undefined', () => {
    assert.strictEqual(analyzeSession(ctx([12_000]))!.perTurn.neverCompacted, false);
    const empty = analyzeSession(fixture([{ timestamp: '2026-07-01T10:00:00Z', message: { role: 'user', content: 'hi' } }]))!;
    assert.strictEqual(empty.perTurn.count, 0);
    assert.strictEqual(empty.perTurn.neverCompacted, false);
  })) p++; else f++;

  if (test('vendored kaizen.mjs reports the same perTurn (neverCompacted included) as analyzeSession', () => {
    const kaizen = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../.claude/skills/kaizen/kaizen.mjs');
    for (const sizes of [[20_000, 400_000, 600_000], [100_000, 600_000, 40_000], [100_000, 250_000]]) {
      const file = ctx(sizes);
      const r = spawnSync(process.execPath, [kaizen, file], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      const k = JSON.parse(r.stdout);
      const a = analyzeSession(file)!;
      assert.deepStrictEqual(k.perTurn, a.perTurn);
      assert.deepStrictEqual(k.notes, a.notes);
    }
    assert.strictEqual(JSON.parse(spawnSync(process.execPath, [kaizen, ctx([20_000, 600_000])], { encoding: 'utf8' }).stdout).perTurn.neverCompacted, true);
  })) p++; else f++;

  if (test('missing file → null', () => {
    assert.strictEqual(analyzeSession('/no/such/transcript.jsonl'), null);
  })) p++; else f++;

  console.log('\nPassed: ' + p + '  Failed: ' + f + '\n');
  return f;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(run() > 0 ? 1 : 0);
