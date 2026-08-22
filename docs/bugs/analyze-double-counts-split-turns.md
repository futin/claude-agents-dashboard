# Bug: token totals double-count, because one API turn is several JSONL records

**Status:** open, not fixed. Research only — the numbers below are measured, the
fix is specified but deliberately unwritten.

**Affects:** `server/lib/analyze.ts` (the Analytics tab) and
`.claude/skills/kaizen/kaizen.mjs` (the `/kaizen` skill) — which carry the *same
loop*, and the vendored copy is byte-identical to the global one at
`~/.claude/skills/kaizen/kaizen.mjs` (`diff` is silent). So the same fix has to
land in all three places, or the vendored/global lockstep that `.claude/CLAUDE.md`
requires breaks.

**Not affected:** `server/lib/transcript.ts`, and therefore the session rows and
the chat-drawer context readout. It reads the *latest* usage rather than summing,
and the duplicate records are identical, so its numbers are right.

**Context:** `docs/subsystems/analytics.md`, and
`docs/ideas/per-turn-token-usage.md` — which is where this was found, and which
needs the same dedup to work at all.

## Symptom

Every token total the Analytics tab and `/kaizen` print is roughly **1.7–2.6×
too high**, and the per-tool breakdown is inflated by a *different, much smaller*
factor — so the two do not reconcile, and the ratio between them is what misleads
worst.

## Mechanism

A single assistant response is not one line in the transcript. Claude Code writes
**one record per content block**, and every one of those records carries a full
copy of the same `message.usage`, under the same `message.id`:

```
uuid c469cb30   message.id msg_011CeJCMHxmg…   content [thinking]    ctx 40021
uuid 8cced8fe   message.id msg_011CeJCMHxmg…   content [tool_use]    ctx 40021
```

Observed groupings, one transcript (88 turns):

| Records per `message.id` | count |
|---|---|
| `thinking` + `tool_use` | 25 |
| `thinking` + `text` + `tool_use` | 23 |
| `tool_use` alone | 20 |
| `thinking` + `tool_use` + `tool_use` | 9 |
| `text` alone | 5 |
| `thinking` + `text` + `tool_use` + `tool_use` | 4 |

Note rows 4 and 6: **parallel tool calls are separate records too**, so a turn
firing three tools at once writes four or five records — each with the whole
turn's usage on it.

`analyze.ts:114-124` (and `kaizen.mjs:225-238`) sums per record:

```js
if (rec.isSidechain === true) continue;
…
const combined = inp + out + cc + cr;
if (combined > 0) {
  input += inp; output += out; cacheCreation += cc; cacheRead += cr;
  const idx = turnCount++;
  …
}
```

There is no `message.id` guard, so each copy is added again.

## Blast radius — measured

Four transcripts, naive (today) → deduped by `message.id`. Measured 2026-08-22;
`64bbe973` was a live session still being written, so treat the ratios rather
than its absolutes as the finding.

| transcript | turnCount | combined | output | billableApprox | byTool as % of output |
|---|---|---|---|---|---|
| `64bbe973` | 96 → 56 | 6,497,505 → 3,814,540 | 56,773 → 30,871 | 354,214 → 183,616 | 49% → 90% |
| `acbdcd0d` | 23 → 11 | 1,218,794 → 590,175 | 25,135 → 11,224 | 158,100 → 60,841 | 17% → 34% |
| `6f8c3c9e` | 191 → 88 | 33,659,952 → 16,195,571 | 298,414 → 113,826 | 874,087 → 334,537 | 42% → 98% |
| `25ec88c3` | 101 → 46 | 13,522,664 → 6,476,471 | 91,636 → 41,089 | 454,783 → 194,275 | 56% → 98% |

Field by field:

- **`totals.input` / `output` / `cacheCreation` / `cacheRead` / `combined`** —
  inflated 1.7–2.6×. `billableApprox` too, since it is built from three of them.
