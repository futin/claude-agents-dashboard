// End-to-end runs of the whole skill flow (Task 14), every phase through the CLI in SKILL.md's order, with the one step the model owns — writing the
// commit message and running `git commit -F` on it — done here exactly as SKILL.md tells the model to. T14.4 is one world holding one of each thing
// the flow acts on; T14.5 runs the same flow again on the result and proves a second run on a tidy repo changes nothing (§10.10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { world } from './world.mjs'

// A new branch off a's current HEAD with one commit, optionally pushed with an upstream, then back to `main` (plan.test.mjs's shape).
function branch(w, name, { push = false, daysAgo } = {}) {
  w.git(w.a, 'checkout', '-b', name)
  const tip = w.commit(w.a, { file: `${name}.txt`, content: `${name}\n`, msg: `work on ${name}`, daysAgo })
  if (push) w.git(w.a, 'push', '-u', 'origin', name)
  w.git(w.a, 'checkout', 'main')
  return tip
}

// The T14.4 world. On a: `old` pushed and 31 days stale; `solo` never pushed; `m1` pushed, fast-forwarded into a's local main (unpushed, so sync
// rebases it onto b's commit and survey has to prove it M2 against the local trunk) and checked out in its own clean worktree; one `-u` stash on
// main; `node_modules/` present; and a checked out on `feat` with an untracked file. On b: one commit to main, pushed, carrying the `package.json`
// whose `test` script verify runs against the npm stub.
function setup(t) {
  const w = world(t)
  branch(w, 'old', { push: true, daysAgo: 31 })
  branch(w, 'solo')
  branch(w, 'm1', { push: true })
  w.git(w.a, 'merge', '--ff-only', 'm1')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt m1'), 'm1')
  fs.writeFileSync(path.join(w.a, 'wip.txt'), 'stashed work\n')
  w.git(w.a, 'stash', 'push', '-u')
  const stashSha = w.git(w.a, 'rev-parse', 'stash@{0}')
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.git(w.a, 'checkout', '-b', 'feat')
  fs.writeFileSync(path.join(w.a, 'feat.txt'), 'uncommitted feature work\n')

  const bSha = w.commit(w.b, { file: 'package.json', content: `${JSON.stringify({ scripts: { test: 'x' } })}\n`, msg: 'add package.json' })
  w.git(w.b, 'push', 'origin', 'main')
  w.stub('npm', { stdout: 'ok\n' })
  return { w, stashSha, bSha }
}

function step(w, args) {
  const result = w.cli(w.a, args)
  assert.equal(result.status, 0, `${args[0]}: ${result.stdout}${result.stderr}`)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.cmd, args[0])
  return result.json
}

// SKILL.md's phases 0–8 in order. Phase 1's commit is the model's: only when stage-scan left something staged, a message file in the state dir and
// `git commit -F` on it. Phase 4's answers go to answers.json in the state dir, which preflight's reset has already cleared of any earlier run's.
function run(w, answers) {
  const out = {}
  out.preflight = step(w, ['preflight'])
  out.stageScan = step(w, ['stage-scan'])
  if (!out.stageScan.clean) {
    const msgFile = path.join(out.preflight.stateDir, 'commit-msg.txt')
    fs.writeFileSync(msgFile, `feat: ${out.stageScan.staged.join(', ')}\n`)
    w.git(w.a, 'commit', '-F', msgFile)
  }
  out.sync = step(w, ['sync'])
  out.survey = step(w, ['survey'])
  const answersFile = path.join(out.preflight.stateDir, 'answers.json')
  fs.writeFileSync(answersFile, JSON.stringify(answers))
  out.plan = step(w, ['plan', '--answers', answersFile])
  out.verify = step(w, ['verify'])
  out.pushTrunk = step(w, ['push-trunk'])
  out.apply = step(w, ['apply'])
  out.report = step(w, ['report'])
  return out
}

