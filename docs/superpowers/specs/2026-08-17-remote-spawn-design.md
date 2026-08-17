# Starting a session from the dashboard (remote spawn) — design

Start a new Claude Code session from the phone. Pick a project, speak or type a prompt, tap
launch. The server spawns a detached headless `claude -p` in that project; the row appears
in the session list ~3s later and you keep talking to it with the reply window that already
exists.

Approved 2026-08-17 (shape, permission posture, cwd source, form knobs, and scope all
confirmed via dashboard remote answers).

## Why this is the fourth write path, and different in kind

The three existing write paths are all **hook-held**: a session is already running, a hook
blocks on something, and the browser resolves it ([remote-answer](../../subsystems/remote-answer.md),
[remote-plan](../../subsystems/remote-plan.md),
[remote-message](../../subsystems/remote-message.md)). The dashboard has never *initiated*
anything — it answers what a session raised.

Spawn inverts that, which is the whole security story below. It is worth being blunt: this
turns a read-mostly monitor into a remote code-execution surface. The mitigating argument is
that remote-message already lets a phone hand a running session brand-new instructions, so
the marginal capability is "without needing one to already be running" rather than a new
class of power — but the gate is still off by default and the ceiling still lives on the
host, not in the browser.

## Why headless `-p` and not an interactive terminal

`osascript`/`open -a Terminal` would give a session you can take over at the keyboard. It
also needs the Mac awake with a live GUI session, and away from the machine you cannot see
or drive its TUI at all — which is the only case this feature exists for. Headless `-p`
runs anywhere the server runs, writes an ordinary transcript, and (critically) fires the
same global hooks, so it inherits remote AskUserQuestion and the Stop reply window for free.

The cost is that a headless run has no TTY, so any permission prompt has nowhere to go —
which is what forces the permission-mode decision in section A rather than leaving it at
the default.

## Verified on this machine

| Fact | Evidence |
|---|---|
| `--session-id <uuid>` is honored end to end | Minted `8fbf70f2-4754-4768-84c5-541615d084ec`, ran `claude -p --session-id …`; the JSON result echoed that exact `session_id` **and** `~/.claude/projects/<dir>/8fbf70f2-….jsonl` appeared under that name. This is what lets the client deep-link before any transcript exists. |
| A prompt on **stdin** is never parsed as flags | `printf '%s' "--version is not a flag here; just reply with the single word OK" \| claude -p …` → result `OK`. Passing the prompt positionally would make a prompt starting with `--` a CLI flag; stdin removes that bug class and the argv length limit with it. |
| `--permission-mode auto` completes headless, does not stall | Three probes (`git push`, `sudo -n true`, an out-of-scope `/etc` write), all `stop_reason: end_turn`, 10–13s each, `permission_denials: []` throughout. |
| **Unproven:** that a *soft-denied* call continues rather than stalls | No probe produced a positive denial — `git push` and `sudo` were allowed, and the `/etc` write was refused by the model itself before reaching the permission layer. Treated as a known unknown, see Risks. |
| Global hooks fire for headless runs | `~/.claude/settings.json` registers `PreToolUse:AskUserQuestion`, `Stop`, `Notification`, `PermissionRequest`, `UserPromptSubmit` with no matcher restricting them to interactive sessions. |
| The enumerated project set already exists, with a resolver | `listRecentProjects` → `ProjectRef[]` (`{dirName, name, path, lastActiveMs}`) and `resolveProject(config, dirName)` at [server/lib/management.ts:344,377](../../../server/lib/management.ts) — membership-checked, exactly the shape path safety needs. Nothing new to build. |
| Token gate helper | `tokenOk` at [server/api.ts:381](../../../server/api.ts) — reused verbatim. |
| JSON body reader + cap | `readJsonBody` at [server/api.ts:266](../../../server/api.ts), `BODY_CAP = 64 * 1024` at :207. |
| The "unset means off" config rule | `whisperModel` / `ntfyTopic` doc comments in [server/lib/config.ts:29,52](../../../server/lib/config.ts): *"one 'unset means off' rule rather than a separate boolean."* Section A follows it rather than adding `SPAWN_ENABLED`. |
| The cached-probe + injectable-seam patterns to copy | `probeTranscribe` / `resetProbe` at [server/lib/transcribe.ts:62,96](../../../server/lib/transcribe.ts); `setIdleReader` at [server/lib/messages.ts:178](../../../server/lib/messages.ts). |
| CLI version these were measured against | `2.1.233` |

