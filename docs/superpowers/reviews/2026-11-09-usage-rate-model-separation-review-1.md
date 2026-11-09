# Plan review 1 — usage-rate model separation

Plan: `docs/superpowers/plans/2026-11-09-usage-rate-model-separation.md` (296 lines)
Spec: `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`
Reviewer: fresh subagent (Fable 5.1), 2026-11-09. Every code claim below was checked by reading the cited range in the worktree.

## Verdict: APPROVE WITH FIXES

The plan maps every spec section and every spec test to a task, its numeric fixtures recompute exactly (cap 0.34 / 0.46, [2] 500k & 0.25 & 400k,
[3]/[4] 400k→500k & 80k→100k, [5] 10.0% at s=0.34 and 11.0% at s=0.36), all line ranges it cites exist within a few lines of the stated number, the
task order has no forward dependency, and it keeps its own "behaviour, not code" and soft-size conventions. Five Important findings need a sentence each
before building; none of them is a wrong design, all are places an implementer following the text literally either compiles nothing or ships dead copy.

## Coverage map (spec → task)

| Spec section / test | Task |
|---|---|
| §Estimator (formula, interval set, rate_m from horizon fit) | 2 (`separatedRate`, `separationContext`) |
| §Guards: sensitivity cap, repriced, missing rate, residual floor, counters, row-vs-cell, thinReason + precedence | 2 (guards), 3 (row), 4 (cells), 1 (type) |
| §What changes: row/baseline/deviation/strip, rawPerPct, fitted stays, mix adjustment, surfaces, labels/copy, JSDoc, docs, DRIFT_PCT re-measure | 3, 4, 5, 1 step 4, 6 |
| Tests 1, 2, 3, 4, 5, 5b, 6, 7, 7b (reason per guard), 7c, 8 | 2: [1]–[7b], stratum; 3: [7c], row reasons; 4: day reasons, [8] |
| Back-test, goal check, "not verified" line | 6, 7 |

Gap: spec test 7b requires `unpriced` asserted **on both the day cell and the row**; Task 3 asserts `mixed`/`floor`/`repriced` on the row and Task 4
`mixed`/`repriced`/`floor` on the cell — `unpriced` is pinned only at the estimator (Task 2 [6]). See I-3.

## Important

**I-1 — plan:121 — `NO_FLOOR` already exists in the target test file with a different value.** The plan tells Task 2 to use
`NO_FLOOR = { minIntervals: 0, minUtil: 0, minDays: 0 }` in `test/usage-rate-fit.test.ts`, but that file already declares
`const NO_FLOOR: RateFloors = { minIntervals: 1, minUtil: 0, minDays: 0 }` (`test/usage-rate-fit.test.ts:35`). A second `const NO_FLOOR` in the same
module is a TS redeclaration error; reusing the existing one silently changes `minIntervals` to 1. → Say "reuse the file's `NO_FLOOR` (minIntervals 1
— every fixture below has ≥ 1 interval where A spent)" or name the new constant.

**I-2 — plan:127–129, 137, 142, 146 — the "mixed" fixtures are intervals the classifier would call A-owned.** At the 500k/100k price pair, an interval
whose B points are 25% of `dUtil` holds A at 1.5M of 1.6M weighted tokens = 93.75% ≥ `DOMINANCE` (`server/lib/usage-rate.ts:145–152`,
`dominantModel`), so "`poolRate` on the same intervals is null (nothing owned)" is true only because the fixture hand-sets `kind: 'mixed'`. Algebra:
with A < 90% of tokens at a 5:1 price ratio, B's point share is ≥ 5/14 ≈ 0.357 > `SEPARATION_S_CAP`, so a *genuinely* mixed interval is always over the
cap for the pricier model on its own; the rated-at-0.25 spans in [2] and [5] cannot be built from classifier-mixed intervals alone. The arithmetic the
tests pin is still right (`separatedRate` reads `usableForRate`, never ownership), but an implementer who builds the span through `joinIntervals` gets
pooled 381k, not null, and a different `pricedOutShare`. → Add one line to the fixture paragraph (plan:121): "intervals are hand-built with `kind` set
directly, as the file already does; a `mixed` label here is not a claim about `dominantModel`", and in [2] drop the parenthetical "(nothing owned)" or
replace it with "(kind hand-set to `mixed`)".

