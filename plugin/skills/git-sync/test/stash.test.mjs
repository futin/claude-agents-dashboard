// Tests for `apply`'s stash actions (design.md §10.5): a stash is addressed by its SHA, resolved to a live `stash@{n}` only at the moment of each
// action, and either turned into a `stash/<base>-<yyyymmdd>` branch — built in a temporary detached worktree, so `a`'s own tree and HEAD are never
// touched — or dropped. A stash that cannot be branched cleanly is kept, and no temporary worktree ever outlives the action.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { world } from './world.mjs'
import { stashIndexOf } from '../tools/git-sync.mjs'

// Writes each `[file, content]` into a's tree and stashes the lot (`-u` when asked, so untracked files ride along); returns the new stash's SHA.
function stash(w, files, flags = []) {
  for (const [file, content] of files) fs.writeFileSync(path.join(w.a, file), content)
  w.git(w.a, 'stash', 'push', ...flags)
  return w.git(w.a, 'rev-parse', 'stash@{0}')
}

// The stash's own date as the branch name spells it, read through a world-env child (R27: TZ=UTC there, as in the engine's), never from the
// runner's own zone.
const ymd = (w, sha) => w.git(w.a, 'log', '-1', '--date=format-local:%Y%m%d', '--format=%cd', sha)

