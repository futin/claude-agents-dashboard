# Review 3 — amendment "V3" to the usage-rate model-separation spec and plan

Date: 2026-11-09. Reviewer: fresh subagent (Fable 5.1), read-only. Scope: the changed text only — the spec's "Amendment, 2026-11-09" paragraph and the
two rewritten guard bullets (spec:67–99), verification tests 5/5a/5b (spec:188–198), the back-test bullets (spec:209–213), the "Left to the builder" line
(spec:221), and plan Task 6b (plan:299–359). Code read: `server/lib/usage-rate.ts` (constants 631–660, `SeparationContext`/`separationContext` 663–685,
`separatedRate` 728–808, `dailyRates` 994–1026, `fitRates` 1743–1752), `server/lib/usage-shape.ts:193,221`, `server/lib/usage-history.ts:717,853`,
`client/src/hooks/useUsageRates.ts:29`, the three `test/usage-rate-*.test.ts` files and `docs/subsystems/usage-limits.md` at the cited lines.

Spec paths below are `docs/superpowers/specs/2026-11-09-usage-rate-model-separation-design.md`; plan paths are
`docs/superpowers/plans/2026-11-09-usage-rate-model-separation.md`.

## Verdict

**APPROVE WITH FIXES.** The replacement guards are internally consistent, every worked number in the plan recomputes, and the plan's file/test references
resolve. Three Important items: a unit slip in the spec's guard inequalities, a memo whose stated key cannot deliver the "once an hour" cost the spec
accepts, and a determinism test that a memo hit would make pass without the seed.

## Recomputed values (all agree with the documents)

With `r = DRIFT_PCT / 200 = 0.10`, `s = Σ P_m / U`, `R = U(1 − s)`:

| Case (plan line) | Computation | Result | Document says |
|---|---|---|---|
| fallback 15 %, one neighbour, threshold `s` | `1/(1 − 0.17647·s/(1−s)) = 1.1` → `s/(1−s) = 0.515` | `s = 0.340` | "reproduces the old cap" (spec:85–86) ✓ |
| `s` = 0.40, 15 % (plan:334, 336) | `x = 0.17647 × 0.667 = 0.1176`; `1/(1−x) − 1` | 13.3 % → `mixed` | ≈ 13.3 % ✓ |
| `s` = 0.25, 15 % (plan:334) | `x = 0.17647 × 0.333 = 0.0588` | 6.25 % → rated | rated ✓ |
| `s` = 0.40, over side | `ΔO/R = 0.1304 × 0.667 = 0.087`; `1 − 1/1.087` | 8.0 % | under 10 % ✓ |
| `s` = 0.40, band 3 % (plan:335) | `(1/0.97 − 1) × 0.667 = 0.0206` | 2.1 % → rated | rated ✓ |
| two neighbours 0.20 each (plan:336) | `ΔU = 0.2U × 0.17647 × √2 = 0.0499U`; `/0.6U = 0.0832` | 9.07 % → rated | ≈ 9.1 % ✓ |
| repriced 500k→650k, `P_m` 0.40 (plan:343) | `R_swap = 0.6 + 0.4 × (1 − 500/650) = 0.6923`; `0.6/0.6923 − 1` | −13.3 % → `repriced` | ≈ 13.3 % ✓ |
| same, `P_m` 0.10 (plan:344) | `R_swap = 0.9231`; `0.9/0.9231 − 1` | −2.5 % | ≈ 2.5 % ✓ |
| 500k→200k, `P_m` 0.50 (plan:344) | `P_swap = 1.25U`, `R_swap = −0.25U` | ≤ 0 → `repriced` | ✓ |
| spec:71 `cv` 27.0 % | `27.0 × √(1/7 + 1/2) = 27.0 × 0.8018` | 21.65 | 21.7 > 20 ✓ |
| spec:73 `cv` 22.3 % | `22.3 × 0.8018` | 17.88 | 17.9 < 20 ✓ |
| spec:73 602k vs 536k | `602/536 − 1` | +12.3 % | +12 % ✓ |
| spec:87 bootstrap cost | `200 × 6.8 ms` | 1.36 s | ≈ 1.4 s ✓ |

The `|R / R_swap − 1|` metric (plan:331) is the relative move of M's figure (`W_M/R_swap ÷ W_M/R`), so it is the same quantity the `mixed` guard's
`R/(R − ΔU) − 1` and `1 − R/(R + ΔO)` measure; the two guards are on one footing as the spec intends (spec:71).

## Important

### I1. Spec:82–83 — the `mixed` inequalities compare a ratio to a percent

