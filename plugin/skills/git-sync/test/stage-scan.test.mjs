// Tests for the `stage-scan` subcommand (design.md §4 phase 1, §8): `add -A` followed by a
// secret/junk guard over the staged set, restoring the index untouched whenever the guard trips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { world } from './world.mjs'

// Resolved once, the same way world.mjs resolves the real git binary, so the wrapper below can
// proxy through to it for every call it isn't deliberately failing.
const REAL_GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

// Installs a `git` on PATH, ahead of the world's own sandboxed one, that fails outright for any
// invocation whose argv contains `failMarker` and otherwise proxies straight through to the real
// binary — used to force a git failure at one exact, chosen point mid-scan (fixture-only; nothing
// in the engine itself is stubbed or bypassed). Returns the PATH to hand to `w.cli`'s `extraEnv`.
function pathWithFailingGit(w, failMarker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-failing-git-'))
  const script = [
    `#!${process.execPath}`,
    `const { spawnSync } = require('child_process')`,
    `const argv = process.argv.slice(2)`,
    `if (argv.includes(${JSON.stringify(failMarker)})) {`,
    `  process.stderr.write('simulated git failure\\n')`,
    `  process.exit(1)`,
    `}`,
    `const result = spawnSync(${JSON.stringify(REAL_GIT)}, argv, { stdio: 'inherit' })`,
    `process.exit(result.status ?? 1)`,
    '',
  ].join('\n')
  const file = path.join(dir, 'git')
  fs.writeFileSync(file, script, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return `${dir}:${w.env.PATH}`
}

test('T3.1 stages everything and reports names, stat, clean:false', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'README.md', content: 'orig\n', msg: 'add readme' })
  fs.writeFileSync(path.join(w.a, 'README.md'), 'updated\n')
  fs.mkdirSync(path.join(w.a, 'src'), { recursive: true })
  fs.writeFileSync(path.join(w.a, 'src', 'a.js'), 'export const a = 1\n')

  const result = w.cli(w.a, ['stage-scan'])
  assert.equal(result.status, 0)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.staged, ['README.md', 'src/a.js'])
  assert.equal(result.json.clean, false)

  const cached = w.git(w.a, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
  assert.deepEqual(cached, ['README.md', 'src/a.js'])
  assert.match(result.json.stat, /README\.md/)
  assert.match(result.json.stat, /a\.js/)
})

test('T3.2 secret-shaped paths: .env, a nested .env.local, .env.example alone is fine', (t) => {
  const dotEnv = world(t)
  fs.writeFileSync(path.join(dotEnv.a, '.env'), 'X=1\n')
  const dotEnvResult = dotEnv.cli(dotEnv.a, ['stage-scan'])
  assert.equal(dotEnvResult.json.ok, false)
  assert.equal(dotEnvResult.json.stop, 'secret-or-junk-staged')
  assert.deepEqual(dotEnvResult.json.detail.hits, [{ path: '.env', reason: 'secret-path' }])

  const nested = world(t)
  fs.mkdirSync(path.join(nested.a, 'config'), { recursive: true })
  fs.writeFileSync(path.join(nested.a, 'config', '.env.local'), 'X=1\n')
  const nestedResult = nested.cli(nested.a, ['stage-scan'])
  assert.equal(nestedResult.json.ok, false)
  assert.deepEqual(nestedResult.json.detail.hits, [{ path: 'config/.env.local', reason: 'secret-path' }])

  const example = world(t)
  fs.writeFileSync(path.join(example.a, '.env.example'), 'X=1\n')
  const exampleResult = example.cli(example.a, ['stage-scan'])
  assert.equal(exampleResult.json.ok, true)
  assert.deepEqual(exampleResult.json.staged, ['.env.example'])
})

