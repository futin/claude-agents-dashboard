#!/usr/bin/env node
// git-sync — deterministic engine behind the git-sync skill. One subcommand per phase of
// the flow in references/design.md §4; each subcommand reads/writes plain JSON, is safe to
// re-run, and never destroys anything the survey didn't just prove safe. SKILL.md drives this
// file and owns the judgement calls (commit message, decision round, report prose); this file
// never talks to the user.
//
// Subcommands, in phase order (§4):
//   preflight    0  refuse mid-rebase/merge/cherry-pick/bisect, detached HEAD, no origin, no trunk
//   stage-scan   1  stage everything, stop on secrets/junk, else leave staged for the model to commit
//   sync         2  fetch --prune, checkout trunk, rebase it onto origin/<trunk>
//   survey       3  read-only branch/stash/worktree classification (§5) plus check discovery (§9)
//   plan         4  turn the decision round's answers into plan.json (§7)
//   verify       5  install if needed, run discovered checks, write verify.json
//   push-trunk   6  push the trunk when verify is green (or unverified) for this exact SHA
//   apply        7  execute plan.json, re-proving each action first (§10)
//   report       8  render committed/trunk/deleted/kept/pushed/stashes/worktrees/warnings
//
// `process.exitCode = main(...)` (never `process.exit`) so a caller that `import`s this module
// for its named exports — the test suite, later phases — never has the process pulled out from
// under it; the `import.meta.url` guard below means importing the module alone never runs the
// CLI, only executing it directly does.
//
// Node >= 20, zero dependencies: synchronous fs and spawnSync only, per the project's constraints.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SUBCOMMANDS = [
  'preflight',
  'stage-scan',
  'sync',
  'survey',
  'plan',
  'verify',
  'push-trunk',
  'apply',
  'report',
]

export const USAGE = `Usage: git-sync <command> [--cwd <dir>] [--answers <file>] [--plan <file>]\n\nCommands:\n  ${SUBCOMMANDS.join('\n  ')}\n`

// Every git invocation goes through here so the whole engine shares one hardening pass:
// `-C <root>` instead of relying on process.cwd, colour and quoting forced off so stdout stays
// script-safe no matter the user's own config (a hostile `color.ui=always` must not leak escape
// codes into JSON we parse downstream), and a child env that never opens a prompt, an editor, or
// an auto-continuing merge. `opts.env` layers on top of `process.env` rather than replacing it —
// production callers omit it and get the real environment; the test suite passes a fully
// sandboxed env to run this exact function inside a disposable world. `GIT_EXTERNAL_DIFF` is
// deleted after the merge (never just omitted from `opts.env`) because omission alone would still
// let it leak in from an inherited `process.env` — this is defense in depth for every diff any
// current or future phase reads, on top of the `--no-ext-diff` the scan's own diff calls also pass.
export function git(root, args, opts = {}) {
  const env = {
    ...process.env,
    ...opts.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
  }
  delete env.GIT_EXTERNAL_DIFF
  const result = spawnSync('git', ['-C', root, '-c', 'color.ui=never', '-c', 'core.quotepath=off', ...args], {
    env,
    encoding: 'utf8',
  })
  // spawnSync sets `.error` (and leaves `.status` null) when the binary itself can't be
  // launched at all. Folding that into a synthetic failure keeps this function's contract —
  // never throws, always returns {status, stdout, stderr} — true for every caller.
  if (result.error) return { status: 1, stdout: '', stderr: String(result.error) }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export class GitError extends Error {
  constructor(args, stderr) {
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
  }
}

// Sugar for the common case: a caller that treats failure as a bug rather than a decision point,
// and wants stdout already trimmed instead of re-trimming it at every call site.
export function gitOk(root, args, opts = {}) {
  const result = git(root, args, opts)
  if (result.status !== 0) throw new GitError(args, result.stderr)
  return result.stdout.trim()
}

// Thrown by any phase that needs to stop the whole run; `main` is the only catcher, turning it
// into the `ok:false` envelope instead of a stack trace. `detail` is free-form context for the
// eventual report — a cwd, a branch name, a git stderr tail — whatever explains the stop.
export class Stop extends Error {
  constructor(stop, detail) {
    super(stop)
    this.name = 'Stop'
    this.stop = stop
    this.detail = detail
  }
}

// Resolves where we are, once, so every later phase works from the same coordinates whether
// invoked from the repo root, a subdirectory, or a linked worktree. `--git-common-dir` is
// documented to print relative to the working directory on a plain (non-worktree) repo, so it's
// resolved against `root` rather than trusted as already absolute; `--absolute-git-dir` already
// is one.
export function context(cwd, opts = {}) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], opts)
  if (top.status !== 0) throw new Stop('not-a-repo', { cwd, stderr: top.stderr.trim() })
  const root = top.stdout.trim()

  const gitDir = gitOk(root, ['rev-parse', '--absolute-git-dir'], opts)
  const commonDirRaw = gitOk(root, ['rev-parse', '--git-common-dir'], opts)
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(root, commonDirRaw)

  return {
    root,
    gitDir,
    commonDir,
    stateDir: path.join(commonDir, 'git-sync'),
    linked: gitDir !== commonDir,
    // R8: carried so every later function that only has a ctx (not the original opts) can still
    // pass `{ env: ctx.env }` to its own git/gitOk calls — the test suite's sandboxed env in
    // particular must never fall back to the real process env partway through a call chain.
    env: opts.env,
  }
}

// R28: a state file that exists but fails to parse (a process killed mid-`writeState`, a disk-full write) is a stop, not a stack trace — every
// caller either wants a Stop it can let propagate as its own `ok:false` envelope (`apply` reading a corrupt `plan.json`, say) or, in `report`'s
// case, a `bad-state` it can catch per file and downgrade to a warning, since `report`'s whole job is to survive exactly this kind of damage.
export function readState(ctx, name) {
  const file = path.join(ctx.stateDir, `${name}.json`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Stop('bad-state', { file, error: err.message })
  }
}

export function writeState(ctx, name, obj) {
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.writeFileSync(path.join(ctx.stateDir, `${name}.json`), `${JSON.stringify(obj, null, 2)}\n`)
}

// Reads `key` from git config (repo-local overriding global, git's own precedence), returning
// `null` when it isn't set at all rather than throwing — an unset key is a normal, expected case
// here, not the bug `gitOk` exists to catch.
function stringConfig(ctx, key) {
  const result = git(ctx.root, ['config', key], { env: ctx.env })
  return result.status === 0 ? result.stdout.trim() : null
}

// Same shape as stringConfig, normalised through git's own bool parser (`--type=bool`) so any of
// git's accepted spellings (true/false/yes/no/on/off/1/0) read back as an actual boolean. `invalid`
// distinguishes "unset" (git config exits non-zero because the key doesn't exist — the normal,
// silent case) from "set to something git's bool parser rejects" (a typo the caller should warn
// about) — `--type=bool` alone can't tell those apart, since both exit non-zero.
function boolConfig(ctx, key) {
  if (stringConfig(ctx, key) === null) return { value: null, invalid: false }
  const result = git(ctx.root, ['config', '--type=bool', key], { env: ctx.env })
  if (result.status === 0) return { value: result.stdout.trim() === 'true', invalid: false }
  return { value: null, invalid: true }
}

function refExists(ctx, ref) {
  return git(ctx.root, ['show-ref', '--verify', '--quiet', ref], { env: ctx.env }).status === 0
}

