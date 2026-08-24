---
id: idea-2
title: Per-turn token usage in the chat drawer
created: 2026-08-22
---

## Problem

Claude Code itself does not show "which turn added how much context." Checked
against the installed CLI (2.1.234): `/context` renders a **snapshot** of the
current window broken down by category, `/cost` gives a session **total**,
`/usage` gives account plan limits, and the footer shows a live **percentage**.
Every one of those is either a point-in-time reading or a grand total. None
answers *"which turn added 40k?"*

We are unusually well placed to answer it, because we already read the field.
`server/lib/analyze.ts` walks the whole transcript and sums every turn's
`message.usage` — but only offline, only as totals, and only in the Analytics
tab. The chat drawer, which is the one place a human is actually *looking at the
messages*, throws the same data away: `parseChatRecord`
(`server/lib/chat.ts:133`) receives the raw record and keeps only text + tool
calls.

**Status: partially built.** The session-level half shipped instead — the
drawer head now carries the same live `tokens / window` + `%` readout the row
has (`client/src/components/ChatDrawer.tsx`), fed by the 3s poll, no new read.
This item covers the *other* half: attributing context growth to the individual
message that caused it.

**Context:** `docs/subsystems/chat.md` (how the drawer pages a transcript),
`docs/subsystems/analytics.md` (the offline totals we already compute).

## Rough shape

Verbatim from a live transcript (`~/.claude/projects/*/*.jsonl`), on an
`assistant` record:

```json
"usage": {
  "input_tokens": 2,
  "cache_creation_input_tokens": 559,
  "cache_read_input_tokens": 40019,
  "output_tokens": 143,
  "output_tokens_details": { "thinking_tokens": 11 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 }
}
```

Two very different numbers live in there: `output_tokens` (what this turn
generated — free, self-contained on the record) vs. `input + cache_read +
cache_creation` (the whole prompt at that turn — a running total, so it must be
**differenced** against the previous assistant turn to mean anything). Measured
on a real transcript: ctx 40,021 → 40,580 → 43,751 → 44,916, i.e. deltas of
+559, +3,171, +1,165 — that delta is the tool result or user message that
landed in between, priced. `usageTokens()` (`server/lib/transcript.ts:111`)
already sums exactly those three fields; reuse it rather than re-deriving the
formula.

**The trap that must be handled first:** a single assistant response is written
as one record per content block, and every record carries the *same*
`message.usage` under the same `message.id` (53 usage-bearing records, 31
distinct `message.id`s in one sample). Naive consecutive-record differencing
produces alternating garbage (`+559, 0, +3171, 0…` — the zeros are the second
half of a split turn), and naive summing double-counts. This is the same root
cause as bug-1 in this backlog — **fix that dedup before or alongside building
this idea**, it's a prerequisite here, not a neighbouring cleanup.
`server/lib/transcript.ts` is unaffected (reads latest, not a sum), so the
drawer-head readout that already shipped inherits correctness for free.

**Second trap — the delta needs a record the page may not contain.** The drawer
pages by byte offset (tail / `?after=` / `?before=`); the first assistant turn
in any page has no predecessor *within that page*. Recommended fix: when
building a page, keep scanning backwards for the nearest preceding assistant
record with usage and return its combined total as a scalar (`prevContext`)
alongside `messages` — one extra scalar on `SessionChat`, interpretation stays
client-side, `title-cache.ts` already establishes the backward-hunt pattern.
Degrades to "render nothing for the first message" when the hunt finds nothing
(page starts at byte 0).

**Third trap — compaction makes deltas go negative.** `/compact` (and
auto-compact) replaces the conversation with a summary, so context *drops*. A
negative delta is real and worth showing as such (a `−120k` badge on the turn
after a compact is genuinely useful, not an error state) — do not clamp to
zero. `/clear` opens a new transcript file with a new UUID, so it's a different
session, not a delta problem.

**Fourth trap — subagents are invisible here, by design.** `parseChatRecord`
drops `rec.isSidechain === true` (`server/lib/chat.ts:135`) — subagent traffic
never reaches the drawer. But a `Task` call's tool result *does* land in the
main thread, so a subagent that burned 200k shows up as one large delta on the
turn that received its result, with no breakdown. Arguably correct (the delta
honestly reports what hit the main context), but the badge should not imply
the model *generated* it — `server/lib/agents.ts` already has per-subagent
token totals, so a tooltip on a `Task`-result delta could name the culprit.

Shape of the change: `shared/types.ts` — optional `usage?: { output: number;
context: number }` on `ChatMessage`; optional `prevContext?: number` on
`SessionChat`. `server/lib/chat.ts` — populate it in `parseChatRecord` (pure,
already unit tested); dedup split records by `message.id`; backward-hunt the
page anchor. `client/src/components/ChatDrawer.tsx` — a small badge on
assistant bubbles; existing `.tok` / `.pct` classes are already themed, no new
colors. `test/chat.test.ts` — split-turn dedup, page-boundary anchor, negative
delta across a compact. `docs/subsystems/chat.md` — the contract change.

## Open questions

The drawer is a **reading** surface. Every message currently renders as text
plus tool calls; a token badge on each assistant bubble is persistent visual
noise in service of a question that is only occasionally asked ("where did my
context go?").

- Worth it **if** the badge is opt-in — the drawer already persists an
  all/text/you filter (`client/src/lib/chatFilter.ts`), so a fourth toggle is a
  natural home, and `hooks/usePersistedState` already handles the persistence.
- **Not** worth it as always-on chrome, and not worth it at all if the honest
  answer is that `/kaizen`'s post-mortem already serves this need well enough —
  it names the priciest turn today (`maxTurnIndex`), just without letting you
  *look at* that turn.

Recommended: fix bug-1 (the `analyze.ts` double-count) first — it's a
correctness bug in shipped numbers, independent of this idea — then build the
badge behind a filter toggle, showing the **delta** rather than the raw running
total (the raw total is what everyone reaches for first and is the less useful
of the two).
