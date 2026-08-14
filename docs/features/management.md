---
docs-sync:
  sources:
    - server/lib/management.ts
    - server/lib/frontmatter.ts
    - client/src/components/management/
    - client/src/lib/managementEntries.ts
---

# Management tab

A read-only, three-pane browser for all Claude configuration on the machine:

- **Left — scope menu:** Global (`~/.claude`) plus every recently-active project.
- **Middle — item list:** skills, agents, commands, rules, hooks, memory (CLAUDE.md),
  settings, and installed plugins for the selected scope, grouped by type and
  filterable. Every item is tagged with its source: `user`, `project`, or
  `plugin:<name>` — installed plugins are fully expanded, so plugin-provided
  skills/hooks/agents/rules show up too.
- **Right — detail pane:** the selected item's metadata and file content (SKILL.md, hook
  script, settings.json, …).

Nothing is ever written.

## The security invariant

The file endpoint serves **only** paths the scanner itself enumerated — exact set
membership, never prefix or subtree checks. That construction is what keeps secrets
living under the same roots — `~/.claude/.credentials.json`, `history.jsonl`, project
`.env` — unservable. File bodies are capped at 256 KB (a `truncated` flag says when).
`~/.claude.json` (huge, private) is never read.

If you touch `server/lib/management.ts`, read
[.claude/rules/management.md](../../.claude/rules/management.md) first — the invariant
above is the one thing not to lose.

## No polling

Config changes over days, not seconds: the index is fetched when you open the tab (↻ to
refresh), project scopes and file bodies load lazily on click and are cached in memory.
Switching to Management also unmounts the sessions view, stopping its 3s poll.
