---
id: bug-27
title: subagent_tokens undercounts subagent usage by 5-340x
created: 2026-09-21
tags: analytics, kaizen, usage
---

## Symptom

The Analytics tab's `subagents · <n>` metric and kaizen's `subagentTotals.tokens` both report a number that is 5x to 340x smaller than what the subagents
actually moved. On a session where the subagents genuinely spent more than the controller did, the surface shows them as a rounding error, so a run whose cost
was majority-subagent reads as a cheap run.

Measured 2026-09-21 across three sessions that used `superpowers:subagent-driven-development`, comparing the summed `<subagent_tokens>` tags in the main
transcript against the summed `message.usage` of every record in that session's own `subagents/agent-*.jsonl` files:

| session    | subagents | reported | actual  | ratio  |
| ---------- | --------- | -------- | ------- | ------ |
| `45be9cde` | 43        | 16.76M   | 78.66M  | 4.7x   |
| `fecb27f9` | 37        | 34.27M   | 379.44M | 11.1x  |
| `93319dd5` | 37        | 0.97M    | 332.34M | 342.3x |

The 342x case is the clearest tell: only **3** `<subagent_tokens>` tags existed for 37 dispatched subagents. The other 34 contributed zero.

Priced at published API rates, `fecb27f9` was $47 controller + $111 subagents. The surface attributed roughly a tenth of that second figure.

## Repro

1. Open a session that dispatched subagents and whose project dir contains `<sessionId>/subagents/agent-*.jsonl` — e.g. the three above.
2. Read the `subagents · <n>` figure on the Analytics tab (or run `/kaizen` and read `subagentTotals.tokens`).
3. Sum `cache_read_input_tokens + cache_creation_input_tokens + input_tokens + output_tokens` over every unique `message.id` in that session's
   `subagents/*.jsonl`.
4. Step 3 is 5x to 340x step 2.

## Affects

- `server/lib/agents.ts:69` — `SUBAGENT_TOKENS_RE`, the only source of the number.
- `server/lib/agents.ts:137` — `tokens: intFromMatch(flat, SUBAGENT_TOKENS_RE)`, which yields null when the tag is absent.
- `shared/types.ts:601` — documents the field as coming from the notification tag.
- `client/src/components/analytics/atoms.tsx:99` — renders `a.subagentTotals.tokens`.
- `.claude/skills/kaizen/kaizen.mjs:77` and `:95` — the vendored copy of the same regex, so kaizen inherits the same undercount.

Not affected: `server/lib/usage-ledger.ts:311-313` already counts subagent turns from the transcripts and documents that it does. The two surfaces therefore
disagree with each other today, which is a second symptom of the same cause.

## Cause

`<subagent_tokens>` is a tag the harness emits into the Agent tool result. Two independent problems with trusting it:

1. **It appears to carry only the subagent's non-cached tokens.** A subagent that runs 45 turns replays its own context on each one; none of that replay is in
   the tag. This is inferred from the ratio pattern, not from reading the emitter — confirm before building on it.
2. **It is frequently absent.** 3 tags for 37 subagents on `93319dd5`. `intFromMatch` returns null, the totals treat it as unknown, and the session's
   `unknownTokenCount` note is the only surviving trace.

The authoritative data is already on disk and is already enumerated by this codebase: `server/lib/scan.ts:119` defines `SUBAGENT_DIR` and `:178` walks
`<projectDir>/<sessionId>/subagents/agent-*.jsonl`.

## Fix

Stop deriving subagent tokens from the tag. Read the subagent transcripts, the way `usage-ledger.ts` already does, and sum `message.usage` over unique
`message.id` — the same de-duplication the main-chain scan uses, because usage repeats per content block.

Keep the tag as a fallback for a subagent whose transcript is missing or still being written, and keep reporting `unknownTokenCount` for that case only.

The four token classes should stay separable at the API boundary rather than collapsing to one integer, so the surface can distinguish what the subagents
*spent* from what they *replayed* — the same distinction the session surface already draws.

Both the dashboard and the vendored `/kaizen` skill carry the regex, so both change together, and `docs/subsystems/analytics.md` is in lockstep with the
kaizen log format per the repo's CLAUDE.md.

Test cases worth pinning: a session with N subagent files and zero tags (must report the real total, not zero); a session with tags on some dispatches only
(must not double-count the tagged ones); a subagent file that is mid-write (must fall back to the tag rather than under-reporting); and a session with no
`subagents/` dir at all (must behave as today).