// R10: planted tokens are built at runtime, split across the concatenation boundary a plain
// string search would key on, so no literal secret-shaped token ever sits whole in this source.
test('T3.3 secret-shaped content, one hit per pattern, planted token never reaches stdout', (t) => {
  const privateKeyLine = '-----BEGIN' + ' RSA PRIVATE KEY-----'
  const pemWorld = world(t)
  fs.writeFileSync(path.join(pemWorld.a, 'key.txt'), `${privateKeyLine}\nMIIBogIBAAKCAQ==\n`)
  const pemResult = pemWorld.cli(pemWorld.a, ['stage-scan'])
  assert.equal(pemResult.json.ok, false)
  assert.deepEqual(pemResult.json.detail.hits, [{ path: 'key.txt', reason: 'secret-content:private-key' }])
  assert.ok(!pemResult.stdout.includes(privateKeyLine))

  const awsToken = 'AK' + 'IA' + '1234ABCD1234ABCD'
  const awsWorld = world(t)
  fs.writeFileSync(path.join(awsWorld.a, 'notes.txt'), `key=${awsToken}\n`)
  const awsResult = awsWorld.cli(awsWorld.a, ['stage-scan'])
  assert.equal(awsResult.json.ok, false)
  assert.deepEqual(awsResult.json.detail.hits, [{ path: 'notes.txt', reason: 'secret-content:aws' }])
  assert.ok(!awsResult.stdout.includes(awsToken))

  const ghToken = 'gh' + 'p_' + 'a'.repeat(36)
  const ghWorld = world(t)
  fs.writeFileSync(path.join(ghWorld.a, 'notes.txt'), `token=${ghToken}\n`)
  const ghResult = ghWorld.cli(ghWorld.a, ['stage-scan'])
  assert.equal(ghResult.json.ok, false)
  assert.deepEqual(ghResult.json.detail.hits, [{ path: 'notes.txt', reason: 'secret-content:github' }])
  assert.ok(!ghResult.stdout.includes(ghToken))

  const anthToken = 'sk-' + 'ant-' + 'a'.repeat(24)
  const anthWorld = world(t)
  fs.writeFileSync(path.join(anthWorld.a, 'notes.txt'), `token=${anthToken}\n`)
  const anthResult = anthWorld.cli(anthWorld.a, ['stage-scan'])
  assert.equal(anthResult.json.ok, false)
  assert.deepEqual(anthResult.json.detail.hits, [{ path: 'notes.txt', reason: 'secret-content:anthropic' }])
  assert.ok(!anthResult.stdout.includes(anthToken))
})

test('T3.4 junk paths and the too-large blob-size threshold', (t) => {
  // The seed world's committed .gitignore excludes node_modules/; removing it is what makes this
  // world "no .gitignore" the way the brief means it, so add -A actually stages the junk path.
  const junkPath = world(t)
  fs.rmSync(path.join(junkPath.a, '.gitignore'))
  fs.mkdirSync(path.join(junkPath.a, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(junkPath.a, 'node_modules', 'x', 'index.js'), 'module.exports = {}\n')
  const junkPathResult = junkPath.cli(junkPath.a, ['stage-scan'])
  assert.equal(junkPathResult.json.ok, false)
  assert.deepEqual(junkPathResult.json.detail.hits, [{ path: 'node_modules/x/index.js', reason: 'junk-path' }])

  const dsStore = world(t)
  fs.writeFileSync(path.join(dsStore.a, '.DS_Store'), 'binarylike\n')
  const dsStoreResult = dsStore.cli(dsStore.a, ['stage-scan'])
  assert.equal(dsStoreResult.json.ok, false)
  assert.deepEqual(dsStoreResult.json.detail.hits, [{ path: '.DS_Store', reason: 'junk-path' }])

  const tooLarge = world(t)
  fs.writeFileSync(path.join(tooLarge.a, 'big.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
  const tooLargeResult = tooLarge.cli(tooLarge.a, ['stage-scan'])
  assert.equal(tooLargeResult.json.ok, false)
  assert.deepEqual(tooLargeResult.json.detail.hits, [{ path: 'big.bin', reason: 'too-large' }])

  const okSize = world(t)
  fs.writeFileSync(path.join(okSize.a, 'ok.bin'), Buffer.alloc(10 * 1024 * 1024))
  const okSizeResult = okSize.cli(okSize.a, ['stage-scan'])
  assert.equal(okSizeResult.json.ok, true)
  assert.deepEqual(okSizeResult.json.staged, ['ok.bin'])
})

test('T3.5 a hit restores the index exactly: staged-by-hand, unstaged-modified and untracked all survive untouched', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'a.txt', content: 'orig a\n', msg: 'add a' })
  w.commit(w.a, { file: 'b.txt', content: 'orig b\n', msg: 'add b' })

  fs.writeFileSync(path.join(w.a, 'a.txt'), 'staged a\n')
  w.git(w.a, 'add', 'a.txt')

  fs.writeFileSync(path.join(w.a, 'b.txt'), 'unstaged b\n')
  fs.writeFileSync(path.join(w.a, '.env'), 'X=1\n')

  const result = w.cli(w.a, ['stage-scan'])
  assert.equal(result.json.ok, false)
  assert.equal(result.json.stop, 'secret-or-junk-staged')

  assert.equal(w.git(w.a, 'diff', '--cached', '--name-only'), 'a.txt')

  const status = w.git(w.a, 'status', '--porcelain')
  assert.match(status, /^M {2}a\.txt$/m, `a.txt should stay staged exactly as before: ${status}`)
  assert.match(status, /^ M b\.txt$/m, `b.txt should stay modified-unstaged: ${status}`)
  assert.match(status, /^\?\? \.env$/m, `.env should stay untracked: ${status}`)
  assert.ok(fs.existsSync(path.join(w.a, '.env')))
})

