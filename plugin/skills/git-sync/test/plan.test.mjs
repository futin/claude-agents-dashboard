// Tests for the decision round and the plan (design.md §7, §10.9): `rounds` turns a survey into AskUserQuestion-sized calls, and `buildPlan` turns
// the answers back into the ordered action list `apply` executes. The worlds are real git histories surveyed through the CLI, so the questions and
// the plan are built from exactly the payload SKILL.md sees; answer validation is exercised in-process against that same payload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildPlan, rounds, Stop } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

// Same shape as survey.test.mjs's helper: a new branch off `main` with one commit, optionally pushed with an upstream, then back to `main`.
function branch(w, name, { daysAgo, push = false, dir = w.a } = {}) {
  w.git(dir, 'checkout', '-b', name)
  const tip = w.commit(dir, { file: `${name}.txt`, content: `${name}\n`, msg: `work on ${name}`, daysAgo })
  if (push) w.git(dir, 'push', '-u', 'origin', name)
  w.git(dir, 'checkout', 'main')
  return tip
}

function surveyOf(w) {
  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

// Runs `plan` through the CLI with `answers` written to a file under the world root (whose path holds a space).
function planCli(w, answers) {
  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, JSON.stringify(answers))
  return w.cli(w.a, ['plan', '--answers', file])
}

const questions = (s) => s.rounds.flat()
const byId = (s, id) => questions(s).find((q) => q.id === id)
const badAnswers = (err) => err instanceof Stop && err.stop === 'bad-answers'
const realWt = (w, name) => path.join(fs.realpathSync(w.root), `wt ${name}`)

// T7.1's world: one of each bucket, `open-pr` protected by an open PR the gh stub reports.
function t71World(t) {
  const w = world(t)
  branch(w, 'done-ff', { push: true })
  w.git(w.a, 'merge', '--ff-only', 'done-ff')
  branch(w, 'wip', { push: true, daysAgo: 1 })
  branch(w, 'old', { push: true, daysAgo: 31 })
  branch(w, 'young', { push: true, daysAgo: 29 })
  branch(w, 'gone', { push: true })
  const prTip = branch(w, 'open-pr', { push: true })
  w.git(w.b, 'push', 'origin', '--delete', 'gone')
  w.git(w.a, 'fetch', '--prune', 'origin')
  w.stub('gh', {
    stdout: '[]\n',
    byArgs: { '--head open-pr': { stdout: `${JSON.stringify([{ number: 9, state: 'OPEN', headRefOid: prTip }])}\n` } },
  })
  return w
}

test('T8.1 the merged question comes first; abandoned and gone-unproven share the asked question', (t) => {
  const w = t71World(t)
  const s = surveyOf(w)
  const first = s.rounds[0][0]
  assert.equal(first.id, 'merged')
  assert.equal(first.header, 'Merged')
  assert.equal(first.multiSelect, false)
  assert.deepEqual(first.options.map((o) => o.label), ['Delete all', 'Let me pick', 'Keep all'])
  assert.match(first.question, /1 branch, 1 remote copy, 0 worktrees/)
  const asked = byId(s, 'asked:0')
  assert.equal(asked.multiSelect, true)
  assert.deepEqual(asked.options.map((o) => o.label).sort(), ['gone', 'old'])
  assert.match(asked.options.find((o) => o.label === 'old').description, /31d/)
  assert.match(asked.options.find((o) => o.label === 'old').description, /local\+remote/)
  assert.match(asked.options.find((o) => o.label === 'gone').description, /local only/)
  assert.match(asked.options.find((o) => o.label === 'gone').description, /remote deleted, not provably merged/)
  // Let me pick → one follow-up multiSelect over the merged set.
  assert.deepEqual(
    s.followups.merged.flat().map((q) => [q.id, q.multiSelect, q.options.map((o) => o.label)]),
    [['merged-pick:0', true, ['done-ff', 'Keep all']]],
  )
})

