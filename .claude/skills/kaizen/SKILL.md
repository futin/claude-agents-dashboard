---
name: kaizen
description: Continuous-improvement loop over finished Claude Code sessions — total token usage across the whole session (incl. every subagent), which tools/subagents cost the most, an accuracy read, and concrete suggestions to work better next time. Appends one lesson to ~/.claude/session-analytics-log.md so patterns accumulate across all projects, and flags lessons recurring across 4+ projects for promotion to global config. Use when the user says "/kaizen" (or the legacy "/doctor"), "review this session", "how did that session do", "where did I waste tokens", or wants a retrospective on work just completed.
---

> **NOTE — vendored copy.** This is a copy of the personal global `kaizen` skill
> (`~/.claude/skills/kaizen/`), vendored into this repo so collaborators can populate the
> dashboard's Analytics tab. The log path + line format below (`~/.claude/session-analytics-log.md`)
> are a contract with the Analytics consumer — keep them in lockstep with
> `.claude/rules/analytics.md` and `server/lib/sessionAnalyticsLog.ts`. Never rename the log
> on one side only.

# Kaizen — session post-mortem + continuous-improvement loop

Turn a finished session's transcript into (1) real token usage, (2) the priciest
tools/subagents, (3) an honest accuracy read, (4) concrete improvements — then record one
lesson so patterns surface across sessions.

The numbers come from a deterministic analyzer bundled with this skill. **You do the
judgment.** Never invent figures; always read them from the analyzer.

## 1. Get the facts

Run the self-contained analyzer (pure Node, zero deps — works in any project, no repo or
server needed). It lives next to this skill; use the skill's own base directory:

- Inside the session / project you want to analyze: `node "$CLAUDE_SKILL_DIR/kaizen.mjs" --latest`
- A specific past session: `node "$CLAUDE_SKILL_DIR/kaizen.mjs" <session-id>` (UUID in `~/.claude/projects/*/`)
- A transcript by path: `node "$CLAUDE_SKILL_DIR/kaizen.mjs" /abs/path/to/x.jsonl`

`$CLAUDE_SKILL_DIR` = this skill's base directory (given to you when the skill loads, e.g.
`~/.claude/skills/kaizen`). Substitute the real absolute path. `--latest` picks the newest
transcript whose recorded cwd matches the current directory and prints the chosen session id
to stderr — report it, since two sessions in one cwd are indistinguishable. Output is a
`SessionAnalysis` JSON.

## 2. Read tokens honestly

- **Lead with `totals.billableApprox`** (input + output + cacheCreation). This tracks real
  cost. `totals.combined` is larger because it adds `cacheRead` — the cached prompt replayed
  each turn, billed at ~10%. Mention `combined` only as a context-pressure signal, never as
  "what this cost". The `notes[]` array restates these caveats — respect them.
