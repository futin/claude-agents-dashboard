---
id: task-21
title: Record the weekly window and price one percent of the week per model
created: 2026-09-06
from: idea-12
updated: 2026-09-06T17:48:07Z
started: 2026-09-06T17:10:24Z
execute-elapsed: 2263
execute-tokens: 331927
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

### The week this was groomed in was not a normal week

User-reported, 2026-09-06: Anthropic reset the weekly counter **twice** inside one
nominal week — Tuesday 2026-09-01 from ~50% to 0, and Friday 2026-09-04 from ~85% to 0 —
and the account consumed **over 200%** of a nominal week's allowance as a result. The
live window at 2026-09-06T09:03Z stood at 44% with a published `resetsAt` of
`2026-09-07T07:59:59.840279+00:00` (a Monday). Read as boundaries at 07:59:59Z on
09-01 / 09-04 / 09-07, that is a **72-hour** cadence, which is exactly what
`docs/subsystems/usage-limits.md`'s existing ⚠️ records as conflicting community
reports. The user expects normal behaviour to resume the following week.

**This is evidence for the design, not against it,** and it is why the numbers below are
a bracket rather than a figure. Three consequences run through the whole task:

- Every "tokens per weekly point" figure measured *without* a recorded weekly series has
  to guess where each window instance opened, and this week that guess is wrong twice.
  **The fitted rate this task builds needs no such guess** — it reads Δutil the recorder
  actually observed. That is the strongest argument for shipping the recording half.
- A mid-window reset is now an *observed* event, not a hypothetical. The joiner must
  handle utilization falling to zero inside what looks like one window (Plan §2, case 7).
- Nothing here may assume a weekly window length, or a cadence. See open question 2.

### Measured, on this machine, 2026-09-06T09:15Z

The ledger begins `2026-08-31T07:42:01Z`, so only the two window instances after that are
fully priced; the instance that reset on Tuesday is mostly un-ledgered and is excluded.

| window instance | span | weekly pts | weighted tokens | **weighted / weekly pt** | 5h pts | weighted / 5h pt | ratio |
|---|---|---|---|---|---|---|---|
| Tue 09-01 08:00Z → Fri 09-04 08:00Z | 3.00 d | 85 | 151.51 M | **1.782 M** | 700 | 0.216 M | 8.2× |
| Fri 09-04 08:00Z → now | 2.05 d | 44 | 123.16 M | **2.799 M** | 633 | 0.195 M | 14.4× |

**So a weekly point is worth somewhere between ~1.8 M and ~2.8 M weighted tokens — 8× to
14× a 5h point — and this week's data cannot narrow it further.** The two estimates
disagree by 57%, under a boundary reading that may itself be wrong; pooling all three
instances gives 1.674 M/pt, but that figure is depressed by the un-ledgered first
instance and is a lower bound only. Weekly points arrived at 21–28 per day this week
(one per ~51–69 min); under a normal 7-day window capped at 100% the ceiling is ~14 per
day, one per ≥1.7 h. Treat every figure in this table as provisional and re-derive from
the first normal week of recorded weekly data (test case 14).

Weighted-token share over `2026-08-31T08:00Z → now`: `claude-opus-5` 94.7%,
`claude-fable-5-1` 2.0%, `claude-fable-5` 1.9%, `claude-sonnet-5` 1.2%,
`claude-haiku-4-5-20251001` 0.1%, `claude-opus-4-8` 0.0%.

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
the *points*, which is why the joint fit from `task-20` is carried over too.

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
   5h-only. **Nothing added here may import or define a weekly window length.** The ⚠️ in
   `docs/subsystems/usage-limits.md` already tracks two dependencies on that assumption;
   this task must not become the third, and the doc should say so out loud.
   This week settles the question that used to be the risk here. The worry was that a
   *sliding* window would advance `resetsAt` continuously and classify every weekly
   interval as a `reset`, leaving the card permanently empty. It does not slide: at
   2026-09-06T09:03Z the published stamp was `2026-09-07T07:59:59`, not `now + 7 d`. It
   steps — just not on the cadence the name implies, and this week not even on a
   consistent one. A design that reads only the *stamp* is immune to both.
