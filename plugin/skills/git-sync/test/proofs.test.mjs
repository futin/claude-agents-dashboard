// Tests for the merge proofs (design.md §5, M1–M3) that survey and apply lean on to call a branch safe to delete: each case builds `feat` in
// clone `a`, integrates it into `main` by one named method, pushes `main`, fetches, and asks `mergeProof` about `feat`'s tip against `origin/main`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { git, mergeProof, netDiffContained } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

const REF = 'origin/main'

// `count` commits on a fresh `feat` branched off `a`'s current `main`, one new file each, then back to `main` so the integration step starts there.
// `prefix` keeps file names distinct when a test grows the same branch twice.
function buildFeat(w, count, prefix = 'feat') {
  w.git(w.a, 'checkout', '-b', 'feat')
  for (let i = 1; i <= count; i++) {
    w.commit(w.a, { file: `${prefix}-${i}.txt`, content: `${prefix} ${i}\n`, msg: `${prefix} commit ${i}` })
  }
  const tip = w.git(w.a, 'rev-parse', 'feat')
  w.git(w.a, 'checkout', 'main')
  return tip
}

function pushAndFetch(w) {
  w.git(w.a, 'push', 'origin', 'main')
  w.git(w.a, 'fetch', 'origin')
}

// The squash scenario T5.4, T5.7–T5.9 and T5.11 share: a three-commit `feat` folded into one commit on `main`. `beforeSquash` runs on `main` after `feat`
// is built and before the squash lands — T5.8 uses it to move `main` on between the merge-base and the squash.
function squashWorld(t, { beforeSquash } = {}) {
  const w = world(t)
  const tip = buildFeat(w, 3)
  beforeSquash?.(w)
  w.git(w.a, 'merge', '--squash', 'feat')
  w.git(w.a, 'commit', '-m', 'squash feat')
  pushAndFetch(w)
  return { w, tip }
}

test('T5.1 a fast-forward merge proves M1', (t) => {
  const w = world(t)
  const tip = buildFeat(w, 2)
  w.git(w.a, 'merge', '--ff-only', 'feat')
  pushAndFetch(w)
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M1')
})

test('T5.2 a --no-ff merge proves M1', (t) => {
  const w = world(t)
  const tip = buildFeat(w, 2)
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge feat', 'feat')
  pushAndFetch(w)
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M1')
})

test('T5.3 a rebase-merge (commits cherry-picked onto main, new SHAs) proves M2', (t) => {
  const w = world(t)
  const tip = buildFeat(w, 2)
  // An unrelated commit on main first, so the picks land on a different parent and are guaranteed new SHAs rather than a same-second replay.
  w.commit(w.a, { file: 'other.txt', content: 'other\n', msg: 'unrelated main work' })
  w.git(w.a, 'cherry-pick', 'feat~1', 'feat')
  pushAndFetch(w)

  assert.equal(w.git(w.a, 'rev-parse', 'feat'), tip, 'feat itself is untouched')
  // Exit 1 is git's "not an ancestor" — the property that makes this an M2 case rather than an M1 case in disguise.
  assert.equal(git(w.a, ['merge-base', '--is-ancestor', tip, REF], { env: w.env }).status, 1, 'the picked commits carry new SHAs')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M2')
})

test('T5.4 a squash merge of a three-commit branch proves M3', (t) => {
  const { w, tip } = squashWorld(t)
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M3')
})

