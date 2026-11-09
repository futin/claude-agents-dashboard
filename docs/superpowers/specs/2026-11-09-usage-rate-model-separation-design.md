# Usage card: separate each model's token value from the other models it ran beside

Status: design, approved approach 2026-11-09. Implementation plan to follow.

## Intent

The Usage card's per-model "token value" — weighted tokens per 1% of the 5-hour window — is how the maintainer judges whether a model got pricier. It reads
wrong whenever one session mixes models. The concrete case: a doc-review run is an Opus 5.5 main thread with a Fable 5.1 reviewer, and Fable costs roughly
5–6x more window per weighted token than Opus (card: Fable ~100k/pt, Opus ~470–650k/pt, 2026-11-09). On 2026-11-09 the card showed Opus at **268k per 1%**
for the day (later 326k), which read as "Opus 5.5 drains far faster than last Friday" (Friday 2026-11-06: 645k). Opus did not change. Fable was used more.

What the maintainer wants: a model's token value moves only when *that model's* cost moves. Using more of another model must show up as that other model's
spend, never as a change in this one's rate.

## Why the current number is wrong (measured 2026-11-09, scratch scripts over the live ledger, 17-day horizon)

The headline rate, the drift verdict and the day strip all come from `poolRate` (`server/lib/usage-rate.ts`): Σ weighted tokens / Σ dUtil over the intervals
one model *owns* (`DOMINANCE` = 90% of weighted tokens). Three things go wrong on mixed days, the first being the big one:

1. **Carry-over across the whole-percent tick.** Utilization is read in whole points and intervals are 1–2 minutes long, so a point earned mostly by Fable in
   a mixed interval often ticks over in the *next* interval, which Opus happens to own. On 2026-11-09 the five Opus-owned intervals recorded 5 points while
   their own tokens, priced at the models' known rates, explain ~2.6. The extra ~2.4 points are Fable's, booked to Opus. The code already knows this effect
   exists — the two-term fit's interval comment says "spend often lands in one interval and its visible rise in the next" — but the pooled rate ignores it.
2. **Owned-only sampling.** On 2026-11-09, 44 of 61 points sat in `mixed` intervals that the pooled rate discards, leaving 5 points to price Opus from, every
   carried-over point counting in full.
3. **Idle intervals dropped.** `poolRate` reads only owned intervals, and an interval whose utilization did not move is `idle`, never owned. Its tokens vanish
   from the numerator while the tick they contribute to is counted elsewhere — selection on the dependent variable. Including idle intervals raised every
   day's separated Opus figure by roughly 10–20%.

What was ruled out the same day, so the builder does not chase it:

- **In-interval leak through the 90% rule is small.** Pricing the minor models inside Opus-owned intervals moves the 17-day Opus pooled rate +2% (482k →
  490k), at most +4% on any day. The 90% rule works for tokens *inside* an interval; it cannot see carry-over *between* intervals.