3. **Are the 5h confidence floors right for a ~1%-integer-step series?** Partly. Two
   distinct things were conflated in the idea:
   - **Quantization is not the problem.** The pooled ratio is `Σtokens / Σ dUtil`, and
     over one window instance the rounding in `Σ dUtil` telescopes to `u_end − u_start` —
     a total error of ≤ 1 point however many intervals it spans. Over a 3-day fit
     (40–85 points on recent use) that is ≤ 2.5%, well inside any floor.
   - **Pairing is the problem, and it is fatal if ignored.** The history log writes a
     line whenever the *5h* counter moves — around one line per 7 min overall, one per
     ~3 min during active work. Several such lines land between two weekly ticks, so
     pairing consecutive samples the way `joinIntervals` does hands almost every tick's
     tokens to intervals with `dUtil = 0` (classified `idle`, excluded from `pool` by
     `ownedBy`), leaving the ticking interval holding a fraction of them.
     **Measured, not argued**: replaying this machine's real logs with a synthetic weekly
     series at K = 8 / 10 / 14 five-hour points per weekly point (the bracket measured
     above), consecutive-sample pairing yields **0.265 / 0.241 / 0.296 M weighted per
     point** where tick-to-tick pairing over the identical input yields
     **1.726 / 2.153 / 3.092 M** — the pooled weekly rate reads **6.5× to 10.4× too
     low**. Tick-to-tick recovers 235–240 M of the span's weighted tokens; consecutive
     pairing captures 22–37 M of them.
     **No evidence floor can catch this.** The two pairings produce the *same* number of
     owned intervals (139 vs 139 at K = 8, 76 vs 73 at K = 14) and the same cumulative
     points; only the token numerator differs. Every counter the card shows as evidence
     would look healthy while the published rate was an order of magnitude wrong. Hence
     `joinWeeklyIntervals` pairs tick to tick, not sample to sample (Plan §2).

   The floors themselves are then re-derived for the weekly grain in Plan §3 — the 5h
   values are not simply reused.

### Out of scope, deliberately

- **No weekly drift verdict.** `DRIFT_PCT` was set from a *measured* day-to-day
  dispersion of the 5h rates (cv ≈ 24%). No such measurement exists for the weekly
  series, none can exist until weeks of it are on disk, and a week in which the counter
  resets twice is not the week to measure it in. Ship the rate with its evidence; a
  weekly baseline and verdict is a later item.
- **No two-term (per-request) split for weekly.** The split separates a per-request term
  from a per-token one by exploiting interval-level variation in the request:token
  ratio. A one-to-several-hour interval carrying thousands of requests averages that
  variation away, so the design would be rank-deficient and `explainRates`' independence
  gate would refuse it anyway. Do not wire `fitSplits` to the weekly set.
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

Pairing is **tick to tick**, for the measured reason in open question 3:

- Ignore samples with no `week` (pre-widening lines) — they carry no weekly reading and
  must not close or open an interval.
- Walk the remaining samples in order. Hold the sample that last *changed* the weekly
  utilization. When a later sample shows a higher weekly utilization, emit one interval
  spanning `[held.t, current.t]` with `dUtil` = the rise, then make the current sample
  the new held one. Runs of identical weekly utilization collapse into the interval that
  ends at the tick.
- A weekly window change (`sameWindow` false on the weekly `resetsAt`) closes the run
  **without** emitting: utilization is cumulative only *within* a window. The next
  sample starts a fresh held sample. Same rule as `joinIntervals`, on the weekly stamp.
