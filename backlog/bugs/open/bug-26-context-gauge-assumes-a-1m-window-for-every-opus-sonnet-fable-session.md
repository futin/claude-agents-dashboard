---
id: bug-26
title: Context gauge assumes a 1M window for every opus/sonnet/fable session
created: 2026-09-20
tags: sessions, context
---

## Symptom

A session running plain `opus` (200k window) is shown against a 1,000,000-token denominator, so the context gauge reads roughly 5x safer than reality — a card
sitting at ~60% of its real window displays ~12%. The gauge is the main signal for "this session is about to compact", and it is wrong in the dangerous
direction: it never warns.

Noticed while asking why an Opus 5 session displayed a 1m context when nothing in config requests one. Config is clean — `~/.claude/settings.json` has
`"model": "opus"` with no `[1m]`, no context-related env var, and no `1m` anywhere in global or project settings. The session transcript records
`"model":"claude-opus-5"`. The 1M comes entirely from the dashboard's own inference.

## Repro

1. Run any session on plain `opus` (or `sonnet` / `fable`) without the 1m beta.
2. Open the Sessions view.
3. The context gauge for that card is computed against 1,000,000 rather than 200,000.

## Affects

- `server/lib/transcript.ts:23` — `LARGE_WINDOW_MODEL_PATTERNS = [/sonnet/i, /opus/i, /fable/i]`
- `server/lib/transcript.ts:266` — the `[1m]` marker check
- `server/lib/transcript.ts:267` — the family-regex branch that returns `LARGE_WINDOW`
- `server/lib/transcript.ts:268` — the token-count branch

## Cause

`transcript.ts:267` returns `LARGE_WINDOW` for any model id matching the family regex, which every Opus/Sonnet/Fable session does — the patterns match the
family name, not the beta. Having a 1M-capable family says nothing about whether the 1m window was actually granted to this session.

The `[1m]` marker check one line above (`transcript.ts:266`) was meant to be the real discriminator, but it is dead for live sessions and the code says so
itself — the comment at `transcript.ts:17` records that real transcripts never carry the marker, because it is a beta-header artifact that never reaches
`message.model`. With the only honest signal inert, the family regex became the de facto answer for everything.

The underlying constraint: **the granted window is not recoverable from the transcript.** The 1m beta travels as a request header and the API does not echo it
back, so no field on disk distinguishes a 200k `opus` session from a 1M one. Any fix is choosing which way to be wrong when the answer is unknowable.

## Fix

unknown — candidate below, but it carries a real call that should be made at groom time, not assumed here.

Candidate: delete `LARGE_WINDOW_MODEL_PATTERNS` and the `transcript.ts:267` branch entirely, leaving `transcript.ts:268` (`tokens > STANDARD_WINDOW →
LARGE_WINDOW`) as the only promotion path. That branch self-corrects: a session starts measured against 200k and flips to 1M the moment it demonstrably exceeds
200k, which is proof rather than inference. Keep `transcript.ts:266` — harmless, and it becomes live if a future transcript format ever carries the marker.

The tradeoff to decide: a genuine 1m session then reads against 200k for its whole first 200k of context, showing >100% until it crosses over. Whether that
over-warning is preferable to today's silent under-warning is the judgement call. Worth checking what the gauge renders above 100% before committing to it.

Two further things a groom should settle:

- Whether the promotion should be sticky per session once it fires, so a card can't oscillate between denominators as the tail window is re-read.
- What `STANDARD_WINDOW` should be for Haiku, which falls through both branches today and gets 200k by default — probably correct, but it is untested rather
  than decided.
