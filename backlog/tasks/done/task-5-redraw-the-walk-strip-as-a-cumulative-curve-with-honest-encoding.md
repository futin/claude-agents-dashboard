---
id: task-5
title: Redraw the walk strip as a cumulative curve with honest encoding
created: 2026-08-26
from: idea-6
tags: ui, usage, forecast
---

## Goal

Make the forward-walk strip in the Usage tab answer the question it exists for — *when does
the weekly window hit 100%, and is that a measurement or a guess?* — instead of drawing 117
near-identical bars whose encoding contradicts the heatmap above it.

Background, the measured defects, and the two rejected alternatives are in `idea-6`. The
direction was chosen from
`docs/guides/mockups/usage-profile-walk-strip-mockups.html`: **a cumulative climb to a 100%
ceiling, carrying the ghost/solid honesty rules from the per-hour variant.**

Scope boundary, deliberate: **no projected number changes.** `walkForward`'s arithmetic, the
weight model in `usage-history.ts`, and the heatmap are all untouched. This task changes what
is drawn and what is disclosed, nothing that is computed. Any diff that moves a forecast
value has escaped its scope.

## Plan

### 1. Wire contract first (`shared/types.ts`)

The type is the contract, so it moves before either side. `ForecastStep` gains three fields:

```ts
export interface ForecastStep {
  t: string;
  gain: number;
  /** Window % consumed after this hour — the curve's y value. */
  cum: number;
  /** The weight actually used for this hour, 0–1 (globalMean when untrusted). */
  weight: number;
  /** True when `weight` came from the bucket; false when it is the fallback. */
  learned: boolean;
}
```

Two decisions worth not re-litigating during implementation:

- **`cum` is server-side, not a client running-sum.** `UsageProfileResponse` carries no
  `utilization`, so the client has nothing to seed a sum from; and `exhaustAt` is derived
  from these same partial sums, so computing them twice in two languages invites exactly the
  drift `shapeUsageProfile`'s docstring promises can't happen.
- **`learned` is not derivable from `weight`.** A measured `1.0` and a fallback `1.0` are the
  same number and different statements. Deriving it client-side would mean re-implementing
  `hourOfWeek` timezone arithmetic in the browser — the off-by-one `usageProfile.ts` already
  warns about.

`UsageProfileResponse` also gains:

```ts
walkAbsent: null | 'recording-off' | 'no-rate' | 'no-window';
```

`null` whenever `walk` is non-empty. Only consumer of both types today is
`UsageProfile.tsx` (verified by grep), so there is no compatibility burden.

### 2. Server fills them

- `usage-forecast.ts` — `ForecastStepMs` gains the same three fields; `walkForward` already
  tracks the running total and the per-slice weight internally, so this is exposing state it
  has rather than computing anything new. `learned` comes from whether
  `profile.weights[hw]` was non-null, i.e. the branch `weightAt` already takes.
- `api.ts` — `shapeUsageProfile` maps the new fields through, and sets `walkAbsent` from the
  branch of `canWalk` that failed: recording off → `recording-off`; rate null or 0 →
  `no-rate`; utilization null or `resetsAt` unparseable → `no-window`.

### 3. Pure geometry module (`client/src/lib/walkChart.ts`, new)

Everything with arithmetic in it goes here so it can be unit-tested without a DOM. This is
where the real bug risk lives; the component should end up with no arithmetic of its own.

- **y scale** — fixed domain `0 → 130%`, clamped, never NaN. Not auto-scaled to the
  endpoint: a walk that ends at 294.7% would squash the 100% rule into the bottom third, and
  every value above 100% is equally "over".
- **run splitter** — turn the step list into consecutive runs of equal `learned`, each
  emitted as its own point list, with **adjacent runs sharing their boundary point** so the
  line has no gap where the encoding changes. A single `<polyline>` cannot be half-dashed;
  this is why the splitter exists.
- **tick positions** — one per local midnight within the walk, plus `now` at the left edge.
- **tooltip text builder** — the same shape as the existing `cellTitle`: hour, `+gain this
  hour`, `cum% consumed`, then either `weight N% — measured, K weeks` or `weight N% —
  assumed (no evidence)`, plus a `past 100%` line once `cum` has crossed.

### 4. The component (`UsageProfile.tsx`)

Replace the flex bar strip with one SVG: `viewBox` + `preserveAspectRatio="none"`, and
`vector-effect: non-scaling-stroke` on every stroked element. That combination is what
structurally removes the ±1px painted-width artefact — it is not a tuning fix, the geometry
becomes one uniform scale of a single coordinate space.

