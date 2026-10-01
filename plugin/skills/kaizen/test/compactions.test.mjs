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
