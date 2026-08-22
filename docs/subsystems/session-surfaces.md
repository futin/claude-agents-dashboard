# Where a session lives, and where you can continue it

Written after the remote-control spawn work (2026-08-17), because the boundaries
between the surfaces are easy to guess wrong — several were guessed wrong, tested,
and corrected the same day. Every claim below was verified live on this machine
(CLI 2.1.233, desktop app 1.30096.5) unless marked *untested*.

## The five kinds of session

| # | Kind | Runs on | Local skills / memory / files | Account-registered |
|---|------|---------|-------------------------------|--------------------|
| A | Desktop-app (Harness) session | this Mac | ✅ | ❌ (local registry only) |
| B | Terminal `claude` | this Mac | ✅ | only with `--remote-control` |
| C | Dashboard spawn, plain headless `-p` | this Mac | ✅ | ❌ |
| D | Dashboard spawn with **remote control** (the default) | this Mac | ✅ | ✅ while alive |
| E | Cloud session (created from the phone app / claude.ai) | Anthropic sandbox | ❌ | ✅ |

E is the only one that does **not** get this Mac's global skills, memory, hooks, or
filesystem — that is the trade the phone app's native "new chat" makes, and the
reason D exists at all.

## What each surface can see and do

| Surface | Sees | Can continue a conversation | Long-text comfort |
|---|---|---|---|
| Desktop app sidebar | A + E — it merges the account's **cloud** sessions into the list (verified: a phone-created cloud session appears; its id is absent from the app's local registry, so this is a rendered merge, not an import). **Not D** — a live, phone-visible RC session shows nowhere in the app | A full UI; E as a cloud thread | ✅ |
| Phone Claude app | D (while alive), E | D and E, full chat UI | ✅ |
| claude.ai web | E; D *untested* | E | ✅ |
| This dashboard | A, B, C, D (anything with a transcript on disk) | any of them via the turn-end reply window (away-only), 8 replies per stretch; **C/D also via [resume](spawn.md#resuming-an-ended-session-resume)** once the turn is over — no away gate, no reply cap | ⚠️ composer, not a thread UI |
| Terminal `claude --resume <id>` | any local transcript (A–D) | full TUI with complete history | ✅ |
| Another local session (`ListAgents`/`SendMessage`) | any *live* local session, incl. one held in its reply window | enqueue a message; the reply comes back cross-session | n/a (agent-to-agent) |

## What the dashboard says about it (the `dashboard` pill)

Because those boundaries don't move, the row says so instead. Every session carries
`Session.surface` (`shared/types.ts`) — `local | dashboard | cloud`, an enum rather
than an `isLocalOnly` boolean because `cloud` is already a known third answer:

| value | means | pill |
|---|---|---|
| `local` | an ordinary terminal (B) or desktop-app (A) session — the surface that started it lists it too | none, on purpose |
| `dashboard` | a headless `-p` run (C/D): **no other list has it** | cyan `dashboard` |
| `cloud` | reserved for E. Nothing produces it: a cloud session writes no transcript here, so the scanner cannot see one | grey `cloud` |

It is read off the transcript's own `entrypoint` field — `cli`, `claude-desktop`,
`sdk-cli` — which every user/assistant record carries (measured: 1504/1504 across the
newest 12 transcripts on this machine), so it sits inside the 256KB tail
`transcript.ts` already reads. **No stored state**: nothing to persist, nothing to
prune, nothing lost on a restart, and sessions spawned before the field existed get
labelled too.

Three details that are load-bearing:

- **Only `sdk-cli` earns `dashboard`; every other value, unknown or absent included,
  is `local`.** The failure direction is chosen: under-claiming costs a pill, while
  over-claiming would tell you a session is invisible to the desktop app while it sits
  in its sidebar.
- **Newest record wins.** One transcript on this machine runs `sdk-cli` →
  `claude-desktop` — a headless session later picked up in the app — and that session
  *is* in the sidebar now. Reading the oldest value would label it dashboard-only and
  be wrong.
- **`sdk-cli` means headless, not "launched by this dashboard."** Another SDK launcher
  on this Mac reads the same, and the pill's claim still holds for it. Exact
  attribution would need a record of the ids `launch()` minted, which the RAM-only
  launch store deliberately drops at adoption ([spawn](spawn.md)) — so this reads the
  disk instead of growing a fifth store.

The pill renders in the list row and again in the chat drawer's header
(`client/src/lib/surface.ts` holds the one copy of its tooltip): a drawer opened
straight from a tapped push (`?session=<id>`) never showed the list, so the header is
the first place that reader learns the session lives only here.

## Why `cloud` stays empty, and what it would cost to fill (probed 2026-08-20)

The row above reserves `cloud` and notes that nothing produces it. This section
records *why* nobody should re-derive that, and what the one real door costs.
Probed against CLI 2.1.234 with **zero cloud sessions live on the account** — so
the shape of a cloud row below is read off the CLI bundle, not observed.

Four places could plausibly know about a cloud session. Only the last one does:

| Door | Cloud rows? | Reachable from `server/` |
|---|---|---|
| `~/.claude/projects/*/*.jsonl` — today's scanner | never: a cloud session writes no transcript on this Mac | ✅ |
| `claude agents --json --all` | no — 6/6 rows `kind: "interactive"` with a `pid`, backed by `~/.claude/sessions/<pid>.json`. It enumerates local processes, not account sessions | ✅ zero-dep `child_process` |
| The desktop app's own registry (below) | no — 437/438 files are `local_*`, the 438th `scheduled-tasks`. Consistent with the verified claim above that the app *renders* cloud rows rather than importing them | ✅ plain JSON on disk |
| The inter-Claude bridge — what `ListAgents` speaks | **yes, and only here** | ⚠️ see below |

`listBridgePeerSessions` in the CLI bundle resolves to a single authenticated
HTTPS call:

```
GET ${BASE_API_URL}/v1/code/sessions?limit=100[&cursor=…]
  Authorization: <OAuth, from prepareApiRequest()>
  x-organization-uuid: <orgUUID>
  X-Trusted-Device-Token: <when the device is bound>
```

(without the code-sessions flag it falls back to `/v1/sessions` with an
`anthropic-beta` header and `after_id` paging). There is no local file, no
cache, and no socket behind it — cloud state exists only at the other end of
that request. Adding it to this backend means a **second outbound call**
(see the zero-dep rule in `CLAUDE.md`) plus reading an OAuth token the CLI keeps
in the macOS keychain.

**And the feature you'd buy is half a feature.** The bridge does expose
`postInterClaudeMessage`, so a message can be sent *into* a cloud session — but
the CLI's own constant `CLOUD_SESSION_CANNOT_SEND_HINT` renders as
`a cloud session (can't reply yet)`. Remote-control peers get a reply address;
cloud peers do not. Reading is worse: with no transcript on disk, `ChatDrawer`
has nothing to page, so content would need a further endpoint. The result is a
row you cannot open, cannot read, and can shout into once — while every
interactive surface this dashboard has (`QuestionPanel`, `PlanPanel`,
`MessagePanel`) is request→response by construction.

### The desktop registry, and why it is not a shortcut

The probe turned up the desktop app's session store, which is not documented
elsewhere and looks more useful than it is:

```
~/Library/Application Support/Claude/claude-code-sessions/<a>/<b>/local_<uuid>.json
  sessionId, cliSessionId, cwd, originCwd, title, titleSource, model, effort,
  permissionMode, isArchived, createdAt, lastActivityAt, enabledMcpTools, …
```

`cliSessionId` joins straight onto the transcript filename `scan.ts` already
keys on, which makes it tempting as a metadata source. Measured on this machine
before believing it:

| | count |
|---|---|
| transcripts on disk | 722 |
| carrying a `custom-title` record (what `title-cache.ts` finds today) | 251 |
| registry supplies a title | 193 |
| — both sources agree | 189 |
| — **registry only** | **4** |
| — transcript only (registry misses) | 62 |

The join is worth four titles out of 722 and loses 62, because the registry only
holds desktop-app sessions — terminal sessions and dashboard spawns are never in
it. Its other fields are no better: `"effort"` and `"permissionMode"` are both
already present in the 256 KB tail `transcript.ts` decodes anyway. Nothing here
is a source; it is a partial mirror of what the transcript already says.

## The two boundaries that will not move from this repo

- **Nothing external can add a row to the desktop app's local sidebar.** Its registry
  turns out to be *readable* — the JSON tree in the section above — but no supported
  path writes to it: the management surface (`ccd_session_mgmt`) has list/get/send and
  no create/import, and whether a hand-written row would be picked up is *untested*
  (the files are user-owned, so the filesystem would not stop you). A spawned session —
  RC or not — will never appear there through any documented route.
- **No cloud + teleport sequence can put a *local* session in that sidebar.** Tested
  end to end (`claude --cloud` → sidebar row → `claude --teleport`): the row is bound to
  the cloud session for its whole life. It survives the teleport, but it keeps talking to
  the container, never to the local continuation. The sidebar therefore shows the cloud
  brain by construction — the exact thing the local continuation exists to avoid.

  And deleting the cloud copy to resolve the ambiguity collapses the whole detour: the
  row goes with it, leaving exactly one local session — indistinguishable from what a
  plain dashboard spawn produces in one step, without the provisioning, the clean-tree
  requirement, or the fork. That is the closing argument against the idea: its only
  durable artifact is a session you could have created directly.

  The missing primitive is small and specific — a way to register an existing local
  transcript with the desktop app's session store. Until that exists (or teleport hands
  its row over), no arrangement of the current flags gets there.