Contents, back to front: dead-zone fill right of the crossing (≈5% opacity), day ticks,
dashed 100% ceiling rule, the area fill, one polyline per `learned` run (solid = measured,
dashed = assumed), the crossing rule and its label, then full-height transparent `<rect>` hit
targets — one per hour — carrying the existing `tipHandlers`. Full-height so the touch target
is a column and not a 2px line; keep the real-element tooltip, never `title`.

When `walk` is empty, render one line from `walkAbsent` instead of unmounting the section.

Delete the current note about "flat stubs" and "the visible gap across the weekend" — it
describes a state the chart no longer has, and described one the user didn't have even before.

### 5. Styles

Replace the `.up-walk*` rules. Tokens only, no literal colour or shadow, and check all five
themes — the light one is where a hardcoded value or a too-faint dead-zone fill will show.

## Test cases

Backend cases in `test/usage-profile-api.test.ts`, pure view cases in a new file beside
`test/usage-profile-view.test.ts`.

1. **`cum` is coherent** — the last step's `cum` equals `utilization + Σgain`; the step whose
   `cum` first reaches 100 is the one containing `exhaustAt`.
2. **`learned` tracks the trust floor** — false for a bucket with
   `lifetimeObservedMin < 60`; true for one at or above it that has folded. A bucket at the
   floor whose weight is still `null` (past the floor, not yet folded) must report false, not
   crash — that state is reachable for up to a week.
3. **`walkAbsent`** — `no-rate` when `ratePerHour` is 0 and when it is null;
   `recording-off` when recording is false; `no-window` for an unparseable `resetsAt` and for
   a null `utilization`; `null` whenever `walk` is non-empty.
4. **run splitter** — all-assumed → exactly 1 run; all-measured → 1 run; alternating
   learned/assumed → N runs where each run's first point equals the previous run's last point.
   A single-step walk → 1 run of 1 point without throwing.
5. **y scale** — exact at `cum` 0 and 100; clamped (not NaN, not negative height) at 294.7;
   monotonic across the domain.
6. **ticks** — one tick per local midnight in the walk, none duplicated, and a walk spanning
   a DST transition still yields one tick per calendar day when the day is 23 or 25 hours
   long.
7. **tooltip text** — an assumed hour says `assumed`, a measured one says
   `measured, K weeks` with K from `observedMin / 60`, and a post-crossing hour includes
   `past 100%`.

Every guard here gets mutation-checked: delete the guard, confirm the test goes red. A test
that stays green without its guard proves nothing. Case 3 in particular is four branches that
all currently produce the same empty array — check each fails independently.

## Done when

- `pnpm typecheck` and `pnpm test` both pass, with the printed case count quoted in the PR
  body rather than asserted as "green".
- The strip renders as a cumulative curve against a 100% ceiling, with measured runs solid and
  assumed runs dashed, verified in the browser at both `confidence: none` (all dashed, straight
  diagonal) and with at least one trusted bucket present.
- Hovering any hour shows cumulative %, the weight, and whether it was measured or assumed;
  verified by press-and-hold on a phone-width viewport, not only by mouse hover.
- Going idle no longer unmounts the section — it shows the `no-rate` line. Reproducible by
  waiting out the pace ring, or by forcing `ratePerHour` to 0.
- No painted-width unevenness at any container width: re-run the bar-geometry measurement from
  `idea-6` against the new SVG and confirm a single distinct painted stroke width.
- All five themes checked, light included. No literal colour or shadow added to `styles.css`.
- No forecast number moved: `exhaustAt` for a given input is identical before and after.

## Outcome

**2026-08-26 — done.** The strip is now one SVG cumulative curve against a dashed 100%
ceiling: measured runs solid, assumed runs dashed at the same height, a crossing rule with
its time label, day ticks, a faint over-window wash, and a full-height transparent hit
column per hour carrying the existing real-element tooltip. `walk` empty now renders a
`walkAbsent` sentence instead of unmounting the section.

Built as planned, on branch `feat/walk-strip-cumulative-curve`:

- `shared/types.ts` — `ForecastStep` gained `cum` / `weight` / `learned`;
  `UsageProfileResponse` gained `walkAbsent`.
- `server/lib/usage-forecast.ts` — `ForecastStepMs` carries the same three; new
  `isLearnedAt` names the branch `weightAt` already took.
- `server/api.ts` — `shapeUsageProfile` maps them through and sets `walkAbsent` from the
  `canWalk` branch that failed.
- `client/src/lib/walkChart.ts` (new) — all the arithmetic: `yOf`, `walkPoints`,
  `splitRuns`, `crossingX`, `dayTicks`, `hitRect`, `pctX`/`pctY`, `pointsAttr`,
  `areaPath`, `stepTitle`, `absentText`.
