# Final review — usage-rate model separation (whole branch)

Branch `docs/usage-rate-model-separation`, range `5a7836f..1d55fd0` (17 commits). Spec `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`
(binding, incl. the 2026-11-09 V3 amendment), plan `docs/superpowers/plans/2026-11-09-usage-rate-model-separation.md`. Reviewed 2026-11-09.

**Spec compliance: COMPLIANT WITH GAPS.** The estimator, the four guards, their precedence, the shared `SeparationContext`, the measured-band bootstrap and
memo, the separated surface strata, row-vs-cell publishing and the three named copy strings all match the spec. The gaps are copy and disclosure that still
describe the old owned basis (I2–I4), a stale doc figure (I5), and one unguarded edge the spec is silent on (I1).

**Task quality: APPROVED WITH FIXES** — no Critical, five Important, all small.

## Verification run by the reviewer

- `pnpm typecheck` — clean.
- The rate suites, each through its exported `run()` (scratch runner, foreground): `usage-rate-classify`, `usage-rate-drift`, `usage-rate-fit`,
  `usage-rate-weekly`, `api-usage-rates`, `usage-rate-daily`, `usage-rates-format`, `rates-audit` — `total failed 0`.
- Scratch script over `bootstrapBands` with noisy synthetic intervals (two models, ±40% multiplicative noise per interval):
  2-day horizon → bands `A {under 1.8e-15, over 0}`, `B {under 0, over 8.9e-16}`; 3-day → A 7.1% / 8.0%, B 5.1% / 4.8%; 5-day → A 6.2% / 5.8%, B 4.6% / 5.7%.
- Scratch script, 2-day horizon, B holding ~88% of the points beside A: `driftRow` publishes `weightedPerPct` 483k for A with `thinReason: 'floor'` (baseline
  only) — the sensitivity guard did not fire.
