# Usage-rate model separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model's token value (weighted tokens per 1% of the 5-hour window) on the Usage card moves only when that model's own cost moves: every other
model's spend in the same span is priced out at its own joint-fit rate instead of landing on whoever owned the tick.

**Architecture:** One new estimator in `server/lib/usage-rate.ts`, `separatedRate`, computes `W_M / (U − Σ W_m / rate_m)` over the intervals the one-term
joint fit admits, with four guards that publish *why* a span is `thin`. `driftRow`, `surfaceRates`, `mixAdjustedDeviation` and `dailyRates` switch to it;
`poolRate`/`rateFor` stay for the weekly figures, the boost detector and the scripts. A `thinReason` field crosses the boundary so the card's copy can say
why a span is not rated.

**Tech Stack:** Node + TypeScript via `tsx`, node-assert tests (`test/*.test.ts`, each exporting `run()`), React client.

**Spec:** `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`

**How to read this plan (override of the writing-plans template):** tasks give behaviour, signatures, exact values and exact test *cases*, never literal
code. Write the bodies yourself; if a stated value looks wrong against the spec or the code, say so instead of transcribing it. The ~300-line size is a soft
target, not a budget to compress rules into.

## Global Constraints

- No new dependency, outbound call or written file (spec §Anti-goals). Server imports use the `.js` suffix; cross-boundary imports are `import type`.
- `shared/types.ts` first, then server, then client (repo rule "Adding an API field").
- The separated rate **replaces** the pooled one in the row and strip; no second number beside it. A span the separation cannot price reads `thin`, never
  the pooled figure.
- Unchanged by this plan: `poolRate`, `rateFor`, `fitRates`, `explainRates`, `fitSplits`, the weekly figures (`ModelWeeklyRate`), `usage-boost.ts`,
  `DRIFT_PCT` (20), `RAW_SHIFT_PCT`, `BASELINE_FLOORS {30, 15, 7}`, `CURRENT_FLOORS {10, 5, 2}`, `SURFACE_COVERAGE_MIN`, `DOMINANCE` (0.9).
- CSS class names stay; no color literal in `styles.css`. New prose wraps at 160 columns; commit bodies at 72.
- Run one test file with `npx tsx -e "import('./test/<file>.test.ts').then(async m => process.exit((await m.run()) > 0 ? 1 : 0))"`. Never the whole
  `pnpm test` before a push (CI runs it).
- The worktree has no `node_modules`: run `pnpm install` once before Task 1.

## Review Focus

1. A day on which another model ran alone (M spent nothing) must not change M's figure on neighbouring days or the span — its intervals count in `U` and
   are priced out, and M's evidence counters do not count them. Pinned in Task 2 (test "other model's solo interval").
