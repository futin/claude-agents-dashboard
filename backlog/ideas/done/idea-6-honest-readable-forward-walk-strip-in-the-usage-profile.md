---
id: idea-6
title: Honest readable forward-walk strip in the Usage profile
created: 2026-08-26
tags: ui, usage, forecast
promoted-to: task-5
---

## Problem

The forward-walk strip under the 24x7 heatmap (`.up-walk` in
`client/src/components/usage/UsageProfile.tsx:333`) is the disclosure for *when the weekly
window hits 100%*, and today it discloses almost nothing. Four separate defects, all
observed on 2026-08-26 against the running server:

**1. Encoding contradicts the heatmap directly above it.** An hour with no learned weight
falls back to `globalMean` (`1.0` while `confidence: none`), so it draws as a **full-height
solid bar**. Zero knowledge renders as maximum activity. The heatmap in the same card uses
the opposite rule on purpose — no evidence is *texture*, never a colour step
(`UsageProfile.tsx:27`) — because "no value" is a different statement from "a low value".
The strip says the opposite of its own card.

Live payload while the walk existed:

```
confidence: none   globalMean: 1   steps: 118
distinct gains: 0.713 (partial current hour), 2.146 (every full hour), 0.0000924 (last partial hour)
zero-gain hours: 0
```

116 identical bars. There is no weekend gap, no shape, nothing to read.

**2. The explanatory note describes a state that isn't on screen.** `UsageProfile.tsx:353`
reads "Flat stubs are hours the profile expects to be idle... The visible gap across the
weekend is what stops the projection landing on Saturday." With `confidence: none` there are
**zero** idle hours in the walk, so the note narrates a learned profile the user does not
have. The sliver at the right edge is the partial hour at the reset boundary, not a weekend.

**3. Bars are visibly uneven — device-pixel rounding, not a layout mistake.** `.up-wb` is
`flex:1; min-width:0` with `gap:1px` (`styles.css:802`), which gives fractional CSS widths;
the compositor then rounds each bar's two painted edges to device pixels independently.
Gaps stay exactly 1px, but the **bars** alternate +/-1px, and a narrower bar behind a
constant gap reads as "more spaced". Measured by injecting 118 real `.up-wb` nodes into the
live page, DPR 1:

| container | css bar width | painted widths |
|---|---|---|
| 640px | 4.4219 | 4px x67, 5px x51 |
| 800px | 5.7813 | 5px x25, 6px x93 |
| 950px | 7.0469 | 7px x111, 8px x7 |
| 1000px | 7.4688 | 7px x61, 8px x57 |

Painted gaps: `1px` x117 at every width. So the unevenness is entirely in the bars. At 640px
that is a 25% width swing between neighbours. This is the same class of Gestalt artefact as
the row-label rhythm bug already documented at `UsageProfile.tsx:56` — and like that one it
cannot be tuned away in CSS, because the rounding happens per element.

**4. The whole panel silently vanishes when idle.** `canWalk` in `server/api.ts:518`
requires `ratePerHour != null && > 0`. `ratePerHour` comes from the RAM-only sample ring in
`usage-pace.ts` and reads 0 when idle, so the strip appears and disappears within minutes.
Same server process, 7 minutes apart:

```
11:40 -> walk 118 steps, exhaustAt 2026-08-27T13:18:07Z
13:47 -> walk 0 steps,   exhaustAt null
```

`walk.length > 0` is the render gate, so the section unmounts with no text saying why. A
disclosure view that disappears when there is nothing burning is exactly backwards: idle is
a normal state and deserves a sentence.

**5. Hover already exists but answers the wrong question.** `tipHandlers` is wired to each
bar (`UsageProfile.tsx:342`) and shows `Thu 14:00` / `+2.1% this hour`. Per-hour gain is the
least useful number the walk holds — with a flat profile every bar says the same thing. The
question the strip poses is "when do I run out", i.e. the **cumulative** number. Also: the
walk deliberately covers the whole window past the crossing
(`usage-forecast.ts:76`) — live cumulative reached **249.6%** — and bars after 100% are drawn
identically to bars before it. The text says "hits 100% Thu 13:00"; the graph marks nothing.

## Direction (decided 2026-08-26)

**Direction 2 — a cumulative climb to a 100% ceiling — carrying direction 1's honesty
rules.** Reviewed against two rejected alternatives, each drawn twice (with and without a learned
profile), in `docs/guides/mockups/usage-profile-walk-strip-mockups.html` — beside the
heatmap mockup that settled the grid above it.

Every step of the walk already carries all four numbers the chart needs:

```
Wed 18:00      w=0.62        +1.33            -> 52.1
   |             |              |                 |
   |             |              |                 +- cumulative window % after this hour
   |             |              +- rate x w x hours, the per-hour cost
   |             +- learned weight: expected ACTIVE SHARE of that hour-of-week
   +- the hour slice, local time
```

Today's strip plots the third column. Direction 2 plots the fourth, against a dashed rule
at 100%. Same walk, same rows, no new server computation — the choice is only which column
becomes the y-axis.

**Why the fourth column wins.** The panel exists to answer "when does the weekly window hit
100%". A per-hour bar chart makes the reader integrate 117 bars to get there; a cumulative
curve puts the answer at the intersection with the ceiling. And the per-hour auditing that
direction 1 is good at is already done better by the 24x7 heatmap directly above it — the
strip was competing with its own card.

