---
id: task-21
title: Record the weekly window and price one percent of the week per model
created: 2026-09-06
from: idea-12
---

## Goal

Persist the **weekly** rate-limit window beside the 5-hour one, join it against the same
token ledger, and publish what one percentage point of the week costs per model — the
number that actually constrains a week of work, which `task-8` and `task-20` never
measured because the record on disk is 5h-only.

### What the record looks like today

`.usage-history.jsonl` carries `{t, utilization, resetsAt}` for the **5-hour** window
only (`UsageSample`, `server/lib/usage-history.ts`), because that window is the sensor
the duty-cycle profile is learned from. `usage.ts` feeds `recordTick` `limits.fiveHour`
and drops `limits.sevenDay` on the floor. So there is nothing for a weekly fitter to
join against, and that — not the fitting — is the prerequisite.

### Measured, on this machine, 2026-09-06T09:03Z

The live weekly window opened `2026-08-31T07:59:59.840Z` (7 d before its published
`resetsAt` of `2026-09-07T07:59:59.840279+00:00`) and stood at **44%** after 6.04 days.
Over that same span the ledger recorded **293.34 M** weighted tokens across 5 918 lines,
and the 5h counter moved **1 470** points against 281.77 M weighted tokens:

| quantity | 5-hour window | weekly window |
|---|---|---|
| points moved over the span | 1 470 | 44 |
| points per day | ~243 | **7.3** |
| weighted tokens per point | **0.192 M** | **6.667 M** |
| raw tokens per point | — | 39.6 M |
| mean wall time per point | ~6 min | **~3.3 h** |

**A weekly point is worth ~34.8× a 5h point** on this machine's mix, and they arrive
~33× less often. Both figures are pooled across all models and both assume the weekly
window is 7 days *for the purpose of locating its start* — the fitted rate itself needs
no such assumption (see open question 2). Weighted-token share inside that window:
`claude-opus-5` 94.7%, `claude-fable-5-1` 2.0%, `claude-fable-5` 1.9%,
`claude-sonnet-5` 1.2%, `claude-haiku-4-5-20251001` 0.1%, `claude-opus-4-8` 0.0%.

**Dominance survives the coarser grain.** Re-joining the existing 5h series after
sub-sampling it to the cadence a weekly tick arrives at (a scratch probe over the same
logs, `joinIntervals` unchanged):

| min sample spacing | dominated | mixed |
|---|---|---|
| none (1/tick) | 999 intervals / 1102 pt | 108 / 150 pt |
| ≥ 30 min | 111 / 963 pt | 23 / 282 pt |
| ≥ 60 min | 52 / 784 pt | 12 / 282 pt |

So the pooled dominance estimator does **not** collapse at weekly grain — the fear that
long intervals are all `mixed` is wrong on this data. Mixed does take a larger share of
the *points*, which is exactly why the joint fit from `task-20` is carried over too.

### The three open questions, answered

1. **One log or two?** One log, one optional nested field per line. A second file needs
   a second rotation policy, a second write path and a join by time between two files
   written on different grids — strictly more machinery for the same data. A line that
   lacks the field is legitimately weekly-less, not corrupt, so absence *is* the version
   marker and no `v:` key is needed. `idea-5` anticipated this exact shape.
2. **Does a weekly rate care that the weekly window's length is unproven?** **No, and
   this must stay true.** The rate is weighted tokens per Δutil *inside* one window; the
   only thing it needs from `resetsAt` is whether two samples sit in the same window,
   which `sameWindow` answers by comparing stamps. The one place a window *length* is
   used — `provableIdleSpan`'s `WINDOW_MS` — belongs to profile learning, which stays
   5h-only. Nothing added here may import a `SEVEN_DAY_MS`. The ⚠️ in
   `docs/subsystems/usage-limits.md` already tracks two dependencies on that assumption;
   this task must not become the third, and the doc should say so out loud.
   Corroboration that the window **steps** rather than slides, which is the failure that
   would make every weekly interval a `reset`: at 2026-09-06T09:03Z the published weekly
   `resetsAt` was `2026-09-07T07:59:59`, not `now + 7 d` (`2026-09-13T09:03`). It is
   anchored to a fixed start. Confirm it again against recorded data (test case 14) —
   one observation is an argument, not a proof.
