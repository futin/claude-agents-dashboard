// Tests for the `preflight` subcommand (design.md §4 phase 0, §6) and the repo/trunk/remote-kind/
// config helpers it introduces, which every later subcommand will also call through `repo()`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

// Leaves `w.a` mid-rebase against `origin/main`: both sides add the same new file with different
// content, so the replay conflicts ("both added") and `--merge` guarantees a `rebase-merge/` dir
// regardless of which backend this git version defaults to.
function conflictingRebase(w) {
  w.commit(w.b, { file: 'shared.txt', content: 'from b\n', msg: 'b edits shared' })
  w.git(w.b, 'push', 'origin', 'main')
  w.commit(w.a, { file: 'shared.txt', content: 'from a\n', msg: 'a edits shared' })
  w.git(w.a, 'fetch', 'origin')
  const result = git(w.a, ['rebase', '--merge', 'origin/main'], { env: w.env })
  assert.notEqual(result.status, 0, 'setup: rebase should conflict')
}

// Same shape as conflictingRebase, but leaves a plain merge conflict (MERGE_HEAD) instead.
function conflictingMerge(w) {
  w.commit(w.b, { file: 'shared.txt', content: 'from b\n', msg: 'b edits shared' })
  w.git(w.b, 'push', 'origin', 'main')
  w.commit(w.a, { file: 'shared.txt', content: 'from a\n', msg: 'a edits shared' })
  w.git(w.a, 'fetch', 'origin')
  const result = git(w.a, ['merge', 'origin/main'], { env: w.env })
  assert.notEqual(result.status, 0, 'setup: merge should conflict')
}

// Cherry-picks a commit that added cp.txt onto a history where cp.txt was independently added
// with different content — an "add/add" conflict that leaves CHERRY_PICK_HEAD.
function conflictingCherryPick(w) {
  const sha = w.commit(w.a, { file: 'cp.txt', content: 'v1\n', msg: 'v1' })
  w.git(w.a, 'reset', '--hard', 'HEAD~1')
  w.commit(w.a, { file: 'cp.txt', content: 'v2\n', msg: 'v2' })
  const result = git(w.a, ['cherry-pick', sha], { env: w.env })
  assert.notEqual(result.status, 0, 'setup: cherry-pick should conflict')
}

test('T2.1 fresh clone: ok envelope, and preflight.json mirrors it', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['preflight'])
  assert.equal(result.status, 0)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.trunk, 'main')
  assert.equal(result.json.remoteKind, 'github')
  assert.equal(result.json.pushAllowed, true)
  assert.equal(result.json.downgraded, false)
  assert.equal(result.json.startBranch, 'main')
  assert.equal(result.json.startHead, w.git(w.a, 'rev-parse', 'HEAD'))
  assert.equal(result.json.dirty, false)

  const ctx = w.ctx(w.a)
  const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'preflight.json'), 'utf8'))
  assert.deepEqual(onDisk, result.json)
})

// R31: the payload names the state dir, so SKILL.md never derives it. It lives under the git common dir, and a run from a subdirectory reports the
// same one. A linked worktree has no success case to check here: preflight refuses it before building a payload (T2.6).
test('T2.1b payload carries stateDir under the git common dir, from the root and from a subdirectory', (t) => {
  const w = world(t)
  const ctx = w.ctx(w.a)
  const fromRoot = w.cli(w.a, ['preflight'])
  assert.equal(fromRoot.json.stateDir, ctx.stateDir)
  assert.equal(fromRoot.json.stateDir, path.join(ctx.commonDir, 'git-sync'))
  assert.ok(fs.statSync(fromRoot.json.stateDir).isDirectory(), 'the named state dir exists')

  const deep = path.join(w.a, 'src')
  fs.mkdirSync(deep, { recursive: true })
  assert.equal(w.cli(deep, ['preflight']).json.stateDir, ctx.stateDir)
})

