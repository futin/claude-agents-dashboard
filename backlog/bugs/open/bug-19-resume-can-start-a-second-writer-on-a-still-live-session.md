---
id: bug-19
title: Resume can start a second writer on a still-live session
created: 2026-09-05
tags: spawn, resume
updated: 2026-09-05T21:16:11Z
groom-elapsed: 1249
groom-tokens: 91900
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

Two independent halves, plus the severity question the capture left open — answered below.

**1. The liveness test is store-scoped; the eligibility test is not.** `serveSpawn`'s
resume branch (`server/api.ts:1272-1286`) asks three questions about liveness — a held
question/plan/message socket, `hasLiveChild(rid)`, and `listLaunching()` — and all three
can only answer for state *this process* holds. `hasLiveChild` (`server/lib/spawn.ts:908`)
reads the RAM-only store, so it is false for any child this server did not spawn or no
longer holds a handle for. The eligibility check one line above it is not scoped that way:
`sessionSurface(tr.entrypoint) !== 'dashboard'` admits **every** `sdk-cli` transcript on
the machine, and `sessionSurface`'s own doc comment says why (`server/lib/scan.ts:114`) —
"`sdk-cli` says *headless*, not *launched by this dashboard*". The resumable set is
therefore strictly larger than the set the guard can see: a session spawned before the
last dashboard restart, one spawned by a second dashboard instance, and every headless
`claude -p` started by any other launcher on the machine — `backlog-orchestrate`'s own
execute sessions among them — all read `dashboard`, and all answer `hasLiveChild === false`
while running. So this is not only a post-restart window; the orchestrator running in this
repo produces resumable-but-live rows as a matter of routine.

**2. `incomplete` never meant "the process is gone".** `resumeEligible`
(`client/src/lib/resume.ts:28`) offers the composer on `idle` and `incomplete`, and
`incomplete` is the *residual* branch of the status ladder (`server/lib/scan.ts:449`): it
means "recent + turn complete" (the post-turn linger, measured 90s+) **or** "stale + still
pending" (a live process mid-tool-call that simply hasn't written lately). Both are
live-process states. The only gate that would force `idle` is the `dead` probe, and it is
per-**cwd** (`liveCwds`, `server/lib/scan.ts:291-305`), fails open on every uncertain
input by design, and cannot tell two sessions in one directory apart. Nothing anywhere in
the repo reads per-session-id liveness — even though the argv carries it
(`--session-id <id>` / `--resume <id>`) and `scan.ts` already shells out to `ps`.

### What the CLI actually does with two writers — measured

CLI **2.1.259**, 2026-09-05, two probe sessions in `/tmp/bug19-probe` (both since killed,
project dir removed). The capture named four candidate answers; the answer is none of
them cleanly, and it differs by *when* the second writer arrives.

- **The CLI does not refuse, does not lock, and does not fork to a new file.** A second
  `claude -p --resume <id>` against a live id starts normally, appends to the same
  `<id>.jsonl`, prints its result and exits 0. No new transcript is created.
- **Second writer during the post-turn linger — benign.** Session `5a2139ff`: A finished
  ("A"), stayed up; B resumed, its records chained onto A's last uuid, one valid linear
  chain, and A wrote nothing further before exiting. This is the exact window the composer
  offers, and on its own it costs nothing.
- **Second writer mid-turn — the chain forks and the two branches interleave.** Session
  `bf8cf6f7` (A running six sequential `sleep 6` tool calls, B resumed after the first).
  Record `2c159d2f` ends up with **two children**: A's own next `tool_use` (`379f185a`)
  and B's first record (`f4d25288`). From there both processes keep appending to the one
  file in write order, so the branches are physically interleaved. The CLI also injected
  its own synthetic `"Continue from where you left off."` prompt into B's branch, because
  the transcript B loaded ended on a `tool_use` with no result yet. Reachable from the UI:
  `incomplete` covers exactly this state once the writes go quiet for a while.
- **No byte-level corruption.** All 44 lines parsed; appends are whole-line and nothing was
  overwritten or torn. "Transcript corruption" in the file sense is *not* what happens.
