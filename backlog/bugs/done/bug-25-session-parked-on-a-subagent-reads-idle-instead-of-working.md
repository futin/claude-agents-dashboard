---
id: bug-25
title: Session parked on a subagent reads idle instead of working
created: 2026-09-15
tags: dashboard, status, subagents
updated: 2026-09-23T08:56:17Z
groom-elapsed: 253
groom-tokens: 64296
started: 2026-09-23T08:43:56Z
execute-elapsed: 741
execute-tokens: 81280
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

The capture's leading hypothesis is wrong: sidechain records never reach the parent transcript. Subagents write their own file,
`<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`, and every record in it is `isSidechain: true`. Across every top-level transcript under
`~/.claude/projects/` on this machine, `grep -c '"isSidechain":true'` returns **0**. So `turnComplete` and `lastMessageTs` in `readTranscript`
(`server/lib/transcript.ts:405-411`) describe the parent's own thread only. They are accurate. The problem is that the status ladder
(`server/lib/scan.ts:581-589`) looks at nothing else, and a parent that is parked on a subagent writes nothing while it waits.

There are two parked shapes, and each one produces a different wrong colour:

- **Background agent: this is the `idle` in the title.** The launch `tool_result` is only an ack ("Async agent launched … agentId: <hex>", see the
  header of `server/lib/agents.ts`). The main thread then ends its turn with an assistant `stop_reason: 'end_turn'` record, and the real completion
  arrives later as a `<task-notification>` user record. From the parent file's point of view the turn is finished (`turnComplete = true`). The row
  therefore reads `incomplete` ("your turn") for `ACTIVE_WINDOW_MIN` and then `idle` (`turnComplete && !recent`, scan.ts:588) until the notification
  lands. The shape is observed on this machine for background `Bash` and `Monitor` parks, which use the same ack → `end_turn` → `<task-notification>`
  sequence. For example, `backlog-manager/4cd7c642…jsonl` has `end_turn` "Waiting on red proofs." at 08:36:22 and the notification at 08:38:52, with no
  parent message between them. No background *Agent* park survives in the local transcripts (all 3 `Agent` calls in the 400 newest are
  `run_in_background: false`). For agents, the shape comes from the documented protocol that `agents.ts` already parses, and it is not re-observed.
- **Foreground (sync) agent: the near-miss.** The parent's newest record is the assistant `tool_use` for `Agent`/`Task`, so `turnComplete = false`,
  which is correct. But `recent` goes false once the parent has been silent for `ACTIVE_WINDOW_MIN`. The ladder then falls through to `incomplete`
  ("stalled", yellow) for the rest of the subagent's run. This is observed in `claude-agents-dashboard/a6f5483e…jsonl`, where an `Agent` `tool_use` at
  20:43:42 is followed by its `tool_result` at 20:49:20 and nothing in between.

The liveness gate is not involved: a parked CLI process is alive and sits in the same cwd.

## Fix

Give the ladder one more piece of evidence: **a subagent of this session is still running**. Add it as a new arm directly after
`parsed.waitingOnQuestion` and before `recent && !parsed.turnComplete` (scan.ts:586-587). When the arm is true, the status is `working` (green). Put it
below `dead` and every `question` arm, so a dead process stays `idle` and a pending question or permission dialog still wins.

Compute it only when the ladder would otherwise land on `incomplete` or `idle`, because the other arms never need it. The computation is a new helper in
`server/lib/scan.ts`, for example `subagentRunning(parentFile, sessionId, nowMs): boolean`. It is `true` only when all three checks pass:

1. **A fresh subagent file.** Read `<dirname(parentFile)>/<sessionId>/subagents/` and stat each `agent-*.jsonl` (skip the `.meta.json` siblings). Keep
   only the files whose mtime is within `SUBAGENT_STALL_MS` of now, a named constant of **15 minutes**. The value must be longer than the Bash tool's
   maximum 10-minute timeout, so a subagent that is inside its longest possible single tool call still counts. If there is no directory or no fresh
   file, return `false` without parsing anything. This is the common case, and it costs one `readdir`.
2. **An unfinished subagent.** Parse each fresh file with the existing `readTranscript`. The subagent counts only when `hasMessages && !turnComplete`.
   A subagent that finished ends with an assistant `end_turn` record (verified on both files under `a6f5483e…/subagents/`), so a just-finished
   subagent is not counted during the moment before the parent records its result.
3. **The parent agrees a launch is still open.** Ask `readAgentsCached(parentFile)` (`server/lib/agents-cache.ts`) for the parent's jobs. Require at
   least one job with `status === 'running'`. This is the veto for an interrupted run. When the user presses Esc on a sync agent, the parent gets a
   `tool_result` for the launch, but the subagent file stops mid-turn with a fresh mtime. Without this check, that row would read `working` for up to
   15 minutes while it is actually the user's turn.

Check 3 is new use of the agents cache inside the 3s list poll. Today the `agents.ts` and `agents-cache.ts` headers and `server/api.ts:186` all say
that the cache is never used in the list poll. Checks 1 and 2 limit check 3 to sessions that have a subagent writing in the last 15 minutes, which is a
small subset of the `MAX_ENTRIES = 32` LRU. Update those three comments to name the new gated caller, instead of leaving them wrong.

Out of scope: a parent that is parked on a background `Bash` or `Monitor` task has the same `end_turn` shape and reads `idle` in the same way. It has
no subagent file and no reliable liveness signal: a background dev server never sends a notification, so "launched and not notified" would pin a row
green forever. Leave it alone here. Capture it as a separate item if it matters.