- **A weekly utilization drop closes the run without emitting too, whether or not the
  stamp moved.** This is not defensive coding — it is the mid-window reset the account
  saw twice this week (85% → 0 on 2026-09-04). If Anthropic zeroes the counter and
  republishes `resetsAt`, `sameWindow` catches it; if it zeroes the counter and leaves
  the stamp alone, only this rule does. Discard, never clamp: a clamped interval
  contributes tokens with no price, and a negative one would poison the pooled sum.
- The trailing partial run — tokens spent since the last tick, no tick yet — is not
  emitted. It is censoring, not bias: one interval at the end of the window.
- `gather`, `classify`, `dominantModel` and the rest are called exactly as
  `joinIntervals` calls them. Edge-tick pro-rating is a *smaller* relative approximation
  here than at 5h (two ~88 s ledger ticks against an interval of an hour or more).

`classify` gains an `externalMax` parameter, defaulted to the existing
`EXTERNAL_WEIGHTED_MAX` so `joinIntervals` is behaviourally untouched.
`joinWeeklyIntervals` passes a new `EXTERNAL_WEIGHTED_MAX_WEEKLY`.

- `EXTERNAL_WEIGHTED_MAX_WEEKLY = 45_000`, **provisional**, derived by holding the
  proportion the 5h constant already has: 5 000 against this machine's measured 0.192 M
  per 5h point is 2.6% of a point's worth, and 2.6% of **1.78 M** — the *lower* of the
  two clean weekly estimates — is ~46 000. The lower estimate on purpose: too high a
  threshold discards real intervals as another device's spend, and refusing real data is
  the more expensive error here because weekly points are scarce. Put the derivation,
  the 1.8–2.8 M bracket and the measurement date in the JSDoc, and re-derive it from the
  first normal week (test case 14).
- Coverage keeps `LEDGER_COVERAGE_MIN` at 0.8 and this is **correct, not a false
  negative**: a collapsed weekly interval that spans an overnight sleep genuinely has no
  ledger for most of its span, so we cannot know whether another device spent inside it.
  Expect roughly one `partial` weekly interval per night on a laptop that sleeps, and
  more of them than at 5h grain simply because the intervals are ~10× longer and so
  ~10× more likely to contain a recorder break. Disclose it via the existing coverage
  breakdown rather than by loosening the floor.

### 3. Weekly rates — `server/lib/usage-rate.ts`

- **The weekly fit uses `currentRange(nowMs)` — the same 3-day span the 5h column
  reports.** No new window constant. Two reasons, and write both down: this card already
  refuses to put two figures spanning different windows side by side, and 3 days now
  carries ample weekly evidence (40–85 points on recent use, ~42 even at the ≤14
  points/day a normal 7-day window caps out at). An earlier draft of this plan proposed a
  7-day weekly window on a scarcity argument that the measurements above refute.
- `WEEKLY_FLOORS: RateFloors = { minIntervals: 10, minUtil: 10, minDays: 2 }` — a copy of
  `CURRENT_FLOORS` with **one** deliberate change, `minUtil` 5 → 10, because 10 points
  bounds the ≤ 1-point quantization error at ≤ 10% and is ~18–28 M weighted tokens: a
  real measurement rather than a rounding artefact. `minDays` stays 2 and must never
  exceed the fit window's span in days — a floor that cannot be met is a column that
  never fills.
- The pooled weekly rate is
  `rateFor(weeklyIntervals, model, currentRange(nowMs)…, WEEKLY_FLOORS)` — `pool` and
  `rateFor` are already window-agnostic and take no change.
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
  `weekly` per row over `currentRange(nowMs)`. `weeklyCoverage` and
  `weeklyExternalSharePct` use the same `nowMs − BASELINE_MS → +∞` horizon the 5h
  disclosure figures use, so no two figures on one card span different windows.
- Row sort order is unchanged (`utilSum` desc, then model name) — the 5h `utilSum`, not
  the weekly one. A weekly-only model sorts last, as a fitted-only model already does.

### 5. The card — `client/src/lib/usageRatesFormat.ts`, `components/usage/UsageRates.tsx`

