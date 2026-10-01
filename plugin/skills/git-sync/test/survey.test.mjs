// Tests for the survey (design.md §5, §6): the read-only phase that pairs every local and `origin/` branch into one record, buckets it, and lists the
// linked worktrees and stashes the decision round asks about. Every world here is two clones of one bare origin — `a` is this machine, `b` the other
// one — so "the other box pushed" is a real push, and every proof is a real git history rather than a mock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { repo, branchRecords, listWorktrees, listStashes } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

// A new branch off `a`'s current `main` with one commit (backdated when `daysAgo` is given), optionally pushed with an upstream, then back to `main`
// so the next fixture step starts from the trunk. The file name carries the branch name so no two fixture branches ever touch the same path.
function branch(w, name, { daysAgo, push = false, dir = w.a } = {}) {
  w.git(dir, 'checkout', '-b', name)
  const tip = w.commit(dir, { file: `${name}.txt`, content: `${name}\n`, msg: `work on ${name}`, daysAgo })
  if (push) w.git(dir, 'push', '-u', 'origin', name)
  w.git(dir, 'checkout', 'main')
  return tip
}

function records(w, dir = w.a) {
  const byName = new Map()
  for (const rec of branchRecords(repo(dir, { env: w.env }))) byName.set(rec.name, rec)
  return byName
}

test('T7.1 buckets: merged, active, abandoned, gone-unproven, protected; the trunk and origin/HEAD never appear', (t) => {
  const w = world(t)
  const doneTip = branch(w, 'done-ff', { push: true })
  w.git(w.a, 'merge', '--ff-only', 'done-ff')
  branch(w, 'wip', { push: true, daysAgo: 1 })
  branch(w, 'old', { push: true, daysAgo: 31 })
  branch(w, 'young', { push: true, daysAgo: 29 })
  branch(w, 'gone', { push: true })
  const prTip = branch(w, 'open-pr', { push: true })
  w.git(w.b, 'push', 'origin', '--delete', 'gone')
  w.git(w.a, 'fetch', '--prune', 'origin')
  w.stub('gh', {
    stdout: '[]\n',
    byArgs: { '--head open-pr': { stdout: `${JSON.stringify([{ number: 9, state: 'OPEN', headRefOid: prTip }])}\n` } },
  })

  const recs = records(w)
  const done = recs.get('done-ff')
  assert.equal(done.bucket, 'merged')
  assert.equal(done.proof, 'M1')
  assert.equal(done.local.sha, doneTip)
  assert.equal(done.remote.sha, doneTip)
  assert.match(done.reason, /^merged: .*\(M1\)$/)
  assert.equal(done.unpushed, null)

  assert.equal(recs.get('wip').bucket, 'active')
  assert.equal(recs.get('wip').reason, 'recent')
  assert.equal(recs.get('old').bucket, 'abandoned')
  assert.equal(recs.get('old').reason, '31d without commits')
  assert.equal(recs.get('old').unpushed, null)
  assert.equal(recs.get('young').bucket, 'active')

  const gone = recs.get('gone')
  assert.equal(gone.bucket, 'gone-unproven')
  assert.equal(gone.local.gone, true)
  assert.equal(gone.remote, null)
  assert.equal(gone.reason, 'remote deleted, not provably merged')
  assert.equal(gone.unpushed, null)

  const pr = recs.get('open-pr')
  assert.equal(pr.bucket, 'protected')
  assert.equal(pr.openPr, 9)
  assert.equal(pr.reason, 'open PR #9')

  assert.equal(recs.has('main'), false)
  assert.equal(recs.has('HEAD'), false)
  assert.deepEqual([...recs.keys()].sort(), ['done-ff', 'gone', 'old', 'open-pr', 'wip', 'young'])
})