- `client/src/components/usage/UsageProfile.tsx` — new `WalkStrip` component; the old
  flex bar strip and its "flat stubs / weekend gap" note are gone.
- `client/src/styles.css` — `.up-walk*` rules replaced, tokens only.
- `test/walk-chart.test.ts` (new, 25 cases) + 6 cases added to
  `test/usage-profile-api.test.ts`.

### Two deviations from the plan, both deliberate

1. **The dead-zone fill is painted *after* the area fill, not before it.** At an opacity
   faint enough not to bury the curve (0.08) a wash under the 12% cyan area fill was
   invisible; measured in all five themes.
2. **`now` moved out of the day-label row into the chart's top-left corner.** At 375px the
   first midnight can be ~18px from the left edge, and the centred day label landed on top
   of `now` ("noThu"). The corner is empty by construction — the curve starts at the
   window's current utilization, never at the ceiling.

### Verification

`pnpm typecheck` — clean, no output. `pnpm build` — `✓ built in 1.03s`.

`pnpm test`:

```
=== /api/usage/profile shaping ===
  16 passed, 0 failed

=== walkChart.ts (forward-walk strip geometry) ===
  25 passed, 0 failed

ALL PASS
```

775 assertions across the whole suite (`grep -c '✓'`), up from 744.

**Mutation-checked, 20 guards, every one goes red when deleted** — including the four
`walkAbsent` branches failing *independently*, which was the specific worry in the plan:

```
M1  drop recording-off branch            → ✗ walkAbsent: recording off
M2  drop the zero-rate check             → ✗ walkAbsent: no-rate for both a zero rate and a null one
M3  drop the null-utilization check      → ✗ walkAbsent: no-window for an unparseable resetsAt and for a null utilization
M4  drop the resetsAt finite check       → ✗ walkAbsent: no-window for an unparseable resetsAt and for a null utilization
M5  learned always true                  → ✗ learned: true only for a bucket past the trust floor that has folded
M6  learned ignores the trust floor      → ✗ (2 tests)
M7  cum omits its own gain               → ✗ cum: the last step is utilization + Σgain …
M8  cum forgets utilization              → ✗ cum: the last step is utilization + Σgain …
M9  yOf: drop the clamp                  → ✗ yOf: clamps far past the ceiling …
M10 yOf: drop the NaN guard              → ✗ yOf: clamps far past the ceiling …
M11 splitRuns: drop the shared boundary  → ✗ splitRuns: alternating flags give N runs …
M12 dayTicks: emit a tick every hour     → ✗ (2 tests)
M13 crossingX: no interpolation          → ✗ crossingX: interpolates inside the hour that reaches 100
M14 stepTitle: assumed claims measured   → ✗ stepTitle: an assumed hour says assumed …
M15 stepTitle: weeks unscaled            → ✗ stepTitle: a measured hour reports its weeks …
M16 stepTitle: drop past-100%            → ✗ (2 tests)
M17 stepTitle: past-100% exclusive       → ✗ stepTitle: the ceiling line appears exactly at 100 …
M18 hitRect: no clamp at the edges       → ✗ hitRect: one column per hour …
M19 walkWidth: allow zero                → ✗ (2 tests)
M20 absentText: one sentence for all     → ✗ absentText: every reason gets its own sentence …
```

**No forecast number moved.** `walkForward`'s crossing and accumulation lines are
untouched in the diff; proved empirically by running the HEAD copy of `usage-forecast.ts`
against the new one over a 6×4×5×7×3 grid of utilization / rate / span / UTC offset /
profile:

```
flat-profile exhaustAt before/after: 1787836664678 1787836664678 IDENTICAL
2520 walks compared, 0 differences in exhaustAt / dutyCycle / tMs / gain
```

**Painted geometry, idea-6's measurement re-run against the SVG** (DPR 1, 115 interior hit
columns). One distinct painted width at every container width, where the old bars had two:

```
640px  | css col 5.2586 | painted 5px x115 | stroke 2px
800px  | css col 6.6379 | painted 7px x115 | stroke 2px
950px  | css col 7.9310 | painted 8px x115 | stroke 2px
1000px | css col 8.3621 | painted 8px x115 | stroke 2px
```

(idea-6, same widths, old strip: `4px x67, 5px x51` / `5px x25, 6px x93` /
`7px x111, 8px x7` / `7px x61, 8px x57`.)

**In the browser** (dev server on 5700, viewport 1100×900 and 375×812):

- Live idle account → the section stays mounted and reads *"No current burn rate — nothing
  to project from yet. The strip returns once this account starts spending again."* This
  was the real server's own state, not a fixture.