- New pure `weeklyAsideText(pooled, fitted)` → **one** line, or `null` when both are
  null (the rule `rawAsideText` and `fittedAsideText` already set: omit the line, never
  print a dash for a measurement nobody made). Naming the week is the whole point — the
  line must not read as another 5h figure. Both numbers when both exist, each labelled
  by its estimator; whichever one exists when only one does.
- `Row` renders it as a fourth aside, under the fitted line. It owns no threshold and
  makes no comparison to the 5h rate: the two are different quantities, and a ratio
  between them would read as a conversion factor the data does not support — the two
  clean measurements above disagree by 57% on what that ratio even is.
- The card subtitle gains one sentence: the weekly figure prices a point of the *weekly*
  limit, it has no drift verdict because no baseline dispersion has been measured for
  it, and it is no more comparable across models than the others.
- When `recording` is true and `weeklyRecorded` is false, show one note: the weekly
  series began recording with this build, and the column fills as the counter ticks
  (roughly 10–30 points a day on recent use, first rate within about a day). Without
  this the card shows empty weekly slots and reads as broken.

### 6. Probe and docs

- `scripts/probe-usage-split.ts` gains `--weekly`: build the weekly interval set, print
  the kind tally with points, print the pooled and fitted weekly rates per model with
  their refusals, print **how many samples carried a `week` field** out of the total, and
  print every **window boundary** it saw (each distinct weekly `resetsAt`, with the wall
  time between consecutive ones). That last line is the instrument for the cadence
  question — it is what would have shown this week's two off-cadence resets directly
  instead of by report.
- `docs/subsystems/usage-limits.md`: a new section covering the widened record, the
  tick-to-tick joiner and the **measured** 6.5–10.4× underestimate that consecutive
  pairing produces, the weekly floors with their derivations, the 1.8–2.8 M per point
  bracket with its date and its caveat, and an explicit statement that the weekly rate
  adds **no** third dependency on the weekly window length. Update the existing ⚠️: its
  "community reports conflict (some observed 72-hour intervals)" line now has a
  first-hand observation on this account — two resets inside one nominal week,
  2026-09-01 and 2026-09-04, >200% of a week's allowance consumed.
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
   33 intervals of which 32 are `idle`, and that the pooled rate over the second set is
   an order of magnitude below the first — the contrast *is* the assertion, and it is
   the 6.5–10.4× error measured on live logs in the Goal. Assert also that both sets
   report the **same** owned-interval count, which is why no evidence floor catches it.
5. **A weekly window change closes without emitting.** Samples whose weekly `resetsAt`
   jumps mid-run: no interval spans the boundary, and the run after it starts fresh. A
   weekly stamp jittering by under two minutes is the *same* window and must not close
   anything (`sameWindow`, already tested for 5h — assert it holds on the weekly stamp).
6. **Samples with no `week` are skipped, not treated as zero.** A run of pre-widening
   samples between two widened ones must neither open, close, nor split an interval; the
   emitted interval spans from the first widened tick to the next one, tokens included.
7. **The mid-window reset, both shapes — this week's event.** (a) Weekly utilization
   drops 85 → 0 with `resetsAt` **unchanged**: nothing is emitted for that run, no
   negative `dUtil` reaches any interval, and the next rise from 0 opens a fresh run
   whose tokens start after the drop. (b) The same drop with `resetsAt` also moving:
   identical outcome, via `sameWindow`. Assert (a) fails if the drop rule is removed —
   with only the `sameWindow` check in place, shape (a) would emit an interval carrying
   `dUtil = −85`. Name the 2026-09-04 reset in the test title.
8. **The weekly external threshold is the one in force.** An interval whose weighted
   tokens sit between `EXTERNAL_WEIGHTED_MAX` (5 000) and
   `EXTERNAL_WEIGHTED_MAX_WEEKLY` (45 000) classifies as `external` in the weekly set
   and as a `{model}` interval in the 5h set from the same tokens. Assert both
   directions in one test — that asymmetry *is* the parameter.