test('T7.2 git-sync.staleDays=7 makes a 10-day-old branch abandoned', (t) => {
  const w = world(t)
  w.git(w.a, 'config', 'git-sync.staleDays', '7')
  branch(w, 'tenday', { daysAgo: 10 })
  const rec = records(w).get('tenday')
  assert.equal(rec.bucket, 'abandoned')
  assert.equal(rec.reason, '10d without commits')
})

test('T7.3 a branch only the other box pushed is a remote-only active record', (t) => {
  const w = world(t)
  const tip = branch(w, 'b-wip', { push: true, dir: w.b })
  w.git(w.a, 'fetch', 'origin')
  const rec = records(w).get('b-wip')
  assert.equal(rec.local, null)
  assert.equal(rec.remote.sha, tip)
  assert.equal(typeof rec.remote.date, 'number')
  assert.equal(rec.bucket, 'active')
  assert.equal(rec.unpushed, null)
  assert.equal(rec.worktree, null)
  assert.equal(rec.openPr, null)
})

test('T7.4 merged only when every present tip is proven (Review Focus 1)', (t) => {
  const w = world(t)
  // This box merged `feat`, then the other box pushed one more commit onto origin/feat: the remote tip holds unmerged work.
  branch(w, 'feat', { push: true })
  w.git(w.a, 'merge', '--ff-only', 'feat')
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'feat', 'origin/feat')
  w.commit(w.b, { file: 'feat-more.txt', content: 'more\n', msg: 'more feat from b' })
  w.git(w.b, 'push', 'origin', 'feat')
  // A merged branch that was never pushed has only one tip to prove.
  branch(w, 'lm')
  w.git(w.a, 'merge', '--ff-only', 'lm')
  // Local `feat2` is behind origin/feat2, and it is origin's newer tip that got merged: both tips are proven.
  branch(w, 'feat2', { push: true })
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'feat2', 'origin/feat2')
  w.commit(w.b, { file: 'feat2-more.txt', content: 'more\n', msg: 'more feat2 from b' })
  w.git(w.b, 'push', 'origin', 'feat2')
  w.git(w.a, 'fetch', 'origin')
  w.git(w.a, 'merge', '--ff-only', 'origin/feat2')

  const recs = records(w)
  const feat = recs.get('feat')
  assert.notEqual(feat.local.sha, feat.remote.sha)
  assert.notEqual(feat.bucket, 'merged')
  assert.equal(feat.proof, null)
  assert.equal(recs.get('lm').bucket, 'merged')
  assert.equal(recs.get('lm').remote, null)
  const feat2 = recs.get('feat2')
  assert.notEqual(feat2.local.sha, feat2.remote.sha)
  assert.equal(feat2.bucket, 'merged')
  assert.equal(feat2.proof, 'M1')
})

test('T7.5 slashes and punctuation in branch names pair and round-trip exactly (Review Focus 3)', (t) => {
  const w = world(t)
  const names = ['feat/a/b', 'backlog/12', 'fix-#3']
  const tips = Object.fromEntries(names.map((n) => [n, branch(w, n, { push: true })]))
  const recs = records(w)
  assert.deepEqual([...recs.keys()].sort(), [...names].sort())
  for (const n of names) {
    assert.equal(recs.get(n).local.sha, tips[n])
    assert.equal(recs.get(n).remote.sha, tips[n])
    assert.equal(recs.get(n).local.upstream, `origin/${n}`)
    assert.equal(recs.get(n).local.gone, false)
  }
})

test('T7.6 unpushed: local-only, ahead of its upstream, or in sync', (t) => {
  const w = world(t)
  branch(w, 'solo')
  branch(w, 'ahead2', { push: true })
  w.git(w.a, 'checkout', 'ahead2')
  w.commit(w.a, { file: 'ahead2-b.txt', content: 'b\n', msg: 'ahead 1' })
  w.commit(w.a, { file: 'ahead2-c.txt', content: 'c\n', msg: 'ahead 2' })
  w.git(w.a, 'checkout', 'main')
  branch(w, 'wip', { push: true })

  const recs = records(w)
  assert.equal(recs.get('solo').unpushed, 'local-only')
  assert.equal(recs.get('solo').local.upstream, null)
  assert.equal(recs.get('solo').local.ahead, 0)
  assert.equal(recs.get('ahead2').unpushed, 'ahead')
  assert.equal(recs.get('ahead2').local.ahead, 2)
  assert.equal(recs.get('wip').unpushed, null)
  assert.equal(recs.get('wip').local.ahead, 0)
  for (const n of ['solo', 'ahead2', 'wip']) assert.equal(recs.get(n).bucket, 'active')
})

