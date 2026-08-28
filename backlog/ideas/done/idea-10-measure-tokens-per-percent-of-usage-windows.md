---
id: idea-10
title: Measure tokens-per-percent of usage windows
created: 2026-08-28
tags: usage, forecast
promoted-to: task-8
---

## Problem

The Usage tab shows utilization percent, but nobody knows what a percent *is* in
tokens. Anthropic doesn't expose the window budget, so "1M tokens ≈ 10% today,
15% tomorrow" is unfalsifiable — is the limit drifting, or is the token *mix*
(model, cache read vs fresh input vs output) just different day to day? The
limit is almost certainly cost-weighted, and Claude Code traffic is >90% cache
reads (the cheapest kind), so raw-token counts are a misleading unit.

## Rough shape

Both data streams already exist or are cheap:

- The usage recorder already appends `{t, utilization, resetsAt}` per minute
  (`server/lib/usage-history.ts`), and the 5h window fully resets at `resetsAt`
  — inside one window utilization only climbs, so Δutilization between samples
  is pure new consumption.
- Transcripts under `~/.claude/projects/*/*.jsonl` carry per-message `usage`
  blocks (input / output / cache-create / cache-read tokens, model, timestamp).

Plan sketch:

1. New per-minute ledger beside the usage history: token deltas per
   (model × token-type) summed across all local sessions.
2. Weight deltas by published API pricing → estimated cost; one unknown left,
   the window budget: `budget ≈ Δcost / Δutilization`.
3. Aggregate per window rather than per minute to kill endpoint quantization
   noise; track the fitted budget across days to answer the stability question
   directly.
4. Surface in the Usage tab: "1% ≈ N weighted tokens", estimated absolute
   window budget, day-over-day stability.

## Open questions

- Cross-device usage (claude.ai, phone, cloud sessions) burns percent with zero
  local tokens — discard intervals with Δutil > 0 and Δtokens = 0, or filter to
  intervals with local activity?
- Do API pricing weights actually fit, or does the subscription discount cache
  reads differently? (Fallback: least-squares fit the weights themselves.)
- Weekly window: same method works but feedback loop is 7 days — worth showing
  before it converges?
- Where does the ledger live — same dir as the usage history JSONL, same
  heartbeat/compaction rules?
