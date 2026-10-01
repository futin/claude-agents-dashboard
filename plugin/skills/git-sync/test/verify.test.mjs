// Tests for the `verify` subcommand (design.md §9): check discovery (`discoverChecks`), the
// install decision (`installFor`), and the subcommand itself — install if needed, run every
// discovered check even after one fails, log each one, and roll the results up into a status.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { discoverChecks, installFor } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

// discoverChecks/installFor work off a plain directory — no git repo needed — so their own unit
// tests use a bare temp dir rather than a full world.
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-checks-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writePackageJson(dir, scripts) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }))
}

test('T9.1 discoverChecks: package manager by lockfile, script names in typecheck/lint/test order', (t) => {
  const pnpmDir = tmpDir(t)
  fs.writeFileSync(path.join(pnpmDir, 'pnpm-lock.yaml'), '')
  writePackageJson(pnpmDir, { test: 'x', lint: 'y', typecheck: 'z' })
  const pnpmChecks = discoverChecks(pnpmDir, {})
  assert.deepEqual(pnpmChecks.map((c) => c.name), ['typecheck', 'lint', 'test'])
  assert.ok(pnpmChecks.every((c) => c.cmd === 'pnpm' && c.shell === false))
  assert.deepEqual(pnpmChecks[0].args, ['run', 'typecheck'])

  const yarnDir = tmpDir(t)
  fs.writeFileSync(path.join(yarnDir, 'yarn.lock'), '')
  writePackageJson(yarnDir, { test: 'x' })
  assert.equal(discoverChecks(yarnDir, {})[0].cmd, 'yarn')

  const npmDir = tmpDir(t)
  fs.writeFileSync(path.join(npmDir, 'package-lock.json'), '')
  writePackageJson(npmDir, { test: 'x' })
  assert.equal(discoverChecks(npmDir, {})[0].cmd, 'npm')

  const bunDir = tmpDir(t)
  fs.writeFileSync(path.join(bunDir, 'bun.lockb'), '')
  writePackageJson(bunDir, { test: 'x' })
  assert.equal(discoverChecks(bunDir, {})[0].cmd, 'bun')

  const noLockfileDir = tmpDir(t)
  writePackageJson(noLockfileDir, { test: 'x' })
  assert.equal(discoverChecks(noLockfileDir, {})[0].cmd, 'npm')

  const typeCheckDir = tmpDir(t)
  writePackageJson(typeCheckDir, { 'type-check': 'z', test: 'x' })
  assert.deepEqual(discoverChecks(typeCheckDir, {}).map((c) => c.name), ['type-check', 'test'])
})

test('T9.2 discoverChecks: Makefile targets, no marker means no checks, package.json falls through to Makefile', (t) => {
  const mkDir = tmpDir(t)
  fs.writeFileSync(path.join(mkDir, 'Makefile'), 'build:\n\techo build\nlint:\n\techo lint\ntest:\n\techo test\n')
  const mkChecks = discoverChecks(mkDir, {})
  assert.deepEqual(mkChecks.map((c) => c.name), ['lint', 'test'])
  assert.deepEqual(mkChecks.map((c) => `${c.cmd} ${c.args.join(' ')}`), ['make lint', 'make test'])

  const onlyBuildDir = tmpDir(t)
  fs.writeFileSync(path.join(onlyBuildDir, 'Makefile'), 'build:\n\techo build\n')
  assert.deepEqual(discoverChecks(onlyBuildDir, {}), [])

  const fallthroughDir = tmpDir(t)
  writePackageJson(fallthroughDir, { build: 'x' })
  fs.writeFileSync(path.join(fallthroughDir, 'Makefile'), 'test:\n\techo test\n')
  const fallthroughChecks = discoverChecks(fallthroughDir, {})
  assert.deepEqual(fallthroughChecks.map((c) => c.name), ['test'])
  assert.equal(fallthroughChecks[0].cmd, 'make')
})