// `m1` merged into this box's local main only, never pushed: proven against the local trunk when the repo may push it (phase 6 publishes it before
// apply re-proves), but a downgraded repo's proofs run against origin/main, which never gets it.
function mergedLocallyOnly(w) {
  branch(w, 'm1')
  w.git(w.a, 'merge', '--ff-only', 'm1')
}

test('T7.7 a downgraded (GitLab) repo: no remote-only records, no unpushed, proofs against origin/<trunk>', (t) => {
  const w = world(t, { host: 'gitlab.com' })
  branch(w, 'b-only', { push: true, dir: w.b })
  w.git(w.a, 'fetch', 'origin')
  branch(w, 'lo')
  mergedLocallyOnly(w)

  const recs = records(w)
  assert.equal(recs.has('b-only'), false)
  assert.equal(recs.get('lo').bucket, 'active')
  assert.equal(recs.get('lo').unpushed, null)
  assert.notEqual(recs.get('m1').bucket, 'merged')
  assert.equal(recs.get('m1').proof, null)

  const gh = world(t)
  mergedLocallyOnly(gh)
  assert.equal(records(gh).get('m1').bucket, 'merged')
})

test('T7.8 worktrees: locked protects, a clean merged one joins mergedSet, a dirty one does not; detached and prunable', (t) => {
  const w = world(t)
  branch(w, 'lk')
  branch(w, 'm1')
  w.git(w.a, 'merge', '--ff-only', 'm1')
  branch(w, 'm2')
  w.git(w.a, 'merge', '--ff-only', 'm2')
  branch(w, 'gone-wt')
  const wt = (name) => path.join(w.root, `wt ${name}`)
  w.git(w.a, 'worktree', 'add', wt('lk'), 'lk')
  w.git(w.a, 'worktree', 'lock', wt('lk'))
  w.git(w.a, 'worktree', 'add', wt('m1'), 'm1')
  w.git(w.a, 'worktree', 'add', wt('m2'), 'm2')
  fs.writeFileSync(path.join(wt('m2'), 'm2.txt'), 'changed\n')
  w.git(w.a, 'worktree', 'add', '--detach', wt('det'))
  w.git(w.a, 'worktree', 'add', wt('gone'), 'gone-wt')
  fs.rmSync(wt('gone'), { recursive: true, force: true })

  const r = repo(w.a, { env: w.env })
  const worktrees = listWorktrees(r)
  const byPath = new Map(worktrees.map((x) => [x.path, x]))
  const real = (name) => path.join(fs.realpathSync(w.root), `wt ${name}`)
  assert.equal(worktrees.length, 5) // the main tree is never listed
  assert.equal(byPath.get(real('lk')).locked, true)
  assert.equal(byPath.get(real('lk')).branch, 'lk')
  assert.equal(byPath.get(real('m1')).dirty, 0)
  assert.equal(byPath.get(real('m2')).dirty, 1)
  assert.equal(byPath.get(real('m2')).locked, false)
  assert.equal(byPath.get(real('det')).branch, null)
  assert.match(byPath.get(real('det')).head, /^[0-9a-f]{40}$/)
  assert.equal(byPath.get(real('gone')).prunable, true)
  assert.equal(byPath.get(real('gone')).dirty, 0)
  assert.equal(byPath.get(real('m1')).prunable, false)

  const recs = new Map(branchRecords(r, worktrees).map((rec) => [rec.name, rec]))
  assert.equal(recs.get('lk').bucket, 'protected')
  assert.equal(recs.get('lk').worktree, real('lk'))
  assert.equal(recs.get('m1').bucket, 'merged')
  assert.equal(recs.get('m2').bucket, 'merged')

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.ok(result.json.mergedSet.includes('m1'))
  assert.ok(!result.json.mergedSet.includes('m2'))
  assert.ok(!result.json.mergedSet.includes('lk'))
})