test('T3.6 clean tree: ok, staged empty, clean:true', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['stage-scan'])
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.staged, [])
  assert.equal(result.json.clean, true)
  assert.equal(result.json.stat, '')
})

// Fix round 1, Critical: a hostile `diff.external` (or `GIT_EXTERNAL_DIFF`) must not be able to
// swallow the whole diff body and hide a secret from the content rules. `diff.noprefix` and a
// hostile `color.ui=always` are piled on the same world since none of the three should change the
// outcome (Review Focus 4's "hostile git config" concern).
test('T3.7 hostile diff.external (config and env var) cannot hide a secret from the content scan', (t) => {
  const ghToken = 'gh' + 'p_' + 'a'.repeat(36)

  const configWorld = world(t)
  const externalScript = path.join(configWorld.root, 'silent-diff.sh')
  fs.writeFileSync(externalScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.chmodSync(externalScript, 0o755)
  configWorld.git(configWorld.a, 'config', 'diff.external', externalScript)
  configWorld.git(configWorld.a, 'config', 'diff.noprefix', 'true')
  configWorld.git(configWorld.a, 'config', 'color.ui', 'always')
  fs.writeFileSync(path.join(configWorld.a, 'notes.txt'), `token=${ghToken}\n`)
  const configResult = configWorld.cli(configWorld.a, ['stage-scan'])
  assert.equal(configResult.json.ok, false)
  assert.deepEqual(configResult.json.detail.hits, [{ path: 'notes.txt', reason: 'secret-content:github' }])

  const envWorld = world(t)
  fs.writeFileSync(path.join(envWorld.a, 'notes.txt'), `token=${ghToken}\n`)
  const envResult = envWorld.cli(envWorld.a, ['stage-scan'], { GIT_EXTERNAL_DIFF: externalScript })
  assert.equal(envResult.json.ok, false)
  assert.deepEqual(envResult.json.detail.hits, [{ path: 'notes.txt', reason: 'secret-content:github' }])
})

// Fix round 1, Important: any git failure once `add -A` has run — not just a detected hit — must
// still restore the index and emit an ok:false envelope rather than crash. Forced with a PATH
// wrapper that fails only the one diff call that scans `broken.txt`'s content, so `write-tree`,
// `add -A` and the `--name-only` listing all run for real first.
test('T3.8 a git failure mid-scan restores the index and still emits an ok:false envelope', (t) => {
  const w = world(t)
  fs.writeFileSync(path.join(w.a, 'broken.txt'), 'hello world\n')

  const beforeHead = w.git(w.a, 'rev-parse', 'HEAD')
  const beforeStatus = w.git(w.a, 'status', '--porcelain')

  const result = w.cli(w.a, ['stage-scan'], { PATH: pathWithFailingGit(w, 'broken.txt') })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.cmd, 'stage-scan')
  assert.ok(result.json.stop, 'must emit a stop, not crash')

  assert.equal(w.git(w.a, 'rev-parse', 'HEAD'), beforeHead)
  assert.equal(w.git(w.a, 'diff', '--cached', '--name-only'), '')
  assert.equal(w.git(w.a, 'status', '--porcelain'), beforeStatus)
})

