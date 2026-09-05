# Spawning a new session (the fourth write path)

The toolbar's **+ New** button starts a brand-new Claude Code session from the
dashboard: pick a recent project, write or dictate a prompt, tap launch. The server
spawns a detached, headless `claude -p` in that project's directory; the session
appears in the list a poll or two later (usually under 3s), and from then on it's an
ordinary row — you keep talking to it with the [reply window](remote-message.md) that
already exists for every session.

⚠️ **That last clause has a host-side prerequisite, and it is easy to miss.** The reply
window only holds if the `Stop` entry in `~/.claude/settings.json` carries a `timeout`
high enough to cover it — `"timeout": 630`, exactly as
[remote-message's install step](remote-message.md#install) specifies. The CLI kills a hook
when its `timeout` elapses, so a missing or too-low value ends the held turn mid-wait: the
session simply stops, and a reply that lands afterwards finds nothing (404 → the panel
says "gone"). Nothing about spawning changes that — it inherits the window as-is — but a
launch you intended to keep talking to degrades to one-shot, which is the difference
between this feature and half of it. **Check that entry before relying on the round
trip**; the ask (`PreToolUse`/`AskUserQuestion`) and plan hooks having `630` does not imply
`Stop` does. This is the design spec's Risk 4. Editing that file is a host-side step, on
purpose outside this repo.

The three earlier write paths — [remote-answer](remote-answer.md),
[remote-plan](remote-plan.md), [remote-message](remote-message.md) — are all
**hook-held**: a session is already running, a hook blocks on something, the browser
resolves it. The dashboard has never *initiated* anything; it has only ever answered
what a session raised. Spawn inverts that, and that inversion is the whole security
story below — this turns a read-mostly monitor into a remote code-execution surface.
The mitigating argument is that remote-message already lets a phone hand a *running*
session brand-new instructions, so the marginal capability here is "without needing one
to already be running" rather than a wholly new class of power — but the feature still
ships off by default, and the ceiling on how much damage it can do lives on the host,
never in the browser.

## Why headless `-p`, not a terminal

`open -a Terminal`/`osascript` would give you a session you can walk up to and type
into. It also needs the Mac awake with a live GUI session — and away from the machine,
which is the only case this feature exists for, you cannot see or drive a TUI at all.
Headless `-p` runs anywhere the server itself runs, writes an ordinary transcript like
any other session, and — because it fires the same global hooks a terminal session
does — inherits remote `AskUserQuestion` and the `Stop` reply window for free. Neither
of those features had to be taught about spawned sessions; they just work, because a
headless run looks like any other run to the hooks that matter. One deliberate exception
since: the reply window's *at-desk* gates do not apply to headless runs — the hook skips
its idle check and the server's idle sweep skips their holds, because sitting down at the
keyboard gives you no terminal to continue this session in (see
[remote-message](remote-message.md#the-released-status-and-the-idle-sweep)). "For free" means
*inherited*, not *guaranteed*: whatever those hooks are (or aren't) configured to do on
this host is what a spawned session gets — see the `Stop` `timeout` warning at the top.

The cost: a headless run has no TTY, so a permission prompt has nowhere to go. That's
what forces a permission-mode *decision* on every launch (below), rather than leaving it
at whatever the CLI defaults to.

## Verified against the CLI (2.1.233)

Two mechanics this feature depends on were measured against the installed binary rather
than assumed from its docs:

- **`--session-id <uuid>` is honored end to end.** A minted uuid passed to `claude -p
  --session-id <uuid>` comes back as that exact `session_id` in the JSON result, and
  `~/.claude/projects/<dir>/<uuid>.jsonl` appears under that name. This is what lets
  `launch` (`server/lib/spawn.ts`) hand back a session id the instant the child is
  spawned — before any transcript exists — so the client can set its chat-drawer deep
  link to that id immediately (`SessionsView.tsx`'s `onLaunched` sets `chatId` right
  from the POST response). The drawer itself still waits: `chatSession`
  (`SessionsView.tsx`) resolves by finding that id in the next `/api/sessions` poll,
  so it opens once the transcript actually exists, not before — there's nothing to
  render before then, but the *id* is known and correct from the first response.
- **A prompt on stdin is never parsed as a flag.** `claude -p` reads argv the way
  nearly every CLI does: a value starting with `-`/`--` is a flag, never data,
  regardless of what it follows — a prompt beginning `--` passed *positionally* would be
  read as one. Measured directly: piping the prompt `--version is not a flag here; just
  reply with the single word OK` to `claude -p …` on stdin produced the reply `OK`, not
  a CLI-flag error. That's why `buildSpawnArgs` (`server/lib/spawn.ts`) never puts
  the prompt in argv at all — a prompt is untrusted free text a user typed, and
  `--dangerously-skip-permissions` is a perfectly ordinary-looking way to start a
  sentence — `launch` pipes it onto the child's stdin instead and ends the stream right
  after.

## Remote Control launches (opt-out)

> Where an RC session can and cannot be continued — including the verified fact that
> the desktop app shows it nowhere — is mapped in
> [session-surfaces](session-surfaces.md).

The form's **remote control** checkbox (default on) adds `--remote-control` to the
argv. Verified against the same CLI build as the mechanics above: the flag combines
with `-p` cleanly, and the session then *registers with the account* while still
running on this machine — the Claude phone app can see and drive it, other local
sessions can reach it by its `-n` name over the messaging socket (`ListAgents` /
`SendMessage`), and the turn-end reply window keeps working unchanged on top. What it
does NOT do is put the session in any cloud sandbox — execution, transcript, and hooks
stay exactly as for a plain launch.

Parsing follows the fail-soft rule every optional field here obeys, with one
tightening: only a literal `true` turns it on (`b.remoteControl === true` in
`parseSpawnRequest`), so `"yes"`, `1`, or an absent field all mean off. The flag is
appended last in `buildSpawnArgs`, after `-n`, per that function's append-only
ordering contract. Nothing else changes: the ceiling still clamps the permission mode
(registration adds a remote *driving* surface, not a wider *permission* surface), the
launch store watches the child the same way, and an account or org that refuses the
registration surfaces it as the CLI's own startup error through the ordinary
`failed`-entry path.

## Resuming an ended session (`resume`)

The spawn path's first extension, and the one its own accepted-limits list predicted: a
dashboard session whose turn is over — the [reply window](remote-message.md) expired, was
released, or hit the CLI's 8-block cap — is not a dead end anymore. The chat drawer of an
ended `dashboard`-surface session offers a **resume composer** (`ResumePanel`): type a
follow-up, tap *resume session*, and `POST /api/spawn` relaunches the same session with
`SpawnRequest.resume: <sessionId>`.

Measured against the CLI (2.1.233), same method as the mechanics above:

- **Plain `--resume <id>` keeps the session id and appends to the same transcript.** The
  resumed run's JSON result reports the *original* `session_id`, the same `.jsonl` grows,
  and the model demonstrably recalls the earlier turns. That is what makes the feature
  cheap: the existing row wakes up on the next poll, the open drawer live-tails the
  continuation, and nothing downstream needed teaching.
- **`--session-id` must NOT accompany `--resume`** — the CLI refuses the pair outright
  unless `--fork-session` is added, and a fork (new id, new row) is exactly what resume
  must not do. `buildSpawnArgs` therefore swaps `--session-id <id>` for `--resume <id>`
  and changes nothing else.

The request reuses the launch machinery wholesale — same toggle/probe/token/cap gates,
same permission ladder and ceiling, prompt still stdin-only — with these differences:

- **`resume` rejects when present-but-malformed** (400 `bad resume id`), the opposite of
  the cosmetic fields' drop-don't-reject rule: silently ignoring it would start a fresh
  session somewhere the user never asked for.
- **Membership check against enumerated transcripts, never a path.** The id is matched
  against `listTranscripts(projectsRoot())` (`unknown session` otherwise), and the child's
  cwd is the *transcript's own* `cwd` — `body.project` is ignored.
- **`dashboard`-surface only** (`sessionSurface(entrypoint) === 'dashboard'`, i.e.
  `sdk-cli`): a terminal session is terminal-owned, and resuming one here could race a
  still-open interactive session on the same transcript. 400 `only dashboard sessions can
  be resumed`.
- **Alive sessions 409.** A held question, plan, or reply window means the process is
  still running (`session is still running`); a resume already in flight for that id is
  `already resuming`. The client-side gate (`resumeEligible`, `client/src/lib/resume.ts`)
  hides the composer in those states too — plus while `working` — but the server checks
  are the boundary, the gate is UX.
- **`name` and `--remote-control` are forced off** on a resume: renaming or
  account-registering a *resumed* session are unverified CLI combos, so they are never
  sent. `model`/`effort`/`permissionMode` pass through as usual.

**The store treats a resume entry specially.** Its id names a transcript that already
exists, so `adoptLaunched` skips it — adoption-on-scan would delete the entry on the first
poll and swallow any failure before the UI could render it. A resume entry leaves the
store the ordinary ways instead: `LAUNCH_TTL_MS` (60s) while `launching`, `FAIL_TTL_MS`
after a failure, or `stopSession`. Two visible consequences: a `launching` resume holds one
of the `MAX_LAUNCHING` slots for up to 60s (so resumes count toward the accident rail,
which is right — they are real processes), and the client (`SessionList`) hides a
`launching` resume phantom — the real row is the progress indicator — while still
rendering a `failed` one, which is the only signal a broken resume gets
(`LaunchingSession.resume` carries the flag across the contract).

⚠️ **The transcript's `entrypoint` decides resumability, and the *child's environment*
decides the entrypoint** — so `launch()` strips `CLAUDE_CODE_ENTRYPOINT` from the env it
hands the child. A server started from inside another Claude Code context (a desktop-app
terminal, a Claude-driven shell) carries that marker, and a child that inherited it
stamped it into the transcript instead of `sdk-cli` — losing the `dashboard` pill and
refusing to resume. Observed directly during this feature's verification (with the
variable: `claude-desktop`; without: `sdk-cli`), then fixed at the spawn site rather than
left as a "run from a plain shell" footnote, because the wrong stamp is silent until the
day a resume fails. The strip covers only sessions this dashboard launches: transcripts
written *before* the fix by a marker-carrying server stay `local` and stay unresumable —
the stamp is in the file, not recomputed.

## A spawned row says `dashboard`

Once the launch is adopted it is an ordinary row — which was the problem: nothing on it
said that this session appears in **no other list**, not the desktop app's sidebar (RC or
not), not `claude.ai`. So `Session.surface`
(`local | dashboard | cloud`) carries that, and a `sdk-cli` transcript — what `-p` writes
— renders a cyan `dashboard` pill on the row and in the chat drawer's header.

It is derived from the transcript's `entrypoint` field, not from this module's store: the
store drops an entry at adoption by charter, and a mark that vanished three seconds after
launch (or on the next `tsx watch` restart) would be worse than none. The consequence is
that `dashboard` means *headless*, not *launched here* — any other SDK launcher on this
machine reads the same, and the pill's claim is still true for it. Full rules, including
why the newest record wins, are in [session-surfaces](session-surfaces.md#what-the-dashboard-says-about-it-the-dashboard-pill).

## The permission ladder, and where the ceiling lives

Four permission modes, lowest to highest:

```
plan  <  acceptEdits  <  auto  <  bypassPermissions
```

(`PERMISSION_MODES` in `server/lib/spawn.ts` — array-index order **is** the
ordering). `manual` and `dontAsk` aren't in the enum at all: `manual` stalls headless by
definition — there is no TTY for it to prompt into — and `dontAsk`'s headless behavior
was never verified. This is a **policy** ladder, not a claim that each mode is a strict
superset of the one below: `acceptEdits` auto-approves edits but still stalls headless
on the first Bash prompt, while `auto` classifies both. It's ordered by how much
unattended damage a launch under that mode can do.

Two independent inputs feed `clampPermission(requested, ceiling)` (`spawn.ts`): what
the launch form asked for, and `config.spawnMaxPermission` — the `SPAWN_MAX_PERMISSION`
env var, defaulting to `auto`. The function returns whichever is *lower* on the ladder,
and an unrecognized value on **either side** — including `undefined` — falls back to
`auto` rather than to the top, so a malformed value can only ever make the result less
permissive, never more. The ceiling is what actually bounds the feature's blast radius:
raise it to `bypassPermissions` and a launch runs fully unsandboxed with no prompts at
all; leave it at the default and the worst a browser can ask for is `auto`.

⚠️ **A typo here used to fail open.** `SPAWN_MAX_PERMISSION` is validated at
config-load time by `toPermissionMode` (`config.ts`), which sits beside the existing
`toPosInt`/`toBool` coercers but behaves differently on purpose: an unrecognized value
doesn't silently become the fallback the way a bad `MAX_SESSIONS` would — it still falls
back to `auto`, but it also `console.warn`s naming the bad value. This is the one knob
that bounds the whole feature's blast radius, and `SPAWN_MAX_PERMISSION=Plan` (capital
P, a plausible typo) used to reach a bare cast straight to `PermissionMode` — which
meant the ceiling *silently rose* from an intended `plan` to `auto`, two rungs up the
ladder, in the permissive direction, with nothing printed anywhere. An absent or empty
value is still the ordinary "unset" case and stays silent, the same "empty means
default" rule every other optional value in `config.ts` follows — the warning is only
for a value that's *present and wrong*.

The client never gets to discover the ceiling by trial and error: `HealthResponse`
carries both `spawnAvailable` (is the feature on at all) and `spawnMaxPermission` (the
ceiling itself — not a secret, a policy value), and `SpawnPanel`'s permission `<select>`
(`allowedPermissionModes` in `client/src/lib/spawnOptions.ts`) lists only modes at or
below it. The alternative — offering all four and letting the server silently downgrade
the choice — was tried and rejected during review: a user picking `bypass permissions`
and quietly getting `auto` back with no feedback is worse than not offering the choice
at all.

## Project selection is a membership check, never a path

`SpawnRequest.project` is a `dirName`, resolved through the same `resolveProject`
[management](management.md) already uses for its own `dirName` query param, against
`listRecentProjects`'s enumerated list (`server/lib/management.ts`) — never
joined into a filesystem path. An unknown name is a 400, not a lookup that might escape
somewhere unexpected. The project's `cwd` (read off its own most-recent transcript, not
user input — its launch cwd, not whatever that session later chdir'd into) becomes the
child's working directory; there is no free-text cwd field, on
purpose — it would violate this exact guarantee.

## The store's charter — deliberately narrow

`server/lib/spawn.ts` keeps a RAM-only map of launches still being watched. Its entire
job: **explain the first few seconds of a launch, and report ones that never became a
real session.** It is explicitly not a session registry — the transcript stays the
single source of truth, the same division that keeps `pending.ts`/`plans.ts`/
`messages.ts` small.

- **Two *public* states.** `LaunchingSession.state` is `'launching' | 'failed'` — there
  is still no `'adopted'` value on the wire. Internally the entry now has a third,
  `'running'`, which adoption transitions it *into* rather than deleting it (see
  [Stopping a spawned session](#stopping-a-spawned-session)); `listLaunching` skips those
  entirely and `toPublic` is never called for one, so the shared contract is unchanged.
  `serveSessions` calls `adoptLaunched(ids)` with the freshly-scanned session ids before
  it calls `listLaunching()`, so an id that just showed up on disk stops being reported as
  `launching` in the same response.
- **No reaper — unlike the other three stores.** `pending.ts`, `plans.ts`, and
  `messages.ts` each run their own timer, because something has to fire even when
  nobody is reading. This store has no timer at all: `listLaunching(now)`
  (`spawn.ts`) evaluates expiry lazily, on the same call the client already makes
  every 3 seconds. `LAUNCH_TTL_MS` (60s) ends a `launching` entry nothing ever adopted —
  *promoting* it to `running` if its child is still alive, deleting it only if the child
  is gone; `FAIL_TTL_MS` (5 min) drops a `failed` one so a phone that never looks doesn't
  accumulate them. Nothing needs to fire without a reader, so nothing does. The one
  exception is the SIGKILL escalation a stop arms — `unref()`ed, and cleared the moment
  the child exits on its own.
- **Failure is idempotent and can arrive from four places.** A synchronous throw from
  the spawner, the child's own `'error'` event (e.g. a typo'd `CLAUDE_BIN` — an async
  ENOENT the cached probe can't catch), an `'error'` on the `stdin`/`stderr` streams
  themselves (each stream is its own `EventEmitter`; an unhandled `'error'` there takes
  the whole dashboard process down independently of the child's own handler), and a
  nonzero or signal-killed `'exit'`. All four route through the same `fail()`
  (`spawn.ts`), which no-ops if the entry is already gone — so a failure event
  arriving after a stop can never resurrect a deleted entry. A `running` entry is
  **deleted before `fail()` is consulted at all**: a session that worked for an hour and
  then exited nonzero is over, not a launch that failed, and reporting it as one would put
  a red phantom row on the board for something that plainly worked.
- **A clean exit is left alone.** Exit code 0 before adoption doesn't mark the entry
  failed — a fast run (a one-line haiku prompt, say) can finish before the next scan
  ever sees it, and at that point the transcript is what matters, not the exit. The
  entry just sits `launching` until adoption or the TTL catches it.
- **`PROMPT_PREVIEW_CAP` (120 chars) and `STDERR_TAIL_CAP` (2048 chars) bound the
  store's memory** regardless of prompt length or how much a crashing process writes to
  stderr. The full, untruncated prompt still reaches the child's stdin — only the
  store's own display copy is cut.

## Stopping a spawned session

**A session this dashboard spawned can be stopped from its row, at any point in its life** —
not just during the ~3s pre-adoption window the original endpoint reached. Expand the row and
the control is under the panel: `stop session`, then `really stop?`.

### The lifecycle: `launching → running → gone`

The store keeps the live `ChildProcess` handle for as long as the child lives. That is the
whole of the widening, and it is what makes a later stop possible at all.

| From | To | Trigger |
|---|---|---|
| `launching` | `running` | `adoptLaunched(ids)` sees the id on disk — **non-resume launches only** |
| `launching` | `running` | `listLaunching(now)` passes `LAUNCH_TTL_MS` **and the child is still alive** |
| `launching` | deleted | past `LAUNCH_TTL_MS` with the child already gone |
| `running` | deleted | the child's `'exit'`/`'close'`, whatever the code |

**Two routes in, and the split is load-bearing.** A resume's id names a transcript that
existed *before* its child did, so seeing it in a scan proves nothing about the process —
adopting on the first poll would swallow a launch failure the user never got to see. Resume
entries therefore keep their `adoptLaunched` skip and reach `running` from the TTL end
instead. **Consequence, accepted and stated: a resumed session is not stoppable for its
first `LAUNCH_TTL_MS` (60 s).** The TTL route also stops a non-resume launch the scan window
never happened to show from silently losing its handle.

A `running` entry is never reported by `listLaunching` (it already has a real row from the
scan — a second one would be a phantom) and is never TTL'd (its handle is the point; it
leaves when the child exits, not when a clock runs out).

**One id can name two children, so no handler trusts an id alone.** A resume reuses the
transcript's id on purpose, and the store is keyed by id — it cannot hold two entries for
one session. Every handler `launch` registers closes over the *id* and re-looks the entry up
when it fires, so a first child's late `'exit'` would otherwise reach whatever entry that id
names by then and delete it, taking a live, working session's handle with it. Two guards:

- `serveSpawn` refuses the second launch in the first place — `hasLiveChild(rid)` → 409
  `session is still running`. A held question/plan/reply socket was never the only way to be
  alive; a session mid-tool-call, or lingering after its turn, holds nothing at all.
- `dropIfRunning` and `fail` take the child they were registered for and no-op unless
  `entry.child === child`. Defence in depth, and it makes every handler immune to id reuse
  rather than only the path the guard covers.

What the CLI itself does with two writers on one transcript is a separate, open question —
`bug-19`.

### One guarded helper does every signal

`signalGroup` is the only thing that signals a process *group*, and it refuses unless
**all four** hold. (It is not the only signal in the codebase: `stopSession`'s `launching`
branch kills the handle alone — see [The two routes](#the-two-routes).)

| Clause | Why |
|---|---|
| `typeof pid === 'number'` | an absent pid coerces to 0 — see the next row |
| **`pid > 1`** | POSIX `kill(0, sig)` signals **every process in the caller's own group** — with a pid of 0 that is this dashboard *and the terminal that started it*. `1` is init. |
| `exitCode === null` | the child has not already been reaped |
| `signalCode === null` | …nor already been killed; each code covers a different kind of death, so either alone misreads the other as still-alive |

The pid is negated in exactly one line, so `process.kill(-pid, …)` reaches the CLI *and*
everything it started. `test/spawn.test.ts` mutation-proves both the `pid > 1` clause and the
liveness clause: with `pid > 1` removed, the suite goes red showing the killer called with
`pid: -0`.

The rule the whole feature rests on: **only ever signal a process this server spawned and
still holds a handle to.** No pid from a request body, no `ps` scan.

### SIGTERM, then SIGKILL after `STOP_GRACE_MS`

`stopSession` records the request, SIGTERMs the group and arms a 5-second escalation to
SIGKILL. A second tap is idempotent — it re-signals nothing and does not push the deadline
back. `escalateStop` fires only if the entry still exists, is `running`, was actually asked
to stop, the grace has elapsed, and the child is still alive.

`STOP_GRACE_MS` is an exported constant, not a config setting, for the reason `LAUNCH_TTL_MS`
and `MAX_LAUNCHING` are: an env var would drag `.env.example`, `README.md`,
`docs/workflows/configuration.md` and `config.ts` along for a number nobody tunes. 5 seconds,
not 30: the grace is not "let real work finish" — the user pressed Stop — it is only "let the
CLI flush and exit on SIGTERM before we SIGKILL it".

**Measured, not assumed** (2026-09-05, this machine, one real `claude -p` per run):

| Signal to `-pgid` | Group at signal time | Fully reaped in |
|---|---|---|
| `SIGTERM` | 6 processes — the CLI, Playwright MCP, 2 codegraph binaries, 2 node | **1101 ms** |
| `SIGKILL` | 6 processes, same shape | **585 ms** |

So the group negation does reach MCP servers and tool grandchildren, and the CLI honours
SIGTERM comfortably inside the 5-second grace — the escalation is cover for a hang, not the
normal path. This closes the "grandchildren survive a stop" gap the pre-adoption endpoint
documented as the spec's Risk 3.

### `stopState`, and why it is absent rather than false

`stopStates()` is injected into the scan the same way `messageSessionIds()` is, and
`Session.stopState` is set only for ids it holds. **Absent means not stoppable**, which is
the honest encoding for three real cases: a terminal-started session (nothing here ever had
its pid), a resume inside its 60-second window, and anything spawned before the last
dashboard restart. The UI renders no Stop control in any of them — offering one that could
not work would be worse than offering none.

Note one poll of latency by construction: `serveSessions` scans *then* adopts, so a freshly
spawned row carries no `stopState` until the following poll. That ordering exists so a launch
is never reported as both a `launching` phantom and a real row in one response.

⚠️ **The restart hole stands, and is now surfaced instead of hidden.** The handle lives only
in this process's RAM. `detached: true` + `unref()` is deliberate — `pnpm dev` runs `tsx
watch` and restarts the API on every file save, and a long unattended run should survive
that — so there is **no shutdown reaper**, and killing spawned children on restart would be a
regression, not a fix. Persisting pids instead was refused: pids are reused, a stale record
is indistinguishable from a live one, and the failure mode is signalling an innocent process.
After a restart the row simply carries no `stopState` and shows no button; ending that
process is a terminal job (`kill <pid>`).

### The two routes

`POST /api/sessions/:id/stop` is what the button calls. `POST /api/spawn/:id/stop` keeps its
route and its documented behaviour but now delegates to the same `stopSession`, so there are
two endpoints and one behaviour.

- An **absent or empty body is normal**, not a 400 — the common request is a bare POST. Only
  a body that is present *and* unparseable is refused.
- `force` is honoured on a strict `=== true`, the same rule `remoteControl` and the dismiss
  flag follow. `{"force":"yes"}` takes the graceful path: a coerced truthy value is not
  evidence the caller meant to skip the grace and SIGKILL.
- `'not-found'` → 404, `'stopped'` → 200 `{stopped:true}`, `'stopping'` → 200 `{stopping:true}`.

Stopping a still-`launching` entry is unchanged: SIGTERM the *handle* (not the group) and
delete the entry immediately, so a launch the user stopped vanishes rather than lingering as
a `failed` row for `FAIL_TTL_MS`, labelled as an error they never actually hit.

## The pieces

| Piece | What it does |
|---|---|
| `server/lib/spawn.ts` | pure `buildSpawnArgs`/`clampPermission`/`parseSpawnRequest`, plus the impure `probeSpawn`/`launch`/`listLaunching`/`adoptLaunched`/`stopSession`/`forceStopSession`/`escalateStop`/`stopStates`/`hasLiveChild` and the RAM-only store |
| `POST /api/spawn` | `serveSpawn` — validates, resolves the project, launches, returns `{sessionId}` immediately |
| `POST /api/spawn/:id/stop` | `serveSpawnStop` — SIGTERM + delete for a `launching` entry; delegates to `stopSession` |
| `POST /api/sessions/:id/stop` | `serveSessionStop` — the row button's route; graceful by default, `{force:true}` for SIGKILL |
| `client/src/lib/stopControl.ts` | the pure decision function behind the Stop control: render or not, the label, and which POST it sends |
| `client/src/hooks/useStopSession.ts` | POSTs the stop, same bearer-token pattern as `useSpawn` |
| `serveSessions` wiring | calls `adoptLaunched(ids)` then `listLaunching()` before every `/api/sessions` response, so `launching` rides the poll the client already makes |
| `serveHealth` wiring | publishes `spawnAvailable` (`probeSpawn`) and `spawnMaxPermission` (`config.spawnMaxPermission`) |
| `client/src/components/SpawnPanel.tsx` | the launch form — project picker, prompt textarea with the reply composer's own `MicButton` in its action row, name/model/effort/permission selects; own lazy chunk, cyan chrome (a compose surface opened on purpose, not a hold waiting on you) |
| `client/src/hooks/useSpawn.ts` | POSTs the request, the same bearer-token pattern as `useRemoteAnswer`'s toggle |
| `client/src/lib/spawnOptions.ts` | the client's copy of `MODELS`/`EFFORTS`/`PERMISSION_MODES` (duplicated, not imported — the FE/BE boundary is `shared/types.ts` alone — kept honest by `test/spawn-options.test.ts` asserting byte-for-byte equality against the server's arrays) and `allowedPermissionModes` |
| Toolbar's `+ New` | rendered only when `spawnAvailable` is true on the one `/api/health` poll `SessionsView` already owns |
| `SessionList`'s phantom row | renders each `launching` entry above the real rows — project, truncated prompt, `starting…` or (for `failed`) the error — and disappears on its own once the real row adopts the id; never interactive |
| `sessionSurface` (`server/lib/scan.ts`) | maps the transcript's `entrypoint` → `Session.surface`; `sdk-cli` ⇒ `dashboard`, everything else ⇒ `local` |
| `client/src/components/ResumePanel.tsx` | the resume composer pinned in an ended dashboard session's chat drawer — textarea + mic + *resume session*, POSTing `useSpawn().launch({prompt, resume: id})` |
| `client/src/lib/resume.ts` | `resumeEligible` — the pure gate deciding when the drawer offers that composer (dashboard surface, nothing pending, turn over, spawn available); unit-tested like every other client lib |
| `client/src/lib/surface.ts` | the pill's label + tooltip, one copy shared by `SessionRow` and the `ChatDrawer` header |

## Endpoints

| Method | Path | Codes |
|---|---|---|
| `POST` | `/api/spawn` | 200 `{sessionId}` (`SpawnResponse`); 400 malformed body / unknown project / empty or oversized prompt / bad or unknown `resume` id / non-dashboard resume target / resume target with no recorded cwd; 403 bad token; 404 remote answers off *or* feature off; 409 resume of a still-running or already-resuming session; 429 `MAX_LAUNCHING` launches already in flight; 500 spawn threw |
| `POST` | `/api/spawn/:id/stop` | 200 `{stopped: true}` for a still-`launching` entry, or `{stopping: true}` if that id has since become a running session (it delegates to `stopSession`); 400 bad id shape; 403 bad token; 404 remote answers off *or* no live launch for that id |
| `POST` | `/api/sessions/:id/stop` | 200 `{stopping: true}` (graceful) or `{stopped: true}` (`{"force": true}`); 400 bad id shape, bad path encoding, *or* a present-but-unparseable body — an absent/empty body is normal; 403 bad token; 404 remote answers off *or* no live session for that id; 405 + `Allow: POST` for any other method |

All three gated by the same `tokenOk` (`api.ts`) the other three write paths use — an
unset `ANSWER_TOKEN` leaves them open, matching the rest of the app's LAN-trust posture —
and by the same remote-answer toggle (below).

**The concurrency cap.** `MAX_LAUNCHING` (4, in `server/lib/spawn.ts` beside the other
caps) is checked before the request body is even read, the same pre-buffer refusal
`serveTranscribe` makes with `isTranscribing()`. It is **not** a security boundary — a
caller with launch rights can simply prompt one session into spawning more — it is the
only rail against an *accident*: a retry loop, a flaky phone connection, a double-tap
that beats React's re-render. Each launch is a real `claude` process on the account's real
quota, and nothing else bounds the count: the store's only reaper is a client poll, and
the client's own guard is a `pending` flag in one browser tab.

What it counts is narrow on both axes, and both are deliberate:

- **`'launching'` rows only.** `listLaunching()` also returns `failed` ones — they linger
  for `FAIL_TTL_MS` (5 minutes) purely so the UI can explain itself, and they hold no
  process. Letting them hold a slot would lock a user out of launching for five minutes
  after four transient failures, behind a 429 that explains nothing. The rail bounds
  concurrent *processes*, so it counts those.
- **The pre-adoption window only** — the ~3s until `adoptLaunched` sees the id on disk. So
  it bounds **rapid-fire POSTs**, not live sessions: ten launches a minute apart all
  succeed, because each has left the store before the next arrives. Capping live sessions
  would need the session registry this store deliberately is not.

`serveSpawn`'s check order: is the switch on (`getState`) → is the feature configured
(`probeSpawn`) → who's asking (`tokenOk`) → is anything already in flight
(`MAX_LAUNCHING`) → is the request usable (`parseSpawnRequest`, pure — it also decides
fresh-vs-resume) → then the filesystem step for the chosen shape: `resolveProject` for a
fresh launch, the transcript hunt plus liveness checks for a resume. Parse moving ahead
of `resolveProject` is deliberate (cheapest first), so a fresh request with both a bad
prompt and an unknown project now reports the prompt. Note that the probe runs *before* the token check,
which is the opposite of `serveTranscribe`'s documented order — and that divergence is
harmless rather than principled, so **neither one should be "corrected" into matching the
other**: `GET /api/health` already publishes `spawnAvailable` unauthenticated and already
calls the same memoised `probeSpawn`, so probe-first here reveals nothing that route
doesn't and spawns no extra process. Both handlers carry a comment saying so. From the
token check onward the order does earn itself, cheapest and least-revealing first.

Only the prompt can fail the request outright — non-blank after trimming, and at most
`PROMPT_CAP` (4000 characters, the same cap `messages.ts`'s `TEXT_CAP` sets for a reply).
An unrecognized `model`, `effort`, `name`, or `permissionMode` is dropped or clamped
rather than rejected, so a client sending a field this server version doesn't recognize —
an older build, or a newer one — still launches with the rest of the request honored. A
`name` must also *start* with a letter or digit, so a name can never itself look like a
flag (`-p` used to pass the charset and become the value of `-n`).

⚠️ **Route order.** `/api/spawn/:id/stop` is matched by an anchored regex checked
*above* the exact-string `/api/spawn` check in `index.ts` — the same trap the
chat/question/plan/message routes further down all document, kept defensive here even
though a plain `===` can't itself be prefix-swallowed the way a looser regex could.

## ⚠️ The `decodePath` fix reaches beyond this feature

`decodeURIComponent` throws a synchronous `URIError` on malformed percent-encoding (a
lone `%ZZ`) — and this process has no `uncaughtException` handler anywhere. Before this
branch, `POST /api/spawn/%ZZ/stop` (or the identical shape against any other `:id`
route) crashed the entire dashboard process, unauthenticated, before `tokenOk` or any
handler ever ran.

The fix is a single `decodePath(raw): string | null` helper (`index.ts`, try/catch
around `decodeURIComponent`, `400 {error: 'bad path encoding'}` on failure) — but it was
applied at **all nine** sites in `index.ts` that pull an id out of a URL, not just the
one this feature added: `/api/spawn/:id/stop` plus the eight pre-existing
`question`/`answer`/`plan`/`plan-answer`/`message`/`message-answer`/`chat`/detail routes
under `/api/sessions/:id`. Eight of those nine predate this feature entirely. Writing
the helper for the one route this branch added and leaving eight identical crash
vectors in place would not have been a defensible scope boundary — every one of them was
reachable by the same unauthenticated crash, so this branch carries a security fix
wider than its own feature.

## Known unknown: soft-denied tool calls with no TTY

`auto` mode was verified to complete headless without stalling — three probes (`git
push`, `sudo -n true`, an out-of-scope `/etc` write) all finished with
`permission_denials: []`, because every one of them was either allowed outright or
refused by the model itself before ever reaching the permission layer. What was **not**
observed, in this implementation or its verification: what happens when the permission
layer itself *denies* a tool call headless, with no TTY to fall back to. That's recorded
here rather than papered over. If a soft-denied call turns out to stall rather than let
the model continue, the practical effect is small — the session simply sits `idle`
instead of finishing, shows up as an ordinary idle row like any stuck session, and the
stop endpoint above ends it. Degrades, does not wedge.

## Security posture

This is the widest write surface in the app, in the same plain terms
[remote-message](remote-message.md#security-posture) uses for its own: with the feature
on and a leaked `ANSWER_TOKEN` (or none set at all, its default), anyone who can reach
this dashboard can start a real Claude Code session — running real tools, in a real
project directory — on this machine. That is a materially different thing from the
other three write paths, which can only ever act on a session that is already running
and already asked for something. It is the honest reading of what "spawn" means, not an
edge case of it.

Four things bound it, and none of them is new machinery — they're the same posture the
rest of the app already takes, aimed at a bigger target:

- **The remote-answer toggle covers it, like every other write path.**
  `serveSpawn`, `serveSpawnStop` and `serveSessionStop` all answer
  `404 {error: 'remote answers disabled'}` when
  `getState(config).remoteAnswer` is false — flipping the toolbar pill off, or setting
  `REMOTE_ANSWER=false`, turns launching off with it. That is the app's only *runtime*
  kill switch (`CLAUDE_BIN` is restart-scoped), so a switch that excluded the widest write
  path would have been worse than none: the user reaches for the pill when the posture
  changes — leaving the house, joining a café network — and infers coverage. It also kept
  the new panel internally coherent, since the `MicButton` inside `SpawnPanel` POSTs
  `/api/transcribe`, which was already gated: with the pill off, the mic 404'd while the
  Launch button beside it still fired. Note what this is *not*: an auth boundary.
  `REMOTE_ANSWER` defaults to `true`, and anyone who can flip the pill off can flip it back
  on. `HealthResponse.spawnAvailable` stays a pure capability probe (`probeSpawn`,
  `CLAUDE_BIN` alone) and is deliberately *not* ANDed with the toggle — same split
  `transcribe` uses on that same payload, where the mic hides on capability and 404s on
  policy.
- **Off by default.** `CLAUDE_BIN` is empty out of the box — the same "unset means off"
  rule `NTFY_TOPIC` and `WHISPER_MODEL` already follow. A fresh clone cannot spawn
  anything until an operator deliberately names a binary.
- **The ceiling, not the request, decides how much damage a launch can do.**
  `SPAWN_MAX_PERMISSION` defaults to `auto` — real tool use, but not
  `bypassPermissions`. Reaching fully unsandboxed execution needs the host owner to
  raise the ceiling on purpose; the browser can never ask its way there.
- **`ANSWER_TOKEN`, same as the other three.** Empty leaves it open, matching this
  app's LAN-trust posture everywhere else; the tailnet remains the intended perimeter —
  set a token if you share it, and treat the token as the minimum behind a public
  tunnel. See [remote-access](remote-access.md).

## Accepted limits (deferred on purpose)

Each of the following was considered during design and deliberately left out of this
feature rather than overlooked — the next reader shouldn't re-litigate them without a
new reason:

- **No `--worktree` isolation.** Would keep a phone-launched session off your dirty
  tree; deferred so v1 has one spawn path, not two.
- **No budget cap (`--max-budget-usd`).** A real rail on an unattended run; not shipped
  unless a runaway actually happens.
- **No streamed output.** The transcript is the output, and the chat drawer already
  renders it — `--output-format stream-json` would be a second rendering path for the
  same bytes.
- **No *fresh* spawn from an existing session row.** The toolbar is still the only way to
  start a *new* session, and rows themselves stay read-only. Continuing an *ended*
  dashboard session from its chat drawer is a different thing, and it now exists — see
  [resume](#resuming-an-ended-session-resume).
- **A stopped launch and an orphaned one are not symmetric.** See [the stop endpoint's
  restart hole](#stopping-a-spawned-session) above — a detached child
  outlives a server restart by design, but the store that could `stop` it does not.

<!-- docs-sync:
  sources:
    - server/lib/spawn.ts
    - server/api.ts
    - server/index.ts
    - server/lib/config.ts
    - server/lib/scan.ts
    - server/lib/transcript.ts
    - shared/types.ts
    - client/src/components/SpawnPanel.tsx
    - client/src/components/ResumePanel.tsx
    - client/src/components/ChatDrawer.tsx
    - client/src/components/SessionList.tsx
    - client/src/components/SessionRow.tsx
    - client/src/hooks/useSpawn.ts
    - client/src/hooks/useStopSession.ts
    - client/src/lib/resume.ts
    - client/src/lib/stopControl.ts
    - client/src/lib/spawnOptions.ts
    - client/src/lib/surface.ts
  kind: subsystem
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
