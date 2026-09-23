---
id: bug-28
title: Graceful Stop leaves a spawned session's subagent running
created: 2026-09-09
tags: spawn, stop, server
updated: 2026-09-22T21:07:49Z
groom-elapsed: 508
groom-tokens: 97461
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

**The SIGKILL escalation can be silently vetoed by its own guard, and nothing ever retries it.** `stopSession` records `stopRequestedAtMs` from the wall
clock (`Date.now()`) and arms a one-shot `setTimeout(…, STOP_GRACE_MS)` (`server/lib/spawn.ts:822-828`). When that timer fires, `escalateStop(id)` reads the
wall clock *again* and refuses unless `now - stopRequestedAtMs >= STOP_GRACE_MS` (`spawn.ts:867`). Node's timers run on the libuv monotonic loop clock, not on
`Date.now()`, so whenever the wall clock reads even slightly ahead of the timer at fire time — a timer firing a few ms early relative to `Date.now()`, or a
wall-clock step, which WSL2 does routinely when it resyncs with the host — the guard returns false. The timer is never re-armed, a repeated graceful click
returns `'stopping'` without re-signalling (`spawn.ts:816`), and `stopStates()` keeps reporting `'stopping'`. The row then says `stopping…` forever and only
**Force stop** ends the process. The existing tests call `escalateStop(id, at + STOP_GRACE_MS)` with hand-picked times (`test/spawn.test.ts:969-1039`) and
never exercise the armed timer, which is why the suite is green.

Proven on 2026-09-22 against the real `spawn.ts`, with a real child that ignores SIGTERM (`bash -c 'trap "" TERM; while :; do sleep 1; done'`), adopted, then
stopped with `stopSession(id, Date.now() + skew)` to model the wall clock reading ahead of the timer:

| skew | child 6.5 s after the stop (grace is 5 s) |
|---|---|
| 0 ms | dead — escalation fired |
| 20 ms | **still alive** — escalation vetoed, never retried |
| 500 ms | **still alive** |

Timer early-fire is real on this machine as well: 3 of 180 `setTimeout(fn, 200)` trials fired with `Date.now() - t0` below 200 (197 and 199 ms).

**The CLI is not the problem.** Probed four times on 2026-09-22 with a dashboard-shaped spawn (`detached: true`, `-p --session-id …`, prompt on stdin),
sending SIGTERM to `-pgid` mid-work: CLI 2.1.280 with a main-thread `Bash` (`sleep 25`) in flight exited in 717 ms, and no `sleep 25` survived it; 2.1.280
with a foreground subagent in flight, 433 ms; CLI 2.1.266 (the incident's build, plus `-n <name>`) with a foreground subagent mid-`Bash`, 655 ms with
`--remote-control <name>` and 717 ms without. All four exited with code 143, and none ran another turn after the signal. That rules out the
capture-time suspect "the CLI defers SIGTERM until the turn ends". The other one, `unref()` on the timer, is ruled out too: the drop above reproduces with the
timer firing on schedule. Also checked: `claude -p` runs each `Bash` tool call in its own
session (`ps` shows the tool's `bash` with `pgid = sid = its own pid`, not the CLI's). A group signal therefore never reaches tool processes directly — the
CLI reaps them itself on SIGTERM.

**The incident timeline, re-read.** The report's click time (~19:31:30) is a user estimate, and it does not fit the transcripts. The subagent transcript's
last rows are a `tool_result` at 17:32:18.255Z and a `total_tokens_reminder` at .264Z. Then the rows stop mid-turn, with no next API call. That is exactly
what a SIGTERM abort looks like in the probes. So SIGTERM most likely landed at ~19:32:18 local, and the "50 s of continued work" is the gap between the
estimate and the real click. After the abort the process stayed alive until at least 19:33:51, when it wrote a `last-prompt`/`custom-title`/`agent-name`/
`atis-latch` flush block. A SIGKILL at +5 s would have made that write impossible. So the SIGTERM was delivered, the CLI's shutdown ran long (the ~90 s exit
hang already seen with `claude -p` on another machine), and **the escalation did not fire** — the one part of this that is the dashboard's. No
server restart explains it: `git reflog` has no checkout, merge or reset between 19:20 and 19:45 that day, and no transcript on this machine shows an edit to
this repo in 17:29-17:36Z, so `tsx watch` had no reason to restart and drop the entry. The vetoed-guard path above is the only way the code can lose an
armed escalation on a live child. It is proven to happen, though it cannot be proven after the fact for that one click, because nothing records the stop.

Two corrections to the Symptom: the parent transcript no longer ends on the unresolved `Agent` call. The session was resumed at 19:42:26 ("cancel this task,
I don't want to proceed…") and answered. And the missing `[Request interrupted by user]` row is the CLI's own SIGTERM behaviour — the probe transcripts end
the same way — so there is nothing in this repo to change about it.

## Fix

Server-only, all in `server/lib/spawn.ts`, no API or client change:

1. **The armed timer must not be vetoable by the wall clock.** Its firing *is* the evidence that the grace elapsed. When arming it in `stopSession`, compute
   the due time from the same `now` that became `stopRequestedAtMs` (`now + STOP_GRACE_MS`), and have the callback pass that value to
   `escalateStop(id, due)`. The wall clock is then never read a second time. `escalateStop(id, now)` keeps its signature and its guard, so the direct-call
   tests at `test/spawn.test.ts:969-1039` stay valid, and the other guards (entry gone, not `running`, child dead) still protect against SIGKILLing a pgid
   that may have been reused.
2. **Add a backstop that does not depend on one timer.** In `stopStates()`, which the sessions poll runs every 3 s (`server/api.ts:151`), call
   `escalateStop(id)` for any entry that is `stopping` and still alive. Any lost escalation — this bug or a future one — then finishes on the next poll.
   `listLaunching` already does lazy state work on the same poll, so this follows the store's existing "expiry is lazy" charter. Once a real SIGKILL has
   landed, `signalablePid` or the exit handler makes the call a no-op.
3. **Make the stop path provable next time.** Log one `console.error('[dashboard] …')` line (the server's only logging convention) when a graceful stop
   signals a group (id, pid) and one when an escalation fires or is refused (id, the reason). A repeat is then decidable from the dev-server output
   instead of from transcript forensics.

Test cases for `test/spawn.test.ts`, each with a **real** child that traps SIGTERM (`bash -c 'trap "" TERM; while :; do sleep 1; done'` through
`setSpawner`), waiting ~300 ms after spawn so the trap is installed before the signal. Keep the default `groupKiller` — the fake one cannot prove a kill.
Kill any survivor by its recorded pid in a `finally`:

- `stopSession(id, Date.now() + 500)` (wall clock ahead of the timer): the child is dead within `STOP_GRACE_MS + 1500` ms. It stays alive today, so this is
  the red proof. Mutation-prove it: revert item 1 and the test must fail.
- `stopSession(id)` with no skew: the child is dead within `STOP_GRACE_MS + 1500` ms (regression guard for the ordinary path).
- Backstop: arm a stop, clear the armed timer to simulate a lost escalation, then call `stopStates()` with the entry past its grace. The child dies, and
  `stopStates()` no longer lists the id once the exit handler has run. Also: `stopStates()` inside the grace sends no SIGKILL (child still alive).

No browser check: the failure needs a child that survives SIGTERM *and* a clock skew between two server reads, and a Playwright session can produce
neither. The server test above is the proof. What a human can confirm afterwards: with a spawned session whose CLI hangs on exit, the row's `stopping…`
badge clears within ~5-8 s of a graceful Stop, without pressing Force stop.
