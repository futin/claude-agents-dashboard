// Tests for the `push-trunk` subcommand (design.md §4 phase 6, §10.6): push the trunk only when
// verify.json is green (or unverified) for the exact trunk HEAD SHA, and only when the repo's
// push rules allow it. Not pushing is a normal outcome, not a stop — every case here is `ok: true`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { world } from './world.mjs'

function writePackageJson(dir, scripts) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }))
}

// The fixture's origin is bare, so its branch tips are read directly by name rather than through
// a remote-tracking ref.
function originTip(w, branch) {
  return w.git(w.origin, 'rev-parse', branch)
}

test('T10.1 one unpushed trunk commit, green verify: pushed, origin catches up to a', (t) => {
  const w = world(t)
  writePackageJson(w.a, { test: 'x' })
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', { stdout: 'ok\n' })
  const sha = w.commit(w.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })

  const verifyResult = w.cli(w.a, ['verify'])
  assert.equal(verifyResult.json.status, 'green')

  const pushResult = w.cli(w.a, ['push-trunk'])
  assert.equal(pushResult.json.ok, true)
  assert.equal(pushResult.json.pushed, true)
  assert.equal(pushResult.json.reason, 'pushed')
  assert.equal(pushResult.json.ahead, 1)
  assert.equal(originTip(w, 'main'), sha)
})

test('T10.2 red, stale, and missing verify all refuse without touching origin', (t) => {
  const w = world(t)
  const before = originTip(w, 'main')
  writePackageJson(w.a, { test: 'x' })
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', { stdout: 'ok\n', byArgs: { 'run test': { exit: 1, stderr: 'boom\n' } } })
  w.commit(w.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })

  const redVerify = w.cli(w.a, ['verify'])
  assert.equal(redVerify.json.status, 'red')
  const redPush = w.cli(w.a, ['push-trunk'])
  assert.equal(redPush.json.ok, true)
  assert.equal(redPush.json.pushed, false)
  assert.equal(redPush.json.reason, 'red')
  assert.equal(originTip(w, 'main'), before)

  // A commit lands after that verify recorded — verify.json's sha no longer equals trunk HEAD.
  w.stub('npm', { stdout: 'ok\n' })
  w.cli(w.a, ['verify']) // re-verify green, sha == current head
  w.commit(w.a, { file: 'feature2.txt', content: 'y\n', msg: 'add feature 2' })
  const stalePush = w.cli(w.a, ['push-trunk'])
  assert.equal(stalePush.json.ok, true)
  assert.equal(stalePush.json.pushed, false)
  assert.equal(stalePush.json.reason, 'stale-verify')
  assert.equal(originTip(w, 'main'), before)

  // verify.json removed entirely.
  const ctx = w.ctx(w.a)
  fs.rmSync(path.join(ctx.stateDir, 'verify.json'))
  const noVerifyPush = w.cli(w.a, ['push-trunk'])
  assert.equal(noVerifyPush.json.ok, true)
  assert.equal(noVerifyPush.json.pushed, false)
  assert.equal(noVerifyPush.json.reason, 'no-verify')
  assert.equal(originTip(w, 'main'), before)
})

test('T10.3 unverified (no discoverable checks) still pushes', (t) => {
  const w = world(t)
  const sha = w.commit(w.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })

  const verifyResult = w.cli(w.a, ['verify'])
  assert.equal(verifyResult.json.status, 'unverified')

  const pushResult = w.cli(w.a, ['push-trunk'])
  assert.equal(pushResult.json.pushed, true)
  assert.equal(pushResult.json.reason, 'pushed')
  assert.equal(originTip(w, 'main'), sha)
})

test('T10.4 push not allowed: GitLab remote, and GitHub remote with git-sync.push=false', (t) => {
  const gl = world(t, { host: 'gitlab.example.com' })
  const glBefore = originTip(gl, 'main')
  gl.commit(gl.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })
  gl.cli(gl.a, ['verify'])
  const glPush = gl.cli(gl.a, ['push-trunk'])
  assert.equal(glPush.json.ok, true)
  assert.equal(glPush.json.pushed, false)
  assert.equal(glPush.json.reason, 'not-allowed')
  assert.equal(originTip(gl, 'main'), glBefore)

  const gh = world(t)
  gh.git(gh.a, 'config', 'git-sync.push', 'false')
  const ghBefore = originTip(gh, 'main')
  gh.commit(gh.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })
  gh.cli(gh.a, ['verify'])
  const ghPush = gh.cli(gh.a, ['push-trunk'])
  assert.equal(ghPush.json.ok, true)
  assert.equal(ghPush.json.pushed, false)
  assert.equal(ghPush.json.reason, 'not-allowed')
  assert.equal(originTip(gh, 'main'), ghBefore)
})

test('T10.5 nothing ahead: nothing-to-push, ahead 0', (t) => {
  const w = world(t)
  w.cli(w.a, ['verify'])
  const before = originTip(w, 'main')

  const pushResult = w.cli(w.a, ['push-trunk'])
  assert.equal(pushResult.json.ok, true)
  assert.equal(pushResult.json.pushed, false)
  assert.equal(pushResult.json.reason, 'nothing-to-push')
  assert.equal(pushResult.json.ahead, 0)
  assert.equal(originTip(w, 'main'), before)
})

test('T10.6 b pushed to origin in the meantime: rejected, origin keeps b\'s tip', (t) => {
  const w = world(t)
  const aSha = w.commit(w.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })
  w.cli(w.a, ['verify']) // unverified, sha == aSha, recorded before b's push below

  // b, a second clone of the same origin, pushes its own commit first — a never fetches, so its
  // `refs/remotes/origin/main` stays the stale tip it cloned, exactly what T10.6 relies on.
  const bSha = w.commit(w.b, { file: 'other.txt', content: 'y\n', msg: 'b commit' })
  w.git(w.b, 'push', 'origin', 'main')
  assert.equal(originTip(w, 'main'), bSha)

  const pushResult = w.cli(w.a, ['push-trunk'])
  assert.equal(pushResult.json.ok, true)
  assert.equal(pushResult.json.pushed, false)
  assert.equal(pushResult.json.reason, 'rejected')
  assert.equal(originTip(w, 'main'), bSha)
  assert.notEqual(originTip(w, 'main'), aSha)
})

// R21: a trunk with no local `refs/remotes/origin/<trunk>` at all (never fetched, or no upstream)
// must not crash `rev-list`'s unresolvable `A..B` range — it's reported as an ordinary refusal.
test('T10.7 no remote-tracking ref for the trunk: rejected, ahead null, origin unchanged', (t) => {
  const w = world(t)
  const before = originTip(w, 'main')
  w.commit(w.a, { file: 'feature.txt', content: 'x\n', msg: 'add feature' })
  w.cli(w.a, ['verify'])
  w.git(w.a, 'update-ref', '-d', 'refs/remotes/origin/main')

  const pushResult = w.cli(w.a, ['push-trunk'])
  assert.equal(pushResult.json.ok, true)
  assert.equal(pushResult.json.pushed, false)
  assert.equal(pushResult.json.reason, 'rejected')
  assert.equal(pushResult.json.ahead, null)
  assert.equal(pushResult.json.detail, 'no remote-tracking ref origin/main')
  assert.equal(originTip(w, 'main'), before)
})