- **Token mix** does not explain the day-to-day swing: cache reads are a steady 42–55% of Opus weighted tokens every day.
- **Headless vs interactive** is a separate, real effect (Opus headless ~322k/pt vs interactive ~558k/pt over the horizon) that is already handled by the
  surface-mix adjustment in the drift verdict, and dashboard spawns stopped being billed headless when `SPAWN_OWN_ENTRYPOINT` went on (2026-10-28, #323).
  The remaining headless days in the horizon (2026-10-24…27 pre-fix, 2026-11-03…04 the codegraph A/B's own `claude -p` runs) age out by ~2026-11-21.

## The estimator: the separated rate

For one model M over a span S (a UTC day, the 3-day current window, or the 17-day baseline range):

```
separatedPerPct(M, S) = W_M(S) / ( U(S) − Σ_{other models m} W_m(S) / rate_m )
```

- `U(S)` — Σ dUtil over every interval in S that the one-term joint fit already admits (`usableForRate`: owned, `mixed` **and** `idle`; never `external` or
  anything `isUnpriced` names). Same interval set as `fitRates`, so carry-over is summed out over the span instead of landing on whoever owned the tick.
- `W_x(S)` — model x's weighted tokens over those same intervals (`weightedTokens` with the model id, as everywhere else).
- `rate_m` — the other model's own token value, used to price its spend out. **Taken from one run of the one-term joint fit (`fitRates`) over the full
  17-day horizon `[now − BASELINE_MS, now)`** — not `baselineRange()`, which is `[now−17d, now−3d)`, and not the card's existing 3-day `fitRates` call.
  Author's call: the fit already solves every model jointly with mixed and idle intervals, so the subtraction rates carry no carry-over bias of their own;
  one fit over the whole horizon serves the headline, the baseline and every day cell alike, so they cannot disagree about what was subtracted; and the
  current window being in-sample is accepted because the guard below catches the case where that matters. The card's existing 3-day `fittedWeightedPerPct`
  stays as it is, a separate published figure.

In a span where only M ran, this collapses to the pooled ratio with idle intervals added back — the pure case must not change except for fix 3.

On 2026-11-09 a prototype of this (with each other model priced at its card baseline, idle excluded) gave Opus **639k** for the day against the card's 268k,
and kept the other days in the 300–840k band. The prototype is not the spec: it used pooled rates for the subtraction, which the design replaces with the
joint fit.

### Guards — when a span cannot be separated

A separated figure is only as good as the subtraction. Mark the span `thin` (figures carried, not coloured, not judged), never rated, when any of these hold:

**Amendment, 2026-11-09 (after the live back-test, Task 6; maintainer's pick "V3").** As first written, the sensitivity guard was a flat cap `s ≤ ~0.34`
from an assumed `SUB_ERR` of 15%, and the repriced guard fired on any non-trivial neighbour whose 3-day fit moved > `DRIFT_PCT`. On the live 17-day horizon
(2026-11-09) that left **no** model with a rated current row: Haiku's 3-day fit (−53%, resting on ~2.4 of its own points and 1.6% of the window's tokens)
and Sonnet's (−43%) tripped `repriced` for every model, and with that guard off the flat cap still turned every current row `mixed`; Opus had 7/15 rated
days and its separated cv (27.0%) broke the floors' inequality (21.7 > 20). Both guards now measure the effect on M's figure instead of a proxy for it.
Measured with the replacement (2026-11-09, scratch back-test `variants.mts`, day-block bootstrap B = 1000): Opus 14/15 rated days, current row rated
602k against a 536k baseline (+12%, `stable`), 2026-11-09 rated at 526k, cv 22.3% → √(cv²/7 + cv²/2) = 17.9 < 20. Fable, Haiku and Sonnet stay `thin`
on almost every day under every variant tried — they are the minor partner nearly everywhere (`s` 0.36–0.89), which is the accepted consequence below.

- **Too sensitive to the subtraction.** The residual is unstable when M's own points are a small part of `U(S)`: on 2026-11-05 Fable's expected points were
  134 of 190 and the separated Opus figure swung 838k–1040k depending on the subtraction rates. The guard is a **sensitivity bound on each model's measured
  error**. Each other model m gets an error band from a **day-block bootstrap of the horizon fit**: resample the horizon's UTC days with replacement
  (`SUB_BOOTSTRAP` = 200 resamples, fixed-seed PRNG so the same ledger gives the same band), refit `fitRates` on each, and take m's 5th and 95th
  percentile against its point rate: `under_m = max(0, 1 − p5/rate_m)`, `over_m = max(0, p95/rate_m − 1)`. With `P_m = W_m(S) / rate_m` and residual
  `R = U(S) − Σ P_m`, the two one-sided moves of the subtracted points combine root-sum-square across models — `ΔU = √Σ (P_m · (1/(1 − min(under_m, 0.99))
  − 1))²` (true rates lower, more priced out) and `ΔO = √Σ (P_m · (1 − 1/(1 + over_m)))²` — and the span is `thin` (`mixed`) when `R ≤ 0`, `R − ΔU ≤ 0`,
  `R / (R − ΔU) − 1 > DRIFT_PCT / 2`, or `1 − R / (R + ΔO) > DRIFT_PCT / 2`. A model fitted in fewer than half the resamples has no measured band: it takes
  `under` 0.99 and `over` 9, so any non-negligible share of its points makes the span `mixed` (its rate is not identified well enough to subtract). A
  context built by hand (tests) may omit a model's band; it then falls back to `SUB_ERR` (15%) on both sides, which for a single neighbour reproduces the
  old cap. The bands are part of `SeparationContext`, built once with the horizon fit, and memoized per UTC hour and horizon interval count: one bootstrap
  costs ~200 × 6.8 ms ≈ 1.4 s of the event loop (measured 2026-11-09, 12,424 intervals), paid at most once an hour. `SEPARATION_S_CAP` goes; `s` is still
  published as `pricedOutShare`. Consequence, accepted: a model that is the minor partner in a span (Fable beside an Opus driver) is usually `thin` there —
  the residual genuinely cannot price it to ±10%. It still carries its figure on the strip, and its row still shows the existing joint-fit
  `fittedWeightedPerPct`.
- **Another model repriced — judged by its effect on M.** `rate_m` is fitted over the whole horizon, so if Fable itself gets pricier this week, its extra
  points are under-subtracted and Opus would read as drift — the exact failure this change exists to remove. So, in the current window and in every day
  cell inside it: for each m with both a horizon rate and a current-window (3-day) joint-fit rate, recompute M's figure with **that one** m priced at its
  3-day rate instead (the others at horizon); if any single swap moves M's figure by more than `DRIFT_PCT / 2`, or leaves no positive residual, the span is
  `thin` (`repriced`). No token-share gate: a neighbour with a trivial share cannot move M's figure 10%, and a noisy 3-day fit on a few points (Haiku,
  2026-11-09) cannot either unless its spend matters. The repricing then shows where it belongs: on m's own row. An m with **no** 3-day fit (refused by
  `fitRates`) does not trigger the guard — there is no evidence it repriced. Accepted limitation, documented: after m reprices, the horizon `rate_m` is a
  blend of old and new, so baseline-range days are mis-subtracted slightly the other way; the 14 baseline days outweigh the 3 current ones, and the guard
  already stops a verdict while the move is fresh.