test('T9.3 discoverChecks: pytest via pytest.ini or pyproject.toml [tool.pytest, uv when uv.lock present', (t) => {
  const iniDir = tmpDir(t)
  fs.writeFileSync(path.join(iniDir, 'pytest.ini'), '[pytest]\n')
  assert.deepEqual(discoverChecks(iniDir, {}), [{ name: 'test', cmd: 'python', args: ['-m', 'pytest', '-q'], shell: false }])

  const uvDir = tmpDir(t)
  fs.writeFileSync(path.join(uvDir, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
  fs.writeFileSync(path.join(uvDir, 'uv.lock'), '')
  assert.deepEqual(discoverChecks(uvDir, {}), [{ name: 'test', cmd: 'uv', args: ['run', 'pytest', '-q'], shell: false }])

  const noneDir = tmpDir(t)
  fs.writeFileSync(path.join(noneDir, 'pyproject.toml'), '[tool.black]\n')
  assert.deepEqual(discoverChecks(noneDir, {}), [])
})

test('T9.4 git-sync.checks overrides discovery with one shell check, even beside a package.json', (t) => {
  const dir = tmpDir(t)
  writePackageJson(dir, { test: 'x' })
  const checks = discoverChecks(dir, { checks: 'make ci' })
  assert.deepEqual(checks, [{ name: 'custom', cmd: 'make ci', args: [], shell: true }])
})

test('T9.5 green: discovered checks run in order with CI=1, no install needed, each logged', (t) => {
  const w = world(t)
  writePackageJson(w.a, { typecheck: 'x', lint: 'y', test: 'z' })
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', { stdout: 'ok\n' })

  const result = w.cli(w.a, ['verify'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.status, 'green')
  assert.equal(result.json.install, null)

  const calls = w.calls()
  assert.deepEqual(calls.map((c) => c.argv.join(' ')), ['run typecheck', 'run lint', 'run test'])
  assert.ok(calls.every((c) => c.ci === '1'))

  const ctx = w.ctx(w.a)
  for (const name of ['typecheck', 'lint', 'test']) {
    assert.ok(fs.existsSync(path.join(ctx.stateDir, `check-${name}.log`)))
  }
})

test('T9.6 red: one check fails, the others still run, the failing log holds its stderr', (t) => {
  const w = world(t)
  writePackageJson(w.a, { typecheck: 'x', lint: 'y', test: 'z' })
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', { stdout: 'ok\n', byArgs: { 'run test': { exit: 1, stderr: 'boom\n' } } })

  const result = w.cli(w.a, ['verify'])
  assert.equal(result.json.status, 'red')
  const byName = Object.fromEntries(result.json.checks.map((c) => [c.name, c]))
  assert.equal(byName.typecheck.exit, 0)
  assert.equal(byName.lint.exit, 0)
  assert.equal(byName.test.exit, 1)
  assert.match(fs.readFileSync(byName.test.log, 'utf8'), /boom/)
})

test('T9.7 no discoverable checks: unverified, empty checks array', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['verify'])
  assert.equal(result.json.ok, true)
  assert.equal(result.json.status, 'unverified')
  assert.deepEqual(result.json.checks, [])
  assert.equal(result.json.install, null)
})

test('T9.8 install: node_modules missing, then lockfile-changed, then a failed install skips checks', (t) => {
  const missing = world(t)
  writePackageJson(missing.a, { test: 'x' })
  missing.stub('npm', { stdout: 'installed\n' })
  const missingResult = missing.cli(missing.a, ['verify'])
  assert.equal(missingResult.json.install.reason, 'node_modules-missing')
  assert.equal(missingResult.json.install.exit, 0)
  assert.equal(missingResult.json.status, 'green')
  assert.deepEqual(missing.calls().map((c) => c.argv.join(' ')), ['ci', 'run test'])

  const changed = world(t)
  const beforeSha = changed.commit(changed.a, { file: 'package-lock.json', content: '{"v":1}\n', msg: 'lockfile v1' })
  writePackageJson(changed.a, { test: 'x' })
  changed.git(changed.a, 'add', 'package.json')
  changed.git(changed.a, 'commit', '-m', 'add package.json')
  fs.mkdirSync(path.join(changed.a, 'node_modules'), { recursive: true })
  changed.commit(changed.a, { file: 'package-lock.json', content: '{"v":2}\n', msg: 'lockfile v2' })
  const changedCtx = changed.ctx(changed.a)
  fs.mkdirSync(changedCtx.stateDir, { recursive: true })
  fs.writeFileSync(path.join(changedCtx.stateDir, 'preflight.json'), JSON.stringify({ startHead: beforeSha }))
  changed.stub('npm', { stdout: 'installed\n' })
  const changedResult = changed.cli(changed.a, ['verify'])
  assert.equal(changedResult.json.install.reason, 'lockfile-changed')
  assert.equal(changedResult.json.status, 'green')

  const failedInstall = world(t)
  writePackageJson(failedInstall.a, { test: 'x' })
  failedInstall.stub('npm', { exit: 1, stderr: 'install failed\n' })
  const failedResult = failedInstall.cli(failedInstall.a, ['verify'])
  assert.equal(failedResult.json.status, 'red')
  assert.equal(failedResult.json.install.exit, 1)
  assert.deepEqual(failedResult.json.checks, [])
  assert.deepEqual(failedInstall.calls().map((c) => c.argv.join(' ')), ['ci'])
})

test('T9.9 a hung check is killed at the overridden timeout and the call still returns in well under 3s', (t) => {
  const w = world(t)
  writePackageJson(w.a, { test: 'x' })
  fs.mkdirSync(path.join(w.a, 'node_modules'), { recursive: true })
  w.stub('npm', { sleepMs: 3000 })

  const start = Date.now()
  const result = w.cli(w.a, ['verify'], { GIT_SYNC_CHECK_TIMEOUT_MS: '200' })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3000, `expected the whole call to return in under 3s, took ${elapsed}ms`)
  assert.equal(result.json.status, 'red')
  assert.equal(result.json.checks[0].timedOut, true)
})

