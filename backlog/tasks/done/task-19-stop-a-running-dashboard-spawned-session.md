---
id: task-19
title: Stop a running dashboard-spawned session
created: 2026-09-04
from: idea-9
updated: 2026-09-05T17:31:02Z
started: 2026-09-05T16:43:17Z
execute-elapsed: 2865
execute-tokens: 277779
---

## Goal

A dashboard-spawned `claude -p` session can be stopped from the dashboard at any point in
its life, not just during the ~3s pre-adoption window `POST /api/spawn/:id/stop` reaches
today. One button, on the row, from a phone.

Scope is unchanged from idea-9: **sessions this server spawned and still holds a
`ChildProcess` handle for**. Terminal-started sessions stay out (they need a
`SessionStart`→pid registry that does not exist).

## Design decisions taken at groom time

Four of these depart from idea-9's *Rough shape*. `AskUserQuestion` was not available in
the grooming session, so they were decided rather than asked — each is reversible, and
each is called out here so the reader can overrule it before execution.

1. **The graceful "stop verdict" path (idea-9 §2) is dropped. Signal-only.**
   Two independent reasons. First, `stop-notify-hook.sh` already exits 0 on every
   `MessageWaitResult.status` except `answered` — so "resolve the held wait with a `stop`
   verdict" is behaviourally identical to today's `dismissed`, i.e. it buys nothing a
   `dismissAll()` would not. Second, a held Stop wait means the turn is *already over*;
   the case worth solving is a session mid-tool-call, which has no hold to resolve. And
   the premise it rested on is false on this machine: `claude -p` finishes its turn and
   then does not exit for 90s+ (measured 2026-08-27, unaffected by `--strict-mcp-config`
   or `--no-session-persistence`). A "graceful" stop that leaves the process up for a
   further minute and a half does not read as a stop.
   Nothing is lost by dropping it: killing the process group takes the hook's `curl` with
   it, the held response's socket closes, and `serveMessageWait`'s existing
   `res.on('close', … cancelMessage)` (api.ts:1034) already reaps the entry.
   → `server/lib/messages.ts` is **not** touched by this task.
2. **Grace window: an exported constant `STOP_GRACE_MS = 5_000`, not a config setting.**
   `spawn.ts` already keeps `LAUNCH_TTL_MS`, `FAIL_TTL_MS` and `MAX_LAUNCHING` as exported
   constants rather than env vars, and an env var would drag `.env.example`, `README.md`,
   `docs/workflows/configuration.md` and `config.ts` along for a number nobody tunes.
   5s, not idea-9's ~30s: the grace is not "let real work finish" — the user pressed
   Stop — it is only "let the CLI flush and exit on SIGTERM before we SIGKILL it".
3. **No shutdown reaper; the restart-orphan limitation stands and is surfaced.**
   Killing spawned children when the dashboard restarts would be a regression: `detached`
   + `unref()` is deliberate, and restarting the dashboard while sessions work is a normal
   thing to do. Instead the UI simply tells the truth — after a restart the handle is gone,
   so `stopState` is absent and no Stop control renders on that row.
4. **The Stop control lives in the expanded row panel, not in `.r1`.**
   Phone-first: a stop affordance sitting next to the project name is tap-bait, and the
   right edge is already the full-height chat tab. Expand-then-stop is two deliberate taps
   for a destructive action. Confirmation is the two-stage inline pattern already in
   `SettingsView` (`confirmReset`), not a modal — the repo has no modal component.

## Plan

### Step 0 — measure what SIGTERM actually does to `claude -p` (30 min, not a gate)

Spawn a real detached `claude -p` with a long prompt, `kill -TERM -<pgid>`, and poll `ps`
until the group is gone. Record: does it exit at all, and after how long. Repeat with
SIGKILL to confirm the group negation reaches MCP servers and bash tools, not just the CLI.

This informs the PR body and validates the 5s constant; it does **not** block the build,
because the SIGKILL escalation is exactly the cover for "SIGTERM is ignored". Write the
measured numbers into the PR's Verification section either way — including "SIGTERM was
ignored" if that is the answer.

### Step 1 — `server/lib/spawn.ts`: the entry survives adoption

The store's charter comment ("this is NOT a session registry") needs amending: it now
holds a live handle for as long as the child lives. Say so there, and say why the
alternative — persisting pids — was refused (PID reuse).

