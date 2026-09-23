---
id: task-26
title: Kaizen byTool should size tool results, not just output tokens
created: 2026-09-20
tags: kaizen, analytics
updated: 2026-09-23T10:26:43Z
started: 2026-09-23T10:13:10Z
execute-elapsed: 813
execute-tokens: 67348
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

## Outcome

2026-09-23 — `byTool` now carries `resultTokens`: each matched tool_result's text sized at chars ÷ 4 (no char-based sizer existed in the file, so this is
the new one, labelled approximate), summed **per call**, error text included, image blocks 0. Landed in both the unit-tested source of truth
(`server/lib/analyze.ts` + `ToolStat` in `shared/types.ts`) and the vendored `.claude/skills/kaizen/kaizen.mjs`, which its PROVENANCE header requires to stay
in sync; a new parity test deep-compares their `byTool` and `notes`.

**Sort decision:** `byTool` now sorts by `resultTokens`, then `approxOutputTokens`, then `count`. `resultTokens` is measured per call rather than split, and it
is the context growth every later turn replays — the thing a kaizen run most needs to name. `byTool[0]` is therefore the top context contributor. The
Analytics tab's *Top tools* (which takes `byTool.slice(0, 3)`) now shows `in` (resultTokens) and `out` (approxOutputTokens) side by side, with the header
saying which is which, so the new order is not shown against the old figure.

A matching `notes[]` entry says what `resultTokens` is and is not (context growth, not assistant output; cite both, never add). SKILL.md §3 tells the reader to
cite both and that `resultTokens` is the firmer one. The log grammar needs no field: the log line is per session, not per tool.

Done-when, checked on a real transcript (session dd85c89f on this machine): `Read in=5560 out=184 x1 | Bash in=919 out=4428 x18` — Read is first by
`resultTokens`, where the old `approxOutputTokens` sort put it third.

Verification (`pnpm test` tail, `pnpm typecheck`, `pnpm build`):

```
  ✓ resultTokens: one 30k-char Read outweighs ten 500-char Bash calls and sorts first
  ✓ resultTokens counts is_error text, and errors still increments independently
  ✓ resultTokens is per call, not split across a shared message.id like approxOutputTokens
  ✓ resultTokens: no tool calls → byTool empty, no crash
  ✓ resultTokens: malformed tool_result content is skipped without throwing
  ✓ vendored kaizen.mjs reports the same byTool as analyzeSession
  ✓ missing file → null

Passed: 29  Failed: 0
...
5 passed, 0 failed
ALL PASS            (1332 cases; three consecutive full runs ALL PASS)

> tsc --noEmit      (exit 0)
✓ built in 1.22s
```

The very first full `pnpm test` run in this session ended `FAILED (1)`. I only captured its tail, so I don't know which case failed. The next four full runs
were all `ALL PASS`, and `test/analyze.test.ts` passed on its own every time. Probably a timing-sensitive case in another module, but that is not proven.

Contract sweep: 5 sites updated (.claude/skills/kaizen/SKILL.md §3, docs/subsystems/analytics.md §Invariants, shared/types.ts ToolStat + byTool JSDoc, server/lib/analyze.ts header comment, client/src/components/analytics/atoms.tsx TopTools label). Left standing on purpose: docs/learning-notes/kaizen-and-analytics{,-diagrams}.md (raw study notes, a record of a moment per CLAUDE.md "Where things go") and docs/guides/mockups/redesign-mock.html:4141 (a static design mockup, not rendered by the app).

Red proof: 6 tests went red with the change reverted. Reverting the accumulation line in analyze.ts turned 5 red. Reverting only the sort key turned the 30k-Read test red. Reverting the accumulation line in kaizen.mjs turned the parity test red. The `no tool calls → byTool empty` case stays green when reverted, because it pins behaviour that already existed; the plan asked for it as a robustness case.
