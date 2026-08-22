# How the dashboard tracks sessions and subagents

The dashboard never *connects* to the running Claude Code processes. There is no
socket, IPC, daemon, or hook. It is entirely passive: it reads the files each
session leaves on disk, plus one OS-level probe to tell which sessions are still
alive. This doc explains the mechanism end to end.

## The data source: transcript files on disk

Every Claude Code session continuously appends to a JSONL transcript at:

```
~/.claude/projects/<encoded-project-dir>/<session-uuid>.jsonl
```

Each line is one record — user messages, assistant messages (carrying token
`usage`, `model`, `stop_reason`), tool calls, and envelope metadata (`cwd`,
`gitBranch`, `version`, `timestamp`). The dashboard only *reads* these files; it
never writes to them and never talks to the CLI. The poll runs every 3s
(`GET /api/sessions`).

So the honest one-liner: **it tails the transcript each session writes, and uses
`lsof` to check which sessions still have a live process behind them.**

## Two read paths, on purpose

There are two distinct reads with very different cost/completeness tradeoffs.

### 1. The 256KB tail — current state, every poll (`server/lib/transcript.ts`)

`readTranscript` reads only the **last 256KB** (`DEFAULT_TAIL_BYTES`) via
`readTail` (open + seek to `size - tailBytes`), then scans that slice
**newest-record-first**, taking the first value it finds for each field and
breaking out early once it has them all.

This is deliberate: everything the poll displays is **current state**, which by
definition lives at the *end* of the file:

- **tokens / model** — from the newest record with a `usage` block.
- **activity** — the newest `tool_use` block (`describeTool` labels it).
- **turn state** — `turnComplete`, `waitingOnQuestion`, `lastMessageTs`, all from
  the newest conversational (user/assistant) message record.
- **cwd / gitBranch / version** — Claude Code stamps these on essentially *every*
  record, so they always appear in the tail no matter how old the session is.

For the poll, the tail is a **recency window, not a history window**. Older data
isn't "missed" — it's irrelevant to a live status view.

**Known tail edge cases** (self-correcting in practice):
- If the last 256KB contains no record with a `usage` block — e.g. a single
  `tool_result` or pasted user message larger than 256KB sits at the very end —
  then `tokens` reads `0` / `model` reads `''` and context% shows 0 until the next
  assistant turn writes fresh usage.
- If a single JSONL line exceeds the tail, its leading fragment is discarded
  (`first = tail.truncated ? 1 : 0`).

### 2. The whole-file walk — subagents, on demand (`server/lib/agents.ts`)

Tracking the subagents a session launched cannot use a tail, because a launch and
its completion can be arbitrarily far apart in the file. So `readAgents` does
`fs.readFileSync` of the **entire** transcript and runs **on demand** — only when
a session is selected in the UI, never in the 3s poll loop.

A subagent is launched with the `Task` tool (stock Claude Code) or `Agent` tool
(some harnesses); both carry a `subagent_type` (`isAgentLaunch` also falls back to
that field so a rename still matches). There are two completion patterns:

- **Synchronous** — the assistant `tool_use` (id `toolu_…`) is answered by a user
  `tool_result` with the matching `tool_use_id`. That result *is* the output;
  the use→result timestamps give the real duration.

- **Background / async** — the immediate `tool_result` is only a launch ack
  (`"Async agent launched successfully. agentId: <hex>"`), **not** completion.
  The real end arrives later as a `<task-notification>` user message keyed by that
  `<hex>` agentId (not the `tool_use_id`), carrying `<status>completed</status>`.
  The code parses the `agentId` from the ack and pairs it with the notification's
  `<task-id>` to compute the true duration.

An unmatched launch (no result, no notification) reads as `running` with null
end/duration. Results are returned newest-first.

**Key subtlety — completions are not in launch order.** A `Task` launched early
can finish late (via a downstream notification) *after* a later job has already
completed. This is exactly why `agents.ts` walks the whole file rather than
stopping at the last finished job. See `docs/ideas/agent-tracking-cache.md` for
how an incremental cache would have to respect this.

Note there is **no separate process** for a subagent: a `Task`/`Agent` subagent
runs inside the parent session's `claude` process and writes into the parent's
transcript. That's why everything is derived from the parent transcript alone,
and why there's no per-subagent `.jsonl` or `lsof` entry.

## Enumerating and ranking sessions (`server/lib/scan.ts`)

`scanSessions` ties it together:

1. `listTranscripts` walks every `.jsonl` under the projects root.
2. Filter to files touched within `lookbackHours` (default 24h), sort by mtime,
   keep the top `maxSessions` (default 5).
3. `readTranscript` each survivor; drop any with `hasMessages === false` (a just
   started or just `/clear`ed session holds only meta/queue records and would
   otherwise show a phantom "pending" row).
4. Compute `status` (see below) and assemble the typed `Session` list.

## Session status (the left dot)

Computed in `scan.ts` from `transcript.ts` signals. `question` overrides
everything; otherwise it's a 2×2 of `recent` × `turnComplete`:

|                          | recent (< `activeWindowMin`) | stale           |
|--------------------------|------------------------------|-----------------|
| **pending** (no end_turn)| 🟢 working                   | 🟡 incomplete   |
| **finished** (end_turn)  | 🟡 incomplete                | ⚪ idle          |

- **question** (blue) — newest assistant action is an unanswered
  `AskUserQuestion`. Beats all.
- **working** (green) — recent AND the turn is unfinished. Only this counts toward
  `totals.active`.
- **incomplete** (yellow) — recent + finished (your turn) OR stale + pending
  (stalled).
- **idle** (gray) — stale AND finished.

"recent" uses the newest **message** timestamp (`lastMessageTs`), **not** file
mtime — selecting a session appends timestamp-less mode/last-prompt/custom-title
records that bump mtime without a turn happening.

## The one place it touches the process: `lsof` liveness gate

Reading files alone has a blind spot: a killed/interrupted session's last record
often has no `end_turn`, so on disk it looks "recent + pending = working" forever
even though nothing runs.

`scan.ts` `liveCwds()` shells out to:

```
lsof -c claude -a -d cwd -Fn
```

This asks the OS for the working directory of every running process named
`claude`. Any session whose transcript `cwd` isn't in that live set is forced to
`idle` — the process is gone, so it can't be working.

- Still not a real connection — it inspects the OS process table, never talks to
  the CLI.
- `-c claude` is case-sensitive → matches the lowercase CLI binary, not the
  `Claude.app` desktop shell.
- **Granularity is per-cwd** (claude doesn't hold the `.jsonl` open and exposes no
  session id in argv/env), so two sessions in the same directory can't be told
  apart — a dead one there still reads live.
- **Fail-open**: `null` (no lsof / timeout / error) skips the gate rather than
  mislabeling everything dead. Injectable via `ScanOptions.liveCwds` for tests;
  `skipProcScan` also disables it.

`countClaudeProcesses()` (via `ps`) is a separate informational cross-check number
in the response, not used for status.

## Why it's built this way

The design goal is **no daemon, no hooks**. Claude Code exposes no live API or
event stream for external monitors, but it *does* leave a rich append-only
transcript on disk as a side effect. So the dashboard treats those transcripts as
the source of truth and reads them passively. The only thing a file can't tell you
— "is this process still alive?" — it recovers from the OS via `lsof`, without
ever coupling to the CLI.
