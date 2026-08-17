---
docs-sync:
  sources:
    - server/lib/spawn.ts
    - server/api.ts
    - server/index.ts
    - server/lib/config.ts
    - shared/types.ts
    - client/src/components/SpawnPanel.tsx
    - client/src/components/SessionList.tsx
    - client/src/hooks/useSpawn.ts
    - client/src/lib/spawnOptions.ts
  kind: subsystem
  verified: ec2199b331e84448c99723d9a17c3860bf27aeb2
---

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
headless run looks like any other run to the hooks that matter. "For free" means
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
  `launch` (`server/lib/spawn.ts:313`) hand back a session id the instant the child is
  spawned — before any transcript exists — so the client can set its chat-drawer deep
  link to that id immediately (`SessionsView.tsx`'s `onLaunched` sets `chatId` right
  from the POST response). The drawer itself still waits: `chatSession`
  (`SessionsView.tsx:44`) resolves by finding that id in the next `/api/sessions` poll,
  so it opens once the transcript actually exists, not before — there's nothing to
  render before then, but the *id* is known and correct from the first response.
- **A prompt on stdin is never parsed as a flag.** `claude -p` reads argv the way
  nearly every CLI does: a value starting with `-`/`--` is a flag, never data,
  regardless of what it follows — a prompt beginning `--` passed *positionally* would be
  read as one. Measured directly: piping the prompt `--version is not a flag here; just
  reply with the single word OK` to `claude -p …` on stdin produced the reply `OK`, not
  a CLI-flag error. That's why `buildSpawnArgs` (`server/lib/spawn.ts:161`) never puts
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

## The permission ladder, and where the ceiling lives

Four permission modes, lowest to highest:

```
plan  <  acceptEdits  <  auto  <  bypassPermissions
```

(`PERMISSION_MODES` in `server/lib/spawn.ts:53` — array-index order **is** the
ordering). `manual` and `dontAsk` aren't in the enum at all: `manual` stalls headless by
definition — there is no TTY for it to prompt into — and `dontAsk`'s headless behavior
was never verified. This is a **policy** ladder, not a claim that each mode is a strict
superset of the one below: `acceptEdits` auto-approves edits but still stalls headless
on the first Bash prompt, while `auto` classifies both. It's ordered by how much
unattended damage a launch under that mode can do.

Two independent inputs feed `clampPermission(requested, ceiling)` (`spawn.ts:90`): what
the launch form asked for, and `config.spawnMaxPermission` — the `SPAWN_MAX_PERMISSION`
env var, defaulting to `auto`. The function returns whichever is *lower* on the ladder,
and an unrecognized value on **either side** — including `undefined` — falls back to
`auto` rather than to the top, so a malformed value can only ever make the result less
permissive, never more. The ceiling is what actually bounds the feature's blast radius:
raise it to `bypassPermissions` and a launch runs fully unsandboxed with no prompts at
all; leave it at the default and the worst a browser can ask for is `auto`.

⚠️ **A typo here used to fail open.** `SPAWN_MAX_PERMISSION` is validated at
config-load time by `toPermissionMode` (`config.ts:153`), which sits beside the existing
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
(`allowedPermissionModes` in `client/src/lib/spawnOptions.ts:61`) lists only modes at or
below it. The alternative — offering all four and letting the server silently downgrade
the choice — was tried and rejected during review: a user picking `bypass permissions`
and quietly getting `auto` back with no feedback is worse than not offering the choice
at all.

## Project selection is a membership check, never a path

`SpawnRequest.project` is a `dirName`, resolved through the same `resolveProject`
[management](management.md) already uses for its own `dirName` query param, against
`listRecentProjects`'s enumerated list (`server/lib/management.ts:344,377`) — never
joined into a filesystem path. An unknown name is a 400, not a lookup that might escape
somewhere unexpected. The project's `cwd` (read off its own most-recent transcript, not
user input) becomes the child's working directory; there is no free-text cwd field, on
purpose — it would violate this exact guarantee.

## The store's charter — deliberately narrow

`server/lib/spawn.ts` keeps a RAM-only map of launches still being watched. Its entire
job: **explain the first few seconds of a launch, and report ones that never became a
real session.** It is explicitly not a session registry — the transcript stays the
single source of truth, the same division that keeps `pending.ts`/`plans.ts`/
`messages.ts` small.

