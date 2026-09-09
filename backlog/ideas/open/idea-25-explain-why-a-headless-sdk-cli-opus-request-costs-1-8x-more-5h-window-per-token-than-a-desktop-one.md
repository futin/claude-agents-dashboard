---
id: idea-25
title: Explain why a headless (sdk-cli) opus request costs ~1.8x more 5h-window per token than a desktop one
created: 2026-09-09
tags: usage, rates
---

## Problem

Measured 2026-09-09 over 17 days of this machine's logs (tokens rebuilt from disk incl.
subagent files, opus-dominant 30-min bins of contiguous priced intervals):

| surface | weighted tok / 1% | bins | Σutil |
|---|---|---|---|
| `claude-desktop` (interactive Code tab) | ~460k | 53 | 203 |
| `sdk-cli` (headless `claude -p`, orchestrator runs) | ~255k | 86 | 598 |

A headless opus request consumes **~1.8× more of the 5-hour window per weighted token**
than an interactive one, and the gap holds at every time of day (weekday-day / -night /
weekend: desktop 475k / 477k / 420k, headless 229k / 234k / 279k) and in both the
baseline and current drift windows (bug-23).

Everything the transcripts record is the same on both sides: cache-write 31–34%,
cache-read 54–58%, output 9–11% of weighted tokens; ~23k weighted tokens/request; ~130k
cache-read tokens/request; `usage.speed` standard; `service_tier` standard;
`inference_geo` not_available; cache writes 100% 1h TTL; no `max_tokens` stops; API-error
lines rare on both (529s, "individual spend limit"). So whatever costs the extra window is
**not in the transcript**. Until it is named, no per-model rate on the card is a price —
it is a blend of two prices in whatever proportion the week happened to run.

## Rough shape

Hypotheses, cheapest test first:

1. **Off-transcript spend correlated with headless runs.** Requests the orchestrator kills
   (timeouts, `--abort`, the `claude -p` hang-on-exit workaround), SDK-level retries on
   529/overloaded, and any `claude -p` the pipeline runs without persistence (commit
   messages, reviews via `--print`) burn window with no assistant record on disk.
   Test: during one orchestrator run, count `POST /v1/messages` at the process level
   (e.g. a logging proxy via `ANTHROPIC_BASE_URL` — but note `lib/usage.ts` must keep
   hitting api.anthropic.com for the usage read) and compare with assistant records
   written. Also grep the plugin for every `claude -p` / `--print` it spawns.
2. **Controlled burn.** One surface, one 5h window, nothing else running: (a) an
   interactive desktop session doing a fixed task; (b) the same task via `claude -p`.
   Read `/usage` before and after each. Two numbers settle whether the gap is real at
   the request level or an artefact of how the work is distributed across ticks.
3. **The "individual spend limit" angle.** The account is a Team/Enterprise seat (48
   "You've hit your individual spend limit" errors in 17 days, 31 of them headless). If
   headless runs push into extra usage, the `/usage` utilization may behave differently
   at the top of the window (pinned at 100% while spend continues → intervals read
   `idle`, excluded, but edge intervals around the cap could carry the whole overshoot).
   Test: correlate low-ratio bins with utilization ≥ 95% at `fromT`.
4. **Anthropic weights the path differently.** Unfalsifiable from here; only left if 1–3
   come back empty. Same standing as the 4.2× opus:fable ratio in
   `docs/subsystems/usage-limits.md` — a finding, not a defect, until something explains it.

Prior art: `server/lib/usage-rate.ts` (`joinIntervals`, `poolRate`, `explainSplits`),
the two-term fit in task-10 that refuted a per-request term — on the *ledger's* request
counts, which miss every subagent request (bug-22); worth re-running once bug-22 lands.
The 4-type and (out, ctx, req) least-squares fits attempted during the investigation were
ill-conditioned (coefficient sign flips between windows) and prove nothing either way.

## Open questions

- Is the 1.8× stable across models, or opus-specific? Fable/sonnet volume is too thin to
  say today.
- Does `mixed-surface` (both running at once) land between the two (measured ~300–340k) —
  i.e. is the cost additive per request, which would point to 1, or does concurrency
  itself cost something?
- If hypothesis 1 holds, is the fix on the recorder (count aborted/retried requests) or on
  the orchestrator (stop producing them)?
- Should the card refuse to show a pooled rate at all while two surfaces with a >1.5×
  gap share the window, and show the split only (bug-23 fix option 3)?
