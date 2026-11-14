// Tests for `kaizen.mjs --skill`: which sessions count as runs of a skill (the first real prompt invokes it), newest-N by mtime with live sessions left
// out, and each row's token split, preload breakdown, error groups, output sinks and outcome capture, plus the cohort summary over them. Each world is a
// synthetic projects root of tiny transcripts; the CLI cases spawn the file with HOME pointed at that root's parent, since projectsRoot() reads os.homedir().
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { reviewSkill } from '../kaizen.mjs'

const KAIZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../kaizen.mjs')
const NOW = Date.parse('2026-11-14T12:00:00Z')
const HOUR = 3600_000

const dirs = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-skill-'))
  dirs.push(home)
  const root = path.join(home, '.claude', 'projects')
  fs.mkdirSync(root, { recursive: true })
  return { home, root }
}

let seq = 0

/**
 * A transcript builder. Records get consecutive timestamps one second apart from `start`; `write()` puts the file under the cwd's project dir and sets
 * its mtime `ageMs` before NOW, so selection order is under the test's control.
 */
function tx(root, { cwd = '/w/proj', start = '2026-11-10T10:00:00Z' } = {}) {
  const id = `s${String(seq++).padStart(4, '0')}`
  const recs = []
  let n = 0
  const t0 = Date.parse(start)
  const ts = () => new Date(t0 + 1000 * n++).toISOString()
  const b = {
    id,
    prompt(content, extra = {}) { recs.push({ type: 'user', cwd, timestamp: ts(), message: { role: 'user', content }, ...extra }); return b },
    meta(content) { return b.prompt(content, { isMeta: true }) },
    attach(attachment) { recs.push({ type: 'attachment', cwd, timestamp: ts(), attachment }); return b },
    /** One assistant turn: optional text, optional tool calls `[name, input, resultText, isError]`, each followed by its result record. */
    turn({ id: mid = `msg_${id}_${n}`, usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, text, tools = [], model = 'claude-x', copies = 1 } = {}) {
      const content = []
      if (text) content.push({ type: 'text', text })
      const calls = tools.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${id}_${n}_${i}`, name, input }))
      content.push(...calls)
      const at = ts()
      for (let c = 0; c < copies; c++) recs.push({ type: 'assistant', cwd, timestamp: at, message: { id: mid, role: 'assistant', model, content, usage } })
      tools.forEach(([, , out = 'ok', err = false], i) => {
        recs.push({ type: 'user', cwd, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls[i].id, content: out, is_error: err }] } })
      })
      return b
    },
    write(ageMs = 2 * HOUR) {
      const dir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${id}.jsonl`)
      fs.writeFileSync(file, recs.map(r => JSON.stringify(r)).join('\n') + '\n')
      const m = new Date(NOW - ageMs)
      fs.utimesSync(file, m, m)
      return id
    }
  }
  return b
}

/** One subagent transcript under `<session>/subagents/` — only its usage matters here. */
function subagent(root, cwd, sessionId, usages) {
  const dir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'), sessionId, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const lines = usages.map((u, i) => JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: `sub_${i}`, role: 'assistant', model: 'claude-sub', content: [], usage: u } }))
  fs.writeFileSync(path.join(dir, `agent-a${seq++}.jsonl`), lines.join('\n') + '\n')
}

const cmd = (name, args = '') => `<command-message>${name.replace(/^\//, '')}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`
const review = (root, skill, opts = {}) => reviewSkill({ root, skill, now: NOW, ...opts })

