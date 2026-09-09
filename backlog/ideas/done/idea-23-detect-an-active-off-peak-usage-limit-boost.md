---
id: idea-23
title: Detect an active off-peak usage-limit boost
created: 2026-09-06
tags: usage, rates
updated: 2026-09-09T12:03:18Z
promoted-to: task-24
groom-elapsed: 425
groom-tokens: 93560
---

## Problem

Anthropic has shipped a **time-of-day capacity promotion** at least once: usage limits
doubled outside weekday peak hours (before 8am ET / after 2pm ET) and all weekend, for
Free/Pro/Max/Team across the Claude app, Cowork and Claude Code. It ran roughly
2026-03-13 → 2026-03-27, applied automatically, and the bonus did **not** count against
the weekly cap.

Nothing in the dashboard would have shown it. The Usage tab reports the fitted rate as a
single pooled number, so a live 2x boost reads as "you're burning half as fast this week"
with no explanation — indistinguishable from a lighter workload or a cheaper model mix.

This is not pricing. Anthropic publishes no time-of-day *pricing*, and the pricing page's
modifiers (batch 50%, cache multipliers, fast mode, `inference_geo`) are all properties of
the request, never the clock. It is a **limits** promotion, which lands squarely in the
unit `usage-rate.ts` already fits.

## Rough shape

A 2x limit boost is arithmetically identical to the same tokens costing **half the window
percentage**. So the detector is a bucketing of the existing fit, not new measurement:

- Bucket priced, model-owned intervals from `joinIntervals` by ET hour-of-day and
  weekend/weekday, then compare tokens-per-1% across buckets.
- Surface on the Usage tab whether a boost **appears active** — and, when it does, which
  hours it covers as observed, not as announced.

**Scope is deliberately detection and display only.** No "best hour to start a session"
recommendation, no scheduling advice, no forecast integration. Those were considered and
cut: they need the 168-bucket profile to be well-populated, and they turn an observation
into a prediction the data does not yet support.

Prior art in-repo: `server/lib/usage-rate.ts` (`joinIntervals`, `poolRate`,
`totalWeighted`, `isUnpriced`) already does the whole join and fit. `usage-history.ts`
already records the 168 hour-of-week buckets. The detector adds a grouping and a card.

### Measured baseline (2026-09-06)

Probed against this machine's own recorded data — **no boost is currently live**:

```
weekday PEAK       n=345  Σutil=381   218.7k tokens per 1%
weekday off-peak   n=445  Σutil=482   219.0k
weekend            n=376  Σutil=453   222.0k
ratio off-peak / PEAK = 1.01x
```

Opus 5 alone (nearly all the volume): 227.0k peak vs 232.1k off-peak, 1.02x. No step at
any ET hour. So the null case is confirmed to read flat, and a 2x step would have been
unmissable at n=1166 priced intervals / 1316 cumulative util points.

Classification breakdown at that sample size, for whoever tunes the floors: 1103
`model:claude-opus-5`, 752 `pre-ledger`, 173 `external`, 167 `idle`, 116 `mixed`, 58
`partial`, 40 `model:claude-fable-5-1`, 33 `gap`, 16 `model:claude-fable-5`, 5
`model:claude-sonnet-5`, 2 `model:claude-haiku-4-5`.

## Open questions

- **Does the 5h `utilization` counter reflect the boost at all?** The March promo excluded
  the bonus from weekly caps, so the 5h and weekly windows may report it differently — or
  the endpoint may rescale utilization so a boost is invisible in the percentage and only
  visible in absolute headroom. Unverified, and it decides whether this works.
- **Weekend coverage is thin.** The baseline above rests on 2 distinct weekend days
  (ledger span 6.54d vs history span 11.97d). Enough to rule out a 2x step, not enough to
  characterise a subtler one. What is the minimum span before the card is allowed to
  claim anything?
- **Hardcode the March boundaries, or learn them?** The 8am/2pm ET window is the only
  observed instance; a future promo could use different hours. Learning the step from the
  data is more honest but needs far more coverage than hardcoding.
- **What is the false-positive story?** A model-mix shift or a run of cache-heavy sessions
  moves the fitted rate too. `driftRow` already distinguishes `drift` from `mix-shift` —
  can the detector reuse that verdict rather than inventing a second one?
- **Should it show anything at all in the null case?** A permanently visible "no boost
  active" card is noise 50 weeks a year.