- **Two states only.** `LaunchingSession.state` is `'launching' | 'failed'` — there is
  no `'adopted'` value. "Adopted" isn't a state an entry moves through; it's the entry
  being *deleted*. `serveSessions` calls `adoptLaunched(ids)` with the freshly-scanned
  session ids before it calls `listLaunching()`, so an id that just showed up on disk is
  removed from the store in the same response that would otherwise still call it
  `launching`.
- **No reaper — unlike the other three stores.** `pending.ts`, `plans.ts`, and
  `messages.ts` each run their own timer, because something has to fire even when
  nobody is reading. This store has no timer at all: `listLaunching(now)`
  (`spawn.ts:400`) evaluates expiry lazily, on the same call the client already makes
  every 3 seconds. `LAUNCH_TTL_MS` (60s) drops a `launching` entry nothing ever adopted;
  `FAIL_TTL_MS` (5 min) drops a `failed` one so a phone that never looks doesn't
  accumulate them. Nothing needs to fire without a reader, so nothing does.
- **Failure is idempotent and can arrive from four places.** A synchronous throw from
  the spawner, the child's own `'error'` event (e.g. a typo'd `CLAUDE_BIN` — an async
  ENOENT the cached probe can't catch), an `'error'` on the `stdin`/`stderr` streams
  themselves (each stream is its own `EventEmitter`; an unhandled `'error'` there takes
  the whole dashboard process down independently of the child's own handler), and a
  nonzero or signal-killed `'exit'`. All four route through the same `fail()`
  (`spawn.ts:285`), which no-ops if the entry is already gone — so a failure event
  arriving after `adoptLaunched` (or after `stopLaunch`) can never resurrect a deleted
  entry.
- **A clean exit is left alone.** Exit code 0 before adoption doesn't mark the entry
  failed — a fast run (a one-line haiku prompt, say) can finish before the next scan
  ever sees it, and at that point the transcript is what matters, not the exit. The
  entry just sits `launching` until adoption or the TTL catches it.
- **`PROMPT_PREVIEW_CAP` (120 chars) and `STDERR_TAIL_CAP` (2048 chars) bound the
  store's memory** regardless of prompt length or how much a crashing process writes to
  stderr. The full, untruncated prompt still reaches the child's stdin — only the
  store's own display copy is cut.

## The stop endpoint, and its restart hole

`POST /api/spawn/:id/stop` (`serveSpawnStop`, `api.ts:826`) sends `SIGTERM` to the live
child behind a still-`launching` entry and deletes the entry immediately — it does not
transition it to `failed`. That's deliberate: `LaunchingSession.state` is a
shared-contract type the client already consumes, and widening it to a third value just
to say "you stopped this" would drift that contract for one row's worth of nuance. The
tradeoff is real: a stop that races the child's own crash shows nothing in the UI rather
than the crash reason, because there is no way to tell "you stopped it" from "it was
never here" once the entry is gone. The later `exit`/`close` event for that id finds no
entry and no-ops through `fail`'s presence guard.

**What stop does not reach: grandchildren.** The signal goes to the `claude` process
itself (`child.kill('SIGTERM')`), not to its process group — so anything that session had
already started keeps running. Under `auto` that is a live possibility: a `Bash` tool call
mid-`npm install`, a test run, a dev server it launched. This is what the spec asked for
("SIGTERM to the stored child") and it is compliant, not a bug — but if you tap stop and
then find a process still going, that is why. `detached: true` made the child a group
leader, so the thorough version (`process.kill(-pid, 'SIGTERM')`) is available to whoever
decides that killing a whole tree from a phone is the behaviour they want; it was not
specified here, and orphaned grandchildren are the spec's own Risk 3. Ending them is a
terminal job today.

⚠️ **The pid lives only in this process's RAM.** It is never written to disk, so after
a server restart the store's entries — and with them, every live child's pid — are
gone, even though the real `claude` process may still be running. It was spawned
`detached` and `unref`'d precisely so a dev-server reload wouldn't kill it (`pnpm dev`
runs `tsx watch`, which restarts the API on every file save, and a long unattended run
should survive that). `POST /api/spawn/:id/stop` on that id now 404s. Killing the
orphaned process at that point is a terminal job (`kill <pid>`), not something this
endpoint can reach anymore. This is the mirror image of the other stores' restart
story: there, a restart ends something that was going to end anyway (a held turn just
stops); here, the restart doesn't end anything — the child correctly keeps running — it
just costs you the ability to stop it remotely. Named and accepted, not fixed.

## The pieces

| Piece | What it does |
|---|---|
| `server/lib/spawn.ts` | pure `buildSpawnArgs`/`clampPermission`/`parseSpawnRequest`, plus the impure `probeSpawn`/`launch`/`listLaunching`/`adoptLaunched`/`stopLaunch` and the RAM-only store |
| `POST /api/spawn` | `serveSpawn` — validates, resolves the project, launches, returns `{sessionId}` immediately |
| `POST /api/spawn/:id/stop` | `serveSpawnStop` — SIGTERM + delete |
| `serveSessions` wiring | calls `adoptLaunched(ids)` then `listLaunching()` before every `/api/sessions` response, so `launching` rides the poll the client already makes |
| `serveHealth` wiring | publishes `spawnAvailable` (`probeSpawn`) and `spawnMaxPermission` (`config.spawnMaxPermission`) |
| `client/src/components/SpawnPanel.tsx` | the launch form — project picker, prompt textarea with the reply composer's own `MicButton` in its action row, name/model/effort/permission selects; own lazy chunk, cyan chrome (a compose surface opened on purpose, not a hold waiting on you) |
| `client/src/hooks/useSpawn.ts` | POSTs the request, the same bearer-token pattern as `useRemoteAnswer`'s toggle |
| `client/src/lib/spawnOptions.ts` | the client's copy of `MODELS`/`EFFORTS`/`PERMISSION_MODES` (duplicated, not imported — the FE/BE boundary is `shared/types.ts` alone — kept honest by `test/spawn-options.test.ts` asserting byte-for-byte equality against the server's arrays) and `allowedPermissionModes` |
| Toolbar's `+ New` | rendered only when `spawnAvailable` is true on the one `/api/health` poll `SessionsView` already owns |
| `SessionList`'s phantom row | renders each `launching` entry above the real rows — project, truncated prompt, `starting…` or (for `failed`) the error — and disappears on its own once the real row adopts the id; never interactive |

