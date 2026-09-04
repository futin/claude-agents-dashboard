---
id: idea-9
title: Stop a running spawned session
created: 2026-08-28
tags: spawn, server, client
updated: 2026-09-04T21:15:19Z
promoted-to: task-19
groom-elapsed: 222
---

## Problem

Once a dashboard-spawned session has been adopted, there is no way to stop it.
`POST /api/spawn/:id/stop` exists, but it only reaches a **pre-adoption** launch —
roughly the first 3 seconds. `adoptLaunched` (`server/lib/spawn.ts:532`) then deletes
the store entry, and with it the only `ChildProcess` handle the server ever held. From
that moment the process is unreachable.

For a headless `claude -p` this is the whole gap: it is detached, there is no terminal
attached to it, so there is no Ctrl-C to fall back on. A spawned session that loops,
stalls, or was launched with the wrong prompt runs to completion or to its own limits.

Nothing on disk closes the gap either — a full key scan of a live transcript turns up no
`pid` and no process field of any kind, so the server cannot rediscover a session's
process after the fact.

Scope decision (2026-08-28): **dashboard-spawned sessions only**. Terminal-started
sessions are explicitly out — see Open questions.

## Rough shape

**1. Keep the `ChildProcess` handle past adoption.** Change `adoptLaunched` to
*transition* the entry `launching -> running` rather than delete it. Delete it on the
child's `exit` event (already wired, `spawn.ts` ~:486) or on TTL.

Holding the live handle rather than a bare pid is the load-bearing choice: it removes
the PID-reuse hazard outright. `child.kill()` on an already-exited child is a no-op, and
the `exit` listener clears the entry, so the server can never signal a recycled pid.

**2. Graceful stop, reusing machinery that already exists.** A spawned session ends its
turn -> hits `stop-notify.sh` -> `messages.ts` holds the wait up to 630s for a reply.
So: set a stop flag on the entry, and resolve any held wait with a `stop` verdict instead
of a reply. The hook exits without injecting a prompt, the turn ends, and headless
`claude -p` exits on its own. No signal, clean transcript.

**3. Hard fallback for mid-turn.** A session deep in a tool call has no Stop hook
pending, so the flag just sits. After a grace window (setting, default ~30s) escalate to
`process.kill(-child.pid, 'SIGTERM')`. Negative pid on purpose: `detached: true` already
put the child in its own process group, so the whole tree goes — bash tools, MCP servers
— not just the CLI. SIGKILL after a second grace. Negate only while the handle reports
the child live.

**Surfaces**

| Boundary | Change |
|---|---|
| `shared/types.ts` | `stoppable: boolean`, `stopState?: 'stopping'` on the session row |
| `server/lib/spawn.ts` | entry survives adopt; `requestStop(id)`; escalation timer |
| `server/lib/messages.ts` | held Stop wait resolvable with a `stop` verdict |
| `server/api.ts` | fold into one `POST /api/session/:id/stop` `{force?}` — pre-adoption path keeps today's immediate SIGTERM, post-adoption gets graceful-then-hard. Two endpoints behind one button is the wrong seam. |
| `client/` | Stop button on `stoppable` rows only, confirm dialog, "stopping…" badge, "Force stop" once grace elapses |

**Security rule, load-bearing.** Only ever signal a process the server itself spawned and
still holds a handle to. Never a pid from a request body, never one found by scanning
`ps`. This is the same write-path surface as spawn, so it takes the same origin check
(`origin.ts`) and the same config gate.

**Known limitation, stated up front.** RAM-only, like `pending.ts`. Restart the API and
every spawned session goes unstoppable again as a detached orphan. Persisting pids to
disk would buy restart-survival but would reintroduce exactly the PID-reuse hazard the
handle-based design avoids.

**Test cases** (existing `setSpawner` fake plus the kill spy already in the suite):
escalation timer fires after grace; kill-after-exit is a no-op; 404 for a session the
server did not spawn; graceful path never signals; pgid negation guarded on liveness.
Mutation-prove each guard — delete the guard, the test must go red.

## Open questions

- **Grace window default.** ~30s is a guess. Too short kills real mid-turn work; too long
  and "Stop" doesn't feel like stopping. Might want it per-launch rather than global.
- **Terminal-started sessions.** Deliberately out of scope, but they are the case that
  bites when you are on your phone with no terminal to reach. Closing it needs a
  session->pid registry that does not exist: a new `SessionStart` hook writing
  `{sessionId, pid, cwd}` to a state file the server reads. Worth its own idea if the
  spawned-only version proves useful.
- **Restart survival.** Is an unstoppable orphan after an API restart acceptable in
  practice, or does it need a reaper (e.g. kill spawned children on server shutdown)?
- **Does `claude -p` exit cleanly when the Stop hook declines to hold?** The graceful path
  assumes it does. Verify against the CLI before building on it.