2. Residual ≤ 0 (others' expected points exceed what moved) must never publish a negative or infinite rate: figures null, `thinReason` `mixed`. Task 2.
3. `U(S) = 0` (nothing moved, only idle intervals) must not divide by zero: figures null, reason `floor`. Task 2.
4. Old bug-23 fixtures that set only `Interval.surface` on owned intervals must keep their meaning through the owner fallback. Task 3 keeps the existing
   `mixAdjustedDeviation` tests passing unchanged.
5. A `thin` day cell with null figures (residual ≤ 0) must render a tip, not "no spend" and not `NaN`. Task 5.

---

### Task 1: Contract field and per-model surfaces

**Files:**
- Modify: `shared/types.ts` (`ModelDayState` ~385–398, `ModelDayRate` ~400–427, `ModelRateRow` ~436–520, `ModelSurfaceRate` ~316–324)
- Modify: `server/lib/usage-rate.ts` (`Interval` 87–114, `surfaceOf` 212–228, `withSurface` 232, `joinIntervals` 291–310)
- Test: `test/usage-rate-classify.test.ts`

**Interfaces:**
- Produces: `export type ModelThinReason = 'floor' | 'mixed' | 'repriced' | 'unpriced'` in `shared/types.ts`; optional `thinReason?: ModelThinReason` on
  `ModelDayRate` and `ModelRateRow`, present exactly when that cell's `state` / that row's `verdict` is `thin`.
- Produces: `Interval.modelSurfaces?: Record<string, ModelRateSurface>` — for each model in `tok`, the surface holding ≥ `DOMINANCE` of **that model's own**
  weighted tokens in the interval (same denominator rule as `surfaceOf`: the model's whole `tok`). Absent (not `{}`, not `undefined`) when no model has one.
  `Interval.surface` is unchanged.

- [ ] **Step 1: Failing tests** in `usage-rate-classify.test.ts`:
  - mixed interval, A `{ 'sdk-cli': 9_000, cli: 1_000 }`, B `{ cli: 6_000 }`, both weighted well under 90% of the total: `modelSurfaces` deep-equals
    `{ A: 'headless', B: 'interactive' }`, and `'surface' in interval` is false.
  - A 80:20 across surfaces, B 100% interactive: `{ B: 'interactive' }` only.
  - a line from before surfaces (no `sur`): `'modelSurfaces' in interval` is false.
  - an owned interval keeps `surface` exactly as the existing case at line 51–60 asserts, and also carries `modelSurfaces` for its owner.
- [ ] **Step 2:** run the file; the new cases fail.
- [ ] **Step 3:** add the type and fields; compute `modelSurfaces` in `joinIntervals` and `joinWeeklyIntervals` (both call `withSurface`) from the `sur`
  `gather` already returns. Update existing classify cases that deep-equal whole intervals only by adding the new key; list each one you touch in the
  commit body.
- [ ] **Step 4:** rewrite the JSDoc the spec names as false: `ModelDayState` (`none` = this model spent nothing in any usable window that day; `thin` = has
  figures but under the floor **or** not separable — see `thinReason`), `ModelDayRate` intro (separated rate, not the pooled ratio over owned windows),
  `ModelDayRate.intervals` ("windows this model spent in"), `ModelSurfaceRate.weightedPerPct` (separated, over intervals whose own tokens of this model the
  surface dominates), `ModelRateRow.weightedPerPct` / `mixAdjustedDeviationPct`, and `fitDeviationPct`'s "drift is still judged on the pooled rate alone" →
  "on the separated rate alone".
- [ ] **Step 5:** run the classify file and `pnpm typecheck`; both pass.
- [ ] **Step 6:** commit `feat(usage): record each model's own surface per interval`.

### Task 2: The separated-rate estimator and its guards

**Files:**
- Modify: `server/lib/usage-rate.ts` (new exports after `poolRate`/`rateFor`, ~554–600)
- Test: `test/usage-rate-fit.test.ts` (it already holds the joint-fit cases; add a `separatedRate` block)

**Interfaces:**
- Consumes: `Interval.modelSurfaces` (Task 1), `fitRates`, `usableForRate` (private, same file), `weightedTokens`, `rawTokens`.
- Produces:
  - `export const SUB_ERR = 0.15`
  - `export const SEPARATION_S_CAP: number` — derived, not literal: with `r = DRIFT_PCT / 200`, the `(1 − SUB_ERR)` side gives
    `r / ((1 + r) / (1 − SUB_ERR) − 1)` and the `(1 + SUB_ERR)` side `r / (1 − (1 − r) / (1 + SUB_ERR))`; the cap is the smaller (= 0.34 at 15% / 20).
    The comment carries the derivation from spec §Guards.
  - `export const UNPRICED_TRIVIAL_SHARE = 0.01` — a model whose weighted tokens are ≤ 1% of the span's total is "trivial". Comment: at the ~5× Fable/Opus
    price ratio, 1% of tokens is ≈ 5% of points, under `DRIFT_PCT / 2`.
  - `export interface SeparationContext { horizon: ReadonlyMap<string, number>; current: ReadonlyMap<string, number> }` — weighted tokens per point.
  - `export function separationContext(intervals: Interval[], nowMs: number, current?: Map<string, RateFit>): SeparationContext` — `horizon` from one
    `fitRates(intervals, nowMs − BASELINE_MS, +∞)` (open top, as `currentRange`), `current` from the passed 3-day fit or `fitRates` over `currentRange`.
  - `export interface SeparatedRate { weightedPerPct: number | null; rawPerPct: number | null; intervals: number; utilSum: number; days: number;
    pricedOutShare: number | null; thinReason: ModelThinReason | null }`
  - `export function separatedRate(intervals: Interval[], model: string, sinceMs: number, untilMs: number, ctx: SeparationContext,
    opts: { floors: RateFloors; surface?: ModelRateSurface; checkRepriced?: boolean }): SeparatedRate | null`

**Behaviour** (spec §The estimator, §Guards):
- Span = usable intervals (`usableForRate`) with `toT ∈ [sinceMs, untilMs)`. **All** of them, including those where M spent nothing — that is what cancels
  carry-over. Returns `null` only when M spent nothing in any of them.
- Per interval `r_i = dUtil_i − Σ_{m ≠ M, m priced} W_m,i / rate_m`, where *priced* = has a `ctx.horizon` rate. A model with no rate and a trivial share
  is not subtracted; one with no rate and a non-trivial share sets `unpriced`.
- `U = Σ dUtil`, `R = Σ r_i`, `pricedOutShare = (U − R) / U` (null when `U ≤ 0`). Figures: `weightedPerPct = W_M / R`, `rawPerPct = raw_M / R`, both null
  when `R ≤ 0`. Carried whatever the reason.
- Counters: `intervals` = span intervals where M spent anything, `days` = their distinct UTC dates, `utilSum = max(0, R)`.
- With `surface`: M's surface in an interval is `modelSurfaces?.[M]`, falling back to `surface` when `kind` is `{ model: M }`. The stratum is the
  intervals where M's surface equals it, **plus** a share of every interval where M spent nothing, weighted by `W_M,stratum / Σ_{all strata} W_M,stratum`
  (their dUtil, priced-out points and residual all scaled by that share). Intervals where M spent but has no surface are in no stratum. Then every quantity
  above is computed on the stratum, guards included. (Refines spec §What changes, "stratification": the spec left intervals without M undefined.)
- Guards → `thinReason`, precedence `unpriced` > `repriced` > `mixed` > `floor`, `null` when none fires:
  - `unpriced`: some m ≠ M with share > `UNPRICED_TRIVIAL_SHARE` of the span's weighted tokens has no `ctx.horizon` rate.
  - `repriced` (only when `checkRepriced`): some m ≠ M with share > `UNPRICED_TRIVIAL_SHARE` has both rates and `|current_m / horizon_m − 1| × 100 >
    DRIFT_PCT`. No `current` rate → no trigger.
  - `mixed`: `pricedOutShare > SEPARATION_S_CAP` (covers `R ≤ 0`).
  - `floor`: `U ≤ 0`, or `intervals < floors.minIntervals`, `utilSum < floors.minUtil`, or `days < floors.minDays`.

Test fixtures: models `A` and `B`, tokens all `in` so weighted = raw, the file's existing `NO_FLOOR` (`{ minIntervals: 1, minUtil: 0, minDays: 0 }`,
`usage-rate-fit.test.ts:35`) unless stated, `ctx` built by hand. Expected figures within ±1%. Interval `kind` is **hand-set** in these fixtures, not
derived by `dominantModel`: at these prices a genuinely `mixed` interval (A < 90% of weighted tokens) already has `s` above the cap, so "mixed" below means
`kind: 'mixed'` set by the fixture (review 1).

- [ ] **Step 1: Failing tests** (spec test numbers in brackets):
  - [1] *pure span*: A-owned intervals plus idle intervals carrying A tokens → `W_A total / Σ dUtil`; with no idle intervals it equals `poolRate`'s figure
    exactly; `thinReason` null.
  - [2] *known mix*: 20 mixed intervals each A 1.5M weighted + B 100k weighted, `dUtil` 4 (A 3 pts at 500k + B 1 pt at 100k); `ctx.horizon` B = 100k →
    A = 500k, `pricedOutShare` 0.25, rated; `poolRate` on the same hand-set `mixed` intervals is null. Then add 5 idle intervals (B 100k, `dUtil` 0) each
    followed by an A-owned interval that received their carried point (A 2M, `dUtil` 5): `poolRate` = 400k, `separatedRate` still 500k (W_A 40M, U 105,
    priced out 25).
  - [3] *carry-over*: 10 pairs of (idle interval with B 100k, `dUtil` 0) then (A-owned, A 2M, `dUtil` 5); horizon B = 100k → `poolRate` = 400k,
    separated = 500k, `pricedOutShare` 0.2, rated.
  - [4] *mirror*: same with roles swapped (A 500k idle, B-owned B 400k `dUtil` 5), horizon A = 500k → `poolRate`(B) = 80k, separated B = 100k.
  - *other model's solo interval*: [3]'s fixture plus a day of B-only intervals (B 100k per `dUtil` 1): A's figure unchanged, A's `intervals`/`days`
    unchanged.
  - [5] *sensitivity cap, both sides of one pair* (A 500k, B 100k, both in `ctx.horizon`, mixed intervals): span with B's priced points 40% of `U` →
    A `mixed`, figure carried at 500k; B in the same span (A's points 60%) → `mixed`. Span with B at 25% → A rated, B `mixed`. Span with A at 25% → B
    rated at 100k, A `mixed`. Plus: `SEPARATION_S_CAP` is within 0.001 of 0.34, and scaling every `ctx.horizon` rate by 0.85 at `s` = 0.34 moves A's
    figure by ≤ 10% + 1e-9 (exactly 10% there) and by > 10% at `s` = 0.36 (≈ 11.0%).
  - [5b] *repriced*: [2]'s fixture, `ctx.current` B = 130k → A `repriced` with `checkRepriced`, rated without it; B = 115k → rated; B absent from
    `current` → rated. B's own span with A stable in both maps → rated (the guard never looks at M itself).
  - [6] *unpriced*: B at 5% of weighted tokens, no horizon rate → `unpriced`; B at 0.5% → rated and A = `W_A / U` (B not subtracted).
  - [7] *floor*: residual 4.9 with `minUtil` 5, `s` 0.1 → `floor`; exactly 5 → rated. `U` = 0 (only idle) → `floor`, figures null.
  - [7b] *precedence*: `s` 0.40 and residual under floor → `mixed`; residual ≤ 0 → `mixed`, `weightedPerPct` and `rawPerPct` null; unpriced + mixed →
    `unpriced`; repriced + mixed → `repriced`.
  - *stratum*: A interactive (`modelSurfaces`) in 10 mixed intervals at 500k and headless in 10 at 300k, B everywhere at 100k, no carry-over:
    `surface: 'interactive'` → 500k, `'headless'` → 300k (±1%). A fixture that only sets `surface` on A-owned intervals (no `modelSurfaces`) strata
    identically.
  - *stratum carry-over*: A interactive only, 4 B-only idle intervals (B 100k, `dUtil` 0) each followed by an A-interactive interval holding the carried
    point: the spread share is 1, so `'interactive'` equals the span figure exactly and `'headless'` returns null (M spent nothing there).
- [ ] **Step 2:** run `usage-rate-fit`; new cases fail (missing exports).
- [ ] **Step 3:** implement the constants, `separationContext` and `separatedRate`.
- [ ] **Step 4:** run `usage-rate-fit`; all pass, old cases included.
- [ ] **Step 5:** commit `feat(usage): separated per-model rate with subtraction guards`.

### Task 3: Row, surfaces and mix adjustment on the separated basis

**Files:**
- Modify: `server/lib/usage-rate.ts` (`DriftRow` 499–523, `mixAdjustedDeviation` 630–649, `surfaceRates` 652–661, `driftRow` 676–720, and the JSDoc of
  each, which currently describes owned-interval pooling)
- Test: `test/usage-rate-drift.test.ts`

**Interfaces:**
- Consumes: `separatedRate`, `separationContext`, `SeparationContext`, `ModelThinReason` (Tasks 1–2).
- Produces (each gains a trailing optional `ctx: SeparationContext = separationContext(intervals, nowMs)`, so `scripts/rates-audit.ts` and existing
  callers compile unchanged):
  - `driftRow(intervals, model, nowMs, ctx?) → DriftRow`, with `DriftRow.thinReason?: ModelThinReason`
  - `surfaceRates(intervals, model, nowMs, ctx?) → ModelSurfaceRate[]`
  - `mixAdjustedDeviation(intervals, model, nowMs, ctx?) → number | null`

**Behaviour:**
- `driftRow`: current = `separatedRate` over `currentRange`, `CURRENT_FLOORS`, `checkRepriced: true`; baseline = over `baselineRange`,
  `BASELINE_FLOORS`, no repriced check. A side is *rated* when its `thinReason` is null and both figures are > 0. Unrated side → its `weightedPerPct` /
  `rawPerPct` null, as today. Counters `intervals`/`utilSum`/`days` from current (0 when null), `baselineDays` from baseline. Verdict `thin` with
  `thinReason` = current's reason if current is unrated, else baseline's; a null side (M spent nothing) counts as `floor`. Otherwise the verdict ladder is
  today's, `judged = mixAdjustedDeviationPct ?? weightedDev`, and `thinReason` is absent.
- `surfaceRates`: per `RATE_SURFACES`, current/baseline = the stratum's `weightedPerPct` when that stratum is rated under `CURRENT_FLOORS` /
  `BASELINE_FLOORS` (repriced check on current), else null; `utilSum` = current stratum `utilSum` (0 when null).
- `mixAdjustedDeviation`: baseline rate per surface = rated baseline stratum figure. Over the current window: `moved` = span `utilSum`; for each surface
  with a baseline rate, `covered += stratum utilSum`, `expected += W_M,stratum / baselineRate` — but only for a current stratum whose `thinReason` is null or `floor`; a
  stratum failing `mixed`/`repriced`/`unpriced` drops out (spec §What changes, "drops out of the mix adjustment"), which lowers coverage. Null when `moved ≤ 0`, `covered ≤ 0` or
  `covered / moved < SURFACE_COVERAGE_MIN`; else `(expected / covered − 1) × 100`. M's tokens only — never `totalWeighted` of the interval. No owned-basis
  path remains.

- [ ] **Step 1: Failing tests:**
  - [7c] B at 500k (horizon and current); A interactive at 500k and headless at 300k. Over 14 baseline days and 3 current days, A runs in A-owned
    intervals and in `mixed` intervals where it holds 70% of weighted tokens beside B; in the current window add carry-over (B-only idle intervals
    whose point ticks in the next A-owned interactive interval). Pick counts so that both strata clear `BASELINE_FLOORS` and `CURRENT_FLOORS`, A's
    headless share of weighted tokens in the current window is ≤ 10%, and `poolRate(…, 'interactive')` over current vs baseline deviates by > 20% (proof
    the fixture fools the old basis). Assert: `mixAdjustedDeviationPct` within ±5 (strata sum to the span, so carry-over cancels there); `verdict`
    `stable`; `surfaces[0].weightedPerPct` within 3% of 500k; `surfaces[1]` within 15% of 300k (the spread rule moves part of the B-only intervals'
    negative residual into the small headless stratum — the documented cost of decision 8).
  - row null rules: a fixture whose current window is `mixed` → `verdict` `thin`, `thinReason` `mixed`, `weightedPerPct`/`rawPerPct`/`deviationPct` null,
    `intervals`/`utilSum`/`days` carried non-zero; baseline still published. Baseline under `BASELINE_FLOORS` and current rated → `thinReason` `floor`.
    Both thin with different reasons → the current side's.
  - repriced row: B's current 3-day rate 30% off its horizon rate → A's row `thin`/`repriced`; B's own row is not `repriced`.
  - unpriced row: a third model C at 5% of the current window's weighted tokens with no horizon rate → A's row `thin`/`unpriced`.
  - [7c] keeps both current strata under `SEPARATION_S_CAP`, so neither drops out of the adjustment.
  - a rated row has no `thinReason` key.
- [ ] **Step 2:** run `usage-rate-drift`; new cases fail.
- [ ] **Step 3:** implement. Existing cases in this file built from single-model owned intervals must pass unchanged; if one fails, decide whether it
  encoded owned-only pooling (update it, naming the case and the reason in the commit body) or found a bug (fix the code).
- [ ] **Step 4:** run `usage-rate-drift` and `usage-rate-weekly`; all pass.
- [ ] **Step 5:** commit `fix(usage): judge drift on each model's separated rate`.

### Task 4: Day strip and the endpoint wiring

**Files:**
- Modify: `server/lib/usage-rate.ts` (`dailyRates` 743–780 and its JSDoc)
- Modify: `server/lib/usage-shape.ts:192–260` (`shapeUsageRates`)
- Test: `test/usage-rate-daily.test.ts`, `test/api-usage-rates.test.ts`

**Interfaces:**
- Consumes: `separatedRate`, `separationContext`, `driftRow(…, ctx)` (Tasks 2–3).
- Produces: `dailyRates(intervals, model, nowMs, ledgerStartMs, baselineWeightedPerPct, ctx?: SeparationContext) → ModelDayRate[]` with `thinReason`.

**Behaviour:**
- Each day cell = `separatedRate` over the day clipped to the horizon (as today), floors `{ minIntervals: 0, minUtil: CURRENT_FLOORS.minUtil, minDays: 0 }`,
  `checkRepriced` true only for a day whose end is after `currentRange(nowMs).sinceMs`. State: `pre-ledger` as today; `none` when `separatedRate` is null;
  `thin` when it has a `thinReason` (carried on the cell); else `rated`. Figures carried for `thin`; `deviationPct` computed whenever the figure and a
  baseline exist (unchanged rule).
- `shapeUsageRates`: build `ctx = separationContext(intervals, nowMs, fitted)` once, reusing the existing 3-day `fitted`; pass it to `driftRow` and
  `dailyRates`. `fitDeviationPct` still compares `fit` against `drift.weightedPerPct`. The `models` set, the weekly block and the sort are unchanged.

- [ ] **Step 1: Failing tests** in `usage-rate-daily`:
  - a day where B ran alone and A never spent → A's cell `none`.
  - a day with A's points 60% beside B at 100k → `thin`, `thinReason` `mixed`, figure carried within 1% of 500k.
  - B's current rate 30% off horizon: a day inside the current window with B share 5% → `repriced`; the same mix on a baseline-range day → not
    `repriced`; a current-window day with B share 0.5% → not `repriced`.
  - a day with C (no horizon rate) at 5% of weighted tokens → `thin`, `thinReason` `unpriced`.
  - [8] for one fixture, every rated cell's `deviationPct` equals `(cell / row.baselineWeightedPerPct − 1) × 100` using `driftRow(…, ctx)`'s baseline, and
    a current-window day whose figure equals the row's current figure has the row's `deviationPct`.
  - the existing "thin and still carries its figures" case (line 107–121) still passes and now asserts `thinReason` `floor`.
- [ ] **Step 2:** run `usage-rate-daily`; new cases fail.
- [ ] **Step 3:** implement `dailyRates`, then wire `shapeUsageRates`.
- [ ] **Step 4:** run `usage-rate-daily`, `api-usage-rates`, `usage-boost` and `pnpm typecheck`; all pass. For any `api-usage-rates` expectation that
  changes, name the case and why in the commit body.
- [ ] **Step 5:** commit `fix(usage): price other models out of the day strip`.

### Task 5: Card copy

**Files:**
- Modify: `client/src/lib/usageRatesFormat.ts` (`verdictText` 126–155, `dayTip` 385–398, `RATES_GLOSSARY` `weighted`/`daily`/`window` 441–485,
  `ratesStats` collecting tile ~575–579, `ledgerReading` 614–619)
- Modify: `client/src/components/usage/UsageRates.tsx:205` only if `verdictText`'s signature change requires it
- Test: `test/usage-rates-format.test.ts`

**Interfaces:**
- Consumes: `ModelThinReason`, `thinReason` on `ModelDayRate`/`ModelRateRow` (Task 1).
- Produces: `verdictText(verdict: ModelRateVerdict, thinReason?: ModelThinReason): { label: string; hint: string }`.

**Exact copy** (spec §Why it is thin; labels stay — `thin` is still labelled `collecting`):
- `verdictText('thin', r).hint`: `floor` or absent → today's string unchanged; `mixed` → `most of the current window's points were another model's —
  this model's rate can't be separated from them`; `repriced` → `another model's rate moved in the current window — this one is not judged until it
  settles`; `unpriced` → `another model spent here without a rate of its own yet — this model's rate can't be separated from it`. `ledgerReading`
  (614–635) only calls `verdictText` for non-thin verdicts today; in its thin branch, when `row.thinReason` is present and not `floor`, return
  `verdictText('thin', row.thinReason).hint` before the day-floor/counter composition; `floor` or absent keeps today's composition.
- `dayTip`: early return only for `pre-ledger` and `none`; `none` reads `no spend from this model that day`. A `thin` cell with null figures shows the date
  line, the evidence line and its reason line, no rate line. Reason line: `floor` → today's `under ${DAY_FLOOR_PTS} pts — not coloured`; `mixed` →
  `mostly another model's spend — can't be separated, not coloured`; `repriced` → `another model's rate moved — can't be separated, not coloured`;
  `unpriced` → `another model has no rate yet — can't be separated, not coloured`.
- Collecting tile `sub` when `n('thin') > 0`: `not enough windows, or not separable`.
- Glossary `weighted`: append ` Other models' spend in the same windows is priced out at their own fitted rates, so a busier neighbour does not move it.`
- Glossary `daily`: `Hatched days moved under ${DAY_FLOOR_PTS} pts and are shown but not coloured` → `Hatched days moved under ${DAY_FLOOR_PTS} pts or could
  not be separated from other models' spend, and are shown but not coloured`.
- Glossary `window`: `One window is one 5-hour limit period in which this model spent tokens, alone or beside other models. pts are the utilization
  percentage points left to it once the other models' spend is priced out.`

- [ ] **Step 1: Failing tests:** one per string above, asserting the exact text (each of the four `dayTip` reasons, the null-figure thin cell — no
  `NaN`, no `undefined`, no rate line — the three non-floor hints, the floor hint unchanged, `ledgerReading` of a `repriced` row past both day floors returning the `repriced` hint and of a
  `floor` row returning today's `waiting on …` text, the tile sub, the three glossary entries).
- [ ] **Step 2:** run `usage-rates-format`; new cases fail.
- [ ] **Step 3:** implement. Update the `DAY_FLOOR_PTS` doc comment (36–45) to say the floor is one of four reasons a day is `thin`.
- [ ] **Step 4:** run `usage-rates-format`, `pnpm typecheck`, `pnpm build`; all pass.
- [ ] **Step 5:** commit `fix(usage): say why a token value is not rated`.

### Task 6: Back-test and reference docs

**Files:**
- Create (scratchpad, not committed): a back-test script under the session scratchpad
- Modify: `docs/subsystems/usage-limits.md` (§Token value per model 570, §The fitter 800, §The one-term joint fit 1083, §The day strip 1485)

- [ ] **Step 1: Back-test.** Import the worktree's `server/lib` modules; read the **main checkout's** live data
  (`/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard`: `readRecentSamples(dir, RATES_HISTORY_BYTES)`, `readLedgerSince(now −
  17 d, dir)`, `ledgerStartMs(dir)`) — `chdir` to the scratchpad first, since some `server/lib` writes are cwd-relative. Print, per model with a horizon
  fit and per UTC day: old `poolRate` figure and pts, new figure, state, `thinReason`, `pricedOutShare`. Then per model: cv of rated days old vs new,
  `√(cv²/7 + cv²/2)` against 20, thin-day count per reason, and the 2026-11-09 Opus 5.5 line. Save the output to a scratchpad file; it goes into the PR
  body verbatim.
- [ ] **Step 2: Check the goal.** 2026-11-09 Opus 5.5 carries a figure in its ordinary interactive band (~470–650k), not ~268–326k, expected `mixed`. If
  not, stop and report instead of tuning.
- [ ] **Step 3: Docs.** Rewrite the four sections for the separated rate: the estimator and why (carry-over, owned-only sampling, idle dropped), the four
  guards with their constants and the `S_CAP` derivation, `thinReason`, the stratum rule including intervals without M, what `poolRate` still serves
  (weekly, boost, scripts), the repriced-neighbour limitation (spec §Guards, "Accepted limitation"), and the measured cv with its date. If the separated cv
  breaks the inequality at 20, record that and leave `DRIFT_PCT` and the floors alone (spec §What changes, last bullet).
- [ ] **Step 4:** commit `docs(usage): document the separated token value`.

### Task 6b: Guards judged by their effect (spec §Guards, amendment 2026-11-09)

Added after Task 6's back-test left every current row unrated live; the maintainer picked "V3". The spec's amendment paragraph and the two rewritten guard
bullets are the authority; Task 2's `mixed` / `repriced` definitions and constants above are superseded where they differ. Precedence, `thinReason`,
`pricedOutShare`, `unpriced`, `floor` and every caller's `checkRepriced` choice are unchanged.

**Files:**
- Modify: `server/lib/usage-rate.ts` (constants ~631–660, `SeparationContext` / `separationContext` ~663–685, guard block ~785–800), `server/lib/usage-shape.ts`
  (~221, if the memo needs nothing there, leave it)
- Modify: `test/usage-rate-fit.test.ts` ([5], [5b] and the `SEPARATION_S_CAP` asserts ~296–473), `test/usage-rate-drift.test.ts` (~464–552),
  `test/usage-rate-daily.test.ts` (the repriced day cases, Task 4's "B share 5% / 0.5%")
- Modify: `docs/subsystems/usage-limits.md` (§guards ~962–1004, the cv paragraph ~1033, the row ~1394, the strip ~1607–1611)

**Interfaces:**
- `export const SUB_BOOTSTRAP = 200`; `SUB_ERR` (0.15) stays, documented as the fallback band for a model with no measured one.
  `SEPARATION_S_CAP` is removed (and every import of it).
- `SeparationContext` gains `error: ReadonlyMap<string, { under: number; over: number }>`. It may be empty; a model absent from it uses `SUB_ERR` both
  sides. Hand-built contexts in tests pass an empty map unless the case is about the band.
- A pure helper turns a list of bootstrap draws (ratios `draw / point`) and the resample count into a band: fewer draws than half the resamples →
  `{ under: 0.99, over: 9 }`; otherwise `under = max(0, 1 − p5)`, `over = max(0, p95 − 1)`, percentiles by one stated method (nearest-rank is fine),
  `under` clamped at 0.99. Export it for the tests.
- The bootstrap (exported, takes the intervals and the window): usable intervals of the horizon window — the same `[nowMs − BASELINE_MS, +∞)` the point
  fit reads — grouped by UTC day; `SUB_BOOTSTRAP` resamples of the day keys with replacement from a
  fixed-seed PRNG (seeded per call, so two calls agree); `fitRates` on each concatenated resample over the same window; per model, the draws where it was
  fitted. Only models with a horizon point rate get a band.
- `separationContext` builds `error` beside `horizon`, memoized in one module-level slot keyed on the UTC hour of `nowMs` plus the sorted set of
  models with a horizon rate — not `intervals.length`, which the recorder grows every minute (spec amendment) — so a hit returns the previous context's
  `error` map, the same object. Export a memo reset, unconditionally; every test that builds a context through the bootstrap resets first.

**Behaviour:**
- `mixed`, with `P_m = W_m / rate_m` over the span's priced neighbours and `R = U − Σ P_m`: `R ≤ 0`, or `R − ΔU ≤ 0`, or `R / (R − ΔU) − 1 > DRIFT_PCT /
  200`, or `1 − R / (R + ΔO) > DRIFT_PCT / 200`, with `ΔU = √Σ (P_m · (1 / (1 − min(under_m, 0.99)) − 1))²` (the clamp lives here, so a hand-built band of 1 is safe too) and `ΔO = √Σ (P_m · (1 − 1 / (1 + over_m)))²`. No path
  publishes `Infinity` or `NaN`.
- `repriced` (when `checkRepriced`): for each neighbour m with both a `horizon` and a `current` rate, the residual with m's `P_m` recomputed at its
  `current` rate (others at horizon); trips when that residual ≤ 0 or `|R / R_swap − 1| > DRIFT_PCT / 200`. No token-share gate.

**Tests** (replace the superseded cases; keep every other existing case passing unchanged):
- Sensitivity, one neighbour, empty `error` map (fallback 15%): `s` = 0.40 → `mixed`; `s` = 0.25 → rated; from both sides of one Fable+Opus pair.
- Same `s` = 0.40 span with the neighbour's band `{ 0.03, 0.03 }` → rated.
- Two neighbours, fallback band, each half of `s` = 0.40 → rated (root-sum-square move ≈ 9.1%); the same total on one neighbour → `mixed` (≈ 13.3%).
- Neighbour band `{ 0.99, 9 }` with its `P_m` at 2% of `U` → `mixed` through the `R − ΔU ≤ 0` branch (`ΔU` 1.98·U > `R` 0.98·U), figures finite or
  null, never `Infinity`; at 0.1% of `U` → `mixed` through the ratio branch (≈ 11%).
- Band helper: 99 draws of 200 → `{ 0.99, 9 }`; 100 draws of 200, all 1.0 → `{ 0, 0 }` (exactly half is measured); 200 of 200 all 1.0 → `{ 0, 0 }`; a draw list spanning 0.8–1.3 → `under` ≈ 0.2-ish and `over` ≈
  0.3-ish by the stated percentile method (assert the exact values your method gives, and name the method in the test).
- Bootstrap on a fixture whose every day prices m identically → m's band < 0.5% both sides; on a fixture where m's per-day rate alternates 400k / 600k →
  both sides > 2% (each fixture through the exported bootstrap, or after a memo reset). Determinism: the exported bootstrap run twice on the same
  intervals → deep-equal bands (no memo involved). Memo: after a reset, two `separationContext` calls in the same UTC hour with the same horizon model set
  → the same `error` object (identity); a third with an extra model in the horizon → a new object with a band for that model.
- Repriced by effect: horizon m 500k, current m 650k, `P_m` 40% of `U` → `repriced` with `checkRepriced`, rated without it (move ≈ 13.3%); same rates with
  `P_m` 10% of `U` → not `repriced` (≈ 2.5%); current m 200k with `P_m` 50% of `U` → `repriced` (residual ≤ 0 after the swap); m absent from `current` →
  not `repriced`.
- Day strip: a current-window day whose neighbour swap moves the figure > 10% → `repriced`; the same day on a baseline-range date → not `repriced`; a
  current-window day where the neighbour's share is small enough that the swap moves < 10% → not `repriced`.
- The row: Task 3's "repriced row" case re-expressed so B's swap moves A's current figure > 10%; B's own row still not `repriced`.

- [ ] **Step 1:** constants, band helper and bootstrap, with their tests.
- [ ] **Step 2:** `SeparationContext.error`, memo, and the two guards, replacing the superseded tests.
- [ ] **Step 3:** run `usage-rate-fit`, `usage-rate-drift`, `usage-rate-daily` and `api-usage-rates` test files (one at a time, foreground),
  plus `pnpm typecheck`. Commit `fix(usage): judge the separation guards by their effect on the figure`.
- [ ] **Step 4: Re-run the back-test** (Task 6's script, same live data) and save the new output beside the old. Expect, against the amendment's B = 1000
  measurement: Opus 5.5 current row rated, ~14 of 15 rated days, 2026-11-09 rated near 526k, cv under the inequality at 20. If the Opus current row is not
  rated or 2026-11-09 is not rated, stop and report instead of tuning.
- [ ] **Step 5: Docs.** Rewrite `usage-limits.md`'s guard section for the measured-band `mixed` and effect-based `repriced` (with `SUB_BOOTSTRAP`, the seed,
  the memo and its ~1.4 s hourly cost dated 2026-11-09), replace the "repriced guard can dominate" paragraph with the new back-test numbers dated, and
  update the cv paragraph, the row and the strip examples. Commit `docs(usage): document the measured-band separation guards`.

### Task 7: Look at the card

- [ ] **Step 1:** invoke `/ui-verify` on the Usage card against the live API (worktree dev servers on 4273/5273 per memory "Worktree dev setup"; record
  each pid and kill only those). Check: no row shows a pooled-looking Opus figure on 2026-11-09; a thin day's tip shows its reason; the glossary entries
  read as specified; nothing overflows at 1440 px or phone width.
- [ ] **Step 2:** fix defects on the branch; anything not checked goes on the PR's "not verified" line.
