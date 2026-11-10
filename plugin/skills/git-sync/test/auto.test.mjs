// Tests for the opt-in auto answers (`survey --auto-merged --auto-clean`): which items they answer, which they leave as questions, and how `plan`
// folds them into the user's own answers. Pure: a hand-built survey goes through `rounds` and `buildPlan`, no repo needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rounds, buildPlan, foldAuto } from '../tools/git-sync.mjs'

const sha = (c) => c.repeat(40)
const branch = (name, bucket, extra = {}) => ({
  name, bucket, proof: bucket === 'merged' ? 'M1' : null, reason: 'r', unpushed: null, superseded: null,
  local: { sha: sha(name.length.toString(16).slice(-1)), date: 0, upstream: null, gone: false, ahead: 0 }, remote: null, ...extra,
})
const tree = (name, dirty = 0, extra = {}) => ({ path: `/wt/${name}`, branch: name, head: sha('a'), dirty, locked: false, prunable: false, inProgress: null, ...extra })
const survey = (branches, worktrees) => ({
  trunk: 'main', downgraded: false, carry: null, stashes: [], branches, worktrees,
  mergedSet: branches.filter((b) => b.bucket === 'merged' && worktrees.every((w) => w.branch !== b.name || w.dirty === 0)).map((b) => b.name),
})
const ids = (r) => r.rounds.flat().map((q) => q.id)

const s = () => survey(
  [branch('m', 'merged'), branch('sup', 'superseded'), branch('sup-dirty', 'superseded'), branch('gone', 'gone-unproven'), branch('act', 'active')],
  [tree('sup'), tree('sup-dirty', 2), tree('gone'), tree('act')],
)

test('A1 no flags: nothing is auto-answered and every question is asked', () => {
  const r = rounds(s())
  assert.deepEqual(r.auto, {})
  assert.deepEqual(ids(r).sort(), ['asked:0', 'merged', 'superseded:0', 'worktree:/wt/act', 'worktree:/wt/gone', 'worktree:/wt/sup', 'worktree:/wt/sup-dirty'].sort())
})

test('A2 --auto-merged answers the merged question and nothing else', () => {
  const r = rounds(s(), { merged: true })
  assert.deepEqual(r.auto, { merged: 'all' })
  assert.ok(!ids(r).includes('merged'))
  assert.ok(ids(r).includes('superseded:0'))
})

test('A3 --auto-clean removes clean worktrees on non-active branches and deletes superseded branches whose worktrees are all clean', () => {
  const r = rounds(s(), { clean: true })
  assert.deepEqual(r.auto, { worktrees: { '/wt/sup': 'remove', '/wt/gone': 'remove' }, superseded: ['sup'] })
  assert.deepEqual(ids(r).sort(), ['asked:0', 'merged', 'superseded:0', 'worktree:/wt/act', 'worktree:/wt/sup-dirty'].sort())
  const q = r.rounds.flat().find((x) => x.id === 'superseded:0')
  assert.deepEqual(q.options.map((o) => o.label).filter((l) => l !== 'Keep all'), ['sup-dirty'])
})

test('A4 --auto-clean never touches an active branch, a dirty worktree, a detached one, or an abandoned or gone-unproven branch itself', () => {
  const r = rounds(survey([branch('act', 'active'), branch('old', 'abandoned')], [tree('act'), tree('old', 1), tree('x', 0, { branch: null, path: '/wt/det' })]), { clean: true })
  assert.deepEqual(r.auto, {})
})

test('A5 the plan built from the auto answers removes worktrees first, then deletes only what was proven', () => {
  const sv = s()
  const { auto } = rounds(sv, { merged: true, clean: true })
  const actions = buildPlan(sv, auto)
  assert.deepEqual(actions.map((a) => `${a.kind}:${a.target}`), ['remove-worktree:/wt/sup', 'remove-worktree:/wt/gone', 'delete-local:m', 'delete-local:sup'])
  assert.deepEqual(actions.filter((a) => a.kind === 'delete-local').map((a) => a.basis), ['merged', 'superseded'])
  assert.ok(!actions.some((a) => a.target === 'gone' || a.target === 'act' || a.target === 'sup-dirty'))
})

test('A6 foldAuto: lists unite, maps fill the unanswered, the user wins on a scalar', () => {
  assert.deepEqual(foldAuto({ superseded: ['b'] }, { superseded: ['a'] }), { superseded: ['b', 'a'] })
  assert.deepEqual(foldAuto({ worktrees: { '/x': 'keep' } }, { worktrees: { '/x': 'remove', '/y': 'remove' } }), { worktrees: { '/x': 'keep', '/y': 'remove' } })
  assert.deepEqual(foldAuto({ merged: 'none' }, { merged: 'all' }), { merged: 'none' })
  assert.deepEqual(foldAuto({}, { merged: 'all' }), { merged: 'all' })
})