3. **Are the 5h confidence floors right for a ~1%-integer-step series?** Partly. Two
   distinct things were conflated in the idea:
   - **Quantization is not the problem.** The pooled ratio is `Σtokens / Σ dUtil`, and
     over one window the rounding in `Σ dUtil` telescopes to `u_end − u_start` — a total
     error of ≤ 1 point however many intervals it spans. Over a 7-day fit (~51 points,
     ≤ 2 windows touched) that is ≤ 4%, well inside any floor.
   - **Pairing is the problem, and it is fatal if ignored.** The history log writes a
     line whenever the *5h* counter moves — ~1 line per 6 min. Between two weekly ticks
     ~33 such lines land, so pairing consecutive samples the way `joinIntervals` does
     yields ~33 intervals with `dUtil = 0` (classified `idle`, excluded from `pool` by
     `ownedBy`) and one interval carrying 1 point with ~1/33 of the tokens. **The pooled
     weekly rate would read roughly 33× too low, with every unit test green.** Hence
     `joinWeeklyIntervals` pairs tick to tick, not sample to sample (Plan §2).

   The floors themselves are then re-derived for the weekly grain in Plan §3 — the 5h
   values are not simply reused.

### Out of scope, deliberately

- **No weekly drift verdict.** `DRIFT_PCT` was set from a *measured* day-to-day
  dispersion of the 5h rates (cv ≈ 24%). No such measurement exists for the weekly
  series and none can exist until weeks of it are on disk. Ship the rate with its
  evidence; a weekly baseline and verdict is a later item.
- **No two-term (per-request) split for weekly.** The split separates a per-request term
  from a per-token one by exploiting interval-level variation in the request:token
  ratio. A ~3.3 h interval carrying thousands of requests averages that variation away,
  so the design would be rank-deficient and `explainRates`' independence gate would
  refuse it anyway. Do not wire `fitSplits` to the weekly set.
- **Seeding the weekly pace ring.** `usage-history.ts:728` seeds only `'fiveHour'` from
  the log, so `sevenDay.ratePerHour` is null for hours after a restart. Once the weekly
  series is on disk that becomes a one-line fix — worth its own item, not this one.
- **The history *view*** from `idea-5` (a backward chart, `GET /api/usage/history`).
  This task widens the record `idea-5` needs but adds no such endpoint.
- **Refreshing the usage tutor deck.** A deck only watches the files its own stamp
  cites; new fields need a new lesson. Separate item.

## Plan

**Plan-format override, deliberate, per `.claude/CLAUDE.md`:** behaviour, signatures and
exact test *cases* only — **no literal code blocks**. Handed code gets transcribed
verbatim and a bug here becomes a bug in the branch with nobody positioned to catch it.
Disagree with anything below in the PR body rather than transcribing around it. Any size
figure below is a soft target.

### 1. Widen the record — `server/lib/usage-history.ts`, `server/lib/usage.ts`

- `UsageSample` gains an **optional** `week?: { utilization: number; resetsAt: string | null }`.
  Optional, not nullable: every line written before this lands has no weekly reading at
  all, and `undefined` says that where a `null` utilization would claim a measured zero.
- `usage.ts` passes `limits.sevenDay` into `recordTick` alongside the 5h reading, under
  the same `recordUsageHistory` gate and the same try/catch. Omit `week` entirely when
  `limits.sevenDay.utilization` is null — a window the endpoint did not report is not a
  window at 0%.
- `shouldWrite` fires additionally when the weekly utilization moves by more than its
  epsilon **or** the weekly window changes (`sameWindow` on the weekly `resetsAt`). Both
  matter: without the first, a weekly tick during a 5h-flat stretch is only captured at
  the 15-minute heartbeat; without the second, a weekly reset lands up to 15 minutes
  late and the interval that straddles it is mis-scoped. In practice this adds almost no
  lines — the weekly counter rarely moves while the 5h one is still.
- `parseSample` reads `week` defensively, exactly as it reads `resetsAt`: present and
  well-shaped → kept; anything else → the field is absent, not a thrown parse.
- **`rotateIfNeeded` is the trap.** It rewrites the file as
  `readRecentSamples(...).map(JSON.stringify)`, so any field `parseSample` drops is
  **silently destroyed at the next rotation** — weeks of weekly series gone with no
  error. A test must pin the round trip (case 3).