test('T7.9 stashes: base branch, first parent, tracked plus untracked file counts, newest first', (t) => {
  const w = world(t)
  w.commit(w.a, { file: 'f1.txt', content: 'one\n', msg: 'f1' })
  w.commit(w.a, { file: 'f2.txt', content: 'two\n', msg: 'f2' })
  fs.writeFileSync(path.join(w.a, 'f1.txt'), 'one changed\n')
  fs.writeFileSync(path.join(w.a, 'f2.txt'), 'two changed\n')
  w.git(w.a, 'stash', 'push')
  const mainSha = w.git(w.a, 'rev-parse', 'main')
  w.git(w.a, 'checkout', '-b', 'feat')
  const featSha = w.commit(w.a, { file: 'feat.txt', content: 'feat\n', msg: 'feat' })
  fs.writeFileSync(path.join(w.a, 'f1.txt'), 'one on feat\n')
  fs.writeFileSync(path.join(w.a, 'untracked.txt'), 'new\n')
  w.git(w.a, 'stash', 'push', '-u')
  w.git(w.a, 'checkout', '--detach')
  fs.writeFileSync(path.join(w.a, 'f2.txt'), 'two detached\n')
  w.git(w.a, 'stash', 'push')
  w.git(w.a, 'checkout', 'main')

  const stashes = listStashes(repo(w.a, { env: w.env }))
  assert.equal(stashes.length, 3)
  const [detached, feat, main] = stashes
  assert.equal(detached.base, null)
  assert.equal(detached.files, 1)
  assert.equal(feat.sha, w.git(w.a, 'rev-parse', 'stash@{1}'))
  assert.equal(feat.base, 'feat')
  assert.equal(feat.baseSha, featSha)
  assert.equal(feat.files, 2)
  assert.equal(main.sha, w.git(w.a, 'rev-parse', 'stash@{2}'))
  assert.equal(main.base, 'main')
  assert.equal(main.baseSha, mainSha)
  assert.equal(main.files, 2)
  assert.equal(typeof main.date, 'number')
})

// Everything under the common git dir that a write could land in — refs, packed-refs, reflogs, config, HEAD, every index — hashed by path, minus the
// object store (the M3 probe is allowed to leave an unreferenced loose object there, and nothing else).
function snapshot(gitDir) {
  const out = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(gitDir, full)
      if (rel === 'objects') continue
      if (entry.isDirectory()) walk(full)
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(gitDir)
  return out
}