test('T5.5 a squash merge followed by one more commit on the branch proves nothing', (t) => {
  const { w } = squashWorld(t)
  w.git(w.a, 'checkout', 'feat')
  const tip = w.commit(w.a, { file: 'late.txt', content: 'late\n', msg: 'after the squash' })
  w.git(w.a, 'checkout', 'main')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

test('T5.6 a never-integrated branch proves nothing; a branch sitting on the merge-base proves M1', (t) => {
  const w = world(t)
  const base = w.git(w.a, 'rev-parse', 'main')
  w.git(w.a, 'branch', 'empty', base)
  const tip = buildFeat(w, 2)
  w.commit(w.a, { file: 'other.txt', content: 'other\n', msg: 'unrelated main work' })
  pushAndFetch(w)

  const ctx = w.ctx(w.a)
  assert.equal(mergeProof(ctx, tip, REF), null)
  assert.equal(mergeProof(ctx, w.git(w.a, 'rev-parse', 'empty'), REF), 'M1')
})

test('T5.7 commit.gpgsign with a broken gpg.program leaves M3 intact and creates no ref', (t) => {
  const { w, tip } = squashWorld(t)
  // git's commit-tree stopped reading commit.gpgSign long ago (confirmed on 2.50), so the signing half of this cannot go red on a current git; it
  // still pins that the probe creates no ref and that M3 survives the config on any git that does sign.
  // Appended only after the fixture's own commits, which would otherwise hit the broken signer themselves.
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n')

  const refsBefore = w.git(w.a, 'for-each-ref')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M3')
  assert.equal(w.git(w.a, 'for-each-ref'), refsBefore)
})

test('T5.8 main gaining an unrelated commit between the merge-base and the squash still proves M3', (t) => {
  const { w, tip } = squashWorld(t, {
    beforeSquash: (w) => w.commit(w.a, { file: 'other.txt', content: 'other\n', msg: 'unrelated main work' }),
  })
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M3')
})

test('T5.9 hostile diff and display config changes no proof', (t) => {
  const { w, tip: squashedTip } = squashWorld(t)
  w.git(w.a, 'checkout', 'feat')
  const lateTip = w.commit(w.a, { file: 'late.txt', content: 'late\n', msg: 'after the squash' })
  w.git(w.a, 'checkout', 'main')

  fs.appendFileSync(
    w.env.GIT_CONFIG_GLOBAL,
    '[diff]\n\texternal = /nonexistent/difftool\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tcontext = 0\n\talgorithm = histogram\n' +
      '\trenames = copies\n[color]\n\tui = always\n[core]\n\tquotePath = true\n',
  )

  const ctx = w.ctx(w.a)
  assert.equal(mergeProof(ctx, squashedTip, REF), 'M3')
  assert.equal(mergeProof(ctx, lateTip, REF), null)
})

test('T5.10 a squash onto a trunk that changed the lines around the hunk misses M3 (the safe direction), whatever diff.context says', (t) => {
  const w = world(t)
  const lines = (edit) => Array.from({ length: 20 }, (_, i) => edit(i + 1) ?? String(i + 1)).join('\n') + '\n'
  w.commit(w.a, { file: 'shared.txt', content: lines(() => null), msg: 'shared file' })
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat')
  w.commit(w.a, { file: 'shared.txt', content: lines((n) => (n === 9 ? 'nine' : null)), msg: 'feat edits line 9' })
  const tip = w.commit(w.a, { file: 'feat-new.txt', content: 'new\n', msg: 'feat adds a file' })
  w.git(w.a, 'checkout', 'main')
  // Line 6 sits inside line 9's three-line context window but far enough away that the squash below still merges cleanly.
  w.commit(w.a, { file: 'shared.txt', content: lines((n) => (n === 6 ? 'six' : null)), msg: 'main edits line 6' })
  w.git(w.a, 'merge', '--squash', 'feat')
  w.git(w.a, 'commit', '-m', 'squash feat')
  pushAndFetch(w)

  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
  // A zero-context diff would make the two patches identical; patch ids must not follow the user's diff.context.
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[diff]\n\tcontext = 0\n')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

test('T5.11 a machine with no configured identity still proves M3', (t) => {
  const { w, tip } = squashWorld(t)
  // Strip the fixture's identity and forbid git from guessing one, so a commit-tree relying on the user's own name would fail outright.
  const config = fs.readFileSync(w.env.GIT_CONFIG_GLOBAL, 'utf8').replace(/\[user\]\n(\t.*\n)+/, '')
  fs.writeFileSync(w.env.GIT_CONFIG_GLOBAL, `${config}[user]\n\tuseConfigOnly = true\n`)
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), 'M3')
})

test('T5.12 a branch whose only commit outside the trunk is a merge carrying its own content is not proven by cherry', (t) => {
  const w = world(t)
  // p and q each land on main by --no-ff merge; feat then merges the same two tips itself, adding a file inside that merge commit. The trunk holds
  // both parents but never the merge, and `git cherry` skips merges, so its list for feat comes back empty rather than a `+`.
  w.git(w.a, 'checkout', '-b', 'p')
  const p = w.commit(w.a, { file: 'p.txt', content: 'p\n', msg: 'p' })
  w.git(w.a, 'checkout', '-b', 'q', 'main')
  w.commit(w.a, { file: 'q.txt', content: 'q\n', msg: 'q' })
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge p', 'p')
  w.git(w.a, 'merge', '--no-ff', '-m', 'merge q', 'q')
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat', p)
  w.git(w.a, 'merge', '--no-ff', '--no-commit', 'q')
  fs.writeFileSync(`${w.a}/only-in-the-merge.txt`, 'resolution\n')
  w.git(w.a, 'add', 'only-in-the-merge.txt')
  w.git(w.a, 'commit', '-m', 'merge q into feat, plus content')
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'checkout', 'main')

  assert.equal(w.git(w.a, 'cherry', REF, tip), '', 'precondition: cherry has nothing to say about a merge-only range')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

test('T5.13 a branch whose commits cancel out proves nothing, even against a trunk holding an empty commit', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat')
  w.commit(w.a, { file: 'tmp.txt', content: 'tmp\n', msg: 'add tmp' })
  w.git(w.a, 'rm', '-q', 'tmp.txt')
  w.git(w.a, 'commit', '-m', 'remove tmp')
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'commit', '--allow-empty', '-m', 'empty marker')
  pushAndFetch(w)
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

// Ruling R11: patch ids hash diffs with all whitespace stripped (and, before git 2.39, without file modes), so cherry can call two patches
// equivalent while the trees differ. Every M2/M3 answer must also pass a containment gate that is exact about both.

test('T5.14 a picked commit plus a merge carrying its own content is not proven by M2 (R11b)', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat')
  const a = w.commit(w.a, { file: 'a.txt', content: 'a\n', msg: 'A' })
  w.git(w.a, 'checkout', 'main')
  w.commit(w.a, { file: 'z.txt', content: 'z\n', msg: 'Z' })
  // The everyday "merge main into the branch, fix the build in the merge" pattern: evil.txt exists only in feat's merge commit.
  w.git(w.a, 'checkout', 'feat')
  w.git(w.a, 'merge', '--no-ff', '--no-commit', 'main')
  fs.writeFileSync(`${w.a}/evil.txt`, 'only in the merge\n')
  w.git(w.a, 'add', 'evil.txt')
  w.git(w.a, 'commit', '-m', 'merge main, plus a fix')
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'cherry-pick', a)
  pushAndFetch(w)

  assert.equal(w.git(w.a, 'cherry', REF, tip).split('\n').filter((l) => l.startsWith('+')).length, 0, 'precondition: cherry sees no + commit')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

// A Python function whose last line's indentation decides whether it runs inside the `if`. `indent` is that line's leading whitespace.
const pyFile = (indent) => `def f(x):\n    if x:\n        a()\n${indent}b()\n`

test('T5.15 a behaviour-changing whitespace edit, picked with different whitespace, is not proven by M2', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'f.py', content: pyFile('    '), msg: 'f.py' })
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat')
  const tip = w.commit(w.a, { file: 'f.py', content: pyFile('        '), msg: 'call b() only when x' })
  w.git(w.a, 'checkout', 'main')
  w.commit(w.a, { file: 'f.py', content: pyFile('\t'), msg: 'call b() only when x (as picked, reindented)' })
  pushAndFetch(w)

  assert.equal(w.git(w.a, 'cherry', REF, tip).slice(0, 1), '-', 'precondition: cherry calls the two patches equivalent')
  // A user's apply.ignoreWhitespace must not make the gate as whitespace-blind as cherry.
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[apply]\n\tignoreWhitespace = change\n')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

test('T5.16 a behaviour-changing whitespace edit, squashed with different whitespace, is not proven by M3', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'f.py', content: pyFile('    '), msg: 'f.py' })
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat')
  w.commit(w.a, { file: 'g.py', content: 'g = 1\n', msg: 'add g' })
  const tip = w.commit(w.a, { file: 'f.py', content: pyFile('        '), msg: 'call b() only when x' })
  w.git(w.a, 'checkout', 'main')
  // A hand-made "squash" of both commits that re-indents the moved line differently.
  fs.writeFileSync(`${w.a}/g.py`, 'g = 1\n')
  w.git(w.a, 'add', 'g.py')
  w.commit(w.a, { file: 'f.py', content: pyFile('\t'), msg: 'squash feat (reindented)' })
  pushAndFetch(w)

  assert.match(w.git(w.a, 'cherry', REF, tip), /^\+/m, 'precondition: no per-commit match, so M2 is out and M3 is the path under test')
  // A user's apply.ignoreWhitespace must not make the gate as whitespace-blind as cherry.
  fs.appendFileSync(w.env.GIT_CONFIG_GLOBAL, '[apply]\n\tignoreWhitespace = change\n')
  assert.equal(mergeProof(w.ctx(w.a), tip, REF), null)
})