const stashList = (w) => w.git(w.a, 'stash', 'list', '--format=%H').split('\n').filter(Boolean)
const stashBranches = (w) => w.git(w.a, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/stash/').split('\n').filter(Boolean)
const worktreeCount = (w) => w.git(w.a, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length
const show = (w, rev) => w.git(w.a, 'show', rev)
// The engine's scratch directory (the world's TMPDIR): a stash branch's temporary worktree must leave nothing there.
const tmpLeft = (w) => fs.readdirSync(w.env.TMPDIR)
const entryAt = (w, rev, file) => w.git(w.a, 'ls-tree', rev, '--', file)

function applied(w, actions) {
  const file = path.join(w.root, 'hand plan.json')
  fs.writeFileSync(file, JSON.stringify({ actions }))
  const result = w.cli(w.a, ['apply', '--plan', file])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.json.ok, true)
  return result.json
}

// The real phase order for a plan the survey itself would produce: survey → plan (from `answers`) → apply from plan.json.
function appliedFromAnswers(w, answers) {
  assert.equal(w.cli(w.a, ['survey']).status, 0)
  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, JSON.stringify(answers))
  const planned = w.cli(w.a, ['plan', '--answers', file])
  assert.equal(planned.status, 0, planned.stdout + planned.stderr)
  const result = w.cli(w.a, ['apply'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

const branchAction = (sha, baseSha, push = false) => ({ kind: 'stash-branch', target: sha, expectTip: sha, push, baseSha })
const dropAction = (sha) => ({ kind: 'stash-drop', target: sha, expectTip: sha })
const outcomes = (json) => json.results.map((r) => [r.kind, r.status, r.reason])

test('T12.1 a -u stash becomes stash/main-<date>: base plus one commit with all three changes, built off to the side', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'f1.txt', content: 'one\n', msg: 'f1' })
  const base = w.commit(w.a, { file: 'f2.txt', content: 'two\n', msg: 'f2' })
  const sha = stash(w, [['f1.txt', 'one stashed\n'], ['f2.txt', 'two stashed\n'], ['new.txt', 'untracked\n']], ['-u'])
  const name = `stash/main-${ymd(w, sha)}`

  const json = appliedFromAnswers(w, { stashes: { [sha]: 'branch-local' } })
  assert.deepEqual(json.results, [{ kind: 'stash-branch', target: sha, status: 'done', reason: name }])

  assert.deepEqual(stashBranches(w), [name])
  assert.equal(w.git(w.a, 'rev-parse', `${name}^`), base)
  assert.equal(w.git(w.a, 'rev-list', '--count', `${base}..${name}`), '1')
  assert.equal(w.git(w.a, 'diff', '--name-status', base, name), 'M\tf1.txt\nM\tf2.txt\nA\tnew.txt')
  assert.equal(show(w, `${name}:f1.txt`), 'one stashed')
  assert.equal(show(w, `${name}:f2.txt`), 'two stashed')
  assert.equal(show(w, `${name}:new.txt`), 'untracked')
  assert.equal(w.git(w.a, 'log', '-1', '--format=%s', name), `chore: branch stash ${sha.slice(0, 7)} from main`)

  assert.deepEqual(stashList(w), [])
  assert.equal(w.git(w.a, 'status', '--porcelain'), '')
  assert.equal(w.git(w.a, 'rev-parse', 'HEAD'), base)
  assert.equal(w.git(w.a, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

// Branching the newest stash first drops stash@{0}, which renumbers the middle one from @{1} to @{0} and the oldest from @{2} to @{1}: a
// remembered index for the middle one would now drop the *oldest*. Resolving by SHA at the moment of each drop takes exactly the two planned.
test('T12.2 indexes shift between actions; each stash is found by SHA when its action runs', (t) => {
  const w = world(t)
  const oldest = stash(w, [['.gitignore', 'node_modules/\noldest\n']])
  const middle = stash(w, [['.gitignore', 'node_modules/\nmiddle\n']])
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  const newest = stash(w, [['.gitignore', 'node_modules/\nnewest\n']])
  const name = `stash/main-${ymd(w, newest)}`

  const json = applied(w, [branchAction(newest, base), dropAction(middle)])
  assert.deepEqual(outcomes(json), [
    ['stash-branch', 'done', name],
    ['stash-drop', 'done', null],
  ])
  assert.equal(show(w, `${name}:.gitignore`), 'node_modules/\nnewest')
  assert.deepEqual(stashList(w), [oldest])
})

test('T12.3 a taken name gets -2, then -3', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  const first = stash(w, [['.gitignore', 'first\n']])
  const date = ymd(w, first)
  w.git(w.a, 'branch', `stash/main-${date}`)

  let json = applied(w, [branchAction(first, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'done', `stash/main-${date}-2`]])

  const second = stash(w, [['.gitignore', 'second\n']])
  json = applied(w, [branchAction(second, base)])
  // Two stashes a moment apart share a date, bar a midnight falling between them.
  const date2 = ymd(w, second)
  assert.equal(json.results[0].reason, date2 === date ? `stash/main-${date}-3` : `stash/main-${date2}`)
  assert.equal(show(w, `stash/main-${date}-2:.gitignore`), 'first')
})

test('T12.4 push: true publishes the branch with an upstream; a downgraded repo keeps it local', async (t) => {
  await t.test('github', (t) => {
    const w = world(t)
    const sha = stash(w, [['.gitignore', 'pushed\n']])
    const name = `stash/main-${ymd(w, sha)}`
    const json = appliedFromAnswers(w, { stashes: { [sha]: 'branch-push' } })
    assert.deepEqual(json.results, [{ kind: 'stash-branch', target: sha, status: 'done', reason: name, push: 'done' }])
    assert.equal(w.git(w.origin, 'rev-parse', `refs/heads/${name}`), w.git(w.a, 'rev-parse', name))
    assert.equal(w.git(w.a, 'rev-parse', '--abbrev-ref', `${name}@{upstream}`), `origin/${name}`)
  })

  await t.test('gitlab, hand-written push: true', (t) => {
    const w = world(t, { host: 'gitlab.com' })
    const base = w.git(w.a, 'rev-parse', 'HEAD')
    const sha = stash(w, [['.gitignore', 'kept local\n']])
    const name = `stash/main-${ymd(w, sha)}`
    const before = w.git(w.origin, 'for-each-ref')
    const json = applied(w, [branchAction(sha, base, true)])
    assert.equal(json.results.length, 1)
    const [r] = json.results
    assert.deepEqual([r.status, r.reason, r.push], ['done', name, 'downgraded'])
    assert.deepEqual(stashBranches(w), [name])
    assert.equal(w.git(w.origin, 'for-each-ref'), before)
    assert.deepEqual(stashList(w), [])
  })

  await t.test('rejected push: the branch is still done, the push part reports it', (t) => {
    const w = world(t)
    const base = w.git(w.a, 'rev-parse', 'HEAD')
    const sha = stash(w, [['.gitignore', 'mine\n']])
    const name = `stash/main-${ymd(w, sha)}`
    // Origin gains the name without a's tracking ref knowing (b pushed it), so the name looks free here and the push is refused, never forced.
    w.git(w.b, 'checkout', '-b', name)
    w.commit(w.b, { file: 'theirs.txt', content: 'theirs\n', msg: 'theirs' })
    w.git(w.b, 'push', 'origin', name)
    const theirs = w.git(w.origin, 'rev-parse', `refs/heads/${name}`)
    const json = applied(w, [branchAction(sha, base, true)])
    const [r] = json.results
    assert.deepEqual([r.status, r.reason, r.push], ['done', name, 'rejected'])
    assert.match(r.detail, /rejected|fetch first|non-fast-forward/)
    assert.equal(w.git(w.origin, 'rev-parse', `refs/heads/${name}`), theirs)
    assert.deepEqual(stashList(w), [])
  })
})

test('T12.5 a stash that conflicts with the plan baseSha is kept, with no branch and no temp worktree left', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'f.txt', content: 'one\n', msg: 'f' })
  const sha = stash(w, [['f.txt', 'stashed\n']])
  const other = w.commit(w.a, { file: 'f.txt', content: 'other\n', msg: 'moves f' })

  const json = applied(w, [branchAction(sha, other)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'stash-conflict']])
  assert.equal(typeof json.results[0].detail, 'string')
  assert.deepEqual(stashList(w), [sha])
  assert.deepEqual(stashBranches(w), [])
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
  assert.equal(w.git(w.a, 'rev-parse', 'HEAD'), other)
  assert.equal(w.git(w.a, 'status', '--porcelain'), '')
})