## Endpoints

| Method | Path | Codes |
|---|---|---|
| `POST` | `/api/spawn` | 200 `{sessionId}` (`SpawnResponse`); 400 malformed body / unknown project / empty or oversized prompt; 403 bad token; 404 remote answers off *or* feature off; 429 `MAX_LAUNCHING` launches already in flight; 500 spawn threw |
| `POST` | `/api/spawn/:id/stop` | 200 `{stopped: true}`; 400 bad id shape; 403 bad token; 404 remote answers off *or* no live launch for that id |

Both gated by the same `tokenOk` (`api.ts:389`) the other three write paths use — an
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
(`MAX_LAUNCHING`) → does the named project exist (`resolveProject`) → is the rest of the
request usable (`parseSpawnRequest`). Note that the probe runs *before* the token check,
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

The fix is a single `decodePath(raw): string | null` helper (`index.ts:85`, try/catch
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

- **The remote-answer toggle covers it, like every other write path.** Both
  `serveSpawn` and `serveSpawnStop` answer `404 {error: 'remote answers disabled'}` when
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

- **No `--resume`.** Reviving a stopped session is the obvious next step — same spawn
  path plus a `--resume <id>` sourced from an enumerated row — but this path proves
  itself first.
- **No `--worktree` isolation.** Would keep a phone-launched session off your dirty
  tree; deferred so v1 has one spawn path, not two.
- **No budget cap (`--max-budget-usd`).** A real rail on an unattended run; not shipped
  unless a runaway actually happens.
- **No streamed output.** The transcript is the output, and the chat drawer already
  renders it — `--output-format stream-json` would be a second rendering path for the
  same bytes.
- **No spawn from an existing session row.** The entry point is the toolbar only; rows
  stay read-only.
- **A stopped launch and an orphaned one are not symmetric.** See [the stop endpoint's
  restart hole](#the-stop-endpoint-and-its-restart-hole) above — a detached child
  outlives a server restart by design, but the store that could `stop` it does not.