**Rejected: hybrid (curve over bars).** Two y-axes in one 120px box, neither labelled, and
at ~8px per bar the ground layer is texture rather than data. Rejected on purpose, not by
omission.

**The example that settled it.** Same facts from the running server (45% spent,
2.15%/active-hour, reset Mon 10:00, 117 hours to walk), with and without a learned profile:

| state | idle hours | crossing | ends the week at |
|---|---|---|---|
| no learned profile (today) | 0 | Thu 15:00 | 294.7% |
| learned profile | 40 | never | 89.7% |

Identical inputs; one says "dead Thursday afternoon", the other "finish at 90%". Under
direction 2 the second is a staircase visibly levelling off below the ceiling. Under the
current strip both are a wall of near-identical bars.

## Rough shape

Ordered by value per unit of risk. 1-3 are the recommendation; 4-5 are the same edit's
natural neighbours.

**1. Solid = measured, ghost = assumed.** Not a reversal of the fill — a split of it. Bar
*height* must not change: the projection genuinely counts an unlearned hour at `globalMean`,
and that pessimistic edge is deliberate (`usage-forecast.ts:12`). Only the ink changes: an
hour whose bucket carries a real weight draws solid; an hour standing on the fallback draws
as a hatched or outlined ghost at the same height. Consequence worth stating plainly: while
`confidence: none`, the strip is **entirely** ghost — which is the honest picture and makes
defect 2's note redundant.

Needs a per-step "was this learned" bit. `ForecastStep` (`shared/types.ts:128`) carries only
`{t, gain}`. Options: add `learned: boolean` (or the `weight` itself) to `ForecastStep`; or
have the client recompute `hourOfWeek(t)` and look the cell up in `cells`. Prefer the server
field — the client would be re-deriving `hourOfWeek` with its own timezone arithmetic, which
is precisely the off-by-one the `usageProfile.ts` docstring warns about. Carrying `weight`
rather than a bool also feeds shape 4's tooltip for free.

**2. Cumulative % in the tooltip, plus the crossing.** `Thu 14:00 · +2.1% this hour ·
68% -> 70%`, and `past 100%` (or a de-emphasised style) once the running total crosses. One
running sum in the render, no new endpoint field. Keep the existing real-element tooltip —
`title` never fires on touch and this dashboard is read from a phone
(`UsageProfile.tsx:38`).

**3. Draw it as one SVG with a `viewBox`, as a cumulative curve.** Fixes defect 3 properly: bar geometry
becomes a uniform scale of one coordinate space instead of 118 independent roundings. It
also makes the rest cheap — a vertical rule at `exhaustAt`, day tick labels along the
bottom, and a shaded past-100% region are all trivial in SVG and all awkward in flexbox.
Hover stays on `<rect>` elements with the same `tipHandlers`, so touch behaviour is
unchanged. Colours must still come from tokens via `color-mix` — no literals below the theme
block (`styles.css`), and the ghost fill needs to hold in all five themes including light.
The alternative (integer bar widths computed from a `ResizeObserver` and a centred fixed-px
row) also removes the rounding but buys none of the other four things.

**4. Day ticks.** 118 unlabelled bars are unlocatable; "hits 100% Thu 13:00" cannot be found
on the chart. Ticks at local midnight, labelled `Thu` / `Fri`, plus a `now` marker at the
left edge.

**5. Say why the strip is absent.** Replace the bare `walk.length > 0` gate with a stated
reason: idle (`ratePerHour` 0) reads "no current burn rate — nothing to project from yet";
recording off already has its own copy; a missing weekly `utilization`/`resetsAt` reads as
such. Cheap, and it is the difference between "the feature is broken" and "there is nothing
to draw".

## Open questions

- **Does `ForecastStep` grow `weight` or `learned`?** `weight: number` (the value actually
  used, fallback included) plus `learned: boolean` (whether that value came from the bucket
  or the mean) is the honest pair, but it is two new wire fields for one strip. Decide
  before touching `shared/types.ts` — the type is the contract
  (`.claude/CLAUDE.md`, "Adding an API field").
- **Ghost as hatch or as outline?** The heatmap's "no evidence" texture is a hatch, and
  reusing it makes the two halves of the card read as one language. But a hatch at 5-7px
  wide may be indistinguishable from noise; an outlined bar with a transparent fill may
  survive small sizes better. Worth mocking both before committing — 2-3 static variants
  first, per the repo's habit of approving UI from mockups rather than prose.
- **Does the past-100% region get shaded, or just the crossing rule?** Shading two thirds of
  the strip (live cumulative was 249.6%) may dominate the graphic and bury the shape the
  ghost/solid split just exposed.
- **Should the strip fall back to a "here is what a learned week looks like" empty state**
  while `confidence: none`, instead of 116 ghost bars carrying no shape? Risk: a sample
  drawing on a disclosure panel is the one thing worse than an honest blank.
- **Is the intermittency (defect 4) really this idea's, or its own bug?** The vanish is a
  server-side gate, not a drawing problem, and it may deserve `bugs/` on its own.
- **Does anything else consume `ForecastStep`?** Only this strip today; confirm before
  widening it.