test('T2.2 trunk resolution: origin/HEAD, fallback to main, fallback to master, no-trunk', (t) => {
  const w = world(t)
  w.git(w.a, 'remote', 'set-head', 'origin', '-d')
  const result = w.cli(w.a, ['preflight'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.trunk, 'main')

  // A world whose trunk was renamed to master in origin before this clone's tracking refs are
  // pruned down to just it — no refs/heads/main or refs/remotes/origin/main survive.
  const w2 = world(t)
  w2.git(w2.a, 'branch', '-m', 'main', 'master')
  w2.git(w2.a, 'push', 'origin', 'master')
  w2.git(w2.origin, 'symbolic-ref', 'HEAD', 'refs/heads/master')
  w2.git(w2.a, 'push', 'origin', '--delete', 'main')
  w2.git(w2.a, 'fetch', '--prune', 'origin')
  w2.git(w2.a, 'remote', 'set-head', 'origin', '-d')
  const result2 = w2.cli(w2.a, ['preflight'])
  assert.equal(result2.json.ok, true)
  assert.equal(result2.json.trunk, 'master')

  // Only branch is `dev`, no origin/HEAD, no main or master anywhere -> no-trunk.
  const w3 = world(t)
  w3.git(w3.a, 'branch', '-m', 'main', 'dev')
  w3.git(w3.a, 'push', 'origin', 'dev')
  w3.git(w3.origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev')
  w3.git(w3.a, 'push', 'origin', '--delete', 'main')
  w3.git(w3.a, 'fetch', '--prune', 'origin')
  w3.git(w3.a, 'remote', 'set-head', 'origin', '-d')
  const result3 = w3.cli(w3.a, ['preflight'])
  assert.equal(result3.json.ok, false)
  assert.equal(result3.json.stop, 'no-trunk')
})

test('T2.3 in-progress-operation (rebase/merge/cherry-pick/bisect), detached-head, no-origin', (t) => {
  const rebaseWorld = world(t)
  conflictingRebase(rebaseWorld)
  const rebaseResult = rebaseWorld.cli(rebaseWorld.a, ['preflight'])
  assert.equal(rebaseResult.json.ok, false)
  assert.equal(rebaseResult.json.stop, 'in-progress-operation')

  const mergeWorld = world(t)
  conflictingMerge(mergeWorld)
  const mergeResult = mergeWorld.cli(mergeWorld.a, ['preflight'])
  assert.equal(mergeResult.json.ok, false)
  assert.equal(mergeResult.json.stop, 'in-progress-operation')

  const cherryWorld = world(t)
  conflictingCherryPick(cherryWorld)
  const cherryResult = cherryWorld.cli(cherryWorld.a, ['preflight'])
  assert.equal(cherryResult.json.ok, false)
  assert.equal(cherryResult.json.stop, 'in-progress-operation')

  const bisectWorld = world(t)
  bisectWorld.git(bisectWorld.a, 'bisect', 'start')
  const bisectResult = bisectWorld.cli(bisectWorld.a, ['preflight'])
  assert.equal(bisectResult.json.ok, false)
  assert.equal(bisectResult.json.stop, 'in-progress-operation')

  const detachedWorld = world(t)
  detachedWorld.git(detachedWorld.a, 'checkout', '--detach')
  const detachedResult = detachedWorld.cli(detachedWorld.a, ['preflight'])
  assert.equal(detachedResult.json.ok, false)
  assert.equal(detachedResult.json.stop, 'detached-head')

  const noOriginWorld = world(t)
  noOriginWorld.git(noOriginWorld.a, 'remote', 'remove', 'origin')
  const noOriginResult = noOriginWorld.cli(noOriginWorld.a, ['preflight'])
  assert.equal(noOriginResult.json.ok, false)
  assert.equal(noOriginResult.json.stop, 'no-origin')
})

test('T2.4 remote kind and push gating', (t) => {
  const gl = world(t, { host: 'gitlab.example.com' })
  const glResult = gl.cli(gl.a, ['preflight'])
  assert.equal(glResult.json.remoteKind, 'other')
  assert.equal(glResult.json.pushAllowed, false)
  assert.equal(glResult.json.downgraded, true)

  const pushFalse = world(t)
  pushFalse.git(pushFalse.a, 'config', 'git-sync.push', 'false')
  const pushFalseResult = pushFalse.cli(pushFalse.a, ['preflight'])
  assert.equal(pushFalseResult.json.pushAllowed, false)

  const glPushTrue = world(t, { host: 'gitlab.example.com' })
  glPushTrue.git(glPushTrue.a, 'config', 'git-sync.push', 'true')
  const glPushTrueResult = glPushTrue.cli(glPushTrue.a, ['preflight'])
  assert.equal(glPushTrueResult.json.pushAllowed, false)

  // An unparseable git-sync.push is treated as unset (not false), mirroring staleDays' warning.
  const badPush = world(t)
  badPush.git(badPush.a, 'config', 'git-sync.push', 'maybe')
  const badPushResult = badPush.cli(badPush.a, ['preflight'])
  assert.equal(badPushResult.json.config.push, null)
  assert.equal(badPushResult.json.pushAllowed, true)
  assert.deepEqual(badPushResult.json.warnings, ['git-sync.push is not a boolean'])
})

test('T2.5 staleDays parsing and warnings', (t) => {
  const good = world(t)
  good.git(good.a, 'config', 'git-sync.staleDays', '7')
  const goodResult = good.cli(good.a, ['preflight'])
  assert.equal(goodResult.json.config.staleDays, 7)
  assert.deepEqual(goodResult.json.warnings, [])

  const bad = world(t)
  bad.git(bad.a, 'config', 'git-sync.staleDays', 'abc')
  const badResult = bad.cli(bad.a, ['preflight'])
  assert.equal(badResult.json.config.staleDays, 30)
  assert.deepEqual(badResult.json.warnings, ['git-sync.staleDays is not a positive integer'])

  const zero = world(t)
  zero.git(zero.a, 'config', 'git-sync.staleDays', '0')
  const zeroResult = zero.cli(zero.a, ['preflight'])
  assert.equal(zeroResult.json.config.staleDays, 30)
  assert.deepEqual(zeroResult.json.warnings, ['git-sync.staleDays is not a positive integer'])
})

test('T2.6 subdirectory resolves to root; a linked worktree stops linked-worktree', (t) => {
  const w = world(t)
  const deep = path.join(w.a, 'src', 'deep')
  fs.mkdirSync(deep, { recursive: true })
  const result = w.cli(deep, ['preflight'])
  assert.equal(result.json.ok, true)
  // `git rev-parse --show-toplevel` resolves symlinks (e.g. macOS's /tmp -> /private/tmp), so the
  // comparison must go through the same resolution rather than against w.a's own spelling.
  assert.equal(result.json.root, fs.realpathSync(w.a))

  const wtPath = path.join(w.a, 'wt')
  w.git(w.a, 'worktree', 'add', wtPath, '-b', 'wt-branch')
  const wtResult = w.cli(wtPath, ['preflight'])
  assert.equal(wtResult.json.ok, false)
  assert.equal(wtResult.json.stop, 'linked-worktree')
})

// R9 regression: a linked worktree shares `commonDir` — and so `stateDir` — with its main tree.
// A refusal from the worktree must not clear the main tree's in-flight state before it stops.
test('T2.6b linked-worktree refusal does not clear the shared state dir', (t) => {
  const w = world(t)
  const wtPath = path.join(w.a, 'wt')
  w.git(w.a, 'worktree', 'add', wtPath, '-b', 'wt-branch')

  const ctx = w.ctx(w.a)
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  const surveyContent = '{"stale":true}\n'
  fs.writeFileSync(path.join(ctx.stateDir, 'survey.json'), surveyContent)

  const result = w.cli(wtPath, ['preflight'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'linked-worktree')
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'survey.json'), 'utf8'), surveyContent)
})