- **A needed rate is missing.** Some other model spent more than a trivial share of S's weighted tokens and has no joint-fit rate (refused `thin`). A model
  whose spend is that small can be ignored rather than refusing the whole span; the builder picks the threshold and states it.
- **Too little left.** The residual `U(S) − Σ…` is under **the span's own** `minUtil` — `BASELINE_FLOORS` (15) for the baseline range, `CURRENT_FLOORS`
  (5) for the current window and for a day cell, as the strip already uses — or is not positive.

The existing floors (`BASELINE_FLOORS`, `CURRENT_FLOORS`) still apply, with every evidence counter redefined on the new basis (review round 1):
`intervals` = the usable intervals in S in which M spent anything (the convention `explainRates` already uses), `days` = their distinct UTC dates,
`utilSum` = the residual points. These feed `DriftRow.intervals / utilSum / days / baselineDays` and `ModelDayRate.intervals / utilSum`.

**Row vs cell when a guard fires.** As today: a row whose current window or baseline is `thin` publishes **null** `weightedPerPct` / `rawPerPct` /
`deviationPct` for the side that failed (as `driftRow` already does), while its evidence counters are carried; a strip cell that is `thin` **carries** its
figures uncoloured and unjudged (as `dailyRates` already does).

**Why it is thin is published (author's call, review round 2).** Today `thin` means only "under the floors", and three client strings say so: the day tip's
"under ${DAY_FLOOR_PTS} pts — not coloured" (`usageRatesFormat.ts` ~396), the Collecting tile's "not enough windows yet" (~578) and the `collecting` verdict
hint "a verdict needs N separate days…" (~148–152). Under the new guards that is false for a thin span the separation could not price. So `shared/types.ts`
gains an optional `thinReason?: 'floor' | 'mixed' | 'repriced' | 'unpriced'` on `ModelDayRate` and on `ModelRateRow` (server: `DriftRow`; for the side that made the row's
verdict `thin`; current window wins when both are), present exactly when that span is `thin`: `floor` = under `BASELINE_FLOORS`/`CURRENT_FLOORS` or the
residual floor; `mixed` = sensitivity cap; `repriced` = repriced-neighbour guard; `unpriced` = missing-rate guard. When several fire, precedence is
`unpriced` > `repriced` > `mixed` > `floor` (the more specific reason wins). Types first, then server, then client. The three strings read
the reason: `floor` keeps today's wording; the other three say the span "can't be separated from other models' spend" (`mixed`: "mostly another model's
spend"; `repriced`: "another model's rate moved"; `unpriced`: "another model has no rate yet"); the Collecting tile's sub-line counts both kinds
("not enough windows, or not separable"). Exact final wording is the builder's, within those meanings.

## What changes on the card

- **The row's headline rate, its baseline, the drift deviation and the day strip** switch from the pooled ratio to the separated rate. These are the four
  numbers the maintainer reads; all four must agree on one estimator or a cell and the badge will contradict each other. **`rawPerPct` and
  `baselineRawPerPct` move with them**: M's raw tokens over the same intervals ÷ the same residual points, because the `mix-shift` verdict is judged on the
  raw deviation (`driftRow`) and a pooled raw beside a separated weighted would mix estimators.
- **The joint-fit figure (`fittedWeightedPerPct`) and its disclosure stay as they are.** `fitDeviationPct` keeps comparing it against whatever the row now
  publishes as its rate.
- **The surface (interactive/headless) mix adjustment moves to the separated basis; there is no owned-basis fallback.** `driftRow` judges
  `mixAdjustedDeviationPct ?? weightedDev`, so leaving `mixAdjustedDeviation` owned-only would keep judging the 2026-11-09 shape at ~−48% → `drift`, the bug
  this change removes (review round 2). Stratification, defined (author's call): in every usable interval, M's **surface** is the surface holding
  ≥ `DOMINANCE` of M's **own** weighted tokens there (the ledger already records per-model surface counts, `sur[model]`, read by `joinIntervals`; today
  `surfaceOf` asks this only of the owner). The interval's residual points go to that surface in proportion to M's expected share, exactly as in the span
  formula, so each surface stratum gets `W_M,surface / (U − Σ_m W_m/rate_m)` over its own intervals; an interval where no surface reaches `DOMINANCE` stays in
  the span total and in no stratum, as unattributed intervals do today. The same guards apply per stratum: a stratum that fails one is `thin` and drops out
  of the mix adjustment, which then falls back to the plain separated deviation (`mixAdjustedDeviationPct` null), never to an owned-basis figure.
- **`DriftRow.surfaces` (`surfaceRates`) moves with it**: each surface's rate is the stratum's separated rate above, so the surface breakdown the card shows
  (`surfaceText`) and the adjustment the verdict uses are the same numbers.
- **Labels** stay. No new tile, no new row. Copy that describes the old basis becomes false and is in scope (`client/src/lib/usageRatesFormat.ts`): the
  empty-cell text "no windows this model owned" (~line 389), the glossary's `weighted` entry (~441–446, which also gains the one line saying other models'
  spend is priced out), and the `windows` entry "one model owned (≥90% of tokens)" (~479–481).
