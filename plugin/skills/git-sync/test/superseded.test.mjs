// Tests for the superseded bucket and the relaxed M4 (design.md §5, R38, R39): branches whose work already reached `origin/<trunk>` with no commit-level
// trace left — a squash that also carried other files, a tip that moved on after its PR merged, an empty "verification only" commit. Each fixture is
// shaped after a real backlog-manager branch from 2026-11-04 (`feat/source-sections` / #394, a docs branch landed inside a bigger squash, #417's
// diverged tip). Superseded is never merged: it gets its own question, is never answered unattended, and apply re-proves it on origin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { repo, branchRecords, supersededProof, prLookup } from '../tools/git-sync.mjs'
import { world } from './world.mjs'

// Writes every `[file, content]` pair in `dir`, stages them and commits — several files in one commit, which is what a squash that carried more than
// the branch looks like. Returns the new HEAD.
function commitFiles(w, dir, files, msg) {
  for (const [file, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
    w.git(dir, 'add', file)
  }
  w.git(dir, 'commit', '-m', msg)
  return w.git(dir, 'rev-parse', 'HEAD')
}

// `files` land on a's main in one commit, which is then published, so `origin/main` holds them.
function landOnTrunk(w, files, msg = 'squash: land work') {
  w.git(w.a, 'checkout', 'main')
  commitFiles(w, w.a, files, msg)
  w.git(w.a, 'push', 'origin', 'main')
}

function records(w) {
  return new Map(branchRecords(repo(w.a, { env: w.env })).map((rec) => [rec.name, rec]))
}

const mergedPr = (number, headRefOid, baseRefName = 'main') => ({
  stdout: `${JSON.stringify([{ number, state: 'MERGED', headRefOid, baseRefName }])}\n`,
})

// backlog-manager's `feat/source-sections` (#394): the PR merged at head H via a squash that also carried another file (so neither M2 nor M3 can
// match it), then one more commit `extra` went onto the branch. `extraOnTrunk` decides whether that commit's change also reached the trunk.
function sourceSections(t, extraOnTrunk) {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat/ss')
  const head = commitFiles(w, w.a, [['src/sections.txt', 'sections\n']], 'feat: source sections')
  w.git(w.a, 'push', '-u', 'origin', 'feat/ss')
  commitFiles(w, w.a, [['src/follow-up.txt', 'follow up\n']], 'fix: follow-up after merge')
  w.git(w.a, 'push', 'origin', 'feat/ss')
  landOnTrunk(w, [['src/sections.txt', 'sections\n'], ['src/unrelated.txt', 'other pr\n']], 'feat: source sections (#394)')
  if (extraOnTrunk) landOnTrunk(w, [['src/follow-up.txt', 'follow up\n'], ['docs/notes.md', 'notes\n']], 'chore: bundle (#401)')
  w.stub('gh', { stdout: '[]\n', byArgs: { '--head feat/ss': mergedPr(394, head), 'rules/branches': { stdout: '[]' } } })
  return { w, head }
}

test('S1 relaxed M4: a merged PR whose head is below the tip proves merged when every later commit is on the trunk', (t) => {
  const { w } = sourceSections(t, true)
  const rec = records(w).get('feat/ss')
  assert.equal(rec.bucket, 'merged')
  assert.equal(rec.proof, 'M4')
  assert.equal(rec.reason, 'merged: PR #394 + 1 later commit already on main (M4)')
  const tip = w.git(w.a, 'rev-parse', 'feat/ss')
  assert.deepEqual(prLookup(repo(w.a, { env: w.env }), 'feat/ss', tip), { state: 'merged-below-tip', number: 394, extra: 1 })
})

test('S2 relaxed M4: a later commit that is not on the trunk proves nothing, and the branch is not superseded either', (t) => {
  const { w } = sourceSections(t, false)
  const rec = records(w).get('feat/ss')
  assert.equal(rec.proof, null)
  assert.equal(rec.bucket, 'active')
  assert.equal(rec.superseded, null)
})

test('S3 relaxed M4: a later commit proven by patch id (cherry-picked onto the trunk) also counts', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat/cp')
  const head = commitFiles(w, w.a, [['cp.txt', 'cp\n']], 'feat: cp')
  const extra = commitFiles(w, w.a, [['cp-more.txt', 'more\n']], 'fix: more')
  landOnTrunk(w, [['cp.txt', 'cp\n'], ['cp-other.txt', 'other\n']], 'feat: cp (#5)')
  w.git(w.a, 'cherry-pick', extra)
  w.git(w.a, 'push', 'origin', 'main')
  w.stub('gh', { stdout: '[]\n', byArgs: { '--head feat/cp': mergedPr(5, head), 'rules/branches': { stdout: '[]' } } })
  const rec = records(w).get('feat/cp')
  assert.equal(rec.proof, 'M4')
  assert.equal(rec.bucket, 'merged')
})