`R / (R − ΔU) − 1 > DRIFT_PCT / 2` and `1 − R / (R + ΔO) > DRIFT_PCT / 2`: the left sides are fractions (0.133 in the worked case), `DRIFT_PCT / 2` is
10. Read literally, the guard never trips. The plan has the right form (`DRIFT_PCT / 200`, plan:327–328), but the plan names the spec paragraph as "the
authority" (plan:301–302), so the two disagree on the authoritative text. Spec:94's prose "by more than `DRIFT_PCT / 2`" is fine as prose (a percent
move) but the formulae need the units.
**Fix:** in spec:82–83 write `> DRIFT_PCT / 200` (or `× 100 > DRIFT_PCT / 2`), matching plan:327–328 and the repo's existing `r = DRIFT_PCT / 200`
(`server/lib/usage-rate.ts:648`).

### I2. Spec:86–87 / plan:323–324 — the memo key cannot deliver "paid at most once an hour"

The key is the UTC hour of `nowMs` plus `intervals.length`. `intervals` is the whole joined list `usage-shape.ts:193` hands over, and it grows by one
interval per sample: the recorder appends a sample every 60 s (`server/lib/usage-history.ts:717` `SAMPLE_INTERVAL_MS = 60_000`, armed at `:853`) and
`joinIntervals` pairs consecutive samples (`server/lib/usage-rate.ts:324`). So the count changes roughly every minute while the sampler runs, and a hit
needs two `/api/usage/rates` requests inside the same minute. The client fetches that route once per card mount (`client/src/hooks/useUsageRates.ts:29`,
empty dependency array), so in practice the ~1.4 s bootstrap runs on essentially every card open, not once an hour. The spec's acceptance of the cost
(spec:86–87) rests on the "once an hour" claim, which the stated key does not deliver.
**Fix (one of):** (a) state the real cost — ~1.4 s of event loop per card load while the recorder runs — and accept it explicitly; (b) key the memo on
something stable inside the hour (the UTC hour alone, or the hour plus the set of UTC days the horizon covers, or the ledger's start/last-break stamps);
(c) move the bootstrap off the request path (recompute on the recorder's tick, serve the last result). Whichever is chosen, spec and plan must say the
same thing.

Related edge (same fix): on a hit the plan returns "the previous context's `error` map" (plan:324) beside a freshly fitted `horizon`. A model that
entered `horizon` since the memo was filled has no band and lands on the `SUB_ERR` fallback (plan:315–316), which spec:85 says is reachable only from
hand-built contexts. For a model whose first fit is still fragile, 15 % is narrower than the `{0.99, 9}` the bootstrap would likely give it. Say the
fallback is reachable live on a stale hit, or key the memo so a hit implies the same `horizon` key set.

### I3. Plan:340–342 — the determinism and memo tests are the same scenario, so the seed is never proven

"Two calls on the same intervals → deep-equal bands" and "a second `separationContext` call in the same UTC hour with the same interval count → the same
`error` object" describe one sequence of two calls. If the memo hits (it will: same hour, same length), the second call returns the first's object and
the deep-equal assertion passes with any PRNG, seeded or not. Likewise the two bootstrap fixtures on the same line (every day identical vs alternating
400k/600k) would, if they happen to share an interval count and `nowMs` hour, get each other's bands and fail for the wrong reason. Plan:324 exports a
reset only "if the memo would leak between cases" — it will, so the condition hides a required step (memory: "tests that prove nothing").
**Fix:** make the reset export unconditional; have the determinism case reset between its two calls (or call the exported bootstrap/band helper
directly, bypassing the memo); state that each bootstrap fixture either resets first or differs in interval count.

## Minor

- **Plan:337** — the `{0.99, 9}` band with `P_m` at 1 % of `U` does not land on the `R − ΔU ≤ 0` branch spec test 5 (spec:192) asks for: in floating
  point `1 − 0.99 = 0.010000000000000009`, so `ΔU ≈ 0.98999…U` against `R = 0.99U`, `R − ΔU ≈ +9e-16·U`, and the guard trips on the ratio branch
  (~1e15 > 0.1) instead. Still `mixed` and still finite, but the case does not pin the `≤ 0` branch. Use 2 % (`ΔU = 1.98U > R = 0.98U`) or add a case.
- **Plan:338** — "100 identical draws of 1.0 → `{ 0, 0 }`" does not state the resample count; 100 of 200 (exactly half, not "fewer than half") or 100 of
  100 both pass the rule, but the test should name which, since the boundary is the half rule.
- **Plan:328** — the `ΔU` formula drops the `min(under_m, 0.99)` clamp spec:81 carries and puts it in the helper (plan:319). A hand-built band of
  `under` = 1 reaches the guard unclamped: `1/(1 − 1)` = `Infinity`, `ΔU` = `Infinity`, `R − ΔU` = `−Infinity` → `mixed`. The outcome is right and the
  figures are untouched, but plan:329 "no path publishes `Infinity`" is true only because `ΔU` is not published. Say where the clamp lives.
- **Plan:320** — "usable intervals of the horizon `[since, until)`": the horizon fit is open-topped (`fitRates(intervals, nowMs − BASELINE_MS,
  Number.POSITIVE_INFINITY)`, `usage-rate.ts:682`). Say `until = +∞` so the resamples and the point fit read the same intervals.
- **Spec:87 vs plan:323** — "horizon interval count" vs `intervals.length`: the list `usage-shape.ts:193` passes is the whole joined list, not the
  horizon's subset. Name one (and see I2).
- **Plan:306** — line references: `SeparationContext` / `separationContext` are at `usage-rate.ts:663–685`, not ~729 (729 is `separatedRate`); the
  constants are 631–660. Guard block ~785–800 is right. `test/usage-rate-fit.test.ts` cap asserts are at 17–18, 407–409, 449 (within the cited ~296–473);
  `test/usage-rate-drift.test.ts` at 12 and 552 (cited ~464–552) — fine. `usage-limits.md`'s cv paragraph is 1033–1036, not ~1038.
- **Spec:118, 159, 202** (unchanged text) — still say "sensitivity cap" / "priced-out share under the cap" after the amendment removed
  `SEPARATION_S_CAP` (spec:87). Terminology only; a reader of §Why it is thin or §Goals will look for a cap that no longer exists.
- **Spec:69–74, 72–73** — the live back-test figures (Haiku −53 % on ~2.4 points and 1.6 % of tokens, Sonnet −43 %, Opus 7/15 → 14/15, 602k / 536k,
  526k, cv 22.3 %) come from an uncommitted scratch script (`variants.mts`); they cannot be checked from the repo. The arithmetic on them checks
  (table above), and the existing doc paragraph `usage-limits.md:1000–1004` records the same −53 % / −43 % measurement at 13:42 UTC. Plan Step 4
  (plan:354–356) re-measures against B = 1000 and names the stop condition, which is the right control.
- **Plan:324** — a memo hit pairs a band computed against an older `horizon` point rate with the new point rate. Bands are ratios, so the mismatch is
  second-order, but it is worth one clause in the `usage-limits.md` rewrite (Step 5).

## Checklist walk

Spec checklist. (1) Facts about code: `fitRates` filters by `toT` itself (`usage-rate.ts:1743–1752` via `explainRates`), so "refit `fitRates` on each"
resample is sound; `checkRepriced` on day cells is `day + DAY_MS > currentSince` (`usage-rate.ts:1008`), matching "every day cell inside it" (spec:92);
the memo-cost claim is false as stated (I2). (2) Internal consistency: units slip in the formulae (I1); every example value recomputes. (3) Edge cases:
`R ≤ 0`, `R − ΔU ≤ 0`, fewer-than-half draws, missing `current` rate, empty `error` map are all named; stale memo beside a new `horizon` is not (I2).
(4) No user-facing copy changes in the amendment. (5) Scope: `SUB_ERR` demoted to fallback is named (spec:221); nothing in scope depends on the scratch
script. (6) CLAUDE.md: no new dep (a seeded PRNG is hand-written), no outbound call, no file written; the dated measurement rule is followed on spec:72,
87 and plan:358.

Plan checklist. (1) Coverage: spec test 5 → plan:334–337; 5a → plan:340–342; 5b → plan:343–348; back-test bullets → Step 4; "Left to the builder" →
plan:313. Nothing uncovered. (2) Values match (table). (3) Reality: all Modify paths exist; `test/usage-shape.test.ts` does not, and the second hunk
correctly drops it from Step 3; `test/api-usage-rates.test.ts` exists; every `SEPARATION_S_CAP` import is in the two test files the task names.
(4) Interfaces: `SUB_BOOTSTRAP`, `SeparationContext.error`, the band helper and the reset are produced in Task 6b before the tests that consume them.
(5) Order: Steps 1→2→3→4→5 are in dependency order; Step 4's stop condition is stated. (6) Tests: the guard cases discriminate (two shares, two bands,
two neighbours); the determinism case does not (I3); the "repriced row" re-expression (plan:348) has a target (`test/usage-rate-drift.test.ts:580`,
plan:197). (7) Conventions: behaviour and exact cases, no literal code; soft size budget respected.
