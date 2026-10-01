// Tests for `apply` (design.md §10): plan.json's actions carried out in §10.9 order, each one re-checked against the live repo first — a worktree's
// HEAD and dirt, a branch's tip, a merged deletion's proof against `origin/<trunk>` (R16, Review Focus 2) — with remote deletions behind a lease and
// every deletion recorded in deleted.log. The worlds run the real phase order through the CLI (survey → plan → verify → push-trunk → apply), so a
// plan here is exactly what SKILL.md would hand over; hand-written plans (`--plan`) cover what no survey would ever offer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { world } from './world.mjs'

// Same shape as plan.test.mjs's helper: a new branch off `main` with one commit, optionally pushed with an upstream, then back to `main`.
function branch(w, name, { push = false, dir = w.a, daysAgo } = {}) {
  w.git(dir, 'checkout', '-b', name)
  const tip = w.commit(dir, { file: `${name}.txt`, content: `${name}\n`, msg: `work on ${name}`, daysAgo })
  if (push) w.git(dir, 'push', '-u', 'origin', name)
  w.git(dir, 'checkout', 'main')
  return tip
}

// The other box's own `name`, pushed first: a different file, so its commit can never collide with a's same-second one of the same content.
function theirBranch(w, name) {
  w.git(w.b, 'checkout', '-b', name)
  const tip = w.commit(w.b, { file: `${name}-theirs.txt`, content: 'theirs\n', msg: `their ${name}` })
  w.git(w.b, 'push', '-u', 'origin', name)
  return tip
}

// T8.4's world: `name` pushed, fast-forwarded into a's local main (not yet pushed — phase 6 does that) and checked out in its own clean worktree.
function mergedInWorktree(w, name) {
  const tip = branch(w, name, { push: true })
  w.git(w.a, 'merge', '--ff-only', name)
  w.git(w.a, 'worktree', 'add', path.join(w.root, `wt ${name}`), name)
  return tip
}

function surveyOf(w) {
  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

function planCli(w, answers) {
  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, JSON.stringify(answers))
  const result = w.cli(w.a, ['plan', '--answers', file])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json.actions
}

// Phases 5 and 6 as the skill runs them. With no discoverable checks verify is `unverified`, which push-trunk still publishes (§10.6).
function publishTrunk(w) {
  assert.equal(w.cli(w.a, ['verify']).status, 0)
  const pushed = w.cli(w.a, ['push-trunk'])
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr)
  return pushed.json
}

// `apply` from plan.json, or from a hand-written action list written to a `--plan` file under the world root (whose path holds a space).
function applyCli(w, actions) {
  const args = ['apply']
  if (actions !== undefined) {
    const file = path.join(w.root, 'hand plan.json')
    fs.writeFileSync(file, JSON.stringify({ actions }))
    args.push('--plan', file)
  }
  return w.cli(w.a, args)
}

function applied(w, actions) {
  const result = applyCli(w, actions)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.cmd, 'apply')
  return result.json
}

