---
id: task-27
title: Kaizen should flag sessions that never compacted
created: 2026-09-20
tags: kaizen, analytics
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