**Entry state.** The internal `Entry.state` union gains `'running'`. The public
`LaunchingSession.state` union in `shared/types.ts` is unchanged: `toPublic` is never
called for a `running` entry.

**Two ways in to `running`**, and the split is load-bearing:

- `adoptLaunched(ids)` transitions a **non-resume** `launching` entry to `running` instead
  of deleting it. Its return value keeps counting entries it acted on (now: transitioned),
  and a second call for an id already `running` counts 0. Update the doc comment — it
  currently says "removed".
- **Resume entries keep today's skip in `adoptLaunched`**, for the reason its comment
  already gives: a resume's id names a transcript that exists before the child does, so
  adopting on the first poll would swallow a launch failure the user never got to see.
  They reach `running` from the *other* end instead — see below. Consequence to accept and
  document: a resumed session is not stoppable for its first `LAUNCH_TTL_MS` (60s).
- `listLaunching(now)`'s TTL branch changes from "delete a `launching` entry past
  `LAUNCH_TTL_MS`" to: **if the child is still alive, transition it to `running`; delete
  only if the child is gone.** This is what promotes resumes, and it also stops a
  non-resume launch that the scan window never showed from silently losing its handle.
- `listLaunching` must not emit `running` entries at all (no phantom row for a real
  session) and must not TTL them. `FAIL_TTL_MS` still applies to `failed` only.

**Exit means gone, not failed.** In `launch()`'s `'exit'` and `'close'` handlers, an entry
in state `running` is **deleted**, before any `fail()` logic runs. Without this, a spawned
session that worked for an hour and exited nonzero reappears as a red "launch failed"
phantom row. `launching` entries keep today's behaviour exactly (code 0 → leave alone;
nonzero → `fail`).

**New exported surface** (signatures, not code):

- `type StopResult = 'not-found' | 'stopped' | 'stopping'`
- `const STOP_GRACE_MS = 5_000`
- `stopSession(id: string, now?: number): StopResult`
  - unknown id, `failed` entry, or no child handle → `'not-found'`
  - `launching` entry → today's `stopLaunch` behaviour verbatim: `child.kill('SIGTERM')` on
    the handle (not the group), delete the entry, `'stopped'`
  - `running` entry already carrying `stopRequestedAtMs` → `'stopping'`, **no second
    signal** (idempotent; a double-tap must not re-signal)
  - `running` entry otherwise → set `stopRequestedAtMs = now`, signal the group SIGTERM,
    arm the escalation timer, `'stopping'`
- `forceStopSession(id: string): StopResult` — `running` entries only; SIGKILL the group,
  `'stopped'`. Deletion is left to the `'exit'` handler, which SIGKILL always produces.
  A `launching` entry answers `'not-found'`: that path is already an immediate kill.
- `escalateStop(id: string, now?: number): boolean` — exported **so the synchronous test
  runner can drive it directly**; the armed timer's callback is a one-line call to it.
  True only when: the entry exists, is `running`, has `stopRequestedAtMs`,
  `now - stopRequestedAtMs >= STOP_GRACE_MS`, and the child is still live. Then SIGKILL
  the group.
- `stopStates(): ReadonlyMap<string, StopState>` — every `running` entry with a live child:
  `'stopping'` if `stopRequestedAtMs` is set, else `'ready'`. Same injected-Set spirit as
  `messageSessionIds()`, a Map because one field carries two states.
- `setGroupKiller(fn: ((pid: number, signal: string) => void) | null): void` — test seam
  mirroring `setSpawner`. **Required, not optional**: without it the suite's fake pids would
  reach the real `process.kill`.
- `stopLaunch` is removed; `stopSession` subsumes it. Update its callers and its tests.

**The group-signal guard, load-bearing.** One internal helper does every signal, and it
refuses unless *all* of: `typeof child.pid === 'number'`, `child.pid > 1`,
`child.exitCode === null`, `child.signalCode === null`. Then `process.kill(-pid, signal)`
inside a try/catch (a lost race throws ESRCH; swallow it — the caller's verdict does not
change). The `pid > 1` clause is the dangerous one: POSIX `kill(0, …)` signals **every
process in the caller's own group**, so a `pid` of 0 would take down the dashboard and the
terminal that started it.

`resetLaunches()` must now clear any armed escalation timers — its comment currently
states this store "deliberately, has none". Arm them with `.unref()` so they can never hold
the process open.

The security rule from idea-9 carries over unchanged: only ever signal a process this
server spawned and still holds a handle to. No pid from a request body, no `ps` scan.