- **The real damage is silent branch loss.** A third `--resume` chains onto the last record
  in *file* order (A's `654cb94c`, "DONE") and loads only A's branch: asked to quote every
  earlier user message, it named one — A's prompt. B's entire exchange ("Reply with exactly
  the single letter B" → "B") is still in the file and gone from the conversation forever.
- **And the dashboard then disagrees with the CLI about what that conversation is.**
  Nothing here follows `parentUuid` — the only chain field any reader touches is
  `isSidechain` (`server/lib/analyze.ts:128`, `server/lib/chat.ts:135`) — so the chat
  drawer renders both branches interleaved as one linear thread, while the CLI's next
  resume sees one branch. Token/context figures come off the same file-order read, so they
  sum two divergent contexts.

**Severity, settled:** between the capture's two poles — worse than cosmetic, short of
transcript corruption. Nothing is destroyed on disk; a resumed turn can be silently
dropped from the session's own future history, and the drawer shows history the CLI no
longer has. Fixing it is a guard, not a repair: there is nothing to un-fork afterwards.

## Fix

Give the guard a per-session-id liveness answer that does not depend on this process
having spawned the child, and stop the composer offering the resume in the states that
answer already covers. Four parts; the first two are the safety boundary.

**1. `server/lib/scan.ts` — a per-id liveness probe, split parse from exec.**

- `parsePsSessionIds(out: string): Set<string>` — pure, over `ps -Ao pid=,args=` stdout.
  For each line, take it only if it contains `claude`, then collect every id matched by
  `--session-id[ =]<id>` and `--resume[ =]<id>` where `<id>` matches the existing
  `RESUME_ID_RE` charset (`[A-Za-z0-9._-]+`). Both flag spellings, because a hand-typed
  `--session-id=<uuid>` is the same live process.
- `liveSessionIds(): Set<string> | null` — runs that `ps` with the same 2s timeout as
  `liveCwds`, returns `null` (skip the check) when `ps` throws. **Note the direction is
  the opposite of `liveCwds`':** there, failing open costs a badge colour; here, `null`
  means the guard cannot fire, so keep the probe as simple as possible and let the
  store-based check stand alone in that case.
- Keep it a second `ps` call rather than teaching `liveCwds`' existing one to serve both.
  `liveCwds` parses `comm=`, and the launcher path can contain spaces
  (`…/Application Support/…`); merging the formats reintroduces exactly the parsing
  ambiguity that comment warns about, for one saved fork per poll.
- Known imprecision, in the safe direction: an argv-based match can produce a false
  positive (some unrelated command line mentioning `claude` and `--resume <id>`), which
  costs one refused resume, never a second writer.

**2. `server/api.ts` — use it in the resume guard.** Immediately after the `hasLiveChild`
409, add the probe check answering the *same* 409 body (`session is still running`):
`const live = liveSessionIds(); if (live?.has(rid)) return …`. Order matters: the store
check is free and authoritative for our own children, the probe costs a `ps` and is the
fallback for everyone else's. Extend the `POST /api/spawn` doc comment there — its resume
paragraph currently describes only the held-socket and store checks.

**3. `client/src/lib/resume.ts` — stop offering the composer for a row we know is live,
and fix the comment that overclaims.** `Session.stopState` is present *only* when this
server holds a live child (`stopStates()`, `server/lib/spawn.ts:882`), so widen
`resumeEligible`'s first parameter to `Pick<Session, 'surface' | 'status' | 'stopState'>`
and return false when `stopState` is set. Do **not** drop `incomplete` from the accepted
statuses — it is the normal "your turn" state and the main reason the feature exists;
removing it would remove the feature. The doc comment's "The server re-checks liveness on
POST (409), so this gate is UX, not the safety boundary" becomes true only once part 2
lands; until then it is the sentence this bug is about, so update it in the same change to
say what the re-check covers (own children via the store, anything else via `ps`).

**4. Docs.** `docs/subsystems/spawn.md` §Resuming an ended session, the **Alive sessions
409** bullet: it currently lists only the held-wait and in-flight cases. Add the two
liveness checks and their asymmetry (store = exact for our children, `ps` = argv-scan for
everything else, neither able to see a session whose argv carries no id). Record the
2.1.259 measurement above beside the existing 2.1.233 ones — that the CLI has no lock of
its own is the fact the whole guard rests on.

**Tests** (`test/`, node-assert, existing style):

- `parsePsSessionIds`: a `--session-id <uuid>` line → set contains it; `--resume <uuid>` →
  contains it; `--session-id=<uuid>` → contains it; a line with the flag but no `claude`
  → excluded; empty stdout → empty set; a line whose id has an out-of-charset character
  (`--resume a/b`) → excluded.
- `liveSessionIds` fail-open: stub the exec seam to throw → `null`, and assert the guard
  does not fire on `null` (a `null` probe must not 409 an otherwise-legal resume).
- `serveSpawn` (extend `test/spawn-endpoint.test.ts`, which already has the `withResumeHome`
  fixture): a resume whose id the probe reports live, **with no store entry for that id**,
  → 409 `session is still running`. The empty store is load-bearing — it is what proves the
  new check produced the 409 and not `hasLiveChild`. Verify by mutation: delete the part-2
  lines and this test must fail.
- The complement, which is where a too-eager guard would hide: probe returns a set *not*
  containing the id → the resume still succeeds (200, same id). Without this, "always
  refuse" passes the suite.
- `resumeEligible` (`test/resume-eligible.test.ts`): `stopState: 'ready'` → false,
  `stopState: 'stopping'` → false, absent → the existing idle/incomplete results unchanged.
- A test seam for the probe mirroring `setSpawner` (`server/lib/spawn.ts:282`) — an
  exported setter that swaps the `ps` runner — rather than shelling out for real in tests.

**Verification beyond the suite.** The unit tests cannot prove the argv match works against
a real `ps`, so run the live check once: spawn a session from `+ New`, and while
`ps -Ao pid=,args= | grep -- "--session-id <id>"` still shows it,
`POST /api/spawn {"resume":"<id>","prompt":"x"}` must answer 409 rather than 200. Then
confirm the same id resumes with 200 once that process is gone. Do this from a *restarted*
server if you want the foreign-child path specifically — that is the case `hasLiveChild`
cannot cover and the whole reason this bug stayed open.

In the browser (playwright MCP tools): open http://localhost:5174, spawn a session with
`+ New` (any short prompt), open that row's chat drawer while the row still shows its stop
control (i.e. `stopState` is present) and confirm the resume composer is **not** offered;
then, after the process exits and the stop control disappears, reopen the drawer and
confirm the composer **is** offered. This repo has no `.mcp.json` of its own — the
Playwright server comes from the user-global plugin install — so if the executing session
has no `browser_*` tools, say so explicitly and fall back to the `POST /api/spawn` check
above rather than reporting the browser step as done.
