---
name: kaizen
description: Continuous-improvement loop over finished Claude Code sessions — total token usage across the whole session (incl. every subagent), which tools/subagents cost the most, an accuracy read, and concrete suggestions to work better next time. Appends one lesson to ~/.claude/session-analytics-log.md so patterns accumulate across all projects, records what became of each lesson, and flags lessons recurring across 4+ projects for promotion to global config. Use when the user says "/kaizen" (or the legacy "/doctor"), "review this session", "how did that session do", "where did I waste tokens", or wants a retrospective on work just completed. Also use for "/kaizen review" (sweep the whole log: batch promote, prune stale rules), and to bank a lesson mid-session when the user corrects course or says "remember that", "bank that lesson", "note that for next time".
---

> **NOTE — vendored copy.** This is a copy of the personal global `kaizen` skill
> (`~/.claude/skills/kaizen/`), vendored into this repo so collaborators can populate the
> dashboard's Analytics tab. The log path + line grammar below
> (`~/.claude/session-analytics-log.md`) are a contract with the Analytics consumer — keep them
> in lockstep with `docs/subsystems/analytics.md` and `server/lib/sessionAnalyticsLog.ts`. Never
> rename the log or add a line shape on one side only. **Edits here don't take effect for the
> user until they're copied to `~/.claude/skills/kaizen/SKILL.md`** — the global copy is the one
> that actually runs.

# Kaizen — session post-mortem + continuous-improvement loop

Turn a finished session's transcript into (1) real token usage, (2) the priciest
tools/subagents, (3) an honest accuracy read, (4) concrete improvements — then record one
lesson so patterns surface across sessions.

The numbers come from a deterministic analyzer bundled with this skill. **You do the
judgment.** Never invent figures; always read them from the analyzer.

**Three modes.** Pick by what the user asked for:

| Trigger | Mode | Do |
|---|---|---|
| `/kaizen`, "review this session" | **post-mortem** (default) | steps 1–7 below |
| `/kaizen review`, "sweep the log", or the review-due prompt | **review** | jump to *Review mode* |
| a mid-session correction, "bank that lesson" | **capture** | jump to *Mid-session capture* — do NOT run the analyzer or interrupt the work |

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

### Log grammar (the contract)

Three line shapes, all `- `-prefixed and single-line. Anything else in the file is prose and is
ignored by parsers.

```
- 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: <takeaway>.
- 2026-08-09 [dashboard] d04e9b52: status actioned — added to project CLAUDE.md
- 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2
```

- **lesson** — one per analyzed session (step 6). `<session-id>` is the short id prefix.
- **status** — what became of that lesson: `actioned` (written into a CLAUDE.md/memory),
  `promoted` (raised to global config), `dropped` (considered, rejected). The note after the em
  dash is free text. Appended in step 7, never earlier — a lesson with no status line is **open**.
- **review** — one marker per `/kaizen review` sweep (see below). No project tag, no session id.

### ⚠️ Append-only, always

The log is shared by every session on the machine, and this user runs several at once. So:
**append, never rewrite.** No sorting, no de-duplicating, no editing a previous line to mark it
done — that is why status is its own line. A read-modify-write of the whole file races other
sessions and silently destroys their entries (no error, no signal). After appending, grep the
line back to confirm it survived; if it's missing, another writer clobbered it — append again.

Use a shell append (`>>`), not a read-then-write edit.

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

### Record what happened (close the loop)

**Whatever the user chose, append a status line for this session** — that is how the next run
(and the dashboard) knows the lesson is settled instead of re-proposing it forever:

```
- <today> [<project>] <session-id>: status actioned — added to project CLAUDE.md
- <today> [<project>] <session-id>: status promoted — added to global CLAUDE.md after 4 projects
- <today> [<project>] <session-id>: status dropped — user declined; habit only
```

Append-only, per the grammar above. A lesson with no status line is open, so **never** skip
this because "nothing changed" — `dropped` is a real outcome and saying so is the whole point.
Skip it only in *capture* mode, where the lesson hasn't been judged yet.

### Prune watch (the rules that stopped earning their keep)

Config only ever grows unless something prunes it, and every line in a CLAUDE.md is paid for in
input tokens on *every* session. So while you're in there, look for **removal** candidates in
the project's CLAUDE.md / rules — not just additions:

- a rule this session (and recent logged ones) never needed to fire,
- a rule added from a single unrepeated observation that never recurred in the log,
- two rules that contradict, or one the user visibly works around,
- a rule the tooling now enforces on its own (a lint, a test, a type).

Test each with: **"would removing this change behavior?"** If no, propose the removal — in the
*same* AskUserQuestion as the additions, as an explicit option, never as a silent edit. Removals
are the user's call, always. Propose at most 2–3; a big pruning pass belongs in review mode.

## Mid-session capture

Friction is most accurate the moment it happens — reconstructing it later from a transcript is
guesswork over a noisy keyword count. So when the user **corrects course** ("no, don't do it
that way", "you should have checked X first"), or says "bank that lesson" / "note that for next
time", record it immediately:

1. Don't stop the work, don't run the analyzer, don't present a report. This is one append.
2. Get the session id: `node "$CLAUDE_SKILL_DIR/kaizen.mjs" --latest` prints it to stderr (it's
   also fine to reuse an id you already resolved this session).
3. Append one lesson line with `mid-session observation.` where the token prose normally sits:

```
- <today> [<project>] <session-id>: mid-session observation. Lesson: <what the correction taught>.
```

4. Confirm in one short sentence, then carry on with what you were doing.

A later full `/kaizen` run on the same session appends its own lesson line; consumers keep the
**newest** line per session, so the end-of-session lesson supersedes the capture automatically —
nothing to clean up. Write the lesson generalized ("check the rules doc before editing the
status machine"), not as a play-by-play of this one exchange.

## Review mode (`/kaizen review`)

Per-session runs see one session. Review mode sweeps the **whole log** — that's where
cross-project patterns and dead rules actually show up. Run it on `/kaizen review`, or when the
user accepts the review-due offer. It analyzes nothing; it's pure log work.

1. **Read the whole log.** Classify each lesson: **open** (no later `status` line for that
   session id) or settled. Only open lessons are in scope.
2. **Group semantically**, not by string — one group per underlying habit, across projects
   (same matching rule as the cross-project watch).
3. **Decide per group:**
   - ≥ 4 distinct `[project]` tags → **promote** candidate (global `~/.claude/CLAUDE.md`).
   - recurring in one project → **codify** candidate (that project's CLAUDE.md).
   - one-off and stale (older than ~30 days, never recurred) → **drop** candidate; it was noise.
4. **Prune pass:** apply the prune-watch tests above to the current project's CLAUDE.md/rules,
   plus global if the sweep touches it.
5. **One grouped AskUserQuestion**, not one per group: list each proposal as an option with its
   evidence (pattern, project count, dates). Multi-select. Anything the user doesn't pick stays
   open — untouched, not dropped.
6. **Apply** the approved edits, then **append one status line per affected session** and a
   single review marker:

```
- <today> review: swept <N> lessons, promoted <n>, codified <n>, dropped <n>, pruned <n> rules
```

The marker is what tells the dashboard the log has been swept — without it the review-due chip
never clears.

**The offer, during a normal run:** if the last `review:` marker is more than 7 days old (or
absent) and open lessons have piled up, say so in **one sentence** at the end of your report
("12 open lessons, last swept 3 weeks ago — want a `/kaizen review`?"). Never gate the
post-mortem on it, never ask twice in a session, and never start a sweep unasked.

