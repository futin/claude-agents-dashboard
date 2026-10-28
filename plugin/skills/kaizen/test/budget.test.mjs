// Tests for `kaizen.mjs --budget`: the byte size of one CLAUDE.md section against a budget, and its top-level bullets ranked by size. Spawned, since the
// mode is a CLI over a file path; each fixture is a temp file.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KAIZEN = fileURLToPath(new URL('../kaizen.mjs', import.meta.url))
const dirs = []
const fixtureDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-budget-')); dirs.push(d); return d }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const run = (...args) => spawnSync(process.execPath, [KAIZEN, '--budget', ...args], { encoding: 'utf8' })
const budget = (text, ...rest) => {
  const file = path.join(fixtureDir(), 'CLAUDE.md')
  fs.writeFileSync(file, text)
  const r = run(file, ...rest)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const bytes = (s) => Buffer.byteLength(s, 'utf8')

test('the section runs from its heading through the line before the next same-level heading; rules are ranked largest first', () => {
  const section = '## Learnings\n\n- **A** aaa\n- **B** bbbbbbbbbb\n\n'
  const r = budget(`# T\n\n${section}## Conventions\n\n- c\n`)
  assert.equal(r.exists, true)
  assert.equal(r.section, true)
  assert.equal(r.bytes, bytes(section))
  assert.deepEqual(r.rules, [{ first: '**B** bbbbbbbbbb', bytes: bytes('- **B** bbbbbbbbbb\n') }, { first: '**A** aaa', bytes: bytes('- **A** aaa\n') }])
})

test('a deeper heading stays inside the section; the next ## or # ends it', () => {
  const section = '## Learnings\n\n- a\n\n### Sub\n\n- b\n\n'
  assert.equal(budget(`${section}## Next\n`).bytes, bytes(section))
  assert.equal(budget(`${section}# Top\n`).bytes, bytes(section))
})

test('the last section runs to EOF', () => {
  const section = '## Learnings\n\n- a\n  continued\n\n- b'
  const r = budget(`# T\n\n${section}`)
  assert.equal(r.bytes, bytes(section))
  assert.deepEqual(r.rules.map(x => x.bytes), [bytes('- a\n  continued\n'), bytes('- b')])
})

test('multi-byte text counts UTF-8 bytes, not characters', () => {
  const r = budget('## Learnings\n- —\n')
  assert.equal(r.rules[0].bytes, 6)
  assert.equal(r.bytes, bytes('## Learnings\n') + 6)
  assert.equal(budget('## Learnings\n- § ≥\n').rules[0].bytes, 1 + 1 + 2 + 1 + 3 + 1)
})

test('remaining and over against the budget', () => {
  const sized = (n) => { const head = '## Learnings\n- '; return head + 'x'.repeat(n - bytes(head) - 1) + '\n' }
  const under = budget(sized(3950), '## Learnings', '4000')
  assert.equal(under.bytes, 3950)
  assert.equal(under.remaining, 50)
  assert.equal(under.over, false)
  const overB = budget(sized(4010), '## Learnings', '4000')
  assert.equal(overB.remaining, -10)
  assert.equal(overB.over, true)
})

test('an absent file or an absent heading is zero bytes and exit 0', () => {
  const missing = run(path.join(fixtureDir(), 'nope.md'))
  assert.equal(missing.status, 0, missing.stderr)
  const m = JSON.parse(missing.stdout)
  assert.equal(m.exists, false)
  assert.equal(m.bytes, 0)
  assert.equal(m.budget, 4000)
  const h = budget('# T\n\n## Conventions\n\n- c\n')
  assert.equal(h.exists, true)
  assert.equal(h.section, false)
  assert.equal(h.bytes, 0)
})

test('a bad budget argument is a usage error with nothing on stdout', () => {
  for (const args of [['x', 'y', 'notanumber'], ['x', '## Learnings', 'notanumber'], ['x', '## Learnings', '0']]) {
    const r = run(...args)
    assert.notEqual(r.status, 0, args.join(' '))
    assert.match(r.stderr, /usage:.*--budget/)
    assert.equal(r.stdout, '')
  }
})