test('T7.10 survey is read-only: refs, stashes, worktrees and every index are unchanged; only survey.json is written', (t) => {
  const w = world(t)
  // A two-commit squash-merged branch so the M3 probe (the one proof that writes an object) actually runs; one commit would already prove M2.
  branch(w, 'sq')
  w.git(w.a, 'checkout', 'sq')
  w.commit(w.a, { file: 'sq-2.txt', content: 'sq 2\n', msg: 'sq 2' })
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'merge', '--squash', 'sq')
  w.git(w.a, 'commit', '-m', 'squash sq')
  branch(w, 'wip', { push: true })
  branch(w, 'b-wip', { push: true, dir: w.b })
  w.git(w.a, 'fetch', 'origin')
  w.commit(w.a, { file: 'f.txt', content: 'f\n', msg: 'f' })
  fs.writeFileSync(path.join(w.a, 'f.txt'), 'f changed\n')
  w.git(w.a, 'stash', 'push')
  const wtPath = path.join(w.root, 'wt wip')
  w.git(w.a, 'worktree', 'add', wtPath, 'wip')
  // Same content, new mtime: a `status` that refreshes the index would rewrite the worktree's index here, which is exactly what must not happen.
  const file = path.join(wtPath, 'wip.txt')
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(file, later, later)

  const readOnly = () => [
    w.git(w.a, 'for-each-ref'),
    w.git(w.a, 'stash', 'list'),
    w.git(w.a, 'worktree', 'list', '--porcelain'),
  ]
  const gitDir = path.join(w.a, '.git')
  const before = readOnly()
  const filesBefore = snapshot(gitDir)

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)

  assert.deepEqual(readOnly(), before)
  const filesAfter = snapshot(gitDir)
  const added = Object.keys(filesAfter).filter((k) => !(k in filesBefore))
  assert.deepEqual(added, [path.join('git-sync', 'survey.json')])
  for (const [k, hash] of Object.entries(filesBefore)) assert.equal(filesAfter[k], hash, `${k} changed`)

  const s = result.json
  assert.equal(s.ok, true)
  assert.equal(s.cmd, 'survey')
  assert.equal(s.trunk, 'main')
  assert.equal(s.remoteKind, 'github')
  assert.equal(s.pushAllowed, true)
  assert.equal(s.downgraded, false)
  assert.equal(s.staleDays, 30)
  assert.equal(s.gh, 'absent')
  // The decision round is Task 8's (plan.test.mjs); here only that the payload carries it, built from this same survey.
  assert.equal(s.rounds[0][0].id, 'merged')
  assert.deepEqual(s.followups.merged.flat().map((q) => q.id), ['merged-pick:0'])
  assert.equal(s.stashes.length, 1)
  assert.equal(s.worktrees.length, 1)
  const sq = s.branches.find((b) => b.name === 'sq')
  assert.equal(sq.bucket, 'merged')
  assert.equal(sq.proof, 'M3')
  assert.equal(sq.reason, 'merged: squash (M3)')
  assert.deepEqual(s.mergedSet, ['sq'])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gitDir, 'git-sync', 'survey.json'), 'utf8')), s)
})

test('T7.11 a branch checked out in the main tree is protected (§5 "is the current HEAD")', (t) => {
  const w = world(t)
  branch(w, 'here', { daysAgo: 60 })
  w.git(w.a, 'checkout', 'here')
  const rec = records(w).get('here')
  assert.equal(rec.bucket, 'protected')
  assert.equal(rec.unpushed, null)
})

test('T7.12 a missing proof ref is no proof, never a crash (R12)', (t) => {
  const w = world(t, { host: 'gitlab.com' })
  branch(w, 'm1')
  w.git(w.a, 'merge', '--ff-only', 'm1')
  w.git(w.a, 'update-ref', '-d', 'refs/remotes/origin/main')
  const rec = records(w).get('m1')
  assert.equal(rec.proof, null)
  assert.notEqual(rec.bucket, 'merged')
})

