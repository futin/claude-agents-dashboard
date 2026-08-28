---
id: task-6
title: Build the two remaining usage tutor lessons
created: 2026-08-27
tags: guides, tutor, usage
---

## Goal

Finish the usage tutor series. Lesson 1 shipped in
[PR #55](https://github.com/futin/claude-agents-dashboard/pull/55) as
`docs/guides/tutor/usage/usage-1-pace.html` (stamped `ac8d11d`). Two lessons remain, and
**1,605 lines of the usage domain are currently watched by no deck at all** — so no deck
would report them stale as they drift.

A tutor deck only diffs the files its own provenance stamp names. That is exactly how the
previous usage deck went stale invisibly: it cited five files, never `usage-forecast.ts`,
and the whole forecast layer landed unnoticed. The uncovered files below are the same trap,
re-armed.

## Plan

Run `/tutor` once per lesson (deck mode, ~5 sections each), writing into the existing series
directory. The tutor skill's series convention is
`docs/guides/tutor/<series>/<series>-N-<desc>.html`, so the paths are fixed:

**Lesson 2 — `docs/guides/tutor/usage/usage-2-learning-the-profile.html`**

Source: `server/lib/usage-history.ts` (680 lines), the recorder half. Nothing in it is
taught by lesson 1 (verified: `classifyInterval`, `isoWeekKey`, `foldBucket`,
`appendSample`, `shouldWrite`, `EWMA_ALPHA`, `TRUST_FLOOR_MIN`, `MAX_OBSERVED_WEEKS` all
score zero mentions in lesson 1). Material:

- `classifyInterval` → `active` / `idle` / `ambiguous` / `reset`, and the load-bearing
  point that **a flat overnight interval is an idle *measurement*, not missing data**.
- Hour-of-week bucket folding: `isoWeekKey`, `foldBucket`, `EWMA_ALPHA` (0.3), and the
  warning at `usage-forecast.ts:100-104` that bucket *indexing* (Sunday-first) and fold
  *grouping* (ISO week, Monday) are independent axes.
- Trust: `TRUST_FLOOR_MIN` (60), `MAX_OBSERVED_WEEKS` (26), `skippedWeeks` decay,
  `MAX_ATTRIBUTABLE_MS` (300_000), `MOVE_EPSILON` (0.5), `SAME_WINDOW_MS` (120_000).
- Storage and the opt-in: `.usage-history.jsonl` / `.usage-profile.json`, `HEARTBEAT_MS`
  (900_000), `MAX_HISTORY_BYTES` (32 MiB), `TAIL_BYTES` (256 KiB), `shouldWrite`,
  `repoRoot`, and `recordUsageHistory` in `server/lib/settings.ts`.

**Lesson 3 — `docs/guides/tutor/usage/usage-3-inspector.html`**

Source: the Usage tab, ~925 lines. `client/src/components/usage/UsageProfile.tsx` (527),
`client/src/lib/walkChart.ts` (250), `client/src/lib/usageProfile.ts` (76),
`client/src/hooks/useUsageProfile.ts` (44), `client/src/components/usage/UsageView.tsx`
(28), plus the `GET /api/usage/profile` handler. Material:

- The 24×7 hour-of-week heatmap and its `color-mix` ramp — it has to hold across all five
  themes, which is why no colour is hardcoded.
- The tooltip: a **real element, never the `title` attribute**, because `title` never fires
  on touch. Pinned over the grid, following over the walk strip — see
  `docs/subsystems/usage-limits.md` §The inspector.
- `walkChart.ts` geometry: the cumulative climb to a 100% ceiling, `splitRuns` (measured
  solid vs assumed dashed), `crossingX`, `dayTicks`, `Y_MAX` (130).
- `profileProgress` and the first-week status line, so the inspector is not a blank grid.

**Also correct lesson 1's recap card during lesson 2's run** (deliberately deferred rather
than given its own PR). Its "rest of the series" block still names
`usage-3-forecast-walk`, whose material lesson 1 actually teaches in section s5 —
`walkForward` (5 mentions), `confidenceOf` (4), plus `hourOfWeek`, `flatProfile`,
`weightAt`, `isLearnedAt`, `nextLocalHour`, `localOffsetMinutes`. Cause: the 4-way split
was recorded while the deck had 4 sections, then the deck was rebuilt at 5 and s5 absorbed
that lesson's material. Fix: list only the two lessons above, renumbering the inspector
to 3.

Note `/tutor` asks for the deck path per session and defaults elsewhere — answer with the
paths above. Register each deck with guide-manager at the end of its run; `register.js` is
upsert-only, so a moved or renamed deck leaves a dead entry behind.

## Test cases

Per deck, before calling it done:

- All 7 pre-handover checklist items pass: no external references (URLs only inside
  `<pre>` or an `xmlns`), stamp parses with every `sections[].sources` present in the
  top-level `sources`, no empty quiz feedback or Q&A body, correct-option position takes
  more than one distinct value, no `fetch`/`XMLHttpRequest`/`WebSocket`/dynamic `import`
  in the inline JS, correct option never the *sole* longest by label **or** feedback word
  count, both meta tags present.
- Structure: N−1 divider cards for N sections, one opener, one recap, at most one Q&A card
  per section and always last in its wrapper, recap links every section.
- **Every `<pre>` excerpt matches its cited line range verbatim.** `(compacted here)`
  licenses *abridging* lines, not rewrapping them — 5 of 15 excerpts failed this on lesson
  1's first pass because multi-line source had been reflowed into compact form.
- Every `file:line` citation in bounds, and each numeric claim grepped against source.
- Opens from `file://` with no console errors; `Next` gated on an unanswered quiz card;
  tapping an option reveals only its own feedback and makes all options inert.
- Any inline SVG: measure with `getBBox` for text collisions and viewBox overflow; no
  hardcoded hex, no external `<image>`/`<use>`.

Reusable checkers were written for lesson 1 but left in the session scratchpad, not
committed — rewrite or re-derive them; they are ~150 lines each and caught 6 real defects.

## Done when

- Both decks exist at the paths above and pass every check listed.
- Between them, the stamps cite `usage-history.ts`, `walkChart.ts`, `usageProfile.ts`,
  `useUsageProfile.ts`, `UsageView.tsx` and `UsageProfile.tsx`, so drift in those 1,605
  lines is finally detected.
- Both registered with guide-manager and `~/.guide-manager/registry.json` has zero dead
  entries.
- Lesson 1's recap card no longer names `usage-3-forecast-walk`.

⚠️ `UsageProfile.tsx` is actively edited — it changed twice mid-session on 2026-08-26
(514 → 527 lines). Re-read it at the start of lesson 3 rather than trusting any line
number in this file.
