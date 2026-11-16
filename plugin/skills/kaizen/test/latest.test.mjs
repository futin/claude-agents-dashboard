// Tests for `kaizen.mjs --latest` and the CLI's session selection: which transcript `resolveLatest` picks for a cwd, how many candidates it had to
// parse in full to decide (`fullParses`), and the path guard, session-id and usage errors the CLI prints. Each world is a synthetic projects root;
// the CLI cases spawn the file with HOME pointed at that root's parent, since projectsRoot() reads os.homedir(). The same unit cases run against
// the repo-side twin in test/analytics/session-latest.test.ts, with that side's 16 KiB window.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLatest } from '../kaizen.mjs'

const KAIZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../kaizen.mjs')
/** kaizen's head window (HEAD_BYTES in kaizen.mjs). */
const W = 65536

const dirs = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-latest-'))
  dirs.push(home)
  const root = path.join(home, '.claude', 'projects')
  fs.mkdirSync(root, { recursive: true })
  return { home, root }
}

let seq = 0
const T0 = Date.parse('2026-11-01T00:00:00Z') / 1000

/** Write `records` as one transcript under the project dir for `dirCwd`, with mtime T0 + `age` seconds. Returns its id and path. */
function transcript(root, dirCwd, records, age, { raw } = {}) {
  const dir = path.join(root, dirCwd.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const id = `s${String(seq++).padStart(4, '0')}`
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, raw ?? records.map(r => JSON.stringify(r)).join('\n') + '\n')
  fs.utimesSync(file, T0 + age, T0 + age)
  return { id, file }
}

const rec = (cwd, extra = {}) => ({ type: 'user', ...(cwd === undefined ? {} : { cwd }), timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'go' }, ...extra })
/** A first record with no `cwd` key whose serialised line is exactly `bytes` long. */
function padding(bytes) {
  const base = { type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: '' } }
  const overhead = JSON.stringify(base).length
  return { ...base, message: { role: 'user', content: 'x'.repeat(bytes - overhead) } }
}
const normal = (root, cwd, age) => transcript(root, cwd, [rec(cwd), rec(cwd)], age)

test('1. an older match behind newer foreign sessions, with no full parse', () => {
  const { root } = world()
  for (let i = 0; i < 3; i++) normal(root, '/w/a', 100 + i)
  const b = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 0 })
})

test('2. the newest of several transcripts in the same cwd', () => {
  const { root } = world()
  normal(root, '/w/b', 0)
  const bNew = normal(root, '/w/b', 60)
  const r = resolveLatest({ root, cwd: '/w/b' })
  assert.equal(r.match.id, bNew.id)
  assert.equal(r.fullParses, 0)
})

test('3. a trailing slash on either side still matches; / matches only /', () => {
  let { root } = world()
  let t = transcript(root, '/x/proj', [rec('/x/proj/')], 0)
  assert.equal(resolveLatest({ root, cwd: '/x/proj' }).match?.id, t.id)
  ;({ root } = world())
  t = transcript(root, '/x/proj', [rec('/x/proj')], 0)
  assert.equal(resolveLatest({ root, cwd: '/x/proj/' }).match?.id, t.id)
  ;({ root } = world())
  t = transcript(root, '/', [rec('/')], 0)
  assert.equal(resolveLatest({ root, cwd: '/' }).match?.id, t.id)
  assert.equal(resolveLatest({ root, cwd: '/x' }).match, null)
  ;({ root } = world())
  transcript(root, '/x', [rec('/x/')], 0)
  assert.equal(resolveLatest({ root, cwd: '/' }).match, null)
})

test('4. no match reads heads only — never a full parse', () => {
  const { root } = world()
  for (let i = 0; i < 5; i++) normal(root, `/w/other${i}`, i)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: null, fullParses: 0 })
})

test('5. the first cwd decides, not any later one', () => {
  let { root } = world()
  transcript(root, '/w/a', [rec('/w/a'), rec('/w/b')], 100)
  const older = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: older.file, id: older.id }, fullParses: 0 })
  ;({ root } = world())
  transcript(root, '/w/a', [rec('/w/a'), rec('/w/b')], 100)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: null, fullParses: 0 })
})

test('6. fallback: the first cwd sits past the window', () => {
  const { root } = world()
  const t = transcript(root, '/w/b', [padding(W + 5000), rec('/w/b')], 0)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: t.file, id: t.id }, fullParses: 1 })
})

test('7. fallback: the cwd record straddles the window edge', () => {
  const { root } = world()
  const pad = padding(W - 100 - 1) // its newline makes the cwd record start at byte W - 100
  const cwdRec = rec('/w/b', { message: { role: 'user', content: 'y'.repeat(300) } })
  const t = transcript(root, '/w/b', [pad, cwdRec], 0)
  const text = fs.readFileSync(t.file, 'utf8')
  assert.equal(text.indexOf('{"type":"user","cwd"'), W - 100)
  assert.ok(W - 100 + JSON.stringify(cwdRec).length > W)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: t.file, id: t.id }, fullParses: 1 })
})