### Step 2 — `shared/types.ts`

- `export type StopState = 'ready' | 'stopping'`
- `Session.stopState?: StopState` — **absent means not stoppable**, which is the honest
  encoding of the post-restart orphan case. Document that on the field.

### Step 3 — `server/lib/scan.ts`

`ScanOptions` gains `stopStates?: ReadonlyMap<string, StopState> | null`, documented in the
same shape as `messageIds` (omitted/null ⇒ no row is flagged). Set `Session.stopState` when
the id is present, leave it absent otherwise.

### Step 4 — `server/api.ts` + `server/index.ts`

- `serveSessions` passes `stopStates: stopStates()` into `scanSessions`, alongside the
  existing `messageIds` etc.
- New `serveSessionStop(config, id, req, res)` — `async`, because unlike `serveSpawnStop`
  it reads a body. Guard order mirrors `serveSpawnStop`: remote-answer state → `tokenOk` →
  `ID_RE` → body → dispatch.
  - **An absent or empty body is normal**, not a 400 — the common request is a bare POST.
    Only a present-but-unparseable body is `sendBadBody`.
  - `force` is honoured on strict `=== true` only, the same rule `remoteControl` and the
    dismiss flag already follow. Anything else routes to the graceful path.
  - Result mapping: `'not-found'` → 404 `{error:'no live session'}`; `'stopped'` → 200
    `{stopped:true}`; `'stopping'` → 200 `{stopping:true}`.
- `serveSpawnStop` keeps its route and its behaviour but delegates to `stopSession`. Do not
  delete `/api/spawn/:id/stop`: it is documented, and folding the two handlers is enough to
  satisfy idea-9's "two endpoints behind one button is the wrong seam" — the *button* only
  ever calls the new route.
- Route it in `index.ts` as `/^\/api\/sessions\/([^/]+)\/stop$/`, POST-only
  (`methodNotAllowed` otherwise), id through `decodePath`, and **matched before the
  `/api/sessions/:id` detail regex** — the same route-order trap the chat/question/plan/
  message routes each document.

### Step 5 — client

- `client/src/lib/stopControl.ts` — a pure module, because this repo's client tests import
  `client/src/lib/*` and never render components (see `panelCollapse.test.ts`). Export the
  decision function that maps `(stopState, confirming)` to what the control should show:
  whether to render at all, the label, and which POST it sends. All the branching lives
  here so it is testable; the component stays declarative.
- `client/src/hooks/useStopSession.ts` — mirrors `useSpawn`: one shared
  `usePersistedState('dashboard.answerToken')`, `Authorization: Bearer` when set,
  `403 → needsToken`, every other non-2xx feeds an `error` string, never throws.
- `SessionRow` renders the control **inside the expanded panel, above `<SessionDetail/>`**,
  only when `s.stopState` is present. Two-stage confirm (`SettingsView`'s `confirmReset`
  pattern): `stop session` → `really stop?` + `cancel`.
- When `stopState === 'stopping'`: a **visible** `stopping…` badge in `.r2` — visible text,
  not a `title` attribute, which does nothing on touch — and the expanded panel offers
  `force stop` (POST `{force:true}`) in place of the confirm pair. Force is offered
  immediately rather than after a client-side grace timer: the server escalates on its own
  after `STOP_GRACE_MS`, so the button is only there for impatience, and no timer means no
  clock to keep in sync with the server's.
- CSS: new class names in `client/src/styles.css`, **no literal color or shadow** below the
  theme-token block — reuse `var(--red)` / `var(--amber)` as the existing states do. The
  light theme breaks on a single literal.

### Step 6 — docs

- `docs/subsystems/spawn.md`: a "Stopping a spawned session" section — the
  `launching → running → gone` lifecycle and both routes into `running`, the group-signal
  guard and why `pid > 1` is there, the 5s escalation, the 60s resume blind spot, and the
  restart-orphan limitation. Re-stamp it per `docs-sync`.
- `docs/overview.md` §Map: the two new client files.

## Test cases

Backend cases extend `test/spawn.test.ts` and `test/spawn-endpoint.test.ts`. The runner is
synchronous, so nothing may `await` — that is why `escalateStop` takes `now` and is
exported. `FakeChild` needs three new fields to exercise the guard: `pid`, `exitCode`,
`signalCode`; a test that emits `'exit'` sets `exitCode` first, the way a real child does.
Every test installs a recording `setGroupKiller` stub and restores it.

**Store lifecycle**

