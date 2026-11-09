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

- **Too sensitive to the subtraction.** The residual is unstable when M's own points are a small part of `U(S)`: on 2026-11-05 Fable's expected points were
  134 of 190 and the separated Opus figure swung 838k–1040k depending on the subtraction rates. A fixed cap on the priced-out share was considered and
  rejected (author's call, after the builder check): applied to a minor model such as Fable beside an Opus driver, it would mark that model `thin` on almost
  every span, which defeats the goal. The guard is a **sensitivity bound** instead, symmetric for driver and minor models: perturb every `rate_m` by ±`SUB_ERR`
  (the subtraction rates' plausible error, starting value 15%, back-tested) and mark the span `thin` when either perturbation moves M's separated figure by
  more than `DRIFT_PCT / 2`. Which spans this keeps rated — and in particular how many Fable days survive beside Opus — is a back-test output, not a promise.
- **Another model repriced.** `rate_m` is fitted over the whole horizon, so if Fable itself gets pricier this week, its extra points are under-subtracted and
  Opus would read as drift — the exact failure this change exists to remove. So: when any m that contributes to the subtraction in the current window has a
  current-window (3-day) joint-fit rate more than `DRIFT_PCT` away from its horizon `rate_m`, M's **current-window verdict** is `thin` rather than `drift`,
  and each affected day cell is `thin` too. The repricing then shows where it belongs: on m's own row.
- **A needed rate is missing.** Some other model spent more than a trivial share of S's weighted tokens and has no joint-fit rate (refused `thin`). A model
  whose spend is that small can be ignored rather than refusing the whole span; the builder picks the threshold and states it.
- **Too little left.** The residual `U(S) − Σ…` is under the existing `CURRENT_FLOORS.minUtil` (the same floor the strip already uses), or not positive.

The existing floors (`BASELINE_FLOORS`, `CURRENT_FLOORS`) still apply to the windows on the residual points, not on raw `U(S)`.

## What changes on the card

- **The row's headline rate, its baseline, the drift deviation and the day strip** switch from the pooled ratio to the separated rate. These are the four
  numbers the maintainer reads; all four must agree on one estimator or a cell and the badge will contradict each other.
- **The joint-fit figure (`fittedWeightedPerPct`) and its disclosure stay as they are.** `fitDeviationPct` keeps comparing it against whatever the row now
  publishes as its rate.
- **The surface (interactive/headless) mix adjustment keeps working.** It is computed today over owned intervals; it must now be computed on the separated
  basis too, or the verdict would mix two estimators. If doing that properly is large, the builder may keep the surface strata on the old owned-interval basis
  for v1 **only** if it says so in the PR and the docs — the verdict must never silently mix the two.
- **Labels** stay. One line in the card's explanatory text (where it already explains the pooled rate) says the figure has other models' spend priced out.
  No new tile, no new row.
- **`DRIFT_PCT` = 20** was set from the pooled rate's measured day-to-day dispersion. The builder re-measures that dispersion for the separated rate over the
  live 17-day horizon and records it with its date in `docs/subsystems/usage-limits.md`. `DRIFT_PCT` and the day floors were derived together from a cv of
  ~24%, so that √(cv²/7 + cv²/2) stays under `DRIFT_PCT` (`usage-rate.ts` comment above `BASELINE_FLOORS`). Author's call: **the floors stay**; if the
  separated cv breaks that inequality at 20, the builder does not move either knob in this change — the PR reports the measured cv and the inequality, and
  the threshold is retuned in a follow-up the maintainer approves. The subtraction should *lower* the cv on mixed days; if it raises it overall, that is a
  finding to report, not to tune away.

## Goals

- Opus's token value stays put on a day Fable is used heavily beside it.
- Every model that runs beside others gets a rate that is its own.
- The day strip, headline and verdict agree with each other.

## Non-goals

- The weekly figures (`ModelWeeklyRate`). They have their own pairing and no drift verdict; leave them on their current estimators.
- The two-term split (tokens + requests). Untouched.
- A per-model breakdown of the live 5h window ("Fable spent 30 of today's 43 points"). Discussed and set aside 2026-11-09; a candidate follow-up.
- Explaining *why* headless costs more. Already documented as not on disk.

## Anti-goals

- A second competing number on the card. The separated rate **replaces** the pooled one in the row; it does not sit beside it.
- Hiding the guard. A span the separation cannot price must read `thin`, never quietly fall back to the pooled figure.
- Any new outbound call, dependency, or file written. This is a pure change to `lib/usage-rate.ts`, `lib/usage-shape.ts`, `shared/types.ts` (only if a field
  or state is added), the card, tests and docs.

## Verification the builder owes

Tests (node-assert, synthetic intervals, in the existing `test/usage-rate*.test.ts` files):

1. **Pure span.** Only model A ran, idle intervals included: separated rate = A's weighted tokens / Σ dUtil over owned + idle. Equal to the pooled rate when
   there are no idle intervals.
2. **Known two-model mix.** Synthetic A at 500k/pt and B at 100k/pt, with B's joint-fit rate supplied as 100k: A's separated rate comes back 500k (±1%),
   where the pooled rate on the same data does not.
3. **Carry-over.** B's spend in interval *i* with dUtil 0, the tick landing in interval *i+1* that A owns with small A spend: A's pooled rate is visibly low,
   its separated rate is not. This is the 2026-11-09 shape and the reason for the change.
4. **Mirror of 3.** A's spend carries into a B-owned interval: B's rate is not inflated either.
5. **Sensitivity guard, both directions.** A span where M's own points are a small share and a ±`SUB_ERR` change in `rate_m` moves M's figure past
   `DRIFT_PCT / 2` → `thin`, figures carried. The same minor model in a span where it holds enough of the points → rated. (Covers a Fable-beside-Opus span
   from Fable's side, not only Opus's.)
5b. **Repriced-neighbour guard.** m's 3-day fit is > `DRIFT_PCT` off its horizon rate → M's current verdict is `thin`, not `drift`; m's own row still shows
   its move.
6. **Missing-rate guard.** Another model with non-trivial spend and no fit → `thin`; the same model with trivial spend → ignored, span rated.
7. **Residual floor.** Residual points under the floor or ≤ 0 → `thin`.
8. **Strip/verdict agreement.** The day cells' deviation and the row's deviation are both computed against the same separated baseline.

Back-test, recorded in the PR with the command output:

- Re-run the separated rate over the live ledger for the 17-day horizon, per UTC day, for every model with a fit, beside the old pooled figure. Report the
  day-to-day dispersion of both and how many days the guard turned `thin`.
- Confirm 2026-11-09's Opus day reads in Opus's ordinary interactive band rather than ~268–326k.
- State what was not verified (at minimum: the card was or was not looked at in the browser, and against which data).

## Left to the builder

- Where the separated estimator lives inside `lib/usage-rate.ts` and how it reuses `usableForRate`, `fitRates` and the existing floors.
- Whether `ModelDayState` needs a new reason for "cannot separate" or `thin` is enough (author leans to `thin` plus the existing evidence counters; if a new
  state is added, `shared/types.ts` first, then server, then client, per the repo's rule).
- The exact trivial-share threshold in the missing-rate guard, and the final `SUB_ERR` after the back-test.
- The wording of the one explanatory line on the card.
