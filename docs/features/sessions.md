---
docs-sync:
  sources:
    - server/lib/scan.ts
    - server/lib/transcript.ts
    - server/lib/agents.ts
    - server/lib/agents-cache.ts
    - client/src/components/SessionsView.tsx
    - client/src/components/SessionRow.tsx
    - client/src/lib/filterSort.ts
    - client/src/hooks/usePersistedState.ts
---

# Live session monitor

The default tab: one row per Claude Code session, refreshed every 3 seconds, sorted
most-recent-first. Everything is derived from the transcript files on disk.

## Per-session rows

- **Status dot** — one of four states (below).
- **Project + git branch** — real path from the transcript's `cwd`, plus its `gitBranch`.
- **Model + CLI version** — what the session is running.
- **Context bar + %** — current context tokens vs. the model's window (1M for
  Sonnet/Opus/Fable, 200k for Haiku and unknowns; override with
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). Turns orange/red as it fills.
- **Activity line** — the most recent tool call (e.g. `Edit server.ts`,
  `Task Explore: map the codebase`).
- **Relative time** — since the last conversational message.

## Session status (the left dot)

`question` (blue) overrides everything; otherwise a 2×2 of **recency** × **turn
finished**:

|                            | recent (< `ACTIVE_WINDOW_MIN`) | stale             |
|----------------------------|--------------------------------|-------------------|
| **pending** (no end_turn)  | 🟢 **working**                 | 🟡 **incomplete** |
| **finished** (end_turn)    | 🟡 **incomplete**              | ⚪ **idle**        |

- 🔵 **question** — the newest assistant action is an unanswered `AskUserQuestion` (or a
  [remote answer](remote-answers.md) is waiting). `ExitPlanMode` doesn't count.
- 🟢 **working** (pulsing) — machine actively churning. Only this state counts toward the
  header's active total.
- 🟡 **incomplete** — your turn to reply, or stalled mid-task.
- ⚪ **idle** — stale and finished cleanly.

Recency uses the last **conversational message** timestamp, not file mtime — merely
selecting a session in Claude Code appends metadata records that would otherwise flip an
idle session to working.

Two guards keep the dots honest:

- **Process-liveness gate:** an interrupted session can look "recent + pending" on disk
  forever, so the scanner asks `lsof` which directories have a live `claude` CLI process
  and forces sessions elsewhere to idle. Fail-open (no `lsof` → skipped) and auto-disabled
  in [Docker](../architecture/docker.md).
- **Empty-session filter:** a freshly `/clear`ed transcript with no real message yet is
  dropped — no phantom "pending" rows.

Full state machine + edge cases: [.claude/rules/session-status.md](../../.claude/rules/session-status.md).

## Expandable subagent detail

Click a row to expand it: the dashboard fetches `GET /api/sessions/:id` and lists the
subagents that session launched via the `Task` tool — type, description, running/done,
duration, tokens. Served by an incremental byte-offset cache so repeat opens stay cheap.

## Filter + sort toolbar

Client-side controls above the list: project, status, activity window, and sort
(recency / tokens / name / status, asc/desc). The selection is persisted to
`localStorage` (`dashboard.view`) so it survives refresh and tab-close — see
[.claude/rules/view-persistence.md](../../.claude/rules/view-persistence.md). Row
expansion is deliberately not persisted (session IDs churn).
