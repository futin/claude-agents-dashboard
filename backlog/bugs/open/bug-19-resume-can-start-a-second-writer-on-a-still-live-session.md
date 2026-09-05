---
id: bug-19
title: Resume can start a second writer on a still-live session
created: 2026-09-05
tags: spawn, resume
---

## Symptom

Resuming a dashboard-spawned session can launch a second `claude` process against a
transcript the first one is **still writing to** — two writers on one file, which is the
exact thing `serveSpawn`'s resume guard says it exists to prevent:

```
// A held question, plan, or reply window means the process is alive —
// resuming now would put a second writer on the same session.
```

The guard is real but incomplete. It catches a session that is *holding a socket*; it does
not catch one that is merely *still alive*.

The window is not exotic — it is the normal end of every headless turn. `claude -p`
finishes its turn and then lingers before exiting (measured 90s+ on this machine,
2026-08-27, and confirmed again on 2026-09-05: a spawned session still reported
`stopState: 'ready'`, i.e. a live child, well after it had answered). During that linger
the row reads `incomplete` — "your turn" — which `resumeEligible` accepts, so the resume
composer is offered while the process is up.

Nothing here is a regression from task-19. Before it, `adoptLaunched` **deleted** the
entry, so `listLaunching()` could not see an adopted session either. What changed is that
the fix is now cheap: the store keeps the live handle, so it finally knows.

## Repro

1. Spawn a session from `+ New` with a short prompt.
2. Wait for its turn to finish. The row goes `incomplete`; the chat drawer offers the
   resume composer.
3. Before ~90s have passed, confirm the process is still up — either
   `ps -ax | grep -- "--session-id <id>"`, or read `stopState` off `GET /api/sessions`
   (present ⇒ this server still holds a live child for it).
4. Resume it from the composer, or `POST /api/spawn {"resume":"<id>","prompt":"…"}`.
5. 200 with the same session id, and a second `claude --resume <id>` appears in `ps`
   alongside the first.

Not yet established, and the first thing grooming should settle: **what the CLI actually
does** with two processes on one transcript — interleaved records, a silent fork, last
writer wins, or its own lock. The severity of this bug is whatever that answer is. If the
CLI already refuses, this is a cosmetic gap; if it interleaves, it is transcript
corruption.

## Affects

- `server/api.ts:1258-1266` — the resume guard: holds, then
  `listLaunching().some(e => e.sessionId === rid)`.
- `server/lib/spawn.ts` — `listLaunching` skips `'running'` entries
  (`if (entry.state === 'running') continue;`), so an adopted, live spawned session is
  invisible to that guard. `stopStates()` is the map that *does* see it.
- `client/src/lib/resume.ts:28` — `resumeEligible` accepts `idle` **and** `incomplete`;
  `incomplete` is precisely the status a lingering post-turn session shows.
- `docs/subsystems/spawn.md` — §Resuming an ended session, and `resume.ts`'s own doc
  comment, both claim "the server re-checks liveness on POST (409), so this gate is UX,
  not the safety boundary." That claim is stronger than the code: the re-check covers
  held sockets, not liveness.

### Partly closed by task-19's review loop 1

The **store-level** half of this is fixed on the task-19 branch, because the review found a
consequence this bug did not record: launching a second child for a live id also replaced
the store entry, throwing away the first child's kill handle (a live session silently became
unstoppable) and letting the first child's eventual `'exit'` delete or fail the *newer*
entry. Two guards landed there:

- `serveSpawn` now refuses with 409 `session is still running` when `hasLiveChild(rid)` —
  which closes the repro above for any session **this server spawned and still holds a handle
  for**.
- `dropIfRunning`/`fail` take a child-identity check, so a stale handler can never touch a
  newer entry for the same id.

**What is left, and why this bug stays open.** `hasLiveChild` can only answer for children
this process spawned: a terminal-started session, or one spawned before the last dashboard
restart, still answers false, and the guard does not fire. And the question that sets this
bug's severity is untouched — **what the CLI actually does with two writers on one
transcript**. Until that is answered, the remaining exposure is unquantified.

## Cause

unknown

## Fix

unknown
