---
id: task-27
title: Kaizen should flag sessions that never compacted
created: 2026-09-20
tags: kaizen, analytics
updated: 2026-09-23T10:42:03Z
started: 2026-09-23T10:31:50Z
execute-elapsed: 613
execute-tokens: 59980
---

## Goal

A single kaizen run should be able to say "this session never compacted, and that is why it cost what it did". Today it cannot, and the most expensive
sessions on this machine are exactly that shape.

Total input scales with the square of context, because every turn replays the whole thing: `total ≈ (C_end² − C_start²) / 2d`, where `d` is tokens added per
turn. A session that never compacts pays that curve to the end. Measured 2026-09-20 on this Mac, 7 days: 2,614M tokens moved across 105 sessions, and the 33
that grew past 200k context accounted for 87% of it, peaking at 631k / 668k. The cause was `"model": "opus[1m]"` as the global default — a 1M window puts
auto-compaction out of reach, so it never fires. Changed to `"model": "opus"` on 2026-09-20; the detection is still worth having, because the next drift will
not announce itself either.

## Plan

- Derive a boolean in `analyzeSession` (`.claude/skills/kaizen/kaizen.mjs:188`) from data the function already computes: `maxCombined` above a threshold
  proves compaction never ran, since a 200k window compacts near 160k. ~250k is a defensible threshold — pick one, name it as a constant, and comment why.
- The transcript cannot be relied on for the window directly. Verified 2026-09-20: `message.model` reads `claude-opus-5` with no `[1m]` suffix, and no record
  carries a compaction marker. Inference from `maxCombined` is the available signal, so treat the flag as inferred and say so where it is reported.
- Surface it in the analyzer output next to the existing `perTurn` block (`maxTurnIndex` / `maxCombined` / `avgCombined`).
- Reframe SKILL.md §2 "Read tokens honestly" (around line 47). Today it says to mention `totals.combined` "only as a context-pressure signal, never as what
  this cost". That is right about billing — `cacheRead` is billed at roughly 10% — and wrong as diagnosis, because `cacheRead` growth IS the quadratic replay.
  Keep the cost caveat, but promote context growth to a first-class efficiency signal rather than a footnote, and tie it to the new flag.
- Add a `notes[]` entry stating the flag is inferred from peak context, not read from a window field.
- Lockstep `docs/subsystems/analytics.md` per the repo rule.

## Test cases

- Transcript whose peak turn is ~600k combined: flag true.
- Transcript whose peak turn is ~140k: flag false.
- Transcript whose peak sits just either side of the chosen threshold: assert both directions explicitly, so the boundary is pinned rather than incidental.
- A transcript where an early turn is the peak and later turns are much smaller — the shape compaction actually produces: flag false. This is the case that
  distinguishes "did compact" from "never got big", and a naive `max > threshold` check gets it wrong, so decide deliberately what the right answer is here
  and encode it.
- A one-turn transcript, and a transcript with no usage records at all: no crash, flag false rather than undefined.

## Done when

A kaizen run on any of this machine's 600k-peak sessions reports the never-compacted flag, and SKILL.md instructs the reader to treat it as a primary
explanation for cost rather than a footnote.

## Outcome

2026-09-23 — `perTurn.neverCompacted` added to `analyzeSession` in both `.claude/skills/kaizen/kaizen.mjs` and its unit-tested source of truth
`server/lib/analyze.ts` (plus `PerTurn` in `shared/types.ts`), kept in step by a new kaizen.mjs-vs-analyzeSession parity test, the same way task-26 did it.
Rule: `maxCombined > NEVER_COMPACTED_PEAK` (250k, exclusive) **and** no turn anywhere fell below `COMPACTION_DROP_RATIO` (0.5) of the running peak. A
turn's combined is its whole context, which only grows between compactions, so that fall is the compaction signature.

Decision on the plan's open case: an early peak followed by a drop reads **false** (the session did compact). A compaction *before* a later 600k peak also
reads false, because the name promises "never" — a stricter reading than "compaction was not firing at the peak". A one-turn 600k transcript would read true;
the tested one-turn case is small. The flag is always a boolean (no turns → false). A `notes[]` entry says it is inferred from peak context. SKILL.md §2
now keeps the `billableApprox` cost caveat, makes `cacheRead` growth a first-class signal with the quadratic formula, and says to lead the cost story with
`neverCompacted: true`; §5 gets a matching suggestion. `docs/subsystems/analytics.md` §Invariants documents the inference.

Real-data check (`node .claude/skills/kaizen/kaizen.mjs <file>` on this machine's highest-peak transcripts):

```
7d086732 claude-opus-5 {"count":423,"avgCombined":414050,"maxCombined":748566,"maxTurnIndex":422,"neverCompacted":true} true
767c3567 claude-fable-5,claude-opus-4-8 {"count":319,"avgCombined":355677,"maxCombined":694407,"maxTurnIndex":193,"neverCompacted":false} true
52a78a2a claude-opus-5 {"count":260,"avgCombined":396851,"maxCombined":669525,"maxTurnIndex":259,"neverCompacted":true} true
```

(trailing `true` = the inference note is present). 767c3567 really compacted: turn 194 drops to 75,218 after a 694,407 peak, so false is right.

`npx tsx test/analyze.test.ts`:

```
  ✓ neverCompacted: a session that grows to ~600k reads true
  ✓ neverCompacted: a session peaking at ~140k reads false
  ✓ neverCompacted: the 250k boundary is exclusive — 250,000 false, 250,001 true
  ✓ neverCompacted: a big early peak followed by a compaction drop reads false
  ✓ neverCompacted: a compaction before the peak still reads false — the session did compact
  ✓ neverCompacted: one turn, and no usage at all, read false rather than undefined
  ✓ vendored kaizen.mjs reports the same perTurn (neverCompacted included) as analyzeSession
  ✓ missing file → null

Passed: 36  Failed: 0
```

`pnpm test` → `ALL PASS` (exit 0); `pnpm typecheck` → clean. The first `pnpm test` run failed one unrelated case, `api-usage-rates: a near-miss path is
not the rates endpoint` ("it falls through to the static handler"), because a fresh worktree has no `client/dist`. After `pnpm build` the whole suite passed.
The diff touches no routing or static code.

Contract sweep: 3 sites updated (.claude/skills/kaizen/SKILL.md §2 "context-pressure signal only" bullet and §5 examples, docs/subsystems/analytics.md
§Invariants, shared/types.ts PerTurn). Left on purpose: `shared/types.ts` `TotalTokens.combined` JSDoc ("a context-pressure signal, NOT a cost figure") is
still true about cost. `docs/learning-notes/kaizen-and-analytics*.md` use the same phrase but are raw study notes, a record of a moment. The globally
installed copy at `~/.claude/skills/kaizen/` is a plain directory outside this worktree, so it is not updated here. It needs a re-sync after merge.
Red proof: 7 tests went red with the change reverted (field removed from server: all 7; drop detection removed, i.e. naive `max > 250k`: early-peak,
pre-peak-compaction and parity; `>` → `>=`: boundary and parity; kaizen.mjs reverted to HEAD or made naive: parity)
