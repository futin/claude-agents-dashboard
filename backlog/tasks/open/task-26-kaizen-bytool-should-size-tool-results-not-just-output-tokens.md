---
id: task-26
title: Kaizen byTool should size tool results, not just output tokens
created: 2026-09-20
tags: kaizen, analytics
---

## Goal

`byTool` should report how many tokens each tool *injected into context*, alongside what it costs in assistant output. Today it ranks tools by
`approxOutputTokens` only, which structurally cannot surface the tools that dominate context growth.

Measured on this machine 2026-09-20 across 105 sessions / 7 days: `Read` accounted for 3,619k tokens of tool output — 53% of all 6,860k that entered main
context — at 31k average per call, worst 148k. A `Read` produces almost no assistant output, so it sorts near the bottom of today's `byTool` and a kaizen run
would never name it. For contrast in the same window: `bash other` 2,447k over 4,559 calls (536 avg), `browser_batch` 238k, test runs 112k (277 avg),
`codegraph_explore` 76k (4,450 avg), `Agent` 26k (258 avg).

## Plan

- In `.claude/skills/kaizen/kaizen.mjs`, extend the per-tool struct minted in `getTool` (currently `{ tool, count, durationMs, errors, approxOutputTokens }`,
  kaizen.mjs:204) with a `resultTokens` field.
- Populate it from `toolResultText(b)` — the helper already exists at kaizen.mjs:69 and is already called at :65 and :111, so no new parsing is needed. Size it
  the same approximate way the rest of the file does and label it approximate.
- Decide the sort. `approxOutputTokens` is an even split of a turn's output across its tool calls and is already flagged approximate in the `notes[]` array
  (kaizen.mjs:315); `resultTokens` is measured, not split, so it is the firmer number. Sorting by `resultTokens` is the implementer's call — state which was
  chosen and why.
- Add a matching `notes[]` entry describing what `resultTokens` is and is not.
- Update SKILL.md §3 ("Find where the tokens/time went", around line 59) so the reader is told to cite both, and which one is firm.
- Lockstep: `docs/subsystems/analytics.md` per the repo rule that the vendored kaizen skill and the session-analytics log format stay in sync. Check whether
  the log grammar in SKILL.md §"Log grammar" needs a field for this; it probably does not, since the log line is per-session, not per-tool.

## Test cases

- A transcript with one `Read` returning ~30k of text and ten `Bash` calls returning ~500 each: `Read.resultTokens` must exceed the summed `Bash`
  `resultTokens`, and `Read` must be visible as the context-dominant tool in the rendered report.
- A tool call whose result is `is_error: true`: `resultTokens` still counts the error text, and `errors` still increments — the two are independent.
- A turn with several tool calls sharing one `message.id`: `resultTokens` is attributed per tool call, NOT split evenly the way `approxOutputTokens` is. This
  is the distinction the whole item exists for; assert it explicitly.
- A transcript with no tool calls at all: no crash, `byTool` empty.
- A malformed/unparseable `tool_result` content block: skipped without throwing, consistent with the existing per-line `try/catch` on JSON.parse.

## Done when

A kaizen run on a `Read`-heavy session names `Read` as the top context contributor with a token figure, and the report distinguishes "injected into context"
from "assistant output tokens" clearly enough that a reader does not conflate them.
