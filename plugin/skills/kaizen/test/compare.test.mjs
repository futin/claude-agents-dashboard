// Tests for `kaizen.mjs --compare`: which of a project's sessions land before and after a date, the cap, the median, and that a session where the
// field path resolves to nothing is counted as missing rather than as 0. Each world is a synthetic projects root of tiny transcripts; the CLI cases
// spawn the file with HOME pointed at that root's parent, since projectsRoot() reads os.homedir().
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSessions } from '../kaizen.mjs'

const KAIZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../kaizen.mjs')

const dirs = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

/** A fresh home with an empty `.claude/projects`; returns both paths. */
function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-compare-'))
  dirs.push(home)
  const root = path.join(home, '.claude', 'projects')
  fs.mkdirSync(root, { recursive: true })
  return { home, root }
}

let seq = 0

/**
 * Write one main-session transcript for `cwd` starting at `iso`, with `retries` Bash retries (each an errored call followed by another call of the
 * same tool). `bash: false` writes a session with no Bash call at all, so `byTool.Bash.count` resolves to nothing.
 */
function session(root, cwd, iso, retries, { bash = true } = {}) {
  const dir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  const id = `s${String(seq++).padStart(4, '0')}`
  const t0 = Date.parse(iso)
  let n = 0
  const ts = () => new Date(t0 + 1000 * n++).toISOString()
  const recs = [{ type: 'user', cwd, timestamp: ts(), message: { role: 'user', content: 'go' } }]
  const call = (name, err) => {
    const tid = `t${seq}_${n}`
    recs.push({ type: 'assistant', cwd, timestamp: ts(), message: { id: `msg_${tid}`, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: tid, name, input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } })
    recs.push({ type: 'user', cwd, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'r', is_error: err }] } })
  }
  const tool = bash ? 'Bash' : 'Read'
  for (let i = 0; i < retries; i++) call(tool, true)
  call(tool, false)
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n')
  return id
}

const day = (d, h = 12) => `2026-${d}T${String(h).padStart(2, '0')}:00:00Z`

test('before/after medians over one project; other projects in the same root are excluded, a same-suffix one too', () => {
  const { root } = world()
  ;[5, 4, 6, 4].forEach((r, i) => session(root, '/w/proj', day(`09-2${i + 1}`), r))
  ;[1, 0, 2, 1].forEach((r, i) => session(root, '/w/proj', day(`10-0${i + 2}`), r))
  ;[9, 9, 9, 9].forEach((r, i) => session(root, '/w/other', day(`10-0${i + 2}`), r))
  ;[9, 9].forEach((r, i) => session(root, '/w/other', day(`09-2${i + 1}`), r))
  // `my-proj`'s dir name ends in `-proj` too, so only the cwd basename tells it apart.
  ;[9, 9].forEach((r, i) => session(root, '/w/my-proj', day(`10-0${i + 2}`, 6), r))
  const c = compareSessions({ root, project: 'proj', since: '2026-10-01', fieldPath: 'errorSignals.retries' })
  assert.equal(c.before.n, 4)
  assert.equal(c.before.median, 4.5)
  assert.equal(c.after.n, 4)
  assert.equal(c.after.median, 1)
  assert.deepEqual(c.after.values.map(v => v.value), [1, 0, 2, 1])
  assert.deepEqual(c.after.values.map(v => v.date), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
})

test('a session where the path resolves to nothing is missing, not 0, and stays out of the median', () => {
  const { root } = world()
  ;[2, 2, 2].forEach((r, i) => session(root, '/w/proj', day(`09-2${i + 1}`), r))
  session(root, '/w/proj', day('10-02'), 3)
  const none = session(root, '/w/proj', day('10-03'), 0, { bash: false })
  session(root, '/w/proj', day('10-04'), 5)
  const c = compareSessions({ root, project: 'proj', since: '2026-10-01', fieldPath: 'byTool.Bash.count' })
  // count = retries + 1 calls: 4 and 6; a 0 counted in would drag the median to 4.
  assert.equal(c.after.n, 2)
  assert.equal(c.after.median, 5)
  assert.deepEqual(c.after.missing, [{ session: none, date: '2026-10-03' }])
})

test('twelve after-sessions: after takes the oldest ten, before the ten immediately preceding', () => {
  const { root } = world()
  for (let i = 0; i < 12; i++) session(root, '/w/proj', day(`09-${String(i + 1).padStart(2, '0')}`), 1)
  for (let i = 0; i < 12; i++) session(root, '/w/proj', day(`10-${String(i + 2).padStart(2, '0')}`), 0)
  const c = compareSessions({ root, project: 'proj', since: '2026-10-01', fieldPath: 'errorSignals.retries' })
  assert.equal(c.after.n, 10)
  assert.equal(c.after.values[0].date, '2026-10-02')
  assert.equal(c.after.values[9].date, '2026-10-11')
  assert.equal(c.before.n, 10)
  assert.equal(c.before.values[0].date, '2026-09-03')
  assert.equal(c.before.values[9].date, '2026-09-12')
})

test('a session starting on the since date itself counts as before, the next midnight as after', () => {
  const { root } = world()
  const onDay = session(root, '/w/proj', day('10-01', 23), 7)
  const midnight = session(root, '/w/proj', '2026-10-02T00:00:00Z', 1)
  const c = compareSessions({ root, project: 'proj', since: '2026-10-01', fieldPath: 'errorSignals.retries' })
  assert.deepEqual(c.before.values.map(v => v.session), [onDay])
  assert.deepEqual(c.after.values.map(v => v.session), [midnight])
})

const cli = (home, args) => spawnSync(process.execPath, [KAIZEN, '--compare', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })

test('CLI: prints the comparison as JSON', () => {
  const { home, root } = world()
  ;[1, 1, 1].forEach((r, i) => session(root, '/w/proj', day(`09-2${i + 1}`), r))
  const r = cli(home, ['proj', '2026-10-01', 'errorSignals.retries'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.field, 'errorSignals.retries')
  assert.equal(out.before.n, 3)
  assert.equal(out.after.n, 0)
})

test('CLI: a field path that resolves in no session exits non-zero and names the path', () => {
  const { home, root } = world()
  ;[1, 1, 1].forEach((r, i) => session(root, '/w/proj', day(`09-2${i + 1}`), r))
  const r = cli(home, ['proj', '2026-10-01', 'errorSignals.nope'])
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /errorSignals\.nope/)
})

test('CLI: a bad date or missing arguments is a usage error with nothing on stdout', () => {
  const { home } = world()
  for (const args of [['proj', '2026-13-45', 'errorSignals.retries'], ['proj', '10/01/2026', 'errorSignals.retries'], ['proj', '2026-10-01'], []]) {
    const r = cli(home, args)
    assert.notEqual(r.status, 0, args.join(' '))
    assert.equal(r.stdout, '', args.join(' '))
    assert.ok(r.stderr.length > 0, args.join(' '))
  }
})