9. **`WEEKLY_FLOORS` bite at the documented boundary.** A model with 9 weekly intervals
   → `rateFor` null. The same model at 10 intervals / 10.0 points / 2 distinct UTC dates
   → a rate. Then each floor alone, in the mirror direction: 10 intervals but 1 date →
   null; 10 intervals over 2 dates but 9.0 points → null. A floor that only ever passes
   is a decoration. Assert `WEEKLY_FLOORS.minDays` is not greater than
   `CURRENT_MS / 86_400_000` — a floor wider than its own window can never be met.
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
    millions band (a weekly rate is ~2 M, the top band). Every pre-existing case in
    `test/usage-rates-format.test.ts` must be untouched — a diff that edits one means the
    change leaked.
14. **Live-data check, not a unit test.** After the recorder has run for at least a day
    on the branch, run `tsx scripts/probe-usage-split.ts --weekly` against this machine's
    real logs and paste the output into the PR. Green unit tests are not evidence here:
    the first version of the 5h join classified **759 of 759** real intervals as `gap`
    with the whole suite passing. Specifically report:
    (a) how many samples carry a `week` field;
    (b) the weekly kind tally — if everything lands in `reset`, say so plainly rather
    than shipping a card that will never fill;
    (c) the **window boundaries observed and the gap between them**, against the 72 h
    cadence this week showed and the 7 days the name implies. This is the first
    first-hand measurement of the cadence the ⚠️ has been guessing at;
    (d) the fitted weighted-tokens-per-weekly-point against the 1.8–2.8 M bracket in the
    Goal, and a re-derivation of `EXTERNAL_WEIGHTED_MAX_WEEKLY` from it. **If the
    recorded week is another abnormal one, say so and leave the constant provisional
    rather than re-deriving from a second bad week.**
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
  case 4 pins the contrast against `joinIntervals` on identical input — including the
  identical owned-interval count that makes the bug invisible to every floor.
- A mid-window drop to zero is discarded whether or not `resetsAt` moved, with case 7's
  removal check recorded.
- `EXTERNAL_WEIGHTED_MAX_WEEKLY` and `WEEKLY_FLOORS` exist with their derivations and
  their provisional status in the JSDoc; `classify` / `explainRates` / `fitRates` take
  the new parameters with defaults that leave the 5h path behaviourally identical.
- The weekly fit runs over `currentRange(nowMs)`. No new window-span constant was added,
  and no weekly window *length* is imported or defined anywhere — `grep` for
  `SEVEN_DAY_MS` in `usage-rate.ts` must find nothing.
- No weekly drift verdict, no weekly baseline, no weekly two-term split exists.
- `ModelRateRow.weekly` is always present; `UsageRatesResponse` carries
  `weeklyRecorded`, `weeklyCoverage` and `weeklyExternalSharePct`, all three present in
  `emptyRates`.
- The card renders the weekly aside, omits it entirely when there is no weekly rate,
  shows the "just started recording" note while `weeklyRecorded` is false, and its 5h
  rows are visibly unchanged.
- `scripts/probe-usage-split.ts --weekly` works, prints the observed window boundaries
  and their spacing, and its output is in the PR (case 14).
- `docs/subsystems/usage-limits.md` has the new section with the measured figures, their
  date and their provisional status; its weekly-length ⚠️ carries the 2026-09-01 /
  2026-09-04 double reset as a first-hand observation and says a third dependency on the
  window length was considered and deliberately not added; `docs/overview.md` §Map is
  updated.
- `pnpm test`, `pnpm typecheck` and `pnpm build` all pass with the command output pasted
  in the PR — never a green claim without it.
- The PR states what was **not** verified. At minimum: the weekly rate's day-to-day
  dispersion is unmeasured, so no drift threshold for it is claimed; the 1.8–2.8 M per
  point bracket comes from a week in which the counter reset twice off-cadence and is
  not a settled figure; and if case 14 ran before a normal week accrued, say that the
  published weekly rates have never been seen against normal-cadence data.