// [kind, status, reason] per result, the shape most assertions care about; `detail` (git's stderr on a failure) is checked where it matters.
const outcomes = (json) => json.results.map((r) => [r.kind, r.status, r.reason])
const byTarget = (json, kind, target) => json.results.find((r) => r.kind === kind && r.target === target)
// A ref's sha in `dir`, or '' when it doesn't exist — `for-each-ref` prints nothing for a missing ref instead of failing like rev-parse.
const tipOf = (w, dir, ref) => w.git(dir, 'for-each-ref', '--format=%(objectname)', ref)
const localTip = (w, name) => tipOf(w, w.a, `refs/heads/${name}`)
const originTip = (w, name) => tipOf(w, w.origin, `refs/heads/${name}`)
const realWt = (w, name) => path.join(fs.realpathSync(w.root), `wt ${name}`)
const logFile = (w) => path.join(w.a, '.git', 'git-sync', 'deleted.log')
const logLines = (w) => (fs.existsSync(logFile(w)) ? fs.readFileSync(logFile(w), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [])

test('T11.1 T8.4 plan: the worktree, the remote copy and the local branch all go, and deleted.log records both deletions', (t) => {
  const w = world(t)
  const tip = mergedInWorktree(w, 'm1')
  surveyOf(w)
  planCli(w, { merged: 'all' })
  assert.equal(publishTrunk(w).pushed, true)

  const json = applied(w)
  assert.deepEqual(json.pruned, [])
  assert.deepEqual(outcomes(json), [
    ['remove-worktree', 'done', null],
    ['delete-remote', 'done', null],
    ['delete-local', 'done', null],
  ])
  assert.deepEqual(json.results.map((r) => r.target), [realWt(w, 'm1'), 'm1', 'm1'])
  assert.equal(localTip(w, 'm1'), '')
  assert.equal(originTip(w, 'm1'), '')
  assert.equal(tipOf(w, w.a, 'refs/remotes/origin/m1'), '')
  assert.equal(fs.existsSync(realWt(w, 'm1')), false)
  const saved = JSON.parse(fs.readFileSync(path.join(w.a, '.git', 'git-sync', 'apply.json'), 'utf8'))
  assert.deepEqual(saved, json)

  const lines = logLines(w)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => l.slice(1)), [
    [os.hostname(), 'm1', 'remote', tip],
    [os.hostname(), 'm1', 'local', tip],
  ])
  for (const [when] of lines) assert.equal(new Date(when).toISOString(), when)

  // §10.10: a second run on the now-tidy repo changes nothing, and deleted.log is only ever appended to.
  const again = applied(w)
  assert.deepEqual(outcomes(again), [
    ['remove-worktree', 'skipped', 'worktree-gone'],
    ['delete-remote', 'skipped', 'lease-failed'],
    ['delete-local', 'skipped', 'branch-gone'],
  ])
  assert.equal(logLines(w).length, 2)
})

// `name` pushed and fast-forwarded into a's local main, with no worktree — the survey offers it merged, the plan deletes both copies.
function mergedBranch(t, name) {
  const w = world(t)
  const tip = branch(w, name, { push: true })
  w.git(w.a, 'merge', '--ff-only', name)
  surveyOf(w)
  assert.deepEqual(planCli(w, { merged: 'all' }).map((a) => a.kind), ['delete-remote', 'delete-local'])
  assert.equal(publishTrunk(w).pushed, true)
  return { w, tip }
}

test('T11.2 a commit on the branch after the survey keeps the local branch', (t) => {
  const { w, tip } = mergedBranch(t, 'm1')
  w.git(w.a, 'checkout', 'm1')
  const moved = w.commit(w.a, { file: 'later.txt', content: 'later\n', msg: 'later work' })
  w.git(w.a, 'checkout', 'main')

  const json = applied(w)
  assert.deepEqual(outcomes(json), [
    ['delete-remote', 'done', null],
    ['delete-local', 'skipped', 'tip-moved'],
  ])
  assert.equal(localTip(w, 'm1'), moved)
  assert.deepEqual(logLines(w).map((l) => l.slice(2)), [['m1', 'remote', tip]])
})

test('T11.3 the other box pushing to the branch after the survey fails the lease, and its commit stays on origin', (t) => {
  const { w } = mergedBranch(t, 'm1')
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'm1', 'origin/m1')
  const theirs = w.commit(w.b, { file: 'theirs.txt', content: 'theirs\n', msg: 'more from b' })
  w.git(w.b, 'push', 'origin', 'm1')

  const json = applied(w)
  assert.deepEqual(byTarget(json, 'delete-remote', 'm1'), { kind: 'delete-remote', target: 'm1', status: 'skipped', reason: 'lease-failed' })
  assert.equal(originTip(w, 'm1'), theirs)
  assert.equal(logLines(w).some((l) => l[3] === 'remote'), false)
})

test('T11.4 a hand-written merged deletion of an unmerged branch is refused', (t) => {
  const w = world(t)
  const tip = branch(w, 'wip', { push: true })
  const json = applied(w, [
    { kind: 'delete-remote', target: 'wip', expectTip: tip, basis: 'merged', proof: 'M1' },
    { kind: 'delete-local', target: 'wip', expectTip: tip, basis: 'merged', proof: 'M1' },
  ])
  assert.deepEqual(outcomes(json), [
    ['delete-remote', 'skipped', 'not-merged-on-origin'],
    ['delete-local', 'skipped', 'not-merged-on-origin'],
  ])
  assert.equal(localTip(w, 'wip'), tip)
  assert.equal(originTip(w, 'wip'), tip)
  assert.deepEqual(logLines(w), [])
})