**I-3 — plan:192–196 and 222–229 — spec 7b's `unpriced` is not asserted on the row or the day cell.** Spec:178–179 says tests 5, 5b, 6 and 7 assert
`mixed`, `repriced`, `unpriced`, `floor` "on both the day cell and the row". Task 3 lists `mixed`, `floor`, `repriced`; Task 4 lists `mixed`,
`repriced`, `floor`. → Add to Task 3 Step 1 "current window with B at 5% of weighted tokens and no `ctx.horizon` rate → `thinReason` `unpriced`, figures
null" and to Task 4 Step 1 the same on a day cell (figure carried).

**I-4 — plan:251–252 — "`ledgerReading` passes `row.thinReason`" names a call that does not exist; without a change there, three of the four new hints
are dead copy.** `client/src/lib/usageRatesFormat.ts:614–635`: `ledgerReading` calls `verdictText(row.verdict).hint` only when `verdict !== 'thin'`
(615–618); its `thin` branch composes its own text from `baselineDays`/`days`/`intervals` (622–635) and never calls `verdictText('thin')`. The only
other `verdictText('thin')` caller is the static explainer at `client/src/components/usage/UsageRates.tsx:352`, which has no row. So a `mixed` row whose
days clear both floors would read "N windows, not yet enough to separate this model from the ones it runs beside" (close, but wrong for `repriced`),
and a `mixed` row under a day floor would read "waiting on 1 of 2 current days" — the misdirection the spec's §Why it is thin exists to remove.
→ State the behaviour: in `ledgerReading`'s `thin` branch, when `row.thinReason` is present and not `floor`, return `verdictText('thin',
row.thinReason).hint` (weekly aside appended as for other verdicts) **before** the counter composition; `floor`/absent keeps today's path. Add the test:
a `thin` row with `thinReason: 'repriced'` and days under both floors reads the repriced hint, not "waiting on".

**I-5 — plan:179–181 — the mix adjustment admits a current stratum whatever its own guards say; spec says a guarded stratum drops out.** Spec:122–123:
"The same guards apply per stratum: a stratum that fails one is `thin` and drops out of the mix adjustment". The plan's `mixAdjustedDeviation` rule
conditions only on the *baseline* stratum being rated ("for each surface with a baseline rate, `covered += stratum utilSum`") and sums the current
stratum unconditionally — so a current headless stratum that is `mixed` (B dominating the headless intervals) or `repriced` still feeds `expected`.
Today's code (`server/lib/usage-rate.ts:630–649`) also applies no current-side floor, so dropping the *floors* is defensible; dropping the four
*guards* is not what the spec says. → State explicitly: a current stratum contributes to `covered`/`expected` only when its `thinReason` is null or
`floor` (the floors are the span's business, the guards are the stratum's); then the [7c] fixture needs both current strata under the cap, which the
"headless ≤ 10% of A's tokens" constraint and the spread rule do not guarantee — say so in the fixture brief.

## Minor (file only)

- plan:33 — "The worktree has no `node_modules`" is false: `node_modules/` is present in the worktree (`ls` shows `@axe-core`, `@fontsource`, …).
  Harmless (`pnpm install` is idempotent); drop the line or make it "run `pnpm install` if `node_modules` is missing".
- plan:96 — `horizon` fit is `[now − BASELINE_MS, +∞)`; spec:51 says `[now − BASELINE_MS, now)`. The open top matches `currentRange`
  (`usage-rate.ts:535–537`) and is the better choice; note the deviation in the comment so the spec and code do not look at odds.
- plan:118 — "`mixed` … (covers `R ≤ 0`)" is true only when `U > 0`; with `U = 0` the share is null and the reason is `floor` (plan:143, Review Focus 3).
  Say "(covers `R ≤ 0` when `U > 0`)".
- plan:134–135 — the "other model's solo interval" case does not size the B-only day. In [3]'s fixture `s` = 0.2 (10 of 50); 11 B-only intervals at
  1 pt each push `s` to 0.344 > cap and the span flips to `mixed`. The asserts (figure, counters) still hold since figures are carried, but say "≤ 10
  intervals, so the span stays rated" or assert the reason too, or the implementer will wonder whether the flip is a bug.
- plan:146–148 — the stratum test gives rates but not point shares; at 500k/100k any classifier-mixed interval has `s` > cap (I-2), so the strata will be
  `mixed`. Fine for a figure-only assert (figures are carried), but say so, or give B's points as ≤ 25% per interval with hand-set kinds.
- plan:165–169 — each of `surfaceRates` / `mixAdjustedDeviation` defaults `ctx` to a fresh `separationContext(...)`, i.e. a 17-day `fitRates` per call.
  Say that `driftRow` passes its own `ctx` to both (and `shapeUsageRates` to `driftRow`/`dailyRates`), or a row costs three joint fits.
- plan:216 — "`checkRepriced` true only for a day whose end is after `currentRange(nowMs).sinceMs`" admits the day straddling the boundary; spec:80
  says "a day inside the current window". The straddling day's clipped-to-horizon rule makes either reading defensible; pick one in the JSDoc.
- plan:241 — `UsageRates.tsx:205` reads `.label` only; `:352` reads `verdictText('thin').hint` with no row, which the optional parameter keeps valid. No
  change needed in that file — the plan could say so outright.
- plan:280–281 — the back-test reads the main checkout's data directory but imports the worktree's `server/lib`; memory "Ad-hoc scripts clobber state
  files" is already honoured by the `chdir` note. Also name the output file path in the PR body, not just "verbatim".
- spec:80–81 defines an *affected* day cell by "priced-out **points** above the trivial share"; plan:92 and :116 use share of weighted **tokens** for
  both guards. The plan's comment (1% tokens ≈ 5% points) justifies it; one clause saying "tokens, not points, on purpose" closes the gap.

## Checklist record

1. Coverage — all spec sections and tests mapped (table above); one gap (I-3).
2. Values — all recomputed: `SEPARATION_S_CAP` = 0.1/(1.1/0.85 − 1) = 0.34, other side 0.46; [2] 30M/60 = 500k, 20/80 = 0.25, (30M+10M)/(105−25) = 500k,
   10M/25 = 400k; [3] 20M/50 = 400k vs 20M/40 = 500k, s 0.2; [4] 4M/50 = 80k vs 4M/40 = 100k; [5] 0.66/0.6 = 1.10, 0.64/0.5765 = 1.110; [5b] 30% > 20,
   15% ≤ 20; [7] 4.9 < 5 floor, 5 rated (`rateFor` semantics, `usage-rate.ts:592–595`). Copy strings match spec §Why it is thin and §What changes.
3. Reality — every cited range exists: `types.ts` 316/398/409/436; `usage-rate.ts` 87/217/232/291/359/499/554/587/630/652/676/743/1352/1485;
   `usage-shape.ts` 179–260; `usageRatesFormat.ts` 47/126/385/435/555/614; `UsageRates.tsx` 205; classify test 51–60; daily test 107–121;
   `scripts/rates-audit.ts:222` compiles unchanged under the optional `ctx`. False facts: plan:33 (Minor), plan:251 (I-4).
4. Interfaces — every Consumes has an earlier Produces with the same spelling; `ModelThinReason` crosses as `import type`.
5. Order — 1 → 2 → 3 → 4 → 5 → 6 → 7, no forward reference; `/ui-verify` is the last task.
6. Tests — each task's tests fail first on a missing export/field/string; Review Focus 1–5 each have a test (1: Task 2 solo-interval; 2–3: [7]/[7b];
   4: Task 3 Step 3; 5: Task 5 null-figure tip). Two-key logic (A/B, interactive/headless) is exercised with two keys throughout; distinct values per
   asserted field hold (500k/100k, 400k/80k, 500k/300k).
7. Conventions — no literal code, soft size respected (296 lines), 160-column prose.