// §6: the branch `origin/HEAD` points at, else `main`, else `master` — checking each candidate's
// remote-tracking ref before its local one, since a fresh clone always has the former and a
// pre-existing local repo being pointed at may only have the latter. Throws `no-trunk` rather
// than returning a sentinel so every caller gets the refusal for free instead of re-checking.
export function trunkOf(ctx) {
  const symbolic = git(ctx.root, ['symbolic-ref', 'refs/remotes/origin/HEAD'], { env: ctx.env })
  if (symbolic.status === 0) {
    // The whole name after the prefix, never the last segment: a trunk may be `release/x`.
    const ref = symbolic.stdout.trim() // refs/remotes/origin/<branch>
    const prefix = 'refs/remotes/origin/'
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  for (const name of ['main', 'master']) {
    if (refExists(ctx, `refs/remotes/origin/${name}`) || refExists(ctx, `refs/heads/${name}`)) return name
  }
  throw new Stop('no-trunk', { root: ctx.root })
}

// §6: host of the **raw** `remote.origin.url` — never `git remote get-url`, which expands
// `insteadOf` and would report the rewritten transport instead of what the user actually
// configured. Handles both `git@host:path` (scp-style, no scheme) and any URL-style remote
// (`https://host/...`, `ssh://user@host/...`).
export function remoteKindOf(ctx) {
  const url = stringConfig(ctx, 'remote.origin.url') ?? ''
  const scp = /^[^/]+@([^:/]+):/.exec(url)
  let host = ''
  if (scp) {
    host = scp[1]
  } else {
    try {
      host = new URL(url).hostname
    } catch {
      host = ''
    }
  }
  return host === 'github.com' ? 'github' : 'other'
}

// §6: the three per-machine local-config overrides, plus any warning their values earn. staleDays
// falls back to 30 both when unset (silently — that's just the documented default) and when set
// to something that isn't a positive integer (with a warning, since that's a typo the user should
// hear about). `push` mirrors that: unset is silent, an unparseable value falls back to `null`
// (i.e. treated as unset for `pushAllowed`) plus the matching warning.
export function configOf(ctx) {
  const warnings = []
  const pushResult = boolConfig(ctx, 'git-sync.push')
  if (pushResult.invalid) warnings.push('git-sync.push is not a boolean')
  const push = pushResult.value
  const checks = stringConfig(ctx, 'git-sync.checks')
  const staleRaw = stringConfig(ctx, 'git-sync.staleDays')
  let staleDays = 30
  if (staleRaw !== null) {
    const n = Number(staleRaw)
    if (Number.isInteger(n) && n > 0) staleDays = n
    else warnings.push('git-sync.staleDays is not a positive integer')
  }
  return { push, checks, staleDays, warnings }
}

// The shared Repo shape every later subcommand builds on: a Ctx plus trunk/remote-kind/push
// rules, resolved fresh from `cwd` each time rather than threaded through as a long-lived object,
// so a subcommand that runs after a sync (which can move the trunk) never works from stale data.
// Never writes state — only `preflight`'s own payload does that, since this is a read.
export function repo(cwd, opts = {}) {
  const ctx = context(cwd, opts)
  if (stringConfig(ctx, 'remote.origin.url') === null) throw new Stop('no-origin', { root: ctx.root })
  const trunk = trunkOf(ctx)
  const remoteKind = remoteKindOf(ctx)
  const { push, checks, staleDays, warnings } = configOf(ctx)
  const pushAllowed = remoteKind === 'github' && push !== false
  return {
    ...ctx,
    trunk,
    remoteKind,
    pushAllowed,
    downgraded: !pushAllowed,
    config: { push, checks, staleDays },
    warnings,
  }
}

// gitDir markers of an operation left mid-flight. R5: bisect is either of BISECT_LOG/BISECT_START
// (the brief only names the former; a `bisect start` with no bad/good yet has only the latter).
const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START']

// A previous run's files never survive into this one — a stale plan.json or verify.json read by
// this run's later phases would be silently wrong. `deleted.log` (the running record of what past
// runs actually deleted) and `last-report.md` (what the last report said) are history, not run
// state, so they're the two names this sweep leaves alone.
const KEEP_ACROSS_RESET = new Set(['deleted.log', 'last-report.md'])

function resetStateDir(ctx) {
  if (!fs.existsSync(ctx.stateDir)) return
  for (const name of fs.readdirSync(ctx.stateDir)) {
    if (KEEP_ACROSS_RESET.has(name)) continue
    fs.rmSync(path.join(ctx.stateDir, name), { recursive: true, force: true })
  }
}

// Phase 0 (§4, §6). Refusals run in exactly this order — linked-worktree first because checking
// out the trunk there later would fail against the main tree that already holds it; the two that
// `repo()` folds together (no-origin, no-trunk) come last since they're what every later phase
// also needs resolved. R9: every refusal must run — and pass — before anything is mutated. A linked
// worktree shares `commonDir` (and so `stateDir`) with its main tree, so clearing state before this
// check would let a run invoked from the wrong place wipe the main tree's in-flight survey/plan/
// verify state and only then refuse; the reset moves below all five checks so a refused run never
// touches disk.
function preflight(ctx) {
  if (ctx.linked) throw new Stop('linked-worktree', { root: ctx.root })

  const marker = IN_PROGRESS_MARKERS.find((name) => fs.existsSync(path.join(ctx.gitDir, name)))
  if (marker) throw new Stop('in-progress-operation', { root: ctx.root, marker })

  const headRef = git(ctx.root, ['symbolic-ref', '-q', '--short', 'HEAD'], { env: ctx.env })
  if (headRef.status !== 0) throw new Stop('detached-head', { root: ctx.root })
  const startBranch = headRef.stdout.trim()

  const r = repo(ctx.root, { env: ctx.env }) // throws no-origin / no-trunk

  resetStateDir(ctx)

  const startHead = gitOk(ctx.root, ['rev-parse', 'HEAD'], { env: ctx.env })
  const dirty = gitOk(ctx.root, ['status', '--porcelain'], { env: ctx.env }) !== ''

  return {
    root: r.root,
    // R31: SKILL.md writes commit-msg.txt and answers.json here and reads the path from this payload, never deriving it: it sits under the git
    // common dir, which is not `<root>/.git` for a submodule or any other `.git`-file layout.
    stateDir: ctx.stateDir,
    trunk: r.trunk,
    remoteKind: r.remoteKind,
    pushAllowed: r.pushAllowed,
    downgraded: r.downgraded,
    startBranch,
    startHead,
    dirty,
    config: r.config,
    warnings: r.warnings,
  }
}

// §8: secret- and junk-shaped basenames, checked against the staged path itself rather than its
// content. `.env.example`/`.env.sample` are the one carve-out — they're conventionally committed
// as templates, never real secrets — so they're excluded before the general `.env`/`.env.*` test
// runs rather than folded into it.
const SECRET_PATH_EXEMPT = new Set(['.env.example', '.env.sample'])

function isSecretPath(p) {
  const base = path.basename(p)
  if (SECRET_PATH_EXEMPT.has(base)) return false
  if (base === '.env' || base.startsWith('.env.')) return true
  if (/\.(pem|key)$/.test(base)) return true
  if (/^id_(rsa|ed25519)/.test(base)) return true
  return false
}

// §8: junk lives by directory segment (anywhere in the path, not just as its parent), except
// `.DS_Store`, which is junk by basename alone — Finder drops one in every directory it touches.
const JUNK_DIR_SEGMENTS = new Set(['node_modules', '.venv', 'venv', '__pycache__'])

function isJunkPath(p) {
  const segments = p.split('/')
  if (segments[segments.length - 1] === '.DS_Store') return true
  return segments.some((segment) => JUNK_DIR_SEGMENTS.has(segment))
}

// §8's content-shaped reasons. Each pattern is checked against one added line at a time (never
// the whole diff), so a match can never span the `+` prefix or a line boundary. The fragments
// below (`AKIA`, `gh[pousr]_`, `sk-ant-`) are detection prefixes, not secrets themselves — only a
// *test* planting a matching token has to build it at runtime (R10); the patterns that recognise
// one are the guard's whole job and have to be literal to work at all.
const CONTENT_RULES = [
  { reason: 'secret-content:private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { reason: 'secret-content:aws', pattern: /AKIA[0-9A-Z]{16}/ },
  { reason: 'secret-content:github', pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/ },
  { reason: 'secret-content:anthropic', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
]

// One 10 MiB blob is the line design.md §8 draws between "large file" and "too large".
const TOO_LARGE_BYTES = 10 * 1024 * 1024

// The rule table scanStaged walks, one entry per reason, kept as data so the reasons a hit can
// carry are all visible in one place rather than scattered across scanStaged's branches.
export const SCAN_RULES = [
  { reason: 'secret-path', kind: 'path', test: isSecretPath },
  { reason: 'junk-path', kind: 'path', test: isJunkPath },
  ...CONTENT_RULES.map((rule) => ({ ...rule, kind: 'content' })),
  { reason: 'too-large', kind: 'size' },
]

// Every diff this guard reads goes through here, never through `git`/`gitOk` directly: a hostile
// `diff.external` (or `GIT_EXTERNAL_DIFF`) replaces the whole diff body with an external tool's own
// output, and a `textconv` filter can rewrite a blob's content before git even diffs it — either
// one would make the content rules go silently blind. `--no-ext-diff --no-textconv` close both
// regardless of whether the setting came from repo config or an inherited env var; `git()` also
// strips `GIT_EXTERNAL_DIFF` itself for defense in depth, so this belt-and-braces here even if that
// changes later. `--no-color` and explicit prefixes are cheap insurance against `color.ui=always`
// and `diff.noprefix` leaking into anything this function's callers still read as text.
function scanDiff(ctx, args) {
  const env = { ...ctx.env }
  delete env.GIT_EXTERNAL_DIFF
  return gitOk(
    ctx.root,
    ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...args],
    { env },
  )
}

// `-z`-terminated so a path holding a literal newline (git would otherwise quote it) can never be
// mis-split; empty stdout (nothing staged) must become `[]`, not `['']`, after the split.
function stagedNames(ctx) {
  const raw = scanDiff(ctx, ['--cached', '--name-only', '-z'])
  return raw === '' ? [] : raw.split('\0').filter(Boolean)
}

// Every added line staged for one path. Scoped with `-- <path>` (the exact raw bytes `-z` already
// gave us, never re-parsed from a header) rather than one global diff split by each hunk's own
// `+++ b/<path>` line — so there is no path to attribute back to, and so no way for `diff.noprefix`
// or a control character/quote in a filename to desync a match from the path it belongs to (both
// were real gaps in that header-parsing approach). `-U0` (no context lines) means every remaining
// `+` line is content, not context; binary files never emit content lines at all, so they fall out
// for free. Matches the brief's literal rule ("lines starting `+` but not `+++`"): a content line
// that itself begins `++` is skipped along with the real `+++ b/<path>` header line, a known,
// accepted edge case.
function addedLinesForPath(ctx, p) {
  const diffText = scanDiff(ctx, ['--cached', '-U0', '--', p])
  return diffText
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
}

// The staged blob's own size, via the index's stage-0 object rather than the working-tree file
// (§8: "measured on the staged blob", so a filter or a working-tree-only edit can never change the
// verdict). A path that vanished from the index by the time this runs (e.g. staged as a deletion)
// has no blob to size — 0 is the correct answer, not a crash.
function blobSize(ctx, p) {
  const result = git(ctx.root, ['cat-file', '-s', `:${p}`], { env: ctx.env })
  return result.status === 0 ? Number(result.stdout.trim()) : 0
}

// §8's guard proper: every currently-staged path against every rule in SCAN_RULES, in that order,
// so hits come back in "the order the paths come in from `diff --cached --name-only -z`" with one
// entry per path+reason — guaranteed by construction (each path visited once, each rule visited
// once per path) rather than by a separate dedup pass. Exported so a future phase (or a test) can
// ask "would this staged set trip the guard" without going through the stage/restore dance. A
// path's added lines are fetched at most once (cached in `addedLines`, reused across all four
// content rules) rather than once per rule.
export function scanStaged(ctx) {
  const hits = []
  for (const p of stagedNames(ctx)) {
    let addedLines = null
    for (const rule of SCAN_RULES) {
      let hit
      if (rule.kind === 'path') {
        hit = rule.test(p)
      } else if (rule.kind === 'content') {
        addedLines ??= addedLinesForPath(ctx, p)
        hit = addedLines.some((line) => rule.pattern.test(line))
      } else {
        hit = blobSize(ctx, p) > TOO_LARGE_BYTES
      }
      if (hit) hits.push({ path: p, reason: rule.reason })
    }
  }
  return hits
}

// R35: the index file that `add -A` is about to rewrite. `--git-path index` already honours `GIT_INDEX_FILE` and a linked worktree's own index, and
// prints relative to the cwd git ran in — `-C root` — so it is resolved against `root`, as `--git-common-dir` is in `context()`.
function indexPath(ctx) {
  return path.resolve(ctx.root, gitOk(ctx.root, ['rev-parse', '--git-path', 'index'], { env: ctx.env }))
}

// R35: the snapshot is a byte copy of the index file, never a `write-tree`: a tree object carries no index flags, so a `read-tree` restore would drop
// skip-worktree and assume-unchanged bits and lose intent-to-add entries outright — exactly the flags a user sets to keep a local credential out of
// commits. The copy sits next to the index so the restore is a same-directory rename, atomic over the index `add -A` wrote. A repo with no index yet
// (nothing ever staged) snapshots as `null` and restores by removing whatever `add -A` created.
function snapshotIndex(ctx) {
  const file = indexPath(ctx)
  if (!fs.existsSync(file)) return { file, copy: null }
  const copy = `${file}.git-sync-snapshot`
  fs.copyFileSync(file, copy)
  return { file, copy }
}

function restoreIndex(snapshot) {
  if (snapshot.copy === null) fs.rmSync(snapshot.file, { force: true })
  else fs.renameSync(snapshot.copy, snapshot.file)
}

function discardSnapshot(snapshot) {
  if (snapshot.copy !== null) fs.rmSync(snapshot.copy, { force: true })
}

// Runs `fn`, restoring the index from `snapshot` and normalising any throw into a `Stop` first: a
// deliberate `Stop` (there isn't one on this path today, but a future rule could throw one) passes
// through as-is, and any other error — a `GitError` from a git call that failed mid-scan, most
// likely — is wrapped as `Stop('scan-failed', …)` so main's Stop-only catch still has an envelope
// to emit instead of the process crashing with the index left mutated by `add -A`.
function withRestoreOnError(snapshot, fn) {
  try {
    return fn()
  } catch (err) {
    restoreIndex(snapshot)
    throw err instanceof Stop ? err : new Stop('scan-failed', { message: err.message })
  }
}

// Phase 1 (§4, §8). `repo()` is called for the same reason it backs preflight: no-origin/no-trunk
// must refuse here too, not just when preflight happened to run first in this invocation — even
// though this phase's own payload never touches the Repo fields. The index file is copied (R35)
// *before* `add -A` so a hit — or any other failure once `add -A` has run, `add -A` itself included — can be undone exactly: putting the copy back
// rewrites only the index, flags and all, leaving the working tree — and so every unstaged edit and untracked file the guard never touched — exactly
// as the user left it. Everything after the copy runs under `withRestoreOnError` so that guarantee holds on every path out of this function, not just
// the detected-hit one.
function stageScan(ctx) {
  repo(ctx.root, { env: ctx.env })

  const snapshot = snapshotIndex(ctx)
  withRestoreOnError(snapshot, () => gitOk(ctx.root, ['add', '-A'], { env: ctx.env }))

  const hits = withRestoreOnError(snapshot, () => scanStaged(ctx))
  if (hits.length > 0) {
    restoreIndex(snapshot)
    throw new Stop('secret-or-junk-staged', { hits })
  }

  const payload = withRestoreOnError(snapshot, () => {
    const staged = stagedNames(ctx)
    const stat = scanDiff(ctx, ['--cached', '--stat'])
    return { staged, stat, clean: staged.length === 0 }
  })
  discardSnapshot(snapshot)
  return payload
}

// Review Focus 4: a hostile `rebase.autoStash`/`rebase.updateRefs`/`rebase.autoSquash`/
// `commit.gpgSign` in the user's own config must never change what a mutating call does or whether
// it succeeds — and neither may a hook. `core.hooksPath=/dev/null` is the one override that covers
// every hook class, including `post-checkout`, which `--no-verify` (a rebase-only flag with no
// `checkout` equivalent) cannot touch: git looks up `<hooksPath>/<hook-name>` before running it, and
// since `/dev/null` is a file, not a directory, that lookup always misses, so every hook is silently
// treated as absent — verified directly against this project's git on both `checkout` and `rebase`
// with a hook planted to fail loudly. `/dev/null` exists on every platform this project targets
// (macOS, Linux), unlike an empty directory this code would otherwise have to create and clean up.
// Kept as one small constant, named for what it's for rather than which call first needed it, so
// later phases (push, apply) that also run mutating git commands can reuse it for theirs.
const SAFE_MUTATE_CONFIG = [
  '-c', 'rebase.autoStash=false',
  '-c', 'rebase.updateRefs=false',
  '-c', 'rebase.autoSquash=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'core.hooksPath=/dev/null',
]

// Phase 2 (§4): fetch with prune, get the trunk checked out and tracking `origin/<trunk>`, then
// rebase it onto the fetched tip so the two-machine flow this skill exists for — commit here, sync
// there — replays cleanly instead of merging. `git pull` is deliberately never used: it would let
// the user's own `pull.rebase`/`pull.ff` config pick the strategy, where this phase needs exactly
// one, always. A conflicting rebase is undone in full rather than left mid-flight, since this
// script never asks a question — a conflict here can only be reported, not worked through.
function sync(ctx) {
  if (gitOk(ctx.root, ['status', '--porcelain'], { env: ctx.env }) !== '') {
    throw new Stop('dirty-tree', { root: ctx.root })
  }

  // Resolved the same way preflight's no-origin/no-trunk checks are, and for the same reason: this
  // must refuse before the fetch below touches anything, rather than fail later with a git error.
  const { trunk } = repo(ctx.root, { env: ctx.env })

  // Captured before the checkout below can move HEAD, so the payload can name the branch the user
  // was actually switched off of — `null` covers already being on the trunk, or a detached HEAD.
  const headRef = git(ctx.root, ['symbolic-ref', '-q', '--short', 'HEAD'], { env: ctx.env })
  const startBranch = headRef.status === 0 ? headRef.stdout.trim() : null
  const switchedFrom = startBranch && startBranch !== trunk ? startBranch : null

  // `fetch` writes refs too — it moves every remote-tracking branch it touches — so a hostile
  // `reference-transaction` hook can fail it exactly the way it fails a checkout or a rebase, and
  // gets the same guard for the same reason (hand-verified: without it, that hook makes `fetch`
  // itself exit non-zero here, well before sync ever reaches a checkout or a rebase to protect).
  const fetchResult = git(ctx.root, [...SAFE_MUTATE_CONFIG, 'fetch', '--all', '--prune'], { env: ctx.env })
  if (fetchResult.status !== 0) {
    throw new Stop('fetch-failed', { root: ctx.root, stderr: fetchResult.stderr.trim() })
  }

  // A local trunk branch is reused as-is; when only the remote-tracking one survived (a fresh
  // clone, or a local branch deleted between runs), a tracking branch is created from it instead,
  // so the rebase below always has an upstream to run against.
  // The trailing `--` on the existing-branch checkout forces `trunk` to resolve as a revision, not
  // a pathspec, so a same-named file at the repo's top level can never hijack it (a plain `git
  // checkout <trunk>` would still switch branches in that case, but only after printing an ignored
  // ambiguity warning to stderr — this removes the ambiguity outright instead of relying on that).
  // The create-tracking branch below has no such ambiguity: `-b <trunk>` names a branch to create,
  // never a path, and `--track` takes an explicit revision argument.
  if (refExists(ctx, `refs/heads/${trunk}`)) {
    gitOk(ctx.root, [...SAFE_MUTATE_CONFIG, 'checkout', trunk, '--'], { env: ctx.env })
  } else {
    gitOk(ctx.root, [...SAFE_MUTATE_CONFIG, 'checkout', '-b', trunk, '--track', `origin/${trunk}`], { env: ctx.env })
  }

  const upstream = git(ctx.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${trunk}@{upstream}`], {
    env: ctx.env,
  })
  if (upstream.status !== 0) throw new Stop('no-upstream', { root: ctx.root, trunk, switchedFrom })

  const before = gitOk(ctx.root, ['rev-parse', 'HEAD'], { env: ctx.env })

  // `refs/remotes/origin/<trunk>`, not `origin/<trunk>` or a plain `pull`: the fetch above already
  // moved the remote-tracking ref, so this names the exact tip to replay onto, unambiguously, and
  // without going through any of `pull`'s own strategy-picking config. `--no-verify` is redundant
  // with `SAFE_MUTATE_CONFIG`'s `core.hooksPath` here but kept for defense in depth.
  const rebaseResult = git(
    ctx.root,
    [...SAFE_MUTATE_CONFIG, 'rebase', '--no-verify', `refs/remotes/origin/${trunk}`],
    { env: ctx.env },
  )
  if (rebaseResult.status !== 0) {
    // Unmerged paths are read before `--abort` unwinds the in-progress rebase — afterwards there's
    // nothing left to diff.
    const raw = gitOk(ctx.root, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: ctx.env })
    const files = raw === '' ? [] : raw.split('\0').filter(Boolean)
    // `--abort` checks the tree back out to the pre-rebase tip internally, so it's exactly as capable
    // of triggering a hostile `post-checkout` (or being steered by a hostile `rebase.*`/`commit.gpgSign`)
    // as the two explicit checkouts above — it gets the same guard for the same reason.
    gitOk(ctx.root, [...SAFE_MUTATE_CONFIG, 'rebase', '--abort'], { env: ctx.env })
    throw new Stop('rebase-conflict', { files, switchedFrom })
  }

  const after = gitOk(ctx.root, ['rev-parse', 'HEAD'], { env: ctx.env })
  // The commits that arrived from the other box: everything the fetched trunk has that the local
  // trunk didn't before this rebase ran.
  const pulled = Number(gitOk(ctx.root, ['rev-list', '--count', `${before}..origin/${trunk}`], { env: ctx.env }))

  // Preflight's `startHead` is what the tree currently installed (node_modules, etc.) most likely
  // matches; falling back to `before` covers a `sync` run with no preceding `preflight` this run.
  const fromSha = readState(ctx, 'preflight')?.startHead ?? before

  return { trunk, switchedFrom, before, after, pulled, lockfileChanged: lockfileChanged(ctx, fromSha, after) }
}

// §9: the lockfiles whose presence decides the package manager, and whose blob identity between
// two commits decides whether a dependency install is needed before checks run.
export const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'uv.lock']

// The blob id of `file` as of `sha`, or `null` when it doesn't exist there — `rev-parse --verify
// -q` reports "no such path in that tree" the same way it reports "no such commit", both folded to
// the one `null` this function's caller needs.
function blobAt(ctx, sha, file) {
  const result = git(ctx.root, ['rev-parse', '--verify', '-q', `${sha}:${file}`], { env: ctx.env })
  return result.status === 0 ? result.stdout.trim() : null
}

// True when any lockfile's blob differs between `fromSha` and `toSha`, including the case where a
// file exists on only one side — `blobAt`'s `null` for "absent" never equals a real blob id, so
// that case falls out of the same comparison without a separate branch.
export function lockfileChanged(ctx, fromSha, toSha) {
  return LOCKFILES.some((file) => blobAt(ctx, fromSha, file) !== blobAt(ctx, toSha, file))
}

// The fixed identity the M3 probe commit is written under. commit-tree refuses to run without one, and a machine whose user never set `user.name`
// (or set `user.useConfigOnly`) must not lose M3 for it; the probe is never referenced, so whose name it carries is irrelevant.
const PROBE_IDENTITY = {
  GIT_AUTHOR_NAME: 'git-sync',
  GIT_AUTHOR_EMAIL: 'git-sync@localhost',
  GIT_COMMITTER_NAME: 'git-sync',
  GIT_COMMITTER_EMAIL: 'git-sync@localhost',
}

// `git cherry <upstream> <head>` as a list of signs, one per commit in `upstream..head`: `-` when an equivalent patch (same patch id) is already in
// `upstream`, `+` when not. Merge commits are skipped by cherry itself, so they never appear here.
function cherrySigns(ctx, upstream, head) {
  const out = gitOk(ctx.root, ['cherry', upstream, head], { env: ctx.env })
  return out === '' ? [] : out.split('\n').map((line) => line[0])
}

// Ruling R11's containment gate: does `ref` already hold the branch's net change, exactly? Patch ids — all cherry compares — hash every diff line
// with its whitespace stripped, and before git 2.39 without file modes, so M2 and M3 can call two patches equivalent while the trees differ in a
// reindented Python block or a lost exec bit (T5.15–T5.17). This asks the exact question instead: the net `base..tip` diff must reverse-apply
// cleanly to `ref`'s tree, i.e. every post-image line of the branch, whitespace included, is sitting in `ref` where the branch put it.
// (`patch-id --verbatim` would fix the hashing itself, but it needs 2.39 and the floor is 2.34.)
//
// All of it happens in a scratch directory: a throwaway index (`GIT_INDEX_FILE`) loaded with `ref`'s tree, and the patch written by git straight to
// a file (`--output`), so arbitrary bytes and any size survive with no stdout round trip. The real index and the worktree are never touched.
// The diff is `diff-tree`, the plumbing whose output ignores the porcelain `diff.*` ui config (noprefix, mnemonicPrefix, relative, context,
// suppressBlankEmpty, submodule); the flags then pin what plumbing still reads — `diff.ignoreSubmodules`, external drivers, textconv — plus the
// prefixes and context apply expects, for the same reason `scanDiff` pins its own. `apply.ignoreWhitespace` would make the check whitespace-blind
// again and `apply.whitespace=error` would fail it on the branch's own trailing spaces, so both are forced. apply only *warns* when a file's mode
// differs from the patch's old mode (exit 0), so that warning is read as a failure: it is exactly the lost-exec-bit case (T5.17).
export function netDiffContained(ctx, base, tip, ref) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-gate-'))
  try {
    const patchFile = path.join(scratch, 'net.patch')
    gitOk(
      ctx.root,
      [
        'diff-tree', '-r', '-p', '--binary', '--full-index', '-U3', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
        '--ignore-submodules=none', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patchFile}`, base, tip,
      ],
      { env: ctx.env },
    )
    // Nothing to contain: the branch nets to no change at all. M3 never gets here with one (its own empty-tree guard), but M2 can — a branch
    // whose add-then-revert pair were both picked onto the trunk — and git 2.34's apply has no `--allow-empty` to accept an empty patch.
    if (fs.statSync(patchFile).size === 0) return true

    const env = { ...ctx.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
    gitOk(ctx.root, [...SAFE_MUTATE_CONFIG, 'read-tree', ref], { env })
    const check = git(
      ctx.root,
      ['-c', 'apply.ignoreWhitespace=no', 'apply', '--cached', '--check', '-R', '-p1', '--whitespace=nowarn', patchFile],
      { env },
    )
    return check.status === 0 && !/ has type \d+, expected \d+/.test(check.stderr)
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// §5's merge proofs, cheapest first: which one shows `tip` is already in `ref` (`origin/<trunk>` after sync), or `null` when none does. `null` is
// never "unmerged" — it only means "not provably merged", which survey turns into ask/keep, so every doubtful case here resolves to it.
// Throws `GitError` when `ref` is missing or `tip` is not a commit (ruling R12): survey and apply check `ref` exists first, or catch and treat the
// throw as "no proof".
//
// M1: `tip` is an ancestor of `ref` — a merge or a fast-forward, and also a branch with no commits of its own. Exact, so no gate.
// M2: every commit in `ref..tip` has a patch-equivalent commit in `ref` — a rebase-merge or cherry-picks. Cherry skips merge commits, so a merge
//     carrying its own content (the "merge main, fix the build" pattern) would go unjudged; any merge in the range therefore rules M2 out (R11b)
//     and the case falls to M3, whose probe carries the merge's content in its tree (T5.12, T5.14).
// M3: a squash merge leaves no per-commit trace, so the branch's whole change is rebuilt as one synthetic commit — the tip's tree on the merge-base
//     as its only parent — and cherry asks whether `ref` holds a patch-equivalent commit. Patch ids hash the diff including its context lines, so
//     when the squash landed on a trunk that had changed the lines around the branch's hunks, the ids differ and M3 misses: the branch falls to
//     ask/keep, never to a wrong delete. A branch whose tree equals the merge-base is a deliberate miss: its empty diff would patch-match any empty
//     commit in `ref` (T5.13), and telling that apart from the sound case — every byte of it already reachable from `ref`, say a branch that merged
//     the trunk after its own squash — is not worth a second proof when ask/keep is the cost.
// M2 and M3 both then pass `netDiffContained` (R11a), since patch-id equivalence is blind to whitespace and, before 2.39, to modes.
//
// The probe is an object only: commit-tree writes no ref, runs no hook, and the unreferenced commit is garbage for the next gc. A signing
// commit-tree behind a broken signer would fail the write and silently cost M3 (Review Focus 4); the git this was verified on (2.50) no longer reads
// `commit.gpgSign` in commit-tree at all, but `--no-gpg-sign` on top of SAFE_MUTATE_CONFIG's own `commit.gpgSign=false` keeps that true on any git
// that does. Its identity comes from PROBE_IDENTITY, never the user's config (T5.11). Cherry's patch ids are computed inside git with a fixed
// `a/`/`b/` prefix, three context lines and no external driver — verified against `diff.context=0`, `diff.noprefix`, `diff.external`,
// `diff.algorithm` and `core.quotePath` — so the user's diff config cannot move a proof either way (T5.9, T5.10).
export function mergeProof(ctx, tip, ref) {
  const ancestor = git(ctx.root, ['merge-base', '--is-ancestor', tip, ref], { env: ctx.env })
  if (ancestor.status === 0) return 'M1'
  // 1 is "not an ancestor"; anything else is a bad object name, a caller bug worth a loud failure rather than a quiet `null`.
  if (ancestor.status !== 1) throw new GitError(['merge-base', '--is-ancestor', tip, ref], ancestor.stderr)

  // Unrelated histories have no merge-base (exit 1): there is no net change to rebuild or to check containment of, so nothing is proven.
  const base = git(ctx.root, ['merge-base', ref, tip], { env: ctx.env })
  if (base.status !== 0) return null
  const baseSha = base.stdout.trim()

  const proof = patchEquivalence(ctx, tip, ref, baseSha)
  return proof && netDiffContained(ctx, baseSha, tip, ref) ? proof : null
}

// M2, else M3, by patch id alone — `mergeProof`'s comment says why each is only half a proof until the containment gate agrees.
function patchEquivalence(ctx, tip, ref, baseSha) {
  const signs = cherrySigns(ctx, ref, tip)
  const merges = gitOk(ctx.root, ['rev-list', '--merges', `${ref}..${tip}`], { env: ctx.env })
  if (merges === '' && signs.length > 0 && !signs.includes('+')) return 'M2'

  const tree = gitOk(ctx.root, ['rev-parse', `${tip}^{tree}`], { env: ctx.env })
  if (tree === gitOk(ctx.root, ['rev-parse', `${baseSha}^{tree}`], { env: ctx.env })) return null
  const probe = gitOk(
    ctx.root,
    [...SAFE_MUTATE_CONFIG, 'commit-tree', tree, '-p', baseSha, '-m', 'git-sync-probe', '--no-gpg-sign'],
    { env: { ...ctx.env, ...PROBE_IDENTITY } },
  )
  const probeSigns = cherrySigns(ctx, ref, probe)
  return probeSigns.length === 1 && probeSigns[0] === '-' ? 'M3' : null
}

const GH_TIMEOUT_MS = 20_000

// `ghStatus` is per-root, not per-call: §9's survey reports the tool's situation once, and every `prLookup` for that root warms or reads the same
// entry. Only `'absent'` (ENOENT) is trusted to hold for the rest of the run, since a missing binary doesn't reappear between branches; a failed
// call (non-zero exit, timeout, bad JSON) may be one rate limit or dropped connection, so it never stops the next branch asking (R17), and one
// success anywhere marks the root `'ok'` whatever failed before or after it. Keyed by `root`, not a single module-level value, so two worlds open
// in the same test process — or two repos in one run — never see each other's status.
const ghStatusCache = new Map()

// Runs `gh pr list`, classifying every way it can end up unusable onto the one axis both exported functions share: `'ok'` (ran, gave back a
// JSON array), `'absent'` (`gh` isn't on PATH at all — spawnSync's `ENOENT`), or `'unavailable'` (found but unusable some other way: non-zero
// exit, killed for running past the timeout, or exit 0 with output that isn't the array we asked for). `headArgs` is `[]` for `ghStatus`'s own
// branch-less probe and `['--head', branch]` for `prLookup`'s real query — same command shape either way, so one classifier serves both, and
// the branch never crosses a shell: it is one element of an argv array handed straight to `spawnSync`.
function runGhPrList(repo, headArgs) {
  const env = { ...process.env, ...repo.env }
  const result = spawnSync(
    'gh',
    ['pr', 'list', ...headArgs, '--state', 'all', '--json', 'number,state,headRefOid,baseRefName', '--limit', '20'],
    { cwd: repo.root, env, encoding: 'utf8', timeout: GH_TIMEOUT_MS },
  )
  // `.error` is spawnSync's own signal that the child never ran at all (ENOENT) or was killed (a timeout sets `ETIMEDOUT`) — either way there is
  // no exit status to read, so this is checked before `.status`.
  if (result.error) return { status: result.error.code === 'ENOENT' ? 'absent' : 'unavailable', prs: null }
  if (result.status !== 0) return { status: 'unavailable', prs: null }
  try {
    const prs = JSON.parse(result.stdout)
    if (!Array.isArray(prs)) throw new Error('gh pr list did not return a JSON array')
    return { status: 'ok', prs }
  } catch {
    return { status: 'unavailable', prs: null }
  }
}

// §5 M4 / §6: `gh`'s situation for this repo, resolved once per root and cached (see `ghStatusCache` above) with a probe identical in shape to
// `prLookup`'s own query, just without a `--head`. In practice this rarely runs the probe itself — the branch loop's first `prLookup` call
// already warms the cache before survey asks for the top-level status — but it still has to work standalone for a repo with no branches to ask
// about.
export function ghStatus(repo) {
  if (ghStatusCache.has(repo.root)) return ghStatusCache.get(repo.root)
  const { status } = runGhPrList(repo, [])
  ghStatusCache.set(repo.root, status)
  return status
}

// §5 M4: is `branch` (whose current tip is `tip`) covered by a GitHub PR? An `open` PR protects the branch from every deletion bucket
// regardless of what M1-M3 find (§5's bucket table); `merged-at-tip` is one more way into the merged bucket for the case none of those catch —
// a squash GitHub performed server-side whose rebuilt commit doesn't patch-match the original, because GitHub's own squash message or diff
// order differs from git's. A MERGED PR whose head has since moved (the branch was reused after merging) is deliberately not proof: `headRefOid`
// must still equal this exact tip, and the PR must have merged into the trunk (R15): a stacked PR merged into `feat/base` put the work in that
// branch, not in the trunk, and M4 is only ever consulted when M1-M3 already found the tip missing from the trunk — exactly that case.
//
// A root whose `gh` is `absent` is not asked again: ENOENT is deterministic, so it costs one spawn attempt per survey rather than one per branch.
// Any other failure is this branch's alone (R17): an `unavailable` answer poisoning the cache would silently drop every later branch's open-PR
// protection, and `branchRecords` refuses to call a branch merged when its own lookup failed.
//
// GitHub only: a GitLab or self-hosted remote has no such lookup, so `remoteKind` is checked before ever touching a child process, not after a
// failed one — the brief's "otherwise none without spawning".
export function prLookup(repo, branch, tip) {
  if (repo.remoteKind !== 'github') return { state: 'none', number: null }
  if (ghStatusCache.get(repo.root) === 'absent') return { state: 'unavailable', number: null }

  const { status, prs } = runGhPrList(repo, ['--head', branch])
  if (status !== 'unavailable' || !ghStatusCache.has(repo.root)) ghStatusCache.set(repo.root, status)
  if (status !== 'ok') return { state: 'unavailable', number: null }

  const open = prs.find((pr) => pr.state === 'OPEN')
  if (open) return { state: 'open', number: open.number }
  const mergedAtTip = prs.find((pr) => pr.state === 'MERGED' && pr.headRefOid === tip && pr.baseRefName === repo.trunk)
  if (mergedAtTip) return { state: 'merged-at-tip', number: mergedAtTip.number }
  return { state: 'none', number: null }
}

// Directory names whose ignored contents are regenerable build or tool output, so they don't make a worktree dirty (R14). Matched against every
// path component, so `packages/x/node_modules/` is junk at any depth while `.env` or `config/local.yml` never are. Deliberately wider than the
// stage-scan's JUNK_DIR_SEGMENTS: that list decides what may never be committed, this one what may be thrown away with a removed worktree.
const WORKTREE_JUNK_SEGMENTS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.turbo', 'target', 'coverage', '.cache', '.pytest_cache', '.mypy_cache',
  '.gradle', '.parcel-cache',
])

// The branch a tree still holds while git shows its HEAD as detached: a rebase records the branch it will move back onto in `head-name`, and a
// bisect records where it started in BISECT_START (a branch name, or a SHA when it started detached — only an existing branch counts). `gitDir`
// is the tree's own git dir, since both live per worktree. `null` when neither operation is in progress.
function heldBranch(repo, gitDir) {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const file = path.join(gitDir, dir, 'head-name')
    if (!fs.existsSync(file)) continue
    const ref = fs.readFileSync(file, 'utf8').trim()
    if (ref.startsWith('refs/heads/')) return { branch: ref.slice('refs/heads/'.length), op: 'rebase' }
  }
  const bisect = path.join(gitDir, 'BISECT_START')
  if (fs.existsSync(bisect)) {
    const name = fs.readFileSync(bisect, 'utf8').trim()
    if (name && refExists(repo, `refs/heads/${name}`)) return { branch: name, op: 'bisect' }
  }
  return null
}

// A linked worktree's own git dir, from the `gitdir:` line of its `.git` file (relative when `worktree.useRelativePaths` is set, so resolved
// against the worktree). `null` when that file is missing or isn't one.
function worktreeGitDir(wtPath) {
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(wtPath, '.git'), 'utf8'))
    return m ? path.resolve(wtPath, m[1].trim()) : null
  } catch {
    return null
  }
}

// §5 Worktrees: every linked worktree (the main tree, always the first porcelain block, is not a candidate for anything and is left out). Porcelain
// is line-based on the 2.34 floor (`-z` arrived in 2.36), which is fine for every path short of one holding a newline.
//
// A worktree mid-rebase or mid-bisect prints `detached`, but its branch is still checked out there — git refuses to delete it — so `heldBranch`
// recovers the name and `inProgress` says why. A `prunable` worktree whose directory is gone has nothing to lose (dirty 0); one git calls prunable
// while the directory still exists (its `.git` file went missing) may hold anything, and status can't look inside it, so it counts as dirty.
// `{ dirty: false }` skips the per-worktree status (final review Minor 13) for callers that only need paths and branches; `dirty` is then null.
export function listWorktrees(repo, { dirty: withDirty = true } = {}) {
  const blocks = gitOk(repo.root, ['worktree', 'list', '--porcelain'], { env: repo.env }).split('\n\n').slice(1)
  const worktrees = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const field = (key) => lines.find((l) => l === key || l.startsWith(`${key} `))
    const wtPath = field('worktree')?.slice('worktree '.length)
    if (!wtPath) continue
    const branchLine = field('branch')
    const exists = fs.existsSync(wtPath)
    const prunable = field('prunable') !== undefined || !exists
    const wtGitDir = exists ? worktreeGitDir(wtPath) : null
    const held = !branchLine && wtGitDir ? heldBranch(repo, wtGitDir) : null
    const dirty = withDirty ? worktreeDirty(repo, wtPath, prunable) : null
    worktrees.push({
      path: wtPath,
      branch: branchLine ? branchLine.slice('branch refs/heads/'.length) : (held?.branch ?? null),
      head: field('HEAD')?.slice('HEAD '.length) ?? null,
      dirty,
      locked: field('locked') !== undefined,
      prunable,
      inProgress: held?.op ?? null,
    })
  }
  return worktrees
}

function worktreeDirty(repo, wtPath, prunable) {
  if (prunable) return fs.existsSync(wtPath) ? 1 : 0
  return dirtyCount(repo, wtPath)
}

// Changed-file count inside one worktree: everything `worktree remove` would throw away. `--no-optional-locks` keeps `status` from refreshing and
// rewriting that worktree's index — the survey must leave every index byte-identical (T7.10). Untracked files are forced to `all` and submodules
// to `none` so a user's `status.showUntrackedFiles=no` or `diff.ignoreSubmodules` can't report a worktree clean, and `--no-renames` keeps the
// `-z` stream at one field per entry. Ignored paths count too (R14) — a copied `.env` is exactly the unrecoverable file a clean-looking worktree
// holds — except under a WORKTREE_JUNK_SEGMENTS directory. `--ignored=matching` (git 2.16+) reports a directory an ignore pattern matches as the one
// entry `dir/` rather than every file inside it, so a large node_modules costs one line, and an ignored directory of the user's own counts once.
// A status that fails outright counts as dirty: unknown must never read as clean.
function dirtyCount(repo, wtPath) {
  const result = git(
    wtPath,
    [
      '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none',
      '--no-renames',
    ],
    { env: repo.env },
  )
  if (result.status !== 0) return 1
  const entries = result.stdout.split('\0').filter(Boolean)
  const isJunk = (p) => p.split('/').some((segment) => WORKTREE_JUNK_SEGMENTS.has(segment))
  return entries.filter((e) => !(e.startsWith('!! ') && isJunk(e.slice(3)))).length
}

// Paths one tree-ish pair differs in, through the `diff-tree` plumbing for the reason `netDiffContained` gives: porcelain `diff.*` config
// (relative, noprefix, external drivers) can't reshape the list. `-z` because a path can hold anything but a NUL.
function changedPaths(repo, from, to) {
  const out = gitOk(repo.root, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', from, to], {
    env: repo.env,
  })
  return out.split('\0').filter(Boolean)
}

// §5 Stashes, newest first (stash list's own order). A stash commit W has the base as `^1`, the index as `^2` and, for `-u`/`-a`, the untracked
// files as a root commit `^3`; `files` is the union over all three, so a change that is only staged, or only untracked, still counts.
// `log.showSignature` is forced off because `stash list` is `log -g` underneath, and a signed base would otherwise splice gpg lines into the parse.
// The base comes from the reflog subject git writes (`WIP on <b>: …`, or `On <b>: …` with `-m`); branch names cannot hold `:`, so the first colon
// ends the name, and `(no branch)` is a detached HEAD.
export function listStashes(repo) {
  const opts = { env: repo.env }
  const out = gitOk(repo.root, ['-c', 'log.showSignature=false', 'stash', 'list', '--format=%H %ct %gs'], opts)
  if (out === '') return []
  return out.split('\n').map((line) => {
    const [sha, ct] = line.split(' ', 2)
    const subject = line.slice(sha.length + ct.length + 2)
    const base = /^(?:WIP on|On) ([^:]+):/.exec(subject)?.[1] ?? null
    const baseSha = gitOk(repo.root, ['rev-parse', `${sha}^1`], opts)
    const paths = new Set([...changedPaths(repo, baseSha, sha), ...changedPaths(repo, baseSha, `${sha}^2`)])
    if (git(repo.root, ['rev-parse', '--verify', '-q', `${sha}^3^{commit}`], opts).status === 0) {
      const untracked = gitOk(repo.root, ['ls-tree', '-r', '--full-tree', '--name-only', '-z', `${sha}^3`], opts)
      for (const p of untracked.split('\0').filter(Boolean)) paths.add(p)
    }
    return { sha, base: base === '(no branch)' ? null : base, baseSha, date: Number(ct), files: paths.size }
  })
}

const PROOF_LABELS = { M1: 'merge or fast-forward', M2: 'rebase or cherry-pick', M3: 'squash' }

// One side's branches from `for-each-ref`, keyed by the name after `prefix`. Fields are `%00`-separated and the full refname is kept, so a name like
// `feat/a/b` or `fix-#3` comes back byte for byte, never re-split on whitespace or slashes. `%(upstream:track)` is `[gone]`, `[ahead N]`,
// `[ahead N, behind M]`, `[behind M]` or empty (in sync, or no upstream at all) — LC_ALL=C in `git()` keeps those words unlocalised.
function refsUnder(repo, prefix) {
  const format = ['%(refname)', '%(objectname)', '%(committerdate:unix)', '%(upstream:short)', '%(upstream:track)'].join('%00')
  const out = gitOk(repo.root, ['for-each-ref', `--format=${format}`, prefix], { env: repo.env })
  const refs = new Map()
  for (const line of out.split('\n').filter(Boolean)) {
    const [refname, sha, date, upstream, track] = line.split('\0')
    refs.set(refname.slice(prefix.length), { sha, date: Number(date), upstream: upstream || null, track })
  }
  return refs
}

// §5 classification, one record per branch name across `refs/heads/*` and `refs/remotes/origin/*`, minus the trunk and the name `HEAD` on both
// sides (`origin/HEAD` is a symref, and a local `refs/heads/HEAD` is a pathological ref no user means as a branch).
//
// Proof ref: the local trunk when the repo may push, since phase 6 publishes it before `apply` (which re-proves every deletion against
// `origin/<trunk>`, Task 11); `origin/<trunk>` when downgraded, because that trunk is never pushed here and a proof against it would only offer
// deletions apply must refuse. Either may be missing (a fresh clone, a pruned remote): then nothing is proven — `mergeProof` throws on a missing ref
// (R12), and no proof is the safe answer, never a crash.
//
// Merged means every present tip is proven (Review Focus 1): this box can have merged `feat` while the other one pushed more onto `origin/feat`, and
// deleting both would lose that work. M4 (GitHub's merged-PR head equal to a tip) only fills in when M1–M3 left something unproven, and only for a
// single unproven tip, since one PR head can't equal two different ones. The same `prLookup` answers the open-PR check, so it runs for every record.
// When that lookup failed on a GitHub remote (R17), nothing is proven at all: an open PR can't be ruled out, and §5 never offers an open-PR branch
// for deletion, so the record takes its unproven bucket with `PR status unknown (gh failed)` appended to the reason. `gh` being absent is the
// exception — that is the machine's standing situation, not a failed check, so M1–M3 stand and the survey's `gh: 'absent'` carries the caveat.
//
// Buckets, first match wins (§5): protected (open PR, locked worktree, mid-rebase/bisect in a worktree, or checked out in this tree — including
// mid-rebase/bisect here, when HEAD reads detached but the branch is still git's to move back onto), merged, gone-unproven, abandoned, active.
// `git worktree add -f` can put one branch in several worktrees, so they are grouped per branch: any locked one protects it. `worktree` names the
// first of them; `survey` checks every one for the merged set.
//
// `ahead` is measured against `origin/<name>` whenever that exists — the ref a branch push would update — not the configured upstream, which may
// be unset (pushed without `-u`) or point elsewhere (a branch tracking `origin/main`); either would hide unpushed work or invent it. Without a
// remote copy it falls back to the upstream's own count, and is 0 with neither. `unpushed` is set only for active records (R4) and never in a
// downgraded repo, which neither pushes branches nor lists remote-only ones (§6).
export function branchRecords(repo, worktrees = listWorktrees(repo)) {
  const opts = { env: repo.env }
  const locals = refsUnder(repo, 'refs/heads/')
  const remotes = refsUnder(repo, 'refs/remotes/origin/')
  locals.delete('HEAD')
  remotes.delete('HEAD')
  const proofRef = repo.pushAllowed ? `refs/heads/${repo.trunk}` : `refs/remotes/origin/${repo.trunk}`
  const canProve = refExists(repo, proofRef)
  const headRef = git(repo.root, ['symbolic-ref', '-q', 'HEAD'], opts)
  const current = headRef.status === 0 ? headRef.stdout.trim().replace(/^refs\/heads\//, '') : null
  const mainHeld = current === null ? heldBranch(repo, repo.gitDir) : null
  const wtsByBranch = new Map()
  for (const wt of worktrees.filter((x) => x.branch)) wtsByBranch.set(wt.branch, [...(wtsByBranch.get(wt.branch) ?? []), wt])
  const now = Math.floor(Date.now() / 1000)
  const staleSecs = repo.config.staleDays * 86400

  const proofs = new Map()
  const proofOf = (sha) => {
    if (!canProve) return null
    if (!proofs.has(sha)) {
      try {
        proofs.set(sha, mergeProof(repo, sha, proofRef))
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        proofs.set(sha, null)
      }
    }
    return proofs.get(sha)
  }

  const names = [...new Set([...locals.keys(), ...remotes.keys()])].filter((n) => n !== repo.trunk).sort()
  const records = []
  for (const name of names) {
    const l = locals.get(name)
    const rm = remotes.get(name)
    if (repo.downgraded && !l) continue
    const trackAhead = (track) => Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
    let ahead = 0
    if (l && rm) {
      if (l.upstream === `origin/${name}`) ahead = trackAhead(l.track)
      else if (l.sha !== rm.sha) {
        ahead = Number(gitOk(repo.root, ['rev-list', '--count', `refs/remotes/origin/${name}..refs/heads/${name}`], opts))
      }
    } else if (l) ahead = trackAhead(l.track)
    const local = l ? { sha: l.sha, date: l.date, upstream: l.upstream, gone: l.track === '[gone]', ahead } : null
    const remote = rm ? { sha: rm.sha, date: rm.date } : null
    const tips = [local?.sha, remote?.sha].filter(Boolean)
    const unproven = [...new Set(tips.filter((sha) => proofOf(sha) === null))]

    const pr = prLookup(repo, name, unproven.length === 1 ? unproven[0] : tips[0])
    // The record's proof is the local tip's (the remote's when there is no local); M4 stands in for whichever single tip only the PR proves.
    const m4 = unproven.length === 1 && pr.state === 'merged-at-tip'
    const prUnknown = pr.state === 'unavailable' && ghStatus(repo) !== 'absent'
    const proof = !prUnknown && (unproven.length === 0 || m4) ? (proofOf(tips[0]) ?? 'M4') : null
    let reason = proof ? `merged: ${proof === 'M4' ? `PR #${pr.number}` : PROOF_LABELS[proof]} (${proof})` : null

    const wts = wtsByBranch.get(name) ?? []
    const busy = wts.find((x) => x.inProgress)
    const newest = Math.max(local?.date ?? 0, remote?.date ?? 0)
    let bucket
    if (pr.state === 'open') [bucket, reason] = ['protected', `open PR #${pr.number}`]
    else if (wts.some((x) => x.locked)) [bucket, reason] = ['protected', 'checked out in a locked worktree']
    else if (busy) [bucket, reason] = ['protected', `mid-${busy.inProgress} in a worktree`]
    else if (name === current) [bucket, reason] = ['protected', 'checked out in the main tree']
    else if (name === mainHeld?.branch) [bucket, reason] = ['protected', `mid-${mainHeld.op} in the main tree`]
    else if (proof) bucket = 'merged'
    else if (local?.gone) [bucket, reason] = ['gone-unproven', 'remote deleted, not provably merged']
    else if (now - newest > staleSecs) [bucket, reason] = ['abandoned', `${Math.floor((now - newest) / 86400)}d without commits`]
    else [bucket, reason] = ['active', 'recent']
    if (prUnknown) reason = `${reason}; PR status unknown (gh failed)`

    let unpushed = null
    if (bucket === 'active' && !repo.downgraded && local) {
      if (!remote) unpushed = 'local-only'
      else if (local.ahead > 0) unpushed = 'ahead'
    }
    records.push({
      name,
      local,
      remote,
      bucket,
      proof,
      reason,
      unpushed,
      worktree: wts[0]?.path ?? null,
      openPr: pr.state === 'open' ? pr.number : null,
    })
  }
  return records
}

// Phase 3 (§4): the read-only picture the decision round is built from. Writes nothing itself — `main` mirrors the envelope into survey.json, the
// only state this phase leaves (T7.10). `gh` is read after the branch loop so its cached answer is the loop's own (R13); a remote that isn't GitHub
// never had a PR lookup to run, so it reports `unavailable` without spawning `gh` just to learn that. A merged branch joins `mergedSet` only when
// every worktree holding it is clean, since removing that worktree is part of the one-confirmation deletion. The decision round's questions are
// built from this same payload, so what SKILL.md asks and what `plan` later accepts can never disagree.
function survey(ctx) {
  const r = repo(ctx.root, { env: ctx.env })
  const worktrees = listWorktrees(r)
  const branches = branchRecords(r, worktrees)
  const stashes = listStashes(r)
  const gh = r.remoteKind === 'github' ? ghStatus(r) : 'unavailable'
  const mergedSet = branches
    .filter((b) => b.bucket === 'merged' && worktrees.every((wt) => wt.branch !== b.name || wt.dirty === 0))
    .map((b) => b.name)
  const payload = {
    trunk: r.trunk,
    remoteKind: r.remoteKind,
    pushAllowed: r.pushAllowed,
    downgraded: r.downgraded,
    staleDays: r.config.staleDays,
    gh,
    branches,
    worktrees,
    stashes,
    mergedSet,
  }
  return { ...payload, ...rounds(payload) }
}

// AskUserQuestion's limits: 4 questions per call, 4 options per question, a header of at most 12 characters.
const PER_CALL = 4
const PER_QUESTION = 4

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const daysOld = (epoch) => Math.max(0, Math.floor((Date.now() / 1000 - epoch) / 86400))

function chunks(xs, n) {
  const out = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// Everything the decision round may ask about, in one place, so `rounds` (what is offered) and `buildPlan` (what an answer may name) are the same
// predicate and can't drift apart. Asked: abandoned and gone-unproven only — protected and active are never offered for deletion (§5). Push: only
// records the survey flagged `unpushed`, and none at all when downgraded (§6). Worktrees: one that is dirty, detached, or on a branch outside the
// merged set — a clean one on a merged-set branch goes with its branch instead. Locked and mid-rebase/bisect ones are never touched (§5, R18), and a
// prunable one only needs the metadata prune apply runs anyway.
function offered(survey) {
  const byName = new Map(survey.branches.map((b) => [b.name, b]))
  const inSet = new Set(survey.mergedSet)
  return {
    byName,
    merged: survey.mergedSet.map((n) => byName.get(n)).filter(Boolean),
    asked: survey.branches.filter((b) => b.bucket === 'abandoned' || b.bucket === 'gone-unproven'),
    push: survey.downgraded ? [] : survey.branches.filter((b) => b.unpushed && b.local),
    stashes: survey.stashes,
    worktrees: survey.worktrees.filter(
      (wt) => !wt.locked && !wt.prunable && !wt.inProgress && (wt.dirty > 0 || wt.branch === null || !inSet.has(wt.branch)),
    ),
  }
}

// Worktrees a branch deletion must take with it: every one holding the branch, bar prunable ones, whose directory is already gone.
const holdersOf = (survey, name) => survey.worktrees.filter((wt) => wt.branch === name && !wt.prunable)

// A branch as an option: its exact name as the label, so an answer maps back without parsing. `ahead` is shown only when there is something it was
// counted against (a remote copy or an upstream); a local-only branch's 0 would read as "nothing to lose". A downgraded repo never touches the
// remote, so a remote copy there is named as kept rather than implied deleted.
function branchOption(survey, rec) {
  const parts = [`${daysOld(Math.max(rec.local?.date ?? 0, rec.remote?.date ?? 0))}d old`]
  if (rec.local && (rec.remote || rec.local.upstream)) parts.push(`${plural(rec.local.ahead, 'commit')} ahead`)
  if (rec.local && rec.remote) parts.push(survey.downgraded ? 'local+remote (remote kept)' : 'local+remote')
  else parts.push(rec.local ? 'local only' : 'remote only')
  parts.push(rec.reason)
  return { label: rec.name, description: parts.join(', ') }
}

// R19: AskUserQuestion takes 2–4 options per question, so a lone candidate gets this second option meaning "none of these". Git forbids spaces in
// branch names, so neither label can ever collide with a real one; `buildPlan` drops it from an answer.
const SENTINELS = {
  asked: { label: 'Keep all', description: 'Delete nothing from this list' },
  'merged-pick': { label: 'Keep all', description: 'Delete nothing from this list' },
  push: { label: 'Push none', description: 'Push nothing' },
}

// Fills 4-option chunks in candidate order and, when that would leave a lone last option (R19), moves one over from the chunk before: 5 → 3/2,
// 9 → 4/3/2, 13 → 4/4/3/2. Only a list of exactly one stays a single-option chunk, which the caller pads with its sentinel.
function balancedChunks(xs) {
  const parts = chunks(xs, PER_QUESTION)
  if (parts.length > 1 && parts.at(-1).length === 1) parts.at(-1).unshift(parts.at(-2).pop())
  return parts
}

// A multiSelect over branches, split into chunks `<prefix>:0..n-1` so a long list still fits the tool.
function branchChunks(survey, recs, prefix, header, ask) {
  const parts = balancedChunks(recs)
  return parts.map((part, i) => {
    const options = part.map((rec) => branchOption(survey, rec))
    if (options.length === 1) options.push(SENTINELS[prefix])
    return { id: `${prefix}:${i}`, header, question: parts.length > 1 ? `${ask} (${i + 1} of ${parts.length})` : ask, multiSelect: true, options }
  })
}

function stashQuestion(survey, s) {
  const lost = plural(s.files, 'changed file')
  return {
    id: `stash:${s.sha}`,
    header: 'Stash',
    question: `Stash ${s.sha.slice(0, 7)} on ${s.base ?? 'a detached HEAD'}, ${lost}, ${daysOld(s.date)}d old: what should happen to it?`,
    multiSelect: false,
    options: [
      !survey.downgraded && { label: 'Branch + push', description: 'Commit it onto a new branch at its base and push that branch' },
      { label: 'Branch, local', description: 'Commit it onto a new local branch at its base, not pushed' },
      { label: 'Drop', description: `Discard it; its ${lost} will be lost` },
      { label: 'Keep stash', description: 'Leave it in the stash list' },
    ].filter(Boolean),
  }
}

// Remove names what goes with the worktree (R14: ignored files count, so the wording says so). A clean detached one can still hold the only ref
// to commits made there — its HEAD reflog is deleted with it — so that case says as much rather than "nothing is lost".
function worktreeQuestion(survey, wt) {
  const rec = wt.branch ? survey.branches.find((b) => b.name === wt.branch) : null
  const on = wt.branch ? `on ${wt.branch}` : `detached at ${wt.head?.slice(0, 7)}`
  let remove
  if (wt.dirty > 0) remove = `${plural(wt.dirty, 'changed or ignored file')} will be lost`
  else if (wt.branch) remove = `Clean; nothing is lost`
  else remove = 'Clean, but commits reachable only from its HEAD become unreachable'
  if (rec?.bucket === 'merged') remove += `; merged branch ${wt.branch} is deleted with it`
  else if (wt.branch) remove += `; branch ${wt.branch} is kept`
  return {
    id: `worktree:${wt.path}`,
    header: 'Worktree',
    question: `Worktree ${wt.path} (${on}, ${wt.dirty > 0 ? plural(wt.dirty, 'changed file') : 'clean'}): keep or remove it?`,
    multiSelect: false,
    options: [
      { label: 'Keep', description: 'Leave the worktree as it is' },
      { label: 'Remove', description: remove },
    ],
  }
}

// §7's decision round, in the fixed order merged → asked → push → stashes → worktrees, packed into calls of at most 4 questions without reordering
// (SKILL.md asks them back to back). "Let me pick" on the merged question opens `followups.merged`, which is packed the same way. The merged counts
// are exactly what `buildPlan` would emit for "Delete all": remote copies only where a remote delete is allowed, worktrees bar prunable ones.
export function rounds(survey) {
  const o = offered(survey)
  const questions = []
  if (o.merged.length > 0) {
    const remotes = survey.downgraded ? 0 : o.merged.filter((b) => b.remote).length
    const wts = o.merged.reduce((n, b) => n + holdersOf(survey, b.name).length, 0)
    const counts = `${plural(o.merged.length, 'branch', 'branches')}, ${plural(remotes, 'remote copy', 'remote copies')}, ${plural(wts, 'worktree')}`
    questions.push({
      id: 'merged',
      header: 'Merged',
      question: `Delete the branches proven merged into ${survey.trunk}: ${counts}?`,
      multiSelect: false,
      options: [
        { label: 'Delete all', description: counts },
        { label: 'Let me pick', description: 'Choose which merged branches to delete in a follow-up question' },
        { label: 'Keep all', description: 'Delete none of them' },
      ],
    })
  }
  questions.push(...branchChunks(survey, o.asked, 'asked', 'Abandoned', 'Delete which unmerged branches? Ticked ones are deleted.'))
  questions.push(...branchChunks(survey, o.push, 'push', 'Push', 'Push which branches to origin with an upstream? Ticked ones are pushed.'))
  questions.push(...o.stashes.map((s) => stashQuestion(survey, s)))
  questions.push(...o.worktrees.map((wt) => worktreeQuestion(survey, wt)))
  const picks = branchChunks(survey, o.merged, 'merged-pick', 'Merged', 'Delete which merged branches? Ticked ones are deleted, with their clean worktrees.')
  return { rounds: chunks(questions, PER_CALL), followups: { merged: chunks(picks, PER_CALL) }, unattended: unattended(survey, o) }
}

// R37: the standing answers for a session with no AskUserQuestion. The user approved cleaning up merged work in advance, so the merged set goes, and
// so does every offered worktree on a merged branch — dirty ones included, which takes the branch along with it. Everything else stays unanswered,
// which means keep. Built from `offered` like the questions, so `buildPlan` accepts them by construction.
function unattended(survey, o) {
  const answers = {}
  if (o.merged.length > 0) answers.merged = 'all'
  const wts = o.worktrees.filter((wt) => wt.branch && o.byName.get(wt.branch)?.bucket === 'merged')
  if (wts.length > 0) answers.worktrees = Object.fromEntries(wts.map((wt) => [wt.path, 'remove']))
  return answers
}

const ANSWER_KEYS = new Set(['merged', 'asked', 'push', 'stashes', 'worktrees'])
const STASH_CHOICES = new Set(['branch-push', 'branch-local', 'drop', 'keep'])
const WORKTREE_CHOICES = new Set(['keep', 'remove'])
// §10.9: stash actions, worktree removals, branch pushes, remote deletions, local deletions. Stash first so a stash's branch exists before anything
// else runs; worktrees before branches because git refuses to delete a branch a worktree still holds; remote before local so the local copy — the
// recovery point — is the last thing to go.
const ACTION_RANK = { 'stash-branch': 0, 'stash-drop': 0, 'remove-worktree': 1, 'push-branch': 2, 'delete-remote': 3, 'delete-local': 4 }
const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

// Answers → plan actions (§7). The answers file is JSON the SKILL layer writes from the model's reading of AskUserQuestion, so it is validated as
// strictly as untrusted input: every name, sha and path must be one a question offered for that very choice, or the whole plan stops with
// `bad-answers` — a typo must never turn into deleting something nobody was asked about. A missing answer means keep (§7).
//
// Each action carries `expectTip` as the survey saw it (a worktree's HEAD, a stash's own sha) so apply can refuse anything that moved since; apply
// still re-proves every merged deletion itself (R16), `proof` being the survey's label for the report. A remote copy is deleted only where the repo
// may touch its remote (§6). A worktree the user removes takes its branch along only when that branch is merged and no other worktree still holds it.
export function buildPlan(survey, answers) {
  const bad = (why, value) => {
    throw new Stop('bad-answers', { why, value })
  }
  if (!isPlainObject(answers)) bad('answers must be a JSON object', answers)
  for (const key of Object.keys(answers)) if (!ANSWER_KEYS.has(key)) bad('unknown answer key', key)
  const o = offered(survey)

  // A sentinel (R19) names no branch, so it is dropped wherever it appears — alone it is an empty answer, beside real names it adds nothing.
  const pick = (key, pool, sentinel) => {
    const list = answers[key]
    if (list === undefined) return []
    if (!Array.isArray(list)) bad(`${key} must be a list of branch names`, list)
    const allowed = new Map(pool.map((b) => [b.name, b]))
    const seen = new Set()
    return list.filter((name) => name !== sentinel).map((name) => {
      if (typeof name !== 'string' || !allowed.has(name)) bad(`${key} names a branch it was not offered`, name)
      if (seen.has(name)) bad(`${key} names a branch twice`, name)
      seen.add(name)
      return allowed.get(name)
    })
  }
  const choices = (key, allowedKeys, allowedValues) => {
    const map = answers[key] === undefined ? {} : answers[key]
    if (!isPlainObject(map)) bad(`${key} must be an object`, map)
    for (const [k, v] of Object.entries(map)) {
      if (!allowedKeys.has(k)) bad(`${key} names something it was not offered`, k)
      if (!allowedValues.has(v)) bad(`${key} has an unknown choice`, v)
    }
    return map
  }

  let merged
  if (answers.merged === 'all') merged = o.merged
  else if (answers.merged === 'none') merged = []
  else merged = pick('merged', o.merged, SENTINELS['merged-pick'].label)
  const asked = pick('asked', o.asked, SENTINELS.asked.label)
  if (survey.downgraded && Array.isArray(answers.push) && answers.push.length > 0) bad('a downgraded repo pushes no branches', answers.push)
  const push = pick('push', o.push, SENTINELS.push.label)
  const stashAnswers = choices('stashes', new Set(o.stashes.map((s) => s.sha)), STASH_CHOICES)
  if (survey.downgraded && Object.values(stashAnswers).includes('branch-push')) bad('a downgraded repo pushes no branches', 'branch-push')
  const wtAnswers = choices('worktrees', new Set(o.worktrees.map((wt) => wt.path)), WORKTREE_CHOICES)

  const actions = []
  const deleting = new Set()
  const deleteBranch = (rec, basis) => {
    if (deleting.has(rec.name)) return
    deleting.add(rec.name)
    const why = basis === 'merged' ? { basis, proof: rec.proof } : { basis }
    if (rec.remote && !survey.downgraded) actions.push({ kind: 'delete-remote', target: rec.name, expectTip: rec.remote.sha, ...why })
    if (rec.local) actions.push({ kind: 'delete-local', target: rec.name, expectTip: rec.local.sha, ...why })
  }

  for (const rec of merged) {
    for (const wt of holdersOf(survey, rec.name)) {
      actions.push({ kind: 'remove-worktree', target: wt.path, expectTip: wt.head, force: false, expectDirty: 0, basis: 'merged', proof: rec.proof })
    }
    deleteBranch(rec, 'merged')
  }
  for (const rec of asked) deleteBranch(rec, 'picked')
  for (const rec of push) actions.push({ kind: 'push-branch', target: rec.name, expectTip: rec.local.sha })
  for (const s of o.stashes) {
    const choice = stashAnswers[s.sha]
    if (choice === 'branch-push' || choice === 'branch-local') {
      actions.push({ kind: 'stash-branch', target: s.sha, expectTip: s.sha, push: choice === 'branch-push', baseSha: s.baseSha })
    } else if (choice === 'drop') actions.push({ kind: 'stash-drop', target: s.sha, expectTip: s.sha })
  }
  const removed = new Set(o.worktrees.filter((wt) => wtAnswers[wt.path] === 'remove').map((wt) => wt.path))
  for (const wt of o.worktrees.filter((x) => removed.has(x.path))) {
    actions.push({ kind: 'remove-worktree', target: wt.path, expectTip: wt.head, force: wt.dirty > 0, expectDirty: wt.dirty })
  }
  for (const wt of o.worktrees.filter((x) => removed.has(x.path) && x.branch)) {
    const rec = o.byName.get(wt.branch)
    if (rec?.bucket === 'merged' && holdersOf(survey, rec.name).every((x) => removed.has(x.path))) deleteBranch(rec, 'merged')
  }
  // Array#sort is stable, so within one kind the answers' own order survives.
  return actions.sort((a, b) => ACTION_RANK[a.kind] - ACTION_RANK[b.kind])
}

// Phase 4 (§7): the plan for the answers in `answersFile` (none → `{}`, an empty plan), built against the survey.json this run's survey wrote —
// the plan is only meaningful against the exact tips that survey saw, so without one there is nothing to build against.
function plan(ctx, answersFile) {
  let answers = {}
  if (answersFile !== null) {
    try {
      answers = JSON.parse(fs.readFileSync(answersFile, 'utf8'))
    } catch (err) {
      throw new Stop('bad-answers', { why: 'answers file unreadable or not JSON', file: answersFile, error: err.message })
    }
  }
  const surveyed = readState(ctx, 'survey')
  if (!surveyed?.ok) throw new Stop('no-survey', { stateDir: ctx.stateDir })
  return { actions: buildPlan(surveyed, answers) }
}

// §9 check discovery: package manager per lockfile, in priority order — only one is ever present
// in practice, but a fixed order keeps the pick deterministic if more than one lockfile survives a
// merge. No lockfile at all defaults to npm, per the brief.
const NODE_PACKAGE_MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lockb', 'bun'],
]

function nodePackageManager(root) {
  const found = NODE_PACKAGE_MANAGERS.find(([file]) => fs.existsSync(path.join(root, file)))
  return found ? found[1] : 'npm'
}

// Root `package.json` scripts, in the fixed order the brief wants them run: typecheck (else
// type-check, never both), lint, test — whichever exist. `null`, not `[]`, when none exist at all,
// so `discoverChecks` can tell "a package.json with nothing to run" from "no package.json" and fall
// through to the Makefile the same way either way.
function nodeChecks(root) {
  const pkgPath = path.join(root, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  let scripts
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.scripts ?? {}
  } catch {
    return null
  }
  const names = []
  if (typeof scripts.typecheck === 'string') names.push('typecheck')
  else if (typeof scripts['type-check'] === 'string') names.push('type-check')
  if (typeof scripts.lint === 'string') names.push('lint')
  if (typeof scripts.test === 'string') names.push('test')
  if (names.length === 0) return null
  const pm = nodePackageManager(root)
  return names.map((name) => ({ name, cmd: pm, args: ['run', name], shell: false }))
}

// A root Makefile with a `lint:` and/or `test:` target line — checked by literal prefix, not
// parsed, since that's all the brief asks for. `null` when neither target exists, same reason as
// `nodeChecks`: an uninteresting Makefile (only `build:`, say) must still fall through to pytest.
function makeChecks(root) {
  const makefilePath = path.join(root, 'Makefile')
  if (!fs.existsSync(makefilePath)) return null
  const lines = fs.readFileSync(makefilePath, 'utf8').split('\n')
  const names = ['lint', 'test'].filter((target) => lines.some((line) => line.startsWith(`${target}:`)))
  if (names.length === 0) return null
  return names.map((name) => ({ name, cmd: 'make', args: [name], shell: false }))
}

// The last fallback: a Python project with pytest configured, either via `pytest.ini` or a
// `[tool.pytest` section of `pyproject.toml` (the exact prefix the brief names — good enough to
// catch `[tool.pytest.ini_options]` without a TOML parser). `uv.lock` picks `uv run` over a bare
// `python -m`, mirroring the Node side's lockfile-driven package-manager choice.
function pytestChecks(root) {
  const hasIni = fs.existsSync(path.join(root, 'pytest.ini'))
  const pyprojectPath = path.join(root, 'pyproject.toml')
  const hasPyprojectSection = fs.existsSync(pyprojectPath) && fs.readFileSync(pyprojectPath, 'utf8').includes('[tool.pytest')
  if (!hasIni && !hasPyprojectSection) return null
  const useUv = fs.existsSync(path.join(root, 'uv.lock'))
  return useUv
    ? [{ name: 'test', cmd: 'uv', args: ['run', 'pytest', '-q'], shell: false }]
    : [{ name: 'test', cmd: 'python', args: ['-m', 'pytest', '-q'], shell: false }]
}

// §9: what `verify` will actually run. `git-sync.checks` (the user's own config) wins outright
// as one `shell: true` check — the one place in this engine a shell is intentional, since the
// command is arbitrary user-authored text, not an argv this engine assembles itself. Otherwise the
// first source that yields at least one check wins: Node, then Makefile, then pytest; a source that
// exists but yields nothing (a package.json with only a `build` script) falls through rather than
// stopping discovery, so a repo mixing a packaging-only package.json with a real Makefile still
// gets its Makefile checks.
export function discoverChecks(root, config) {
  if (config?.checks) return [{ name: 'custom', cmd: config.checks, args: [], shell: true }]
  return nodeChecks(root) ?? makeChecks(root) ?? pytestChecks(root) ?? []
}

// The frozen-install command per Node package manager (§9) — never the mutating variant, since an
// unattended check run must never rewrite a lockfile the survey/plan phases haven't seen.
const NODE_INSTALL_COMMANDS = {
  pnpm: ['pnpm', ['install', '--frozen-lockfile']],
  npm: ['npm', ['ci']],
  yarn: ['yarn', ['install', '--frozen-lockfile']],
  bun: ['bun', ['install', '--frozen-lockfile']],
}

// §9: whether an install must run before checks, and why — `null` when none is needed. Node only:
// a Makefile- or pytest-driven repo installs its own dependencies (or doesn't) outside this engine's
// remit. `node_modules` missing wins over a lockfile change when both are true, since either reason
// alone already means "install", and `node_modules-missing` is the more informative of the two.
// `verify` asks only when the Node source supplied the checks it chose, so a package.json alone never triggers it.
export function installFor(root, startHead, head, ctx) {
  if (!fs.existsSync(path.join(root, 'package.json'))) return null
  const [cmd, args] = NODE_INSTALL_COMMANDS[nodePackageManager(root)]
  if (!fs.existsSync(path.join(root, 'node_modules'))) return { cmd, args, reason: 'node_modules-missing' }
  if (lockfileChanged(ctx, startHead, head)) return { cmd, args, reason: 'lockfile-changed' }
  return null
}

// §9: 10 minutes, overridable only through `GIT_SYNC_CHECK_TIMEOUT_MS` — a test hook so the
// suite never has to wait out a real 10-minute hang to prove the timeout path. Read from the
// sandboxed `ctx.env` first (in-process tests build a ctx directly) and `process.env` second (the
// CLI subprocess path, where the whole child's environment already **is** the test's sandboxed one).
const DEFAULT_CHECK_TIMEOUT_MS = 600_000

function checkTimeoutMs(ctx) {
  const raw = ctx.env?.GIT_SYNC_CHECK_TIMEOUT_MS ?? process.env.GIT_SYNC_CHECK_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHECK_TIMEOUT_MS
}

// Sanitizes a check name for use as a filename — every name this engine itself generates
// (typecheck, type-check, lint, test, custom, install) is already filesystem-safe, but a future
// source or a stray character in one shouldn't be able to escape `stateDir` or collide on disk.
function sanitizeCheckName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

// Runs one check (or the install step, given the same shape) to completion: full stdout+stderr to
// its own log file, `CI=1` so a watch-mode test runner behaves, and a hard timeout. A check that
// could not be launched at all (ENOENT) has no output of its own, so spawnSync's error is logged
// instead: SKILL.md reads the log's tail for every failed check, and an empty one explains nothing.
//
// Timeout kill: `detached: true` makes the child the leader of its own process group (POSIX), and
// `timeout`/`killSignal` are spawnSync's own — built into the native synchronous wait, so they fire
// even though this call blocks the whole event loop. spawnSync's internal kill only ever signals
// that one pid, though, which is not enough for a real `pnpm → node → jest` chain: SIGKILL gives the
// direct child no chance to forward anything to what it spawned, so those grandchildren would live
// on as orphans. The fix needs no concurrency, because spawnSync has already returned by the time
// it runs: a synchronous `process.kill(-pid, 'SIGKILL')` right after, targeting the negative (group)
// pid, sweeps up anything the timeout left behind. (An async `spawn` + manual timer was the other
// option; this one stays inside the "spawnSync only" rule and needs no separate wait loop.)
//
// A timeout has two shapes. The direct child still running is killed by spawnSync (`SIGKILL`, no status). But a child that exits while a
// backgrounded grandchild still holds its stdout keeps spawnSync waiting on the pipe until the timeout, which then reports `error.code:
// 'ETIMEDOUT'` with no signal and the child's own status — often 0. Both are timeouts, never green, and both get the group kill, which reaches the
// grandchild because it inherited the group. The same group is why a Ctrl-C at the terminal does not reach a running check: it is no longer in the
// terminal's foreground group, so it runs on until its own timeout, which bounds it.
function runCheck(ctx, check, timeoutMs) {
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  const logPath = path.join(ctx.stateDir, `check-${sanitizeCheckName(check.name)}.log`)
  const env = { ...process.env, ...ctx.env, CI: '1' }
  const start = Date.now()
  const result = spawnSync(check.cmd, check.args, {
    cwd: ctx.root,
    env,
    shell: check.shell,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    detached: true,
  })
  const durationMs = Date.now() - start
  const timedOut = result.error?.code === 'ETIMEDOUT' || (result.signal === 'SIGKILL' && result.status === null)
  if (timedOut && result.pid) {
    try {
      process.kill(-result.pid, 'SIGKILL')
    } catch {
      // Nothing left in the group to clean up.
    }
  }
  const launchError = result.error && !timedOut ? `git-sync: could not run the check: ${result.error.message}\n` : ''
  fs.writeFileSync(logPath, (result.stdout ?? '') + (result.stderr ?? '') + launchError)
  const command = check.shell ? check.cmd : [check.cmd, ...check.args].join(' ')
  return { name: check.name, command, exit: result.status, durationMs, timedOut, log: logPath }
}

// §9: a `.nvmrc` naming a plain numeric version (`18`, `18.17.0`) whose components don't prefix-
// match the active `node --version` — spawned via PATH, so a test can stub it — earns a report
// warning. A non-numeric spec (`lts/*`, `lts/iron`, `node`) isn't a version this engine can compare
// against, so it's silently skipped rather than misread as a mismatch.
function parseNumericVersion(raw) {
  const trimmed = raw.trim().replace(/^v/, '')
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null
  return trimmed.split('.').map(Number)
}

function nvmrcWarning(root, env) {
  const nvmrcPath = path.join(root, '.nvmrc')
  if (!fs.existsSync(nvmrcPath)) return null
  const raw = fs.readFileSync(nvmrcPath, 'utf8').trim()
  const wanted = parseNumericVersion(raw)
  if (!wanted) return null
  const versionResult = spawnSync('node', ['--version'], { env: { ...process.env, ...env }, encoding: 'utf8' })
  if (versionResult.status !== 0) return null
  const active = parseNumericVersion(versionResult.stdout)
  if (!active) return null
  if (wanted.every((component, i) => active[i] === component)) return null
  return `.nvmrc wants ${raw}, active node is ${versionResult.stdout.trim()}`
}

// Phase 5 (§9): install if the tree needs it, then run every discovered check regardless of
// earlier failures — the model reads a log tail only for the ones that failed, so nothing is saved
// by stopping early. A failed install is red outright, with the checks it would have unblocked
// left unrun.
function verify(ctx) {
  const r = repo(ctx.root, { env: ctx.env })
  const head = gitOk(ctx.root, ['rev-parse', 'HEAD'], { env: ctx.env })
  // Preflight's `startHead` is what the tree currently installed most likely matches (same
  // reasoning as `sync`'s own fallback); a standalone `verify` with no preceding `preflight` this
  // run falls back to `head` itself, which makes the lockfile comparison a no-op rather than a
  // false trigger.
  const startHead = readState(ctx, 'preflight')?.startHead ?? head
  const timeoutMs = checkTimeoutMs(ctx)

  const warnings = []
  const nvmrc = nvmrcWarning(r.root, ctx.env)
  if (nvmrc) warnings.push(nvmrc)

  // Final review Minor 3: the install exists for the Node checks, so it runs only when they are the ones verify chose — never beside a
  // `git-sync.checks` override or a Makefile/pytest source that won discovery over a package.json with nothing to run.
  const discovered = discoverChecks(r.root, r.config)
  const nodeSourced = !r.config?.checks && nodeChecks(r.root) !== null

  let install = null
  const installSpec = nodeSourced ? installFor(r.root, startHead, head, ctx) : null
  if (installSpec) {
    const record = runCheck(ctx, { name: 'install', cmd: installSpec.cmd, args: installSpec.args, shell: false }, timeoutMs)
    install = { command: record.command, exit: record.exit, log: record.log, reason: installSpec.reason }
    if (record.exit !== 0) return { sha: head, status: 'red', install, checks: [], warnings }
  }

  const checks = discovered.map((check) => runCheck(ctx, check, timeoutMs))
  const status = discovered.length === 0 ? 'unverified' : checks.some((c) => c.exit !== 0 || c.timedOut) ? 'red' : 'green'

  return { sha: head, status, install, checks, warnings }
}

// Phase 6 (§4, §10.6): push the trunk only when this exact HEAD already has a verify.json that
// isn't red. `ahead` is read straight off the last-known `refs/remotes/origin/<trunk>` — this
// never fetches first (that's sync's job), so a push race with another machine surfaces as an
// ordinary rejection below rather than something this phase tries to detect in advance. Ordered
// per §10.6: not-allowed, then no-verify, then stale-verify, then red, then (R21) the
// remote-tracking ref itself, then nothing-to-push, then the push. The verify gates never need
// `ahead`, so they report `null` for it rather than paying for a `rev-list` before it's known the
// range is even resolvable — that range is exactly what R21 exists to guard: without a local
// `refs/remotes/origin/<trunk>` (never fetched, or the trunk has no upstream at all), `A..B`
// names an unknown revision and `gitOk` throws a plain `GitError`, which `main()`'s catch doesn't
// intercept (only `Stop` is), crashing the process instead of emitting the one JSON envelope every
// subcommand owes. That's reported the same way any other unpushable state is: `ok:true`,
// `reason:'rejected'`, with `detail` naming what's missing.
function pushTrunk(ctx) {
  const r = repo(ctx.root, { env: ctx.env })
  const head = gitOk(ctx.root, ['rev-parse', `refs/heads/${r.trunk}`], { env: ctx.env })

  if (!r.pushAllowed) return { pushed: false, reason: 'not-allowed', ahead: null }

  const verifyState = readState(ctx, 'verify')
  if (!verifyState) return { pushed: false, reason: 'no-verify', ahead: null }
  if (verifyState.sha !== head) return { pushed: false, reason: 'stale-verify', ahead: null }
  if (verifyState.status === 'red') return { pushed: false, reason: 'red', ahead: null }

  const trackingRef = `refs/remotes/origin/${r.trunk}`
  if (!refExists(ctx, trackingRef)) {
    return { pushed: false, reason: 'rejected', ahead: null, detail: `no remote-tracking ref origin/${r.trunk}` }
  }

  const ahead = Number(gitOk(ctx.root, ['rev-list', '--count', `${trackingRef}..refs/heads/${r.trunk}`], { env: ctx.env }))
  if (ahead === 0) return { pushed: false, reason: 'nothing-to-push', ahead }

  // An explicit `<src>:<dst>` refspec, both full refnames, so this never depends on which branch
  // happens to be checked out or on the user's own `push.default`. Never `--force`/`+refspec`
  // (§10 invariant 4/6): a non-fast-forward rejection — the other machine got there first — is
  // folded into the same `rejected` outcome as any other non-zero exit (a missing remote, a
  // network failure); §10.6 only needs "did the push land", not why it didn't.
  const pushResult = git(
    ctx.root,
    [...SAFE_MUTATE_CONFIG, 'push', 'origin', `refs/heads/${r.trunk}:refs/heads/${r.trunk}`],
    { env: ctx.env },
  )
  if (pushResult.status !== 0) return { pushed: false, reason: 'rejected', ahead, detail: pushResult.stderr.trim() }

  return { pushed: true, reason: 'pushed', ahead }
}

// Phase 7 (§10): plan.json's actions, carried out. Nothing the plan says is trusted on its own — each action is re-checked against the live repo
// immediately before it runs, because the verify phase between plan and apply can take minutes and the other machine may push in the meantime.
// A check that fails skips that one action (`skipped`, with the reason); a git command that fails is `failed` with its stderr as `detail` (an
// optional Result field Task 11 adds). Either way the next action still runs (§10.9): one refused deletion must never strand the rest of a plan.

// A full object name (sha-1 or sha-256). `expectTip` becomes the lease's expected value and a comparison target, so a ref name like `main` there
// would be resolved locally at push time — refused as a malformed plan instead.
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BRANCH_ACTIONS = new Set(['push-branch', 'delete-remote', 'delete-local'])

// The plan to apply: `--plan <file>` when given (the SKILL layer's escape hatch, and the tests' hand-written plans), else the plan.json this run's
// `plan` wrote. Validated in full before anything runs, as strictly as `buildPlan` validates answers: a malformed plan stops with `bad-plan`
// rather than half-running. A branch target must be a valid branch name (`check-ref-format`), which also rules out the `:` that would split a
// refspec; a deletion must say whether it rests on a proof (`merged`) or on the user's pick, since only the former is re-proved.
function readPlan(ctx, planFile) {
  let planned
  if (planFile !== null) {
    try {
      planned = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    } catch (err) {
      throw new Stop('bad-plan', { why: 'plan file unreadable or not JSON', file: planFile, error: err.message })
    }
  } else {
    planned = readState(ctx, 'plan')
    if (!planned?.ok) throw new Stop('no-plan', { stateDir: ctx.stateDir })
  }
  const bad = (why, value) => {
    throw new Stop('bad-plan', { why, value })
  }
  if (!isPlainObject(planned) || !Array.isArray(planned.actions)) bad('a plan is an object with an actions list', planned)
  for (const a of planned.actions) {
    if (!isPlainObject(a) || !Object.hasOwn(ACTION_RANK, a.kind)) bad('unknown action kind', a)
    if (typeof a.target !== 'string' || a.target === '') bad('an action needs a target', a)
    if (typeof a.expectTip !== 'string' || !FULL_SHA.test(a.expectTip)) bad('expectTip must be a full sha', a)
    if (a.kind.startsWith('delete-') && a.basis !== 'merged' && a.basis !== 'picked') bad('a deletion needs a basis of merged or picked', a)
    if (BRANCH_ACTIONS.has(a.kind) && git(ctx.root, ['check-ref-format', `refs/heads/${a.target}`], { env: ctx.env }).status !== 0) {
      bad('not a branch name', a)
    }
    // A stash is only ever named by its own SHA (§10.5); a `stash@{n}` or a short name would be resolved against whatever sits there now.
    if (a.kind.startsWith('stash-') && a.target !== a.expectTip) bad('a stash action targets the stash sha it expects', a)
    if (a.kind === 'stash-branch' && a.baseSha !== undefined && (typeof a.baseSha !== 'string' || !FULL_SHA.test(a.baseSha))) {
      bad('baseSha must be a full sha', a)
    }
  }
  return planned.actions
}

// A branch's tip right now, or null when it no longer exists.
function localTipNow(r, name) {
  const res = git(r.root, ['rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`], { env: r.env })
  return res.status === 0 ? res.stdout.trim() : null
}

// R16 / Review Focus 2: a `merged` deletion re-proves the exact tip it is about to delete, against `origin/<trunk>` and never the local trunk. The
// survey proved against the local trunk because phase 6 normally publishes it — but when that push was refused (red checks, a rejection) the work
// would otherwise live only on a trunk the other machine cannot see. A successful phase-6 push has already moved `origin/<trunk>` (git updates the
// tracking ref on push), so the normal flow still deletes what it merged this run. A missing ref or object makes `mergeProof` throw (R12), which
// proves nothing. The PR lookup stands in only where the survey's own proof was M4, and only a merged-at-tip answer counts (an open PR, `none`
// or a failed `gh` all keep the branch).
function mergedOnOrigin(r, action, sha) {
  const ref = `refs/remotes/origin/${r.trunk}`
  if (!refExists(r, ref)) return false
  try {
    if (mergeProof(r, sha, ref) !== null) return true
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return false
  }
  return action.proof === 'M4' && prLookup(r, action.target, sha).state === 'merged-at-tip'
}

// Invariant 7: one line per deleted copy, `<ISO time>\t<hostname>\t<name>\t<local|remote>\t<sha>`, appended and never rewritten — it is the
// recovery record (`git branch <name> <sha>`), kept across preflight's state reset and across runs, and the hostname says which box's objects
// still hold the sha. Branch names cannot hold a tab or newline (`check-ref-format`), so the line always splits back into five fields.
//
// R36: the deletion has already happened by the time this runs, so a log that cannot be written (a full disk, a path that is not a file) must not
// throw the `done` result away — that result, sha and all, is what the report's recovery line is built from. It becomes a warning instead.
function logDeletion(ctx, name, side, sha) {
  try {
    fs.mkdirSync(ctx.stateDir, { recursive: true })
    fs.appendFileSync(path.join(ctx.stateDir, 'deleted.log'), `${new Date().toISOString()}\t${os.hostname()}\t${name}\t${side}\t${sha}\n`)
  } catch (err) {
    ctx.warnings?.push(`deleted.log not written for ${name} (${side} ${sha}): ${err.message}`)
  }
}

// The plan names a worktree by the path the survey printed (porcelain's resolved path); a hand-written plan may use the same directory through a
// symlink, so a target that still exists is also compared by its realpath.
function worktreeAt(r, target) {
  const real = fs.existsSync(target) ? fs.realpathSync(target) : null
  const wt = listWorktrees(r, { dirty: false }).find((w) => w.path === target || w.path === real)
  return wt ? { ...wt, dirty: worktreeDirty(r, wt.path, wt.prunable) } : null
}

// `worktree remove` throws away everything uncommitted in the tree, so it runs only on the exact tree the user saw: same HEAD, same dirty count
// (R14's count, ignored files outside the junk list included). `--force` only when the plan says the user chose to lose that dirt; without it git
// itself refuses a dirty tree. A locked tree is never removed (the lock is someone's explicit "keep"), nor one mid-rebase/bisect (R18) — a new
// reason, `in-progress`, the brief's list doesn't name. A prunable one the prune left behind is gone for this purpose. A removal on the `merged`
// basis rests on its branch's proof, so it is re-proved like that branch's own deletion (R16): the worktree's HEAD must be merged on
// `origin/<trunk>`, else `not-merged-on-origin`. The PR fallback needs the branch name, which a detached tree no longer carries.
function removeWorktree(r, a) {
  const wt = worktreeAt(r, a.target)
  if (!wt) return ['skipped', 'worktree-gone']
  if (wt.locked) return ['skipped', 'locked']
  if (wt.prunable) return ['skipped', 'worktree-gone']
  if (wt.inProgress) return ['skipped', 'in-progress']
  if (wt.head !== a.expectTip) return ['skipped', 'head-moved']
  if (wt.dirty !== (a.expectDirty ?? 0)) return ['skipped', 'worktree-changed']
  if (a.basis === 'merged' && !mergedOnOrigin(r, { target: wt.branch, proof: wt.branch ? a.proof : null }, wt.head)) {
    return ['skipped', 'not-merged-on-origin']
  }
  const force = a.force === true ? ['--force'] : []
  const res = git(r.root, [...SAFE_MUTATE_CONFIG, 'worktree', 'remove', ...force, '--', wt.path], { env: r.env })
  if (res.status !== 0) return ['failed', 'git-failed', res.stderr.trim()]
  return ['done', null]
}

// Invariant 4: never forced, so a branch the other machine already pushed under the same name is a rejection to report, not work to overwrite.
// Explicit full refnames on both sides keep the user's `push.default` and `remote.origin.push` out of it; `-u` is what makes the pushed branch
// track `origin/<b>`. `--no-follow-tags` because a `push.followTags` config would otherwise publish tags nobody chose to push.
function pushBranch(r, a) {
  if (a.target === r.trunk) return ['skipped', 'protected'] // R23: the trunk is published by push-trunk alone, behind verify
  if (r.downgraded) return ['skipped', 'downgraded']
  const tip = localTipNow(r, a.target)
  if (tip === null) return ['skipped', 'branch-gone']
  if (tip !== a.expectTip) return ['skipped', 'tip-moved']
  const res = pushWithUpstream(r, a.target)
  if (res.status !== 0) return ['failed', 'rejected', res.stderr.trim()]
  return ['done', null]
}

function pushWithUpstream(r, name) {
  const ref = `refs/heads/${name}`
  return git(r.root, [...SAFE_MUTATE_CONFIG, 'push', '--no-follow-tags', '-u', 'origin', `${ref}:${ref}`], { env: r.env })
}

// Invariant 3: the delete carries a lease on the remote tip the survey saw, with the expected value spelled out so it is checked against origin
// itself rather than against a tracking ref some later fetch may have moved. The other machine having pushed since (or deleted it already) makes
// the remote disagree, and git answers `stale info` — a skip, since nothing is wrong except that this deletion no longer applies. Any other
// failure (network, permissions) is `failed`.
function deleteRemote(ctx, r, a) {
  if (a.target === r.trunk) return ['skipped', 'protected'] // R23: the trunk is never deleted, whatever the plan says
  if (r.downgraded) return ['skipped', 'downgraded']
  if (a.basis === 'merged' && !mergedOnOrigin(r, a, a.expectTip)) return ['skipped', 'not-merged-on-origin']
  const ref = `refs/heads/${a.target}`
  const res = git(r.root, [...SAFE_MUTATE_CONFIG, 'push', `--force-with-lease=${ref}:${a.expectTip}`, 'origin', `:${ref}`], { env: r.env })
  if (res.status !== 0) return /stale info/.test(res.stderr) ? ['skipped', 'lease-failed'] : ['failed', 'rejected', res.stderr.trim()]
  logDeletion(ctx, a.target, 'remote', a.expectTip)
  // R30: `sha` rides on the Result itself — the tip actually deleted — so `report` can build its recovery line straight from this run's
  // apply.json instead of re-deriving it by lining the result up positionally against deleted.log's cross-run tail.
  return ['done', null, undefined, { sha: a.expectTip }]
}

// Invariants 1 and 2. The trunk and whatever this tree has checked out (or holds mid-rebase/bisect) are never deleted; nor is a branch any linked
// worktree present at this moment still holds — which, by §10.9's order, means one whose removal earlier in this same run was skipped. The tip is
// read live and must still be the one the survey saw, and a merged deletion re-proves that very tip (`mergedOnOrigin`).
function deleteLocal(ctx, r, a) {
  const head = git(r.root, ['symbolic-ref', '-q', 'HEAD'], { env: r.env })
  const current = head.status === 0 ? head.stdout.trim().replace(/^refs\/heads\//, '') : heldBranch(r, r.gitDir)?.branch
  if (a.target === r.trunk || a.target === current) return ['skipped', 'protected']
  if (listWorktrees(r, { dirty: false }).some((wt) => wt.branch === a.target)) return ['skipped', 'checked-out-in-worktree']
  const tip = localTipNow(r, a.target)
  if (tip === null) return ['skipped', 'branch-gone']
  if (tip !== a.expectTip) return ['skipped', 'tip-moved']
  if (a.basis === 'merged' && !mergedOnOrigin(r, a, tip)) return ['skipped', 'not-merged-on-origin']
  const res = git(r.root, [...SAFE_MUTATE_CONFIG, 'branch', '-D', '--', a.target], { env: r.env })
  if (res.status !== 0) return ['failed', 'git-failed', res.stderr.trim()]
  logDeletion(ctx, a.target, 'local', tip)
  return ['done', null, undefined, { sha: tip }] // R30, see deleteRemote's own note
}

// §10.5: where a stash sits in `stash list` right now, or null when it is no longer there. Indexes shift whenever an earlier stash is dropped or
// branched — by this very run, or by hand between survey and apply — so a drop resolves its index here, immediately before it runs, and never
// from one remembered earlier. `log.showSignature` off for the same reason as `listStashes`: `stash list` is `log -g` underneath.
export function stashIndexOf(ctx, sha) {
  const out = gitOk(ctx.root, ['-c', 'log.showSignature=false', 'stash', 'list', '--format=%H'], { env: ctx.env })
  const i = out === '' ? -1 : out.split('\n').indexOf(sha)
  return i === -1 ? null : i
}

function dropStash(r, sha) {
  const n = stashIndexOf(r, sha)
  if (n === null) return ['skipped', 'stash-gone']
  const res = git(r.root, [...SAFE_MUTATE_CONFIG, 'stash', 'drop', `stash@{${n}}`], { env: r.env })
  if (res.status !== 0) return ['failed', 'git-failed', res.stderr.trim()]
  return ['done', null]
}

// The stash's own date on this machine's calendar, since that is the day the user remembers stashing it.
function localYmd(epoch) {
  const d = new Date(epoch * 1000)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// `stash/<base or 'detached'>-<yyyymmdd>`, then `-2`, `-3` … while the name is taken. Taken means a local branch — and, for a branch about to be
// pushed, origin's copy as last fetched, so the push does not land on a name the other machine already published (a local-only branch need not
// dodge those) — or a name some existing branch sits *under* (`<name>/…`), since a ref cannot be both a file and a directory. The other direction
// admits no suffix: an existing branch at one of the name's own parent paths (`stash` itself, or `stash/feat` for a stash on `feat/x`) blocks
// every candidate alike, so it returns the blocker instead of a name, as it does for a base git will not accept inside a branch name.
function stashBranchName(r, stash, pushing) {
  const scopes = pushing ? ['refs/heads/', 'refs/remotes/origin/'] : ['refs/heads/']
  const refs = gitOk(r.root, ['for-each-ref', '--format=%(refname)', ...scopes], { env: r.env })
  const names = new Set(refs.split('\n').filter(Boolean).map((ref) => ref.replace(/^refs\/(?:heads|remotes\/origin)\//, '')))
  const stem = `stash/${stash.base ?? 'detached'}-${localYmd(stash.date)}`
  if (git(r.root, ['check-ref-format', '--branch', stem], { env: r.env }).status !== 0) return { detail: `${stem} is not a valid branch name` }
  const parts = stem.split('/')
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/')
    if (names.has(parent)) return { detail: `branch ${parent} exists, so no branch can be created under ${parent}/` }
  }
  const all = [...names]
  for (let k = 1; ; k++) {
    const name = k === 1 ? stem : `${stem}-${k}`
    if (!names.has(name) && !all.some((n) => n.startsWith(`${name}/`))) return { name }
  }
}

// A tree's files as path → `<mode> <oid>`. `-z` so no path is ever quoted or split, `--full-tree` so the listing never depends on a cwd.
function treeEntries(r, rev) {
  const out = gitOk(r.root, ['ls-tree', '-r', '-z', '--full-tree', rev], { env: r.env })
  const entries = new Map()
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t')
    const [mode, , oid] = rec.slice(0, tab).split(' ')
    entries.set(rec.slice(tab + 1), `${mode} ${oid}`)
  }
  return entries
}

// The paths two trees differ on, each mapped to the `to` side's `<mode> <oid>` — or null where `to` no longer has it. Raw plumbing output with
// full oids; the textconv/ext-diff/rename flags are spelled out because a user's diff config is exactly what this file never lets steer a parse.
function treeChanges(r, from, to) {
  const args = ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', from, to]
  const tokens = gitOk(r.root, args, { env: r.env }).split('\0')
  const changes = new Map()
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [, mode, , oid, status] = tokens[i].slice(1).split(' ')
    changes.set(tokens[i + 1], status === 'D' ? null : `${mode} ${oid}`)
  }
  return changes
}

// R26: what the branch commit fails to hold of the stash, checked before the stash may be dropped — against the stash's own commits, never
// against what the temporary tree happened to stage, because the misses are precisely what that tree cannot show: a submodule bump (a worktree
// never populates the submodule, so `add -A` sees no change), a mode change `core.fileMode=false` would hide, an ignored file `add -A` skips.
// Every path the worktree commit changes against its base must carry the stash's exact mode and oid in the commit (or be absent where the stash
// deleted it), and so must every file of the untracked tree `^3`. A path whose index version `^2` differs from both the base and the worktree
// version is partial staging: that content has no place in a single commit, so such a stash is unrepresentable however the commit came out.
function stashNotHeld(r, stash, commit) {
  const held = treeEntries(r, commit)
  const missing = []
  for (const [p, want] of treeChanges(r, `${stash.sha}^1`, stash.sha)) if ((held.get(p) ?? null) !== want) missing.push(p)
  if (git(r.root, ['rev-parse', '--verify', '-q', `${stash.sha}^3^{commit}`], { env: r.env }).status === 0) {
    for (const [p, want] of treeEntries(r, `${stash.sha}^3`)) if (held.get(p) !== want) missing.push(p)
  }
  const staged = treeChanges(r, `${stash.sha}^1`, `${stash.sha}^2`)
  for (const p of treeChanges(r, `${stash.sha}^2`, stash.sha).keys()) if (staged.has(p)) missing.push(`${p} (partially staged)`)
  return [...new Set(missing)]
}

// §10.5, invariant 5. The branch is built in a throwaway detached worktree at the plan's `baseSha` (the stash's own base unless a hand-written
// plan says otherwise), so the user's tree, index and HEAD are never touched — and a conflicting apply leaves its mess there, not here. Stash
// refs and objects are shared by every worktree, so `stash apply <sha>` restores the untracked part of a `-u` stash there as well. The temp
// tree's calls force `core.fileMode=true` (the tmpdir is a POSIX filesystem even on WSL, where the repo's own config often says false), so a
// chmod survives the round trip. The branch is created while the temp HEAD still references the commit — no gc window — and then proved to
// hold the stash exactly (`stashNotHeld`, R26); any failure or miss keeps the stash, and a miss deletes the branch again, by the commit it was
// made at. The stash is dropped only after that proof, by the index it has at that moment. The push is its own part: the branch is `done`
// whether it was pushed (`push: 'done'`), withheld on a downgraded repo (`'downgraded'`), or refused (`'rejected'`, git's stderr in `detail`) —
// never forced.
function stashBranch(r, a) {
  const stash = listStashes(r).find((s) => s.sha === a.target)
  if (!stash) return ['skipped', 'stash-gone']
  const { name, detail } = stashBranchName(r, stash, a.push === true && !r.downgraded)
  if (name === undefined) return ['skipped', 'name-conflict', detail]

  const opts = { env: r.env }
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-stash-'))
  } catch (err) {
    return ['failed', 'io-failed', err.message]
  }
  // A fresh child path rather than the mkdtemp directory itself, so `worktree add` never depends on how a given git treats an existing empty one.
  const tree = path.join(dir, 'wt')
  const inTree = [...SAFE_MUTATE_CONFIG, '-c', 'core.fileMode=true']
  try {
    const added = git(r.root, [...inTree, 'worktree', 'add', '--detach', tree, a.baseSha ?? stash.baseSha], opts)
    if (added.status !== 0) return ['failed', 'git-failed', added.stderr.trim()]
    const msg = `chore: branch stash ${stash.sha.slice(0, 7)} from ${stash.base ?? 'detached'}`
    for (const args of [['stash', 'apply', stash.sha], ['add', '-A']]) {
      const res = git(tree, [...inTree, ...args], opts)
      if (res.status !== 0) return ['skipped', 'stash-conflict', res.stderr.trim() || res.stdout.trim()]
    }
    // Final review Minor 6: a commit with nothing to commit means the branch could not hold the stash (only ignored files, say), a conflict of
    // the stash's own; any other commit failure — no identity, a signing hook — is git failing, reported as such, with the stash still kept.
    const committed = git(tree, [...inTree, 'commit', '--no-verify', '-q', '-m', msg], opts)
    if (committed.status !== 0) {
      const why = committed.stderr.trim() || committed.stdout.trim()
      if (/nothing (added )?to commit/.test(committed.stdout + committed.stderr)) return ['skipped', 'stash-conflict', why]
      return ['failed', 'git-failed', `stash kept: ${why}`]
    }
    const commit = gitOk(tree, ['rev-parse', 'HEAD'], opts)
    const created = git(r.root, [...SAFE_MUTATE_CONFIG, 'branch', '--no-track', '--', name, commit], opts)
    if (created.status !== 0) return ['failed', 'git-failed', created.stderr.trim()]
    const unmake = () => git(r.root, [...SAFE_MUTATE_CONFIG, 'update-ref', '-d', `refs/heads/${name}`, commit], opts)
    let missing
    try {
      missing = stashNotHeld(r, stash, commit)
    } catch (err) {
      unmake()
      throw err
    }
    if (missing.length > 0) {
      unmake()
      const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` (+${missing.length - 5} more)` : '')
      return ['skipped', 'stash-conflict', `a branch commit would not hold the stash exactly: ${shown}`]
    }
  } finally {
    // Non-throwing, so a cleanup failure never masks the outcome above; the prune drops the entry even if the removal itself failed, and a
    // directory left under the tmpdir is litter, not lost work.
    git(r.root, [...SAFE_MUTATE_CONFIG, 'worktree', 'remove', '--force', tree], opts)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    git(r.root, [...SAFE_MUTATE_CONFIG, 'worktree', 'prune'], opts)
  }

  const notes = []
  const [dropped, why, dropDetail] = dropStash(r, stash.sha)
  if (dropped !== 'done') notes.push(`stash not dropped (${why})${dropDetail ? `: ${dropDetail}` : ''}`)
  let extra
  if (a.push === true) {
    if (r.downgraded) extra = { push: 'downgraded' }
    else {
      const pushed = pushWithUpstream(r, name)
      extra = { push: pushed.status === 0 ? 'done' : 'rejected' }
      if (pushed.status !== 0) notes.push(pushed.stderr.trim())
    }
  }
  return ['done', name, notes.length > 0 ? notes.join('\n') : undefined, extra]
}

const APPLY_STEPS = {
  'stash-branch': (ctx, r, a) => stashBranch(r, a),
  'stash-drop': (ctx, r, a) => dropStash(r, a.target),
  'remove-worktree': (ctx, r, a) => removeWorktree(r, a),
  'push-branch': (ctx, r, a) => pushBranch(r, a),
  'delete-remote': deleteRemote,
  'delete-local': deleteLocal,
}

// R20: `worktree prune` runs first, so a worktree whose directory was deleted by hand no longer holds its branch when the deletions come to it;
// `pruned` is whatever the prune dropped from `worktree list`. The actions then run in §10.9 order whatever order the plan lists them in (a stable
// sort, so one kind keeps the plan's order). A linked worktree is refused as in preflight: this tree's HEAD is what `protected` guards, and from a
// linked tree the main tree's own branch would be hidden from the worktree list `delete-local` consults.
//
// R36: once the plan is loaded, apply.json is written on every way out. A failed prune is a warning, not an escape: the actions still run, and a
// worktree the prune would have dropped still holds its branch, so `delete-local` skips it. Any error inside one action is that action's `failed`
// result — `git-failed` for a git call, `internal` for anything else — and the rest still run. An error outside every action (listing the worktrees
// around the prune, say) writes what has run so far as a `partial` apply.json and then rethrows, so the caller still sees an engine failure (R33)
// while the report still prints a recovery line for every deletion this run made.
function apply(ctx, planFile) {
  if (ctx.linked) throw new Stop('linked-worktree', { root: ctx.root })
  const r = repo(ctx.root, { env: ctx.env })
  const actions = readPlan(ctx, planFile)

  const warnings = []
  const actx = { ...ctx, warnings }
  let pruned = []
  const results = []
  try {
    const before = listWorktrees(r, { dirty: false }).map((wt) => wt.path)
    const prune = git(r.root, [...SAFE_MUTATE_CONFIG, 'worktree', 'prune'], { env: r.env })
    if (prune.status !== 0) warnings.push(`worktree prune failed: ${prune.stderr.trim()}`)
    const after = new Set(listWorktrees(r, { dirty: false }).map((wt) => wt.path))
    pruned = before.filter((p) => !after.has(p))

    for (const a of [...actions].sort((x, y) => ACTION_RANK[x.kind] - ACTION_RANK[y.kind])) {
      let outcome
      try {
        outcome = APPLY_STEPS[a.kind](actx, r, a)
      } catch (err) {
        outcome = ['failed', err instanceof GitError ? 'git-failed' : 'internal', err.message]
      }
      const [status, reason, detail, extra] = outcome
      results.push({ kind: a.kind, target: a.target, status, reason, ...(detail === undefined ? {} : { detail }), ...extra })
    }
  } catch (err) {
    warnings.push(`apply stopped early: ${err.message}; results cover only the actions before it`)
    writeState(ctx, 'apply', { ok: true, cmd: 'apply', partial: true, pruned, results, warnings })
    throw err
  }
  return { pruned, results, warnings }
}

// Phase 8 (§12): turns the state files every earlier phase left behind into one markdown report,
// without re-touching the repo — this phase is pure read-and-render. `reason` codes on a Result
// are kept visible everywhere (T13/T14 read them back out of the report), but a handful the user
// would otherwise misread earn a short gloss in parentheses; everything else prints as its bare
// code, which is deliberately the more common case (R24's "word it neutrally" is the exception,
// not the rule — most reasons are already self-explanatory: `tip-moved`, `branch-gone`, …).
const REASON_TEXT = {
  // R24: also covers a remote branch the other machine already deleted — worded so neither reading
  // blames a specific actor.
  'lease-failed': 'remote branch changed or already gone',
  'in-progress': 'a rebase or bisect is in progress there',
  'git-failed': 'the git command failed',
  'not-merged-on-origin': 'not provably merged into the trunk on origin',
  // R36: an error that is not git's own, caught per action so the rest of the plan still ran.
  internal: 'an unexpected engine error; see detail',
  // R25/R26: these four skip reasons must say the stash itself was kept, except `stash-gone` —
  // there is no stash left to have kept.
  'io-failed': 'filesystem error while branching the stash; stash kept',
  'stash-conflict': 'the stash could not be applied cleanly; stash kept',
  'name-conflict': 'the branch name is already in use; stash kept',
  'stash-gone': 'the stash no longer exists',
  // push-trunk's own refusal reasons (§10.6).
  'not-allowed': 'pushing the trunk is disabled for this repo',
  'no-verify': 'no verify has run for this commit',
  'stale-verify': 'verify is for a different commit',
  red: 'checks are red',
  rejected: 'the push was rejected',
  'nothing-to-push': 'the trunk is already up to date on the remote',
}

function describeReason(reason) {
  if (reason == null) return 'unknown'
  const text = REASON_TEXT[reason]
  return text ? `${reason} (${text})` : reason
}

// R29: a recovery line exists so it can be pasted straight into a shell, and git's own `check-ref-format` allows characters — `$ ( ) ; & | \` ' "`
// among them — that are meaningful to `sh`. A name made only of the safe token characters prints bare (the common case, and lets the many existing
// examples in this file's own comments read naturally); anything else is POSIX single-quoted, with an embedded `'` escaped as `'\''` — the standard
// way to close the quote, emit a literal quote, and reopen it. A quoted token concatenates with the plain text around it into one shell word with no
// space needed, so this drops in wherever a name is interpolated without changing the surrounding line shape.
const SAFE_SH_TOKEN = /^[A-Za-z0-9._/@+-]+$/
function shQuote(s) {
  return SAFE_SH_TOKEN.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}

// §12 "Committed": every commit made on the branch preflight started this run on, since the SHA it
// started at — the model's own commit (stage-scan → commit) plus anything the user added by hand.
// `startBranch` may since have been deleted (rare: a user branch that was itself merged and
// cleaned up mid-run) or never existed as a ref name at all outside a test fixture, so a missing
// ref quietly yields no commits rather than a crash.
function commitsSince(ctx, preflightState) {
  if (!preflightState?.startBranch) return []
  if (!refExists(ctx, `refs/heads/${preflightState.startBranch}`)) return []
  const log = git(ctx.root, ['log', '--format=%h %s', `${preflightState.startHead}..${preflightState.startBranch}`], {
    env: ctx.env,
  })
  if (log.status !== 0) return []
  return log.stdout.split('\n').filter(Boolean).map((line) => `- ${line}`)
}

// §12 "Trunk": commits pulled, each discovered check's verdict, then whether the trunk push
// landed. Each piece is independent — a `sync` stop before `verify` ever ran still gets its own
// "pulled" line, an unverified repo (no checks discovered) still gets its push line.
function trunkLines(syncState, verifyState, pushTrunkState) {
  const lines = []
  if (syncState) lines.push(`- pulled ${syncState.pulled} commit${syncState.pulled === 1 ? '' : 's'}`)
  if (verifyState) {
    for (const check of verifyState.checks) {
      const verdict = check.timedOut ? 'timeout' : check.exit === 0 ? 'pass' : 'FAIL'
      lines.push(`- ${check.name}: ${verdict}`)
    }
  }
  if (pushTrunkState) {
    lines.push(
      pushTrunkState.pushed
        ? '- pushed'
        : `- not pushed: ${describeReason(pushTrunkState.reason)}${pushTrunkState.detail ? ` (${pushTrunkState.detail})` : ''}`,
    )
  }
  return lines
}

// §12 "Deleted"/"Kept". R30: built entirely from *this run's* apply.json, never from deleted.log — the log is a cross-run ledger (preflight's reset
// explicitly spares it), so pairing a Result up with "whichever log line happens to sit at the matching position in the tail" broke the moment apply
// ran twice without an intervening survey (§10.10 says that must always be safe): the second, no-op apply's own zero `done` deletes left nothing to
// pair against, which is correct for Deleted, but doesn't by itself stop Kept from describing an already-gone branch as merely "skipped". Each done
// delete-local/delete-remote Result now carries the tip it deleted as `sha` (added in `deleteLocal`/`deleteRemote` above), so Deleted reads it straight
// off the Result with no log lookup at all.
//
// A branch "survives" (and so appears under Kept) unless every side of it the survey saw (local, remote, or both) is now accounted for — either
// deleted this run (`done`) or, for the local side, already gone before this run ever started (`branch-gone`: unambiguous, since a local ref either
// exists or it doesn't). `lease-failed` is deliberately *not* treated as resolved here even though it can also mean "already gone" (R24) — it's
// genuinely ambiguous with "the other machine changed it first", so a side reported that way still counts as kept rather than silently dropped. A
// side resolved via `branch-gone` is left out of the "planned delete skipped" reasons entirely: printing "skipped: branch-gone" would read as "still
// there, we chose not to delete it", the opposite of what a resolved side means.
function buildDeletedAndKept(surveyState, applyState) {
  if (!surveyState) return { deleted: [], kept: [] }
  const results = applyState?.results ?? []
  const resultFor = (kind, target) => results.find((r) => r.kind === kind && r.target === target)
  const doneDeletes = results.filter((r) => (r.kind === 'delete-local' || r.kind === 'delete-remote') && r.status === 'done')

  const deleted = []
  for (const r of doneDeletes) {
    const bucket = surveyState.branches.find((b) => b.name === r.target)?.bucket ?? 'unknown'
    const side = r.kind === 'delete-remote' ? 'remote' : 'local'
    const name = shQuote(r.target)
    const recovery = side === 'local' ? `git branch ${name} ${r.sha}` : `git push origin ${r.sha}:refs/heads/${name}`
    deleted.push(`- ${r.target} (${bucket}) — ${side}`, `  \`${recovery}\``)
  }

  const resolved = (r) => r.status === 'done' || r.reason === 'branch-gone'
  const kept = []
  for (const rec of surveyState.branches) {
    const sides = []
    if (rec.local) sides.push(resultFor('delete-local', rec.name))
    if (rec.remote) sides.push(resultFor('delete-remote', rec.name))
    const attempted = sides.filter(Boolean)
    if (attempted.length > 0 && attempted.length === sides.length && attempted.every(resolved)) continue
    const skipped = [...new Set(attempted.filter((r) => !resolved(r)).map((r) => r.reason))]
    const reason = skipped.length > 0 ? `planned delete skipped: ${skipped.map(describeReason).join(', ')}` : rec.reason
    kept.push(`- ${rec.name} (${rec.bucket}): ${reason}`)
  }
  return { deleted, kept }
}

// §12 "Pushed branches": `push-branch` results only — stash and worktree actions get their own
// sections below.
function pushedBranchLines(applyState) {
  return (applyState?.results ?? [])
    .filter((r) => r.kind === 'push-branch')
    .map((r) =>
      r.status === 'done'
        ? `- ${r.target}: pushed`
        : `- ${r.target}: ${r.status} (${describeReason(r.reason)})${r.detail ? `: ${r.detail}` : ''}`,
    )
}

// §12 "Stashes": `stash-branch` names the branch it made (R25's `reason` — the branch name on
// `done`, an ordinary skip/fail code otherwise); `stash-drop` reports only whether the drop itself
// landed. `detail` on a `stash-branch` `done` carries either "stash not dropped" prose or a
// rejected push's stderr (or both, newline-joined by the engine) — shown indented under the line
// rather than folded into it, since either can be multi-line.
function stashLines(applyState) {
  return (applyState?.results ?? [])
    .filter((r) => r.kind === 'stash-branch' || r.kind === 'stash-drop')
    .map((r) => {
      const short = r.target.slice(0, 7)
      if (r.kind === 'stash-drop') {
        return r.status === 'done'
          ? `- ${short}: dropped`
          : `- ${short}: ${r.status} (${describeReason(r.reason)})${r.detail ? `: ${r.detail}` : ''}`
      }
      if (r.status !== 'done') return `- ${short}: ${r.status} (${describeReason(r.reason)})${r.detail ? `: ${r.detail}` : ''}`
      let line = `- ${short}: branched as ${r.reason}`
      if (r.push === 'done') line += ' (pushed)'
      else if (r.push === 'downgraded') line += ' (push skipped: repo downgraded)'
      else if (r.push === 'rejected') line += ' (push rejected)'
      if (r.detail) line += `\n  ${r.detail.split('\n').join('\n  ')}`
      return line
    })
}

// §12 "Worktrees": `apply`'s own metadata prune (R20) runs before any deletion and is reported
// first, then every `remove-worktree` result.
function worktreeLines(applyState) {
  if (!applyState) return []
  const lines = applyState.pruned.map((p) => `- pruned: ${p}`)
  for (const r of applyState.results.filter((r) => r.kind === 'remove-worktree')) {
    lines.push(
      r.status === 'done'
        ? `- ${r.target}: removed`
        : `- ${r.target}: ${r.status} (${describeReason(r.reason)})${r.detail ? `: ${r.detail}` : ''}`,
    )
  }
  return lines
}

// §12 "Warnings": preflight's, verify's and apply's own warnings (R36), plus three the report adds itself from
// context those phases don't carry a dedicated warning for: a downgraded repo (R6, so a reader
// isn't left wondering why nothing was pushed), an unverified run (no checks discovered at all,
// distinct from a red one), and R17's open-PR blind spot when GitHub's own `gh` was unavailable —
// every merged bucket this run trusted was proven by git alone, never by an open-PR check.
function warningLines(preflightState, verifyState, surveyState, applyState) {
  const lines = [...(preflightState?.warnings ?? []), ...(verifyState?.warnings ?? []), ...(applyState?.warnings ?? [])]
  const downgraded = preflightState?.downgraded ?? surveyState?.downgraded ?? false
  if (downgraded) lines.push('downgraded: trunk not pushed, remote branches untouched')
  if (verifyState?.status === 'unverified') lines.push('unverified: no checks found')
  if (surveyState?.remoteKind === 'github' && surveyState?.gh === 'absent') {
    lines.push('gh absent: open-PR protection was off; merged branches were judged by git proofs only')
  }
  return lines
}

// Phase 8 itself. Every earlier phase's state is read through `at()`, which drops a phase's
// payload — even if the file is still sitting there from a stale previous run — the moment that
// phase or an earlier one stopped this run, so a stop always reads as "nothing later happened"
// regardless of what leftover JSON happens to be on disk (§3's per-run overwrite already prevents
// this in the normal case; `at()` is the belt to that braces). `SUBCOMMANDS` minus this phase
// itself is exactly the fixed order §4 defines.
function report(ctx) {
  const order = SUBCOMMANDS.filter((name) => name !== 'report')
  // R28: a state file this run can't parse is caught right here, per file, and downgraded to "never ran" plus a named warning — the one place in
  // the engine allowed to treat `bad-state` as recoverable, since surviving a damaged run is this phase's entire purpose. Every other reader of
  // `readState` lets the same Stop propagate as its own subcommand's `ok:false`.
  const raw = {}
  const unreadable = []
  for (const name of order) {
    try {
      raw[name] = readState(ctx, name)
    } catch (err) {
      if (!(err instanceof Stop) || err.stop !== 'bad-state') throw err
      raw[name] = null
      unreadable.push(`${name}.json`)
    }
  }
  const stoppedAt = order.find((name) => raw[name]?.ok === false)
  const stoppedIndex = stoppedAt ? order.indexOf(stoppedAt) : order.length
  const at = (name) => {
    const state = order.indexOf(name) <= stoppedIndex ? raw[name] : null
    return state && state.ok !== false ? state : null
  }

  const preflightState = at('preflight')
  const syncState = at('sync')
  const surveyState = at('survey')
  const verifyState = at('verify')
  const pushTrunkState = at('push-trunk')
  const applyState = at('apply')
  const { deleted, kept } = buildDeletedAndKept(surveyState, applyState)
  const warnings = [
    ...warningLines(preflightState, verifyState, surveyState, applyState),
    ...unreadable.map((file) => `state file ${file} unreadable`),
  ]

  const sections = [
    ['Committed', commitsSince(ctx, preflightState)],
    ['Trunk', trunkLines(syncState, verifyState, pushTrunkState)],
    ['Deleted', deleted],
    ['Kept', kept],
    ['Pushed branches', pushedBranchLines(applyState)],
    ['Stashes', stashLines(applyState)],
    ['Worktrees', worktreeLines(applyState)],
    ['Warnings', warnings],
  ]

  const body = ['# git-sync report', '']
  if (stoppedAt) {
    const { stop, detail } = raw[stoppedAt]
    const detailSuffix = detail && Object.keys(detail).length > 0 ? ` — ${JSON.stringify(detail)}` : ''
    body.push(`Stopped at ${stoppedAt}: ${stop}${detailSuffix}`, '')
  }
  for (const [heading, lines] of sections) {
    if (lines.length === 0) continue
    body.push(`## ${heading}`, ...lines, '')
  }
  const markdown = body.join('\n').replace(/\n+$/, '\n')

  const reportPath = path.join(ctx.stateDir, 'last-report.md')
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.writeFileSync(reportPath, markdown)
  return { path: reportPath, markdown }
}

// Prints the one JSON envelope every subcommand owes stdout, mirrors it into state (the §3
// contract) when there's a repo to hold it, and returns the exit code main() should use.
// R32: a `linked-worktree` refusal is not mirrored. That state dir belongs to the main tree too, and a run from the wrong tree must not overwrite
// the main tree's in-flight `<cmd>.json` (its report would then open with this refusal) or create the dir where none existed.
function emit(ctx, envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
  if (ctx && envelope.stop !== 'linked-worktree') writeState(ctx, envelope.cmd, envelope)
  return envelope.ok ? 0 : 2
}

// `--cwd <dir>` is the only global flag and may appear on either side of the subcommand. `--answers <file>` is `plan`'s own and `--plan <file>`
// `apply`'s, each resolved against the caller's cwd like any path typed on a command line; missing its value either is a bad argument
// (`undefined`), not an empty plan.
function parseArgv(argv) {
  let cwd = process.cwd()
  let cmd = null
  const files = { answers: null, plan: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') {
      // Final review Minor 8: a missing directory is a bad argument (`undefined`), as for `--answers`/`--plan`, never a crash in `context()`.
      const dir = argv[i + 1]
      if (dir && !dir.startsWith('--')) i++
      cwd = dir && !dir.startsWith('--') ? dir : undefined
    } else if (argv[i] === '--answers' || argv[i] === '--plan') {
      // A following flag is not a file name: `plan --answers --cwd x` must not read `--cwd` as the answers and lose the cwd.
      const file = argv[i + 1]
      const key = argv[i].slice(2)
      if (file && !file.startsWith('--')) i++
      files[key] = file && !file.startsWith('--') ? path.resolve(file) : undefined
    } else if (cmd === null) {
      cmd = argv[i]
    }
  }
  return { cmd, cwd, ...files }
}

export function main(argv) {
  const { cmd, cwd, answers, plan: planFile } = parseArgv(argv)
  if (!SUBCOMMANDS.includes(cmd)) {
    process.stderr.write(`${USAGE}unknown command: ${cmd}\n`)
    return 1
  }
  if (cwd === undefined) {
    process.stderr.write(`${USAGE}--cwd <dir> needs a directory\n`)
    return 1
  }
  if (answers !== null && (cmd !== 'plan' || answers === undefined)) {
    process.stderr.write(`${USAGE}--answers <file> belongs to plan and needs a file\n`)
    return 1
  }
  if (planFile !== null && (cmd !== 'apply' || planFile === undefined)) {
    process.stderr.write(`${USAGE}--plan <file> belongs to apply and needs a file\n`)
    return 1
  }

  // R3: context resolves before dispatch, so a non-repo is `not-a-repo` whatever the subcommand —
  // the caller learns their cwd is wrong before anything about their subcommand.
  let ctx
  try {
    ctx = context(cwd)
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    return emit(null, { ok: false, cmd, stop: err.stop, detail: err.detail })
  }

  // Each phase's own Stop (a refusal, not a bug) is caught here and turned into the same ok:false
  // envelope the not-a-repo case above uses — the one place main() decides exit code 2 vs a thrown
  // error propagating out as a crash.
  try {
    if (cmd === 'preflight') return emit(ctx, { ok: true, cmd, ...preflight(ctx) })
    if (cmd === 'stage-scan') return emit(ctx, { ok: true, cmd, ...stageScan(ctx) })
    if (cmd === 'sync') return emit(ctx, { ok: true, cmd, ...sync(ctx) })
    if (cmd === 'survey') return emit(ctx, { ok: true, cmd, ...survey(ctx) })
    if (cmd === 'plan') return emit(ctx, { ok: true, cmd, ...plan(ctx, answers) })
    if (cmd === 'verify') return emit(ctx, { ok: true, cmd, ...verify(ctx) })
    if (cmd === 'push-trunk') return emit(ctx, { ok: true, cmd, ...pushTrunk(ctx) })
    if (cmd === 'apply') return emit(ctx, { ok: true, cmd, ...apply(ctx, planFile) })
    // `report` is the last of SUBCOMMANDS, which `cmd` was checked against above, so nothing falls through.
    return emit(ctx, { ok: true, cmd, ...report(ctx) })
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    return emit(ctx, { ok: false, cmd, stop: err.stop, detail: err.detail })
  }
}

// Compares realpaths, not raw strings, so this still resolves correctly when the CLI is reached
// through a symlink — a plugin installed from a local checkout, or a hand-made link into
// ~/.claude/skills. `import.meta.url` always resolves to the module's real, resolved path; `process.argv[1]`
// stays whatever path the caller typed, so it has to be resolved the same way before comparing —
// otherwise the guard is false, `main()` never runs, and the CLI is a silent no-op that exits 0.
// Wrapped in try/catch since `argv[1]` can be absent or point at a path that no longer exists.
function isDirectRun() {
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
}

// Unindented on purpose: T1.1 pins the literal line `process.exitCode = main(` as the file's
// last non-empty line, so the entry point stays trivially greppable even while it stays
// conditional on the guard that lets tests `import` this module without also running the CLI.
if (isDirectRun())
process.exitCode = main(process.argv.slice(2))
