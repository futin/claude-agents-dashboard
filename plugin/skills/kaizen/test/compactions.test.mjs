// Tests for kaizen's compaction stats: every compact_boundary in the main chain becomes one row (pre/post context, dropped, turns after), a boundary
// replayed with the same timestamp is counted once, and the unbounded-window counterfactual is Σ dropped × turns after. Each world is a synthetic
// transcript written to a temp file, since analyzeSession reads a path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeSession } from '../kaizen.mjs'

let seq = 0
const ts = (n) => new Date(Date.UTC(2026, 8, 25, 10, 0, n)).toISOString()

// A main-chain assistant turn whose context is cc + cr (input is 0).
const turn = (n, cc, cr) => ({
  type: 'assistant', isSidechain: false, timestamp: ts(n),
  message: { id: `msg_${seq++}`, role: 'assistant', model: 'm', content: [], usage: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } }
})
const boundary = (n, trigger, durationMs) => ({
  type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: ts(n), content: 'Conversation compacted',
  compactMetadata: { trigger, preTokens: 999, durationMs }
})
const summary = (n, text) => ({ type: 'user', isSidechain: false, isCompactSummary: true, timestamp: ts(n), message: { role: 'user', content: text } })
const said = (n, text) => ({ type: 'user', isSidechain: false, timestamp: ts(n), message: { role: 'user', content: text } })

function analyze(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-'))
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return analyzeSession(file, 'x')
}

test('two boundaries: per-boundary rows, counterfactual, cache rewrite, duration and hypothetical peak', () => {
  const c = analyze([
    turn(0, 100, 0), turn(1, 0, 300),
    boundary(2, 'auto', 60000), summary(3, 'x'.repeat(40)),
    turn(4, 50, 30), turn(5, 0, 200),
    boundary(6, 'manual', 30000), summary(7, 'y'.repeat(10)),
    turn(8, 60, 30), turn(9, 0, 120)
  ]).compactions
  assert.equal(c.count, 2)
  assert.equal(c.auto, 1)
  assert.equal(c.manual, 1)
  assert.equal(c.duplicatesSkipped, 0)
  assert.deepEqual(c.boundaries.map(b => [b.trigger, b.turnIndex, b.preCtx, b.postCtx, b.dropped, b.turnsAfter, b.summaryChars, b.durationMs]), [
    ['auto', 2, 300, 80, 220, 4, 40, 60000],
    ['manual', 4, 200, 90, 110, 2, 10, 30000]
  ])
  assert.equal(c.turnsAfterFirst, 4)
  assert.equal(c.counterfactualExtraCacheRead, 220 * 4 + 110 * 2)
  assert.equal(c.postCompactCacheCreation, 50 + 60)
  assert.equal(c.durationMs, 90000)
  // turns replayed with everything dropped so far: 100, 300, 300, 420, 420, 450
  assert.equal(c.hypotheticalPeakCtx, 450)
})

test('a boundary replayed with the same timestamp is counted once', () => {
  const c = analyze([
    turn(0, 0, 300),
    boundary(1, 'auto', 60000), summary(2, 'a'),
    turn(3, 0, 80), turn(4, 0, 250),
    boundary(1, 'auto', 60000), summary(2, 'a'),
    boundary(5, 'auto', 40000), summary(6, 'b'),
    turn(7, 0, 90), turn(8, 0, 100)
  ]).compactions
  assert.equal(c.count, 2)
  assert.equal(c.duplicatesSkipped, 1)
  assert.deepEqual(c.boundaries.map(b => [b.preCtx, b.postCtx, b.dropped, b.turnsAfter]), [[300, 80, 220, 4], [250, 90, 160, 2]])
  assert.equal(c.counterfactualExtraCacheRead, 220 * 4 + 160 * 2)
  assert.equal(c.durationMs, 100000)
})

test('no compaction: zero counts and a zero counterfactual', () => {
  const c = analyze([turn(0, 100, 0), turn(1, 0, 200)]).compactions
  assert.equal(c.count, 0)
  assert.deepEqual(c.boundaries, [])
  assert.equal(c.turnsAfterFirst, 0)
  assert.equal(c.counterfactualExtraCacheRead, 0)
  assert.equal(c.hypotheticalPeakCtx, 200)
})