test('T7.13 M4 fills in only for a single tip M1–M3 left unproven', (t) => {
  const w = world(t)
  // Unmerged locally; GitHub says its PR merged at exactly this tip (a server-side squash no local proof can see).
  const ghTip = branch(w, 'gh-sq', { push: true })
  // This box merged `half`, the other box pushed one more commit, and that newer origin tip is the merged PR's head.
  branch(w, 'half', { push: true })
  w.git(w.a, 'merge', '--ff-only', 'half')
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'half', 'origin/half')
  const halfRemote = w.commit(w.b, { file: 'half-more.txt', content: 'more\n', msg: 'more half from b' })
  w.git(w.b, 'push', 'origin', 'half')
  // Local and remote diverged and neither is merged: one PR head can never cover both.
  branch(w, 'split', { push: true })
  w.git(w.a, 'checkout', 'split')
  w.commit(w.a, { file: 'split-local.txt', content: 'l\n', msg: 'split local' })
  w.git(w.a, 'checkout', 'main')
  w.git(w.b, 'fetch', 'origin')
  w.git(w.b, 'checkout', '-b', 'split', 'origin/split')
  const splitRemote = w.commit(w.b, { file: 'split-remote.txt', content: 'r\n', msg: 'split remote' })
  w.git(w.b, 'push', 'origin', 'split')
  w.git(w.a, 'fetch', 'origin')
  const merged = (number, headRefOid) => ({ stdout: `${JSON.stringify([{ number, state: 'MERGED', headRefOid, baseRefName: 'main' }])}\n` })
  w.stub('gh', {
    stdout: '[]\n',
    byArgs: { '--head gh-sq': merged(4, ghTip), '--head half': merged(5, halfRemote), '--head split': merged(6, splitRemote) },
  })

  const recs = records(w)
  assert.equal(recs.get('gh-sq').bucket, 'merged')
  assert.equal(recs.get('gh-sq').proof, 'M4')
  assert.equal(recs.get('gh-sq').reason, 'merged: PR #4 (M4)')
  assert.equal(recs.get('half').bucket, 'merged')
  assert.equal(recs.get('half').proof, 'M1')
  assert.equal(recs.get('split').proof, null)
  assert.notEqual(recs.get('split').bucket, 'merged')
})

// A merged branch `name` checked out in its own linked worktree under the world root, returning the worktree's realpath (how git reports it).
function mergedInWorktree(w, name) {
  branch(w, name)
  w.git(w.a, 'merge', '--ff-only', name)
  const wtPath = path.join(w.root, `wt ${name}`)
  w.git(w.a, 'worktree', 'add', wtPath, name)
  return path.join(fs.realpathSync(w.root), `wt ${name}`)
}