const lines = (s) => s.split('\n').filter(Boolean)
const refs = (w, dir) => lines(w.git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'))
const originHas = (w, name) => refs(w, w.origin).some((l) => l.startsWith(`refs/heads/${name} `))
const localHas = (w, name) => refs(w, w.a).some((l) => l.startsWith(`refs/heads/${name} `))

function firstRun(t) {
  const { w, stashSha, bSha } = setup(t)
  const out = run(w, { merged: 'all', asked: ['old'], push: ['solo', 'feat'], stashes: { [stashSha]: 'branch-local' } })
  return { w, stashSha, bSha, out }
}

test('T14.4 end to end: commit, sync, survey, plan, verify, push-trunk, apply, report on one world', (t) => {
  const { w, stashSha, bSha, out } = firstRun(t)

  assert.equal(out.preflight.startBranch, 'feat')
  assert.equal(out.preflight.dirty, true)
  assert.deepEqual(out.stageScan.staged, ['feat.txt'])
  assert.equal(out.sync.switchedFrom, 'feat')
  assert.equal(out.sync.pulled, 1)
  assert.deepEqual(out.survey.mergedSet, ['m1'])
  assert.deepEqual(out.survey.stashes.map((s) => s.sha), [stashSha])
  assert.equal(out.verify.status, 'green')
  assert.equal(out.pushTrunk.pushed, true)
  assert.ok(out.apply.results.every((r) => r.status === 'done'), JSON.stringify(out.apply.results))

  // a is on the trunk, level with origin, and the trunk holds b's commit.
  assert.equal(w.git(w.a, 'symbolic-ref', '--short', 'HEAD'), 'main')
  const mainSha = w.git(w.a, 'rev-parse', 'refs/heads/main')
  assert.equal(w.git(w.a, 'rev-parse', 'refs/remotes/origin/main'), mainSha)
  assert.equal(w.git(w.origin, 'rev-parse', 'refs/heads/main'), mainSha)
  w.git(w.a, 'merge-base', '--is-ancestor', bSha, mainSha)

  for (const name of ['m1', 'old']) {
    assert.ok(!localHas(w, name), `${name} still local`)
    assert.ok(!originHas(w, name), `${name} still on origin`)
  }
  for (const name of ['solo', 'feat']) assert.ok(originHas(w, name), `${name} not on origin`)
  const stashBranches = lines(w.git(w.a, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/stash/'))
  assert.equal(stashBranches.length, 1)
  assert.match(stashBranches[0], /^stash\/main-\d{8}$/)
  assert.equal(w.git(w.a, 'stash', 'list'), '')
  assert.equal(lines(w.git(w.a, 'worktree', 'list', '--porcelain')).filter((l) => l.startsWith('worktree ')).length, 1)

  assert.doesNotMatch(out.report.markdown, /Stopped at/)
  assert.match(out.report.markdown, /## Deleted/)
})

test('T14.5 idempotence: a second run on the result changes nothing', (t) => {
  const { w } = firstRun(t)
  const snapshot = () => ({
    refs: refs(w, w.a),
    stashes: w.git(w.a, 'stash', 'list'),
    worktrees: w.git(w.a, 'worktree', 'list', '--porcelain'),
    origin: refs(w, w.origin),
  })
  const before = snapshot()

  const out = run(w, {})
  assert.equal(out.stageScan.clean, true)
  assert.equal(out.sync.pulled, 0)
  assert.equal(out.pushTrunk.pushed, false)
  assert.equal(out.pushTrunk.reason, 'nothing-to-push')

  // One question left: pushing the local-only stash branch the first run made. R19 pads a lone candidate with its `Push none` sentinel, so the only
  // real option is that branch.
  const questions = out.survey.rounds.flat()
  assert.deepEqual(questions.map((q) => q.id), ['push:0'])
  const [stashBranch] = lines(w.git(w.a, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/stash/'))
  assert.deepEqual(questions[0].options.map((o) => o.label), [stashBranch, 'Push none'])
  assert.equal(out.survey.branches.find((b) => b.name === stashBranch).unpushed, 'local-only')
  assert.deepEqual(out.survey.followups.merged, [])

  assert.deepEqual(out.plan.actions, [])
  assert.deepEqual(out.apply.results, [])
  assert.deepEqual(snapshot(), before)
})