// Fix round 1, Minor: a filename with a space must not desync from its content match now that
// content scanning is per-path rather than reattributed from a parsed `+++ b/<path>` header.
test('T3.9 a filename with a space still matches its own planted content', (t) => {
  const w = world(t)
  const ghToken = 'gh' + 'p_' + 'a'.repeat(36)
  fs.writeFileSync(path.join(w.a, 'my notes.txt'), `token=${ghToken}\n`)
  const result = w.cli(w.a, ['stage-scan'])
  assert.equal(result.json.ok, false)
  assert.deepEqual(result.json.detail.hits, [{ path: 'my notes.txt', reason: 'secret-content:github' }])
})

// R35 (final review I1): a tree object carries no index flags, so a `write-tree`/`read-tree` round trip drops skip-worktree and assume-unchanged
// bits and loses intent-to-add entries outright. The restore must put the index file itself back, so every flag survives byte for byte.
function flaggedIndexWorld(t) {
  const w = world(t)
  w.commit(w.a, { file: 'sparse.txt', content: 'tracked sparse\n', msg: 'add sparse' })
  w.commit(w.a, { file: 'creds.conf', content: 'password=placeholder\n', msg: 'add creds' })
  w.git(w.a, 'update-index', '--skip-worktree', 'sparse.txt')
  w.git(w.a, 'update-index', '--assume-unchanged', 'creds.conf')
  fs.writeFileSync(path.join(w.a, 'creds.conf'), 'password=local-only\n')
  fs.writeFileSync(path.join(w.a, 'planned.txt'), 'not yet\n')
  w.git(w.a, 'add', '-N', 'planned.txt')
  return w
}

function indexSnapshot(w) {
  return {
    flags: w.git(w.a, 'ls-files', '-v'),
    stage: w.git(w.a, 'ls-files', '--stage'),
    bytes: fs.readFileSync(path.join(w.a, '.git', 'index')).toString('base64'),
  }
}

test('T3.10 a hit restores skip-worktree, assume-unchanged and intent-to-add entries byte for byte (R35)', (t) => {
  const w = flaggedIndexWorld(t)
  const before = indexSnapshot(w)
  assert.match(before.flags, /^S sparse\.txt$/m, 'fixture: skip-worktree set')
  assert.match(before.flags, /^h creds\.conf$/m, 'fixture: assume-unchanged set')
  assert.match(before.stage, /\tplanned\.txt$/m, 'fixture: intent-to-add entry present')

  fs.writeFileSync(path.join(w.a, '.env'), 'X=1\n')
  const result = w.cli(w.a, ['stage-scan'])
  assert.equal(result.json.stop, 'secret-or-junk-staged')

  assert.deepEqual(indexSnapshot(w), before)
  assert.deepEqual(fs.readdirSync(path.join(w.a, '.git')).filter((n) => n.startsWith('index') && n !== 'index'), [], 'no snapshot file left behind')
})

test('T3.11 a scan-failed restore keeps the index flags too (R35)', (t) => {
  const w = flaggedIndexWorld(t)
  const before = indexSnapshot(w)
  fs.writeFileSync(path.join(w.a, 'broken.txt'), 'hello world\n')

  const result = w.cli(w.a, ['stage-scan'], { PATH: pathWithFailingGit(w, 'broken.txt') })
  assert.equal(result.json.stop, 'scan-failed')
  assert.deepEqual(indexSnapshot(w), before)
})

test('T3.12 GIT_INDEX_FILE is the index that is snapshotted and restored (R35)', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'a.txt', content: 'a\n', msg: 'add a' })
  const alt = path.join(w.root, 'alt-index')
  fs.copyFileSync(path.join(w.a, '.git', 'index'), alt)
  const altEnv = { GIT_INDEX_FILE: alt }
  spawnSync('git', ['-C', w.a, 'update-index', '--assume-unchanged', 'a.txt'], { env: { ...w.env, ...altEnv } })
  const altBefore = fs.readFileSync(alt).toString('base64')
  const mainBefore = fs.readFileSync(path.join(w.a, '.git', 'index')).toString('base64')
  assert.notEqual(altBefore, mainBefore, 'fixture: the two indexes differ')

  fs.writeFileSync(path.join(w.a, '.env'), 'X=1\n')
  const result = w.cli(w.a, ['stage-scan'], altEnv)
  assert.equal(result.json.stop, 'secret-or-junk-staged')
  assert.equal(fs.readFileSync(alt).toString('base64'), altBefore)
  assert.equal(fs.readFileSync(path.join(w.a, '.git', 'index')).toString('base64'), mainBefore)
})
