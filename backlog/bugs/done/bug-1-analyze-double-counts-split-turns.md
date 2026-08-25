---
id: bug-1
title: Analyze double-counts split turns
created: 2026-08-22
---

## Symptom

Every token total the Analytics tab and `/kaizen` print is roughly **1.7–2.6×
too high**, and the per-tool breakdown is inflated by a *different, much smaller*
factor — so the two do not reconcile, and the ratio between them is what misleads
worst.

## Repro

Run `/kaizen` (or open the Analytics tab) on any real transcript with 20+ turns
and compare its `turnCount` / totals against a manual count of actual assistant
turns in that transcript — the tool's numbers run ~1.7–2.2× high on `turnCount`
and ~1.7–2.6× high on the token totals. Measured on four transcripts (2026-08-22):

| transcript | turnCount | combined | output | billableApprox | byTool as % of output |
|---|---|---|---|---|---|
| `64bbe973` | 96 → 56 | 6,497,505 → 3,814,540 | 56,773 → 30,871 | 354,214 → 183,616 | 49% → 90% |
| `acbdcd0d` | 23 → 11 | 1,218,794 → 590,175 | 25,135 → 11,224 | 158,100 → 60,841 | 17% → 34% |
| `6f8c3c9e` | 191 → 88 | 33,659,952 → 16,195,571 | 298,414 → 113,826 | 874,087 → 334,537 | 42% → 98% |
| `25ec88c3` | 101 → 46 | 13,522,664 → 6,476,471 | 91,636 → 41,089 | 454,783 → 194,275 | 56% → 98% |

(naive-today → deduped-by-`message.id`, per field.)

## Affects

`server/lib/analyze.ts` (the Analytics tab) and
`.claude/skills/kaizen/kaizen.mjs` (the `/kaizen` skill) — which carry the *same
loop*, and the vendored copy is byte-identical to the global one at
`~/.claude/skills/kaizen/kaizen.mjs` (`diff` is silent). So the same fix has to
land in all three places, or the vendored/global lockstep that `.claude/CLAUDE.md`
requires breaks.

**Not affected:** `server/lib/transcript.ts`, and therefore the session rows and
the chat-drawer context readout. It reads the *latest* usage rather than summing,
and the duplicate records are identical, so its numbers are right.

**Context:** `docs/subsystems/analytics.md`, and the sibling idea this was found
while researching — see `from:` below.

## Cause

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

Two changes, in the same loop, in all three copies (`analyze.ts`, the vendored
and the global `kaizen.mjs`):

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

Found while researching per-turn token attribution (idea-2 in this backlog) —
specifically, why differencing consecutive records' context totals produced
`+559, 0, +3171, 0, +1165, 0…`. The alternating zeros were not quiet turns; they
were the second record of a split turn. The same duplication that broke the
delta is what inflates the sums.

## Outcome

**2026-08-25 — fixed.** Both changes landed in all three copies (`server/lib/analyze.ts`,
`.claude/skills/kaizen/kaizen.mjs`, and the global `~/.claude/skills/kaizen/kaizen.mjs`,
still byte-identical to the vendored one).

**Shape of the fix.** One `Map` keyed by `message.id` holds each turn's `output_tokens`
plus every tool block it emitted across all of its records. Usage, `models`, `turnCount`
and `server_tool_use` accumulate on a turn's **first** record only (`firstOfTurn`); the
per-tool token split is buffered and settled in one pass after the walk, so a turn's output
divides across *all* of its tool blocks rather than per record. `count` / `durationMs` /
`errors` / `retries` stay per tool **call** — parallel calls really are separate calls, and
only the token split is per turn. No `message.id` → key is `#anon<n>`, unique per record,
which is exactly the pre-fix behaviour (fail open, never drop a turn).

`server_tool_use` was **also** double-counted — it rides in the same replicated usage block
and the plan didn't mention it. It is now inside the same gate. Latent only: zero records
with `web_search_requests`/`web_fetch_requests` > 0 across all 406 transcripts on this
machine, so no observed number changes.

**Root cause re-confirmed live before changing anything** (2026-08-25, fresh transcripts):

```
45be9cde  usage records 511  distinct message.id 263  inflation 1.94x  ids w/ >1 tool-bearing rec 6
b4d0e509  usage records 250  distinct message.id 140  inflation 1.79x  ids w/ >1 tool-bearing rec 17
15ac05f3  usage records 649  distinct message.id 281  inflation 2.31x  ids w/ >1 tool-bearing rec 18
347fd1ec  usage records 232  distinct message.id 155  inflation 1.50x  ids w/ >1 tool-bearing rec 4
ids whose duplicate usages DIFFER: 0 on all four  <- dedup by message.id is safe
records with no message.id:        0 on all four
```

**Before → after on the four transcripts this bug originally measured** (old = the
`kaizen.mjs` at HEAD, new = the fixed one; `byTool %` is the byTool sum as a share of
`totals.output`):

