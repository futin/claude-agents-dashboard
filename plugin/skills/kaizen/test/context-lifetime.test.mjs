// Tests for kaizen's contextLifetime block: how long each tool result stayed in context, counted in main-chain turns (one per distinct message.id,
// usage or not) up to the next compact boundary, a replayed duplicate boundary included. Token-turns = resultTokens × turnsAfter; a result is flagged
// when it clears both the absolute and the share floor, at most five per session. Each world is a synthetic transcript written to a temp file.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeSession } from '../kaizen.mjs'

const dirs = []
const fixtureDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-life-')); dirs.push(d); return d }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const ts = (n) => new Date(Date.UTC(2026, 10, 17, 10, 0, n)).toISOString()
const USAGE = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// T: an assistant turn (one record) with the given message.id and blocks. usage: false → a turn without usage.
const T = (id, blocks = [], { usage = true, sidechain = false, n = 0 } = {}) => ({
  type: 'assistant', isSidechain: sidechain, timestamp: ts(n),
  message: { id, role: 'assistant', model: 'm', content: blocks, ...(usage ? { usage: USAGE } : {}) }
})
const U = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })
const R = (id, text, { sidechain = false, n = 0 } = {}) => ({
  type: 'user', isSidechain: sidechain, timestamp: ts(n), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }
})
const boundary = (n) => ({
  type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: ts(n), content: 'Conversation compacted',
  compactMetadata: { trigger: 'auto', preTokens: 999, durationMs: 1000 }
})
// `count` plain turns with ids `${prefix}${from}`…
const turns = (prefix, from, count, opts) => Array.from({ length: count }, (_, i) => T(`${prefix}${from + i}`, [], opts))

function analyze(records) {
  const file = path.join(fixtureDir(), 'x.jsonl')
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return analyzeSession(file, 'x')
}
const rowsOf = (a) => a.contextLifetime

test('1. a result lives to the session end', () => {
  const c = rowsOf(analyze([T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(4000)), ...turns('m', 2, 10)]))
  assert.equal(c.tokenTurns, 10_000)
  assert.deepEqual(c.byTool, [{ tool: 'Read', results: 1, tokenTurns: 10_000, maxTurnsAfter: 10 }])
  // 10,000 is under the absolute floor, so nothing is flagged — read the row back through a flag-sized twin below.
  assert.deepEqual(c.flagged, [])
  const big = rowsOf(analyze([T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(400_000)), ...turns('m', 2, 10)]))
  assert.deepEqual(big.flagged, [{ tool: 'Read', target: '/a.ts', turnIndex: 1, resultTokens: 100_000, turnsAfter: 10, tokenTurns: 1_000_000, share: 1 }])
})

test('2. a compaction ends the lifetime', () => {
  const c = rowsOf(analyze([
    T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(4000)), ...turns('m', 2, 3), boundary(5), ...turns('m', 5, 7)
  ]))
  assert.deepEqual(c.byTool, [{ tool: 'Read', results: 1, tokenTurns: 3000, maxTurnsAfter: 3 }])
})

test('3. a replayed duplicate boundary still settles', () => {
  const a = analyze([
    T('m1', [U('a', 'Read', { file_path: '/a.ts' })]), R('a', 'x'.repeat(400)), T('m2'),
    boundary(9),
    T('m3', [U('b', 'Bash', { command: 'ls' })]), R('b', 'y'.repeat(400)), T('m4'), T('m5'),
    boundary(9),
    T('m6'), T('m7')
  ])
  assert.equal(a.compactions.count, 1)
  assert.equal(a.compactions.duplicatesSkipped, 1)
  assert.deepEqual(a.contextLifetime.byTool.map(t => [t.tool, t.maxTurnsAfter]).sort(), [['Bash', 2], ['Read', 1]])
})

test('4. turns without usage still count — the lifetime counter is not perTurn.count', () => {
  const a = analyze([T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(4000)), ...turns('m', 2, 10, { usage: false })])
  assert.equal(a.contextLifetime.byTool[0].maxTurnsAfter, 10)
  assert.equal(a.perTurn.count, 1)
})

test('5. one turn split across records counts once', () => {
  const c = rowsOf(analyze([T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(4000)), T('m2'), T('m2'), T('m2'), T('m3')]))
  assert.equal(c.byTool[0].maxTurnsAfter, 2)
})

test('6. sidechain records add neither a row nor a turn', () => {
  const c = rowsOf(analyze([
    T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), R('r1', 'x'.repeat(4000)),
    T('s1', [U('s-r', 'Bash', { command: 'ls' })], { sidechain: true }), R('s-r', 'z'.repeat(4000), { sidechain: true }), T('s2', [], { sidechain: true }),
    T('m2'), T('s3', [], { sidechain: true }), T('m3')
  ]))
  assert.deepEqual(c.byTool, [{ tool: 'Read', results: 1, tokenTurns: 2000, maxTurnsAfter: 2 }])
})

