# Review 1 — `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-11-09. Checklist: facts vs code, internal consistency, edge cases, copy, scope, CLAUDE.md rules.
Code read: `server/lib/usage-rate.ts` (constants 405–482, `poolRate`/`rateFor` 554–598, `mixAdjustedDeviation` 630–649, `driftRow` 676–720,
`dailyRates` 743–772, `usableForRate`/`explainRates`/`fitRates` 1356–1481), `server/lib/usage-shape.ts` 190–262, `shared/types.ts` 300–535,
`client/src/lib/usageRatesFormat.ts` 70–95, 380–490, `docs/subsystems/usage-limits.md` 1148–1162, git log for #323.

## Verdict

**APPROVE WITH FIXES.** The estimator, the interval set and the four-numbers-on-one-estimator rule are stated precisely and match the code they
cite. The gaps are in the guard section and in what the separated basis does to the row's *other* published numbers (raw rate, evidence counters,
`thin` semantics), each of which an implementer would have to guess.

## Facts checked against the code (all true unless listed under findings)

| Spec line | Claim | Code |
|---|---|---|
| 17 | headline, verdict, strip all come from `poolRate`; `DOMINANCE` = 90% | `usage-rate.ts:25`, `:145-149`, `:587-598`, `:753` |
| 22 | two-term fit comment: "spend often lands in one interval and its visible rise in the next" | `usage-rate.ts:1005-1006` (`usableForSplit` doc) |
| 26 | an interval whose utilization did not move is `idle`, never owned | `usage-rate.ts:269` (`idle` tested before ownership) |
| 47 | `usableForRate` admits owned, `mixed`, `idle`; excludes `external` and every `isUnpriced` kind | `usage-rate.ts:1356-1358`, `:69-84` |
| 50–51 | `baselineRange` = `[now−17d, now−3d)`; the card's existing `fitRates` call is 3-day | `usage-rate.ts:526-528`, `usage-shape.ts:201-203` |
| 79 | `CURRENT_FLOORS.minUtil` is the strip's floor | `usage-rate.ts:461`, `:757` |
| 87 | `fitDeviationPct` compares the 3-day fit against the row's published rate | `usage-shape.ts:242` |
| 89 | surface mix adjustment is computed over owned intervals | `usage-rate.ts:640-641` (`ownedBy`), `surface` only on owned intervals `:109-114` |
| 94–96 | `DRIFT_PCT` = 20; floors derived from cv ≈ 24% via √(cv²/7 + cv²/2) | `usage-rate.ts:420`, `:453-461` |
| 109 | weekly figures have their own pairing and no drift verdict | `shared/types.ts:353-368`, `usage-shape.ts:206-212` |
| 123 | `test/usage-rate*.test.ts` exist | `test/usage-rate-{classify,daily,drift,fit,weekly}.test.ts` |

Not verifiable from the repo: every measured figure at lines 9–10, 21–28, 32–37, 59 (scratch scripts over the live ledger; the scripts are not in
the tree and `scripts/probe-usage-split.ts` prints the split, not per-day pooled rates). Taken as the author's measurement.

## Findings

### Important

**[I1] spec:68–72 — the sensitivity bound is algebraically a fixed cap on the priced-out share, the very guard the paragraph rejects.**
With `X = Σ W_m/rate_m` and `s = X/U(S)`, scaling every `rate_m` by `(1+ε)` moves the separated figure by `−sε/(1+ε−s)` and by `(1−ε)` by
`+sε/(1−ε−s)`. At `SUB_ERR` = 0.15 and `DRIFT_PCT/2` = 10 the second exceeds 10% exactly when `s > 0.34`, the first when `s > 0.46`. So "either
perturbation past `DRIFT_PCT/2`" ≡ "other models account for more than ~34% of the span's points" — a cap, with a value nobody chose. The paragraph's
own argument against a cap (a minor model beside an Opus driver is `thin` on almost every span) therefore applies unchanged, and Goal line 104
("every model that runs beside others gets a rate that is its own") is not something the back-test can rescue; line 72's hedge does not resolve the
contradiction with line 69. → Either state the equivalence and accept it (drop "symmetric for driver and minor models", rewrite line 104 as a
goal for the *driver*), or choose a guard that is not a function of `s` alone (e.g. an absolute floor on M's own expected points, `W_M/rate_M`, on
top of the residual floor). Test 5's "same minor model … holds enough of the points → rated" (line 133) then needs the threshold it is written to.