- **Contract and reference docs are in scope whether or not a field is added**: the JSDoc in `shared/types.ts` that says the row and the strip are the pooled
  ratio over owned windows and that "drift is still judged on the pooled rate alone" (`ModelDayState` / `ModelDayRate` ~393–408, `fitDeviationPct`
  ~509–517, and the rate fields around ~329–350), and `docs/subsystems/usage-limits.md` §Token value per model and §The day strip.
- **`DRIFT_PCT` = 20** was set from the pooled rate's measured day-to-day dispersion. The builder re-measures that dispersion for the separated rate over the
  live 17-day horizon and records it with its date in `docs/subsystems/usage-limits.md`. `DRIFT_PCT` and the day floors were derived together from a cv of
  ~24%, so that √(cv²/7 + cv²/2) stays under `DRIFT_PCT` (`usage-rate.ts` comment above `BASELINE_FLOORS`). Author's call: **the floors stay**; if the
  separated cv breaks that inequality at 20, the builder does not move either knob in this change — the PR reports the measured cv and the inequality, and
  the threshold is retuned in a follow-up the maintainer approves. The subtraction should *lower* the cv on mixed days; if it raises it overall, that is a
  finding to report, not to tune away.

## Goals

- Opus's token value stays put on a day Fable is used heavily beside it: either a rated figure in its normal band, or `thin` carrying a figure in that band
  — never a rated or carried figure that is really Fable's spend (2026-11-09: 268k today; ~640k separated, `thin` at `s ≈ 0.76`).
- Every model that drives the spend in a span (priced-out share under the cap) gets a rate that is its own; a model that is only the minor partner reads
  `thin` there and keeps its joint-fit figure.
- The day strip, headline and verdict agree with each other.

## Non-goals

- The weekly figures (`ModelWeeklyRate`). They have their own pairing and no drift verdict; leave them on their current estimators.
- The two-term split (tokens + requests). Untouched.
- A per-model breakdown of the live 5h window ("Fable spent 30 of today's 43 points"). Discussed and set aside 2026-11-09; a candidate follow-up.
- Explaining *why* headless costs more. Already documented as not on disk.

## Anti-goals

- A second competing number on the card. The separated rate **replaces** the pooled one in the row; it does not sit beside it.
- Hiding the guard. A span the separation cannot price must read `thin`, never quietly fall back to the pooled figure.
- Any new outbound call, dependency, or file written. This is a pure change to `lib/usage-rate.ts`, `lib/usage-shape.ts`, `shared/types.ts`, the card, tests
  and docs.

