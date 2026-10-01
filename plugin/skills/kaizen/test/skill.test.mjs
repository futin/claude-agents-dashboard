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

test('the vendored-copy note is gone and the Analytics log contract stays', () => {
  const text = skill()
  assert.ok(!/vendored/i.test(text), 'no vendored-copy note')
  for (const ref of ['~/.claude/session-analytics-log.md', 'docs/subsystems/analytics.md', 'server/lib/sessionAnalyticsLog.ts']) {
    assert.ok(text.includes(ref), `SKILL.md names the contract's other side: ${ref}`)
  }
})
