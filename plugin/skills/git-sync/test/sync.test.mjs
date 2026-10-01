// Tests for the `sync` subcommand (design.md §4 phase 2): fetch --prune, check out the trunk, and
// rebase it onto the fetched `origin/<trunk>`, aborting on conflict — plus the lockfile-change
// detection a later phase (`verify`, §9) reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { git } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

test('T4.1 fast-forwards onto origin/<trunk> and switches off the starting branch', (t) => {
  const w = world(t)
  w.commit(w.b, { file: 'one.txt', content: '1\n', msg: 'b commit one' })
  w.git(w.b, 'push', 'origin', 'main')
  w.commit(w.b, { file: 'two.txt', content: '2\n', msg: 'b commit two' })
  w.git(w.b, 'push', 'origin', 'main')
  w.git(w.a, 'checkout', '-b', 'feat')

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.status, 0)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.trunk, 'main')
  assert.equal(result.json.switchedFrom, 'feat')
  assert.equal(result.json.pulled, 2)
  assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(result.json.after, w.git(w.a, 'rev-parse', 'origin/main'))
})

test('T4.2 a hostile pull.rebase/pull.ff never steers the rebase (Review Focus 4)', (t) => {
  const w = world(t)
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[pull]\n\trebase = false\n\tff = only\n')

  const bSha = w.commit(w.b, { file: 'b.txt', content: 'from b\n', msg: 'b commit' })
  w.git(w.b, 'push', 'origin', 'main')
  w.commit(w.a, { file: 'a.txt', content: 'from a\n', msg: 'a commit' })

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.pulled, 1)

  // Linear history: the rebased commit's sole parent is b's pushed commit, not a merge of the two.
  const [rebasedSha, parentSha] = w.git(w.a, 'log', '-1', '--format=%H %P', 'main').split(' ')
  assert.equal(rebasedSha, result.json.after)
  assert.equal(parentSha, bSha)
})

test('T4.3 a conflicting rebase is aborted and the tree is left exactly as it was', (t) => {
  const w = world(t)
  w.commit(w.b, { file: 'f.txt', content: 'from b\n', msg: 'b edits f' })
  w.git(w.b, 'push', 'origin', 'main')
  const preSyncTip = w.commit(w.a, { file: 'f.txt', content: 'from a\n', msg: 'a edits f' })

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'rebase-conflict')
  assert.deepEqual(result.json.detail.files, ['f.txt'])

  const ctx = w.ctx(w.a)
  assert.equal(fs.existsSync(path.join(ctx.gitDir, 'rebase-merge')), false)
  assert.equal(fs.existsSync(path.join(ctx.gitDir, 'rebase-apply')), false)
  assert.equal(w.git(w.a, 'status', '--porcelain'), '')
  assert.equal(w.git(w.a, 'rev-parse', 'main'), preSyncTip)
})

test('T4.4 a dirty tree stops before anything is fetched or moved', (t) => {
  const w = world(t)
  const head = w.git(w.a, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(w.a, 'untracked.txt'), 'x\n')

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'dirty-tree')
  assert.equal(w.git(w.a, 'rev-parse', 'HEAD'), head)
})

test('T4.5 an unreachable origin stops with fetch-failed', (t) => {
  const w = world(t)
  w.git(w.a, 'remote', 'set-url', 'origin', path.join(w.root, 'missing.git'))

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'fetch-failed')
  assert.ok(result.json.detail.stderr.length > 0)
})

