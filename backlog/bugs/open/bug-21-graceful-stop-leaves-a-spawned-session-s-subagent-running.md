---
id: bug-21
title: Graceful Stop leaves a spawned session's subagent running
created: 2026-09-09
tags: spawn, stop, server
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

unknown. Ruled out by the evidence above:

- **A restarted API.** `entries` is in-memory only, so a `tsx watch` restart between
  spawn and stop would drop the handle and make the session unstoppable. It didn't
  happen: the API process (pid 2017) had been up since 18:04:32, well before the 19:27
  spawn and the 19:31 stop, and there was only one dashboard instance listening.
- **A `'not-found'` answer.** The instance held the child handle, and the row still
  offered a Stop button, which the code only does for a session it can signal.

Candidates still open, in rough order of suspicion:

1. **The CLI defers SIGTERM until the current turn ends.** If `claude -p` installs a
   graceful SIGTERM handler that waits for the in-flight subagent, the ~50 s of continued
   work is explained — but then the +5 s SIGKILL should still have cut it short, so this
   alone is not sufficient.
2. **The escalation never fired.** `escalateStop` returns false silently on any of five
   conditions (entry missing, not `running`, no recorded request, grace not elapsed,
   child already dead). A stale/absent entry, or the entry having been deleted by the
   `launching` branch at `spawn.ts:810` (which SIGTERMs the *handle*, not the group, and
   removes the entry with no escalation armed), would both leave nothing to kill the
   process. Whether the entry was still `launching` at 19:31 is not recoverable from
   disk — worth logging.
3. **`unref()` on the escalation timer.** It cannot stop a timer from firing in a live
   process, so this should be innocent, but it is on the path and cheap to rule out.

Nothing on disk records the stop request, which is why the click time above is the user's
estimate rather than a measurement. Adding a line to the run log or a `stopRequestedAtMs`
readout on the API would make the next occurrence decidable in seconds instead of an hour.

## Fix

unknown. Directions the groom should weigh:

- Log the stop path — request time, resolved entry state, whether the signal was
  delivered, and whether the escalation fired — so a repeat is provable.
- Verify the escalation actually reaches SIGKILL when the child ignores SIGTERM, with a
  test using a real child that traps SIGTERM (the existing suite's fake children can't
  exercise this).
- Consider whether the UI should say more than `stopping…` once the grace has elapsed and
  the process is still alive — today the escalation is invisible, so a stop that silently
  fails looks identical to one in progress.