1. Adoption transitions rather than deletes: launch, `adoptLaunched([id])` → `1`, then
   `listLaunching()` has length `0` and `stopStates().get(id)` is `'ready'`.
2. Adoption is once: a second `adoptLaunched([id])` → `0`, `stopStates().get(id)` still
   `'ready'`.
3. A resume entry is still skipped by adoption: launch with `resumeId`, `adoptLaunched([R])`
   → `0`, `listLaunching()` length `1` with `state: 'launching'`, `stopStates()` empty.
4. A resume failure still renders (the regression guard for case 3): after that same
   adoption attempt, emit `exit` code `2` → `listLaunching()` length `1`,
   `state: 'failed'`, `resume: true`.
5. TTL promotes a live child: launch with `resumeId`, then
   `listLaunching(Date.now() + LAUNCH_TTL_MS + 1)` → length `0` and `stopStates().get(R)`
   is `'ready'`.
6. TTL still deletes a dead one: same setup, but set `exitCode = 0` and emit `'exit'` first
   (code 0 leaves a `launching` entry alone today — keep that). Then
   `listLaunching(now + LAUNCH_TTL_MS + 1)` → length `0` and `stopStates()` **empty**.
7. A `running` entry that exits is deleted, not failed: adopt, then `exitCode = 1` +
   emit `'exit'` → `listLaunching()` length `0`, `stopStates()` empty. (Mutation proof:
   with the new delete-first branch removed, this test must go red with a `failed` phantom.)

**Stopping**

8. `stopSession` on a `launching` entry: → `'stopped'`, `child.killSignals` deep-equals
   `['SIGTERM']`, the group killer was **never** called, `listLaunching()` length `0`.
9. `stopSession` on a `running` entry: → `'stopping'`, group killer called exactly once
   with `(-pid, 'SIGTERM')`, `stopStates().get(id)` is `'stopping'`, the entry survives.
10. Idempotent: a second `stopSession` → `'stopping'` and the killer's call count is still
    `1`.
11. `stopSession` on an unknown id → `'not-found'`; on a `failed` entry → `'not-found'`;
    neither signals anything.
12. `escalateStop(id, stopRequestedAtMs + STOP_GRACE_MS - 1)` → `false`, killer call count
    unchanged at `1`.
13. `escalateStop(id, stopRequestedAtMs + STOP_GRACE_MS)` → `true`, killer called with
    `(-pid, 'SIGKILL')`.
14. `escalateStop` after the child exited (`exitCode = 0`, `'exit'` emitted) → `false` and
    **no signal at all**. *Mutation proof required*: delete the liveness clause of the
    guard, re-run, this test must fail; restore, it must pass. Put both outputs in the PR.
15. **The pid guard.** A child with `pid = 0` → `stopSession` → `'not-found'` and the
    killer is never called. Repeat for `pid` `undefined` and `pid` `1`.
    *Mutation proof required*: remove the `pid > 1` clause and the `pid = 0` case must fail
    with the killer having been called with `-0` — which in production is the dashboard's
    own process group. Both outputs in the PR.
16. A killer that throws (simulated ESRCH) does not propagate: `stopSession` still returns
    `'stopping'` and does not throw.
17. `forceStopSession` on a `running` entry → `'stopped'` with `(-pid, 'SIGKILL')`; on a
    `launching` entry → `'not-found'` with no signal.

**Endpoints**

18. Remote answers off → `POST /api/sessions/<id>/stop` is 404 `{error:'remote answers disabled'}`.
19. Wrong bearer token → 403. *Mutation proof required* on this gate: drop the `tokenOk`
    line and the test must go red.
20. An id the server never spawned → 404 `{error:'no live session'}`.
21. A spawned, adopted id with **no request body** → 200 `{stopping:true}` and the killer
    saw `(-pid, 'SIGTERM')`. An empty body must not 400.
22. `{"force":true}` → 200 `{stopped:true}`, killer saw SIGKILL. `{"force":"yes"}` → 200
    `{stopping:true}` (strict `=== true`), killer saw SIGTERM.
23. `GET /api/sessions/<id>/stop` → 405 with an `Allow: POST` header.
24. `POST /api/sessions/%ZZ/stop` → 400 `{error:'bad path encoding'}` and the server is
    still answering afterwards (the `decodePath` crash guard).
25. `POST /api/spawn/<id>/stop` against a still-`launching` entry → 200 `{stopped:true}`,
    unchanged from today.
