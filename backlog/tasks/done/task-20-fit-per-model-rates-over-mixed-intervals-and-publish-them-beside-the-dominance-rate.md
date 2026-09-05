---
id: task-20
title: Fit per-model rates over mixed intervals and publish them beside the dominance rate
created: 2026-09-05
from: idea-13
updated: 2026-09-05T18:53:29Z
started: 2026-09-05T18:31:17Z
execute-elapsed: 1332
execute-tokens: 235391
---

## Goal

Give every model a weighted rate fitted over the intervals `DOMINANCE` throws away, publish
it beside the pooled dominance rate, and say out loud when the two estimators disagree.

`idea-13` was filed on a fear — that mixed intervals could be "most of the data", leaving the
card on `collecting` forever. **Measured on this machine's own logs, that fear is wrong and
the real finding is worse.** Probe over the 17-day baseline horizon, 2026-09-05
(`tsx scripts/probe-usage-split.ts --days 17`, plus a scratch one-term variant):

- `mixed` is **113.0 of 1640.0 moved points — 6.9%**, across 88 of 2011 intervals. It is not
  starving the card. `pre-ledger` (26.7%) and `external` (9.5%) are the larger refusals, and
  the first ages out by itself.
- But those 6.9% of points carry most of the *information*. A one-term joint OLS of `dUtil`
  on per-model weighted tokens, run over owned + mixed + idle intervals, disagrees with the
  pooled dominance rate the card publishes today by far more than `DRIFT_PCT`:

  | model | pooled (card today) | one-term joint OLS | gap |
  |---|---|---|---|
  | `claude-opus-5` | 0.2255M weighted/pt | 0.3569M | **+58%** |
  | `claude-fable-5` | 0.0764M | 0.1217M | **+59%** |
  | `claude-fable-5-1` | 0.0627M | 0.1513M | **+141%** |
  | `claude-sonnet-5` | 0.2102M | 0.3917M | **+86%** |
  | `claude-haiku-4-5-20251001` | 0.0244M | 0.2841M | **+1064%** |
  | `claude-opus-4-8` | *no rate — 0 owned intervals* | 0.2420M | — |

  These OLS figures are **ungated** — no identifiability or evidence floor was applied — so
  the bottom three rows are almost certainly refused once the gates in this plan are on.
  Step 1 exists to find out which survive rather than to assume.
- `claude-opus-4-8` appears in the ledger across the window and **owns not one interval**, so
  `shapeUsageRates` gives it no row at all. A model used only as a subagent alongside a
  driver model is invisible to this card today. That is the concrete user-visible defect.
- Dropping mixed intervals also makes the joint design **singular** on this data (sets
  "owned only" and "owned + idle" both fail to solve). The proximate cause is `opus-4-8`'s
  all-zero column in those sets rather than a rank collapse among the other models — state it
  that way; do not claim mixed intervals rescue rank in general.

## Plan

**Plan-format override, deliberate, per `.claude/CLAUDE.md`:** this plan gives behaviour,
signatures and exact test cases. It contains **no literal code blocks** on purpose. Handed
code gets transcribed verbatim and a bug in the plan becomes a bug in the branch with nobody
positioned to catch it. Disagree with anything here in the PR body rather than transcribing
around it.

### The decision this task encodes, and what was rejected

The pooled dominance rate **stays the headline and stays the quantity drift is judged on.**
The fitted rate is published beside it and is **excluded from every drift verdict**. This is
`idea-13`'s third open question answered on the conservative branch, for three reasons:

1. There is no baseline history for the new estimator. `BASELINE_FLOORS`/`CURRENT_FLOORS` and
   `DRIFT_PCT` were tuned against the *measured* day-to-day dispersion of the pooled ratio
   (cv ≈ 24%, see `usage-rate.ts`). Nothing has measured the fitted rate's dispersion.
2. Swapping the drift quantity silently rewrites every verdict on the card with no way for a
   reader to see that it happened.
3. The two-term fit's own cross-model ratio came back **refuted** on live data — opus:fable
   at 0.79x where the API list ratio is 2.00x — so a fitted number is not automatically the
   more trustworthy one. `bug-13` already settled that this card must not claim cross-model
   comparability; the new line inherits that limit, not an exemption from it.