test('T7.14 ignored files count as dirty unless they sit under a junk directory (R14)', (t) => {
  const w = world(t)
  w.commit(w.a, { file: '.gitignore', content: 'node_modules/\n.env\nsecrets/\n', msg: 'ignore more' })
  const env = mergedInWorktree(w, 'env')
  fs.writeFileSync(path.join(env, '.env'), 'TOKEN=local\n')
  const junk = mergedInWorktree(w, 'junk')
  fs.mkdirSync(path.join(junk, 'node_modules'))
  fs.writeFileSync(path.join(junk, 'node_modules', 'x.js'), 'x\n')
  const nested = mergedInWorktree(w, 'nested')
  fs.mkdirSync(path.join(nested, 'pkg', 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(nested, 'pkg', 'node_modules', 'dep', 'index.js'), 'dep\n')
  // An ignored directory is one status entry however many files it holds, and its contents are the user's, not junk.
  const secrets = mergedInWorktree(w, 'secrets')
  fs.mkdirSync(path.join(secrets, 'secrets'))
  fs.writeFileSync(path.join(secrets, 'secrets', 'a.key'), 'a\n')
  fs.writeFileSync(path.join(secrets, 'secrets', 'b.key'), 'b\n')

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const dirty = Object.fromEntries(result.json.worktrees.map((wt) => [wt.path, wt.dirty]))
  assert.equal(dirty[env], 1)
  assert.equal(dirty[junk], 0)
  assert.equal(dirty[nested], 0)
  assert.equal(dirty[secrets], 1)
  assert.deepEqual([...result.json.mergedSet].sort(), ['junk', 'nested'])
  for (const name of ['env', 'junk', 'nested', 'secrets']) assert.equal(result.json.branches.find((b) => b.name === name).bucket, 'merged')
})

test('T7.15 a branch checked out in several worktrees: protected if any is locked, in mergedSet only if all are clean', (t) => {
  const w = world(t)
  const lockedDirty = mergedInWorktree(w, 'multi')
  w.git(w.a, 'worktree', 'lock', lockedDirty)
  fs.writeFileSync(path.join(lockedDirty, 'multi.txt'), 'changed\n')
  w.git(w.a, 'worktree', 'add', '-f', path.join(w.root, 'wt multi 2'), 'multi')
  const dirtyFirst = mergedInWorktree(w, 'twice')
  fs.writeFileSync(path.join(dirtyFirst, 'twice.txt'), 'changed\n')
  w.git(w.a, 'worktree', 'add', '-f', path.join(w.root, 'wt twice 2'), 'twice')

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const rec = (name) => result.json.branches.find((b) => b.name === name)
  assert.equal(rec('multi').bucket, 'protected')
  assert.equal(rec('multi').reason, 'checked out in a locked worktree')
  assert.equal(rec('twice').bucket, 'merged')
  assert.deepEqual(result.json.mergedSet, [])
})

test('T7.16 a branch mid-rebase or mid-bisect in a linked worktree is still checked out there, so protected', (t) => {
  const w = world(t)
  // `rb` and main both change the same file, so the rebase stops on a conflict and the worktree's HEAD goes detached.
  const rbWt = mergedInWorktree(w, 'rb')
  w.commit(rbWt, { file: 'shared.txt', content: 'from rb\n', msg: 'rb side' })
  w.commit(w.a, { file: 'shared.txt', content: 'from main\n', msg: 'main side' })
  assert.throws(() => w.git(rbWt, 'rebase', 'main'))
  // Bisecting `bs` against main checks out a detached midpoint in its worktree.
  const bsWt = mergedInWorktree(w, 'bs')
  w.commit(bsWt, { file: 'bs-2.txt', content: '2\n', msg: 'bs 2' })
  w.commit(bsWt, { file: 'bs-3.txt', content: '3\n', msg: 'bs 3' })
  w.git(bsWt, 'bisect', 'start', 'bs', 'main')

  const r = repo(w.a, { env: w.env })
  const worktrees = listWorktrees(r)
  const byPath = new Map(worktrees.map((x) => [x.path, x]))
  assert.equal(byPath.get(rbWt).branch, 'rb')
  assert.equal(byPath.get(bsWt).branch, 'bs')
  const recs = new Map(branchRecords(r, worktrees).map((rec) => [rec.name, rec]))
  assert.equal(recs.get('rb').bucket, 'protected')
  assert.equal(recs.get('rb').worktree, rbWt)
  assert.equal(recs.get('rb').reason, 'mid-rebase in a worktree')
  assert.equal(recs.get('bs').bucket, 'protected')
  assert.equal(recs.get('bs').reason, 'mid-bisect in a worktree')
})

test('T7.17 a local refs/heads/HEAD never becomes a record', (t) => {
  const w = world(t)
  // Created after `real`: once refs/heads/HEAD exists, any later git command that resolves plain `HEAD` fails as ambiguous.
  branch(w, 'real')
  w.git(w.a, 'update-ref', 'refs/heads/HEAD', w.git(w.a, 'rev-parse', 'main'))
  assert.deepEqual([...records(w).keys()], ['real'])
})

test('T7.18 ahead counts against origin/<name> when it exists, whatever the upstream says', (t) => {
  const w = world(t)
  // Pushed without -u: no upstream, but origin/nou exists and the local copy is one commit past it.
  branch(w, 'nou')
  w.git(w.a, 'push', 'origin', 'nou')
  w.git(w.a, 'checkout', 'nou')
  w.commit(w.a, { file: 'nou-2.txt', content: '2\n', msg: 'nou 2' })
  w.git(w.a, 'checkout', 'main')
  // Tracks origin/main rather than origin/tm, and is in sync with origin/tm.
  branch(w, 'tm', { push: true })
  w.git(w.a, 'branch', '--set-upstream-to=origin/main', 'tm')

  const recs = records(w)
  assert.equal(recs.get('nou').local.upstream, null)
  assert.equal(recs.get('nou').local.ahead, 1)
  assert.equal(recs.get('nou').unpushed, 'ahead')
  assert.equal(recs.get('tm').local.ahead, 0)
  assert.equal(recs.get('tm').unpushed, null)
})

test('T7.19 a prunable worktree whose directory still exists counts as dirty', (t) => {
  const w = world(t)
  const wtPath = mergedInWorktree(w, 'orphan')
  fs.writeFileSync(path.join(wtPath, 'notes.txt'), 'mine\n')
  fs.rmSync(path.join(wtPath, '.git'))

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const wt = result.json.worktrees.find((x) => x.path === wtPath)
  assert.equal(wt.prunable, true)
  assert.equal(wt.dirty, 1)
  assert.deepEqual(result.json.mergedSet, [])
})

test('T7.20 a gh failure on one branch leaves it unmerged and flagged, and never costs the next branch its open-PR protection (R17)', (t) => {
  const w = world(t)
  // Both are fast-forward merged into main (M1); `flaky` sorts first, so its failed lookup runs before `open-y`'s.
  for (const name of ['flaky', 'open-y']) {
    branch(w, name)
    w.git(w.a, 'merge', '--ff-only', name)
  }
  const open = `${JSON.stringify([{ number: 8, state: 'OPEN', headRefOid: 'x', baseRefName: 'main' }])}\n`
  w.stub('gh', { stdout: open, byArgs: { '--head flaky': { exit: 1, stderr: 'HTTP 502\n', stdout: '' } } })

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stderr)
  const recs = new Map(result.json.branches.map((rec) => [rec.name, rec]))
  assert.equal(recs.get('open-y').bucket, 'protected')
  assert.equal(recs.get('open-y').reason, 'open PR #8')
  const flaky = recs.get('flaky')
  assert.equal(flaky.bucket, 'active')
  assert.equal(flaky.proof, null)
  assert.match(flaky.reason, /PR status unknown \(gh failed\)$/)
  assert.equal(flaky.unpushed, 'local-only')
  assert.deepEqual(result.json.mergedSet, [])
})

