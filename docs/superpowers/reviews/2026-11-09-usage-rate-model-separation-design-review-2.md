# Review 2 — `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-11-09, round 2. Focus: the round-1 diff (`git diff HEAD~1 -- docs/superpowers/specs/`), checked against the
whole document for consistency. Code read: `server/lib/usage-rate.ts` (kinds 60–125, constants 415–482, `poolRate`/`rateFor` 545–598,
`mixAdjustedDeviation` 630–649, `driftRow` 676–720, `dailyRates` 743–772, `explainRates`/`fitRates` 1389–1490), `server/lib/usage-shape.ts` 185–280,
`shared/types.ts` 300–352, 390–425, 440–460, 505–520, `client/src/lib/usageRatesFormat.ts` 36–48, 100–215, 385–396, 438–484, 577–578,
`client/src/components/usage/UsageRates.tsx` 70–82, 197–215, `docs/subsystems/usage-limits.md` headings, git log for #323.

## Verdict

**REVISE.** Round 1's findings I1–I8 are all addressed and the fixes are right: the sensitivity bound is now stated as the derived cap (the algebra at
spec:70–72 recomputes correctly — `(1−s)/(1−s/(1±ε))`, the `(1−ε)` side binds at `s > 0.34`, the `(1+ε)` side at `s > 0.46`), the residual floor is the
span's own, the evidence counters are defined, `rawPerPct` is assigned, the `thin` row/cell split is stated, the repriced-neighbour edges are defined, and
the contract/doc paragraphs are in scope. What blocks is the surface-mix paragraph (spec:105–107): its "proper" path cannot be built as written because
mixed and idle intervals carry no surface, and its permitted fallback path reinstates the exact verdict failure the change exists to remove, through the
`judged = mixAdjustedDeviationPct ?? weightedDev` line in `driftRow`. Three further Important items are copy and contract gaps an implementer would
otherwise ship false.

## Round-1 fixes verified

| Round-1 finding | Spec lines now | Checked |
|---|---|---|
| I1 cap equivalence | 68–75, 123–126 | derivation recomputed, cap value right, goal rewritten for the driver |
| I2 two floors | 86–87 | `BASELINE_FLOORS.minUtil` 15 / `CURRENT_FLOORS.minUtil` 5 (`usage-rate.ts:460-461`), strip uses the latter (`:757`) |
| I3 evidence counters | 89–91 | `explainRates` counts intervals with `weighted[m][i] > 0` (`usage-rate.ts:1411-1418`) — matches |
| I4 `rawPerPct` | 100–102 | `mix-shift` judged on `rawDev` vs `RAW_SHIFT_PCT` (`:706-717`) — matches |
| I5 thin row vs cell | 93–95 | `driftRow` nulls the rate under refusal (`:689-704`); `dailyRates` carries figures (`:757-769`) — matches, with one caveat below (M5) |
| I6 joint vs one-at-a-time | 68–70 | all `rate_m` scaled together, both directions |
| I7 repriced-neighbour edges | 79–83 | (a) no 3-day fit → guard off; (b) affected cell defined; (c) baseline bias accepted in writing |
| I8 contract JSDoc | 111–113 | `shared/types.ts:329-350`, `:393-408`, `:509-517` are the paragraphs named; `usage-limits.md` §Token value per model (:570) and §The day strip (:1485) exist |

## Findings

### Critical