Also rejected, and not to be built here: regularisation toward the clean-interval rate
(`idea-13`'s second open question). The existing fit answers ill-conditioning by **refusing**,
not by shrinking toward a prior, and a prior would make the fitted number partly an echo of
the pooled number it is supposed to be an independent check on. Drift on the fitted rate is a
separate follow-up idea, to be filed only once this estimator has weeks of history.

### Server — `server/lib/usage-rate.ts`

Add a one-term joint fit beside the existing two-term one, reusing its primitives. `project`,
`independentShares` and `leastSquares` already exist in this file and are the right tools;
do not write a second solver.

1. **`usableForRate(interval): boolean`** — a new, separate predicate. Admits `{model}`,
   `mixed` and `idle`; rejects everything `isUnpriced` names and rejects `external`. Route the
   unpriced test through `isUnpriced` for the reason its own JSDoc gives — a kind added later
   beside `gap` must not walk into the fit.

   **It must NOT test `reqUsable`.** That flag is a two-term-only requirement: a missing
   request count says nothing about the token totals, and `usableForSplit` gates on it only
   because its second regressor is the request column. On the live ledger 2000 of 5019 lines
   carry no `req`, so copying `usableForSplit` wholesale here would throw away ~40% of the
   evidence for no reason. Test case 7 exists to catch exactly that copy.

2. **`explainRates(intervals, sinceMs, untilMs): RateDiagnostic[]`** — the diagnostic form,
   mirroring `explainSplits`. Windowed on `toT`, half-open `[sinceMs, untilMs)`, same as every
   other windowed function in this file.

   - One column per model: that model's weighted tokens over the fitted rows, in units of 1M
     (`MTOK`), unit-normed before the solve exactly as the two-term fit normalises, so
     `SPLIT_RANK_TOL` keeps meaning "a share of the column's own length".
   - `y` is `dUtil` per row. No intercept, same as the two-term fit.
   - Solve with `leastSquares(cols, y, SPLIT_RANK_TOL)`.
   - Compute `independentShares(cols)` and refuse any model under
     `SPLIT_MIN_INDEPENDENT_SHARE`. This is the guard that matters most here: one column per
     model means there is no within-model `r²` question at all, so `SPLIT_MAX_R2` has nothing
     to say and must not be applied — cross-model collinearity is the entire risk, and
     `independentShares` is the instrument for it.
   - Evidence per model = rows in which that model spent anything (weighted tokens > 0), the
     cumulative `dUtil` over those rows, and the distinct UTC dates they fall on — the same
     three counters `explainSplits` reports, counted the same way.
   - Floors: reuse **`CURRENT_FLOORS`** (10 / 5 / 2), not `SPLIT_FLOORS`. `SPLIT_FLOORS` is
     doubled because the split fits two parameters per model; this fits one, the same count
     the pooled ratio fits, so it earns the same floor. Say so in the JSDoc — the next reader
     will otherwise assume the higher floor was an oversight.
   - Refusal vocabulary, reusing the words the probe and docs already use:
     `'thin-evidence'` (under the floors) → `'unidentified'` (no coefficient, or independent
     share under the threshold) → `'negative'`. Report them in that order, most-informative
     first, for the same reason `explainSplits` does.
   - A negative coefficient is a **refusal, not a clamp** — identical reasoning to the
     two-term fit, and the diagnostic keeps the signed raw value so the probe can print it.
   - `RateDiagnostic` fields: `model`, `intervals`, `utilSum`, `days`, `independentShare`,
     `refusal: RateRefusal | null`, `fit: { weightedPerPct, pctPerMWeighted, intervals,
     utilSum } | null`, `raw: number | null` (the signed `pt/Mtok` coefficient before the
     floors and the sign refusal, null when the column was never in the solve).
   - `weightedPerPct` is `MTOK / pctPerMWeighted` — the same unit the pooled rate and the card
     already speak, so the two numbers on the row are directly comparable. Guard the division:
     a zero or non-finite coefficient is a `negative`/`unidentified` refusal, never an
     `Infinity` published as a rate.

3. **`fitRates(intervals, sinceMs, untilMs): Map<string, RateFit>`** — the filtered form, one
   entry per model whose `fit` is non-null. Exactly the shape and one-line JSDoc `fitSplits`
   has.

4. **`fitDeviation(fitted, pooled): number | null`** — signed percent of the fitted rate
   against the pooled rate, null when either is null or the pooled rate is ≤ 0. Reuse the
   existing `deviation` helper for the arithmetic rather than repeating the formula; export
   only what `api.ts` needs.

### Server — `shared/types.ts` first, then `server/api.ts`

`shared/types.ts` is the contract and changes first, per the repo's ordering rule.

5. **`shared/types.ts`** — on `ModelRateRow`, three new **required** fields, each with the
   JSDoc house style of its neighbours (nulls mean *not enough evidence to say*, never zero):
   - `fittedWeightedPerPct: number | null` — weighted tokens per 1%, fitted jointly over the
     intervals the dominance rate discards. Null whenever `fitVerdict` is `thin`.
   - `fitVerdict: ModelFitVerdict` — a new `'fitted' | 'thin'` alias, collapsing the four
     refusals exactly as `ModelSplitVerdict` already collapses `SplitRefusal`. Keep the
     detailed refusal diagnostic-only; the API does not carry it.
   - `fitDeviationPct: number | null` — signed percent of the fitted rate against the pooled
     one. Null when either rate is null. **Computed on the server so the disagreement
     threshold lives in one place**; the client formats it and does not own a threshold.

6. **`server/api.ts`, `shapeUsageRates`** — one joint `fitRates` call over the *same*
   `currentRange(nowMs)` window `fitSplits` already uses, so a row's three numbers never
   describe different spans. Then:
   - Extend the row set: today `models` is built from owned intervals only. Add every model
     with a non-null fit. A model with neither owns nothing and is not identified, and still
     gets no row — that rule is unchanged.
   - A fitted-only model's `driftRow` legitimately returns all-null rates, `verdict: 'thin'`
     and zeroed counters. That is honest and needs no special case; verify it rather than
     working around it.
   - Sort is unchanged (`utilSum` desc, then model name), so fitted-only rows land last.
   - `emptyRates` returns `models: []` and needs no change, but confirm it still typechecks
     against the widened `ModelRateRow`.

### Server — `scripts/probe-usage-split.ts`

7. Replace the ungated `ols()` "one-term joint OLS (bug-13's estimator)" section with a call
   to `explainRates`, printing per model: the fitted `weightedPerPct`, the pooled rate beside
   it, the signed gap, `independentShare`, the evidence triple, and the refusal when there is
   one. The probe must report **what the server will publish**, gates and all — an ungated
   number in the probe is how a refused model gets cited as a measurement, which is the
   mistake this task's own Goal table had to caveat. Keep the local `ols()` helper only if
   something else still uses it; otherwise delete it.

### Client — `client/src/lib/usageRatesFormat.ts`, then the card

8. **`fittedAsideText(fittedWeightedPerPct, fitDeviationPct): string | null`** — a pure helper
   beside `rawAsideText`, so the statement the card makes is testable the way every other
   statement on this card is. Returns null when there is no fitted rate, so the card renders
   no line rather than a dash — the rule `rawAsideText` already established.

9. **`client/src/components/usage/UsageRates.tsx`** — render the fitted line under the raw
   aside, only when the helper returns a string. For a fitted-only model the headline is `—`
   and this line carries the only number on the row; that is honest and intended. Update the
   component JSDoc to say why the fitted rate does not lead and does not feed the badge.

10. **Copy.** Two strings are now false and must change:
    - The empty state — "A model appears here once it has held at least 90% of the tokens in
      ten recorded windows" — is no longer the only route onto the card.
    - The `up-sub` paragraph must cover the new line: the fitted rate is measured over windows
      where several models ran together, it is **not** more comparable across models than the
      pooled one (`bug-13`'s limit applies to both), and drift is still judged on the headline.

11. **`client/src/styles.css`** — reuse `.rates-raw` if it fits; if a distinct class is
    needed, add it beside the existing rate classes, **theme tokens only, zero literal colours
    or shadows** below the token block.

### Docs

12. **`docs/subsystems/usage-limits.md`** — a new `###` section after §"The two-term fit:
    tokens and requests, separated" (~line 714) and before §"The endpoint and the card": what
    the one-term joint fit is, which intervals it reads and why `reqUsable` is *not* among its
    conditions, which gates apply and which deliberately do not (`SPLIT_MAX_R2`), why the
    floors are `CURRENT_FLOORS`, and why the fitted rate is disclosed but excluded from drift.
    Record the measured pooled-vs-fitted gaps from the Goal table with their date. Fix the
    §"Interval classification" narrative wherever it says mixed intervals are discarded from
    every fit — since task-10 that was already only true of the *pooled* fit, and after this
    task it is true of neither.
13. **`docs/overview.md`** — the `lib/usage-rate.ts` line in §Map gains the one-term fit; the
    `GET /api/usage/rates` row gains the fitted-rate fields. One line each, matching the
    file's existing terseness.
14. The `docs-sync:` stamp at the foot of `usage-limits.md` already lists `usage-rate.ts`,
    `usageRatesFormat.ts`, `api.ts`, `probe-usage-split.ts` and `client/src/components/usage/`
    as sources. Nothing to add; re-baseline `verified:` per the repo's normal docs-sync flow.

### Order of work

`shared/types.ts` → `usage-rate.ts` + its tests → `api.ts` + its tests → probe → client +
its tests → docs. The repo's "adding an API field" rule, and it keeps each test file green at
the point it is written.

## Test cases

House style: node-assert, `test/run-all.ts`, tmpdir JSONL fixtures where a file is needed.
Cases 1-8 belong in a new `test/usage-rate-fit.test.ts` (the existing
`usage-rate-classify` / `usage-rate-drift` files stay on their own subjects); 9-12 extend
`test/api-usage-rates.test.ts`; 13 extends `test/usage-rates-format.test.ts`.

Build the fitter fixtures by generating `dUtil` from a known coefficient per model, so every
expected value is exact rather than eyeballed. Assert to a relative tolerance of 1e-6.

1. **Exact recovery, two separable models.** A appears alone in 10 intervals, B alone in 10,
   both together in 10 mixed ones, with `dUtil = 2.0·A_Mtok + 5.0·B_Mtok` throughout. Expect
   `fittedWeightedPerPct` of **500_000** for A and **200_000** for B, `refusal: null` for both.

2. **A mixed-only model gets a rate — the case this task exists for.** A is dominant in 12
   intervals; B is present in 12 mixed intervals and never exceeds a 50% weighted share, so it
   owns none. Expect `rateFor(..., 'B', ...)` to be **null** under any floors, and
   `fitRates` to return B at its generated coefficient. Assert both in the same test: the
   contrast *is* the assertion.

3. **Collinear pair refused, and prove the gate is load-bearing.** Two models whose weighted
   tokens sit in a fixed 1:2 ratio in every interval. Expect both refused `'unidentified'`
   with `fit: null`. **Mutation-prove it**: with the `SPLIT_MIN_INDEPENDENT_SHARE` comparison
   deleted the test must fail. Record that failure output in the PR — a guard test that stays
   green with the guard removed proves nothing.

4. **Negative coefficient refused, not clamped.** Data where least squares returns a negative
   coefficient for B. Expect `refusal: 'negative'`, `fit: null`, and `raw` still carrying the
   signed negative value. Assert `fit` is null rather than 0 — publishing a clamped zero would
   state "this model's tokens are free" as a measurement nobody made.

5. **Floors bite at the documented boundary.** A model present in **9** intervals → refused
   `'thin-evidence'` even when perfectly identified. The same model at **10** intervals / 5.0
   cumulative points / 2 distinct UTC dates → fitted. Also assert the mirror: 10 intervals but
   only **1** distinct date → `'thin-evidence'`, since a day floor that only ever passes is a
   decoration.

6. **Which kinds are in.** Starting from case 1's data: (a) adding an `external` interval
   carrying large weighted tokens must leave both coefficients unchanged to 1e-6; (b) adding
   a `gap`, a `partial` and a `pre-ledger` interval must likewise change nothing; (c) adding an
   `idle` interval that carries real A tokens with `dUtil` 0 **must** strictly *raise* A's
   `fittedWeightedPerPct` — idle rows are measurements and are deliberately in the fit, and
   this is the case that proves they are.

7. **`reqUsable: false` does not exclude an interval.** Case 1's fixture with every interval's
   `reqUsable` set to false. Expect **identical** coefficients to case 1. This is the
   copy-`usableForSplit`-wholesale regression; name it in the test title.

8. **Window bounds, half-open on `toT`.** An interval at exactly `sinceMs` is in; one at
   exactly `untilMs` is out. Assert via a model whose only interval sits on each boundary in
   turn — present at `sinceMs`, absent (refused `'thin-evidence'`) at `untilMs`.

9. **A fitted-only model gets a row** (`shapeUsageRates`). Fixture where B owns nothing but is
   identified. Expect exactly one row for B, with `weightedPerPct: null`, `verdict: 'thin'`,
   `intervals: 0`, `utilSum: 0`, `fittedWeightedPerPct` set, `fitVerdict: 'fitted'`,
   `fitDeviationPct: null` (no pooled rate to compare against).

10. **A model with neither an owned interval nor an identified fit still gets no row.** The
    unchanged rule, asserted so a later widening cannot pass unnoticed.

11. **`fitDeviationPct` sign and value.** A model whose pooled rate is 200_000 and whose
    fitted rate is 300_000 → exactly **+50**. Fitted below pooled → negative. Pooled null →
    null; pooled 0 → null, never `Infinity`.

12. **Row order is unchanged**: `utilSum` desc then model name, so a fitted-only row (utilSum
    0) sorts last. Assert against a fixture with one rich owned model and one fitted-only model.

13. **`fittedAsideText`** — exact strings, pinned:
    - `(null, null)` → **null** (no line rendered), never `'—'`.
    - fitted set, `fitDeviationPct` null → a line naming the rate and its origin (mixed-model
      windows) with no comparison clause.
    - fitted set, deviation small → the same line plus the signed comparison clause.
    - fitted set, deviation large → same shape; the helper does **not** own a threshold, and
      asserting that it renders large and small deviations identically is what pins that.
    - Magnitudes come from `formatTok`, so assert one value in each of its documented bands.
    - Every pre-existing case in `test/usage-rates-format.test.ts` must be untouched. A diff
      that edits one means the change leaked.

14. **Live-data check, not a unit test.** Run `tsx scripts/probe-usage-split.ts --days 17`
    against this machine's real logs and paste the fitted-vs-pooled table into the PR. Green
    unit tests are not evidence here: the first version of this join classified **759 of 759**
    real intervals as `gap` with the whole suite passing. Specifically confirm that
    `claude-opus-4-8` — 0 owned intervals in the Goal table — either gets a fitted rate or a
    *named* refusal, and report which.

15. **In the browser (playwright MCP tools):** open http://localhost:5174, click **Usage** in
    the left rail, then the **Token value** sub-tab, and read the TOKEN VALUE PER MODEL card.
    Each row that has a fitted rate must show a line beneath the raw aside naming the fitted
    weighted rate and, where both estimators have a number, the signed gap against the
    headline. At least one model must show a gap well beyond ±20% (the live data has several
    at +58% to +141%) while its badge still reads `collecting`/`stable` from the *pooled*
    rate — the badge must not have moved because of the fitted number. The subtitle must state
    that the fitted rate is measured across mixed windows and is still not a cross-model price.
    Confirm no console errors.

## Done when

- `fitRates` / `explainRates` exist in `server/lib/usage-rate.ts`, reuse the existing
  `leastSquares` / `independentShares` / `project` primitives, and gate on
  `SPLIT_RANK_TOL`, `SPLIT_MIN_INDEPENDENT_SHARE`, `CURRENT_FLOORS` and a non-negativity
  refusal — with `SPLIT_MAX_R2` deliberately not applied and the reason written down.
- `usableForRate` admits `{model}`, `mixed` and `idle`, excludes `external` and everything
  `isUnpriced` names, and **does not** test `reqUsable`.
- `ModelRateRow` carries `fittedWeightedPerPct`, `fitVerdict` and `fitDeviationPct`;
  `shapeUsageRates` fills all three over `currentRange(nowMs)` and gives a row to a model
  identified only in the fit.
- The pooled rate is still the headline and still the only input to `verdict` and
  `deviationPct`. A diff touching `driftRow`'s verdict logic means the scope slipped.
- The card renders the fitted line, omits it entirely when there is no fitted rate, and its
  copy no longer claims 90% dominance is the only way onto the card.
- `scripts/probe-usage-split.ts` reports the gated fit, not an ungated OLS.
- `docs/subsystems/usage-limits.md` has the new section with the measured gaps and their date;
  `docs/overview.md` §Map is updated; no line anywhere still says mixed intervals are
  discarded from every fit.
- `pnpm test`, `pnpm typecheck` and `pnpm build` all pass, with the output pasted in the PR —
  never a green claim without the command output.
- Case 3's mutation check is recorded in the PR: the failure with the independence gate
  removed, and the pass with it restored.
- The live probe table (case 14) and the browser read (case 15) are both in the PR, and
  anything not verified is stated as such — this repo's PR rule, not a formality.

## Outcome

**2026-09-05 — done.** The one-term joint fit ships beside the pooled dominance rate. Every
model now gets a weighted rate fitted over the `mixed` and `idle` windows `DOMINANCE`
discards, published on its own line under the raw aside, with the signed gap against the
headline — and excluded from every drift verdict, as the plan's conservative branch decided.

What landed, by boundary:

- **`shared/types.ts`** — `ModelFitVerdict`, plus `fittedWeightedPerPct`, `fitVerdict` and
  `fitDeviationPct` on `ModelRateRow`, all required.
- **`server/lib/usage-rate.ts`** — `usableForRate` (no `reqUsable` test), `explainRates`,
  `fitRates`, `fitDeviation`, `RateFit` / `RateRefusal` / `RateDiagnostic`. Reuses
  `project` / `independentShares` / `leastSquares`; gates on `SPLIT_RANK_TOL`,
  `SPLIT_MIN_INDEPENDENT_SHARE`, `CURRENT_FLOORS` and a non-positivity refusal.
  `SPLIT_MAX_R2` deliberately not applied, with the reason in the JSDoc.
- **`server/api.ts`** — `shapeUsageRates` widens its row set with every fitted model and
  fills the three fields over the same `currentRange(nowMs)` window `fitSplits` uses.
  `driftRow`'s verdict logic is untouched.
- **`scripts/probe-usage-split.ts`** — the ungated `ols()` section is replaced by gated
  `explainRates` output; the local `ols()` helper is deleted (no other caller).
- **Client** — `fittedAsideText` in `usageRatesFormat.ts`, a third line in `UsageRates.tsx`,
  and both false copy strings rewritten. `styles.css` is **unchanged**: `.rates-raw` fit
  exactly (same mono/size/token colour/4px offset), so no new class was needed — the plan
  allowed reuse and the screenshot confirmed the two asides read as distinct lines.
- **Docs** — new `### The one-term joint fit` section in `usage-limits.md` with the measured
  gaps and their date; the `mixed` classification row and the "still discarded" narrative
  corrected; the endpoint section rewritten. `docs/overview.md` §Map updated.

### Deviation from the plan, stated

Step 13 said the `GET /api/usage/rates` row in `docs/overview.md` "gains the fitted-rate
fields". **That row did not exist** — a pre-existing omission in the endpoint table. I added
the row rather than skipping the step.

### Verification

`pnpm test` — **1010 cases, ALL PASS** (8 new in `test/usage-rate-fit.test.ts`, 4 new in
`test/api-usage-rates.test.ts`, 3 new in `test/usage-rates-format.test.ts`; every
pre-existing case in the latter two untouched):

```
  18/18 passed
ALL PASS
```

`pnpm typecheck` — clean:

```
> claude-agents-dashboard@0.1.0 typecheck
> tsc --noEmit
exit=0
```

`pnpm build` — clean:

```
dist/assets/index-DrIGxh27.js   394.25 kB │ gzip: 113.16 kB
✓ built in 1.29s
```

**New fitter cases (case 1-8):**

```
=== usage-rate.ts (one-term joint fit) ===

  ✓ two separable models are recovered exactly, mixed windows included
  ✓ a model that never dominates a window gets a rate — the case this fit exists for
  ✓ a collinear pair is refused, and the independence gate is what refuses it
  ✓ a negative coefficient is refused, not clamped to zero
  ✓ the floors bite at the documented boundary, days included
  ✓ external and unpriced intervals are out; idle intervals are in and move the answer
  ✓ reqUsable: false does not exclude an interval — the copy-usableForSplit regression
  ✓ the window is half-open on toT: sinceMs is in, untilMs is out

  8 passed, 0 failed
```

### Case 3's mutation check — the independence gate is load-bearing

With the `diagnostic.independentShare < SPLIT_MIN_INDEPENDENT_SHARE` comparison deleted from
`explainRates`, the collinear pair test **fails**: model A keeps the coefficient the solve
handed it and publishes a rate invented by collinearity.

```
  ✗ a collinear pair is refused, and the independence gate is what refuses it
    A: {"model":"A","intervals":30,"utilSum":648,"days":3,
        "independentShare":3.894236168669954e-17,"refusal":null,
        "fit":{"weightedPerPct":83333.3333333333,"pctPerMWeighted":12.000000000000005,
               "intervals":30,"utilSum":648},"raw":12.000000000000005}
    + actual - expected
    + null
    - 'unidentified'

  7 passed, 1 failed
```

Gate restored → 8 passed, 0 failed (above).

### Case 14 — the live probe, `tsx scripts/probe-usage-split.ts --days 17`, 2026-09-05

The probe now reports the **gated** fit. At the server's own 3-day fit window:

```
  one-term joint fit vs the pooled rate (floors 10/5/2, independent share ≥ 0.1):
    claude-fable-5-1: fitted 0.0817M weighted/pt  (pooled 0.0451M, gap 81.0%)
      12.2338 pt/Mtok  (share=0.9925, 86 intervals, 124.0 pts, 4 days)
    claude-haiku-4-5-20251001: no fitted rate — thin-evidence  (share=0.9996, 6 intervals,
      2.0 pts, 3 days, least squares wanted -1.8521 pt/Mtok)
    claude-opus-5: fitted 0.3160M weighted/pt  (pooled 0.2100M, gap 50.4%)
      3.1648 pt/Mtok  (share=0.9925, 550 intervals, 608.0 pts, 4 days)
    claude-sonnet-5: no fitted rate — thin-evidence  (share=0.9999, 7 intervals, 7.0 pts,
      2 days, least squares wanted 3.1947 pt/Mtok)
```

The Goal table's +58%/+141% figures reproduce in direction and rough magnitude, and the
bottom rows are refused exactly as step 1 predicted they would be.

**`claude-opus-4-8`: it gets a named refusal — `thin-evidence`.** Two facts, both worth
recording because the Goal table implies otherwise:

1. It is **not in the fit's window at all**. It appears on exactly **one** ledger line in the
   entire log, stamped 2026-09-01, four days outside `currentRange`. The Goal table's
   "0.2420M fitted" came from an ungated OLS over the whole 17-day span with no floors —
   precisely the citation step 7 exists to prevent.
2. Run `explainRates` over that same 17-day span and it is refused by name:
   `claude-opus-4-8: thin-evidence (1 intervals, 1.0 pts, 1 days, share=0.9998, raw=4.1009)`.
   `raw=4.1009 pt/Mtok` → 244k weighted/pt, which **reproduces the Goal table's 0.2420M** —
   so the ungated arithmetic was right and the gates correctly refuse to publish it.

At that 17-day horizon the other five all clear the gates: `claude-opus-5` 0.354M,
`claude-sonnet-5` 0.394M, `claude-haiku-4-5-20251001` 0.303M, `claude-fable-5` 0.122M,
`claude-fable-5-1` 0.116M — matching the Goal table's OLS closely.

### Case 15 — the browser, real data

Dev server on 5273/5273-API-4273 (the user's own 5174/4173 servers were left running and
verified up afterwards). Usage → Token value, live logs copied into the worktree root:

- `claude-opus-5` — headline `210k weighted / 1%`, badge `COLLECTING`, and beneath the raw
  aside: `fitted 315k weighted / 1% across mixed-model windows · +50.5% vs the rate above`.
- `claude-fable-5-1` — headline `45k`, badge `COLLECTING`,
  `fitted 82k weighted / 1% across mixed-model windows · +81.1% vs the rate above`.
- `claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5-20251001` — no fitted rate, and
  **no fitted line rendered at all** (not a dash). The omission rule holds on screen.
- Both gaps are far beyond ±20% while both badges still read `collecting` **from the pooled
  rate** — the badge did not move because of the fitted number, which was the point of
  case 15.
- The subtitle states the fitted rate is measured across mixed-model windows, that it is
  "no more comparable across models than the headline", and that drift is judged on the
  headline alone.
- **Console: 3 messages, 0 errors, 0 warnings.**

### Not verified — needs a human

- **No fitted-only row was seen on screen.** The case the feature exists for (`claude-opus-4-8`)
  is proven at the API and unit-test layers (`test/api-usage-rates.test.ts`: a model owning
  nothing gets a row carrying only its fitted rate), but on this machine's *current* 3-day
  window no such model exists, so the `—` headline above a lone fitted line was never
  rendered in a browser. Worth a look the next time a subagent-only model is in window.
- **The `docs-sync:` `verified:` stamp in `usage-limits.md` was not re-baselined.** Every
  source this task touched is already listed, but re-baselining needs the commit sha, and
  this skill does not commit. Run the normal docs-sync flow after the commit lands.
- **No cross-browser or phone check.** Read in one desktop Chromium viewport only.

### Review fixes (loop 1)

**2026-09-05.** Review verdict `fix`, one Important finding. Report:
`~/.backlog-manager/orchestrator/…/reviews/task-20-1.md`.

#### The Important finding — misattributed live measurement (`usage-limits.md:858`)

The reviewer is right, and the error was mine. The doc closed its 17-day list with
"`claude-haiku-4-5-20251001` 0.303M — a model with **zero** owned intervals in the whole
window". Haiku owns intervals; `claude-opus-4-8` is the zero-owned model.

**Verified against the real logs rather than the Goal table**, per the requirement. Ran
`explainRates` and `rateFor` over the 17-day window from this machine's own
`.usage-history.jsonl` / `.usage-ledger.jsonl`, 2026-09-05T19:15Z:

```
-- every model appearing in the 17d window, with its OWNED interval count --
  claude-fable-5: owned=16   pooled(17d, no floor)=0.0764M over 16 intervals
  claude-fable-5-1: owned=28  pooled(17d, no floor)=0.0568M over 28 intervals
  claude-haiku-4-5-20251001: owned=2   pooled(17d, no floor)=0.0244M over 2 intervals
  claude-opus-4-8: owned=0    pooled=NONE
  claude-opus-5: owned=855    pooled(17d, no floor)=0.2272M over 855 intervals
  claude-sonnet-5: owned=5    pooled(17d, no floor)=0.2102M over 5 intervals

-- explainRates over the SAME 17d window --
  claude-fable-5: FITTED 0.1219M  (86 int, 100.0 pts, 2 days, raw=8.2059)
  claude-fable-5-1: FITTED 0.1163M  (101 int, 153.0 pts, 4 days, raw=8.5967)
  claude-haiku-4-5-20251001: FITTED 0.3002M  (14 int, 8.0 pts, 6 days, raw=3.3312)
  claude-opus-4-8: thin-evidence  (1 int, 1.0 pts, 1 days, raw=4.1204)
  claude-opus-5: FITTED 0.3558M  (1012 int, 1096.0 pts, 6 days, raw=2.8103)
  claude-sonnet-5: FITTED 0.3933M  (26 int, 26.0 pts, 4 days, raw=2.5424)
```

So: haiku owns **2** intervals and its measured pooled rate is **0.0244M** — reproducing the
Goal table's figure exactly, which is what the reviewer inferred and it holds. All five
fitted models own intervals (855 / 5 / 16 / 28 / 2), so all five already had a pooled rate;
the fit changes their *number*, not whether they have one. `claude-opus-4-8` owns **0**, has
no pooled rate at any floor, and is refused `thin-evidence` on one interval / 1.0 point /
1 day.

The doc passage is rewritten: the five fitted rates now carry their owned-interval counts and
no zero-owned claim, and a new paragraph states opus-4-8's actual disposition — zero owned,
one ledger line, refused `thin-evidence`, `raw = 4.1204 pt/Mtok` ≈ 0.243M weighted/pt, so the
arithmetic works and the floors correctly decline to publish one interval as a measurement —
framed as the fit behaving as designed, with an explicit "do not cite any of the five as the
zero-owned case". The 17-day rates are restated from this 19:15Z re-measurement; the 3-day
figures are unchanged, as they still match the probe output pasted above.

Note the reviewer's suggested fix — "attribute the clause to `claude-opus-4-8`" — could not be
taken literally: the clause sat inside a list of *fitted* rates, and opus-4-8 is refused, so
moving the name there would have swapped one false claim for another. It got its own
paragraph instead.

#### Minor items taken (3 of 6)

- **`shared/types.ts`** — `ModelFitVerdict`'s JSDoc said "four refusals" and listed three.
  `RateRefusal` has three; four is the *split's* count. Corrected, and it now says why the
  counts differ (the split's `collinear` has no counterpart when a model has one regressor).
- **`scripts/probe-usage-split.ts`** — the same misattribution class as the Important finding,
  in the probe. The `pooled` map is keyed by `models`, which derives from the two-term
  `usable` set and so still requires `reqUsable`; a model owning windows but present only on
  pre-upgrade ledger lines printed "no pooled rate — this model owns no window", which is
  false. Now recomputed with `pool()` directly, the window is named in the message, and a
  printed pooled rate carries the owned-interval count behind it. Confirmed on live data:
  `claude-opus-5: fitted 0.3152M weighted/pt (pooled 0.2079M over 472 owned, gap 51.6%)`.
- **`server/lib/usage-rate.ts`** module header — "discards every interval it cannot attribute"
  was already loose after task-10 and is now looser with three estimators reading three
  different sets. Rewritten to say the discarded set is a property of the estimator, not of
  the file.

#### Minor items declined (3 of 6)

- **Tiny-positive coefficient → enormous finite rate.** The reviewer marks it in-spec; the
  plan settled the guard at zero/non-finite. Changing it is a threshold decision with no
  measured basis, which is the same trap the whole task's "excluded from drift" argument
  turns on. Left alone.
- **`fitDeviationPct` compares against a pooled numerator that includes up to 10% other
  models' tokens.** Pre-existing asymmetry in `pool()`, and the plan asked for exactly this
  comparison. A real observation, but fixing it changes the pooled rate itself — out of scope.
- **`docs-sync: verified:` stamp / `shared/types.ts` absent from `sources:`.** Already
  disclosed under *Not verified*; the stamp needs the commit sha and the plan said "nothing
  to add" for the sources list.

#### Verification after the fixes

`pnpm test` — **1010 cases, ALL PASS**:

```
  18/18 passed
ALL PASS
```

```
=== usage-rate.ts (one-term joint fit) ===

  ✓ two separable models are recovered exactly, mixed windows included
  ✓ a model that never dominates a window gets a rate — the case this fit exists for
  ✓ a collinear pair is refused, and the independence gate is what refuses it
  ✓ a negative coefficient is refused, not clamped to zero
  ✓ the floors bite at the documented boundary, days included
  ✓ external and unpriced intervals are out; idle intervals are in and move the answer
  ✓ reqUsable: false does not exclude an interval — the copy-usableForSplit regression
  ✓ the window is half-open on toT: sinceMs is in, untilMs is out

  8 passed, 0 failed
```

`pnpm typecheck`:

```
> claude-agents-dashboard@0.1.0 typecheck
> tsc --noEmit
typecheck exit=0
```

`pnpm build`:

```
dist/assets/index-DrIGxh27.js   394.25 kB │ gzip: 113.16 kB
✓ built in 1.13s
```

**Not re-verified in this loop:** the browser read. No client behaviour changed — the loop
touched one doc passage, two JSDoc blocks and a probe-only print path — so the case-15
evidence above still stands, but nothing was re-opened in a browser to confirm it.