## Non-goals

- **No resume in v1.** Dropped at approval. Reviving a stopped session is the obvious next
  spec — same spawn path plus `--resume <id>`, with the id coming from an enumerated row —
  but the spawn path proves itself first.
- **No worktree isolation.** `--worktree` exists and would keep a phone launch off your
  dirty tree; deferred so v1 has one spawn path, not two.
- **No budget cap.** `--max-budget-usd` works with `--print` and is a real rail on an
  unattended run. Deliberately not shipped; revisit if a runaway actually happens.
- **No streaming output in the dashboard.** The transcript is the output, and the chat
  drawer already renders it. `--output-format stream-json` would be a second rendering path
  for the same bytes.
- **No free-text cwd.** Violates the stated path-safety rule.
- **No spawn from a session row.** The entry point is the toolbar; rows stay read-only.
- **No `bypassPermissions` reachable from the browser by default.** Only if the host owner
  raises the ceiling.
- **No survival of pid state across a server restart.** See the stop endpoint's caveat.

## A. Config — the gate is a binary path, not a boolean

Following the house rule above, the feature is enabled by naming the binary and disabled by
leaving it empty. Two new `Config` fields in [server/lib/config.ts](../../../server/lib/config.ts):

| Key | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `''` | Path or PATH name of the Claude Code CLI. **Empty disables spawn outright** — the endpoints 404 and the client hides the button, exactly as an empty `WHISPER_MODEL` disables dictation. |
| `SPAWN_MAX_PERMISSION` | `auto` | The ceiling the server clamps every request to. |

Add both to `DEFAULTS`, both to `.env.example` with comments, and document them in
[docs/workflows/configuration.md](../../workflows/configuration.md).

The permission ladder, lowest to highest:

```
plan  <  acceptEdits  <  auto  <  bypassPermissions
```

`clampPermission(requested, ceiling)` returns the lower of the two by ladder index, and
falls back to `auto` for anything unrecognized on either side. This is a **policy** ladder,
not a claim that each mode is a strict superset of the one below — `acceptEdits` auto-
approves edits but stalls headless on the first Bash prompt, while `auto` classifies both.
Ordered by how much unattended damage a launch can do.

`manual` and `dontAsk` are excluded from the enum: `manual` stalls headless by definition,
and `dontAsk`'s semantics were not verified here. An unknown mode from the browser clamps to
`auto` rather than erroring — fail toward the documented default.

## B. Server

### `server/lib/spawn.ts` — new module

Four exports, three of them pure:

- **`buildSpawnArgs(input: SpawnInput): string[]`** — pure. Returns argv **without** the
  binary and **without** the prompt (which goes on stdin). Always emits
  `['-p', '--session-id', <uuid>, '--permission-mode', <clamped>]`, plus `--model`,
  `--effort`, `-n` only when the corresponding field is present and non-empty. Every value
  is its own argv entry; the function never builds a shell string.
- **`clampPermission(requested, ceiling): PermissionMode`** — pure, per the ladder above.
- **`probeSpawn(config): boolean`** — cached per process, `null` = unprobed, mirroring
  `probeTranscribe`. False when `config.claudeBin` is empty; otherwise
  `spawnSync(claudeBin, ['--version'])` with a 5s timeout, true on exit 0. Paired with a
  `resetSpawnProbe()` for tests only. This is also what makes the feature self-disable in
  Docker, where no CLI is installed — no separate container check needed.
- **`launch(config, resolved, input)`** — the impure one. Mints
  `crypto.randomUUID()`, spawns, registers the store entry, returns the id.

The spawn call itself:

```
spawn(config.claudeBin, buildSpawnArgs(input), {
  cwd: resolved.path,          // from resolveProject, never from the request
  detached: true,
  stdio: ['pipe', 'ignore', 'pipe']
})
```

then write the prompt to `stdin` and `end()` it, and `unref()` the child.

Three properties of that call are load-bearing, each for a different reason:

1. **Never `shell: true`, argv always an array.** Prompt text cannot become shell.
2. **`detached: true` + `unref()`.** `pnpm dev` runs `tsx watch`, so the API restarts on
   every file save — a non-detached child would be killed by your next keystroke. Detached
   also means the session survives a deliberate server restart, which is the behaviour you
   want from something that runs for minutes unattended.
3. **stderr stays piped while the parent lives.** The parent can still read it (a detached
   child outliving its parent is a separate question from the parent watching it while it
   is alive), which is what catches the common launch failures — binary not found, bad cwd,
   instant crash. stdout is ignored: the transcript is the real output.

### The store's charter — deliberately narrow

RAM-only `Map<sessionId, LaunchEntry>`. Its entire job is:

> explain the first ~3 seconds, and report launches that never became sessions.

States: `launching` → `adopted` (the scan reported this id; **entry is deleted**) or
`failed` (child exited nonzero before adoption; keeps `exitCode` and a stderr tail capped at
2KB). Failed entries expire after 5 minutes so a phone that never looks does not accumulate
them.

This is explicitly **not** a session registry — the transcript stays the single source of
truth, the same division that keeps `pending.ts`/`plans.ts`/`messages.ts` small. A launch
that succeeds leaves no trace in this module.

Adoption is driven from the sessions handler: it already has the scanned id list, so it
calls `adoptLaunched(ids)` before serializing. No extra disk work, no watcher.

The child process handle is kept alongside the entry for the stop endpoint only.

### Endpoints (handlers in `api.ts`, routes in `index.ts`)

| Method | Path | Codes |
|---|---|---|
| `POST` | `/api/spawn` | 200 `{sessionId}`; 400 malformed / unknown project / empty or oversized prompt; 403 bad token; 404 feature off (empty `CLAUDE_BIN` or failed probe); 405 non-POST; 500 spawn threw |
| `POST` | `/api/spawn/:id/stop` | 200 `{stopped: true}`; 400 bad id shape; 403 bad token; 404 no live child for that id; 405 non-POST |

Both gated by `tokenOk`, like every other write path.

`POST /api/spawn` body: `{project: string /* dirName */, prompt: string, name?, model?,
effort?, permissionMode?}`. Validation, in order:

1. Feature on (`probeSpawn`) — else 404.
2. `tokenOk` — else 403.
3. `resolveProject(config, body.project)` — a **membership check against the enumerated
   set**, not a path join. Unknown → 400.
4. `prompt` trimmed non-empty and ≤ `PROMPT_CAP = 4000` (the `TEXT_CAP` precedent from
   `messages.ts`) — else 400.
5. `name` ≤ 60 chars matching `/^[\w .\-]*$/`; `model` and `effort` from fixed enums;
   `permissionMode` from the four-mode enum then clamped. Anything unrecognized in these
   four is dropped, not an error — an old client must not be able to fail a launch.

`/api/spawn/:id/stop` sends `SIGTERM` to the stored child. **It only works for launches this
server process started** — the store is RAM-only and the pid is not persisted, so after a
restart it 404s and killing is a terminal job. Documented as an accepted limit, the same
posture the other three stores take toward restarts.

⚠️ Route order: `/api/spawn/:id/stop` is `$`-anchored and must sit above any looser spawn
route, the same trap chat/question/plan/message all document.

### `shared/types.ts` (edited first — it is the contract)

- `PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'`
- `SpawnRequest` — the POST body above.
- `LaunchingSession = { sessionId, projectName, projectPath, prompt (first 120 chars),
  startedAtMs, state: 'launching' | 'failed', error?: string }`
- `SessionsResponse.launching?: LaunchingSession[]` — added at
  [shared/types.ts:739](../../../shared/types.ts). **Optional**, so an older client ignores it.
