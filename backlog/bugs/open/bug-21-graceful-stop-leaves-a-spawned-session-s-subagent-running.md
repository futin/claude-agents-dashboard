---
id: bug-21
title: Graceful Stop leaves a spawned session's subagent running
created: 2026-09-09
tags: spawn, stop, server
updated: 2026-09-10T20:11:53Z
groom-elapsed: 629
groom-tokens: 105246
---

## Symptom

Clicking **Stop** (the graceful button, *not* force stop) on a dashboard-spawned session
returns and the row goes to `stopping…`, but the session keeps working. The subagent it
had in flight went on issuing tool calls — real ones, with side effects: `Bash`,
`node -e`, file reads — for about 50 seconds after the click, and the CLI process itself
stayed alive and kept writing to its transcript for about two minutes after it. Nothing
finished it off: `STOP_GRACE_MS` is 5 s, so the SIGKILL escalation should have ended the
process roughly 5 s after the click, and it did not.

The user's read from the UI was "I stopped the session but the subagent carried on",
which is exactly what happened.

Observed once, on 2026-09-09, against session `e9f8759d-601a-4379-88de-49da5de97b12`
(cwd `~/custom-projects/guide-manager`, headless `sdk-cli` spawn, CLI 2.1.266). Evidence
from disk:

| Time (local) | Event | Source |
|---|---|---|
| 19:27:13 | session's first transcript row — spawn adopted well before the stop | parent transcript |
| 19:31:25 | parent calls `Agent` (`subagent_type: general-purpose`, `run_in_background: false`) | parent transcript, last content row |
| 19:31:27 | subagent transcript + meta created (`requestShape: "foreground"`) | `…/e9f8759d…/subagents/agent-a5094a80ba5102782.meta.json` |
| ~19:31:30 (user's click, approximate) | graceful Stop pressed from the dashboard | user report |
| 19:31:27 – 19:32:18 | subagent runs ~25 tool calls; the **grandchildren succeed** — a `node -e` returns `function function` at 19:32:18 | subagent transcript, 77 rows |
| 19:33:51 | parent transcript's last write (a `last-prompt` flush row) | `stat` on the parent `.jsonl` |
| after that | process gone; branch `feat/favorites` still at `71ded02d`, no repo file written after 19:31 | `ps`, `find -newermt` |

The grandchildren surviving is the load-bearing detail. `signalGroup` targets `-pgid`, so
a delivered SIGTERM would have taken the subagent's `bash` and `node` children with it.
They kept spawning and exiting 0 for another ~50 s, so the group signal never landed on
that group — or landed and was ignored, with the escalation never arriving either.

A second, smaller defect fell out of the same investigation: the parent transcript ends
on an unresolved `Agent` `tool_use` with **no `[Request interrupted by user]` row and no
`tool_result`**. Other sessions interrupted the ordinary way that day do carry that row
(e.g. `953b9f07…` at 15:37:24). A stopped spawn is therefore indistinguishable on disk
from a session that crashed mid-tool-call, which is also what makes this bug hard to
confirm after the fact.

## Repro

Not yet reduced to a reliable recipe — this is a single observation, and the timing of
the click relative to the subagent dispatch may matter. What was done:

1. Spawn a session from the dashboard (`POST /api/spawn`) that will dispatch a
   foreground subagent — e.g. any `backlog-execute` / subagent-driven-development run.
2. Wait until the session is adopted (`running`, not `launching`) and has an `Agent`
   call in flight with `run_in_background: false`.
3. Click **Stop**, without force.
4. Watch `~/.claude/projects/<project>/<id>/subagents/agent-*.jsonl` — under the bug it
   keeps gaining tool-call rows past the click, and the CLI process stays in `ps` well
   past `STOP_GRACE_MS`.

Worth trying both with the click during the subagent's turn and with it during a
parent-owned tool call, since only the first case was seen.

## Affects

- `server/lib/spawn.ts:806` — `stopSession`, the graceful path.
- `server/lib/spawn.ts:823` — `signalGroup(entry.child, 'SIGTERM')`.
- `server/lib/spawn.ts:827` — the armed escalation, `setTimeout(…, STOP_GRACE_MS)`, `unref()`ed on the next line.
- `server/lib/spawn.ts:455` — `STOP_GRACE_MS = 5_000`.
- `server/lib/spawn.ts:863` — `escalateStop`, and the five conditions it silently returns false on.
- `server/lib/spawn.ts:336` — `signalGroup`, including `signalablePid`'s liveness gate.
- `server/lib/spawn.ts:761` — `adoptLaunched`, which decides whether the stop takes the group path at all.
- `client/src/hooks/useStopSession.ts:35` — the client call, `{ force: false }`.
- `client/src/lib/stopControl.ts:26` — the arm/force button state the UI shows afterwards.

## Cause

Not pinned to one line, but the search space is now small — and two of this item's own
inferences are wrong. What the evidence forces:

**The graceful path did run.** `stopping…` is not an optimistic client state. The badge
comes from `s.stopState`, which the server computes in `stopStates()`
(`server/lib/spawn.ts:882`) as `stopRequestedAtMs === undefined ? 'ready' : 'stopping'`;
`stopControl` (`client/src/lib/stopControl.ts:55`) only renders it, and `SessionRow`
keeps no local stop state. Seeing that badge therefore proves the entry was `running`,
`signalablePid` was non-null, the SIGTERM branch of `stopSession` executed, and the
escalation timer was armed. That kills candidate 2's `launching` sub-case: that branch
deletes the entry, so the Stop control would have vanished rather than shown a badge.

**SIGKILL never reached the process.** SIGKILL cannot be caught or deferred, and the CLI
went on writing for ~2 min. So the escalation did not deliver — it either never fired, or
fired at a group the CLI was no longer in.

**The CLI does not defer SIGTERM — candidate 1 is out.** Measured twice on this machine,
2026-09-10, spawning `claude -p` exactly as `launch` does (`detached: true`,
`stdio: ['pipe','ignore','pipe']`, prompt on stdin, CLI 2.1.x) and then
`process.kill(-pid, 'SIGTERM')`: the CLI exited **code 143 in 0.74 s and 0.89 s**, taking
its in-group MCP servers (codegraph, playwright-mcp — both pgid == CLI pid) with it. A
delivered SIGTERM ends this CLI in under a second, so 50 s of continued subagent work is
not deferral; it is a signal that never arrived.

**The "load-bearing detail" does not hold.** "The grandchildren survived, so the group
signal never landed" assumes every descendant shares the CLI's group. It does not: in the
same probe, `bash ~/.claude/hooks/stop-notify.sh` ran at **pgid 35228 while the CLI's
group was 35041** — Claude Code spawns at least its hook runners detached, in a group no
`kill(-pgid, …)` reaches. Surviving grandchildren are therefore consistent with the signal
landing, and prove nothing on their own. (MCP servers do share the group, so those would
be evidence.) The 19:33:51 "last write" is weak for the same reason in reverse: probe 1's
CLI lingered **54 s after its final assistant message** before it was signalled — `claude
-p` routinely outlives its own turn.

That leaves three structural defects, and they are the reason this is both possible and
undiagnosable after the fact:

1. **`signalGroup` cannot fail** (`server/lib/spawn.ts:335`). It swallows every
   `process.kill` error — `try { kill(-pid, signal); } catch { }` at `:342` — and returns
   `true` unconditionally. ESRCH (no such group), EPERM and an actually-delivered signal
   are indistinguishable to every caller. `stopSession` records the request and shows
   `stopping…`, and `forceStopSession` answers `'stopped'`, for a signal that may have
   gone nowhere. The doc comment justifies the swallow as an ESRCH race ("the process the
   user asked to stop is gone") — true for a dead child, false for a live one, which is
   exactly this bug's fingerprint.
2. **The escalation is one-shot and silent** (`spawn.ts:827` arms it, `spawn.ts:863`
   answers it). One `setTimeout`, no retry, no log, no state change on refusal. A single
   false return from `escalateStop` means SIGKILL never happens again — ever — while the
   row keeps saying `stopping…`. Two of its five refusals are reachable with the child
   alive:
   - `entry.state !== 'running'`. `fail()` (`spawn.ts:563`) sets `state = 'failed'` on
     whatever entry it finds, with no guard against a `running` one, and the
     `stdin`/`stderr` stream `'error'` handlers call it (`spawn.ts:654`, `spawn.ts:664`).
     A stream error on a live, already-SIGTERMed session converts it to `failed`, which
     disarms the escalation *and* makes every later `stopSession` answer `'not-found'`.
   - `now - entry.stopRequestedAtMs < STOP_GRACE_MS`. A wall-clock (`Date.now()`)
     comparison gating a monotonic (libuv) timer; a backwards clock step inside that 5 s
     window refuses permanently. Plain early firing is *not* the explanation — measured
     here on Node v26.4.0, 550 timers across 50 ms and 5000 ms batches, 0 fired early,
     min delta exactly 5000 ms, and the guard is `<`, so the boundary passes.
3. **Nothing is written down.** No log line, no `stopRequestedAtMs` anywhere in the API
   response. The only discriminator left for the next occurrence is the UI, because
   `stopStates()` skips non-`running` entries: if the whole Stop control **disappears**,
   `fail()` flipped the entry to `failed`; if the `stopping…` badge **persists** with a
   live process, the entry stayed `running` and the refusal was the grace check or a
   swallowed `kill` error.

Ruled out as the item already had it: an API restart (pid 2017, up since 18:04:32) and a
`'not-found'` answer. Newly ruled out: a production `setGroupKiller` override — that seam
is installed only from `test/spawn.test.ts` and `test/spawn-endpoint.test.ts`, never by
server code. Candidate 3 (`unref()`) is innocent: an unref'd timer still fires in a
process kept alive by a listening socket, and the two measured batches above show the
timer itself is accurate.

The item's second, smaller defect — the missing `[Request interrupted by user]` row — is
the CLI's own transcript behaviour on SIGTERM, not something this server writes. Out of
scope for the fix below; worth re-checking once a stop provably lands, since a SIGTERM
that never arrived cannot have written an interruption row either.

## Fix

Five changes. The first three are the fix; 4 and 5 are what make a repeat provable and
what would actually have caught this. All server work is in `server/lib/spawn.ts`.

1. **Make signal delivery knowable.** Change `signalGroup` to report what happened
   instead of always `true` — e.g. `'delivered' | 'no-such-group' | 'error'`, keeping the
   `signalablePid` refusal as its own answer. Update the three call sites:
   - `stopSession` (`:806`): on a non-delivery **while `childAlive(child)` is still
     true**, do not silently claim `'stopping'` — record the failure on the entry and
     surface it (see 3). ESRCH against a live child is the impossible case and must be
     loud.
   - `forceStopSession` (`:843`): must not answer `'stopped'` for a `kill` that threw.
   - `escalateStop` (`:863`): same, and feed the retry in 2.

   Keep the ESRCH-is-fine swallow only where it is actually true: the child is already
   dead. The security invariant at `:318` (`pid > 1`, never a request-supplied pid) does
   not change.

2. **Make the escalation persistent instead of one-shot.**
   - Re-arm rather than give up: while the child is alive and a stop is outstanding,
     retry the SIGKILL on a bounded schedule (~1 s, capped at ~30 s from the request)
     instead of the single `setTimeout` at `:827`. `dropIfRunning` (`:528`) already
     clears the timer on exit, which stays the normal exit path.
   - Stop mixing clocks: drop the redundant elapsed re-check inside the timer callback
     (the timer *is* the grace), or measure it with `process.hrtime.bigint()`. Keep the
     explicit `now` parameter — the suite depends on it.
   - Decide the `failed`-with-a-live-child hole deliberately. Preferred: `fail()` must
     not demote a `running` entry — a stream error on an adopted session is not a launch
     failure. If that is judged too broad a change, `escalateStop` must escalate for a
     `failed` entry that still has a live child, since that state is precisely the
     un-killable one.

3. **Say so in the UI.** Add a third `StopState` to `shared/types.ts` (contract first,
   per the repo rule) — e.g. `'stop-failed'` — set once the grace has elapsed and the
   child is still alive, or immediately on a non-delivery against a live child. Render it
   in `stopControl` (`client/src/lib/stopControl.ts`) as its own badge text with `force
   stop` still offered; a silently failed stop must stop looking identical to one in
   progress. `stopStates()` (`:882`) must include those entries even if the `fail()`
   change in 2 is not taken.

4. **Log the stop path.** One line per stop at request, at signal (with the delivery
   result and the pgid), at each escalation attempt with its refusal reason, and at exit.
   `console.warn` in the server's existing style — no dependency, and the next occurrence
   becomes decidable in seconds instead of an hour.

5. **Tests.** Every current stop test drives `escalateStop(id, explicitNow)` directly with
   a fake child and an installed `setGroupKiller`, so none of them can see any of the
   above. Add, in `test/spawn.test.ts`:
   - a `groupKiller` that throws `ESRCH` → `stopSession` and `forceStopSession` must
     report the failure, not `'stopping'`/`'stopped'`;
   - an entry flipped to `failed` (or one whose stream `'error'` handler fired) after a
     stop request, child still alive → the escalation must still kill it;
   - the armed timer itself firing, not just the function called by hand — the one-shot
     behaviour is invisible to a direct call;
   - one **real child**: a small script (`node -e` or a shell script under `test/`)
     spawned `detached` that traps and ignores SIGTERM, then assert it is gone within
     `STOP_GRACE_MS` + slack. The fake children cannot exercise signal semantics at all,
     and this is the only shape of test that would have caught the whole class.

   Mutation-prove each one: revert the corresponding fix and confirm the test goes red.

`docs/subsystems/spawn.md` documents `STOP_GRACE_MS` and the escalation and will need the
new state and retry described.

Verification is server-side and can be done entirely by `pnpm test` + `pnpm typecheck`;
the one thing that needs the real UI is the new badge.

In the browser (playwright MCP tools): with the dashboard running (`pnpm dev`,
http://localhost:5174), `POST /api/spawn` a short-lived session in a scratch cwd, wait for
its row to appear on **Sessions**, expand the row, click `stop session` then `really
stop?`, and confirm the row shows the `stopping…` badge and then leaves the list within
~10 s. Then force the failure surface — with the escalation neutered in the worktree
(temporarily make `signalGroup` report non-delivery) repeat the same click and confirm the
row shows the new stop-failed badge rather than a permanent `stopping…`, with `force stop`
still offered. Restore the neutered line before committing.