**[I2] spec:79 vs spec:81 — two different floors for "too little left".** Line 79 names `CURRENT_FLOORS.minUtil` (5) for every span; line 81 says the
existing floors apply per window, which for the baseline span is `BASELINE_FLOORS.minUtil` (15, `usage-rate.ts:460`). A baseline residual of 10
points is rated by line 79 and `thin` by line 81. → State: residual floor is the span's own — `CURRENT_FLOORS` for day cells and the current window,
`BASELINE_FLOORS` for the baseline window.

**[I3] spec:81 — `minIntervals` and `minDays` are undefined on the separated basis, and so are the evidence counters the card shows.**
`rateFor` counts *owned* intervals and their dates (`usage-rate.ts:554-575`); `explainRates` counts intervals where the model spent anything
(`:1408-1420`). The separated span reads owned + mixed + idle. Which count clears `BASELINE_FLOORS.minIntervals` = 30 / `minDays` = 7? The same
ambiguity reaches `DriftRow.intervals/utilSum/days/baselineDays` (`usage-rate.ts:512-522`) and `ModelDayRate.intervals/utilSum` (`shared/types.ts:417-421`),
documented as "windows this model owned" / "points those windows moved", and rendered by the card as "no windows this model owned"
(`usageRatesFormat.ts:389`) and the glossary entry "One window is one 5-hour limit period that one model owned (≥90% …)" (`:479-481`). → Define
`intervals` = intervals in S where M spent > 0 weighted tokens (the `explainRates` convention), `days` = their distinct UTC dates, `utilSum` =
the residual, and name the two client strings as copy to update.

**[I4] spec:85 — `rawPerPct` is not assigned to either estimator, and the `mix-shift` verdict is judged on it.** `driftRow` computes `rawDev` from
`current.rawPerPct` / `baseline.rawPerPct` and the verdict chain tests it against `RAW_SHIFT_PCT` (`usage-rate.ts:706-718`). The spec lists four
numbers that switch and omits raw; an implementer who leaves `rawPerPct` pooled ships a verdict mixing two estimators, which lines 86 and 91 forbid.
→ Define `rawPerPct(M,S)` = M's raw tokens over the same intervals ÷ the same residual, and add it to the list at line 85.

**[I5] spec:65, 75 — what a guard-`thin` row publishes.** Line 65 says a `thin` span carries its figures. Today a `thin` *row* publishes no rate at
all: `rateFor` returns null under the floors and `driftRow` leaves `weightedPerPct`, `baselineWeightedPerPct` and `deviationPct` null
(`usage-rate.ts:689-704`); only the strip's `thin` cell carries figures (`:757-769`). Under the sensitivity and repriced-neighbour guards the
current window *has* a figure. → State per guard whether `DriftRow.weightedPerPct` / `deviationPct` are carried (and the badge reads `thin`) or
nulled; the client's tooltip and badge copy follow from that.