- **`turnCount`** — inflated ~1.7–2.2×. "191 turns" was 88 turns.
- **`maxTurnIndex`** — *wrong*, but not inflated: it is an index into the
  double-counted sequence, so it points at the wrong turn when a human tries to
  go look at it.
- **`perTurn` max (`maxCombined`)** — **correct**. The duplicates are identical,
  so the largest per-record value equals the largest per-turn value. Verified
  byte-equal on all three sampled transcripts (97,037 / 68,498 / 256,080 either
  way). Only its index is bad.
- **`byTool.approxOutputTokens`** — inflated only **1.00–1.11×**, and this is the
  subtle one. Each tool-bearing record splits *its own* record's `output_tokens`
  across only *its own* blocks. A turn with two parallel tool calls in two records
  therefore charges the full turn output to tool A *and* the full turn output to
  tool B, instead of half each — but a turn whose tools all sit in one record is
  attributed correctly. Measured: 14 of 88 `message.id`s had more than one
  tool-bearing record.

The last two bullets together are the real damage. `byTool` barely moves while
`output` roughly doubles, so **the share of output attributable to tools reads
about half of the truth** — 42% when it is really 98% on `6f8c3c9e`. A reader
concludes "most of my output is prose, tools are a minor cost" when the opposite
is true. That is exactly the judgement `/kaizen` exists to inform.

## Fix

Two changes, in the same loop, in all three copies:

1. **Dedup the usage sum.** Keep a `Set` of `message.id` seen; skip the usage
   accumulation (and `turnCount++`) on a repeat. `requestId` works equally well —
   measured 1:1 with `message.id` across 182 turns in 4 transcripts, zero
   violations — but `message.id` is the more natural key.
   Guard for a missing `message.id`: fall back to counting the record, so an old
   or malformed transcript degrades to today's behaviour rather than dropping
   turns.
2. **Group tool blocks per turn before splitting output.** `approxOutputTokens`
   must divide one turn's `output_tokens` across *all* of that turn's tool blocks,
   not per record. That means buffering blocks by `message.id` and settling at
   end of file, rather than attributing inline.

Both are pure changes to a pure function — no I/O, no new dep.

### Tests to add (`test/analyze.test.ts`)

The existing suite has `totals sum across turns; perTurn max + index`
(`test/analyze.test.ts:77`), which passes today *because its fixtures write one
record per turn*. That is the gap: the fixtures do not reproduce how Claude Code
actually writes a transcript.

Concretely, the `usageRec` helper (`test/analyze.test.ts:21-31`) emits no
`message.id` at all. Two consequences worth knowing before starting: every
existing case keeps passing under the fail-open guard below (no id → count it),
and the helper needs an `id` option added before any of the new cases can even be
expressed.

- A turn split across `thinking` + `tool_use` records sharing one `message.id`
  and one `usage` counts **once** in every `totals` field, and `turnCount` is 1.
- A turn with two parallel `tool_use` blocks in **separate** records gives each
  tool **half** the turn's `output_tokens`, not all of it.
- `maxTurnIndex` indexes deduped turns — on a fixture whose priciest turn is
  split, the index points at that turn's ordinal, not its record's.
- A record with no `message.id` still counts (fail-open).
- Sidechain records stay excluded — the existing `isSidechain` behaviour is
  correct and must not regress.

### Rollout note

This changes every number the Analytics tab prints and every number `/kaizen`
appends to `~/.claude/session-analytics-log.md`. Lessons already logged were
computed under the old, inflated arithmetic, so historical entries in that file
are not comparable with post-fix ones. Worth a dated marker line in the log at
the point the fix lands, rather than silently changing the scale of the series.

## How it was found

Researching `docs/ideas/per-turn-token-usage.md` — specifically, why differencing
consecutive records' context totals produced `+559, 0, +3171, 0, +1165, 0…`. The
alternating zeros were not quiet turns; they were the second record of a split
turn. The same duplication that broke the delta is what inflates the sums.