- **Whole-session total ≈ `totals.combined` + `subagentTotals.tokens`.** Subagent tokens are
  exact and tracked separately (they don't appear in `totals`). Call out the split.
- Flag the bloated turn: `perTurn.maxTurnIndex` / `maxCombined` vs `avgCombined`. A single
  turn far above average usually means context was left to grow (big files re-read, no
  `/clear`, giant tool outputs).

## 3. Find where the tokens/time went

- `byTool` is sorted priciest-first by `approxOutputTokens`. **This is approximate** — an even
  split of each turn's output tokens across its tool calls; the transcript has no per-tool
  token field. Say "approx" when you cite it. `count`, `errors`, and `durationMs` (wall time,
  includes model latency) ARE exact — lean on those for firm claims.
- `bySubagent` has exact per-subagent `tokens` / `toolUses` / `durationMs`. Name the priciest
  subagents and whether the work justified the spend.

## 4. Accuracy read (explicitly subjective)

There is no ground truth on disk, so label this a judgment. Use `errorSignals`:
`toolErrors` (failed tool calls), `retries` (a tool re-run after it errored — rework), and
`userCorrections` (a **noisy keyword lower bound**, not a score). Combine with your own read
of whether the session met its stated goal, stalled, or thrashed. Give a short, hedged verdict
— not a fake percentage.

## 5. Concrete improvements

Tie each suggestion to evidence above. Examples: high `cacheRead` + a bloated turn → suggest
`/clear` between tasks or smaller reads; many `retries` on one tool → the specific fix;
repeated manual work a skill would cover → name the skill to **use, add, or install**
(check installed skills first). Keep it to a few high-signal actions, not a checklist.

## 6. Append one lesson (the learning loop)

Read the last ~20 lines of `~/.claude/session-analytics-log.md` (create the file if absent) so you can
reference accumulating patterns and avoid repeating a lesson. Then append **one** dated line,
tagged with the project so cross-project entries stay distinguishable:

```
- 2026-07-12 [<project>] <session-id>: <billableApprox> billable (<combined> ctx), top cost <tool/subagent>. Lesson: <one concrete takeaway>.
```

Keep it a single line — this file is meant to be skimmed and grepped over time. External
consumers parse this **exact path** (e.g. the claude-agents-dashboard Analytics tab reads
`~/.claude/session-analytics-log.md`), so the producer here and every consumer must move in
lockstep — never rename the file on one side only. The log is
**global** (`~/.claude`): one place accumulating lessons across every project, matching this
skill's global scope. That's the learning loop — most habits (verbose subagents, context
bloat) recur regardless of which project you're in.

### Cross-project pattern watch (always run this)

Before you finish, scan the **whole** log for the current lesson recurring across projects —
it's the aggregation layer, so use it, not five scattered CLAUDE.md files. Count **distinct
`[<project>]` tags** whose lessons express the same underlying habit (semantic match, not
exact string — "verbose subagents", "terse subagent output", "subagent prose bloat" are one
pattern). The just-appended line counts.

- **< 4 distinct projects** — stays project-scoped. Note the running count to the user if it's
  climbing (e.g. "this is the 2nd project with this lesson"), but do nothing else.
- **≥ 4 distinct projects** — the pattern is cross-cutting, not a per-project quirk. Flag it
  for **promotion to global** in step 7 (see the promotion option). Don't promote silently —
  it's the user's call.

## Present it

Short and skimmable: a token headline (billable, whole-session incl. subagents), the top
2–3 cost sinks, the accuracy read, the improvements, then confirm the logged lesson. Caveman
mode if active. Do not dump the raw JSON unless asked.

## 7. Offer to apply the improvements

After presenting, don't leave the suggestions as advice — offer to make them stick. Split
the improvements into **codifiable** (a durable rule that changes future sessions, e.g.
"subagents return terse findings") vs **habit** (a live discipline no config can enforce,
e.g. `/clear` between phases). Habits: just name them, nothing to apply.

**Default persistence is the project, not global.** A lesson from one session is a weak
signal — it may be a per-project quirk. Keep it local until the cross-project watch (step 6)
proves it recurs. Global `~/.claude/CLAUDE.md` loads in *every* session of *every* project, so
its input-token cost is paid always — reserve it for patterns earned by evidence, not one data
point.

For the codifiable ones, use **AskUserQuestion** to ask how to persist them. Offer these
options (recommend "Add to project CLAUDE.md" first):

- **Add to project CLAUDE.md** — one line in the project's `.claude/CLAUDE.md` conventions
  (or root `CLAUDE.md`). Applies every session in this repo; checked into git and shared with
  teammates. **This is the default home for a new lesson.**
- **Save as memory** — a `feedback`-type memory under the project's memory dir + a MEMORY.md
  index line. Use when there's no repo to commit to, or the lesson is about the user's own
  habits rather than the project.
- **Both** — CLAUDE.md for this repo + team, memory as a personal echo.
- **Nothing** — leave config alone; the user steers it live.

Then act on the answer: make the CLAUDE.md edit and/or write the memory (follow the memory
format — frontmatter + **Why:** / **How to apply:**), and reference `~/.claude/session-analytics-log.md`
so the reasoning stays traceable. If several suggestions are codifiable, one multi-select
question covering them is fine — don't ask a separate question per suggestion.

### Promotion to global (only when step 6 flagged ≥ 4 projects)

If the cross-project watch found the pattern in **4 or more distinct projects**, raise it — do
not act silently. Tell the user the count and which projects, then use **AskUserQuestion** to
offer promotion:

- **Promote to global CLAUDE.md (Recommended)** — add the one-line rule to `~/.claude/CLAUDE.md`
  so it binds in every project. Optionally strip the now-redundant per-project copies.
- **Keep project-scoped** — leave it as-is; the user isn't convinced it's universal yet.

Only on explicit yes: edit `~/.claude/CLAUDE.md` (create if absent), add the rule under a
conventions/learnings section, and note in the log line or the edit that it was promoted after
recurring across N projects, so the trail stays traceable.
