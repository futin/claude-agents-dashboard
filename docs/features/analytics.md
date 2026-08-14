---
docs-sync:
  sources:
    - server/lib/analytics.ts
    - server/lib/analyze.ts
    - server/lib/sessionAnalyticsLog.ts
    - client/src/components/analytics/
    - .claude/skills/kaizen/
---

# Analytics tab

A post-mortem card for each of the last few sessions you've run the **`/kaizen`** skill
on. `/kaizen` is the sole producer: a session appears here only because `/kaizen`
appended a line for it to `~/.claude/session-analytics-log.md`. The dashboard never
writes that log — it only reads it.

## What a card shows

- **The numbers** — recomputed live from the transcript on every open: billable tokens
  (the real cost signal), total context tokens, subagent count + tokens, turn count,
  tool-error/retry counts, then the priciest tools and subagents.
- **Research & suggestions** — the one-line lesson `/kaizen` wrote for that session. The
  dashboard does no LLM calls and invents no advice; the qualitative judgment is entirely
  `/kaizen`'s.
- **Status badge** — `actioned` / `promoted` / `dropped` / `open`: did you ever act on
  the lesson? `/kaizen` records that by appending a `status` line to the same log; no
  line means still open.

When no `/kaizen review` sweep has happened in 7 days, the section bar shows a **review
due** chip — the nudge to sweep accumulated lessons, promote recurring ones, and prune
rules that stopped earning their keep.

## Workflow

Run `/kaizen` in a Claude Code session → it appends a lesson to
`~/.claude/session-analytics-log.md` → the session appears in the tab (↻ to pull it in).
If the transcript has since been deleted, the card still shows the logged lesson, just
without live numbers.

The `/kaizen` skill is **vendored** at `.claude/skills/kaizen/` so collaborators can
populate the tab against their own global log.

## Contract to keep

The log's line grammar (lesson / status / review lines) is a contract between the skill
and the parser — never change one side alone. Grammar, append-only rationale, and the
read-only invariant: [.claude/rules/analytics.md](../../.claude/rules/analytics.md).

Toggles: `SHOW_ANALYTICS=false` hides the tab, `ANALYTICS_KEEP=<n>` caps the list — see
[configuration](../architecture/configuration.md).
