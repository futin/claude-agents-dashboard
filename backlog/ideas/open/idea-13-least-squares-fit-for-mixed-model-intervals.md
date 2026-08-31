---
id: idea-13
title: Least-squares fit for mixed-model intervals
created: 2026-08-31
---

## Problem

`server/lib/usage-rate.ts` attributes an interval to a model only when that model
holds ≥ 90% of its weighted tokens (`DOMINANCE`). Everything else is classified
`mixed` and discarded from every fit. If a real usage pattern keeps two models busy
together — a big model driving small subagents is the obvious one — the discard share
could be most of the data, and the card would sit on `collecting` indefinitely while
the machine is plainly working.

## Rough shape

Treat each interval as one equation `Σ_m rate_m · weighted_m = Δutil` and solve for
the per-model rates by least squares over a window's intervals, instead of throwing
mixed intervals away. Named as the follow-up in the design record
(`docs/superpowers/specs/2026-08-28-model-token-rates-design.md`) and deliberately not
built in task-8.

**Measure before building.** The decision needs the actual discard share, which the
endpoint does not currently report — `shapeUsageRates` counts clean intervals only.
Cheapest first step is to expose the interval-kind tally (clean / mixed / external /
gap / idle) so the question can be answered from real data rather than guessed.

## Open questions

- Is it under-determined in practice? Two models *always* used together give
  collinear columns, and a wrong split is indistinguishable from drift — the exact
  failure dominance was chosen to avoid.
- Where would the regularisation come from — a prior that rates are stable, or the
  clean-interval rate as an anchor?
- Does it need to survive the drift comparison, or would fitted-from-mixed rates be
  shown but excluded from drift verdicts?
