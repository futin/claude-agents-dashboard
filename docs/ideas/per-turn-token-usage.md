# Idea: per-turn token usage in the chat drawer

**Status:** not built. The session-level half shipped instead — the drawer head
now carries the same live `tokens / window` + `%` readout the row has
(`client/src/components/ChatDrawer.tsx`), fed by the 3s poll, no new read. This
doc is the *other* half: attributing context growth to the individual message
that caused it.

**Context:** `docs/subsystems/chat.md` (how the drawer pages a transcript),
`docs/subsystems/analytics.md` (the offline totals we already compute).

## Why it's interesting

Claude Code itself does not show this. Checked against the installed CLI
(2.1.234): `/context` renders a **snapshot** of the current window broken down
by category, `/cost` gives a session **total**, `/usage` gives account plan
limits, and the footer shows a live **percentage**. Every one of those is either
a point-in-time reading or a grand total. None answers *"which turn added 40k?"*

We are unusually well placed to answer it, because we already read the field.
`server/lib/analyze.ts` walks the whole transcript and sums every turn's
`message.usage` — but only offline, only as totals, and only in the Analytics
tab. The chat drawer, which is the one place a human is actually *looking at the
messages*, throws the same data away: `parseChatRecord`
(`server/lib/chat.ts:133`) receives the raw record and keeps only text + tool
calls.

## What the transcript actually gives us

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

Two very different numbers live in there, and they cost very different amounts
to surface:

| Number | Meaning | What it takes |
|---|---|---|
| `output_tokens` | what this turn **generated** (thinking included, broken out in `output_tokens_details`) | free — self-contained on the record |
| `input + cache_read + cache_creation` | the **whole prompt** at that turn, i.e. total context so far | needs the previous turn to be useful |

The second is *not* a per-turn cost. It is a running total, so it must be
**differenced** against the previous assistant turn to mean anything. Measured on
a real transcript: ctx 40,021 → 40,580 → 43,751 → 44,916, i.e. deltas of +559,
+3,171, +1,165. Those deltas are the interesting signal — that is the tool result
or user message that landed in between, priced.

`usageTokens()` (`server/lib/transcript.ts:111`) already sums exactly those three
fields; reuse it rather than re-deriving the formula.

## The trap: one API turn is several JSONL records

**This is the thing to get right, and it is currently gotten wrong elsewhere in
the repo.**

A single assistant response is written to the transcript as **one record per
content block** — a `thinking` record, then a `tool_use` record — and *every one
of them carries the same `message.usage`, under the same `message.id`*:

```
uuid c469cb30   message.id msg_011CeJCMHxmg…   content [thinking]    ctx 40021
uuid 8cced8fe   message.id msg_011CeJCMHxmg…   content [tool_use]    ctx 40021
uuid 69c69f67   message.id msg_011CeJCN9Dh5…   content [thinking]    ctx 40580
uuid 85aa2c0d   message.id msg_011CeJCN9Dh5…   content [tool_use]    ctx 40580
```

Sampled transcript: **53 usage-bearing records, 31 distinct `message.id`s.**

Two consequences:

1. **Naive consecutive-record differencing produces alternating garbage** —
   `+559, 0, +3171, 0, +1165, 0…`. The zeros are not quiet turns, they are the
   second half of a split turn.
2. **Naive summing double-counts.** Dedup on `message.id` before differencing
   *or* summing. (`requestId` works equally well — measured 1:1 with `message.id`
   across 182 turns in 4 transcripts, zero violations.)

### Live bug this uncovered — `analyze.ts` over-counts

`server/lib/analyze.ts:114-124` sums `msg.usage` per *record* with no
`message.id` dedup, so a split turn is counted once per content block. Measured
over the four most recent transcripts on this machine, naive vs deduped:

| transcript | turns | combined tokens | inflation |
|---|---|---|---|
| `64bbe973` | 57 → 33 | 3,134,730 → 1,836,027 | 1.71× |
| `acbdcd0d` | 21 → 10 | 1,081,798 → 521,677 | 2.07× |
| `6f8c3c9e` | 191 → 88 | 33,659,952 → 16,195,571 | 2.08× |
| `25ec88c3` | 101 → 46 | 13,522,664 → 6,476,471 | 2.09× |