## Outcome

**2026-09-06 — done, with case 14 only partly satisfiable in an unattended run.**

The record now carries the weekly window (`UsageSample.week`, optional), `usage.ts`
feeds it from `limits.sevenDay`, `shouldWrite` fires on both axes, and
`joinWeeklyIntervals` pairs tick to tick against the same ledger. `ModelRateRow.weekly`
is always present, `UsageRatesResponse` gained `weeklyRecorded` / `weeklyCoverage` /
`weeklyExternalSharePct`, and the card renders a fourth aside naming the week. Profile
learning was not touched: no diff in `classifyInterval`, `provableIdleSpan`,
`accumulate` or `foldBucket`, and `grep SEVEN_DAY_MS server/lib/usage-rate.ts` finds
nothing.

### Verification

```
$ pnpm test
  31/31 passed
ALL PASS

$ pnpm typecheck
> tsc --noEmit
exit=0

$ pnpm build
dist/assets/index-C0UUfgIf.js   396.96 kB │ gzip: 113.69 kB
✓ built in 1.46s
exit=0
```

1387 assertions pass in total. The new file:

```
=== usage-rate.ts (the weekly window) ===

  ✓ the documented weekly thresholds
  ✓ tick to tick collapses a flat run; sample to sample loses 32/33 of its tokens
  ✓ a weekly window change closes the run without emitting across it
  ✓ a weekly stamp jittering under two minutes is the same window
  ✓ samples with no week are skipped — they never open, close or split a run
  ✓ the 2026-09-04 reset: 85 → 0 with the stamp unchanged emits nothing
  ✓ the same reset with the stamp also moving: identical outcome, via sameWindow
  ✓ the trailing partial run is not emitted — censoring, not bias
  ✓ the weekly external threshold is the one in force, and only there
  ✓ WEEKLY_FLOORS: 9 intervals refuses, 10 over 2 dates at 10.0 points fits
  ✓ WEEKLY_FLOORS: each floor alone refuses in the mirror direction
  ✓ WEEKLY_FLOORS.minDays can actually be met inside the fit window

  12 passed, 0 failed
```

### The two mutation checks, run and recorded

**Case 3 — `week` removed from `parseSample`'s output:**

```
  ✗ a mixed file reads back in order with the right lines carrying week
  ✗ a malformed week field is absent, not a thrown parse
  ✗ MUTATION GUARD: rotation preserves the weekly field on every line
    a surviving line lost its weekly reading
```

**Case 7 — the mid-window drop rule removed from `joinWeeklyIntervals`:**

```
  ✗ the 2026-09-04 reset: 85 → 0 with the stamp unchanged emits nothing
    Expected values to be strictly deep-equal:
    + actual - expected
      [ [ 1788512400000, 1788512460000 ] ,
    -   [ 1788512520000, 1788512580000 ] ]
```

The test catches the removal, but **the failure mode is not the one the plan
predicted**. The plan expected an interval carrying `dUtil = −85` to be emitted. In
this implementation the drop rule sits *above* the `dUtil <= IDLE_EPS` branch, so
removing it makes `−85` fall through as "no tick yet": nothing negative is emitted, and
what is lost instead is the whole run *after* the reset — the anchor stays stuck at 85%
until the counter climbs back past it. Worse in a quieter way, and the pinned interval
list is what catches it.

### Case 14 — live probe, incomplete and honestly so

`scripts/probe-usage-split.ts --weekly` works. Against the real logs before any
recording on this build: `samples carrying a week field: 0 / 2491` — the record predates
the widening, exactly as designed.

A dev server was then run in this worktree (ports 4273/5273, its own copy of the two
logs, killed afterwards by recorded pid) so the recorder could write real widened lines:

```
  ── the weekly window ──
  samples carrying a week field: 4 / 2495
  weekly window boundaries observed: 1
    2026-09-07T08:00:00.330703+00:00   first seen 2026-09-06T17:36:12.459Z

  weekly intervals: 0  (external threshold 45000 weighted)
    the weekly counter has not ticked inside a recorded window yet.
```

A real recorded line:

```
{"t":1788716172459,"utilization":61,"resetsAt":"2026-09-06T20:10:00.330681+00:00",
 "week":{"utilization":65,"resetsAt":"2026-09-07T08:00:00.330703+00:00"}}
```

Against the plan's four questions:

- **(a)** 4 of 2495 samples carry `week` after ~15 minutes of live recording. The field
  is written, parsed and round-tripped against the real endpoint.
- **(b)** **Zero** weekly intervals. Not because everything landed in `reset` — because
  the weekly counter did not tick once in fifteen minutes, which at the measured
  21–28 points/day (one per ~51–69 min) is the expected outcome. Nothing here says the
  join works on live data; that check is still owed.
- **(c)** One boundary observed, so **the cadence is not measured**. One thing is
  confirmed: the published stamp was `2026-09-07T08:00:00.330703Z` at 17:36Z on 09-06,
  where the task recorded `2026-09-07T07:59:59.840279Z` at 09:03Z the same day — 8.5
  hours apart, same window, sub-second jitter. The window does not slide, and the
  `sameWindow` slack is the right instrument for the weekly stamp too.
- **(d)** No re-derivation of `EXTERNAL_WEIGHTED_MAX_WEEKLY`. It stays **provisional**
  at 45 000 with its derivation and its 2026-09-06 date in the JSDoc, per the plan's own
  instruction not to re-derive from inadequate data.

### Case 15 — in the browser

http://localhost:5273 (this worktree's own server, not the user's 5174) → **Usage** →
**Token value**. Observed: the subtitle names the weekly figure and states it has no
drift verdict; five 5-hour rows render unchanged — value, `≈ … raw at this model's
recent mix`, `fitted … across mixed-model windows · +46.8% vs the rate above`, baseline
+ evidence meta, collecting hint — with **no** weekly asides; the footer pills are
unchanged (`12% external`, `60% priced` + four clauses). **0 console errors** after a
clean reload.

**One deviation from the plan, driven by that check.** The plan gates the "weekly series
just started recording" note on `weeklyRecorded === false`. Live, the first widened line
was written **90 seconds** after the recorder started, so the note disappeared while
every weekly slot stayed empty — the card was back to looking broken, which is the exact
state the note exists to explain. The note is now shown while **no row has any weekly
figure**, and `weeklyRecorded` chooses which sentence: "began recording with this build"
versus "recording, but the counter has not ticked enough yet". That keeps the two states
`weeklyRecorded` exists to separate visible, which is what the plan asked of the field.

### Other deviations

- `pool` in `usage-rate.ts` is exported as **`poolRate`**. The weekly evidence trio
  (`intervals` / `utilSum` / `days`) has to survive a refused rate the way the 5-hour
  row's already does, and only that function computes it. Three internal call sites
  renamed; no behaviour change.
- The API fixture yields **13** owned weekly intervals, not 14: the second date's first
  tick is what closes the interval bridging the two blocks, and that one is `partial`.
  The collapse eating it is the behaviour, not a loss — documented in the fixture.

### Not verified

- **The weekly join has never seen a real weekly tick.** Case 14(b) is owed: run
  `tsx scripts/probe-usage-split.ts --weekly` after a day of recording before trusting
  any published weekly rate.
- **The weekly rate's day-to-day dispersion is unmeasured**, so no drift threshold is
  claimed for it and none was added.
- **The 1.8–2.8 M per weekly point bracket comes from a week in which the counter reset
  twice off-cadence.** It is not a settled figure, and both `EXTERNAL_WEIGHTED_MAX_WEEKLY`
  and the doc's table say so.
- **The weekly cadence is still unmeasured** — one boundary observed, and the ⚠️ in
  `docs/subsystems/usage-limits.md` still stands.