test('T8.2 overflow is chunked into ≤ 4 options per question and ≤ 4 questions per call, order preserved', (t) => {
  const w = world(t)
  // Nine abandoned branches on one 40-day-old unmerged commit and six local-only ones on one fresh commit: a `git branch` each, not a commit each.
  w.git(w.a, 'checkout', '-b', 'old-1')
  w.commit(w.a, { file: 'old.txt', content: 'old\n', msg: 'old work', daysAgo: 40 })
  for (let i = 2; i <= 9; i++) w.git(w.a, 'branch', `old-${i}`)
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'checkout', '-b', 'new-1')
  w.commit(w.a, { file: 'new.txt', content: 'new\n', msg: 'new work' })
  for (let i = 2; i <= 6; i++) w.git(w.a, 'branch', `new-${i}`)
  w.git(w.a, 'checkout', 'main')
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(w.a, '.gitignore'), `node_modules/\nstash-${n}\n`)
    w.git(w.a, 'stash', 'push')
  }

  const s = surveyOf(w)
  const ids = questions(s).map((q) => q.id)
  assert.deepEqual(ids.slice(0, 5), ['asked:0', 'asked:1', 'asked:2', 'push:0', 'push:1'])
  assert.deepEqual(ids.slice(5).sort(), s.stashes.map((x) => `stash:${x.sha}`).sort())
  assert.deepEqual(['asked:0', 'asked:1', 'asked:2'].map((id) => byId(s, id).options.length), [4, 3, 2]) // R19: never a 1-option chunk
  assert.deepEqual(['push:0', 'push:1'].map((id) => byId(s, id).options.length), [4, 2])
  assert.deepEqual(s.rounds.map((call) => call.length), [4, 3])
  for (const call of s.rounds) assert.ok(call.length <= 4)
  for (const q of questions(s)) {
    assert.ok(q.options.length >= 2 && q.options.length <= 4, q.id)
    assert.ok(q.header.length <= 12, q.header)
  }
  const askedLabels = questions(s).filter((q) => q.id.startsWith('asked:')).flatMap((q) => q.options.map((o) => o.label))
  assert.deepEqual(askedLabels.sort(), Array.from({ length: 9 }, (_, i) => `old-${i + 1}`))
  const pushLabels = questions(s).filter((q) => q.id.startsWith('push:')).flatMap((q) => q.options.map((o) => o.label))
  assert.deepEqual(pushLabels.sort(), Array.from({ length: 6 }, (_, i) => `new-${i + 1}`))
})

// A GitLab remote (downgraded): `solo` is local-only and a stash sits on main.
function gitlabWorld(t) {
  const w = world(t, { host: 'gitlab.com' })
  branch(w, 'solo')
  fs.writeFileSync(path.join(w.a, '.gitignore'), 'node_modules/\nchanged\n')
  w.git(w.a, 'stash', 'push')
  return w
}

test('T8.3 a downgraded repo asks no push question and offers no stash push', (t) => {
  const w = gitlabWorld(t)
  const s = surveyOf(w)
  assert.equal(s.downgraded, true)
  assert.equal(questions(s).some((q) => q.id.startsWith('push:')), false)
  const stash = byId(s, `stash:${s.stashes[0].sha}`)
  assert.equal(stash.header, 'Stash')
  assert.equal(stash.multiSelect, false)
  assert.deepEqual(stash.options.map((o) => o.label), ['Branch, local', 'Drop', 'Keep stash'])
})

// `name` merged into local main (M1 against the local trunk, which phase 6 publishes), pushed, and checked out in its own worktree.
function mergedInWorktree(w, name) {
  const tip = branch(w, name, { push: true })
  w.git(w.a, 'merge', '--ff-only', name)
  w.git(w.a, 'worktree', 'add', path.join(w.root, `wt ${name}`), name)
  return tip
}

