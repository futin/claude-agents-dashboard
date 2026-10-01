import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { git, readState, writeState } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

const CLI_PATH = fileURLToPath(new URL('../tools/git-sync.mjs', import.meta.url))

test('T1.1 source guard: no process.exit(, ends with process.exitCode = main(', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8')
  assert.ok(!src.includes('process.exit('), 'must never call process.exit(')
  const lines = src.split('\n').filter((line) => line.trim() !== '')
  assert.match(lines[lines.length - 1], /^process\.exitCode = main\(/)
})

test('T1.2 unknown subcommand exits 1 with a stderr message and empty stdout', (t) => {
  const w = world(t)
  const result = w.cli(w.a, ['bogus'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown command: bogus/)
  assert.equal(result.stdout, '')
})

test('T1.3 a known subcommand outside a repo stops not-a-repo', (t) => {
  const w = world(t)
  const result = w.cli(w.root, ['preflight'])
  assert.equal(result.status, 2)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.cmd, 'preflight')
  assert.equal(result.json.stop, 'not-a-repo')
  assert.ok('detail' in result.json)
})

test('T1.4 world sanity: raw remote url, working fetch, spaced root, sandboxed PATH', (t) => {
  const w = world(t)

  assert.equal(w.git(w.a, 'config', 'remote.origin.url'), 'git@github.com:example/demo.git')
  assert.doesNotThrow(() => w.git(w.a, 'fetch'))
  assert.ok(w.root.includes(' '))

  const before = spawnSync('sh', ['-c', 'command -v gh'], { env: w.env })
  assert.notEqual(before.status, 0)
  w.stub('gh')
  const after = spawnSync('sh', ['-c', 'command -v gh'], { env: w.env })
  assert.equal(after.status, 0)
})

test('T1.5 the runner overrides a hostile color.ui=always', (t) => {
  const w = world(t)
  w.git(w.a, 'config', '--global', 'color.ui', 'always')

  const result = git(w.a, ['branch', '--list'], { env: w.env })
  assert.equal(result.status, 0)
  assert.ok(!result.stdout.includes('\u001b['), `expected no ANSI escapes, got: ${JSON.stringify(result.stdout)}`)
})

test('T1.6 writeState/readState round-trip under <commonDir>/git-sync', (t) => {
  const w = world(t)
  const ctx = w.ctx(w.a)

  assert.equal(readState(ctx, 'missing'), null)
  writeState(ctx, 'x', { hello: 'world' })
  assert.deepEqual(readState(ctx, 'x'), { hello: 'world' })
  assert.ok(fs.existsSync(path.join(ctx.commonDir, 'git-sync', 'x.json')))
})

test('symlinked invocation still runs main() (regression: import.meta.url vs argv realpath)', (t) => {
  const w = world(t)
  const toolsDir = path.dirname(CLI_PATH)
  const linkDir = path.join(w.root, 'skill-link')
  fs.symlinkSync(toolsDir, linkDir)
  const symlinkedCli = path.join(linkDir, 'git-sync.mjs')

  const result = spawnSync(process.execPath, [symlinkedCli, 'preflight', '--cwd', w.root], {
    env: w.env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 2)
  const json = JSON.parse(result.stdout)
  assert.equal(json.ok, false)
  assert.equal(json.cmd, 'preflight')
})

// Final review Minor 8: a trailing `--cwd` with no directory is the caller's malformed call (R33's `Usage:` exit 1), not a stack trace.
test('T1.7 --cwd without a directory exits 1 with Usage', () => {
  for (const argv of [['preflight', '--cwd'], ['preflight', '--cwd', '--plan', 'x']]) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...argv], { encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /^Usage:/)
    assert.match(result.stderr, /--cwd <dir> needs a directory/)
    assert.equal(result.stdout, '')
  }
})