- **The desktop app does not show remote-control sessions anywhere** (tested with one
  running and visible on the phone) — even though it *does* merge cloud sessions into
  its sidebar. The exclusion is specifically RC. Until the app grows that view,
  "continue in the desktop app UI" for a spawned session means `claude --resume`.

## So what is remote control *for*?

One thing, and it is the thing cloud sessions can't do: **the phone app's full chat
UI attached to a session that runs on this Mac** — local skills, memory, hooks,
repo checkout, the lot. Away from the desk, that is strictly better than both
alternatives: the dashboard composer (works, but it's a text box, not a thread) and
a phone-app cloud session (nice thread, wrong brain).

Lifetime caveat: C and D exit when their turn ends unless the away-hold keeps them
open (`Stop` hook + `idleSecs`; see [remote-message](remote-message.md)). At the
desk they die in seconds by design — you'd continue them in a terminal instead. A
session that has exited shows nowhere live; its transcript remains resumable and
visible to the dashboard.

## Continuity recipes

- **Start on the phone → keep talking on the phone:** dashboard spawn (RC default
  on) → open it in the phone Claude app. Or stay in the dashboard reply window.
- **Start on the phone → continue in the desktop app UI:** create a **cloud** session
  in the phone app instead of spawning — it appears in the desktop sidebar (verified)
  and continues there as a cloud thread. Cost: the cloud brain — no Mac skills,
  memory, or files.
- **Start on the phone → continue at the Mac with the Mac brain:**
  `claude --teleport <session-id>` — **verified**: the same cloud thread continues in
  a local terminal TUI. **Read the verified/unverified split below before relying on
  any of this** — two earlier revisions of this file overstated it.

  **Verified (2026-08-17)** against a session made with `claude --cloud`, teleported
  once headlessly under a pty and once from a bare shell:

  - Teleport executes and loads the cloud history: `Teleporting… → Validating session →
    Fetching session logs → Getting branch info → Checking out branch`, then the TUI
    shows the prior conversation.
  - The **cloud session survives it**. Its desktop-app sidebar row stays, still opens,
    and still answers — from its own Linux container (`cwd /home/user/<repo>`), with the
    cloud brain. So teleport is *not* a move.
  - The desktop app's registry gets **no row** for any teleported session: zero rows
    reference a teleported id, and `list_sessions` never shows one. Structural, not a
    self-report — this is the fact that kills the cloud→sidebar→teleport idea.

  - The **local fork is real, and it persists** — settled by running teleport in a bare
    shell and watching the filesystem. It appears as a **brand-new UUID transcript** in
    `~/.claude/projects/<cwd-slug>/`, carrying the inherited cloud history, and the
    dashboard lists it like any other session. Verified by the strongest available
    probe: a marker file readable only on this Mac, which the cloud side had refused by
    path minutes earlier, was read successfully after the teleport.

  **Nothing links the three ids.** For the run above: cloud id
  `session_011rhayQh5ZoiKenLuXugy1R`, the cloud session's own uuid
  `81a41fc4-…`, and the local fork `98939737-…`. The fork's filename echoes none of
  them — find it by mtime, by content, or just by watching the dashboard.

  ⚠️ **The fork inherits the cloud session's self-descriptions.** That local transcript
  literally contains the container's line *"This session is running in a remote Linux
  container"* — written while it truly was. Ask the fork where it runs and it may repeat
  that from history without checking. This is why locality is judged by the transcript,
  never by the answer (below).

  *Two earlier revisions got this wrong in both directions.* First they named
  `9fefb37c-….jsonl` and `d49f5799-….jsonl` as teleport artifacts — reading the files
  shows both are ordinary sessions whose first user message is the literal text
  `claude --teleport …`, the ids matching by coincidence. The correction then
  over-swung to "no fork is persisted at all", because no real shell teleport had been
  run yet. Both errors came from not opening the file.

  **How to tell local from cloud — never ask the model.** A teleported session inherits
  the cloud history, so it can answer "where do you run?" from stale context instead of
  checking; a cloud session answers correctly that it is in a container. Both look the
  same in chat. Ground truth: a session is local iff a transcript for it is being written
  under `~/.claude/projects` — exactly what this dashboard scans, so *if the dashboard
  lists it, it is local*.

  **Watch for the command-into-session trap.** Typing `claude --teleport <id>` into a
  window where Claude is already running sends it as a *message*; the session answers
  helpfully about the flag, having run nothing. It looks like success — local files get
  read, local hooks fire — because that session was already local. Run teleport in a
  shell with no Claude session attached.

  **`--teleport` also requires a clean git working directory** — it refuses with
  `Git working directory is not clean. Please commit or stash your changes before using
  --teleport.` For a repo that usually carries in-flight work, that alone makes teleport
  unusable as an automated step. It also wants the cloud session's branch: with none
  pushed, it continues but warns `Session resumed without branch: Failed to checkout
  branch 'claude/<name>'`.
- **Start on the phone → continue at the Mac:** `claude --resume <session-id>` in a
  terminal — full history, everything local. (The id is in the dashboard row / chat
  drawer URL.)
- **Dashboard spawn → keep going from the dashboard after it stopped:** the ended
  session's chat drawer offers the resume composer — `--resume` on the same id, so the
  same transcript continues and the same row wakes up. `dashboard`-surface (C/D) only: a
  terminal session stays terminal-owned, since resuming one here could race a still-open
  interactive session on the same transcript
  ([spawn](spawn.md#resuming-an-ended-session-resume)).
- **Start at the Mac (Harness) → continue on the phone:** the dashboard already
  monitors every local session; use the reply window. A-sessions are not
  RC-registered, so the phone *app* cannot attach to them.
- **Start in the desktop app → continue in the desktop app:** its own sidebar,
  as always.

<!-- docs-sync:
  sources:
    - server/lib/scan.ts
    - server/lib/transcript.ts
    - shared/types.ts
    - client/src/lib/surface.ts
    - client/src/components/SessionRow.tsx
    - client/src/components/ChatDrawer.tsx
  kind: subsystem
  verified: fa9fdbc0d1f74c5ba2d43f90ecb63806e5b39b14
-->