test('T12.6 an unknown SHA is stash-gone for both actions', (t) => {
  const w = world(t)
  const kept = stash(w, [['.gitignore', 'kept\n']])
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  const unknown = 'e'.repeat(40)
  const json = applied(w, [dropAction(unknown), branchAction(unknown, base)])
  assert.deepEqual(outcomes(json), [
    ['stash-drop', 'skipped', 'stash-gone'],
    ['stash-branch', 'skipped', 'stash-gone'],
  ])
  assert.deepEqual(stashList(w), [kept])
})

test('T12.7 (Review Focus 3) a stash on feat/x becomes stash/feat/x-<date>', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat/x')
  const base = w.commit(w.a, { file: 'x.txt', content: 'x\n', msg: 'x' })
  const sha = stash(w, [['x.txt', 'x stashed\n']])
  w.git(w.a, 'checkout', 'main')

  const json = applied(w, [branchAction(sha, base)])
  const name = `stash/feat/x-${ymd(w, sha)}`
  assert.deepEqual(outcomes(json), [['stash-branch', 'done', name]])
  assert.equal(w.git(w.a, 'log', '-1', '--format=%s', name), `chore: branch stash ${sha.slice(0, 7)} from feat/x`)
  assert.equal(w.git(w.a, 'rev-parse', `${name}^`), base)
})

test('T12.8 a detached stash is stash/detached-<date>', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '--detach')
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  const sha = stash(w, [['.gitignore', 'detached\n']])
  w.git(w.a, 'checkout', 'main')
  const json = applied(w, [branchAction(sha, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'done', `stash/detached-${ymd(w, sha)}`]])
})

// A branch literally named `stash` makes every `stash/…` ref impossible (a ref cannot be both a file and a directory), and no suffix fixes that:
// skipped with the blocking name in `detail`, the stash kept, nothing built.
test('T12.9 a directory/file ref conflict skips with name-conflict and keeps the stash', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'branch', 'stash')
  const sha = stash(w, [['.gitignore', 'blocked\n']])
  const json = applied(w, [branchAction(sha, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'name-conflict']])
  assert.match(json.results[0].detail, /\bstash\b/)
  assert.deepEqual(stashList(w), [sha])
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

test('T12.9b a stash on feat/x is blocked by an existing stash/feat branch', (t) => {
  const w = world(t)
  w.git(w.a, 'branch', 'stash/feat')
  w.git(w.a, 'checkout', '-b', 'feat/x')
  const base = w.commit(w.a, { file: 'x.txt', content: 'x\n', msg: 'x' })
  const sha = stash(w, [['x.txt', 'x stashed\n']])
  w.git(w.a, 'checkout', 'main')
  const json = applied(w, [branchAction(sha, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'name-conflict']])
  assert.match(json.results[0].detail, /stash\/feat\b/)
  assert.deepEqual(stashBranches(w), ['stash/feat'])
  assert.deepEqual(stashList(w), [sha])
})