**[I6] spec:70–71 — "perturb every `rate_m` by ±`SUB_ERR`" does not say jointly or one at a time.** Perturbing all together in one direction is the
extremal case for a sum (and what [I1]'s algebra assumes); perturbing one at a time gives a smaller move and a different `thin` set. Test 5
(line 132) is written to whichever the builder picks. → Specify: all `rate_m` scaled together by `(1+SUB_ERR)` and, separately, by `(1−SUB_ERR)`.

**[I7] spec:73–76 — repriced-neighbour guard, three undefined edges.** (a) m has no 3-day fit — `fitRates` omits a model on any of three refusals
(`usage-rate.ts:1293-1305`, `:1476-1481`); is the guard then off, or does M go `thin`? (b) "each affected day cell is `thin` too" — which cells:
the current window's three days, every day m spent anything, or every day? (c) `rate_m` is fitted over the whole horizon, so after m reprices the
horizon rate is a blend and *baseline-range* days are mis-subtracted in the other direction; the spec says only the current verdict and "affected"
cells go `thin`. → Define (a) and (b); for (c) either accept the baseline bias in writing or mark the baseline `thin` as well when the guard fires.

**[I8] spec:118–119, 151–152 — `shared/types.ts` edits are limited to "only if a field or state is added", leaving the contract's JSDoc false.**
`ModelRateRow.fitDeviationPct` says "drift is still judged on the pooled rate alone, which is the only quantity with a measured baseline dispersion"
(`shared/types.ts:509-517`); `ModelDayRate` says "the same pooled ratio as the row's own rate" (`:403-408`); `ModelDayState.thin` says "owned windows,
but under the … floor" (`:393-396`); `ModelSplitVerdict`/`ModelFitVerdict` describe the verdict as "drift of the single pooled rate" (`:329-350`).
CLAUDE.md names `shared/types.ts` as the single source of truth for the API contract. `docs/subsystems/usage-limits.md:1150-1156` ("excluded from
every drift verdict … the pooled rate stays the headline") and the client glossary `weighted` entry (`usageRatesFormat.ts:441-446`) likewise. → List
the JSDoc and doc paragraphs that change as in-scope, independent of whether a field is added.

### Minor

- **spec:36** — `SPAWN_OWN_ENTRYPOINT` PR #323 merged 2026-10-27 (`git log 82e730f`), and the flag is opt-in (`.env.example:148`, off by default). If
  2026-10-28 is the day it was switched on here, say so; otherwise the date is off by one.
- **spec:50–51** — `[now − BASELINE_MS, now)` is closed at `now`; `currentRange` is open at the top on purpose (`usage-rate.ts:530-537`) and every
  horizon read in `usage-shape.ts` uses `Number.POSITIVE_INFINITY` (`:265-278`). An interval stamped a moment ahead of the request clock would be
  in the current window but out of the horizon fit. Use the open top.
- **spec:50** — floors for the horizon `fitRates` call are unstated; the default is `CURRENT_FLOORS` (`usage-rate.ts:1476-1478`), i.e. `minDays` = 2
  over 17 days. Name it (or `BASELINE_FLOORS`) so the back-test and the code agree.
- **spec:77** — "refused `thin`": `fitRates` omits a model on `thin-evidence`, `unidentified` or `negative` (`usage-rate.ts:1293-1305`); the
  card's `fitVerdict` collapses all three to `thin`. Say "has no entry in the horizon `fitRates` map" so `unidentified` is unmistakably covered.
- **spec:92** — "where it already explains the pooled rate": the card's glossary never uses the word pooled; the only "pooled" copy is the weekly
  aside (`usageRatesFormat.ts:86`). The `weighted` entry (`:441-446`, "Drift is judged on this and nothing else") is the natural home — name it.
  The `fitted` entry's "has no baseline yet" and the `Window · pts` entry (`:479-483`) are the other two strings the change touches.
- **spec:47, 150** — `usableForRate` is module-private (`usage-rate.ts:1356`); reusing it means exporting it, which is fine, but say so since
  `test/usage-rate-fit.test.ts` may then want it.
- **spec:127** — "(±1%)": on noise-free synthetic intervals built as `dUtil = W_A/500k + W_B/100k` the separated figure is exact; a tolerance
  invites a looser fixture than needed. Either assert near-equality to float precision or state the noise the fixture adds.
- **spec:9** — "5–6x" is the card's reading; the code comment's earlier measurement is 4.2–4.4x (`usage-rate.ts:1140-1143`). Not a contradiction
  (different dates and estimators), but the doc could cite one.
- **spec:144** — "how many days the guard turned `thin`" — say per guard, since [I1] predicts the sensitivity guard dominates for minor models and
  that is the number the maintainer will want to see on its own.

## Not verified

- No live-ledger figure in the spec was recomputed (no script in the repo prints them; writing one would mean `server/lib` state files under the
  review's cwd).
- The card's rendering of a `thin` row with a non-null rate was not checked in a browser; [I5] is from the server shape alone.