test('T9.10 .nvmrc warns only when it names a numeric version whose components do not prefix-match active node', (t) => {
  const mismatch = world(t)
  fs.writeFileSync(path.join(mismatch.a, '.nvmrc'), '1\n')
  mismatch.stub('node', { stdout: 'v22.5.0\n' })
  const mismatchResult = mismatch.cli(mismatch.a, ['verify'])
  assert.deepEqual(mismatchResult.json.warnings, ['.nvmrc wants 1, active node is v22.5.0'])

  const match = world(t)
  fs.writeFileSync(path.join(match.a, '.nvmrc'), '22\n')
  match.stub('node', { stdout: 'v22.5.0\n' })
  const matchResult = match.cli(match.a, ['verify'])
  assert.deepEqual(matchResult.json.warnings, [])

  const ltsIron = world(t)
  fs.writeFileSync(path.join(ltsIron.a, '.nvmrc'), 'lts/iron\n')
  ltsIron.stub('node', { stdout: 'v22.5.0\n' })
  const ltsIronResult = ltsIron.cli(ltsIron.a, ['verify'])
  assert.deepEqual(ltsIronResult.json.warnings, [])
})

test('T9.11 verify.json sha equals rev-parse HEAD', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['verify'])
  assert.equal(result.json.sha, w.git(w.a, 'rev-parse', 'HEAD'))
})

// Final review Minor 3 (T9 install): the install belongs to the Node checks, so it runs only when those are the checks verify chose. A packaging-only
// package.json beside a Makefile, or `git-sync.checks` beside a full one, must never turn a run red over an install nobody's checks needed.
test('T9.12 install runs only when the chosen checks came from package.json', (t) => {
  const makeWorld = world(t)
  writePackageJson(makeWorld.a, { build: 'x' })
  fs.writeFileSync(path.join(makeWorld.a, 'Makefile'), 'test:\n\ttrue\n')
  makeWorld.stub('npm', { exit: 1, stderr: 'install failed\n' })
  makeWorld.stub('make', { stdout: 'ok\n' })
  const makeResult = makeWorld.cli(makeWorld.a, ['verify'])
  assert.equal(makeResult.json.install, null)
  assert.equal(makeResult.json.status, 'green')
  assert.deepEqual(makeWorld.calls().map((c) => c.name), ['make'])

  const customWorld = world(t)
  writePackageJson(customWorld.a, { test: 'x' })
  customWorld.git(customWorld.a, 'config', 'git-sync.checks', 'true')
  customWorld.stub('npm', { exit: 1, stderr: 'install failed\n' })
  const customResult = customWorld.cli(customWorld.a, ['verify'])
  assert.equal(customResult.json.install, null)
  assert.equal(customResult.json.status, 'green')
  assert.deepEqual(customWorld.calls(), [])
})

// Final review Minor 1 (T9 group kill): a check whose shell exits 0 at once but leaves a backgrounded grandchild holding stdout makes spawnSync wait
// out the timeout and report `error.code: 'ETIMEDOUT'` with no signal. That is a timeout, never green, and the grandchild is swept with the group.
test('T9.13 a grandchild holding stdout past the timeout is a timeout, and the group is killed', (t) => {
  const w = world(t)
  const pidFile = path.join(w.root, 'grandchild.pid')
  let grandchild = null
  t.after(() => {
    if (grandchild === null) return
    try {
      process.kill(grandchild, 'SIGKILL')
    } catch {
      // Already gone, which is what the test asserts.
    }
  })
  w.git(w.a, 'config', 'git-sync.checks', `/bin/sleep 30 & echo $! > '${pidFile}'; exit 0`)

  const result = w.cli(w.a, ['verify'], { GIT_SYNC_CHECK_TIMEOUT_MS: '500' })
  grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim())
  assert.equal(result.json.status, 'red')
  assert.equal(result.json.checks[0].timedOut, true)

  let alive = true
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(grandchild, 0)
      spawnSync('/bin/sleep', ['0.05'])
    } catch {
      alive = false
    }
  }
  assert.equal(alive, false, `grandchild ${grandchild} survived the timeout`)
})

// Final review Minor 2: a check whose binary cannot be launched at all must still leave something in its log for SKILL.md's "read the tail" step.
test('T9.14 a check that cannot be spawned logs why', (t) => {
  const w = world(t)
  fs.writeFileSync(path.join(w.a, 'Makefile'), 'test:\n\ttrue\n')
  const result = w.cli(w.a, ['verify'])
  assert.equal(result.json.status, 'red')
  assert.match(fs.readFileSync(result.json.checks[0].log, 'utf8'), /ENOENT/)
})