## Verification the builder owes

Tests (node-assert, synthetic intervals, in the existing `test/usage-rate*.test.ts` files):

1. **Pure span.** Only model A ran, idle intervals included: separated rate = A's weighted tokens / Σ dUtil over owned + idle. Equal to the pooled rate when
   there are no idle intervals.
2. **Known two-model mix.** Synthetic A at 500k/pt and B at 100k/pt, with B's joint-fit rate supplied as 100k: A's separated rate comes back 500k (±1%),
   where the pooled rate on the same data does not.
3. **Carry-over.** B's spend in interval *i* with dUtil 0, the tick landing in interval *i+1* that A owns with small A spend: A's pooled rate is visibly low,
   its separated rate is not. This is the 2026-11-09 shape and the reason for the change.
4. **Mirror of 3.** A's spend carries into a B-owned interval: B's rate is not inflated either.
5. **Sensitivity guard on measured error.** With one neighbour at a hand-set band of 15% both sides (the fallback) and `DRIFT_PCT` 20: a span with
   priced-out share `s` = 0.40 → `thin`, figures carried; the same model in a span with `s` = 0.25 → rated. Run it from both sides of one Fable+Opus pair,
   so the guard is shown to treat driver and minor alike. Then the same `s` = 0.40 span with the neighbour's band at 3% → rated (a well-measured
   neighbour can be priced out of a bigger share). Two neighbours at 15% each with half the priced-out points each → the root-sum-square move, not the
   sum. A neighbour fitted in under half the resamples → `mixed` whenever its points move M's figure. `R − ΔU ≤ 0` → `mixed`, never `Infinity`.
5a. **The bootstrap band.** `separationContext` on a fixture whose days all price m identically → m's band ≈ 0 both sides; on a fixture where m's per-day
   rate alternates 400k/600k → a non-zero band on both sides; two calls on the same intervals → identical bands (seeded); a second call within the same
   UTC hour and interval count does not refit (memo).
5b. **Repriced-neighbour guard by effect.** m's 3-day fit 30% off its horizon rate and m holding a large share of the priced-out points → M's current
   verdict is `thin` (`repriced`), not `drift`; m's own row still shows its move. The same 30% move with m's points a small share, so the swap moves M's
   figure < 10% → not `repriced`. A swap that leaves no positive residual → `repriced`.
6. **Missing-rate guard.** Another model with non-trivial spend and no fit → `thin`; the same model with trivial spend → ignored, span rated.
7. **Residual floor.** Residual points under the floor or ≤ 0 → `thin`.
7b. **Thin reason.** Tests 5 (s = 0.40), 5b, 6 and 7 each assert `thinReason` = `mixed`, `repriced`, `unpriced`, `floor` respectively, on both the
    day cell and the row; a rated span has no `thinReason`; a span failing both the sensitivity cap and the residual floor reads `mixed`.
7c. **Surface strata on the separated basis.** A span where M is Opus at 70% of weighted tokens beside Fable, M's own tokens ≥ 90% interactive in some
    intervals and ≥ 90% headless in others: `surfaces` carries each stratum's separated rate (not the owned-only one), and `mixAdjustedDeviationPct` is
    computed from those; a mixed span that the owned-only adjustment would call `drift` is not `drift` here.
8. **Strip/verdict agreement.** The day cells' deviation and the row's deviation are both computed against the same separated baseline.

Back-test, recorded in the PR with the command output:

- Re-run the separated rate over the live ledger for the 17-day horizon, per UTC day, for every model with a fit, beside the old pooled figure. Report the
  day-to-day dispersion of both and how many days the guard turned `thin`.
- Confirm 2026-11-09's Opus day carries a figure in Opus's ordinary interactive band rather than ~268–326k (after the amendment: expected rated, ~526k).
- After the amendment: Opus's current row rated, its rated-day count and cv against the inequality, and each model's bootstrap band — against the
  amendment's B = 1000 measurement, so a shortfall from B = 200 shows.
- Per guard, how many day cells it turned `thin`.
- State what was not verified (at minimum: the card was or was not looked at in the browser, and against which data).

## Left to the builder

- Where the separated estimator lives inside `lib/usage-rate.ts` and how it reuses `usableForRate`, `fitRates` and the existing floors.
- The exact trivial-share threshold in the missing-rate guard. (`SUB_ERR` now survives only as the hand-built-context fallback; see the amendment.)
- The wording of the one explanatory line on the card.