Docs: in `docs/subsystems/sessions.md` §"The status machine", add the new arm to the table and the prose, and state the 15-minute bound. Also correct
the "known imprecision" comment at `server/lib/scan.ts:260-266`, which claims `readTranscript` sees sidechains when it does not.

Test cases for `test/scan.test.ts`, with tmpdir fixtures: a parent `.jsonl` plus `<id>/subagents/agent-<hex>.jsonl`, `activeWindowMin: 5`,
`skipProcScan: true`, and the parent's newest message 6 minutes before `now` in every case:

- Background park: the parent ends with an async-ack `tool_result` (`toolUseResult.isAsync: true`, `agentId: "<hex>"`) followed by an `end_turn`
  record. The subagent file has mtime 1 min ago and ends with an assistant `tool_use`. Expect `working`. Today the result is `idle`.
- The same fixture after the parent receives a `<task-notification>` for `<hex>` with `<status>completed</status>`: expect `idle`.
- Sync park: the parent's newest record is an `Agent` `tool_use` with no result, and the subagent is fresh and unfinished. Expect `working`. Today the
  result is `incomplete`.
- The subagent file is fresh but ends with `end_turn`: expect `incomplete` for the sync park and `idle` for the background park. The ladder is
  unchanged.
- The subagent file is unfinished, but its mtime is 16 minutes old: the ladder is unchanged (the stall bound).
- Interrupt: the sync launch has a matching `tool_result` in the parent, and the subagent file is fresh and unfinished. Expect `incomplete`, not
  `working` (the check-3 veto).
- No `subagents/` directory at all: the result matches today's ladder exactly. This is the regression case for every existing fixture.
- `liveCwds` excludes the session's cwd while a fresh, unfinished subagent exists: expect `idle`, because the dead gate still outranks the new arm.

In the browser (playwright MCP tools): write a fixture tree under a scratch `HOME` (`<tmp>/.claude/projects/<dir>/<id>.jsonl` plus
`<id>/subagents/agent-<hex>.jsonl`, in the background-park shape above). Every record's `cwd` must be this session's own working directory, so that
the liveness probe finds a live `claude` process there. Stamp the parent's newest message 6 minutes ago, then `touch` the subagent file. Start the API
with `HOME=<tmp>` on a spare port and record its pid. Point Vite at that port, or use the prod build. Open the Sessions tab and find the fixture's row.
Its status dot must read `working` (green), not `idle`. Then append a completed `<task-notification>` for `<hex>` to the parent file, wait one poll
(3s), and check that the same row turns `idle`. Stop the API by the recorded pid.

## Outcome

2026-09-23. I confirmed the groomed cause against the current code. The status ladder in `scan.ts` read only the parent's own records, and a parent
parked on a subagent writes none while it waits. I added `subagentRunning(parentFile, sessionId, nowMs)` and `SUBAGENT_STALL_MS = 15 min` to
`server/lib/scan.ts`. The helper runs three checks, in the order the plan gave: a fresh `agent-*.jsonl`, that file mid-turn, and a `running` launch in
`readAgentsCached`. It is wired in as a `working` arm directly below `recent && !turnComplete`. That puts it below `dead` and every question arm, and it
runs only for a row the ladder would otherwise call idle or incomplete. The arm sits one rung *after* the plan's stated position rather than before it.
Both arms answer `working`, so the order cannot change a result, and this way the probe never runs on a row that is already green.

Deviation in one test case: for "after the parent receives a `<task-notification>`, expect `idle`", the fixture appends the notification **and** the
main thread's `end_turn` reply, both stamped 6 min old. A notification on its own is a user message, which is newest-message pending. With a 6-min stamp
that reads `incomplete` on today's ladder as well, so "expect idle" only holds once the parent has answered. The browser check used the same shape.

Verification:

```
$ npx tsx test/scan.test.ts | tail -1
Passed: 70  Failed: 0
$ pnpm test | tail -1
ALL PASS
$ pnpm typecheck
> tsc --noEmit        (exit 0)
```

The first full-suite run failed 1 case: `a near-miss path is not the rates endpoint — it falls through to the static handler`
(`test/api-usage-rates.test.ts`). The cause is environmental. That test needs `client/dist`, and this fresh worktree had no build. After `pnpm build` the
suite printed `ALL PASS`.

Browser: installed Chrome over CDP, because the playwright MCP's `chrome-for-testing` browser is not installed on this machine and the session did not
download one. The API ran with a scratch `HOME` in prod mode on port 4199, with a no-op `open` shim so no browser window popped up. The fixture was a
background park whose records carry this worktree's cwd, parent newest message 6 min old, and a touched subagent file. The Sessions row showed
`sdot working` / `spill working`. After appending the completed notification plus `end_turn` and waiting one poll, the same row showed `sdot idle`. The
subagent file was still fresh and mid-turn at that point, so the check-3 veto is what flipped it. The API and Chrome were stopped by their recorded pids.

Contract sweep: 5 sites updated (server/lib/scan.ts `lastMessageMs` "known imprecision" doc comment, server/lib/agents.ts header, server/lib/agents-cache.ts header, server/api.ts `serveSessionDetail` doc comment, docs/subsystems/sessions.md §"The status machine")
Red proof: 4 tests went red with the change reverted (removing the ladder arm reddens the background-park, background-completion and sync-park cases; replacing check 3 with `return true` reddens the background-completion and interrupt-veto cases; the stall, ended-turn, no-directory and dead-gate cases are regression guards that pass on both sides by design)