- Not run: the live-ledger back-test (the docs' 595k / cv 22.1% / per-model bands are taken as recorded, not re-measured), `pnpm test:visual`, the card in a
  browser.

## Findings

### Critical

None.

### Important

**I1 — a horizon with fewer than 3 distinct days switches the sensitivity guard off.** `server/lib/usage-rate.ts:716–727` (`bootstrapBands`).
With two UTC days a resample is fittable only when it draws both days (`fitRates` `minDays` 2 counts distinct dates), and then it *is* the original sample, so
every draw is exactly 1.0 whatever the noise. At the shipped seed the two-day draw count is 109/200 (≥ half), so **every** horizon model gets a band of
exactly 0 on every two-day ledger — not "decided per model by the seed" but the same outcome for all of them. With `ΔU = ΔO = 0` only `R ≤ 0` can trip `mixed`;
reproduced above, a current row at a priced-out share ≈ 0.88 publishes a headline figure. That is the exact failure the goals rule out ("never a rated or carried
figure that is really Fable's spend"), it reaches the Weighted column (the current side is published even while the verdict is `thin` for want of a baseline),
and it recurs after any 15-day gap in use, not only on a fresh install. Blast radius is small (a day or so, no verdict, day cells uncoloured), the fix is three
lines, so fix it here rather than park it.
*Fix:* in `bootstrapBands`, return an empty map when `days.length < 3`, so `separationContext` falls back to `SUB_ERR` on both sides (the pre-amendment flat
cap) — the spec's own fallback for "no measured band". Pin it with a fit test (noisy 2-day fixture → no band; 3-day → non-zero band) and rework
`test/api-usage-rates.test.ts:336–345` / `:380–385`, whose `rated`-by-floor outcome rests on this coin flip (Task 6b M2); with the fallback the subagent reads
`mixed` and the test should say so.

**I2 — the hoisted "Collecting" note still says only the day floors keep a row thin.** `client/src/components/usage/UsageRates.tsx:350–353` calls
`verdictText('thin')` with no reason and prints "**Collecting is the normal first fortnight** — a verdict needs 7 separate days behind the baseline and 2 behind
the current window" whenever any row is thin. After this change Fable, Haiku and Sonnet are `thin` / `mixed` or `repriced` indefinitely (docs: "Fable, Haiku
and Sonnet had no rated day"; ui-verify: Collecting 4, three of them separation reasons), so on day 40 the card's one explanation for those rows is false. The
spec's own reasoning for `thinReason` ("Under the new guards that is false for a thin span the separation could not price") applies to this caller too.
*Fix:* print the floor sentence only when some thin row has `thinReason` `floor`/absent, and add one line when any thin row has a separation reason (e.g.
"…or another model's spend can't be priced out of theirs"), reusing `THIN_HINT`.

**I3 — the `mixed` hint names the current window when the reason can be the baseline's.** `client/src/lib/usageRatesFormat.ts:126`
(`THIN_HINT.mixed`: "most of the **current window's** points were another model's") vs `server/lib/usage-rate.ts:1049–1050`, which publishes the baseline
side's `thinReason` when the current side is rated. A model that was the minor partner over the baseline fortnight and drives this week (e.g. Sonnet used
heavily since Friday) shows `mixed` with a sentence about the wrong span. `repriced` cannot come from the baseline (no `checkRepriced` there); `unpriced`'s
copy is span-neutral.
*Fix:* make the `mixed` hint span-neutral ("most of this model's points were priced out as another model's — its rate can't be separated from them"), or
publish which side failed. Add the baseline-mixed case to the `ledgerReading` test.

**I4 — the coverage disclosure, the Priced-share row and the Ledger tile still describe the owned basis.** The spec puts copy and contract docs that
describe the old basis in scope "whether or not a field is added"; these were missed:
- `shared/types.ts:740` `pricedPct` "Points in intervals one model owned — **the ones a rate is fitted on**"; `:742` `mixedPct` "No model held 90% of the
  tokens, so **no rate could be attributed**"; `server/lib/usage-rate.ts:1157` "the only ones that reach a rate"; `docs/subsystems/usage-limits.md:1483`
  "`pricedPct` for what reached a rate". Every 5-hour figure now reads `mixed` (and `idle`) intervals.
- `client/src/lib/usageRatesFormat.ts:324–329` lists `mixed` among the refusals ("no single model held 90% of the tokens", ranked as a cost), and the Coverage
  tile / `Priced share` total row (`UsageRates.tsx:331–335`, "N points of M explained") count owned points only — on 2026-11-09 the card would say 44 of 61
  points were not measured while the headline was built from them.
- The Ledger tile and the total row's Windows cell (`usageRatesFormat.ts:576`, `UsageRates.tsx:260`) sum `row.intervals`, which is now "intervals this model
  spent in": a shared interval counts once per model, so the "recorded windows" total is inflated by exactly the mixed intervals this change brought in.
*Fix (smallest honest one):* keep the buckets as an *ownership* breakdown but say so (JSDoc, docs §coverage, the `mixed` row relabelled as shared rather than
refused and taken out of the refusal ranking), and either label the summed windows as model-windows or count distinct intervals. Whether the Coverage
headline should become `(priced + mixed) / moved` is the maintainer's call; park it if not done here.

**I5 — a stale dispersion figure in the reference doc.** `docs/subsystems/usage-limits.md:1709`: "the separated rate measured 21.7% on its 7 rated Opus 5.5
days on 2026-11-09" — that is the pre-amendment 13:42 UTC measurement; the doc's own §dispersion (`:1050–1053`) records the shipped code at cv 22.1% over 14
rated days → 17.7%, under the band. A reader of §Drift misfires concludes the inequality is broken.
*Fix:* "the separated rate measured 17.7% (cv 22.1%, 14 rated Opus 5.5 days, 2026-11-09 ~14:25 UTC)".

### Minor

- **m1** `server/lib/usage-shape.ts:175–176, 199, 243, 256` — comments still say "pooled" ("Its row's pooled numbers…", "Against the pooled rate the row
  already publishes", "The days the two figures above were pooled from").
- **m2** `client/src/lib/usageRatesFormat.ts:156` — `surface-shift` hint "the pooled rate moved more than 20%"; `shared/types.ts:302` was updated to
  "separated" for the same verdict. Defensible (the separated rate is still Σ/Σ) but now inconsistent.
- **m3** `shared/types.ts:486–489` — `ModelRateRow.intervals` / `utilSum` JSDoc ("behind the current-window fit", "Cumulative utilization points") does not say
  the points are the residual and the intervals are those M spent in, as `ModelDayRate` now does.
- **m4** `server/lib/usage-rate.ts:638–639` says a bootstrap is "~1.4 s"; `usage-limits.md` records 773–849 ms measured cold. Keep one (the measurement).
- **m5** `docs/subsystems/usage-limits.md:1126–1131` — "`CURRENT_FLOORS` counts only intervals it *owns*" is no longer true of the 5-hour row.
- **m6** Deferred Task 4 minor (no test pins `shapeUsageRates` passing `ctx` to `dailyRates`): the mutation is semantically equivalent — the default
  `separationContext(intervals, nowMs)` rebuilds the same horizon and 3-day fits and hits the band memo — so only cost is at stake. Accept; no test needed.
- **m7** Task 6b minors: M1 (`R ≤ 0` reads `mixed`, not `repriced`) is documented (`usage-limits.md` §repriced) and consistent with the ruling — closed. M2 is
  folded into I1. M3 concerns an uncommitted scratch script — n/a. M4 and M5 accepted as written.
- **m8** Request cost: `separatedRate` re-filters the whole interval array on every call — ~11 calls per `driftRow` plus 18 per `dailyRates`, per model, over
  ~12.4k intervals. End-to-end latency of `/api/usage/rates` on the live ledger was not measured on the branch; measure once before the PR.
- **m9** The band memo is a single slot: a horizon model set flapping at a fit floor re-runs the ~0.8–1.4 s blocking bootstrap per flip. Unlikely; note it.
- **m10** Ruling `SUB_BOOTSTRAP` = 200 vs the spec's B = 1000 measurement: accepted. The spec's §Verification still asks the PR to show the two side by side
  (B=1000: Opus 602k, +12%, cv 22.3% → 17.9; B=200 per docs: 595k, +11.0%, cv 22.1% → 17.7) — the PR body owes that table.

## Spec checklist (abridged)

| Spec item | Where | Verdict |
|---|---|---|
| `W_M / (U − Σ W_m/rate_m)` over `usableForRate` intervals incl. idle | usage-rate.ts:807–908 | ok |
| Horizon rates from one `fitRates` over `[now−17d, ∞)`, shared per request | usage-rate.ts:747–764, usage-shape.ts:221 | ok |
| `unpriced` with stated trivial threshold (1%) | usage-rate.ts:655, 869–871 | ok |
| `repriced` by effect, current window and its day cells only, no share gate | usage-rate.ts:880–884, 1107–1109 | ok (R ≤ 0 → `mixed`, ruling) |
| `mixed` by measured band, RSS, `0.99` clamp, unmeasured `{0.99, 9}`, `SUB_ERR` fallback | usage-rate.ts:647, 677–685, 865–892 | ok, except I1 |
| Bootstrap: day blocks, seeded, memo per UTC hour + horizon model set | usage-rate.ts:704–764 | ok |
| `floor` on the span's own floors, residual basis, counters redefined | usage-rate.ts:893–895, 1104 | ok |
| Precedence `unpriced > repriced > mixed > floor`; row: current before baseline | usage-rate.ts:896–901, 1045–1052 | ok |
| Row nulls failed side; cell carries figures | usage-rate.ts:1026–1043, 1115–1126 | ok |
| Raw moves with weighted | usage-rate.ts:841, 904–905 | ok |
| Surface strata on separated basis, no owned fallback; `surfaces` same numbers | usage-rate.ts:955–1000 | ok |
| `thinReason` in types first, then server, then client | shared/types.ts:315–327, 448–449, 482–483 | ok |
| Three named strings read the reason | usageRatesFormat.ts:126–137, 164–168, 414, 596 | ok; I2/I3 for adjacent callers |
| Glossary `weighted`/`windows`/day-strip copy | usageRatesFormat.ts:464, 491, 498–499 | ok |
| Contract JSDoc and usage-limits.md §Token value / §day strip | types.ts, usage-limits.md | ok except I4, I5 |
| `DRIFT_PCT` and floors unchanged; cv re-measured and dated | usage-limits.md:1050–1056 | ok |
| No new dep / outbound call / file written | diff | ok |
| Tests 1–8 incl. 5a, 5b, 7b, 7c | test/usage-rate-{fit,drift,daily}.test.ts, api-usage-rates, usage-rates-format | present and passing |

## Declined to judge

- Weekly figures (`ModelWeeklyRate`) still on the pooled ratio — spec non-goal.
- Off-peak boost detector still on `poolRate` — outside the spec's file list; the docs state it.
- A model with a horizon separated figure but no owned interval and no 3-day fit gets no row — spec: "no new row".
- Two-term split untouched — spec non-goal.
- The live-ledger figures in the docs (bands, 595k, 14/15 days, cv 22.1%) — not re-measured: read-only review, no live-ledger run.
- `scripts/rates-audit.ts` calls `driftRow` without a context — works through the default parameter; a script, not the card.
- Visual suite and dark themes — no CSS or class-name change on the branch; not run.
- Glossary "Window" entry calling an interval "one 5-hour limit period" — pre-existing wording, not introduced here.
- 160-column wrap of new lines — the byte-length check flags only lines carrying multi-byte characters; not pursued.
