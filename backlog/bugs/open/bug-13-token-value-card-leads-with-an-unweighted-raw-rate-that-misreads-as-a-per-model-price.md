---
id: bug-13
title: Token-value card leads with an unweighted raw rate that misreads as a per-model price
created: 2026-09-01
tags: usage, client, analytics
---

## Symptom

The Usage tab's **TOKEN VALUE PER MODEL** card prints, per model, "N / 1%" as its headline
figure. Read as intended — "what one percent of the 5-hour window is worth" — it invites a
cross-model price comparison the number cannot support. On live logs (2026-09-01, two days
of history, both rows `collecting`):

| model | windows | pts | rawPerPct (shown) | weightedPerPct |
|---|---|---|---|---|
| claude-opus-5 | 139 | 148.0 | **1.737M** | 0.257M |
| claude-fable-5 | 16 | 17.0 | **358k** | 0.065M |

That reads as fable being 4.85x more limit-expensive per token than opus, where the list
price ratio is ~2x. The user's reaction — "how can calculation be this wrong" — is the bug:
the card is arithmetically right and rhetorically wrong.

Two separate defects, both in what is *shown* rather than how it is computed:

1. The headline is the **unweighted** sum `in + out + cc + cr`, so it is dominated by
   cache-read volume — 97.2% of opus's raw tokens and 95.0% of fable's on this data. It
   therefore measures how much context a model's sessions replay per 1% of limit (a habit),
   not what a token costs. The code already knows this: `rawTokens` is commented "for the
   plain count, for the courtesy `1% ≈ N tokens` translation only", and every verdict is
   fitted on `weightedPerPct` instead.
2. Nothing on the card says the figure is not comparable across models. The heading
   ("TOKEN VALUE PER MODEL") and the subtitle ("Tokens per 1% of the 5-hour limit") both
   read as a price list.

## Repro

1. Usage tab with `Record usage history` on and at least `CURRENT_FLOORS` worth of
   intervals for two models (10 intervals, 5 utilisation points each).
2. Compare the two headline figures against the models' published price ratio.

Reproduced directly off `.usage-history.jsonl` + `.usage-ledger.jsonl` by re-implementing
the `joinIntervals` + `pool` math standalone: 1.737M and 358k, 139/148.0 and 16/17.0 —
matching the card exactly, so this is not a formatting or transport defect.

## Affects

- `server/lib/usage-rate.ts:211` — `raw += counts.in + counts.out + counts.cc + counts.cr`
- `server/lib/usage-rate.ts:217` — `rawPerPct: raw / utilSum`
- `server/lib/usage-ledger.ts:65` — `rawTokens`, the "courtesy translation" comment
- `client/src/components/usage/UsageRates.tsx:38` — renders `row.rawPerPct` as the headline
- `client/src/components/usage/UsageRates.tsx` — `up-sub` copy, heading text
- `docs/subsystems/usage-limits.md` — the classification table this card documents

## Cause

Design, not arithmetic. Three things were verified *not* to be the cause, so a fix that
targets them is wasted work:

- **Not token-type weighting.** Sweeping the cache-read weight in `TYPE_WEIGHTS`
  (`server/lib/usage-ledger.ts:54`) across 0.1 / 0.25 / 0.5 / 1.0 gives opus:fable ratios
  of 4.20 / 4.77 / 4.97 / 5.04. No weighting reaches 2x.
- **Not the small sample.** Bootstrap (2000 resamples) of fable's pooled `rawPerPct` at
  n=17: point 338k, 90% CI [245k, 437k]. Even the ceiling sits ~4x under opus.
- **Not the `DOMINANCE` selection filter.** Fable is rarely used alone — 50 of the 58
  `mixed` intervals contain it (mean weighted share 0.35, against opus's 0.63) — so the
  16 fable-owned intervals are a thin slice. But a 2-variable OLS of `dUtil` on per-model
  weighted tokens over 219 covered intervals, which *uses* the discarded mixed intervals,
  returns opus 0.40M weighted/pt and fable 0.10M weighted/pt: ratio **4.20**, same answer
  from an estimator with none of the selection bias.

The residual gap between the measured ~4.2-4.85x and the ~2x price ratio is a missing
per-request term in the model, filed separately as `task-10`. This bug is only about the
card presenting a habit-weighted, non-comparable figure as a price.

## Fix

unknown — the presentation choice is open. Candidates, in the order they were considered:

- lead with `weightedPerPct` and demote `rawPerPct` to a secondary line (does not change
  the 4.2x, but stops the cache-read mix from moving the headline);
- keep raw but add copy stating the figure measures this machine's usage pattern per model
  and that cross-model ratios also carry request granularity;
- both.

Blocked on `task-10` if the intent is for the card to become genuinely comparable across
models, since that is the term that closes the 4.2x-vs-2x gap.