test('a session counts only when its first real prompt invokes the skill, in any of the three spellings', () => {
  const { root } = world()
  const tagged = tx(root).prompt(cmd('/plug:tick', 'groom')).turn().write(1 * HOUR)
  const plain = tx(root).prompt('/tick --dry').turn().write(2 * HOUR)
  const plainPlugin = tx(root).prompt([{ type: 'text', text: '/plug:tick' }]).turn().write(3 * HOUR)
  // A meta record (the local-command caveat) before the prompt is not the prompt.
  const afterMeta = tx(root).meta('<local-command-caveat>Caveat</local-command-caveat>').prompt(cmd('/plug:tick')).turn().write(4 * HOUR)
  tx(root).prompt('please look at x').turn().prompt(cmd('/plug:tick')).turn().write(5 * HOUR)
  tx(root).prompt(cmd('/plug:ticker')).turn().write(6 * HOUR)
  tx(root).prompt('/other:tick-tock').turn().write(7 * HOUR)
  tx(root).prompt('run /plug:tick for me').turn().write(8 * HOUR)
  // The mirror: a meta record that reads like the command is not the prompt either.
  tx(root).meta('/plug:tick').prompt('/other').turn().write(8.5 * HOUR)

  const r = review(root, 'plug:tick')
  assert.deepEqual(r.sessions.map(s => s.id), [tagged, plain, plainPlugin, afterMeta])
  assert.equal(r.sessions[0].args, 'groom')
  assert.equal(r.sessions[1].args, '--dry')
  // The bare name matches any plugin's skill of that name; a different plugin prefix does not match a qualified ask.
  const other = tx(root).prompt(cmd('/zzz:tick')).turn().write(9 * HOUR)
  assert.ok(!review(root, 'plug:tick').sessions.some(s => s.id === other))
  assert.ok(review(root, 'tick').sessions.some(s => s.id === other))
})

test('newest N by mtime; a transcript written in the last five minutes is still live and left out, and counted', () => {
  const { root } = world()
  const ids = [3, 1, 4, 2].map(h => [h, tx(root).prompt('/tick').turn().write(h * HOUR)])
  tx(root).prompt('/tick').turn().write(60_000)
  const r = review(root, 'tick', { limit: 2 })
  assert.deepEqual(r.sessions.map(s => s.id), [ids[1][1], ids[3][1]])
  assert.equal(r.skippedActive, 1)
  assert.equal(r.limit, 2)
})

test('tokens split main vs subagents by kind; a turn written as several records is counted once', () => {
  const { root } = world()
  const b = tx(root).prompt('/tick')
    .turn({ usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }, copies: 3 })
    .turn({ usage: { input_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 1100, output_tokens: 7 }, model: 'claude-y' })
  const id = b.write()
  subagent(root, '/w/proj', id, [{ input_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 300, output_tokens: 4 }])
  subagent(root, '/w/proj', id, [{ input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 50, output_tokens: 6 }])
  const [s] = review(root, 'tick').sessions
  assert.deepEqual(s.tokens.main, { input: 11, cacheCreation: 120, cacheRead: 2100, output: 12, billableApprox: 143, combined: 2243 })
  assert.deepEqual(s.tokens.subagents, { count: 2, input: 5, cacheCreation: 30, cacheRead: 350, output: 10, billableApprox: 45, combined: 395 })
  assert.equal(s.tokens.billableApprox, 188)
  assert.equal(s.tokens.combined, 2638)
  assert.equal(s.turns, 2)
  assert.deepEqual(s.models.sort(), ['claude-x', 'claude-y'])
  assert.equal(s.project, 'proj')
})

test('first-turn context and the preload records before it, by kind, hooks keyed by hook name', () => {
  const { root } = world()
  const id = tx(root)
    .attach({ type: 'hook_additional_context', hookName: 'SessionStart', content: 'x'.repeat(400) })
    .attach({ type: 'hook_success', hookName: 'SessionStart:startup', content: '', stdout: 'y'.repeat(4000) })
    .prompt(cmd('/tick'))
    .meta([{ type: 'text', text: 'Base directory for this skill: ' + 'z'.repeat(769) }])
    .attach({ type: 'skill_listing', content: 's'.repeat(2000), names: ['a', 'b'] })
    .attach({ type: 'agent_listing_delta', addedTypes: ['t'], addedLines: ['l'.repeat(800)] })
    .attach({ type: 'instructions', files: [{ path: '/p/CLAUDE.md', type: 'Project', content: 'c'.repeat(1200) }, { path: '/q', type: 'User', content: 'c'.repeat(400) }] })
    .attach({ type: 'hook_additional_context', hookName: 'UserPromptSubmit', content: 'u'.repeat(40) })
    .turn({ usage: { input_tokens: 2, cache_creation_input_tokens: 9000, cache_read_input_tokens: 40000, output_tokens: 50 }, tools: [['Bash', { command: 'ls' }]] })
    .attach({ type: 'skill_listing', content: 's'.repeat(8000) })
    .turn()
    .write()
  const [s] = review(root, 'tick').sessions
  assert.equal(s.id, id)
  assert.equal(s.firstTurnCtx, 49002)
  const byKind = Object.fromEntries(s.preload.map(p => [p.kind, p.approxTokens]))
  assert.deepEqual(byKind, {
    'hook_additional_context:SessionStart': 100,
    'hook_success:SessionStart:startup': 0,
    skill_body: 200,
    skill_listing: 500,
    agent_listing_delta: 200,
    instructions: 400,
    'hook_additional_context:UserPromptSubmit': 10
  })
  // Largest first.
  assert.equal(s.preload[0].kind, 'skill_listing')
})

