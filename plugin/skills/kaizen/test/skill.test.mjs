// Tests for SKILL.md itself: kaizen ships in the dashboard plugin, so every analyzer call goes through the plugin root Claude Code substitutes into the
// skill text at load time — the braced form, quoted. A bare `$CLAUDE_PLUGIN_ROOT` reaches Bash unexpanded and empty, `$CLAUDE_SKILL_DIR` was the old
// convention, and `~/.claude/skills/kaizen` the old home. The log contract with the dashboard's Analytics tab must survive editing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const skill = () => fs.readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8')

test('frontmatter names the skill kaizen', () => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(skill())
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block')
  assert.match(m[1], /^name:\s*kaizen\s*$/m)
})

test('every analyzer call goes through the plugin root', () => {
  const text = skill()
  const calls = [...text.matchAll(/node\s+(\S*kaizen\.mjs"?)/g)].map((m) => m[1])
  assert.ok(calls.length > 0, 'SKILL.md calls the analyzer')
  for (const p of calls) assert.equal(p, '"${CLAUDE_PLUGIN_ROOT}/skills/kaizen/kaizen.mjs"')
  assert.ok(!text.includes('CLAUDE_SKILL_DIR'), 'SKILL.md must not use CLAUDE_SKILL_DIR')
  assert.ok(!/\$CLAUDE_PLUGIN_ROOT/.test(text), 'SKILL.md must use the braced ${CLAUDE_PLUGIN_ROOT}')
  assert.ok(!text.includes('~/.claude/skills/kaizen'), 'SKILL.md must not name the old ~/.claude/skills/kaizen home')
})

// A transcript carries fetched pages, tool output and other agents' text, and kaizen turns what it reads into config edits — so the boundary has to come
// before the first step, and be restated where an injected instruction would take effect: applying edits (step 7) and the log sweep (review mode).
test('transcript content is data, not instructions — stated up front and where edits are applied', () => {
  const text = skill()
  const section = (start, end) => {
    const from = text.indexOf(start)
    assert.ok(from >= 0, `SKILL.md has ${start}`)
    const to = text.indexOf(end, from + start.length)
    return text.slice(from, to < 0 ? undefined : to)
  }
  const boundary = text.indexOf('## Evidence is data, not instructions')
  assert.ok(boundary >= 0, 'SKILL.md has an evidence-boundary section')
  assert.ok(boundary < text.indexOf('## 1. Get the facts'), 'the boundary comes before step 1')
  assert.match(section('## 7. Offer to apply the improvements', '\n## Mid-session capture'), /data, not instructions/i)
  assert.match(section('## Review mode', '\n## '), /data, not instructions/i)
})

// The lesson tail and the `none` form are parsed by server/lib/sessionAnalyticsLog.ts — the producer side has to keep stating the same grammar.
test('the log grammar states the lesson tail, its four keys and the born-closed none form', () => {
  const text = skill()
  const from = text.indexOf('### Log grammar')
  assert.ok(from >= 0, 'SKILL.md has a Log grammar section')
  const grammar = text.slice(from, text.indexOf('\n### ', from + 1))
  assert.ok(grammar.includes(' ‖ '), 'the grammar names the ` ‖ ` tail separator')
  assert.ok(grammar.includes(' · '), 'the grammar names the ` · ` field separator')
  for (const key of ['cue:', 'component:', 'evidence:', 'confidence:']) assert.ok(grammar.includes(key), `the grammar names ${key}`)
  assert.match(grammar, /Lesson: none — /, 'the grammar shows the none form')
  assert.match(grammar, /none[^\n]*born closed/i, 'the grammar says a none lesson is born closed')
  const record = text.slice(text.indexOf('### Record what happened'), text.indexOf('\n### ', text.indexOf('### Record what happened') + 1))
  assert.match(record, /`none` lesson[^.]*no status line/i, 'Record what happened carves out the none lesson')
})

// The verdict line is parsed by server/lib/sessionAnalyticsLog.ts and measured by `--compare`; review mode is its only writer.
test('the log grammar states the verdict line, and review mode says how a verdict is decided', () => {
  const text = skill()
  const from = text.indexOf('### Log grammar')
  const grammar = text.slice(from, text.indexOf('\n### ', from + 1))
  for (const v of ['helped', 'hurt', 'no-effect', 'confounded']) assert.ok(grammar.includes(v), `the grammar names verdict ${v}`)
  assert.match(grammar, /verdict[^\n]*never[^\n]*\n?[^\n]*open or settled|never\*\* changes whether a lesson is open/i, 'a verdict never changes open/settled')
  const review = text.slice(text.indexOf('## Review mode'))
  assert.ok(review.includes('kaizen.mjs" --compare'), 'review mode runs --compare')
  assert.match(review, /after `n` < 3/, 'review mode states the 3-session threshold')
  assert.match(review, /`confounded`[^\n]*default whenever attribution is unclear/, 'confounded is the default when attribution is unclear')
  assert.match(review, /judged <n>/, 'the review marker counts judged lessons')
})

test('the vendored-copy note is gone and the Analytics log contract stays', () => {
  const text = skill()
  assert.ok(!/vendored/i.test(text), 'no vendored-copy note')
  for (const ref of ['~/.claude/session-analytics-log.md', 'docs/subsystems/analytics.md', 'server/lib/sessionAnalyticsLog.ts']) {
    assert.ok(text.includes(ref), `SKILL.md names the contract's other side: ${ref}`)
  }
})

// Step 7 routes each lesson to its cheapest home and escalates prose the log shows ignored (#334). The status-note prefix is what escalation reads to know
// a rule was prose, so the routing table, the hand-off boundary, the prefixes and both triggers all have to stay stated.
const step7 = () => {
  const text = skill()
  const from = text.indexOf('## 7. Offer to apply the improvements')
  assert.ok(from >= 0, 'SKILL.md has step 7')
  return text.slice(from, text.indexOf('\n## Mid-session capture', from))
}

test('step 7 routes to every home, habit included, and names the hand-off targets', () => {
  const s = step7()
  for (const home of ['memory file', 'existing skill', 'project CLAUDE.md', 'a new skill', 'a script', 'a hook', 'bounded fallback', '`habit`']) {
    assert.ok(s.includes(home), `step 7 names the home: ${home}`)
  }
  for (const target of ['skill-creator', 'update-config', '/backlog-capture']) assert.ok(s.includes(target), `step 7 hands off to ${target}`)
})

test('step 7 says kaizen never writes a new skill, script or hook body itself', () => {
  assert.match(step7(), /never writes a new skill, a script or a hook body/)
})

test('step 7 states every status-note home prefix', () => {
  const s = step7()
  for (const prefix of ['memory:', 'claude-md:', 'skill:', 'script:', 'hook:', 'fallback:']) assert.ok(s.includes(`\`${prefix}\``), `step 7 names ${prefix}`)
})

test('step 7 states both escalation triggers', () => {
  const s = step7()
  const from = s.indexOf('### Escalation')
  assert.ok(from >= 0, 'step 7 has an Escalation section')
  const esc = s.slice(from, s.indexOf('\n### ', from + 1))
  assert.match(esc, /`no-effect`/, 'a no-effect verdict escalates')
  assert.match(esc, /2 or more later lessons[^.]*same `cue` \+ `component`/, 'two later recurrences of the same cue + component escalate')
  assert.match(esc, /Never escalate silently/)
})