**[C1] spec:105–107 — the v1 fallback ("keep the surface strata on the old owned-interval basis … only if it says so in the PR") ships the verdict
this change exists to fix.** `driftRow` judges `const judged = row.mixAdjustedDeviationPct ?? weightedDev` (`usage-rate.ts:714-715`), and
`mixAdjustedDeviation` is owned-only: it sums the owned intervals' `dUtil` — carried-over points included — against `totalWeighted(interval.tok) / baselineRate`
(`:639-645`). On the 2026-11-09 shape the spec itself describes (5 owned points, ~2.6 explained by tokens, spec:21–22) that is `expected/covered − 1 ≈ −48%`,
`|judged| > DRIFT_PCT` → `drift`, regardless of what the separated `weightedDev` says. Disclosure in the PR does not change the badge. The paragraph's own
first sentence ("or the verdict would mix two estimators") and Goal line 127 ("strip, headline and verdict agree") are violated by the escape hatch it
then grants. → Remove the fallback; or, if it stays, require that under it `mixAdjustedDeviationPct` is published for information only and `judged` is the
separated `weightedDev` (and say that `surface-shift` is then unreachable in v1, and that `verdictText('surface-shift')` / `drift`'s hint "measured surface
by surface" at `usageRatesFormat.ts:131-132, 142-143` are disclosed as not yet true).

### Important

**[I1] spec:105–106 — "computed on the separated basis too" is not buildable as written.** `Interval.surface` exists only on model-owned intervals
(`usage-rate.ts:107-114`: "Only a model-owned interval ever carries one"; `surfaceOf` `:217-226` requires the *owner's* tokens to be ≥ `DOMINANCE` from one
surface). Mixed and idle intervals — the ones the separated basis adds — have no surface, so there is no stratum to assign their residual points to, and a
per-surface baseline rate (`rateFor(…, surface)` `:635`) cannot be formed on the new basis either. An implementer must invent the stratification. → Define
it (e.g. each usable interval's surface = the surface that spent ≥ `DOMINANCE` of **M's own** tokens in it, absent otherwise; residual points of that
interval go to that surface; coverage counted as today against `SURFACE_COVERAGE_MIN`), or move the stratification to "Left to the builder" with those
constraints and the no-silent-mix rule stated against [C1].

**[I2] spec:140–141 contradicts spec:111.** Anti-goals: "`shared/types.ts` (only if a field or state is added)"; What changes: "Contract and reference docs
are in scope whether or not a field is added". → Drop the parenthetical at line 140.

**[I3] spec:93–95, 108–110, 173 — the client's `thin` copy becomes false under the three new guards and is not listed as in scope.** Every `thin` day cell
tips `under ${DAY_FLOOR_PTS} pts — not coloured` (`usageRatesFormat.ts:396`; `DAY_FLOOR_PTS` = 5 with the comment "the floor under which the server marks a
day `thin`; the tip names it" `:42-47`). A cell made `thin` by the sensitivity cap, a repriced neighbour or a missing rate can hold 40 points, and the tip
would say "under 5 pts". The same for the row: the collecting tile's sub "not enough windows yet" (`:578`) and `verdictText`'s default hint "a verdict needs
7 separate days behind the baseline and 2 behind the current window" (`:148-152`, the hint the fold line and the "Collecting is the normal first fortnight"
note at `UsageRates.tsx:352` both read) describe only the evidence floors. Line 173 leaves "whether `ModelDayState` needs a new reason" to the builder while
leaning `thin`; that lean is only consistent with the copy rule (checklist 4) if the copy is reworded to cover the guards, or a reason is published. →
Either add a reason to `ModelDayState`/`DriftRow` (then `shared/types.ts` first, per CLAUDE.md), or list `:396`, `:578`, `:148-152` as in-scope copy with
wording that covers both "too few points" and "cannot be separated from the models it ran beside", and say which in the spec rather than leaving it to
the builder.

**[I4] spec:99–107 — `DriftRow.surfaces` is assigned to neither estimator.** `surfaceRates` (`usage-rate.ts:652-660`) publishes per-surface `rateFor`
figures on the pooled owned basis (`shared/types.ts:316-324`, "intervals this surface dominates only"), and the card renders them under the model name as
"interactive 455k · headless 249k" (`usageRatesFormat.ts:196-201`, `UsageRates.tsx:197-203`). With the headline separated and the strata pooled, one row
shows two estimators side by side — the anti-goal at line 138 in another shape. → State that `surfaces` moves to the same basis as the mix adjustment
([I1]), and if the owned basis is kept for them, that the glossary/JSDoc says so.

### Minor

- **spec:123–124 vs 93–94** — Goal: "Opus's token value … either a rated figure … or `thin` carrying a figure in that band". A `thin` *row* publishes
  null `weightedPerPct` (line 93, `usage-rate.ts:689-704`); only the strip cell carries. Say "day cell" in the goal, or "the row shows the joint-fit figure".
- **spec:79–81** — "above the trivial share used by the missing-rate guard": that guard's share is of **weighted tokens** (line 84, forced because an
  unpriced model has no points); the affected-cell test is on **priced-out points**. Fable at ~10% of tokens is ~40% of points at the rates on line 9. Say
  the threshold number is reused across the two units on purpose, or give the affected-cell test its own number.