test('S4 relaxed M4 still needs the PR merged into the trunk (R15)', (t) => {
  const { w, head } = sourceSections(t, true)
  w.stub('gh', { stdout: '[]\n', byArgs: { '--head feat/ss': mergedPr(394, head, 'feat/base'), 'rules/branches': { stdout: '[]' } } })
  const rec = records(w).get('feat/ss')
  assert.notEqual(rec.proof, 'M4')
  // Every changed file is on the trunk all the same, so the content proof still finds it — as superseded, never as merged.
  assert.equal(rec.bucket, 'superseded')
})

test('S5 a docs branch landed byte for byte inside a bigger squash is superseded, not merged (M3 misses it)', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'docs/guide')
  commitFiles(w, w.a, [['docs/a.md', '# A\n']], 'docs: a')
  commitFiles(w, w.a, [['docs/b.md', '# B\n']], 'docs: b')
  landOnTrunk(w, [['docs/a.md', '# A\n'], ['docs/b.md', '# B\n'], ['src/feature.txt', 'feature\n']], 'feat: big squash (#300)')
  const rec = records(w).get('docs/guide')
  assert.equal(rec.proof, null)
  assert.equal(rec.bucket, 'superseded')
  assert.deepEqual(rec.superseded, { files: 2 })
  assert.equal(rec.reason, 'superseded: all 2 changed files identical on origin/main')
  // Local-only and recent, it would have been offered for a push before; a superseded branch never is.
  assert.equal(rec.unpushed, null)
})

test('S6 a tip that diverged from its merged PR head is not merged, but superseded when its files are all on the trunk', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'feat/div')
  const head = commitFiles(w, w.a, [['div.txt', 'div\n']], 'feat: div')
  w.git(w.a, 'reset', '--hard', 'main')
  commitFiles(w, w.a, [['div.txt', 'div\n']], 'feat: div, reworded')
  landOnTrunk(w, [['div.txt', 'div\n'], ['div-other.txt', 'other\n']], 'feat: div (#417)')
  w.stub('gh', { stdout: '[]\n', byArgs: { '--head feat/div': mergedPr(417, head), 'rules/branches': { stdout: '[]' } } })
  const tip = w.git(w.a, 'rev-parse', 'feat/div')
  assert.notEqual(tip, head)
  assert.equal(prLookup(repo(w.a, { env: w.env }), 'feat/div', tip).state, 'none')
  const rec = records(w).get('feat/div')
  assert.equal(rec.proof, null)
  assert.equal(rec.bucket, 'superseded')
  assert.equal(rec.reason, 'superseded: its one changed file is identical on origin/main')
})

test('S7 a branch holding only an empty commit is superseded', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'verify-only')
  w.git(w.a, 'commit', '--allow-empty', '-m', 'chore: verification only')
  w.git(w.a, 'checkout', 'main')
  landOnTrunk(w, [['moved.txt', 'trunk moved on\n']])
  const rec = records(w).get('verify-only')
  assert.equal(rec.proof, null)
  assert.equal(rec.bucket, 'superseded')
  assert.deepEqual(rec.superseded, { files: 0 })
  assert.equal(rec.reason, 'superseded: no changed files since it left main')
})

test('S8 one changed file that differs on the trunk keeps the old buckets: active when recent, abandoned when old', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'differs')
  commitFiles(w, w.a, [['shared.txt', 'branch version\n']], 'branch edit')
  w.git(w.a, 'checkout', '-b', 'differs-old', 'main')
  w.commit(w.a, { file: 'shared.txt', content: 'old branch version\n', msg: 'old branch edit', daysAgo: 40 })
  landOnTrunk(w, [['shared.txt', 'trunk version\n']])
  const recs = records(w)
  assert.equal(recs.get('differs').bucket, 'active')
  assert.equal(recs.get('differs').superseded, null)
  assert.equal(recs.get('differs-old').bucket, 'abandoned')
})

test('S9 a branch with an open PR stays protected even when superseded', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'open-sup')
  const tip = commitFiles(w, w.a, [['open.txt', 'open\n']], 'feat: open')
  landOnTrunk(w, [['open.txt', 'open\n'], ['open-other.txt', 'x\n']])
  const open = { stdout: `${JSON.stringify([{ number: 12, state: 'OPEN', headRefOid: tip, baseRefName: 'main' }])}\n` }
  w.stub('gh', { stdout: '[]\n', byArgs: { '--head open-sup': open, 'rules/branches': { stdout: '[]' } } })
  const rec = records(w).get('open-sup')
  assert.equal(rec.bucket, 'protected')
  assert.equal(rec.reason, 'open PR #12')
})

