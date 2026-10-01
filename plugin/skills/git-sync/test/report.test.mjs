// Tests for `report` (design.md §12): turns the state files every earlier phase left behind into one markdown summary — committed commits, the
// trunk's fate, deleted branches with recovery lines, everything that survived and why, pushed branches, stashes, worktrees, and warnings — without
// touching the repo itself. A stopped run reports only what happened before the stop; a partial run (fewer phases than a full one) must never throw.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { world } from './world.mjs'

// Same shape as survey.test.mjs's/apply.test.mjs's own helper: a new branch off `main` with one commit, optionally pushed with an upstream, then
// back to `main` so the next fixture step starts from the trunk.
function branch(w, name, { push = false, dir = w.a, daysAgo } = {}) {
  w.git(dir, 'checkout', '-b', name)
  const tip = w.commit(dir, { file: `${name}.txt`, content: `${name}\n`, msg: `work on ${name}`, daysAgo })
  if (push) w.git(dir, 'push', '-u', 'origin', name)
  w.git(dir, 'checkout', 'main')
  return tip
}

// T11.1/T8.4's world (apply.test.mjs): `name` pushed, fast-forwarded into a's local main, and checked out in its own clean worktree.
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

function applied(w) {
  const result = w.cli(w.a, ['apply'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

function reportOf(w) {
  const result = w.cli(w.a, ['report'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

// apply.test.mjs's own helpers, copied rather than imported (this suite's convention): a hand-written action list run straight through `apply`,
// and the `[kind, status, reason]` shape most outcome assertions care about.
function appliedPlan(w, actions) {
  const file = path.join(w.root, 'hand plan.json')
  fs.writeFileSync(file, JSON.stringify({ actions }))
  const result = w.cli(w.a, ['apply', '--plan', file])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}
const outcomes = (json) => json.results.map((r) => [r.kind, r.status, r.reason])
const realWt = (w, name) => path.join(fs.realpathSync(w.root), `wt ${name}`)

// stash.test.mjs's own helpers, copied for the same reason: a stash addressed by SHA, its branch's date, and the two action shapes apply expects.
function stash(w, files, flags = []) {
  for (const [file, content] of files) fs.writeFileSync(path.join(w.a, file), content)
  w.git(w.a, 'stash', 'push', ...flags)
  return w.git(w.a, 'rev-parse', 'stash@{0}')
}
const ymd = (w, sha) => w.git(w.a, 'log', '-1', '--date=format-local:%Y%m%d', '--format=%cd', sha)
const branchAction = (sha, baseSha, push = false) => ({ kind: 'stash-branch', target: sha, expectTip: sha, push, baseSha })

// T11.12's world (apply.test.mjs): `m1` merged locally (never published), verify forced red or green by the `npm` stub, then push-trunk run.
function mergedLocallyOnly(t, checks) {
  const w = world(t)
  branch(w, 'm1', { push: true })
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge m1', 'm1')
  fs.writeFileSync(path.join(w.a, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', checks === 'red' ? { stdout: 'ok\n', byArgs: { 'run test': { exit: 1, stderr: 'boom\n' } } } : { stdout: 'ok\n' })
  surveyOf(w)
  planCli(w, { merged: 'all' })
  w.cli(w.a, ['verify'])
  return w
}

test('T13.1 after a merged branch is fully deleted, ## Deleted carries both recovery lines', (t) => {
  const w = world(t)
  const tip = mergedInWorktree(w, 'm1')
  surveyOf(w)
  planCli(w, { merged: 'all' })
  assert.equal(publishTrunk(w).pushed, true)
  applied(w)

  const { markdown } = reportOf(w)
  assert.match(markdown, /^# git-sync report/)
  assert.ok(markdown.includes('## Deleted'), markdown)
  assert.ok(markdown.includes(`git branch m1 ${tip}`), markdown)
  assert.ok(markdown.includes(`git push origin ${tip}:refs/heads/m1`), markdown)
  // Fully deleted: nothing of m1 survives to keep.
  assert.ok(!markdown.includes('## Kept'), markdown)
})

test('T13.2 ## Kept lists an active, a protected and an abandoned branch nobody picked', (t) => {
  const w = world(t)
  branch(w, 'wip', { push: true, daysAgo: 1 })
  branch(w, 'old', { push: true, daysAgo: 31 })
  const prTip = branch(w, 'open-pr', { push: true })
  w.stub('gh', {
    stdout: '[]\n',
    byArgs: { '--head open-pr': { stdout: `${JSON.stringify([{ number: 9, state: 'OPEN', headRefOid: prTip }])}\n` } },
  })
  surveyOf(w)
  planCli(w, {}) // nobody picks anything: every offered branch is left alone
  publishTrunk(w)
  applied(w)

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Kept'), markdown)
  assert.ok(markdown.includes('- wip (active): recent'), markdown)
  assert.ok(markdown.includes('- open-pr (protected): open PR #9'), markdown)
  assert.ok(markdown.includes('- old (abandoned): 31d without commits'), markdown)
  assert.ok(!markdown.includes('## Deleted'), markdown)
})

test('T13.3 warnings: a downgraded repo, an unverified repo, and a propagated .nvmrc mismatch', (t) => {
  const gl = world(t, { host: 'gitlab.com' })
  assert.equal(gl.cli(gl.a, ['preflight']).status, 0)
  const glReport = reportOf(gl)
  assert.ok(glReport.markdown.includes('downgraded: trunk not pushed, remote branches untouched'), glReport.markdown)

  const plain = world(t)
  assert.equal(plain.cli(plain.a, ['verify']).status, 0)
  const plainReport = reportOf(plain)
  assert.ok(plainReport.markdown.includes('unverified: no checks found'), plainReport.markdown)

  const nvmrc = world(t)
  fs.writeFileSync(path.join(nvmrc.a, '.nvmrc'), '1\n')
  nvmrc.stub('node', { stdout: 'v22.5.0\n' })
  assert.equal(nvmrc.cli(nvmrc.a, ['verify']).status, 0)
  const nvmrcReport = reportOf(nvmrc)
  assert.ok(nvmrcReport.markdown.includes('.nvmrc wants 1, active node is v22.5.0'), nvmrcReport.markdown)
})

test('T13.4 a run stopped at sync reports the stop and omits every later section', (t) => {
  const w = world(t)
  w.commit(w.b, { file: 'f.txt', content: 'from b\n', msg: 'b edits f' })
  w.git(w.b, 'push', 'origin', 'main')
  w.commit(w.a, { file: 'f.txt', content: 'from a\n', msg: 'a edits f' })
  assert.equal(w.cli(w.a, ['preflight']).status, 0)
  const syncResult = w.cli(w.a, ['sync'])
  assert.equal(syncResult.json.stop, 'rebase-conflict')

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('Stopped at sync: rebase-conflict'), markdown)
  // Minor: the stop line carries its detail too (design.md §11 treats stop+detail as a pair), right after the bare stop code.
  assert.ok(markdown.includes(`Stopped at sync: rebase-conflict — ${JSON.stringify(syncResult.json.detail)}`), markdown)
  assert.ok(!markdown.includes('## Deleted'), markdown)
  assert.ok(!markdown.includes('## Kept'), markdown)
  assert.ok(!markdown.includes('## Trunk'), markdown)
})

test('T13.5 last-report.md is byte-identical to the returned markdown', (t) => {
  const w = world(t)
  branch(w, 'wip', { push: true, daysAgo: 1 })
  surveyOf(w)
  planCli(w, {})
  const { path: reportPath, markdown } = reportOf(w)
  assert.equal(reportPath, path.join(w.ctx(w.a).stateDir, 'last-report.md'))
  assert.equal(fs.readFileSync(reportPath, 'utf8'), markdown)
})

test('T13.6 a commit made on feat after preflight is listed under ## Committed', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat')
  assert.equal(w.cli(w.a, ['preflight']).status, 0)
  const tip = w.commit(w.a, { file: 'later.txt', content: 'later\n', msg: 'later work on feat' })

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Committed'), markdown)
  const shortSha = w.git(w.a, 'rev-parse', '--short', tip)
  assert.ok(markdown.includes(`${shortSha} later work on feat`), markdown)
})

test('T13.7 after a red trunk, a locally-merged branch is kept with a planned-delete-skipped reason', (t) => {
  const w = mergedLocallyOnly(t, 'red')
  const pushed = w.cli(w.a, ['push-trunk']).json
  assert.equal(pushed.reason, 'red')
  applied(w)

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Kept'), markdown)
  assert.ok(markdown.includes('m1 (merged): planned delete skipped: not-merged-on-origin (not provably merged into the trunk on origin)'), markdown)
  assert.ok(!markdown.includes('## Deleted'), markdown)
})

test('T13.8 a partial run (preflight only) never throws and reports just what happened', (t) => {
  const w = world(t)
  assert.equal(w.cli(w.a, ['preflight']).status, 0)

  const result = w.cli(w.a, ['report'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.json.ok, true)
  assert.ok(!result.json.markdown.includes('## Trunk'), result.json.markdown)
  assert.ok(!result.json.markdown.includes('## Deleted'), result.json.markdown)
  assert.ok(!result.json.markdown.includes('## Kept'), result.json.markdown)
})

test('T13.9 a report with no prior phase at all never throws', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['report'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.json.ok, true)
  assert.match(result.json.markdown, /^# git-sync report\n$/)
})

// Fix round 1 (task-13-review.md): C1/R28, I1/R29, I2, I3, I4/R30.

test('T13.10 C1/R28: a truncated preflight.json is treated as missing, with a named warning, not a crash', (t) => {
  const w = world(t)
  assert.equal(w.cli(w.a, ['preflight']).status, 0)
  const file = path.join(w.ctx(w.a).stateDir, 'preflight.json')
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 10)) // still exists, but no longer valid JSON

  const result = w.cli(w.a, ['report'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.json.ok, true)
  assert.ok(result.json.markdown.includes('## Warnings'), result.json.markdown)
  assert.ok(result.json.markdown.includes('state file preflight.json unreadable'), result.json.markdown)
  // Treated as though preflight never ran: no commits-since-preflight section to build from a file report can't read.
  assert.ok(!result.json.markdown.includes('## Committed'), result.json.markdown)
})

test('T13.11 I1/R29: a branch name with shell metacharacters is quoted, and round-trips through sh -c', (t) => {
  const w = world(t)
  const name = "a$(x);'z" // valid per `git check-ref-format --branch`; carries both a command substitution and a literal quote
  const tip = mergedInWorktree(w, name)
  surveyOf(w)
  planCli(w, { merged: 'all' })
  assert.equal(publishTrunk(w).pushed, true)
  applied(w)

  const { markdown } = reportOf(w)
  const localMatch = markdown.match(/`git branch (.+) ([0-9a-f]{40})`/)
  const remoteMatch = markdown.match(/`git push origin ([0-9a-f]{40}):refs\/heads\/(.+)`/)
  assert.ok(localMatch, markdown)
  assert.ok(remoteMatch, markdown)
  assert.equal(localMatch[2], tip)
  assert.equal(remoteMatch[1], tip)

  // Each captured token is exactly what a reader would paste after `git branch`/`refs/heads/`; feeding it to sh -c as a literal argument must
  // hand back the original branch name unchanged, whatever shell metacharacters it contains.
  for (const token of [localMatch[1], remoteMatch[2]]) {
    const printed = spawnSync('/bin/sh', ['-c', `printf %s ${token}`], { encoding: 'utf8' })
    assert.equal(printed.status, 0, printed.stderr)
    assert.equal(printed.stdout, name)
  }
})

test('T13.12 I3: ## Pushed branches lists a successful push-branch result', (t) => {
  const w = world(t)
  branch(w, 'solo')
  surveyOf(w)
  planCli(w, { push: ['solo'] })
  applied(w)

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Pushed branches'), markdown)
  assert.ok(markdown.includes('- solo: pushed'), markdown)
})

test('T13.13 I2/I3: ## Stashes shows a done branch with a rejected push, and a kept stash with its conflict detail', (t) => {
  const w = world(t)
  // T12.4's "rejected push" fixture: the branch is still made, but the name is already taken on origin by the other box.
  const base1 = w.git(w.a, 'rev-parse', 'HEAD')
  const sha1 = stash(w, [['.gitignore', 'mine\n']])
  const name1 = `stash/main-${ymd(w, sha1)}`
  w.git(w.b, 'checkout', '-b', name1)
  w.commit(w.b, { file: 'theirs.txt', content: 'theirs\n', msg: 'theirs' })
  w.git(w.b, 'push', 'origin', name1)

  // T12.5's "stash-conflict" fixture: the plan's baseSha no longer matches, so the stash is kept.
  w.commit(w.a, { file: 'f.txt', content: 'one\n', msg: 'f' })
  const sha2 = stash(w, [['f.txt', 'stashed\n']])
  const other = w.commit(w.a, { file: 'f.txt', content: 'other\n', msg: 'moves f' })

  const json = appliedPlan(w, [branchAction(sha1, base1, true), branchAction(sha2, other)])
  assert.deepEqual(
    outcomes(json).map((o) => o.slice(0, 2)),
    [
      ['stash-branch', 'done'],
      ['stash-branch', 'skipped'],
    ],
  )

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Stashes'), markdown)
  assert.ok(markdown.includes(`- ${sha1.slice(0, 7)}: branched as ${name1} (push rejected)`), markdown)
  // I2: a non-done stash result carries its detail too, the same as pushedBranchLines/worktreeLines already did.
  assert.ok(markdown.includes(`- ${sha2.slice(0, 7)}: skipped (stash-conflict (the stash could not be applied cleanly; stash kept)):`), markdown)
})

test('T13.14 I3: ## Worktrees lists a removed worktree and a pruned path together', (t) => {
  const w = world(t)
  mergedInWorktree(w, 'm1')
  w.git(w.a, 'worktree', 'add', path.join(w.root, 'wt x'), '-b', 'x')
  fs.rmSync(realWt(w, 'x'), { recursive: true, force: true }) // vanished by hand: apply prunes it before any planned action runs
  surveyOf(w)
  planCli(w, { merged: 'all' })
  assert.equal(publishTrunk(w).pushed, true)
  applied(w)

  const { markdown } = reportOf(w)
  assert.ok(markdown.includes('## Worktrees'), markdown)
  assert.ok(markdown.includes(`- pruned: ${realWt(w, 'x')}`), markdown)
  assert.ok(markdown.includes(`- ${realWt(w, 'm1')}: removed`), markdown)
})

test('T13.15 I4/R30: after a second, no-op apply, ## Kept never claims an already-deleted branch is merely skipped', (t) => {
  const w = world(t)
  mergedInWorktree(w, 'm1')
  surveyOf(w)
  planCli(w, { merged: 'all' })
  assert.equal(publishTrunk(w).pushed, true)
  applied(w) // fully deletes m1: worktree, remote, local
  const again = applied(w) // §10.10: a second apply with no intervening survey is a no-op
  assert.deepEqual(outcomes(again), [
    ['remove-worktree', 'skipped', 'worktree-gone'],
    ['delete-remote', 'skipped', 'lease-failed'],
    ['delete-local', 'skipped', 'branch-gone'],
  ])

  const { markdown } = reportOf(w)
  // The local side resolved via branch-gone is unambiguous (already gone) and must never read as "skipped: branch-gone" — the opposite of the
  // truth. Only the genuinely ambiguous remote side (lease-failed, R24) still counts as a reason m1 is kept.
  assert.ok(!markdown.includes('branch-gone'), markdown)
  assert.ok(markdown.includes('## Kept'), markdown)
  assert.ok(markdown.includes('- m1 (merged): planned delete skipped: lease-failed (remote branch changed or already gone)'), markdown)
  // This run's own apply.json has no `done` deletes to report (they all happened on the prior run).
  assert.ok(!markdown.includes('## Deleted'), markdown)
})
