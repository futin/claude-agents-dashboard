// Tests for the GitHub PR lookup (design.md §5, M4): `prLookup` is the one merge proof that comes from the host instead of the repo's own
// history, and the one signal (an open PR) that keeps a branch out of every deletion bucket regardless of what M1-M3 find. `gh` is always a
// PATH stub here (world.mjs's sandboxed PATH has no real one), so every case is driven by what the stub prints or how it fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { repo, prLookup, ghStatus } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

const BRANCH = 'feat/a'

test('T6.1 a MERGED PR whose head still equals the tip proves merged-at-tip', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: `${JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: tip, baseRefName: 'main' }])}\n` })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'merged-at-tip', number: 7 })
})

test('T6.2 a MERGED PR whose head has since moved on is not proof', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: `${JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: 'deadbeefcafe', baseRefName: 'main' }])}\n` })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'none', number: null })
})

test('T6.3 an OPEN PR wins over a MERGED one on the same branch', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', {
    stdout: `${JSON.stringify([
      { number: 7, state: 'MERGED', headRefOid: tip, baseRefName: 'main' },
      { number: 9, state: 'OPEN', headRefOid: tip, baseRefName: 'main' },
    ])}\n`,
  })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'open', number: 9 })
})

test('T6.4 gh not on PATH at all: prLookup is unavailable, ghStatus reads absent', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'unavailable', number: null })
  assert.equal(ghStatus(r), 'absent')
  assert.deepEqual(w.calls(), [])
})

test('T6.5 gh exits non-zero: prLookup is unavailable, ghStatus reads unavailable', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { exit: 1, stderr: 'gh: not authenticated\n' })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'unavailable', number: null })
  assert.equal(ghStatus(r), 'unavailable')
})

test('T6.6 gh prints something that is not JSON: prLookup and ghStatus are both unavailable', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: 'not json\n' })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'unavailable', number: null })
  assert.equal(ghStatus(r), 'unavailable')
})

test('T6.7 a GitLab remote never spawns gh at all', (t) => {
  const w = world(t, { host: 'gitlab.com' })
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: '[]' }) // present and would answer fine — must never be reached

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'none', number: null })
  assert.deepEqual(w.calls(), [])
})

test('T6.8 the branch travels as argv, not a shell string, and the spawn runs in the repo root', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: '[]' })

  prLookup(r, BRANCH, tip)

  const calls = w.calls()
  assert.equal(calls.length, 1)
  const [call] = calls
  const headIdx = call.argv.indexOf('--head')
  assert.notEqual(headIdx, -1)
  assert.equal(call.argv[headIdx + 1], BRANCH)
  // world.mjs: `git rev-parse --show-toplevel` (which `repo()` resolves through) resolves symlinks
  // (e.g. macOS's /tmp -> /private/tmp), so `repo.root` must be compared through the same resolution
  // rather than against w.a's own spelling.
  assert.equal(call.cwd, fs.realpathSync(w.a))
})

test('T6.9 a MERGED PR into a branch other than the trunk (a stacked PR) is not proof (R15)', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.stub('gh', { stdout: `${JSON.stringify([{ number: 7, state: 'MERGED', headRefOid: tip, baseRefName: 'feat/base' }])}\n` })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'none', number: null })
  const [call] = w.calls()
  assert.ok(call.argv[call.argv.indexOf('--json') + 1].split(',').includes('baseRefName'))
})

test('T6.10 a transient gh failure costs only its own branch: later lookups still spawn gh (R17)', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  const open = `${JSON.stringify([{ number: 3, state: 'OPEN', headRefOid: tip, baseRefName: 'main' }])}\n`
  w.stub('gh', { stdout: open, byArgs: { '--head one': { exit: 1, stderr: 'HTTP 502\n', stdout: '' } } })

  assert.deepEqual(prLookup(r, 'one', tip), { state: 'unavailable', number: null })
  assert.deepEqual(prLookup(r, 'two', tip), { state: 'open', number: 3 })
  assert.equal(w.calls().length, 2)
  // One success is enough to say gh works for this root, whichever order the answers came in.
  assert.equal(ghStatus(r), 'ok')
})

test('T6.11 gh absent is deterministic: once seen, later lookups do not look for it again', (t) => {
  const w = world(t)
  const r = repo(w.a, { env: w.env })
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  assert.equal(ghStatus(r), 'absent')
  // A stub appearing mid-run is never consulted: the cached ENOENT answers without a spawn.
  w.stub('gh', { stdout: '[]\n' })

  assert.deepEqual(prLookup(r, BRANCH, tip), { state: 'unavailable', number: null })
  assert.deepEqual(w.calls(), [])
})