- **spec:154–155, test 5** — in a noise-free two-model span `U = W_O/r_O + W_F/r_F` exactly, so `s_Opus + s_Fable = 1` and at most one of the pair is
  under a 0.34 cap in any one span. "From both sides of one pair" therefore needs three spans (s = 0.40 → both `thin`; an Opus-driven s = 0.25; a
  Fable-driven s = 0.25), not two. Say so, or the builder writes two spans and the Fable-side "rated" case is impossible.
- **spec:94–95** — "unjudged (as `dailyRates` already does)": `dailyRates` computes `deviationPct` for `thin` cells too (`usage-rate.ts:765-767`); it is
  the client that leaves them uncoloured (`UsageRates.tsx:76-80`) while the tip still prints "vs baseline" (`usageRatesFormat.ts:392-393`). Say
  "uncoloured" only, or state that the server nulls `deviationPct` on guard-`thin` cells.
- **spec:89–91** — `none` is undefined on the new basis. Today `none` = owned no window (`shared/types.ts:393`, `usage-rate.ts:756`); the natural
  redefinition is "M spent nothing in any usable interval of S" (`intervals` = 0). One sentence.
- **spec:112** — "`ModelDayRate` ~393–408": the `intervals`/`utilSum` JSDoc that reads "Windows this model owned that day" / "points those windows moved"
  is at `shared/types.ts:417-421`, outside the quoted range. `DriftRow.intervals` ("Intervals behind the current-window fit", `:457-458`) is fine as is.
- **spec:50, 84, 164** — a subtraction model that always ran beside M over the horizon can be refused `unidentified` by the horizon fit
  (`usage-rate.ts:1465-1468`, `independentShare < SPLIT_MIN_INDEPENDENT_SHARE`); then the missing-rate guard makes every span where it is non-trivial
  `thin`, which is correct by the anti-goal at line 139 but may be most of Opus's spans if Fable is only ever a reviewer. The back-test should report which
  models got a horizon fit and which refusal the others hit — line 164's "for every model with a fit" implies it but does not ask for it.
- **spec:116** — "√(cv²/7 + cv²/2)" quotes the code comment (`usage-rate.ts:453-456`); fine.

### Round-1 Minor items still open (not re-argued; listed so the author can close or decline them)

- spec:36 — #323 merged 2026-10-27 (`82e730f`); "2026-10-28" is the day the opt-in flag was switched on here, or off by one.
- spec:51 — `[now − BASELINE_MS, now)` is closed at `now`; every horizon read in `usage-shape.ts` uses `Number.POSITIVE_INFINITY` (`:265-278`).
- spec:50 — floors for the horizon `fitRates` run are unnamed (default `CURRENT_FLOORS`, `usage-rate.ts:1485-1487`).
- spec:84 — "refused `thin`" collapses `thin-evidence` / `unidentified` / `negative`; "has no entry in the horizon `fitRates` map" is unambiguous.
- spec:149 — "(±1%)" on a noise-free fixture; the separated figure is exact there.
- spec:47, 172 — `usableForRate` is module-private (`usage-rate.ts:1352`); reusing it means exporting it.

## Not verified

- No live-ledger figure in the spec (lines 9–10, 21–28, 32–37, 59, 74, 124) was recomputed; no script in the repo prints them and writing one would
  write `server/lib` state files under the review's cwd.
- The card's rendering of a guard-`thin` cell or row was not looked at in a browser; [I3] and the strip Minor are from the client source alone.