test('S10 supersededProof: deletions count when the path is absent on the trunk too; a path the trunk still has does not', (t) => {
  const w = world(t)
  landOnTrunk(w, [['gone.txt', 'x\n'], ['kept.txt', 'y\n']])
  w.git(w.a, 'checkout', '-b', 'rm-both')
  w.git(w.a, 'rm', '-q', 'gone.txt')
  w.git(w.a, 'commit', '-m', 'rm gone')
  w.git(w.a, 'checkout', '-b', 'rm-kept', 'main')
  w.git(w.a, 'rm', '-q', 'kept.txt')
  w.git(w.a, 'commit', '-m', 'rm kept')
  w.git(w.a, 'checkout', 'main')
  w.git(w.a, 'rm', '-q', 'gone.txt')
  w.git(w.a, 'commit', '-m', 'trunk rm gone')
  w.git(w.a, 'push', 'origin', 'main')
  const ctx = w.ctx(w.a)
  assert.deepEqual(supersededProof(ctx, w.git(w.a, 'rev-parse', 'rm-both'), 'refs/remotes/origin/main'), { files: 1 })
  assert.equal(supersededProof(ctx, w.git(w.a, 'rev-parse', 'rm-kept'), 'refs/remotes/origin/main'), null)
})

// survey → plan → apply → report for the docs branch of S5, published so it has a remote copy too.
function supersededWorld(t) {
  const w = world(t)
  w.rules([])
  w.git(w.a, 'checkout', '-b', 'docs/guide')
  const tip = commitFiles(w, w.a, [['docs/a.md', '# A\n']], 'docs: a')
  w.git(w.a, 'push', '-u', 'origin', 'docs/guide')
  landOnTrunk(w, [['docs/a.md', '# A\n'], ['src/feature.txt', 'feature\n']], 'feat: big squash (#300)')
  return { w, tip }
}

function cliOk(w, args) {
  const result = w.cli(w.a, args)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.json
}

function planWith(w, answers) {
  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, JSON.stringify(answers))
  return cliOk(w, ['plan', '--answers', file]).actions
}

test('S11 the decision round asks superseded branches on their own, never unattended, never in the merged set', (t) => {
  const { w } = supersededWorld(t)
  const s = cliOk(w, ['survey'])
  assert.deepEqual(s.mergedSet, [])
  assert.deepEqual(s.unattended, {})
  const qs = s.rounds.flat()
  const q = qs.find((x) => x.id === 'superseded:0')
  assert.ok(q, JSON.stringify(qs))
  assert.equal(q.header, 'Superseded')
  assert.equal(q.multiSelect, true)
  assert.deepEqual(q.options.map((o) => o.label), ['docs/guide', 'Keep all'])
  assert.match(q.options[0].description, /identical on origin\/main/)
  assert.ok(!qs.some((x) => x.id.startsWith('asked') || x.id.startsWith('push')), 'not offered as abandoned or for a push')
  // Unattended answers delete nothing superseded.
  assert.deepEqual(planWith(w, s.unattended), [])
})

test('S12 a ticked superseded branch is deleted on both sides with basis superseded and reported as such', (t) => {
  const { w, tip } = supersededWorld(t)
  cliOk(w, ['survey'])
  assert.deepEqual(planWith(w, { superseded: ['Keep all'] }), [])
  const actions = planWith(w, { superseded: ['docs/guide'] })
  assert.deepEqual(actions.map((a) => [a.kind, a.target, a.basis]), [
    ['delete-remote', 'docs/guide', 'superseded'],
    ['delete-local', 'docs/guide', 'superseded'],
  ])
  cliOk(w, ['verify'])
  cliOk(w, ['push-trunk'])
  const applied = cliOk(w, ['apply'])
  assert.deepEqual(applied.results.map((r) => [r.kind, r.status]), [['delete-remote', 'done'], ['delete-local', 'done']])
  const { markdown } = cliOk(w, ['report'])
  assert.ok(markdown.includes('- docs/guide (superseded: its changes were already on main) — local'), markdown)
  assert.ok(markdown.includes(`git branch docs/guide ${tip}`), markdown)
})

test('S13 apply re-proves a superseded deletion on origin: a branch whose content is not on the trunk is kept', (t) => {
  const w = world(t)
  w.git(w.a, 'checkout', '-b', 'not-sup')
  const tip = commitFiles(w, w.a, [['mine.txt', 'mine\n']], 'mine')
  w.git(w.a, 'checkout', 'main')
  const file = path.join(w.root, 'hand plan.json')
  fs.writeFileSync(file, JSON.stringify({ actions: [{ kind: 'delete-local', target: 'not-sup', expectTip: tip, basis: 'superseded' }] }))
  const json = cliOk(w, ['apply', '--plan', file])
  assert.deepEqual(json.results.map((r) => [r.kind, r.status, r.reason]), [['delete-local', 'skipped', 'not-superseded-on-origin']])
  assert.equal(w.git(w.a, 'rev-parse', 'not-sup'), tip)
})

test('S14 bad-answers: superseded names only what its question offered', (t) => {
  const { w } = supersededWorld(t)
  w.git(w.a, 'checkout', '-b', 'other')
  commitFiles(w, w.a, [['other.txt', 'o\n']], 'other')
  w.git(w.a, 'checkout', 'main')
  cliOk(w, ['survey'])
  const file = path.join(w.root, 'answers.json')
  fs.writeFileSync(file, JSON.stringify({ superseded: ['other'] }))
  const result = w.cli(w.a, ['plan', '--answers', file])
  assert.equal(result.status, 2)
  assert.equal(result.json.stop, 'bad-answers')
})