// Origin's names count as taken only for a branch about to be pushed; a local-only one need not dodge them.
test('T12.9c origin names block a pushed stash branch only', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.b, 'checkout', '-b', 'stash')
  w.git(w.b, 'push', 'origin', 'stash')
  w.git(w.a, 'fetch', 'origin')
  const first = stash(w, [['.gitignore', 'local only\n']])
  let json = applied(w, [branchAction(first, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'done', `stash/main-${ymd(w, first)}`]])
  const second = stash(w, [['.gitignore', 'pushed\n']])
  json = applied(w, [branchAction(second, base, true)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'name-conflict']])
  assert.deepEqual(stashList(w), [second])
})

// `stash -a` also holds ignored files, which `add -A` would silently leave out of the commit — so dropping the stash afterwards would lose them.
// Anything the commit did not capture keeps the stash.
test('T12.10 a stash whose ignored files the branch would not hold is kept', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  fs.mkdirSync(path.join(w.a, 'node_modules'))
  const sha = stash(w, [['node_modules/dep.js', 'dep\n'], ['.gitignore', 'node_modules/\nchanged\n']], ['-a'])
  const json = applied(w, [branchAction(sha, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'stash-conflict']])
  assert.match(json.results[0].detail, /^a branch commit would not hold the stash exactly: /, 'R26: stashNotHeld refused the drop')
  assert.match(json.results[0].detail, /node_modules/)
  assert.deepEqual(stashList(w), [sha])
  assert.deepEqual(stashBranches(w), [])
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

// Final review Minor 6: a commit that fails for a reason of its own (no identity here, or a signing failure) is git failing, not the stash
// conflicting, so it is `failed`/`git-failed`, with the stash still kept and the detail saying so.
test('T12.11 no commit identity is failed/git-failed with detail, the stash kept, never a crash', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  const sha = stash(w, [['.gitignore', 'anonymous\n']])
  // A global config with no user and `useConfigOnly`, so git cannot fall back to a guessed identity from the host.
  const bare = path.join(w.root, 'no identity gitconfig')
  fs.writeFileSync(bare, '[user]\n\tuseConfigOnly = true\n')
  const file = path.join(w.root, 'hand plan.json')
  fs.writeFileSync(file, JSON.stringify({ actions: [branchAction(sha, base)] }))
  const result = w.cli(w.a, ['apply', '--plan', file], { GIT_CONFIG_GLOBAL: bare })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(outcomes(result.json), [['stash-branch', 'failed', 'git-failed']])
  assert.match(result.json.results[0].detail, /^stash kept: /)
  assert.match(result.json.results[0].detail, /identity|who you are|user\.(name|email)/i)
  assert.deepEqual(stashList(w), [sha])
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

test('T12.12 a stash action whose target is not a full stash SHA is a bad plan', (t) => {
  const w = world(t)
  const sha = stash(w, [['.gitignore', 'x\n']])
  const file = path.join(w.root, 'hand plan.json')
  for (const action of [
    { kind: 'stash-drop', target: 'stash@{0}', expectTip: sha },
    { kind: 'stash-drop', target: sha.slice(0, 7), expectTip: sha },
    { kind: 'stash-branch', target: sha, expectTip: sha, baseSha: 'main' },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ actions: [action] }))
    const result = w.cli(w.a, ['apply', '--plan', file])
    assert.equal(result.status, 2, JSON.stringify(action))
    assert.equal(result.json.stop, 'bad-plan')
  }
  assert.deepEqual(stashList(w), [sha])
})

// R26 / review I1: a stash is dropped only once the branch commit provably holds it. `core.fileMode=false` (common on WSL's /mnt/c checkouts) is
// read from the shared repo config, so without the temp tree's own `core.fileMode=true` the staged chmod would be committed as 100644.
test('T12.13 a staged chmod under core.fileMode=false reaches the branch as 100755', (t) => {
  const w = world(t)
  w.git(w.a, 'config', 'core.fileMode', 'false')
  const base = w.commit(w.a, { file: 'run.sh', content: 'echo one\n', msg: 'script' })
  fs.writeFileSync(path.join(w.a, 'run.sh'), 'echo two\n')
  w.git(w.a, 'add', 'run.sh')
  w.git(w.a, 'update-index', '--chmod=+x', 'run.sh')
  w.git(w.a, 'stash', 'push')
  const sha = w.git(w.a, 'rev-parse', 'stash@{0}')
  assert.match(entryAt(w, sha, 'run.sh'), /^100755 /)

  const json = applied(w, [branchAction(sha, base)])
  const name = `stash/main-${ymd(w, sha)}`
  assert.deepEqual(outcomes(json), [['stash-branch', 'done', name]])
  assert.equal(entryAt(w, name, 'run.sh'), entryAt(w, sha, 'run.sh'))
  assert.deepEqual(stashList(w), [])
})