test('T5.17 a branch that changed a file and its exec bit, where the trunk only got the content, proves nothing', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'run.sh', content: 'echo hi\n', msg: 'run.sh' })
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat')
  fs.writeFileSync(`${w.a}/run.sh`, 'echo hello\n')
  fs.chmodSync(`${w.a}/run.sh`, 0o755)
  w.git(w.a, 'add', 'run.sh')
  w.git(w.a, 'commit', '-m', 'say hello, make it executable')
  const tip = w.git(w.a, 'rev-parse', 'HEAD')
  w.git(w.a, 'checkout', 'main')
  w.commit(w.a, { file: 'run.sh', content: 'echo hello\n', msg: 'say hello' })
  pushAndFetch(w)

  const ctx = w.ctx(w.a)
  assert.equal(mergeProof(ctx, tip, REF), null)
  // The gate alone, since a git ≥ 2.39 cherry already sees the mode and would mask a gate that ignored it; a 2.34 cherry does not.
  const base = w.git(w.a, 'merge-base', REF, tip)
  assert.equal(netDiffContained(ctx, base, tip, REF), false)
})

test('T5.18 the gate accepts a contained change, leaves the real index and tree alone, and ignores hostile diff/apply config', (t) => {
  const w = world(t)
  // Trailing whitespace in the base line the branch rewrites: reverse-applying re-adds it, which `apply.whitespace=error-all` would reject.
  w.commit(w.a, { file: 'w.txt', content: 'x  \n', msg: 'w.txt with trailing spaces' })
  pushAndFetch(w)
  w.git(w.a, 'checkout', '-b', 'feat')
  w.commit(w.a, { file: 'w.txt', content: 'y\n', msg: 'rewrite w' })
  const tip = w.commit(w.a, { file: 'v.txt', content: 'v\n', msg: 'add v' })
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'merge', '--squash', 'feat')
  w.git(w.a, 'commit', '-m', 'squash feat')
  pushAndFetch(w)

  fs.appendFileSync(
    w.env.GIT_CONFIG_GLOBAL,
    '[diff]\n\tnoprefix = true\n\trelative = true\n\tcontext = 0\n\tignoreSubmodules = all\n\tsuppressBlankEmpty = true\n' +
      '[apply]\n\tignoreWhitespace = change\n\twhitespace = error-all\n',
  )
  const ctx = w.ctx(w.a)
  const indexBefore = fs.readFileSync(`${ctx.gitDir}/index`)
  const base = w.git(w.a, 'merge-base', REF, tip)

  assert.equal(netDiffContained(ctx, base, tip, REF), true)
  assert.equal(netDiffContained(ctx, base, base, REF), true, 'an empty net diff is trivially contained')
  assert.equal(mergeProof(ctx, tip, REF), 'M3')
  assert.deepEqual(fs.readFileSync(`${ctx.gitDir}/index`), indexBefore)
  assert.equal(w.git(w.a, 'status', '--porcelain'), '')
})