So `SessionAnalysis.totals`, `turnCount`, `maxTurnIndex` and the per-tool
`approxOutputTokens` split are all inflated ~1.7–2.1× today, and the Analytics
tab and `/kaizen` report those numbers. **Fix this before or alongside building
the idea** — it is a one-line `Set<string>` guard on `msg.id`, but it changes
every number the Analytics tab prints, so it wants its own change and its own
test.

`server/lib/transcript.ts` is **not** affected: it reads the *latest* usage
rather than summing, and the duplicates are identical, so the row's live
`tokens` / `contextPct` are correct. Level 1 (the drawer-head readout) inherits
that correctness for free.

## Second trap: the delta needs a record the page may not contain

The drawer pages by byte offset — tail, `?after=` (live), `?before=` (older) —
see `docs/subsystems/chat.md`. The first assistant turn in any page has no
predecessor *within that page*, so its delta is unknowable from the page alone.

Three ways out, cheapest first:

1. **Send the anchor with the page.** When building a page, keep scanning
   backwards for the nearest preceding assistant record with usage and return
   its combined total as a scalar (`prevContext`) alongside `messages`. Costs one
   short backward hunt per page; `title-cache.ts` already establishes the pattern
   for hunting below the window. Client differences purely.
2. **Server computes the delta per message.** Same backward hunt, but the wire
   carries `ctxDelta` per message and the client renders it dumbly. Simpler
   client, but bakes an interpretation into the API contract.
3. **Render nothing for the first message in a page.** Free, and honest, but the
   gap moves as the reader scrolls, which reads as a bug.

Option 1 is the recommendation: one extra scalar on `SessionChat`, the
interpretation stays client-side, and it degrades to option 3 when the hunt
finds nothing (page starts at byte 0).

## Third trap: compaction makes deltas go negative

`/compact` (and auto-compact) replaces the conversation with a summary, so
context **drops**. A negative delta is real and worth showing as such — a `−120k`
badge on the turn after a compact is genuinely useful information, not an error
state. Do not clamp it to zero.

Similarly `/clear` opens a *new* transcript file with a new UUID, so it is not a
delta problem at all — it is a different session as far as this repo is
concerned.

## Fourth trap: subagents are invisible here, by design

`parseChatRecord` drops `rec.isSidechain === true` (`server/lib/chat.ts:135`) —
subagent traffic never reaches the drawer. But a `Task` call's tool result *does*
land in the main thread, so a subagent that burned 200k shows up as one large
delta on the turn that received its result, with no breakdown.

That is arguably correct — the delta honestly reports what hit the main context —
but the badge should not imply the model *generated* it. `server/lib/agents.ts`
already has per-subagent token totals; a tooltip on a `Task`-result delta could
name the culprit.

## Shape of the change

- `shared/types.ts` — optional `usage?: { output: number; context: number }` on
  `ChatMessage`; optional `prevContext?: number` on `SessionChat`.
- `server/lib/chat.ts` — populate it in `parseChatRecord` (pure, already unit
  tested); dedup split records by `message.id`; backward-hunt the page anchor.
- `client/src/components/ChatDrawer.tsx` — a small badge on assistant bubbles.
  Existing `.tok` / `.pct` classes are already themed; do not add colors.
- `test/chat.test.ts` — split-turn dedup, page-boundary anchor, negative delta
  across a compact.
- `docs/subsystems/chat.md` — the contract change.

## The real tradeoff (decide before building)

The drawer is a **reading** surface. Every message currently renders as text plus
tool calls; a token badge on each assistant bubble is persistent visual noise in
service of a question that is only occasionally asked ("where did my context
go?").

- Worth it **if** the badge is opt-in — the drawer already persists an all/text/you
  filter (`client/src/lib/chatFilter.ts`), so a fourth toggle is a natural home,
  and `hooks/usePersistedState` already handles the persistence.
- **Not** worth it as always-on chrome, and not worth it at all if the honest
  answer is that `/kaizen`'s post-mortem already serves this need well enough —
  it names the priciest turn today (`maxTurnIndex`), just without letting you
  *look at* that turn.

Recommended: fix the `analyze.ts` double-count first (it is a correctness bug in
shipped numbers, independent of this idea), then build the badge behind a filter
toggle, showing the **delta** rather than the raw running total — the raw total
is what everyone reaches for first and it is the less useful of the two.