test('T7.21 gh absent: an M1-merged branch stays merged and the payload says gh is absent (R17)', (t) => {
  const w = world(t)
  branch(w, 'done')
  w.git(w.a, 'merge', '--ff-only', 'done')

  const result = w.cli(w.a, ['survey'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.gh, 'absent')
  const [done] = result.json.branches
  assert.equal(done.bucket, 'merged')
  assert.equal(done.proof, 'M1')
  assert.deepEqual(result.json.mergedSet, ['done'])
})

test('T7.22 a branch mid-rebase or mid-bisect in the main tree is protected even though HEAD reads detached', (t) => {
  const w = world(t)
  // `mr` conflicts with main on shared.txt, so rebasing it in the main tree stops with HEAD detached.
  branch(w, 'mr')
  w.git(w.a, 'checkout', 'mr')
  w.commit(w.a, { file: 'shared.txt', content: 'from mr\n', msg: 'mr side' })
  w.git(w.a, 'checkout', 'main')
  w.commit(w.a, { file: 'shared.txt', content: 'from main\n', msg: 'main side' })
  w.git(w.a, 'checkout', 'mr')
  assert.throws(() => w.git(w.a, 'rebase', 'main'))
  assert.equal(records(w).get('mr').reason, 'mid-rebase in the main tree')
  assert.equal(records(w).get('mr').bucket, 'protected')
  w.git(w.a, 'rebase', '--abort')
  w.git(w.a, 'checkout', 'main')

  // Bisecting from `bs` detaches HEAD at a midpoint; BISECT_START remembers `bs` as the branch to return to.
  branch(w, 'bs')
  w.git(w.a, 'checkout', 'bs')
  w.commit(w.a, { file: 'bs-2.txt', content: '2\n', msg: 'bs 2' })
  w.commit(w.a, { file: 'bs-3.txt', content: '3\n', msg: 'bs 3' })
  w.git(w.a, 'bisect', 'start', 'bs', 'main')
  const bs = records(w).get('bs')
  assert.equal(bs.bucket, 'protected')
  assert.equal(bs.reason, 'mid-bisect in the main tree')
})