test('T11.4b plan-file refusals: no plan, a bad --plan, a malformed action', (t) => {
  const w = world(t)
  const none = applyCli(w)
  assert.equal(none.status, 2)
  assert.equal(none.json.stop, 'no-plan')

  const bare = w.cli(w.a, ['apply', '--plan'])
  assert.equal(bare.status, 1)
  assert.equal(bare.stdout, '')
  const misplaced = w.cli(w.a, ['survey', '--plan', path.join(w.root, 'x.json')])
  assert.equal(misplaced.status, 1)
  assert.equal(misplaced.stdout, '')

  const missing = w.cli(w.a, ['apply', '--plan', path.join(w.root, 'nope.json')])
  assert.equal(missing.status, 2)
  assert.equal(missing.json.stop, 'bad-plan')

  // Each is refused before anything runs: an unknown kind, a deletion with no basis, a tip that is a ref name rather than a sha (a lease on `main`
  // would resolve it locally), and a name no ref can have (a `:` would split the refspec).
  const tip = branch(w, 'wip')
  for (const action of [
    { kind: 'rename-branch', target: 'wip', expectTip: tip },
    { kind: 'delete-local', target: 'wip', expectTip: tip },
    { kind: 'delete-remote', target: 'wip', expectTip: 'main', basis: 'picked' },
    { kind: 'push-branch', target: 'wip:refs/heads/main', expectTip: tip },
  ]) {
    const refused = applyCli(w, [action])
    assert.equal(refused.status, 2, JSON.stringify(action))
    assert.equal(refused.json.stop, 'bad-plan')
  }
  assert.equal(localTip(w, 'wip'), tip)
})

test('T11.5 a branch checked out in a kept worktree, the trunk and the current HEAD are never deleted, and the trunk never pushed (R23)', (t) => {
  const w = world(t)
  const kept = branch(w, 'kept')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt kept'), 'kept')
  // An unverified trunk commit: push-branch must not become a way round push-trunk's verify gate (§10.6).
  const main = w.commit(w.a, { file: 'unverified.txt', content: 'x\n', msg: 'unverified trunk work' })
  const originMain = originTip(w, 'main')
  const cur = branch(w, 'cur')
  w.git(w.a, 'checkout', 'cur')

  const json = applied(w, [
    { kind: 'delete-local', target: 'kept', expectTip: kept, basis: 'picked' },
    { kind: 'delete-local', target: 'main', expectTip: main, basis: 'picked' },
    { kind: 'delete-local', target: 'cur', expectTip: cur, basis: 'picked' },
    { kind: 'delete-remote', target: 'main', expectTip: originMain, basis: 'merged', proof: 'M1' },
    { kind: 'push-branch', target: 'main', expectTip: main },
  ])
  assert.deepEqual(outcomes(json), [
    ['push-branch', 'skipped', 'protected'],
    ['delete-remote', 'skipped', 'protected'],
    ['delete-local', 'skipped', 'checked-out-in-worktree'],
    ['delete-local', 'skipped', 'protected'],
    ['delete-local', 'skipped', 'protected'],
  ])
  for (const [name, sha] of [['kept', kept], ['main', main], ['cur', cur]]) assert.equal(localTip(w, name), sha)
  assert.equal(originTip(w, 'main'), originMain)
})

test('T11.6 push-branch sets the upstream; a divergent push from the other box first is a rejection', (t) => {
  const w = world(t)
  const tip = branch(w, 'solo')
  surveyOf(w)
  planCli(w, { push: ['solo'] })
  const json = applied(w)
  assert.deepEqual(outcomes(json), [['push-branch', 'done', null]])
  assert.equal(originTip(w, 'solo'), tip)
  assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', 'solo@{upstream}'), 'origin/solo')

  const w2 = world(t)
  branch(w2, 'solo')
  const theirs = theirBranch(w2, 'solo')
  surveyOf(w2)
  planCli(w2, { push: ['solo'] })
  const rejected = applied(w2)
  assert.deepEqual(outcomes(rejected), [['push-branch', 'failed', 'rejected']])
  assert.match(rejected.results[0].detail, /rejected|fetch first|non-fast-forward/)
  assert.equal(originTip(w2, 'solo'), theirs)
})

