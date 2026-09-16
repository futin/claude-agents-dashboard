---
id: bug-25
title: Session parked on a subagent reads idle instead of working
created: 2026-09-15
tags: dashboard, status, subagents
---

## Symptom

A session that is genuinely working — it has dispatched a subagent via the `Task` tool and is parked waiting for that agent to
finish — shows on the board as **idle** (gray). Nothing is wrong with the session: the CLI is live, the subagent is churning, and
the row will flip back to `working` once the subagent returns and the main thread resumes. For the length of the subagent's run,
which can be many minutes, the dashboard reports the opposite of what is happening. Expected: the row stays `working` (green)
for as long as the parent is blocked on a dispatched agent.

## Repro

1. In any session under `~/.claude/projects/`, dispatch a subagent (`Task` / the Agent tool) that runs for longer than
   `ACTIVE_WINDOW_MIN` (default 5 min).
2. Watch that session's row on the dashboard while the subagent works.
3. The row reads `idle` rather than `working`.

## Affects

- `server/lib/scan.ts:584-589` — the status ladder; `working` requires `recent && !parsed.turnComplete`, and `idle` is the
  `turnComplete && !recent` arm.
- `server/lib/transcript.ts:405-411` — `turnComplete` is decided by the **newest** conversational record of either role, with no
  sidechain filter, so a subagent's own `stop_reason: 'end_turn'` message sets it on the parent.
- `server/lib/scan.ts:544-546` — `recent` is derived from `lastMessageTs`, which likewise counts sidechain records.
- `server/lib/scan.ts:260-266` — existing doc comment already records that `readTranscript` does not filter sidechains, as a
  known imprecision of the `permissionWait` gate.

## Cause

unknown — not yet confirmed. Leading hypothesis, to be proved or discarded at groom time: while a subagent runs, the newest
record in the transcript is a **sidechain** assistant message. `readTranscript` does not distinguish sidechains, so:

- that message's `stop_reason === 'end_turn'` sets `turnComplete = true` on the parent (transcript.ts:410), even though the
  parent's own turn is very much open (its last block is a `tool_use` for `Task`); and
- once the subagent goes quiet for longer than the active window — a single long tool call inside it — `recent` goes false too,
  and the ladder lands on `idle` (scan.ts:588).

If that is right, the near-miss variant is also worth checking: while the subagent *is* writing, `recent` is true and
`turnComplete` is true, which falls through to `incomplete` (yellow, "your turn") — also wrong, and the same root cause.
A second candidate to rule out: whether background/dispatched agents write into the parent transcript at all, or into their own
file — the answer changes which of the two fields is actually lying.

## Fix

unknown