| transcript | turnCount | combined | output | billableApprox | byTool % of output |
|---|---|---|---|---|---|
| `64bbe973` | 130 → 77 | 10,245,289 → 6,127,605 | 82,778 → 44,701 | 411,592 → 216,958 | 49% → 90% |
| `acbdcd0d` | 75 → 36 | 7,578,832 → 3,733,589 | 130,155 → 53,889 | 617,261 → 246,275 | 36% → 81% |
| `6f8c3c9e` | 191 → 88 | 33,659,952 → 16,195,571 | 298,414 → 113,826 | 874,087 → 334,537 | 42% → 98% |
| `25ec88c3` | 101 → 46 | 13,522,664 → 6,476,471 | 91,636 → 41,089 | 454,783 → 194,275 | 56% → 98% |

`6f8c3c9e` and `25ec88c3` reproduce this bug's independently-computed
"deduped-by-`message.id`" predictions **exactly**, field for field. `64bbe973` and
`acbdcd0d` are larger than in the 2026-08-22 table because those two sessions kept running
after it was written; their ratios match.

Two independent cross-checks:
- `perTurn.count` now equals a standalone probe's distinct-`message.id` count on all four
  sampled transcripts (263 / 140 / 281 / 155 — exact).
- `byTool` sum never exceeds `totals.output` on **any** of the 406 transcripts on this
  machine (the invariant that was structurally violable before). Single-record sessions are
  untouched (e.g. `004b19bb`, `09bd300c`, `14d49778` — identical before and after), so the
  fix does not over-correct.
- `kaizen.mjs` and `analyze.ts` produce **byte-identical** JSON on real transcripts, so the
  two implementations have not drifted.

### Verification

`pnpm typecheck` — exit 0, no output.

`pnpm test` — 665 assertions, 0 failures, `ALL PASS`. The `analyze.ts` section (17 cases,
6 new):

```
=== analyze.ts ===
  ✓ four-field totals + billableApprox excludes cacheRead
  ✓ totals sum across turns; perTurn max + index
  ✓ a turn split across records sharing one message.id counts once
  ✓ parallel tool_use in separate records split that turn's output once
  ✓ same tool across three records of one turn: count 3, one turn's output
  ✓ maxTurnIndex indexes deduped turns, not records
  ✓ records with no message.id each still count (fail-open)
  ✓ a split sidechain turn stays fully excluded
  ✓ sidechain usage excluded from totals but Task shows in bySubagent
  ✓ per-tool even-split approxOutputTokens
  ✓ toolErrors counts both is_error and <tool_use_error>
  ✓ retries: a tool re-invoked after it errored
  ✓ userCorrections counts human turns, ignores tool_result + task-notification
  ✓ unknown-token subagent → unknownTokenCount + note
  ✓ multi-model models[]
  ✓ serverTools + duration span
  ✓ missing file → null

Passed: 17  Failed: 0
```

Written test-first. All four dedup cases failed before the change, for the right reason —
doubled and tripled values, not errors:

```
  ✗ a turn split across records sharing one message.id counts once      200 !== 100
  ✗ parallel tool_use in separate records split that turn's output once 200 !== 100
  ✗ same tool across three records of one turn: count 3, one turn's out 270 !== 90
  ✗ maxTurnIndex indexes deduped turns, not records                    1400 !== 800
  Passed: 13  Failed: 4
```

The two cases that passed at RED are regression guards, so the fail-open one was
mutation-proved: collapsing `#anon${anonTurnSeq++}` to a constant key kills it plus two
pre-existing cases —

```
  ✗ totals sum across turns; perTurn max + index                        100 !== 800
  ✗ records with no message.id each still count (fail-open)             100 !== 200
  ✗ multi-model models[]                                                  1 !== 2
  Passed: 14  Failed: 3
```

`node --check` passes on both `kaizen.mjs` copies and `diff` between them is silent.

**End-to-end, in the running app** (`dev-verify`, ports 4700/5700). `GET /api/analytics`
returned 5 reports, no error, all with the deduped arithmetic (`turns=263` for `45be9cde` —
the exact figure the standalone probe computed; byTool 83–100% of output across the five).
The Analytics tab renders it: that card now reads **263 TURNS / 1.49M BILLABLE** where the
lesson text logged beside it on 2026-08-22 says "495 turns, 3.39M billable" — the scale
break the marker line documents, visible in one card. `43 · 3.96M SUBAGENTS` is unchanged,
correct: subagent tokens come from `readAgents`, not the usage loop. No console errors.

**Not verified:** only the Analytics tab was exercised in the browser — `/kaizen`'s own
`--latest` path and its log-append were not run end-to-end (the CLI was invoked directly on
explicit transcript paths instead). The next real `/kaizen` run is the first exercise of
that path.

### Rollout

One marker line was appended to `~/.claude/session-analytics-log.md`, dated 2026-08-25,
saying totals above it are ~1.5–2.3× inflated and are not comparable with the ones below.
It deliberately matches none of the three parser shapes (`LINE_RE` / `STATUS_RE` /
`REVIEW_RE`), verified by parsing the log with and without it: `lessons=12 evLessons=12
statuses=4 lastReview=2026-08-12` both ways, so the Analytics tab reads exactly as before.

`docs/subsystems/analytics.md` gained a leading **Invariants** bullet stating the
one-turn-is-not-one-record rule. Its `docs-sync` stamp still points at the pre-fix commit
(`verified: fa9fdbc0…`) and both `server/lib/analyze.ts` and `.claude/skills/kaizen/` are
in its `sources:` — **run `/docs-sync` after committing** to re-baseline it.