26. `GET /api/sessions` carries `stopState: 'ready'` on the adopted spawned row and omits
    the field entirely on every other row.

**Client (pure)**

27. `stopControl` returns "do not render" when `stopState` is absent — the post-restart
    orphan case.
28. `stopState: 'ready'`, not confirming → the primary label; confirming → the confirm pair;
    both send the non-force POST.
29. `stopState: 'stopping'` → the `stopping…` badge plus a force action, and the confirm
    state is not reachable from there.

**Manual / browser**

30. If the Playwright MCP server is reachable in the executing session —
    `In the browser (playwright MCP tools):` open `http://localhost:5174`, launch a session
    with a long-running prompt from the `+ New` panel, wait for its real row to appear,
    expand it, click `stop session`, click `really stop?`, and confirm the row shows
    `stopping…` and then leaves the working state within ~10s. If the server is not
    reachable, **say so explicitly in the PR's Verification section** and mark this row
    Unproven rather than claiming it passed.
31. Not verifiable in this suite, and it must be named as unproven in the PR: that SIGKILL
    on the negated pgid actually reaps MCP server and bash-tool grandchildren of a real
    `claude -p`. Step 0's measurement is the evidence to cite here.

## Done when

- `pnpm test` is green and the case count has grown by the cases above — output pasted in
  the PR, never a claim without it.
- `pnpm typecheck` is clean.
- The three mutation proofs (cases 14, 15, 19) each show a red run with the guard removed
  and a green one with it restored, both outputs in the PR body.
- A dashboard-spawned session can be stopped from an expanded row on a phone, and the row
  reflects `stopping…` while it happens.
- `docs/subsystems/spawn.md` covers the new lifecycle and is re-stamped; `docs/overview.md`
  §Map lists the new client files.
- The PR body follows `.github/pull_request_template.md`, grouped Server / Client / Docs,
  and states what was **not** verified — at minimum case 31, plus case 30 if Playwright was
  unreachable.

## Outcome

**2026-09-05 — done.** A dashboard-spawned session can be stopped from its expanded row at
any point in its life. Built as planned; all four groom-time design decisions were kept
(`AskUserQuestion` was unavailable in this session too, so they were re-confirmed by reading
the code rather than asked).

Two defects the tests caught during the build, both real:

1. `signalGroup` handed the killer a **non-negated** pid — it would have signalled the single
   process, not the group, silently losing every grandchild. Case 9's `(-pid, 'SIGTERM')`
   assertion is what found it.
2. `stopSession` returned `'stopping'` for a running entry even when the pid guard refused to
   signal, leaving a row stuck on `stopping…` with no escalation able to finish it. The guard
   now decides the verdict: `signalablePid()` is shared by `stopSession`, `forceStopSession`
   and `stopStates`, so "cannot be signalled" and "is not offered as stoppable" are the same
   predicate.

One plan test case was **not discriminating as specified and was rewritten.** Case 14
(`escalateStop` after the child exited) stays green with the liveness clause deleted: the
`'exit'` handler deletes the entry first, so `escalateStop` returns at the presence check and
never reaches the guard. Replaced with a test that sets `exitCode` *without* emitting
`'exit'` — the real reaped-but-not-yet-dispatched window, which is the only way to reach that
clause. That version does go red under mutation (proof below). The original assertion was
kept too, renamed to say what it actually proves.

### Step 0 — measured, not assumed

Two real detached `claude -p` runs, signalled on the negated pgid:

```
spawned pid=45184 (pgid=45184, detached)
t=25s: 6 process(es) in group:
   45184 45184 claude
   45256 45184 node
   45270 45184 npm exec @playwright/mcp@latest --headless --isolated
   45278 45184 .../codegraph-darwin-arm64/node
   45393 45184 .../codegraph-darwin-arm64/node
   45567 45184 node
sent SIGTERM to -45184
RESULT: SIGTERM reaped the whole group in 1101ms.
```
```
spawned pid=46406 (pgid=46406, detached)
t=25s: 6 process(es) in group
sent SIGKILL to -46406
RESULT: SIGKILL reaped the whole group in 585ms.
```

SIGTERM is honoured, comfortably inside the 5s grace, and the group negation **does** reach
MCP servers and tool grandchildren. Case 31 is therefore verified rather than unproven.

### `pnpm test` / `pnpm typecheck`

```
$ pnpm typecheck
> tsc --noEmit
(clean, no output)

$ pnpm test
  ✓ no branch ever prints the token value

  18/18 passed
ALL PASS
```