test('a boundary with no turn after it has null post context and adds nothing to the counterfactual', () => {
  const c = analyze([turn(0, 0, 300), boundary(1, 'auto', 5000), summary(2, 'z')]).compactions
  assert.equal(c.count, 1)
  assert.deepEqual([c.boundaries[0].preCtx, c.boundaries[0].postCtx, c.boundaries[0].dropped, c.boundaries[0].turnsAfter], [300, null, null, 0])
  assert.equal(c.counterfactualExtraCacheRead, 0)
})

test('a compact summary quoting correction words is not counted as a user correction', () => {
  const a = analyze([turn(0, 0, 100), summary(1, "The user said: no, that's wrong, don't do it, revert"), said(2, 'no, wrong file')])
  assert.equal(a.errorSignals.userCorrections, 1)
})

// A compaction replays earlier records verbatim. Tool calls, their results and Agent launches must be counted once per id (#174).
const call = (n, msgId, id, name, input = {}) => ({
  type: 'assistant', isSidechain: false, timestamp: ts(n),
  message: { id: msgId, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 0, output_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 0 } }
})
const result = (n, id, content, extra = {}) => ({
  type: 'user', isSidechain: false, timestamp: ts(n),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }
})
const subUsage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 400, cache_read_input_tokens: 1000 }

function analyzeWithSubagent(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-'))
  const file = path.join(dir, 'x.jsonl')
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  fs.mkdirSync(path.join(dir, 'x', 'subagents'), { recursive: true })
  const sub = [1, 2].map(i => ({ type: 'assistant', isSidechain: true, timestamp: ts(i), message: { id: `sub_${i}`, role: 'assistant', model: 'm', content: [], usage: subUsage } }))
  fs.writeFileSync(path.join(dir, 'x', 'subagents', 'agent-abc123.jsonl'), sub.map(r => JSON.stringify(r)).join('\n') + '\n')
  return analyzeSession(file, 'x')
}

function replayWorld(bashResult) {
  const pre = [
    call(0, 'msg_A', 'toolu_A', 'Agent', { subagent_type: 'Explore', description: 'look' }),
    { ...result(1, 'toolu_A', 'Async agent launched successfully. agentId: abc123'), toolUseResult: { isAsync: true, agentId: 'abc123' } },
    said(2, '<task-notification><task-id>abc123</task-id><status>completed</status><subagent_tokens>500</subagent_tokens></task-notification>'),
    call(3, 'msg_B', 'toolu_B', 'Bash', { command: 'ls' }),
    bashResult(4)
  ]
  return [...pre, boundary(5, 'auto', 1000), summary(6, 's'), ...pre, turn(7, 0, 50)]
}
const tool = (a, name) => a.byTool.find(t => t.tool === name)

test('tool calls, results and Agent launches replayed after a compaction are counted once', () => {
  const a = analyzeWithSubagent(replayWorld((n) => result(n, 'toolu_B', 'x'.repeat(40))))
  assert.equal(tool(a, 'Bash').count, 1)
  assert.equal(tool(a, 'Agent').count, 1)
  assert.equal(tool(a, 'Bash').resultTokens, 10)
  assert.equal(a.bySubagent.length, 1)
  assert.equal(a.subagentTotals.count, 1)
  assert.deepEqual(a.subagentTotals.usage, { input: 200, output: 100, cacheCreation: 800, cacheRead: 2000, combined: 3100, billableApprox: 1100 })
  assert.equal(a.subagentTotals.tokens, 3100)
})

test('a replayed error result is one tool error, and its replayed call is not a retry', () => {
  const a = analyzeWithSubagent(replayWorld((n) => result(n, 'toolu_B', '<tool_use_error>boom</tool_use_error>', { is_error: true })))
  assert.equal(a.errorSignals.toolErrors, 1)
  assert.equal(a.errorSignals.retries, 0)
  assert.equal(tool(a, 'Bash').errors, 1)
})

test('two launch rows resolving to one subagent file add its transcript once', () => {
  const a = analyzeWithSubagent([
    call(0, 'msg_A', 'toolu_A', 'Agent', { subagent_type: 'Explore', description: 'look' }),
    result(1, 'toolu_A', 'done'),
    call(2, 'msg_C', 'toolu_C', 'Agent', { subagent_type: 'Explore', description: 'again' }),
    result(3, 'toolu_C', 'done')
  ].map(r => r.type === 'user' ? { ...r, toolUseResult: { agentId: 'abc123', totalTokens: 500 } } : r))
  assert.equal(a.bySubagent.length, 2)
  assert.equal(a.subagentTotals.count, 2)
  assert.equal(a.subagentTotals.usage.combined, 3100)
})