// R32: a linked worktree shares the state dir with its main tree, so its refusal writes nothing there — not even its own `<cmd>.json` envelope,
// which would otherwise overwrite the main tree's in-flight `preflight.json` and make that run's report read "Stopped at preflight". Apply refuses
// a linked worktree the same way and is held to the same rule.
test('T2.6c linked-worktree refusal writes nothing to the state dir, for preflight and apply', (t) => {
  const w = world(t)
  const wtPath = path.join(w.a, 'wt')
  w.git(w.a, 'worktree', 'add', wtPath, '-b', 'wt-branch')
  const ctx = w.ctx(w.a)
  const snapshot = () => (fs.existsSync(ctx.stateDir)
    ? Object.fromEntries(fs.readdirSync(ctx.stateDir).sort().map((f) => [f, fs.readFileSync(path.join(ctx.stateDir, f), 'utf8')]))
    : null)

  for (const cmd of ['preflight', 'apply']) {
    assert.equal(snapshot(), null, `${cmd}: setup has no state dir`)
    const refused = w.cli(wtPath, [cmd])
    assert.equal(refused.status, 2)
    assert.equal(refused.json.stop, 'linked-worktree')
    assert.equal(snapshot(), null, `${cmd}: a refusal creates no state dir`)
  }

  assert.equal(w.cli(w.a, ['preflight']).json.ok, true)
  const before = snapshot()
  assert.ok(before['preflight.json'], 'the main tree has its own preflight.json')
  for (const cmd of ['preflight', 'apply']) {
    assert.equal(w.cli(wtPath, [cmd]).json.stop, 'linked-worktree')
    assert.deepEqual(snapshot(), before, `${cmd}: the main tree's state is untouched`)
  }
})

test('T2.7 state reset: clears prior run files except deleted.log and last-report.md', (t) => {
  const w = world(t)
  const ctx = w.ctx(w.a)
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.writeFileSync(path.join(ctx.stateDir, 'survey.json'), '{"stale":true}\n')
  const deletedLogContent = 'old-branch\n'
  const lastReportContent = '# old report\n'
  fs.writeFileSync(path.join(ctx.stateDir, 'deleted.log'), deletedLogContent)
  fs.writeFileSync(path.join(ctx.stateDir, 'last-report.md'), lastReportContent)

  const result = w.cli(w.a, ['preflight'])
  assert.equal(result.json.ok, true)
  assert.ok(!fs.existsSync(path.join(ctx.stateDir, 'survey.json')))
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'deleted.log'), 'utf8'), deletedLogContent)
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, 'last-report.md'), 'utf8'), lastReportContent)
})

test('T2.8 untracked file counts as dirty without refusing', (t) => {
  const w = world(t)
  fs.writeFileSync(path.join(w.a, 'untracked.txt'), 'hi\n')
  const result = w.cli(w.a, ['preflight'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.dirty, true)
})

// Final review Minor 5: `origin/HEAD` names a branch by its full ref, and a trunk may hold a slash; taking the last path segment made
// `release/x` read as `x`.
test('T2.9 an origin/HEAD pointing at a slashed branch keeps the whole name as the trunk', (t) => {
  const w = world(t)
  w.git(w.a, 'push', 'origin', 'main:refs/heads/release/x')
  w.git(w.a, 'fetch', 'origin')
  w.git(w.a, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release/x')
  const result = w.cli(w.a, ['preflight'])
  assert.equal(result.json.ok, true, result.stdout)
  assert.equal(result.json.trunk, 'release/x')
})