- **Profile learning stays 5h-only.** `classifyInterval`, `provableIdleSpan`,
  `accumulate`, `foldBucket` and the classifier ring must not read `week`. A diff that
  touches any of them means the scope slipped. Say so in the module header.
- Line growth: ~82 → ~140 bytes. `MAX_HISTORY_BYTES` (32 MB) still holds well over a
  year; leave it alone.

### 2. Weekly intervals — `server/lib/usage-rate.ts`

New `joinWeeklyIntervals(samples, ledger, ledgerStartMs = null): Interval[]`, producing
the **same** `Interval` shape so every downstream estimator is reused unchanged.

Pairing is **tick to tick**, for the reason in open question 3:

- Ignore samples with no `week` (pre-widening lines) — they carry no weekly reading and
  must not close or open an interval.
- Walk the remaining samples in order. Hold the sample that last *changed* the weekly
  utilization. When a later sample shows a different weekly utilization, emit one
  interval spanning `[held.t, current.t]` with `dUtil` = the weekly rise, then make the
  current sample the new held one. Runs of identical weekly utilization collapse into
  the interval that ends at the tick.
- A weekly window change (`sameWindow` false on the weekly `resetsAt`) closes the run
  without emitting: utilization is cumulative only *within* a window. The next sample
  starts a fresh held sample. Same rule as `joinIntervals`, applied to the weekly stamp.
- A weekly utilization **drop** inside one window discards the run rather than clamping
  — upstream is wrong, and a clamped interval contributes tokens with no price.
- The trailing partial run — tokens spent since the last tick, no tick yet — is not
  emitted. It is censoring, not bias: it is one interval at the end of the window.
- `gather`, `classify`, `dominantModel` and the rest are called exactly as
  `joinIntervals` calls them. Edge-tick pro-rating is a *smaller* relative
  approximation here than at 5h (two ~88 s ledger ticks against a ~3.3 h interval).

`classify` gains an `externalMax` parameter, defaulted to the existing
`EXTERNAL_WEIGHTED_MAX` so `joinIntervals` is behaviourally untouched.
`joinWeeklyIntervals` passes a new `EXTERNAL_WEIGHTED_MAX_WEEKLY`.

- `EXTERNAL_WEIGHTED_MAX_WEEKLY = 175_000`, derived as `EXTERNAL_WEIGHTED_MAX × 34.8`,
  the measured ratio of weighted tokens per point between the two windows (Goal table),
  rounded. The rule it preserves is the one the 5h constant encodes: *a point that rose
  on essentially no local spend was another device.* Mark it provisional in the JSDoc,
  with the measurement's date, and re-derive it from the first live weekly fit.
- Coverage keeps `LEDGER_COVERAGE_MIN` at 0.8 and this is **correct, not a false
  negative**: a collapsed weekly interval that spans an overnight sleep genuinely has no
  ledger for most of its span, so we cannot know whether another device spent inside it.
  Expect roughly one `partial` weekly interval per night on a laptop that sleeps, and
  more of them than at 5h grain simply because the intervals are ~35× longer and so
  ~35× more likely to contain a recorder break. Disclose it via the existing coverage
  breakdown rather than by loosening the floor.

### 3. Weekly rates — `server/lib/usage-rate.ts`

- `WEEKLY_RATE_MS = 7 * DAY_MS` and `weeklyRange(nowMs)` → `[now − 7 d, now)`.
  Deliberately **not** `CURRENT_MS` (3 d): three days of weekly ticks is ~22 points
  against the ~500 that three days of 5h ticks gives, and one full weekly window's worth
  of ticks (~51 points) is the natural unit for a number about a week. Write the reason
  in the JSDoc — a constant that merely differs from its neighbour invites being
  "fixed".
- `WEEKLY_FLOORS: RateFloors = { minIntervals: 10, minUtil: 10, minDays: 4 }`, each
  derived rather than copied:
  - `minIntervals: 10` — as `CURRENT_FLOORS`; at 7.3 points/day it is reached in ~1.4
    days, so it is the day floor that actually binds.
  - `minUtil: 10` — 10 points bounds the ≤ 1-point quantization error at ≤ 10%, and is
    ~67 M weighted tokens: a real measurement, not a rounding artefact.
  - `minDays: 4` — the same fraction of the fit window `CURRENT_FLOORS` asks for (2 of 3
    days), applied to 7 days and rounded down. Four distinct dates cannot be one working
    day plus its midnight neighbours.