- `confidence: none` fixture (117 steps, ends at 296.1%, crosses Thu) → 1 polyline, 1
  dashed, 117 hit columns, crossing rule present, ticks `now/Thu/Fri/Sat/Sun/Mon`, crossing
  label matches the meta line. The curve clamps flat along the top of the box past 130%.
- Learned fixture → 7 polylines of which 3 dashed, each run starting where the previous
  ended; a visible staircase with flat overnight stretches.
- Tooltips, read off the live DOM: `Wed 18:00 / +1.8% this hour / 47% consumed / weight 85%
  — measured, 5 weeks`; `weight 34% — assumed (no evidence)`; and a post-crossing hour
  adding `past 100%`.
- All five themes checked (midnight, nightshift, graphite, amber, **daylight**). No literal
  colour or shadow added — `git diff client/src/styles.css | grep -E '#[0-9a-f]{3,8}|rgba?\(|box-shadow'` is empty.

### Not verified

- **Press-and-hold on a real touch device.** At 375×812 the tooltip was driven with a
  synthesised touch-type `pointerover`/`pointerenter`/`pointerdown` sequence on a hit
  column — the same React handler a finger goes through — and it opened at opacity 1 fully
  inside the viewport (box 145,541 222×72). The Browser pane went hidden partway through,
  so the tool's own tap could not be delivered; a human should confirm on a phone.
- **A live account with real learned buckets.** The machine's profile is still
  `confidence: none`, so the solid/dashed split and the staircase were exercised against
  fixtures shaped like idea-6's recorded figures, not against measured weights.
- DST behaviour is pinned by a test that forces `TZ=Europe/Berlin` over a 23-hour and a
  25-hour day and asserts one tick per calendar day. It does **not** discriminate
  date-keying from midnight-keying: for whole-hour UTC offsets the two agree, and the
  exotic case they differ on (a DST transition in a half-hour-offset zone) is untested.

### Follow-up, same day — two defects found in review

Both reported against the browser after the task was archived; fixed on the same branch.

**1. The fat blue bar on click/tap was a focus ring, not our styling.** `.up-hit-col` is
`tabIndex=0`, and a hit column is 6.8px wide on desktop and **2.6px** at 375px — so any UA
focus ring is *wider than the thing it rings*, and several engines (Safari most visibly)
draw theirs as a filled rounded halo that extends past the element box. Reproduced exactly
by forcing `outline:3px solid #2b4fd4` on one column: a solid blue bar at the "Sat" tick,
~13px wide, taller than the chart — the reported artefact. Our rule only ever said
`outline:none` inside `:hover,:focus-visible`, so a plain `:focus` (mouse click, touch tap)
never matched it.

Fixed by moving `outline:none` onto the base `.up-hit-col` rule (plus
`-webkit-tap-highlight-color:transparent`) and splitting hover from focus, so the focus
indicator is the wash itself — exactly one hour wide by construction — at
`fill-opacity:.3`. Verified with a real Tab press: `focusVisible: true`,
`fillOpacity: "0.3"`, `outlineStyle: "none"`.

**2. The tooltip floated off the bottom of the screen — two independent causes.**

- It defaulted to *below* the pointer and only flipped above near the bottom edge. Whatever
  points at a mark sits under it (a cursor a little, a finger a lot), so below is both the
  occluded side and the side that runs off screen. Now above by default, dropping under
  only when there is no room above, and clamped so it can never leave the viewport either
  way. Keyboard/scroll anchors moved from the mark's `bottom` to its `top` to match.
- The panel is `position: fixed` with no `right`, so the viewport edge caps its available
  width — measured while still sitting at its *previous* left near the right edge it
  reported a narrower box than it would occupy once moved, and the clamp then let it hang
  off by the difference (measured: `offsetWidth` 143 at rest, but placed at
  `left: 232.224px` when the cap was 224). Now `left`/`top` are reset to `0` before
  measuring.

Both fixes are in the shared `placeTip`, so the 24×7 heatmap's tooltip gets them too.

Verified at 1100×900 and 375×812 — cursor at the top edge, upper, middle, bottom edge, left
edge and right edge, plus five columns spanning the strip's full width and the first and
last heatmap cell: every one lands above the pointer where there is room, flips below where
there isn't, and satisfies `left>=8 && right<=innerWidth-8 && top>=8 && bottom<=innerHeight-8`.
`pnpm typecheck` clean, `pnpm test` ALL PASS (775), `pnpm build` `✓ built in 962ms`, no
console errors.

**Still not verified:** a real Safari session. The ring was reproduced by forcing an
outline in Chrome, which proves the geometry but not that Safari's own ring is what the
screenshot showed; `outline:none` on the base rule suppresses it in every engine either way.
