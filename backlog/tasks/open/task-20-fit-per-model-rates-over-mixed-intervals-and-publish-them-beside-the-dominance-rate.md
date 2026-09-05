---
id: task-20
title: Fit per-model rates over mixed intervals and publish them beside the dominance rate
created: 2026-09-05
from: idea-13
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