test('T8.4 merged: all deletes the clean worktree, then the remote copy, then the local branch', (t) => {
  const w = world(t)
  const tip = mergedInWorktree(w, 'm1')
  const s = surveyOf(w)
  assert.deepEqual(s.mergedSet, ['m1'])
  assert.match(byId(s, 'merged').question, /1 branch, 1 remote copy, 1 worktree/)
  assert.equal(questions(s).some((q) => q.id.startsWith('worktree:')), false) // clean and merged: removed with its branch, never asked

  const result = planCli(w, { merged: 'all' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const merged = { basis: 'merged', proof: 'M1' }
  assert.deepEqual(result.json.actions, [
    { kind: 'remove-worktree', target: realWt(w, 'm1'), expectTip: tip, force: false, expectDirty: 0, ...merged },
    { kind: 'delete-remote', target: 'm1', expectTip: tip, ...merged },
    { kind: 'delete-local', target: 'm1', expectTip: tip, ...merged },
  ])
  const saved = JSON.parse(fs.readFileSync(path.join(w.a, '.git', 'git-sync', 'plan.json'), 'utf8'))
  assert.deepEqual(saved, result.json)
  assert.deepEqual(buildPlan(s, { merged: ['m1'] }), result.json.actions)
  assert.deepEqual(buildPlan(s, { merged: 'none' }), [])
  // R19: the lone merged branch's pick question carries the `Keep all` sentinel, which maps to no names.
  assert.deepEqual(s.followups.merged[0][0].options.map((o) => o.label), ['m1', 'Keep all'])
  assert.deepEqual(buildPlan(s, { merged: ['Keep all'] }), [])
})

test('T8.5 bad-answers: a name, sha or push the survey never offered', (t) => {
  const w = world(t)
  branch(w, 'b-wip', { push: true, dir: w.b }) // T7.3: active, remote-only — the other box's work
  w.git(w.a, 'fetch', 'origin')
  const s = surveyOf(w)
  assert.equal(s.branches.find((b) => b.name === 'b-wip').bucket, 'active')
  assert.throws(() => buildPlan(s, { asked: ['nope'] }), badAnswers)
  assert.throws(() => buildPlan(s, { asked: ['b-wip'] }), badAnswers)
  assert.throws(() => buildPlan(s, { stashes: { ['f'.repeat(40)]: 'drop' } }), badAnswers)
  const result = planCli(w, { asked: ['b-wip'] })
  assert.equal(result.status, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'bad-answers')

  const gl = gitlabWorld(t)
  const gs = surveyOf(gl)
  assert.throws(() => buildPlan(gs, { push: ['solo'] }), badAnswers)
  assert.throws(() => buildPlan(gs, { stashes: { [gs.stashes[0].sha]: 'branch-push' } }), badAnswers)
  assert.deepEqual(buildPlan(gs, { stashes: { [gs.stashes[0].sha]: 'branch-local' } }), [
    { kind: 'stash-branch', target: gs.stashes[0].sha, expectTip: gs.stashes[0].sha, push: false, baseSha: gs.stashes[0].baseSha },
  ])
})

test('T8.6 no answers is an empty plan', (t) => {
  const w = t71World(t)
  const s = surveyOf(w)
  assert.deepEqual(buildPlan(s, {}), [])
  const result = w.cli(w.a, ['plan'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(result.json, { ok: true, cmd: 'plan', actions: [] })

  // `--answers` without a file is a bad argument (usage, nothing on stdout); a plan with no survey to build against stops.
  const bare = w.cli(w.a, ['plan', '--answers'])
  assert.equal(bare.status, 1)
  assert.equal(bare.stdout, '')
  fs.rmSync(path.join(w.a, '.git', 'git-sync', 'survey.json'))
  const unsurveyed = w.cli(w.a, ['plan'])
  assert.equal(unsurveyed.status, 2)
  assert.equal(unsurveyed.json.stop, 'no-survey')
})

test('T8.7 removing a dirty worktree on a merged branch forces it and then deletes the branch', (t) => {
  const w = world(t)
  const tip = mergedInWorktree(w, 'm2')
  fs.writeFileSync(path.join(w.root, 'wt m2', 'm2.txt'), 'changed\n')
  const s = surveyOf(w)
  assert.deepEqual(s.mergedSet, [])
  const q = byId(s, `worktree:${realWt(w, 'm2')}`)
  assert.equal(q.header, 'Worktree')
  assert.deepEqual(q.options.map((o) => o.label), ['Keep', 'Remove'])
  assert.match(q.options[1].description, /1 changed or ignored file will be lost/)

  const result = planCli(w, { worktrees: { [realWt(w, 'm2')]: 'remove' } })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(result.json.actions, [
    { kind: 'remove-worktree', target: realWt(w, 'm2'), expectTip: tip, force: true, expectDirty: 1 },
    { kind: 'delete-remote', target: 'm2', expectTip: tip, basis: 'merged', proof: 'M1' },
    { kind: 'delete-local', target: 'm2', expectTip: tip, basis: 'merged', proof: 'M1' },
  ])
  assert.deepEqual(buildPlan(s, { worktrees: { [realWt(w, 'm2')]: 'keep' } }), [])
})

test('T8.8 answer validation is strict: only what a question offered, in the shape the SKILL layer writes', (t) => {
  const w = t71World(t)
  branch(w, 'solo')
  branch(w, 'lk')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt lk'), 'lk')
  w.git(w.a, 'worktree', 'lock', path.join(w.root, 'wt lk'))
  const s = surveyOf(w)
  // A locked worktree gets no question and so can never be removed.
  assert.equal(byId(s, `worktree:${realWt(w, 'lk')}`), undefined)
  for (const answers of [
    null,
    [],
    'all',
    { bogus: [] },
    { merged: 'some' },
    { merged: ['old'] }, // abandoned, not merged
    { merged: ['done-ff', 'done-ff'] },
    { asked: ['done-ff'] }, // merged, not asked
    { asked: ['open-pr'] }, // protected
    { asked: ['wip'] }, // active
    { asked: ['main'] }, // the trunk
    { asked: ['old', 'old'] },
    { asked: 'old' },
    { asked: [7] },
    { push: ['wip'] }, // in sync with origin, nothing to push
    { push: ['old'] },
    { stashes: [] },
    { worktrees: { [realWt(w, 'lk')]: 'remove' } },
    { worktrees: { '/nowhere': 'remove' } },
    { worktrees: [] },
  ]) {
    assert.throws(() => buildPlan(s, answers), badAnswers, JSON.stringify(answers))
  }

  // A well-formed mix, emitted in §10.9 order whatever order the answers arrive in.
  const rec = (n) => s.branches.find((b) => b.name === n)
  assert.deepEqual(buildPlan(s, { push: ['solo'], asked: ['old', 'gone'], merged: ['done-ff'] }), [
    { kind: 'push-branch', target: 'solo', expectTip: rec('solo').local.sha },
    { kind: 'delete-remote', target: 'done-ff', expectTip: rec('done-ff').remote.sha, basis: 'merged', proof: 'M1' },
    { kind: 'delete-remote', target: 'old', expectTip: rec('old').remote.sha, basis: 'picked' },
    { kind: 'delete-local', target: 'done-ff', expectTip: rec('done-ff').local.sha, basis: 'merged', proof: 'M1' },
    { kind: 'delete-local', target: 'old', expectTip: rec('old').local.sha, basis: 'picked' },
    { kind: 'delete-local', target: 'gone', expectTip: rec('gone').local.sha, basis: 'picked' },
  ])

  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, '{not json')
  const result = w.cli(w.a, ['plan', '--answers', file])
  assert.equal(result.status, 2)
  assert.equal(result.json.stop, 'bad-answers')
})

test('T8.9 rounds skip locked, in-progress and prunable worktrees; a detached or unmerged clean one is asked', () => {
  const wt = (p, extra) => ({ path: p, branch: null, head: 'a'.repeat(40), dirty: 0, locked: false, prunable: false, inProgress: null, ...extra })
  const survey = {
    trunk: 'main',
    downgraded: false,
    branches: [
      { name: 'feat', local: { sha: 'b'.repeat(40), date: 0, upstream: null, gone: false, ahead: 0 }, remote: null, bucket: 'active', proof: null,
        reason: 'recent', unpushed: 'local-only', worktree: '/wt/feat', openPr: null },
    ],
    worktrees: [
      wt('/wt/det'),
      wt('/wt/feat', { branch: 'feat', head: 'b'.repeat(40) }),
      wt('/wt/locked', { locked: true, dirty: 3 }),
      wt('/wt/busy', { inProgress: 'rebase', dirty: 2 }),
      wt('/wt/pruned', { prunable: true }),
    ],
    stashes: [],
    mergedSet: [],
  }
  const { rounds: calls } = rounds(survey)
  const ids = calls.flat().map((q) => q.id)
  assert.deepEqual(ids, ['push:0', 'worktree:/wt/det', 'worktree:/wt/feat'])
  for (const p of ['/wt/busy', '/wt/pruned']) assert.throws(() => buildPlan(survey, { worktrees: { [p]: 'remove' } }), badAnswers)
  assert.deepEqual(buildPlan(survey, { worktrees: { '/wt/feat': 'remove' } }), [
    { kind: 'remove-worktree', target: '/wt/feat', expectTip: 'b'.repeat(40), force: false, expectDirty: 0 },
  ])
})

test('T8.10 a single candidate gets a sentinel second option that maps to no names (R19)', (t) => {
  const w = world(t)
  branch(w, 'stale', { daysAgo: 40 })
  branch(w, 'solo')
  const s = surveyOf(w)
  const asked = byId(s, 'asked:0')
  assert.deepEqual(asked.options.map((o) => o.label), ['stale', 'Keep all'])
  assert.equal(byId(s, 'asked:1'), undefined)
  assert.deepEqual(byId(s, 'push:0').options.map((o) => o.label), ['solo', 'Push none'])
  for (const q of questions(s).concat(s.followups.merged.flat())) assert.ok(q.options.length >= 2 && q.options.length <= 4, q.id)

  assert.deepEqual(buildPlan(s, { asked: ['Keep all'], push: ['Push none'] }), [])
  const tip = s.branches.find((b) => b.name === 'stale').local.sha
  assert.deepEqual(buildPlan(s, { asked: ['Keep all', 'stale'] }), [{ kind: 'delete-local', target: 'stale', expectTip: tip, basis: 'picked' }])
})

test('T8.11 balanced chunks: every split keeps 2–4 options per question in candidate order (R19)', () => {
  const rec = (i) => ({ name: `b-${String(i).padStart(2, '0')}`, local: { sha: 'a'.repeat(40), date: 0, upstream: null, gone: false, ahead: 0 },
    remote: null, bucket: 'abandoned', proof: null, reason: 'old', unpushed: null, worktree: null, openPr: null })
  for (const [n, sizes] of [[2, [2]], [4, [4]], [5, [3, 2]], [6, [4, 2]], [9, [4, 3, 2]], [13, [4, 4, 3, 2]]]) {
    const branches = Array.from({ length: n }, (_, i) => rec(i))
    const qs = rounds({ trunk: 'main', downgraded: false, branches, worktrees: [], stashes: [], mergedSet: [] }).rounds.flat()
    assert.deepEqual(qs.map((q) => q.options.length), sizes, `n=${n}`)
    assert.deepEqual(qs.flatMap((q) => q.options.map((o) => o.label)), branches.map((b) => b.name), `n=${n}`)
  }
})