test('user prompts count only what a person typed; more than one marks the session as human-continued', () => {
  const { root } = world()
  tx(root).prompt('/tick')
    .turn({ tools: [['Bash', { command: 'x' }]] })
    .prompt('<task-notification><task-id>a1</task-id><status>completed</status></task-notification>')
    .turn()
    .write(1 * HOUR)
  tx(root).prompt('/tick').turn().prompt('no, do it the other way').turn().meta('<system-reminder>r</system-reminder>').write(2 * HOUR)
  const r = review(root, 'tick')
  assert.deepEqual(r.sessions.map(s => [s.userPrompts, s.humanContinued]), [[1, false], [2, true]])
  assert.equal(r.summary.humanContinued, 1)
})

test('errors group by tool and message prefix with digits and hex folded, with counts and example sessions', () => {
  const { root } = world()
  const a = tx(root).prompt('/tick')
    .turn({ tools: [['Bash', { command: 'x' }, 'Exit code 1\n(eval):1: no matches found: ======', true]] })
    .turn({ tools: [['Read', { file_path: '/a' }, '<tool_use_error>File does not exist. Note: cwd is /w/proj.</tool_use_error>', false]] })
    .write(1 * HOUR)
  const b = tx(root).prompt('/tick')
    .turn({ tools: [['Bash', { command: 'y' }, 'Exit code 2\n(eval):17: no matches found: ======', true]] })
    .turn({ tools: [['Bash', { command: 'z' }, 'Exit code 1\ncommit deadbeef12 rejected', true]] })
    .turn({ tools: [['Bash', { command: 'z' }, 'fine', false]] })
    .write(2 * HOUR)
  const r = review(root, 'tick')
  const rows = r.summary.errors.map(e => [e.tool, e.message, e.count, e.sessions, e.examples])
  assert.deepEqual(rows, [
    ['Bash', 'Exit code N (eval):N: no matches found: ======', 2, 2, [a, b]],
    ['Bash', 'Exit code N commit N rejected', 1, 1, [b]],
    ['Read', 'File does not exist. Note: cwd is /w/proj.', 1, 1, [a]]
  ])
  assert.deepEqual(r.sessions.map(s => s.errors), [2, 2])
})

test('output sinks: Read keyed by file basename, Skill by skill name, the rest by tool', () => {
  const { root } = world()
  tx(root).prompt('/tick')
    .turn({ tools: [['Read', { file_path: '/x/y/SKILL.md' }, 'r'.repeat(400)], ['Read', { file_path: '/z/SKILL.md' }, 'r'.repeat(400)]] })
    .turn({ tools: [['Skill', { skill: 'plug:groom' }, 'k'.repeat(800)], ['Bash', { command: 'a' }, 'b'.repeat(40)]] })
    .write()
  const r = review(root, 'tick')
  assert.deepEqual(r.summary.sinks.map(s => [s.key, s.calls, s.approxTokens]), [['Read:SKILL.md', 2, 200], ['Skill:plug:groom', 1, 200], ['Bash', 1, 10]])
  assert.deepEqual(r.sessions[0].toolCalls, { Read: 2, Skill: 1, Bash: 1 })
})

