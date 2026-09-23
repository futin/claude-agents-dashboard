---
id: bug-27
title: subagent_tokens undercounts subagent usage by 5-340x
created: 2026-09-21
tags: analytics, kaizen, usage
updated: 2026-09-23T09:13:10Z
started: 2026-09-23T09:00:44Z
execute-elapsed: 746
execute-tokens: 131706
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

## Outcome

2026-09-23 — fixed. Subagent spend is now summed from each subagent's own `<sessionId>/subagents/agent-<agentId>.jsonl`, once per `message.id`
(`server/lib/subagent-usage.ts`), paired to its launch by `agentId` — which `agents.ts` now captures from sync results too (new `AgentJob.agentId`) — or by the
`.meta.json` sidecar's `toolUseId`. `SubagentTotals` gained `usage: TokenTotals` (four classes + `billableApprox`) and `fallbackCount`; `bySubagent[].tokens` in
the analysis is the per-subagent figure counted into the total. The Analytics metric shows the billable / cache-read split as a tooltip. `kaizen.mjs` mirrors
all of it, and a new test runs `kaizen.mjs` against `analyzeSession` on one fixture to keep them in step.

Cause, re-confirmed live and corrected: the harness figure is not "non-cached tokens" — it is the subagent's **final context size** (matches the last turn's
four-class sum within a few hundred tokens on every subagent probed). And it was not absent on `93319dd5`: all 37 launches carried `toolUseResult.totalTokens`,
which the current parser already reads. The fix is the same either way.

Fallback rule: a finished subagent takes its transcript sum unless that sums below the harness figure (the final context can't exceed every turn added
together, so that means the file is still being written) — then the harness figure, counted in `fallbackCount` and flagged in `notes` as a lower bound. A running
launch stays unknown. A subagent file no launch claims is left out, rather than risk a double count.

Real data after the fix (server `analyzeSession`; `kaizen.mjs` prints identical `subagentTotals`):

```
45be9cde {"count":43,"tokens":78655380,"usage":{"input":2124,"output":379043,"cacheCreation":5436003,"cacheRead":72838210,"combined":78655380,"billableApprox":5817170},"fallbackCount":0,"unknownTokenCount":0}
fecb27f9 {"count":37,"tokens":379211985,"usage":{"input":3544,"output":104620,"cacheCreation":10543449,"cacheRead":368560372,"combined":379211985,"billableApprox":10651613},"fallbackCount":0,"unknownTokenCount":1}
93319dd5 {"count":37,"tokens":332339619,"usage":{"input":3956,"output":212345,"cacheCreation":5228881,"cacheRead":326894437,"combined":332339619,"billableApprox":5445182},"fallbackCount":0,"unknownTokenCount":0}
```

45be9cde and 93319dd5 now equal the item's "actual" column exactly. fecb27f9 is 229,236 short of 379.44M: one launch (`toolu_012bouagjio6StJS6pfc7R6D`)
never got a completion in the parent transcript, so it reads as running → unknown, by design.

Also ported to `kaizen.mjs`: bug-11's `notificationText` (mid-turn-absorbed `<task-notification>`s). Without it kaizen read 10 of 45be9cde's async subagents as
still running and reported 76.08M against the server's 78.66M.

Verification (`pnpm typecheck` exit 0; `pnpm build` then `pnpm test`):

```
=== analyze.ts ===
  ✓ subagent files, zero harness figures → the transcripts' real total, split by class
  ✓ harness figure on some dispatches only → transcript wins where present, no double count
  ✓ mid-write subagent file → falls back to the harness figure; running subagent stays unknown
  ✓ no agentId in the result → matched through the file's meta.json toolUseId
  ✓ no subagents dir → harness figure as before, counted as fallback
  ✓ vendored kaizen.mjs reports the same subagent figures as analyzeSession
Passed: 23  Failed: 0
...
5 passed, 0 failed
ALL PASS
```

Before `pnpm build`, the suite failed exactly one unrelated case, `api-usage-rates` "a near-miss path is not the rates endpoint": it expects the SPA shell, and a
fresh worktree has no `client/dist`. It passes once the client is built. This diff does not touch that path.

Contract sweep: 7 sites updated (.claude/skills/kaizen/SKILL.md ×2 — "exact" subagent tokens, ≈ whole-session total; docs/subsystems/analytics.md — new bullet + docs-sync source; docs/overview.md ×2 — scan.ts note, new module line; docs/subsystems/sessions.md — detail panel tokens are the harness figure; server/lib/agents.ts header — totalTokens is not exact spend). Left standing on purpose: docs/learning-notes/kaizen-and-analytics{,-diagrams}.md still say subagent tokens are "exact". They are raw study notes, a record of a moment, so I left them as written. docs/subsystems/usage-limits.md:675 is still true.
Red proof: 7 tests went red with the change reverted (agents.ts → the agentId test plus 3 analyze tests; analyze.ts → all 6 new analyze tests; kaizen.mjs → the parity test, which also goes red with only the notificationText port reverted; removing the mid-write guard, or the running guard, turns the mid-write test red)