test('7. a replayed tool_result is counted once', () => {
  const r = R('r1', 'x'.repeat(4000))
  const c = rowsOf(analyze([T('m1', [U('r1', 'Read', { file_path: '/a.ts' })]), r, r, T('m2')]))
  assert.equal(c.byTool[0].results, 1)
})

// One Read per size (chars), each in its own turn; `tail` plain turns after the last one.
const sized = (sizes, tail) => {
  const recs = []
  sizes.forEach((chars, i) => { recs.push(T(`t${i}`, [U(`r${i}`, 'Read', { file_path: `/f${i}.ts` })]), R(`r${i}`, 'x'.repeat(chars))) })
  return [...recs, ...turns('z', 0, tail)]
}

test('8A. a row exactly at both floors is flagged (inclusive)', () => {
  const c = rowsOf(analyze(sized([100_000], 10)))
  assert.equal(c.tokenTurns, 250_000)
  assert.equal(c.flagged.length, 1)
  assert.equal(c.flagged[0].share, 1)
})

test('8B. a row one token under the absolute floor is not flagged', () => {
  const c = rowsOf(analyze(sized([99_996], 10)))
  assert.equal(c.tokenTurns, 249_990)
  assert.deepEqual(c.flagged, [])
})

test('8C. a row over the absolute floor but under the share floor is not flagged', () => {
  // Row 0: 30,000 tokens × 11 turns would skew the arithmetic, so the big row arrives first and the small one last: big = 600,000 tok × 10 turns,
  // small = 30,000 tok × 10 turns — both followed by the same 10 tail turns, the big one also by the small one's turn.
  const recs = [
    T('big', [U('rb', 'Read', { file_path: '/big.ts' })]), R('rb', 'x'.repeat(2_400_000)),
    ...turns('p', 0, 9),
    T('small', [U('rs', 'Read', { file_path: '/small.ts' })]), R('rs', 'x'.repeat(120_000)),
    ...turns('z', 0, 10)
  ]
  const c = rowsOf(analyze(recs))
  // big lives 9 + 1 + 10 = 20 turns → 12,000,000; small lives 10 → 300,000; share 300k / 12.3M = 0.024.
  assert.equal(c.tokenTurns, 12_300_000)
  assert.deepEqual(c.flagged.map(r => r.target), ['/big.ts'])
})

test('8D. at most five rows are flagged, largest first, share to 3 decimals', () => {
  // Seven reads of 30k..90k tokens; read i lives (7 - i - 1) + 10 turns.
  const c = rowsOf(analyze(sized([120_000, 160_000, 200_000, 240_000, 280_000, 320_000, 360_000], 10)))
  assert.equal(c.flagged.length, 5)
  const tt = c.flagged.map(r => r.tokenTurns)
  assert.deepEqual(tt, [...tt].sort((x, y) => y - x))
  for (const r of c.flagged) {
    assert.ok(r.tokenTurns >= 250_000 && r.tokenTurns / c.tokenTurns >= 0.05)
    assert.equal(r.share, Math.round((r.tokenTurns / c.tokenTurns) * 1000) / 1000)
  }
  // Every one of the seven clears both floors, so the cap — not the floors — is what drops two.
  assert.equal(c.byTool[0].results, 7)
  assert.deepEqual(c.threshold, { minTokenTurns: 250_000, minShare: 0.05, max: 5 })
})

test('9. target labels', () => {
  const cmd = 'echo ' + 'a'.repeat(295)
  const blocks = [
    U('a', 'Read', { file_path: '/a.ts', offset: 10, limit: 20 }), U('b', 'Bash', { command: cmd }), U('c', 'Grep', { pattern: 'foo.*bar' }),
    U('d', 'Mystery', { file_path: '/nope' })
  ]
  const recs = [T('m1', blocks), ...['a', 'b', 'c', 'd'].map(id => R(id, 'x'.repeat(400_000))), ...turns('z', 0, 10)]
  const c = rowsOf(analyze(recs))
  const byTool = Object.fromEntries(c.flagged.map(r => [r.tool, r.target]))
  assert.deepEqual(byTool, { Read: '/a.ts [offset/limit]', Bash: cmd.slice(0, 120), Grep: 'foo.*bar', Mystery: '' })
  assert.equal(byTool.Bash.length, 120)
})

test('10. a session with no tool calls has an empty block and unchanged notes', () => {
  const a = analyze([T('m1'), T('m2')])
  const { threshold, note, ...rest } = a.contextLifetime
  assert.deepEqual(rest, { tokenTurns: 0, byTool: [], flagged: [] })
  assert.deepEqual(threshold, { minTokenTurns: 250_000, minShare: 0.05, max: 5 })
  assert.ok(note.includes('cacheRead'))
  assert.ok(!a.notes.some(n => n.includes('contextLifetime') || n.includes('tokenTurns')))
})
