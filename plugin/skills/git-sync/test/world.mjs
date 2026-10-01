// Shared test fixture for git-sync: builds a throwaway "two machines share one remote" world
// per test — a bare origin, two clones (a, b) — and a fully sandboxed git environment, so the
// suite never reads or writes the real $HOME, the real global gitconfig, or the real PATH.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { context } from '../tools/git-sync.mjs'

const CLI_PATH = fileURLToPath(new URL('../tools/git-sync.mjs', import.meta.url))

// macOS ships `/usr/bin/git` as an xcrun shim that only behaves like a real binary when the
// Xcode command line tools are installed at that exact path. Resolving through the calling
// shell's own PATH once (`command -v`, run through /bin/sh so this works whether or not the
// *test* process's PATH has been tampered with) and symlinking that resolved path into each
// world's sandboxed bin/ works on both macOS (Homebrew or Xcode git) and Linux, where
// `command -v` simply reports the one real binary.
function resolveBin(name) {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
  if (!found) throw new Error(`world(): could not resolve "${name}" via the shell's PATH`)
  return found
}
const REAL_GIT = resolveBin('git')
const REAL_SH = resolveBin('sh')

function run(bin, args, opts) {
  const result = spawnSync(bin, args, { encoding: 'utf8', ...opts })
  if (result.status !== 0) {
    throw new Error(
      `world setup: ${bin} ${args.join(' ')}${opts.cwd ? ` (in ${opts.cwd})` : ''} failed:\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

// Builds one disposable world: a bare `origin`, two clones of it (`a`, `b`, standing in for two
// machines), and the sandboxed env every child process in the test needs so nothing here can
// ever touch the real filesystem outside the world's own root. Registers its own cleanup with
// `t.after` so a failing assertion still leaves the temp directory removed.
export function world(t, { host = 'github.com' } = {}) {
  // The embedded space (required of every world root, per the project's constraints) is why a
  // leading `-C <dir>` runner and quoted shell commands matter everywhere else in this project —
  // this fixture is what makes a space-in-path bug visible instead of accidentally untested.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const home = path.join(root, 'home')
  const stubsDir = path.join(root, 'stubs')
  const binDir = path.join(root, 'bin')
  const originPath = path.join(root, 'origin.git')
  const gitconfigPath = path.join(root, 'gitconfig')
  const callsPath = path.join(root, 'calls.jsonl')
  const aPath = path.join(root, 'a')
  const bPath = path.join(root, 'b')

  // The engine's own scratch space (a stash branch's temporary worktree, the proof gate's temp index) lands here rather than in the real /tmp,
  // so a test can see that nothing was left behind — and, being under the root, its path carries the space too.
  const tmpDir = path.join(root, 'tmp')
  for (const dir of [home, stubsDir, binDir, tmpDir]) fs.mkdirSync(dir, { recursive: true })
  // Real binaries the engine and its checks are allowed to find; everything else (gh, npm, ...)
  // exists only if a test stubs it, so a real tool on the developer's machine can never leak in.
  fs.symlinkSync(REAL_GIT, path.join(binDir, 'git'))
  fs.symlinkSync(REAL_SH, path.join(binDir, 'sh'))
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'))

  const env = {
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(root),
    PATH: `${stubsDir}:${binDir}`,
    TMPDIR: tmpDir,
    // R27: one zone for every child, so a date the engine formats (a stash branch's yyyymmdd) and the one a test derives through `w.git` agree
    // whatever zone the runner itself was started in.
    TZ: 'UTC',
  }

  // The raw URL both clones use, and the one thing `insteadOf` rewrites transparently at fetch
  // time — `remote.origin.url` keeps reading back as this literal string (T1.4), because the
  // rewrite happens at the transport layer, not when the config value is written.
  const rawUrl = `git@${host}:example/demo.git`
  fs.writeFileSync(
    gitconfigPath,
    `[user]\n\tname = Git Sync Test\n\temail = git-sync-test@example.com\n` +
      `[init]\n\tdefaultBranch = main\n` +
      `[url "${originPath}"]\n\tinsteadOf = ${rawUrl}\n`,
  )

  // Seed the bare origin from a scratch working tree, then discard the tree — the bare repo is
  // the only thing the two clones (and every later git call) ever talk to.
  run(REAL_GIT, ['init', '--bare', '-b', 'main', originPath], { cwd: root, env })
  const seedPath = path.join(root, '.seed')
  run(REAL_GIT, ['init', '-b', 'main', seedPath], { cwd: root, env })
  fs.writeFileSync(path.join(seedPath, '.gitignore'), 'node_modules/\n')
  run(REAL_GIT, ['add', '.gitignore'], { cwd: seedPath, env })
  run(REAL_GIT, ['commit', '-m', 'seed'], { cwd: seedPath, env })
  run(REAL_GIT, ['remote', 'add', 'origin', originPath], { cwd: seedPath, env })
  run(REAL_GIT, ['push', 'origin', 'main'], { cwd: seedPath, env })
  fs.rmSync(seedPath, { recursive: true, force: true })

  run(REAL_GIT, ['clone', rawUrl, aPath], { cwd: root, env })
  run(REAL_GIT, ['clone', rawUrl, bPath], { cwd: root, env })

  function git(dir, ...args) {
    return run(REAL_GIT, ['-C', dir, ...args], { cwd: dir, env })
  }

  // Writes `file` under `dir`, stages and commits it; `daysAgo`, when given, backdates both the
  // author and committer timestamps so later tasks can build fixtures for the staleness rules
  // (§5's 30-day threshold) without waiting real days.
  function commit(dir, { file, content, msg, daysAgo } = {}) {
    const filePath = path.join(dir, file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
    git(dir, 'add', file)
    const commitEnv = { ...env }
    if (daysAgo !== undefined) {
      const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString()
      commitEnv.GIT_AUTHOR_DATE = when
      commitEnv.GIT_COMMITTER_DATE = when
    }
    run(REAL_GIT, ['-C', dir, 'commit', '-m', msg], { cwd: dir, env: commitEnv })
    return git(dir, 'rev-parse', 'HEAD')
  }

  // Writes a PATH stub for `name`: a node script (CommonJS, so an extensionless file needs no
  // package.json to be parsed correctly) that records one call — argv, cwd, whether CI was set —
  // to <root>/calls.jsonl, then prints/exits as configured. `byArgs` lets one stub answer
  // differently per invocation, keyed by a substring of the space-joined argv, first match wins;
  // everything else falls back to the stub's own top-level config. Calling `stub` again for the
  // same name overwrites the previous script outright.
  function stub(name, { stdout = '', stderr = '', exit = 0, sleepMs = 0, byArgs = {} } = {}) {
    const body = [
      `#!${process.execPath}`,
      `const fs = require('fs')`,
      `const argv = process.argv.slice(2)`,
      `const record = { name: ${JSON.stringify(name)}, argv, cwd: process.cwd(), ci: process.env.CI ?? null }`,
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(record) + '\\n')`,
      `let cfg = ${JSON.stringify({ stdout, stderr, exit, sleepMs })}`,
      `const byArgs = ${JSON.stringify(byArgs)}`,
      `const joined = argv.join(' ')`,
      `for (const [substr, override] of Object.entries(byArgs)) {`,
      `  if (joined.includes(substr)) { cfg = Object.assign({}, cfg, override); break }`,
      `}`,
      `function done() {`,
      `  if (cfg.stdout) process.stdout.write(cfg.stdout)`,
      `  if (cfg.stderr) process.stderr.write(cfg.stderr)`,
      `  process.exitCode = cfg.exit`,
      `}`,
      `if (cfg.sleepMs) setTimeout(done, cfg.sleepMs)`,
      `else done()`,
      '',
    ].join('\n')
    const file = path.join(stubsDir, name)
    fs.writeFileSync(file, body, { mode: 0o755 })
    fs.chmodSync(file, 0o755) // belt and braces: writeFileSync's mode is still subject to umask
  }

  function calls() {
    if (!fs.existsSync(callsPath)) return []
    return fs
      .readFileSync(callsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
  }

  // Runs the engine exactly as a user would: a fresh `node tools/git-sync.mjs ... --cwd <dir>`
  // process, under this world's sandboxed env. `json` is the parsed stdout envelope when stdout
  // is valid JSON (every implemented subcommand), and `null` for the argument-error path, whose
  // contract is stderr-only.
  function cli(dir, args = [], extraEnv = {}) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args, '--cwd', dir], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    })
    let json = null
    try {
      json = JSON.parse(result.stdout)
    } catch {
      // stdout wasn't JSON — expected for the exit-1 bad-argument path.
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
  }

  // Resolves a Ctx the way a subcommand would, but against this world's sandboxed env — so a
  // direct-import test can call `context()` itself without falling through to the test process's
  // own ambient HOME/PATH/global gitconfig (constraints.md: the suite never touches those).
  function ctx(dir) {
    return context(dir, { env })
  }

  return { root, origin: originPath, a: aPath, b: bPath, env, git, commit, stub, calls, cli, ctx }
}