test('T4.6 fetch --prune removes a remote-tracking branch deleted on the other box', (t) => {
  const w = world(t)
  w.git(w.b, 'checkout', '-b', 'old')
  w.git(w.b, 'push', 'origin', 'old')
  w.git(w.a, 'fetch', 'origin')
  assert.equal(git(w.a, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/old'], { env: w.env }).status, 0)
  w.git(w.b, 'push', 'origin', '--delete', 'old')

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, true)
  assert.notEqual(git(w.a, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/old'], { env: w.env }).status, 0)
})

test('T4.7 a trunk with no upstream stops with no-upstream', (t) => {
  const w = world(t)
  w.git(w.a, 'branch', '--unset-upstream', 'main')

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'no-upstream')
})

test('T4.8 lockfileChanged tracks a lockfile blob, not just any change on the trunk', (t) => {
  const changed = world(t)
  changed.commit(changed.b, { file: 'package-lock.json', content: '{"a":1}\n', msg: 'lockfile bump' })
  changed.git(changed.b, 'push', 'origin', 'main')
  const changedResult = changed.cli(changed.a, ['sync'])
  assert.equal(changedResult.json.ok, true)
  assert.equal(changedResult.json.lockfileChanged, true)

  const unchanged = world(t)
  unchanged.commit(unchanged.b, { file: 'README.md', content: 'hello\n', msg: 'docs only' })
  unchanged.git(unchanged.b, 'push', 'origin', 'main')
  const unchangedResult = unchanged.cli(unchanged.a, ['sync'])
  assert.equal(unchangedResult.json.ok, true)
  assert.equal(unchangedResult.json.lockfileChanged, false)
})

test('T4.9 recreates a deleted local trunk tracking origin', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat')
  w.git(w.a, 'branch', '-D', 'main')

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.trunk, 'main')
  assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main')
})

// Fix round 1, Important #1: a hostile `post-checkout` or `pre-rebase` hook must never run, let
// alone block, a sync — `--no-verify` only reaches the rebase call, so the two `checkout` calls
// (existing-branch and create-tracking) need their own hook suppression via `core.hooksPath`.
test('T4.10 a failing post-checkout/pre-rebase hook never runs and never blocks sync', (t) => {
  const w = world(t)
  w.commit(w.b, { file: 'up.txt', content: '1\n', msg: 'b commit' })
  w.git(w.b, 'push', 'origin', 'main')
  w.git(w.a, 'checkout', '-b', 'feat')

  for (const hook of ['post-checkout', 'pre-rebase']) {
    const hookPath = path.join(w.a, '.git', 'hooks', hook)
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.chmodSync(hookPath, 0o755)
  }

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, true)
  assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(w.git(w.a, 'rev-parse', 'HEAD'), w.git(w.a, 'rev-parse', 'origin/main'))
})

// Fix round 2: `rebase --abort` was the one mutating call `sync` made without `SAFE_MUTATE_CONFIG`.
// A failing `post-checkout` is planted here because that's the hook the abort path is nominally
// exposed to (it checks the tree back out to the pre-rebase tip internally) — but hand-verified
// against this project's git (2.50.1) it turns out `--abort` never re-invokes `post-checkout`, so
// that hook alone can't tell the fixed code from the broken code; T4.10 already owns the hook this
// finding first pointed at. `reference-transaction` is the hook that does: hand-verified the same
// way, `--abort` fires it repeatedly while unwinding the rebase refs, and a `reference-transaction`
// that exits non-zero makes git itself fail the ref update ("fatal: ref updates aborted by hook",
// exit 128) — which is exactly `gitOk`'s trigger for an uncaught `GitError` crash, and leaves
// `rebase-merge` behind uncleaned since the abort never completed. `core.hooksPath=/dev/null`
// suppresses it the same way it suppresses every other hook class. Both hooks are planted so this
// also re-proves T4.10's case doesn't regress under `--abort` specifically.
test('T4.11 a failing reference-transaction/post-checkout hook never blocks the abort on a conflicting rebase', (t) => {
  const w = world(t)
  w.commit(w.b, { file: 'f.txt', content: 'from b\n', msg: 'b edits f' })
  w.git(w.b, 'push', 'origin', 'main')
  const preSyncTip = w.commit(w.a, { file: 'f.txt', content: 'from a\n', msg: 'a edits f' })

  for (const hook of ['post-checkout', 'reference-transaction']) {
    const hookPath = path.join(w.a, '.git', 'hooks', hook)
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.chmodSync(hookPath, 0o755)
  }

  const result = w.cli(w.a, ['sync'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'rebase-conflict')
  assert.deepEqual(result.json.detail.files, ['f.txt'])

  const ctx = w.ctx(w.a)
  assert.equal(fs.existsSync(path.join(ctx.gitDir, 'rebase-merge')), false)
  assert.equal(fs.existsSync(path.join(ctx.gitDir, 'rebase-apply')), false)
  assert.equal(w.git(w.a, 'status', '--porcelain'), '')
  assert.equal(w.git(w.a, 'rev-parse', 'main'), preSyncTip)
})
