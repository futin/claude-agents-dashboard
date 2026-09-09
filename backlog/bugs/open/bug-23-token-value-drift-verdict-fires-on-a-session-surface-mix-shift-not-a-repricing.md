---
id: bug-23
title: Token-value drift verdict fires on a session-surface mix shift, not a repricing
created: 2026-09-09
tags: usage, rates
---

## Symptom

On 2026-09-09 the Token-value card showed `claude-opus-5` at 180k weighted tok/1%,
**−21.9% vs baseline**, badge `drift`. Read literally: 1% of the 5h window buys 22% fewer
tokens than two weeks ago. Nothing was repriced. Splitting the same intervals by the
session surface that produced the tokens (`entrypoint` on the transcript records),
opus-dominant 30-min bins, tokens rebuilt from disk incl. subagent files (bug-22):

| surface | baseline | current | Δ | share of window moved |
|---|---|---|---|---|
| `claude-desktop` (interactive) | 462k (162 pts) | 455k (41 pts) | −1.6% | 27% → 10% |
| `sdk-cli` (headless `claude -p`) | 260k (253 pts) | 249k (345 pts) | −4.1% | 42% → 83% |
| pooled | 334k | 272k | **−18.6%** | |

Each surface is flat within noise; the headless share of the window doubled; the pooled
ratio fell. Simpson's paradox. The user's actual question — "did opus get more
expensive?" — has the answer *no*, and the card says *yes*.

Token composition is identical across surfaces (cache-write 31–34%, cache-read 54–58%,
output 9–11% of weighted; ~23k weighted/request; ~130k cache-read/request), and a
surface × Berlin-time-bucket cross-tab shows the gap holds at every hour (desktop
475k / 477k / 420k weekday-day / weekday-night / weekend; headless 229k / 234k / 279k),
so it is not a time-of-day or mix effect the weights could absorb. Why a headless request
costs ~1.8× more window per token is its own item (idea-25). This bug is about the verdict
being blind to it.

`effort` shows the same picture because it is a proxy for surface here: `xhigh`/`max`
were 79%/100% `claude-desktop`, `high` was 71% `sdk-cli`. The card's design note says
the weighted rate is "effort-invariant"; on this data `high` ran at 299k and `xhigh` at
491k *inside the same baseline window*. The invariance argument (thinking tokens are
output tokens) is right about tokens and wrong about what actually differs between those
sessions.

## Repro

Live: `GET /api/usage/rates` on a day after an orchestrator-heavy stretch (07–08 Sep 2026
was one) → `deviationPct` ≈ −22, `verdict: drift`. Then group opus-owned intervals by the
dominant `entrypoint` of the records inside each interval and pool per group per window —
both groups come out flat. The probe that found it lived in the session scratchpad as
`surface.mts` (rebuild ledger from disk on real tick boundaries → `joinIntervals` →
30-min contiguous bins → pool by surface); any equivalent reproduces it.

Ruled out on the same data, so groom does not redo it: fast mode (`usage.speed` never
`fast`), `service_tier` (standard 100%), cache TTL (`pnpm check:weights` green, 100% 1h),
long-context share (22–48%/day, no trend), off-peak boost (idea-23's 09-06 probe flat),
idle-stranded tokens (3.7% → 7.1%, all-in rate still −19%), pure-external share
(11.9% → 17.7%, excluded from the pool anyway), turn shape (43–45 req/M weighted both
windows), and the subagent blind spot (bug-22 — corrected deviation still −22.0%).

## Affects

- `server/lib/usage-rate.ts:477` `poolRate` — Σtokens/Σutil over every interval the model
  owns, with no notion of where the tokens came from.
- `server/lib/usage-rate.ts:533` `driftRow` — compares two pools whose composition can
  differ; `DRIFT_PCT` (20) was tuned to the day-to-day dispersion of a *fixed* mix.
- `server/lib/usage-ledger.ts` `LedgerLine.tok` — keyed by model only; the ledger does
  not record `entrypoint`, so the split cannot be computed from the ledger today.
- `shared/types.ts` `ModelRateRow` — nothing to carry a per-surface figure.
- `client/src/components/usage/UsageRates.tsx:129` — the `vs baseline` chip.
- `docs/subsystems/usage-limits.md` "Drift is judged on the weighted rate only" /
  "effort-invariant" paragraph — states the invariance as fact.

## Cause

The pooled ratio assumes every opus token buys the same fraction of the window. It does
not: two populations of requests coexist at ~1.8× different window cost per token, and the
verdict reads a change in their proportions as a change in price. Any pooled Σ/Σ over a
heterogeneous population does this; the day floors and the ±20% band guard against
sampling noise, not against composition shift.

## Fix

Candidate — groom to choose the shape:

1. **Record the surface.** Ledger lines gain a per-model split by `entrypoint`
   (`tok[model]` → `tok[model][entrypoint]`, or a parallel `surface` map), the way `req`
   was added as a parallel map. Old lines have no split; treat as `unknown`.
2. **Judge drift within a surface, not across the pool.** Either stratify — a row per
   (model, surface) with its own baseline/current — or keep one headline and require the
   dominant surface's own deviation to cross `DRIFT_PCT` before saying `drift`, calling
   the pooled move **mix shift** otherwise (the vocabulary already exists for raw-vs-
   weighted; this is the same verdict for a different mix).
3. **Show the split.** The card's honesty rule is "no rate is comparable across models";
   add "and not across surfaces" — a headless point and an interactive point are not the
   same goods. A two-line breakdown under the headline, `desktop 455k · headless 249k`, is
   the smallest UI that stops the misread.
4. Correct the doc: effort-invariance holds for tokens, not for cost; cite this item.
5. Tests: exact cases — a fixture where surface A is 400k/1% and surface B 200k/1% in both
   windows, A:B moves 60:40 → 20:80, pooled falls ~25%, verdict must **not** be `drift`;
   the mirror case where both surfaces fall 25% at a constant mix must be `drift`
   (test-the-untested-complement). Mutation: with the surface guard removed the first case
   reports `drift`.

Until 1. lands there is no way to compute this from the ledger; a first cut can run the
disk rebuild the probe used, but that is the analytics-side scan, not the recorder.