test('T11.7 remove-worktree: a locked one stays, a dirty one goes with force, one changed since the survey stays', (t) => {
  const w = world(t)
  branch(w, 'lk')
  branch(w, 'wip1')
  branch(w, 'wip2')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt lk'), 'lk')
  w.git(w.a, 'worktree', 'lock', path.join(w.root, 'wt lk'))
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt wip1'), 'wip1')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt wip2'), 'wip2')
  fs.writeFileSync(path.join(realWt(w, 'wip1'), 'wip1.txt'), 'edited\n')
  fs.writeFileSync(path.join(realWt(w, 'wip2'), 'wip2.txt'), 'edited\n')

  surveyOf(w)
  const actions = planCli(w, { worktrees: { [realWt(w, 'wip1')]: 'remove', [realWt(w, 'wip2')]: 'remove' } })
  assert.deepEqual(actions.map((a) => [a.force, a.expectDirty]), [[true, 1], [true, 1]])
  fs.writeFileSync(path.join(realWt(w, 'wip2'), 'second.txt'), 'new\n')
  const lkHead = w.git(realWt(w, 'lk'), 'rev-parse', 'HEAD')
  actions.push({ kind: 'remove-worktree', target: realWt(w, 'lk'), expectTip: lkHead, force: false, expectDirty: 0 })

  const json = applied(w, actions)
  assert.equal(byTarget(json, 'remove-worktree', realWt(w, 'wip1')).status, 'done')
  assert.equal(fs.existsSync(realWt(w, 'wip1')), false)
  assert.equal(byTarget(json, 'remove-worktree', realWt(w, 'wip2')).reason, 'worktree-changed')
  assert.equal(fs.existsSync(path.join(realWt(w, 'wip2'), 'second.txt')), true)
  assert.equal(byTarget(json, 'remove-worktree', realWt(w, 'lk')).reason, 'locked')
  assert.equal(fs.existsSync(realWt(w, 'lk')), true)
  // A worktree removal never takes an unmerged branch with it.
  assert.notEqual(localTip(w, 'wip1'), '')
})

test('T11.8 one failed action does not stop the rest', (t) => {
  const w = world(t)
  const solo = branch(w, 'solo')
  theirBranch(w, 'solo')
  const old = branch(w, 'old')
  const stash = 'f'.repeat(40)
  const json = applied(w, [
    { kind: 'push-branch', target: 'solo', expectTip: solo },
    { kind: 'delete-local', target: 'old', expectTip: old, basis: 'picked' },
    { kind: 'stash-drop', target: stash, expectTip: stash },
  ])
  assert.deepEqual(outcomes(json), [
    ['stash-drop', 'skipped', 'stash-gone'],
    ['push-branch', 'failed', 'rejected'],
    ['delete-local', 'done', null],
  ])
  assert.equal(localTip(w, 'old'), '')
  assert.deepEqual(logLines(w).map((l) => l.slice(2)), [['old', 'local', old]])
})

test('T11.9 actions run in §10.9 order whatever order the plan lists them in', (t) => {
  const w = world(t)
  mergedInWorktree(w, 'm1')
  surveyOf(w)
  const actions = planCli(w, { merged: 'all' })
  publishTrunk(w)
  const json = applied(w, [...actions].reverse())
  assert.deepEqual(outcomes(json), [
    ['remove-worktree', 'done', null],
    ['delete-remote', 'done', null],
    ['delete-local', 'done', null],
  ])
})

test('T11.10 a worktree directory removed by hand is pruned before any deletion (R20)', (t) => {
  const w = world(t)
  const tip = branch(w, 'x')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt x'), 'x')
  fs.rmSync(realWt(w, 'x'), { recursive: true, force: true })

  // The branch the vanished worktree held is deletable only because the prune ran first; before it, git still counts it checked out there.
  const json = applied(w, [{ kind: 'delete-local', target: 'x', expectTip: tip, basis: 'picked' }])
  assert.deepEqual(json.pruned, [realWt(w, 'x')])
  assert.equal(w.git(w.a, 'worktree', 'list', '--porcelain').includes('wt x'), false)
  assert.deepEqual(outcomes(json), [['delete-local', 'done', null]])
})