- The pooled weekly rate is `rateFor(weeklyIntervals, model, weeklyRange…, WEEKLY_FLOORS)`
  — `pool` and `rateFor` are already window-agnostic and take no change.
- The jointly-fitted weekly rate reuses `explainRates` / `fitRates`, which today
  hardcode `CURRENT_FLOORS` (`usage-rate.ts:1099`). Give both an optional trailing
  `floors: RateFloors = CURRENT_FLOORS` parameter and pass `WEEKLY_FLOORS`. A hardcoded
  floor inside a function otherwise pure in its inputs is the only change either needs.
- **No weekly `driftRow`, no weekly baseline, no weekly `fitSplits`.** See Goal §Out of
  scope.

### 4. The contract — `shared/types.ts` first, then producer, then consumer

- New `ModelWeeklyRate`: `weightedPerPct`, `rawPerPct`, `fittedWeightedPerPct` (all
  `number | null`), `verdict` and `fitVerdict` (reuse the existing `ModelFitVerdict` —
  `'fitted' | 'thin'`; do not add a third verdict alias), and the evidence trio
  `intervals`, `utilSum`, `days`.
- `ModelRateRow` gains `weekly: ModelWeeklyRate`, **always present**. A thin weekly
  reading is a `thin` verdict with null rates and zeroed counters, the shape this file
  already uses for the 5h fit — not an absent key the card has to null-check.
- `UsageRatesResponse` gains three top-level fields:
  - `weeklyRecorded: boolean` — did **any** sample in the read window carry a `week`
    field. This is the one that keeps the first fortnight honest: it separates "the
    record predates the widening" from "the weekly counter has not moved".
  - `weeklyCoverage: UsageCoverage` — the same breakdown over the weekly interval set.
  - `weeklyExternalSharePct: number | null`.
- `emptyRates` gains all three, zeroed/false, on the same reasoning its `coverage`
  already is.
- `shapeUsageRates` builds the weekly interval set once, unions the weekly models into
  the row set it already builds (a model priced only weekly still gets a row), and fills
  `weekly` per row over `weeklyRange(nowMs)`. `weeklyCoverage` and
  `weeklyExternalSharePct` use the same `nowMs − BASELINE_MS → +∞` horizon the 5h
  disclosure figures use, so no two figures on one card span different windows.
- Row sort order is unchanged (`utilSum` desc, then model name) — the 5h `utilSum`, not
  the weekly one. A weekly-only model sorts last, as a fitted-only model already does.

### 5. The card — `client/src/lib/usageRatesFormat.ts`, `components/usage/UsageRates.tsx`

- New pure `weeklyAsideText(pooled, fitted)` → **one** line, or `null` when both are
  null (the rule `rawAsideText` and `fittedAsideText` already set: omit the line, never
  print a dash for a measurement nobody made). Naming the week is the whole point —
  the line must not read as another 5h figure. Both numbers when both exist, each
  labelled by its estimator; whichever one exists when only one does.
- `Row` renders it as a fourth aside, under the fitted line. It owns no threshold and
  makes no comparison to the 5h rate: the two are different quantities, and a ratio
  between them would read as a conversion factor the data does not support.
- The card subtitle gains one sentence: the weekly figure prices a point of the *weekly*
  limit, it has no drift verdict because no baseline dispersion has been measured for
  it, and it is no more comparable across models than the others.
- When `recording` is true and `weeklyRecorded` is false, show one note: the weekly
  series began recording with this build, and the column fills as the counter ticks
  (~7 points a day on recent use, first rate after ~4 days). Without this the card shows
  four empty weekly slots and reads as broken.

### 6. Probe and docs

- `scripts/probe-usage-split.ts` gains `--weekly`: build the weekly interval set, print
  the kind tally with points, print the pooled and fitted weekly rates per model with
  their refusals, and print **how many samples carried a `week` field** out of the total.
  This is the instrument for test case 14 and the early-warning for a sliding window.
- `docs/subsystems/usage-limits.md`: a new section covering the widened record, the
  tick-to-tick joiner and *why* consecutive-sample pairing would read ~33× low, the
  weekly floors with their derivations, the measured 34.8× ratio with its date, and an
  explicit statement that the weekly rate adds **no** third dependency on the unproven
  weekly window length. Update the existing ⚠️ to say so.