test('an outcome regex captures its first group from the first tool result or assistant text that matches; summary counts and medians by outcome', () => {
  const { root } = world()
  const decide = (v) => `{"verdict": "${v}", "id": 3}`
  const big = { input_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 0 }
  tx(root).prompt('/tick').turn({ tools: [['Bash', { command: 'decide' }, decide('idle')]] }).turn({ text: '"verdict": "groom" said nothing' }).write(1 * HOUR)
  tx(root).prompt('/tick').turn({ usage: big, tools: [['Bash', { command: 'decide' }, decide('execute')]] }).write(2 * HOUR)
  tx(root).prompt('/tick').turn({ text: 'verdict was "verdict":"idle"' }).write(3 * HOUR)
  tx(root).prompt('/tick').turn({ text: 'crashed early' }).write(4 * HOUR)
  const r = review(root, 'tick', { outcome: '"verdict":\\s*"(\\w+)"' })
  assert.deepEqual(r.sessions.map(s => s.outcome), ['idle', 'execute', 'idle', null])
  assert.deepEqual(r.summary.outcomes, { idle: 2, execute: 1, '(none)': 1 })
  assert.equal(r.summary.byOutcome.execute.medianBillable, 1000)
  assert.equal(r.summary.byOutcome.idle.sessions, 2)
})

test('summary: counts, date range, projects, token sums and medians', () => {
  const { root } = world()
  const u = (cc) => ({ input_tokens: 0, cache_creation_input_tokens: cc, cache_read_input_tokens: 0, output_tokens: 0 })
  tx(root, { cwd: '/w/a', start: '2026-11-01T10:00:00Z' }).prompt('/tick').turn({ usage: u(100) }).write(1 * HOUR)
  tx(root, { cwd: '/w/b', start: '2026-11-03T10:00:00Z' }).prompt('/tick').turn({ usage: u(300) }).turn({ usage: u(10) }).write(2 * HOUR)
  tx(root, { cwd: '/w/a', start: '2026-11-02T10:00:00Z' }).prompt('/tick').turn({ usage: u(200) }).write(3 * HOUR)
  const { summary } = review(root, 'tick')
  assert.equal(summary.sessions, 3)
  assert.equal(summary.firstStartedAt, '2026-11-01T10:00:00.000Z')
  assert.equal(summary.lastStartedAt, '2026-11-03T10:00:00.000Z')
  assert.deepEqual(summary.projects, { a: 2, b: 1 })
  assert.equal(summary.tokens.main.cacheCreation, 610)
  assert.equal(summary.tokens.billableApprox, 610)
  assert.equal(summary.median.billableApprox, 200)
  assert.equal(summary.median.firstTurnCtx, 200)
  assert.equal(summary.median.turns, 1)
})

test('no matching session is an empty result, not an error', () => {
  const { root } = world()
  tx(root).prompt('/other').turn().write()
  const r = review(root, 'tick')
  assert.equal(r.sessions.length, 0)
  assert.equal(r.summary.sessions, 0)
})

const cli = (home, args) => spawnSync(process.execPath, [KAIZEN, '--skill', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })

test('CLI: prints the review as JSON, N and --outcome honoured', () => {
  const { home, root } = world()
  for (let h = 1; h <= 3; h++) tx(root).prompt('/plug:tick').turn({ text: 'verdict=idle' }).write(h * HOUR)
  const r = cli(home, ['plug:tick', '2', '--outcome', 'verdict=(\\w+)'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.skill, 'plug:tick')
  assert.equal(out.sessions.length, 2)
  assert.deepEqual(out.summary.outcomes, { idle: 2 })
})

test('CLI: a bad name, N or regex is a usage error with nothing on stdout', () => {
  const { home } = world()
  for (const args of [[], ['bad name'], ['tick', '0'], ['tick', 'x'], ['tick', '5', '--outcome', '('], ['tick', '--outcome']]) {
    const r = cli(home, args)
    assert.notEqual(r.status, 0, args.join(' '))
    assert.equal(r.stdout, '', args.join(' '))
    assert.ok(r.stderr.length > 0, args.join(' '))
  }
})