test('T11.11 a downgraded repo never pushes or deletes a remote branch', (t) => {
  const w = world(t, { host: 'gitlab.com' })
  const x = branch(w, 'x', { push: true })
  const solo = branch(w, 'solo')
  const before = w.git(w.origin, 'for-each-ref')
  const json = applied(w, [
    { kind: 'delete-remote', target: 'x', expectTip: x, basis: 'picked' },
    { kind: 'push-branch', target: 'solo', expectTip: solo },
  ])
  assert.deepEqual(outcomes(json), [
    ['push-branch', 'skipped', 'downgraded'],
    ['delete-remote', 'skipped', 'downgraded'],
  ])
  assert.equal(w.git(w.origin, 'for-each-ref'), before)
})

// Review Focus 2: `m1` merged with --no-ff into a's local main only. The survey proves it against that local trunk (phase 6 will publish it) and
// offers it; whether apply may delete it depends on whether phase 6 actually did.
function mergedLocallyOnly(t, checks) {
  const w = world(t)
  const tip = branch(w, 'm1', { push: true })
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge m1', 'm1')
  fs.writeFileSync(path.join(w.a, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', checks === 'red' ? { stdout: 'ok\n', byArgs: { 'run test': { exit: 1, stderr: 'boom\n' } } } : { stdout: 'ok\n' })
  const s = surveyOf(w)
  assert.equal(s.branches.find((b) => b.name === 'm1').bucket, 'merged')
  assert.deepEqual(planCli(w, { merged: 'all' }).map((a) => a.kind), ['delete-remote', 'delete-local'])
  assert.equal(w.cli(w.a, ['verify']).json.status, checks)
  return { w, tip, pushed: w.cli(w.a, ['push-trunk']).json }
}

test('T11.12 a branch merged only into an unpublished trunk is not deleted; once the trunk is published it is', (t) => {
  const red = mergedLocallyOnly(t, 'red')
  assert.equal(red.pushed.reason, 'red')
  const refused = applied(red.w)
  assert.deepEqual(outcomes(refused), [
    ['delete-remote', 'skipped', 'not-merged-on-origin'],
    ['delete-local', 'skipped', 'not-merged-on-origin'],
  ])
  assert.equal(localTip(red.w, 'm1'), red.tip)
  assert.equal(originTip(red.w, 'm1'), red.tip)
  assert.deepEqual(logLines(red.w), [])

  const green = mergedLocallyOnly(t, 'green')
  assert.equal(green.pushed.pushed, true)
  assert.deepEqual(outcomes(applied(green.w)), [
    ['delete-remote', 'done', null],
    ['delete-local', 'done', null],
  ])
  assert.equal(localTip(green.w, 'm1'), '')
  assert.equal(originTip(green.w, 'm1'), '')
})

test('T11.13 an M4 deletion is re-proved by the PR lookup; anything but merged-at-tip keeps the branch', (t) => {
  const w = world(t)
  const tip = branch(w, 'sq')
  const action = { kind: 'delete-local', target: 'sq', expectTip: tip, basis: 'merged', proof: 'M4' }
  w.stub('gh', { stdout: `${JSON.stringify([{ number: 4, state: 'OPEN', headRefOid: tip, baseRefName: 'main' }])}\n` })
  assert.deepEqual(outcomes(applied(w, [action])), [['delete-local', 'skipped', 'not-merged-on-origin']])
  // Recorded as M1, the same merged PR proves nothing: only a recorded M4 may lean on it.
  w.stub('gh', { stdout: `${JSON.stringify([{ number: 4, state: 'MERGED', headRefOid: tip, baseRefName: 'main' }])}\n` })
  assert.deepEqual(outcomes(applied(w, [{ ...action, proof: 'M1' }])), [['delete-local', 'skipped', 'not-merged-on-origin']])
  assert.deepEqual(outcomes(applied(w, [action])), [['delete-local', 'done', null]])
  assert.equal(localTip(w, 'sq'), '')
})

test('T11.14 R16: the local and remote tips are proved independently, each against origin/<trunk>', (t) => {
  const w = world(t)
  // x: the local tip is merged into origin main, the other box then pushed one more commit onto origin/x.
  const xLocal = branch(w, 'x', { push: true })
  // y: the remote tip is merged into origin main, this box then committed once more onto local y.
  const yRemote = branch(w, 'y', { push: true })
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge x and y', 'x', 'y')
  w.git(w.a, 'push', 'origin', 'main')
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'x', 'origin/x')
  const xRemote = w.commit(w.b, { file: 'x-more.txt', content: 'more\n', msg: 'more x from b' })
  w.git(w.b, 'push', 'origin', 'x')
  w.git(w.a, 'fetch', 'origin')
  w.git(w.a, 'checkout', 'y')
  const yLocal = w.commit(w.a, { file: 'y-more.txt', content: 'more\n', msg: 'more y here' })
  w.git(w.a, 'checkout', 'main')

  const merged = { basis: 'merged', proof: 'M1' }
  const json = applied(w, [
    { kind: 'delete-remote', target: 'x', expectTip: xRemote, ...merged },
    { kind: 'delete-local', target: 'x', expectTip: xLocal, ...merged },
    { kind: 'delete-remote', target: 'y', expectTip: yRemote, ...merged },
    { kind: 'delete-local', target: 'y', expectTip: yLocal, ...merged },
  ])
  assert.deepEqual(json.results.map((r) => [r.kind, r.target, r.status, r.reason]), [
    ['delete-remote', 'x', 'skipped', 'not-merged-on-origin'],
    ['delete-remote', 'y', 'done', null],
    ['delete-local', 'x', 'done', null],
    ['delete-local', 'y', 'skipped', 'not-merged-on-origin'],
  ])
  assert.equal(originTip(w, 'x'), xRemote)
  assert.equal(originTip(w, 'y'), '')
  assert.equal(localTip(w, 'x'), '')
  assert.equal(localTip(w, 'y'), yLocal)
})

test('T11.15 the remaining skip reasons: head-moved, a dirty tree without force, a push whose branch moved or vanished', (t) => {
  const w = world(t)
  branch(w, 'h')
  branch(w, 'd')
  const p = branch(w, 'p')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt h'), 'h')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt d'), 'd')
  fs.writeFileSync(path.join(realWt(w, 'd'), 'd.txt'), 'edited\n')
  const main = localTip(w, 'main')
  const dHead = w.git(realWt(w, 'd'), 'rev-parse', 'HEAD')

  const json = applied(w, [
    { kind: 'remove-worktree', target: realWt(w, 'h'), expectTip: main, force: false, expectDirty: 0 },
    { kind: 'remove-worktree', target: realWt(w, 'd'), expectTip: dHead, force: false, expectDirty: 1 },
    { kind: 'push-branch', target: 'p', expectTip: main },
    { kind: 'push-branch', target: 'nope', expectTip: main },
  ])
  assert.deepEqual(outcomes(json), [
    ['remove-worktree', 'skipped', 'head-moved'],
    ['remove-worktree', 'failed', 'git-failed'],
    ['push-branch', 'skipped', 'tip-moved'],
    ['push-branch', 'skipped', 'branch-gone'],
  ])
  assert.match(json.results[1].detail, /modified or untracked|--force/)
  assert.equal(fs.readFileSync(path.join(realWt(w, 'd'), 'd.txt'), 'utf8'), 'edited\n')
  assert.equal(fs.existsSync(realWt(w, 'h')), true)
  assert.equal(originTip(w, 'p'), '')
  assert.equal(localTip(w, 'p'), p)
})