// The index holds a version of `f.txt` that is neither the base's nor the worktree's; one commit cannot carry both, so the stash stays whole.
test('T12.14 a partially staged stash is unrepresentable: kept, no branch', (t) => {
  const w = world(t)
  const base = w.commit(w.a, { file: 'f.txt', content: 'one\n', msg: 'f' })
  fs.writeFileSync(path.join(w.a, 'f.txt'), 'staged\n')
  w.git(w.a, 'add', 'f.txt')
  const sha = stash(w, [['f.txt', 'worktree\n']])

  const json = applied(w, [branchAction(sha, base)])
  assert.deepEqual(outcomes(json), [['stash-branch', 'skipped', 'stash-conflict']])
  assert.match(json.results[0].detail, /^a branch commit would not hold the stash exactly: .*f\.txt \(partially staged\)/, 'R26: stashNotHeld refused')
  assert.deepEqual(stashList(w), [sha])
  assert.deepEqual(stashBranches(w), [])
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

// The temp worktree never populates a submodule, so the gitlink bump cannot be re-staged there. Either outcome is safe — the branch holding the
// new pointer, or the stash kept — but never `done` with the old pointer and the stash gone.
test('T12.15 a staged submodule bump is never dropped onto the old pointer', (t) => {
  const w = world(t)
  // Built with plumbing, not `git submodule` (a shell script needing sed/basename, which the sandboxed PATH rightly lacks). A gitlink need not
  // point into a real submodule for this: the temp worktree never populates one anyway, which is exactly the hazard.
  const old = w.git(w.a, 'rev-parse', 'HEAD')
  const newer = w.commit(w.a, { file: 'other.txt', content: 'other\n', msg: 'a second commit to point at' })
  fs.writeFileSync(path.join(w.a, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n')
  w.git(w.a, 'add', '.gitmodules')
  w.git(w.a, 'update-index', '--add', '--cacheinfo', `160000,${old},sub`)
  fs.mkdirSync(path.join(w.a, 'sub')) // what an unpopulated submodule looks like; without it git sees the gitlink as deleted
  w.git(w.a, 'commit', '-q', '-m', 'add sub')
  const base = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'update-index', '--cacheinfo', `160000,${newer},sub`)
  const sha = stash(w, [['.gitignore', 'node_modules/\nwith bump\n']])
  assert.match(entryAt(w, sha, 'sub'), new RegExp(`^160000 commit ${newer}\t`))

  const json = applied(w, [branchAction(sha, base)])
  const [r] = json.results
  if (r.status === 'done') {
    assert.match(entryAt(w, r.reason, 'sub'), new RegExp(`^160000 commit ${newer}\t`))
  } else {
    assert.deepEqual([r.status, r.reason], ['skipped', 'stash-conflict'])
    assert.match(r.detail, /\bsub\b/)
    assert.deepEqual(stashList(w), [sha])
    assert.deepEqual(stashBranches(w), [])
  }
  assert.equal(worktreeCount(w), 1)
  assert.deepEqual(tmpLeft(w), [])
})

test('T12.16 stashIndexOf is the live position of a SHA, or null', (t) => {
  const w = world(t)
  const ctx = w.ctx(w.a)
  assert.equal(stashIndexOf(ctx, 'e'.repeat(40)), null)
  const older = stash(w, [['.gitignore', 'older\n']])
  const newer = stash(w, [['.gitignore', 'newer\n']])
  assert.equal(stashIndexOf(ctx, newer), 0)
  assert.equal(stashIndexOf(ctx, older), 1)
  w.git(w.a, 'stash', 'drop', 'stash@{0}')
  assert.equal(stashIndexOf(ctx, older), 0)
  assert.equal(stashIndexOf(ctx, newer), null)
})