- `docs/overview.md` §Map: the new exports and the probe flag.

## Test cases

House style: node-assert, registered in `test/run-all.ts`, tmpdir JSONL fixtures where a
file is needed. Cases 1–3 extend `test/usage-history.test.ts`; 4–9 belong in a new
`test/usage-rate-weekly.test.ts`; 10–12 extend `test/api-usage-rates.test.ts`; 13 extends
`test/usage-rates-format.test.ts`. Build fitter fixtures by generating `dUtil` from a
known coefficient per model so every expected value is exact; assert to a relative
tolerance of 1e-6.

1. **`shouldWrite` on the weekly axis.** Two samples with identical 5h readings inside
   the heartbeat, whose weekly utilization differs by 1 → true. Identical weekly
   utilization but a weekly `resetsAt` 7 days later → true. Both axes identical and
   inside the heartbeat → false. Assert the mirror too: a 5h change with no weekly
   reading at all on either sample still returns true, so pre-widening behaviour is
   untouched.
2. **Old lines stay valid.** A fixture file of pre-widening lines (no `week` key) reads
   back through `readRecentSamples` with `week` undefined on every sample and no line
   skipped. Mixed files — some lines widened, some not — read back in order with the
   right samples carrying the field.
3. **Rotation preserves the weekly field.** Write past `maxBytes` with widened lines,
   run `rotateIfNeeded`, read back: every surviving sample still carries its `week`.
   **Mutation-prove it** — with `week` removed from `parseSample`'s output the test must
   fail. Record that failure in the PR; a round-trip test that passes with the field
   dropped proves nothing.
4. **Tick-to-tick collapsing, and the bug it exists for.** A fixture of 40 samples
   inside one weekly window: the weekly utilization holds at 10 for 33 samples then
   steps to 11, with ledger tokens spread evenly across all 33 spans. Expect
   `joinWeeklyIntervals` to return **one** interval, `dUtil` 1, carrying **all** the
   tokens. Assert in the same test that `joinIntervals` over the identical input returns
   33 intervals of which 32 are `idle` — the contrast *is* the assertion, and it is the
   ~33× error this design exists to avoid.
5. **A weekly window change closes without emitting.** Samples whose weekly `resetsAt`
   jumps by 7 days mid-run: no interval spans the boundary, and the run after it starts
   fresh. A weekly stamp jittering by under two minutes is the *same* window and must
   not close anything (`sameWindow`, already tested for 5h — assert it holds on the
   weekly stamp too).
6. **Samples with no `week` are skipped, not treated as zero.** A run of pre-widening
   samples between two widened ones must neither open, close, nor split an interval; the
   emitted interval spans from the first widened tick to the next one, tokens included.
7. **A weekly drop discards rather than clamps.** Weekly utilization falling inside one
   window emits nothing for that run, and the next rise starts from the sample after it.
8. **The weekly external threshold is the one in force.** An interval whose weighted
   tokens sit between `EXTERNAL_WEIGHTED_MAX` (5 000) and
   `EXTERNAL_WEIGHTED_MAX_WEEKLY` (175 000) classifies as `external` in the weekly set
   and as a `{model}` interval in the 5h set from the same tokens. Assert both
   directions in one test — that asymmetry *is* the parameter.
9. **`WEEKLY_FLOORS` bite at the documented boundary.** A model with 9 weekly intervals
   → `rateFor` null. The same model at 10 intervals / 10.0 points / 4 distinct UTC dates
   → a rate. Then each floor alone, in the mirror direction: 10 intervals but 3 dates →
   null; 10 intervals over 4 dates but 9.0 points → null. A floor that only ever passes
   is a decoration.
10. **`weeklyRecorded` separates absence from stillness.** Samples with no `week` at all
    → `weeklyRecorded` false with an empty weekly coverage. Samples carrying `week` whose
    weekly utilization never moves → `weeklyRecorded` **true**, still no weekly rates.
    These two must not look alike in the body.
11. **A weekly-only model gets a row.** A fixture where model B owns no 5h interval and
    no 5h fit but does own weekly ones → exactly one row for B, with every 5h number
    null / `thin` / zero and `weekly.weightedPerPct` set. Assert the row's position: it
    sorts last, because sorting is on the 5h `utilSum`.
