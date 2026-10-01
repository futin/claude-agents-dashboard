// Tests for SKILL.md itself (Task 14): the frontmatter Claude Code reads to decide when the skill fires, that every engine call the procedure names
// is a real subcommand (and none is left out), and that the four hard rules survive editing word for word — they are what keeps the model from
// improvising around the engine, so a paraphrase is a regression.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUBCOMMANDS, rounds } from '../tools/git-sync.mjs'

const SKILL_PATH = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const skill = () => fs.readFileSync(SKILL_PATH, 'utf8')

// Just enough YAML for this file's own frontmatter: `key: value` lines, plus a folded `key: >` block whose indented lines join with single spaces
// (YAML's folding for plain prose). Anything fancier in the frontmatter would itself be a sign the file drifted from the house style.
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block')
  const out = {}
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(lines[i])
    if (!kv) continue
    if (kv[2] === '>') {
      const block = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      out[kv[1]] = block.join(' ')
    } else out[kv[1]] = kv[2]
  }
  return out
}

test('T14.1 frontmatter: name, trigger, and a description within 1024 bytes', () => {
  const fm = frontmatter(skill())
  assert.equal(fm.name, 'git-sync')
  assert.equal(fm.trigger, '/git-sync')
  assert.ok(fm.description && fm.description.length > 0, 'description is present')
  assert.ok(Buffer.byteLength(fm.description) <= 1024, `description is ${Buffer.byteLength(fm.description)} bytes`)
})

test('T14.2 every `git-sync.mjs <word>` names a subcommand, and every subcommand is named', () => {
  // The closing quote is optional: the plugin form is `node "${CLAUDE_PLUGIN_ROOT}/…/git-sync.mjs" <sub>`, quoted because the path is substituted.
  const named = [...skill().matchAll(/git-sync\.mjs"?\s+([A-Za-z-]+)/g)].map((m) => m[1])
  assert.ok(named.length > 0, 'SKILL.md calls the engine')
  for (const word of named) assert.ok(SUBCOMMANDS.includes(word), `${word} is not a subcommand`)
  for (const cmd of SUBCOMMANDS) assert.ok(named.includes(cmd), `${cmd} is never called`)
})

test('T14.3 the four hard rules appear verbatim', () => {
  const text = skill()
  for (const rule of [
    'Never work around a stop.',
    'The only git command you run yourself is git commit -F, in phase 1.',
    'Without AskUserQuestion, ask in prose, run verify and push-trunk, and skip plan and apply.',
    'Never kill a process by pattern.',
  ]) {
    assert.ok(text.includes(rule), `missing: ${rule}`)
  }
})

// A survey holding one candidate of every kind `rounds()` can ask about, so every fixed label the decision round can show is emitted at least once.
// Branch labels are the branch names themselves; everything else is a fixed label SKILL.md's answers table has to map.
function everyKindSurvey() {
  const rec = (name, fields) => ({ name, local: { sha: 'a'.repeat(40), date: 0, upstream: null, gone: false, ahead: 0 }, remote: null,
    bucket: 'active', proof: null, reason: 'recent', unpushed: null, worktree: null, openPr: null, ...fields })
  const branches = [
    rec('done', { bucket: 'merged', proof: 'M1', reason: 'merged', remote: { sha: 'a'.repeat(40), date: 0 } }),
    rec('old', { bucket: 'abandoned', reason: 'old' }),
    rec('solo', { unpushed: 'local-only' }),
    rec('kept', {}),
  ]
  const worktrees = [{ path: '/wt/kept', branch: 'kept', head: 'a'.repeat(40), dirty: 0, locked: false, prunable: false, inProgress: null }]
  const stashes = [{ sha: 'c'.repeat(40), base: 'main', files: 1, date: 0 }]
  return { trunk: 'main', downgraded: false, branches, worktrees, stashes, mergedSet: ['done'] }
}

test('T14.6 every fixed label the decision round emits is mapped in SKILL.md, and every question id prefix is named', () => {
  const s = everyKindSurvey()
  const r = rounds(s)
  const qs = r.rounds.flat().concat(r.followups.merged.flat())
  const names = new Set(s.branches.map((b) => b.name))
  const prefixes = new Set(qs.map((q) => q.id.split(':')[0]))
  assert.deepEqual([...prefixes].sort(), ['asked', 'merged', 'merged-pick', 'push', 'stash', 'worktree'], 'the fixture reaches every kind')
  const text = skill()
  for (const label of new Set(qs.flatMap((q) => q.options.map((o) => o.label)).filter((l) => !names.has(l)))) {
    assert.ok(text.includes(`\`${label}\``), `label not mapped in SKILL.md: ${label}`)
  }
  for (const prefix of prefixes) assert.ok(text.includes(`\`${prefix}`), `question id not named in SKILL.md: ${prefix}`)
})

test('T14.7 the state dir comes from preflight (R31) and exit 1 is split into usage vs engine failure (R33)', () => {
  const text = skill()
  assert.ok(!text.includes('gitdir:'), 'SKILL.md must not derive the state dir itself')
  assert.ok(!text.includes('.git/git-sync'), 'SKILL.md must not spell the state dir path')
  assert.ok(text.includes("preflight's `stateDir`"), "SKILL.md reads the state dir from preflight's payload")
  assert.ok(text.includes('`Usage:`'), 'SKILL.md tells a usage error apart by its stderr')
  assert.ok(text.includes('engine failure'), 'SKILL.md names the other exit 1 as an engine failure')
})

// R34: `report` has nothing of this run to read after `not-a-repo` (no repo) or `linked-worktree` (R32 writes nothing, so it would show the main
// tree's own run or nothing at all). Both rows must say to relay the envelope and not run `report`.
test('T14.8 not-a-repo and linked-worktree are relayed directly, never through report (R34)', () => {
  const rows = skill().split('\n').filter((l) => l.startsWith('|'))
  for (const stop of ['not-a-repo', 'linked-worktree']) {
    const row = rows.find((l) => l.startsWith(`| \`${stop}\` |`))
    assert.ok(row, `stop table has a ${stop} row`)
    assert.ok(row.includes('do not run `report`'), `${stop} row says not to run report: ${row}`)
  }
})

// The skill ships in the dashboard plugin, so every engine call goes through the plugin root Claude Code substitutes into the skill text at load time.
// The braced form is the one substituted; a bare `$CLAUDE_PLUGIN_ROOT` reaches Bash unexpanded and empty, and `~/.claude/skills/` is the old home.
test('T14.9 every engine call goes through the plugin root', () => {
  const text = skill()
  const calls = [...text.matchAll(/node\s+(\S*git-sync\.mjs"?)/g)].map((m) => m[1])
  assert.ok(calls.length > 0, 'SKILL.md calls the engine')
  for (const p of calls) assert.equal(p, '"${CLAUDE_PLUGIN_ROOT}/skills/git-sync/tools/git-sync.mjs"')
  assert.ok(!text.includes('~/.claude/skills/'), 'SKILL.md must not name the old ~/.claude/skills home')
  assert.ok(!/\$CLAUDE_PLUGIN_ROOT/.test(text), 'SKILL.md must use the braced ${CLAUDE_PLUGIN_ROOT}')
  assert.ok(!text.includes('CLAUDE_SKILL_DIR'), 'SKILL.md must not use CLAUDE_SKILL_DIR')
})