- `HealthResponse.spawnAvailable?: boolean` — the capability flag the client reads to show
  or hide the button, exactly how dictation rides `HealthResponse` today.

Putting `launching` on the existing poll rather than behind its own endpoint is the point:
no new polling loop, and the phantom row arrives on the same 3s cadence as everything else.

## C. Client

- **`components/SpawnPanel.tsx`** (own lazy chunk, like `ChatDrawer`/`AnalyticsView`): project
  `<select>` fed by the management projects list, prompt `<textarea>` with **`MicButton`**
  in its action row (the reason this feature is worth building now — reuse it as-is, it was
  built reusable and wired in exactly one place so far), plus name / model / effort /
  permission-mode selects. Launch button disabled while the prompt is empty or a request is
  in flight.
- **`hooks/useSpawn.ts`**: `launch(req)` → POST, then on success set the deep-link session
  and close the panel. Exposes `pending` / `error`.
- **Toolbar**: a `+ New` button, rendered only when `spawnAvailable` is true on the
  `/api/health` poll the Toolbar already consumes for the origin badge.
- **`SessionList`**: renders `launching` entries as phantom rows above the real ones —
  project name, truncated prompt, a `starting…` state, and for `failed` the error with the
  stderr tail. A phantom row disappears on its own when the real row adopts the id.
- **CSS**: new classes below the theme-token block only; no literal colors or shadows.

## D. Tests, docs, risks

**Tests** (`test/spawn.test.ts`, registered in `run-all.ts`). Nothing here spawns a real
`claude` — `launch` takes an injected spawner, the way `messages.ts` takes an injected idle
reader:

- `buildSpawnArgs`: minimal input → exactly `-p --session-id <uuid> --permission-mode auto`;
  each optional knob adds exactly its own two entries; absent/empty knobs add nothing.
- `buildSpawnArgs` adversarial: a prompt is never in argv at all; a name of
  `x"; rm -rf /; echo "` either fails the charset check or survives as one argv entry —
  never two.
- `clampPermission`: full 4×4 table, plus unknown-on-either-side → `auto`.
- Validation: unknown `project` rejected; prompt of 4001 chars rejected; whitespace-only
  prompt rejected; unrecognized `model` dropped while the launch still succeeds.
- Store lifecycle: `launching` → `adopted` deletes the entry; nonzero exit before adoption
  → `failed` with the stderr tail; the tail is capped at 2KB; failed entries expire.
- `probeSpawn`: empty `claudeBin` → false; probe runs once and memoises;
  `resetSpawnProbe()` clears it.

**Docs**: new `docs/subsystems/spawn.md`, a line in `docs/overview.md`'s map and its route
table, the two new keys in `docs/workflows/configuration.md`, and the `server/lib/spawn.ts`
line in the CLAUDE.md tree.

**Risks**

1. **Remote code execution is the feature.** Off by default via empty `CLAUDE_BIN`; ceiling
   on the host via `SPAWN_MAX_PERMISSION`; `ANSWER_TOKEN` on the POST. The honest framing:
   with this on and a leaked token, someone who can reach the dashboard can run Claude Code
   in any project the machine has recently touched.
2. **The unproven soft-deny behaviour.** If a denied call turns out to stall rather than
   continue, the session sits idle instead of finishing. It shows as an idle row and the
   stop endpoint ends it — degrades, does not wedge. Worth one deliberate probe during
   implementation now that a real denial can be provoked on purpose.
3. **Orphaned children.** Detached by design, so a server restart leaves them running. That
   is correct behaviour (a long unattended run should survive a dev-server reload) but it
   means the stop button has a hole. Named, not fixed.
4. **The `Stop` hook timeout gap, pre-existing.** `~/.claude/settings.json` currently
   registers the `Stop` hook with **no `timeout`**, but
   [remote-message.md](../../subsystems/remote-message.md) requires `630` — without it the
   CLI kills the hook at its default and held turns die early. This affects normal sessions
   today and every spawned session tomorrow, since the reply window is how you keep talking
   to one. Fix the settings entry before relying on spawn.