12. **`weekly` is always present.** Every row in every fixture — including the richest
    5h model with no weekly evidence — carries a `weekly` object, `thin` verdicts, null
    rates and zeroed counters. Assert the key exists rather than that it is truthy.
13. **`weeklyAsideText`** — exact strings, pinned: `(null, null)` → **null**, never
    `'—'`; pooled only → a line naming the week and the pooled rate with no fitted
    clause; fitted only → the same shape for the fitted rate; both → one line carrying
    both, each labelled. Magnitudes come from `formatTok`, so assert one value in the
    millions band (a weekly rate is ~6.7 M, the top band). Every pre-existing case in
    `test/usage-rates-format.test.ts` must be untouched — a diff that edits one means the
    change leaked.
14. **Live-data check, not a unit test.** After the recorder has run for at least a few
    hours on the branch, run `tsx scripts/probe-usage-split.ts --weekly` against this
    machine's real logs and paste the output into the PR. Green unit tests are not
    evidence here: the first version of the 5h join classified **759 of 759** real
    intervals as `gap` with the whole suite passing. Specifically report:
    (a) how many samples carry a `week` field; (b) the weekly kind tally — **if
    everything lands in `reset`, the weekly window slides and the whole design is
    refuted; say so plainly rather than shipping a card that will never fill**;
    (c) whether the aggregate weighted-tokens-per-weekly-point is near the 6.667 M
    measured in the Goal, and re-derive `EXTERNAL_WEIGHTED_MAX_WEEKLY` from it.
15. **In the browser (playwright MCP tools):** open http://localhost:5174, click
    **Usage** in the left rail, then the **Token value** sub-tab. With a fresh weekly
    series the card must show the "weekly series just started recording" note and no
    weekly asides. Confirm the 5h rows, badges, raw and fitted asides are **unchanged**
    from before the branch, the subtitle names the weekly figure and says it has no
    drift verdict, and there are no console errors. If enough weekly ticks have accrued
    by then, screenshot a row showing the weekly aside instead and state which case you
    saw.

## Done when

- `UsageSample` carries an optional `week`, `usage.ts` feeds it from `limits.sevenDay`,
  `shouldWrite` fires on both axes, and `parseSample` + `rotateIfNeeded` round-trip it —
  with case 3's mutation check recorded in the PR.
- No profile-learning function reads `week`. A diff touching `classifyInterval`,
  `provableIdleSpan`, `accumulate` or `foldBucket` means the scope slipped.
- `joinWeeklyIntervals` pairs tick to tick, returns the existing `Interval` shape, and
  case 4 pins the contrast against `joinIntervals` on identical input.
- `EXTERNAL_WEIGHTED_MAX_WEEKLY`, `WEEKLY_RATE_MS`, `weeklyRange` and `WEEKLY_FLOORS`
  exist with their derivations in the JSDoc, and `classify` / `explainRates` /
  `fitRates` take the new parameters with defaults that leave the 5h path byte-identical
  in behaviour.
- Nothing added anywhere imports or defines a weekly window *length*. `grep` for
  `SEVEN_DAY_MS` in `usage-rate.ts` must find nothing.
- No weekly drift verdict, no weekly baseline, no weekly two-term split exists.
- `ModelRateRow.weekly` is always present; `UsageRatesResponse` carries
  `weeklyRecorded`, `weeklyCoverage` and `weeklyExternalSharePct`, all three present in
  `emptyRates`.
- The card renders the weekly aside, omits it entirely when there is no weekly rate,
  shows the "just started recording" note while `weeklyRecorded` is false, and its 5h
  rows are visibly unchanged.
- `scripts/probe-usage-split.ts --weekly` works and its output is in the PR (case 14),
  including the explicit statement of whether the weekly window steps or slides.
- `docs/subsystems/usage-limits.md` has the new section with the measured figures and
  their date, its weekly-length ⚠️ says a third dependency was considered and
  deliberately not added, and `docs/overview.md` §Map is updated.
- `pnpm test`, `pnpm typecheck` and `pnpm build` all pass with the command output pasted
  in the PR — never a green claim without it.
- The PR states what was **not** verified. At minimum: the weekly rate's day-to-day
  dispersion is unmeasured, so no drift threshold for it is claimed; and if case 14 ran
  before four days of weekly ticks accrued, say that the published weekly rates have
  never been seen non-null on live data.
