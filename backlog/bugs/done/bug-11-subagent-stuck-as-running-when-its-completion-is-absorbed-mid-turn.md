---
id: bug-11
title: Subagent stuck as running when its completion is absorbed mid-turn
created: 2026-08-31
tags: agents, server
---

## Symptom

A background subagent that finished stays `RUNNING` on the session detail panel
indefinitely, its live duration ticking upward long past the real finish. Observed at
29m8s for an agent that had actually stopped 14m32s in, ~15 minutes earlier. The
`N running · N finished` counts are wrong to match, and analytics never sees the job's
tokens or tool count.

## Repro

1. Launch a background subagent (`run_in_background: true`).
2. Keep the parent session busy so it is mid-turn when the agent finishes — e.g. a long
   tool call, or a pending permission prompt.
3. Agent completes. Claude Code absorbs the notification into the running turn instead of
   delivering it as a fresh user message.
4. Open that session in the dashboard: the agent is still `RUNNING`.

Live evidence, session `d4aef3be-4e1a-40ae-90a8-a01bfe1cc443` under
`~/.claude/projects/-Users-andrejajevtic-Documents-custom-projects-backlog-manager/`:

| line | ts | record |
|---|---|---|
| 316 | 21:20:14 | `LAUNCH` `toolu_01Xp8c1pqbyLkHoyyzdqCSkw`, general-purpose, `run_in_background: true` |
| 317 | 21:20:16 | async ack, agentId `aacf84e5d9331c7c9` |
| 381 | 21:34:50 | `type:"queue-operation"` enqueue — full `<task-notification>`, `<status>completed</status>` |
| 385 | 21:34:55 | `type:"attachment"` — same payload in `attachment.prompt` |
| 386 | 21:34:55 | `type:"queue-operation"` remove, `reason: "absorbed_mid_turn"` |

None of 381/385/386 has a `message` field. The dropped `<usage>` block held
`146111` tokens, `71` tool uses, `872048` ms.

The control case is in the same file: agent `a47a55dc9ebe69bf9` notified at line 430 as a
normal `type:"user"` record with `message.content` and resolved to `done` correctly. Same
code, same session — the only difference is the record shape the notification landed in.

## Affects

- `server/lib/agents.ts:92` — `parseRecordEvents`: `const msg = rec && rec.message; if (!msg) return [];`
- `server/lib/agents.ts:191` — `applyEvent`: launch stays parked in `byAgentId`, `endedAt` never set
- `server/lib/agents.ts:238` — `toAgentJobs`: `status: l.endedAt ? 'done' : 'running'`
- `client/src/components/SessionDetail.tsx:32` — running rows render `now - startedAt`, so the stale row keeps counting
- `server/lib/agents-cache.ts` — same parser, so the incremental cache is wrong identically (no divergence from the oracle)

## Cause

`parseRecordEvents` reads a task-notification only out of `rec.message.content`, and
returns `[]` for any record without a `message`. When the notification arrives while the
parent is mid-turn, Claude Code never writes it as a `type:"user"` message — it writes a
`queue-operation` pair carrying the payload in a top-level `content` string and an
`attachment` record carrying it in `attachment.prompt`. Both are skipped, so no `notify`
event is emitted, `byAgentId` keeps the launch forever, and the job reports `running`.

The notification is delivered to the model in that turn, so nothing is broken in Claude
Code — this is purely the dashboard reading one of two legitimate delivery shapes.

## Fix

In `parseRecordEvents`, build the `<task-notification>` scan text from three sources
instead of one: `contentText(rec.message?.content)`, `rec.content` when it is a string,
and `rec.attachment?.prompt` when it is a string. Move the `if (!msg) return []` guard so
it only short-circuits the `content`-block loop (launches / tool_results), not the
notification scan.

Dedup needs no new state: the same payload appears up to three times, but `applyEvent`
deletes the agentId from `byAgentId` on the first notify, so every repeat is a no-op —
and first-wins already keeps the earliest (enqueue) timestamp, which is the closest to
the real finish time.

Test cases (`test/agents.test.ts`, plus the cache oracle in `test/agents-cache.test.ts`):

- launch → async ack → `type:"queue-operation"` record with top-level `content` carrying a
  completed notification ⇒ `status: 'done'`, `durationMs` from `<duration_ms>`, tokens and
  toolUses populated
- launch → async ack → `type:"attachment"` record with `attachment.prompt` ⇒ same
- all three records (enqueue, attachment, remove) in sequence ⇒ exactly one resolution,
  `endedAt` from the first, no double-count in the done tally
- a `queue-operation` whose payload has `<status>running</status>` or no `<status>` ⇒ still
  `running` (mirrors the existing `!ev.completed` rule)
- the existing `type:"user"` notification path still resolves, unchanged
- feeding the same fixture through `readAgentsCached` split across a byte boundary matches
  `readAgents` (the cache/oracle equivalence the suite already asserts)

## Verification

- `parseRecordEvents` now scans `message.content`, top-level `rec.content` and
  `rec.attachment.prompt` via a new `notificationText` helper
  (`server/lib/agents.ts`); the `message` guard no longer short-circuits the record.
- `test/agents.test.ts` — 5 new cases (queue-operation, attachment, all-three-dedup,
  non-completed status still running, notification-free queue-operation ignored).
  Red before the fix on the three positive cases (`'running' !== 'done'`), green after:
  `Passed: 19  Failed: 0`.
- `test/agents-cache.test.ts` — absorbed records appended in 37-byte chunks still match
  the whole-file oracle: `Passed: 10  Failed: 0`.
- `pnpm test` → `ALL PASS`; `pnpm typecheck` clean.
- Live probe against the transcript from the report: the stuck agent now reads
  `done  general-purpose  872048ms  tok=146111  tools=71  ended 2026-08-31T21:34:50.023Z`.

Not verified: nothing exercised the browser UI — the running-row timer at
`client/src/components/SessionDetail.tsx:32` was never changed, and the claim that the
panel now flips to DONE rests on the server output alone.
