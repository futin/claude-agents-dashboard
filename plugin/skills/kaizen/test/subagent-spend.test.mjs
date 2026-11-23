// Tests for kaizen's subagent fold and spend: a background subagent closes on any terminal <status> — completed, failed, killed or stopped — and a
// SendMessage resume closes a run still open, so each one's own transcript reaches subagentTotals. The fold mirrors server/lib/agents.ts (#420, #506).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeSession } from '../kaizen.mjs'

const dirs = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const launch = (id, ts) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'job' } }] } })
const asyncAck = (id, agentId, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Async agent launched successfully.\nagentId: ${agentId} (internal)` }] } })
const syncResult = (id, agentId, ts, totalTokens) => ({ type: 'user', timestamp: ts, toolUseResult: { status: 'completed', agentId, totalTokens }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } })
const notify = (agentId, status, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n</task-notification>` } })
const send = (id, to, ts) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, summary: 'round 2', message: 'x' } }] } })
const resumed = (id, agentId, ts) => ({ type: 'user', timestamp: ts, toolUseResult: { success: true, resumedAgentId: agentId }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'sent' }] } })
const usage = (msgId, input) => ({ type: 'assistant', timestamp: '2026-11-23T10:00:10Z', message: { id: msgId, role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })

// A main transcript plus one subagent transcript per entry of `subagents` ({ agentId: [records] }).
function analyze(records, subagents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-')); dirs.push(dir)
  const file = path.join(dir, 'x.jsonl')
  const write = (p, recs) => fs.writeFileSync(p, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  write(file, records)
  const sub = path.join(dir, 'x', 'subagents')
  fs.mkdirSync(sub, { recursive: true })
  for (const [agentId, recs] of Object.entries(subagents)) write(path.join(sub, `agent-${agentId}.jsonl`), recs)
  return analyzeSession(file, 'x')
}

for (const status of ['completed', 'failed', 'killed', 'stopped']) {
  test(`a background subagent that ends ${status} has its transcript spend in subagentTotals`, () => {
    const a = analyze(
      [launch('t1', '2026-11-23T10:00:00Z'), asyncAck('t1', 'aBg', '2026-11-23T10:00:01Z'), notify('aBg', status, '2026-11-23T10:01:00Z')],
      { aBg: [usage('m1', 3000)] }
    )
    assert.equal(a.subagentTotals.tokens, 3000)
    assert.equal(a.subagentTotals.usage.combined, 3000)
    assert.equal(a.subagentTotals.unknownTokenCount, 0)
    assert.deepEqual(a.bySubagent.map(s => [s.id, s.status, s.tokens]), [['t1', 'done', 3000]])
  })
}

test('a non-terminal status leaves the subagent running, its spend unknown', () => {
  const a = analyze(
    [launch('t1', '2026-11-23T10:00:00Z'), asyncAck('t1', 'aBg', '2026-11-23T10:00:01Z'), notify('aBg', 'in_progress', '2026-11-23T10:01:00Z')],
    { aBg: [usage('m1', 3000)] }
  )
  assert.equal(a.subagentTotals.tokens, 0)
  assert.equal(a.subagentTotals.unknownTokenCount, 1)
  assert.deepEqual(a.bySubagent.map(s => [s.id, s.status]), [['t1', 'running']])
})

test('a resume closes a run still open, and the shared transcript is spent once, on the launch row', () => {
  const a = analyze(
    [
      launch('t1', '2026-11-23T10:00:00Z'), asyncAck('t1', 'aRes', '2026-11-23T10:00:01Z'),
      send('sm1', 'aRes', '2026-11-23T10:01:00Z'), resumed('sm1', 'aRes', '2026-11-23T10:01:01Z')
    ],
    { aRes: [usage('m1', 3000), usage('m2', 4000)] }
  )
  assert.deepEqual(a.bySubagent.map(s => [s.id, s.status, s.tokens, s.endedAt]), [['t1', 'done', 7000, '2026-11-23T10:01:00Z']])
  assert.equal(a.subagentTotals.count, 1)
  assert.equal(a.subagentTotals.tokens, 7000)
  assert.equal(a.subagentTotals.usage.combined, 7000)
  assert.equal(a.subagentTotals.unknownTokenCount, 0)
})

test('a resume after a finished run leaves the launch row as it was and counts the transcript once', () => {
  const a = analyze(
    [
      launch('t1', '2026-11-23T10:00:00Z'), syncResult('t1', 'aRes', '2026-11-23T10:00:30Z', 100),
      send('sm1', 'aRes', '2026-11-23T10:01:00Z'), resumed('sm1', 'aRes', '2026-11-23T10:01:01Z'),
      notify('aRes', 'completed', '2026-11-23T10:02:00Z')
    ],
    { aRes: [usage('m1', 3000), usage('m2', 4000)] }
  )
  assert.deepEqual(a.bySubagent.map(s => [s.id, s.tokens, s.endedAt]), [['t1', 7000, '2026-11-23T10:00:30Z']])
  assert.equal(a.subagentTotals.count, 1)
  assert.equal(a.subagentTotals.tokens, 7000)
  assert.equal(a.subagentTotals.usage.combined, 7000)
})