test('8. a fallback on a foreign file costs one parse and does not match', () => {
  const { root } = world()
  transcript(root, '/w/a', [padding(W + 5000), rec('/w/a')], 100)
  const b = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 1 })
})

test('9. no cwd anywhere: a small file costs no parse, a big one costs one', () => {
  let { root } = world()
  transcript(root, '/w/none', [rec(undefined), rec(undefined)], 100)
  let b = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 0 })
  ;({ root } = world())
  transcript(root, '/w/none', [padding(W + 5000), rec(undefined)], 100)
  b = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 1 })
  ;({ root } = world())
  transcript(root, '/w/none', [rec(undefined), rec(undefined)], 100)
  transcript(root, '/w/none2', [padding(W + 5000), rec(undefined)], 90)
  b = normal(root, '/w/b', 10)
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 1 })
})

test('10. empty and unreadable files are skipped without throwing', () => {
  const { root } = world()
  transcript(root, '/w/b', [], 100, { raw: '' })
  const locked = process.getuid?.() === 0 ? null : transcript(root, '/w/b', [rec('/w/b')], 90)
  if (locked) fs.chmodSync(locked.file, 0o000)
  const b = normal(root, '/w/b', 10)
  try {
    assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: { file: b.file, id: b.id }, fullParses: 0 })
  } finally {
    if (locked) fs.chmodSync(locked.file, 0o644)
  }
})

test('11. an empty or missing root', () => {
  const { root } = world()
  assert.deepEqual(resolveLatest({ root, cwd: '/w/b' }), { match: null, fullParses: 0 })
  assert.deepEqual(resolveLatest({ root: path.join(root, 'nope'), cwd: '/w/b' }), { match: null, fullParses: 0 })
})

/* ------------------------------------------------ CLI, spawned */

function run(home, args, cwd = home) {
  const r = spawnSync(process.execPath, [KAIZEN, ...args], { cwd, env: { ...process.env, HOME: home }, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** A world with one real project dir (realpath'd, since macOS tmpdir is /var → /private/var) and one transcript recorded there. */
function cliWorld() {
  const { home, root } = world()
  const proj = path.join(home, 'work', 'proj-b')
  fs.mkdirSync(proj, { recursive: true })
  const cwd = fs.realpathSync(proj)
  const t = normal(root, cwd, 10)
  normal(root, '/w/elsewhere', 100)
  return { home, root, cwd, t }
}

test('12. --latest from the project dir prints that session', () => {
  const { home, cwd, t } = cliWorld()
  const r = run(home, ['--latest'], cwd)
  assert.equal(r.code, 0, r.err)
  const a = JSON.parse(r.out)
  assert.equal(a.cwd, cwd)
  assert.equal(a.id, t.id)
  assert.match(r.err, new RegExp(`\\[kaizen\\] --latest resolved to session ${t.id}`))
})

test('13. --latest from a dir with no transcripts exits 1', () => {
  const { home } = cliWorld()
  const empty = path.join(home, 'work', 'empty')
  fs.mkdirSync(empty, { recursive: true })
  const real = fs.realpathSync(empty)
  const r = run(home, ['--latest'], real)
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), `no transcript found for cwd ${real}`)
})

test('14. the path guard', () => {
  const { home, t } = cliWorld()
  for (const p of [`${home}/../x.jsonl`, `${home}/x.json`]) {
    const r = run(home, [p])
    assert.equal(r.code, 1, p)
    assert.equal(r.err.trim(), 'path must be an absolute .jsonl file')
  }
  const missing = `${home}/missing.jsonl`
  const r = run(home, [missing])
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), `could not read transcript: ${missing}`)
  const ok = run(home, [t.file])
  assert.equal(ok.code, 0, ok.err)
  assert.equal(JSON.parse(ok.out).file, t.file)
})

test('15. the session id', () => {
  const { home, t } = cliWorld()
  for (const bad of ['bad/id', 'a b']) {
    const r = run(home, [bad])
    assert.equal(r.code, 1, bad)
    assert.equal(r.err.trim(), 'invalid session id')
  }
  const absent = run(home, ['nope'])
  assert.equal(absent.code, 1)
  assert.equal(absent.err.trim(), 'session not found: nope')
  const ok = run(home, [t.id])
  assert.equal(ok.code, 0, ok.err)
  assert.equal(JSON.parse(ok.out).id, t.id)
})

test('16. no argument prints the usage', () => {
  const { home } = cliWorld()
  const r = run(home, [])
  assert.equal(r.code, 1)
  assert.ok(r.err.startsWith('usage: node kaizen.mjs'), r.err)
})