Case count: **994 → 1028 (+34)**, measured by running the suite on a clean `main` worktree
rather than eyeballed.

### The three mutation proofs

**1. The liveness clause** (`signalablePid`, `return childAlive(child) ? pid : null`):
```
=== RED run: liveness clause deleted ===
  ✗ a reaped-but-not-yet-dispatched child is never signalled — the liveness clause
FAILED (1)

=== GREEN run: clause restored ===
  ✓ a reaped-but-not-yet-dispatched child is never signalled — the liveness clause
ALL PASS
```

**2. The `pid > 1` clause** — the failure output names the pid it would have signalled:
```
=== RED run: pid > 1 clause deleted ===
  ✗ the pid guard refuses to signal a child whose pid is 0
    nothing may be signalled for an unusable pid
+ actual - expected
+ [ {  pid: -0,  signal: 'SIGTERM' } ]
- []

  ✗ the pid guard refuses to signal a child whose pid is 1
+ [ {  pid: -1,  signal: 'SIGTERM' } ]
- []

  ✓ the pid guard refuses to signal a child whose pid is undefined
```
`pid: -0` is this dashboard's own process group. The `undefined` case stays green under this
mutation, correctly — the `typeof` clause still catches it.
```
=== GREEN run: clause restored ===
  ✓ the pid guard refuses to signal a child whose pid is 0
  ✓ the pid guard refuses to signal a child whose pid is 1
  ✓ the pid guard refuses to signal a child whose pid is undefined
ALL PASS
```

**3. The `tokenOk` gate** on `serveSessionStop`:
```
=== RED run: tokenOk gate deleted ===
  ✗ POST /api/sessions/:id/stop is 403 for a wrong bearer token
    200 == 403
FAILED (1)

=== GREEN run: gate restored ===
  ✓ POST /api/sessions/:id/stop is 403 for a wrong bearer token
ALL PASS
```

### Case 30 — browser, against a real spawned session

Playwright MCP was reachable. Dev server on this worktree's own ports (4273 / Vite 5178);
the user's dashboard on 5174 was confirmed untouched before and after.

Launched a real `claude -p` from `+ New` (plan mode, remote control off), waited for its row,
expanded it, clicked `stop session` → `really stop?`. Its process group at the moment of the
click was **nine** processes:

```
50461 50461 /Users/andrejajevtic/.local/bin/claude
50481 50461 node
50483 50461 npm exec @playwright/mcp@latest --headless --isolated
50487 50461 .../codegraph-darwin-arm64/node
50596 50461 .../codegraph-darwin-arm64/node
50637 50461 node
52564 50461 /Library/Developer/CommandLineTools/usr/bin/git
52589 50461 .../git-core/git
52597 50461 ssh
```
```
whole group (9 procs) gone after 0.15s
--- survivors (expect none) ---
(none)
```

The row went `working → idle` and the Stop control disappeared on the next poll — correct,
since the handle is gone and `stopState` with it. The confirm step also proved the
`stopPropagation` guard: clicking `stop session` armed `really stop?` without collapsing the
row.

**One honest caveat on the `stopping…` badge: it did not render in that run.** The CLI died
faster than one 3s client poll. Measured directly against the API, the window is real but
short:

```
$ curl -s -X POST /api/sessions/<id>/stop
{"stopping":true}
  t+0.3s  stopState='stopping'
  t+0.6s  stopState='stopping'
  t+0.9s  stopState=None
```

So the badge is correct and server-observable for ~0.9s, but for a healthy CLI a 3s poll
usually misses it. It earns its place for the case it was built for — a session that resists
SIGTERM — which is exactly when `force stop` also appears. Not a defect; stated so nobody
reads the fast path as a bug.

Both probe sessions were confirmed fully reaped afterwards; the temporary worktree `.env`
(needed only to set `CLAUDE_BIN`) was removed.

### Not verified

- The doc stamp on `docs/subsystems/spawn.md` has its **sources updated but its `verified`
  SHA untouched** — this skill never commits, so the branch SHA does not exist yet. It needs
  a `/docs-sync` re-stamp after the commit lands.
- `docs/guides/tutor/write-paths/write-paths-2-spawn-deck.html` still teaches `stopLaunch`.
  It is a generated deck, refreshed by `/tutor`, not by hand — left alone deliberately. Every
  reference in live code and in `docs/subsystems/` was migrated.