// Leaves `dir` mid-rebase of `name` onto main, stopped on a conflict in `clash.txt`: HEAD reads detached, but git still holds `name` there.
function conflictedRebase(w, dir, name) {
  w.git(dir, 'checkout', name)
  w.commit(dir, { file: 'clash.txt', content: `${name}\n`, msg: `clash on ${name}` })
  assert.throws(() => w.git(dir, 'rebase', 'main'))
  assert.equal(fs.existsSync(path.join(w.git(dir, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')), true)
}

test('T11.16 a branch mid-rebase is protected in the main tree, and a worktree mid-rebase is never removed (R18)', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'clash.txt', content: 'main\n', msg: 'clash on main' })
  branch(w, 'r1')
  branch(w, 'r2')
  w.git(w.a, 'reset', '--hard', 'HEAD~1')
  w.git(w.a, 'branch', '-f', 'r1', 'main')
  w.git(w.a, 'branch', '-f', 'r2', 'main')
  w.git(w.a, 'reset', '--hard', 'ORIG_HEAD')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt r2'), 'r2')
  conflictedRebase(w, realWt(w, 'r2'), 'r2')
  conflictedRebase(w, w.a, 'r1')
  const r1 = localTip(w, 'r1')
  const wt = realWt(w, 'r2')
  const wtHead = w.git(wt, 'rev-parse', 'HEAD')
  const listed = w.cli(w.a, ['survey']).json.worktrees.find((x) => x.path === wt)
  assert.equal(listed.inProgress, 'rebase')

  const json = applied(w, [
    { kind: 'remove-worktree', target: wt, expectTip: wtHead, force: true, expectDirty: listed.dirty },
    { kind: 'delete-local', target: 'r1', expectTip: r1, basis: 'picked' },
  ])
  assert.deepEqual(outcomes(json), [
    ['remove-worktree', 'skipped', 'in-progress'],
    ['delete-local', 'skipped', 'protected'],
  ])
  assert.equal(fs.existsSync(wt), true)
  assert.equal(localTip(w, 'r1'), r1)
})

test('T11.17 R28: a truncated plan.json is a bad-state stop, not a crash', (t) => {
  const w = world(t)
  mergedInWorktree(w, 'm1')
  surveyOf(w)
  planCli(w, { merged: 'all' })
  const file = path.join(w.a, '.git', 'git-sync', 'plan.json')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 5))

  const result = w.cli(w.a, ['apply'])
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.cmd, 'apply')
  assert.equal(result.json.stop, 'bad-state')
  assert.equal(fs.realpathSync(result.json.detail.file), fs.realpathSync(file))
})

// R36 (final review I2): once the plan is loaded, apply.json is written on every way out, so the report can always print a recovery line for a
// deletion that already happened. The failures are forced with fixture state only: a detached HEAD whose `rebase-merge/head-name` is a directory
// makes `heldBranch`'s read throw EISDIR, a plain (non-git) error, exactly where delete-local asks what this tree holds.
function eisdirAt(gitDir) {
  fs.mkdirSync(path.join(gitDir, 'rebase-merge', 'head-name'), { recursive: true })
}

const applyStateOf = (w) => JSON.parse(fs.readFileSync(path.join(w.a, '.git', 'git-sync', 'apply.json'), 'utf8'))

test('T11.18 a non-git error after one deletion is failed/internal, and the deletion keeps its recovery line (R36)', (t) => {
  const w = world(t)
  const tip = branch(w, 'gone', { push: true })
  surveyOf(w)
  w.git(w.a, 'checkout', '--detach')
  eisdirAt(path.join(w.a, '.git'))

  const json = applied(w, [
    { kind: 'delete-remote', target: 'gone', expectTip: tip, basis: 'picked' },
    { kind: 'delete-local', target: 'gone', expectTip: tip, basis: 'picked' },
  ])
  assert.deepEqual(outcomes(json), [
    ['delete-remote', 'done', null],
    ['delete-local', 'failed', 'internal'],
  ])
  assert.match(byTarget(json, 'delete-local', 'gone').detail, /EISDIR/)
  assert.equal(applyStateOf(w).results[0].sha, tip)
  assert.equal(originTip(w, 'gone'), '')
  assert.equal(localTip(w, 'gone'), tip)

  const report = w.cli(w.a, ['report'])
  assert.equal(report.status, 0, report.stdout + report.stderr)
  assert.ok(report.json.markdown.includes(`git push origin ${tip}:refs/heads/gone`), report.json.markdown)
  assert.match(report.json.markdown, /internal \(/)
})

test('T11.19 a deleted.log that cannot be written does not turn a done deletion into a lost one (R36)', (t) => {
  const w = world(t)
  const tip = branch(w, 'old')
  fs.mkdirSync(logFile(w), { recursive: true })

  const json = applied(w, [{ kind: 'delete-local', target: 'old', expectTip: tip, basis: 'picked' }])
  assert.deepEqual(outcomes(json), [['delete-local', 'done', null]])
  assert.equal(byTarget(json, 'delete-local', 'old').sha, tip)
  assert.equal(localTip(w, 'old'), '')
  assert.ok(json.warnings.some((line) => line.startsWith('deleted.log not written')), JSON.stringify(json.warnings))
})

test('T11.20 a failing worktree prune is a warning, and the actions still run (R36)', (t) => {
  const w = world(t)
  const tip = branch(w, 'old')
  const binDir = path.join(w.root, 'failing-git')
  fs.mkdirSync(binDir)
  const realGit = fs.realpathSync(path.join(w.root, 'bin', 'git'))
  const script = [
    `#!${process.execPath}`,
    `const { spawnSync } = require('child_process')`,
    `const argv = process.argv.slice(2)`,
    `if (argv.includes('prune')) { process.stderr.write('simulated prune failure\\n'); process.exit(1) }`,
    `process.exit(spawnSync(${JSON.stringify(realGit)}, argv, { stdio: 'inherit' }).status ?? 1)`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(binDir, 'git'), script, { mode: 0o755 })

  const file = path.join(w.root, 'hand plan.json')
  fs.writeFileSync(file, JSON.stringify({ actions: [{ kind: 'delete-local', target: 'old', expectTip: tip, basis: 'picked' }] }))
  const result = w.cli(w.a, ['apply', '--plan', file], { PATH: `${binDir}:${w.env.PATH}` })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(result.json.pruned, [])
  assert.deepEqual(outcomes(result.json), [['delete-local', 'done', null]])
  assert.ok(result.json.warnings.some((line) => /worktree prune failed: simulated prune failure/.test(line)), JSON.stringify(result.json.warnings))

  const report = w.cli(w.a, ['report'])
  assert.match(report.json.markdown, /worktree prune failed/)
})

test('T11.21 an engine failure outside any action still leaves a partial apply.json (R36)', (t) => {
  const w = world(t)
  const tip = branch(w, 'old')
  const wt = path.join(w.root, 'wt detached')
  w.git(w.a, 'worktree', 'add', '--detach', wt, 'main')
  eisdirAt(w.git(wt, 'rev-parse', '--absolute-git-dir'))

  const result = applyCli(w, [{ kind: 'delete-local', target: 'old', expectTip: tip, basis: 'picked' }])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const state = applyStateOf(w)
  assert.equal(state.partial, true)
  assert.deepEqual(state.results, [])
  assert.ok(state.warnings.some((line) => line.startsWith('apply stopped early')), JSON.stringify(state.warnings))
  assert.equal(localTip(w, 'old'), tip)
})

// Final review Minor 4 (T11 #1): a worktree removed on the merged basis rests on the same proof as the branch it holds, so it is re-proved the
// same way (R16): its HEAD must be merged on `origin/<trunk>`, not just on the local trunk the survey saw.
test('T11.22 a merged-basis worktree removal is re-proved on origin: kept while the trunk is unpublished, removed once it is', (t) => {
  const w = world(t)
  const tip = mergedInWorktree(w, 'm1')
  surveyOf(w)
  const actions = planCli(w, { merged: 'all' })
  assert.equal(actions.find((a) => a.kind === 'remove-worktree').basis, 'merged')

  const refused = applied(w)
  assert.deepEqual(outcomes(refused), [
    ['remove-worktree', 'skipped', 'not-merged-on-origin'],
    ['delete-remote', 'skipped', 'not-merged-on-origin'],
    ['delete-local', 'skipped', 'checked-out-in-worktree'],
  ])
  assert.equal(fs.existsSync(realWt(w, 'm1')), true)
  assert.equal(localTip(w, 'm1'), tip)

  publishTrunk(w)
  assert.deepEqual(outcomes(applied(w)), [
    ['remove-worktree', 'done', null],
    ['delete-remote', 'done', null],
    ['delete-local', 'done', null],
  ])
  assert.equal(fs.existsSync(realWt(w, 'm1')), false)
})
