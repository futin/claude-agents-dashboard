# Launch in the desktop app — design

Date: 2026-10-29. Status: draft, review round 2 applied, awaiting approval. Repos: `claude-agents-dashboard` (this one) and the sibling `backlog-manager`.

## Intent

Today every session the dashboard starts is a headless `claude -p` child (`server/lib/spawn.ts`), driven through the chat drawer. The Claude desktop app
has two undocumented `claude://` links, verified live on 2026-10-29 and recorded in `docs/subsystems/session-surfaces.md` §"The desktop app's
`claude://` links":

- `claude://code/new?folder=<abs path>&q=<prompt>` starts a Code-tab session in that folder and **sends the prompt unattended**.
- `claude://resume?session=<uuid>` imports an existing CLI transcript into the desktop sidebar and keeps writing to the **same** transcript (no fork).

The user wants three moments served by them:

1. **Start a desktop session from anywhere** — from the phone while away, or at the desk — so the work is already running in the app's full UI when they
   sit down.
2. **Hand a dashboard-spawned session over to the desktop app** — continue it in the app instead of the chat drawer.
3. **Run a groom (or any board dispatch) from the backlog-manager board in the desktop app** — the board already launches through this dashboard's
   `POST /api/spawn` (`backlog-manager/server/src/agents/agents.service.ts`, `dispatch`).

Headless stays a first-class choice: the user asked for a per-launch **Dashboard | Desktop** pick, with a setting for the default, **Dashboard by
default**.

## Goals

- One per-launch choice, `Dashboard` (headless, today's behaviour) or `Desktop` (the `code/new` link), in the dashboard's launch form **and** on the
  backlog-manager board's dispatch buttons.
- A setting for the default choice, initial value `Dashboard`.
- An **Open in desktop app** action on a session row that hands the transcript to the desktop app via `resume`.
- Every link is fired **on the Mac by the server** (`open <claude:// url>` through `execFile`), so a tap on the phone acts on the Mac, not on the phone's own
  Claude app.

## Non-goals

- Choosing model, effort, permission mode, name, one-shot or Remote Control for a desktop launch. The link carries none of them (the handler reads only
  `q`/`prompt`, `folder`, `file`, `environment`, `runner_pool`, `ssh_host`/`ssh_port`); the app's own defaults apply.
- Tracking or stopping a desktop session from the dashboard. Once the app owns it, the app is where it is stopped; the dashboard keeps reading its
  transcript like any other session's.
- SSH or cloud desktop launches (`ssh_host`, `environment`).
- Writing the desktop app's session registry by hand.

## Anti-goals

- **A desktop launch that silently happens somewhere other than this Mac.** No `<a href="claude://…">` in the page: from the phone it would open the
  phone's Claude app.
- **Two writers on one transcript.** Handing over a session whose headless child is still live would put the dashboard child and the desktop app on the
  same `.jsonl` (`docs/subsystems/spawn.md` §"Two writers on one transcript").
- **Free-text paths reaching the shell or the link.** The folder is the resolved project cwd, exactly as a headless spawn's is
  (`spawn.md` §"Project selection is a membership check, never a path"); nothing from the request is ever a path or a shell word.
- **A desktop default that strands remote launches.** Desktop sessions take the app's permission mode, so one started from the phone can park on a
  permission dialog only the Mac can answer. That is why the default stays Dashboard; the user accepted the trade for explicit Desktop picks.

## Constraints

- `server/` takes no new dependency and no new outbound kind. Launching `open` is already allowed (`lib/open-folder.ts`); this adds `open <claude:// url>`
  beside it. `test/outbound.test.ts` pins network modules only and must still pass; the launched-program list to extend is the one in
  `.claude/CLAUDE.md` (Code rules) and `docs/overview.md`.
- macOS only, as the links are. On any other platform, or when `/Applications/Claude.app` is absent, Desktop is unavailable and the UI says so.
- Same gates as `POST /api/spawn` today: `refuseWrite`, the remote-answer toggle, project membership.
- `shared/types.ts` first, then server, then client (repo rule). The backlog-manager change is a separate PR in that repo, after this one ships.
- The links are undocumented; an app update can change them. Keep the URL building in one server module so a change is a one-file fix.

## Decided by the user

- Per-launch choice between Dashboard (headless) and Desktop, offered in the dashboard launch form **and** on the backlog-manager board.
- A setting chooses the default; it starts at **Dashboard**.
- Permission prompts in desktop sessions started remotely are an accepted cost of picking Desktop.

## Decided by Claude (overridable)

1. **One server path.** `POST /api/spawn` gains an optional `surface: 'dashboard' | 'desktop'`. **Absent always means `dashboard`** — never the
   default setting — because many callers send no surface and must stay headless whatever the setting says: `ResumePanel`, the Git Sync launch, and on
   the board orchestrate, resume, watchdog resume, `spawnAbort` and Jira dispatch (`AgentsService.spawn`, `agents.service.ts`). A desktop launch
   builds `claude://code/new` with `URLSearchParams` (`folder` = the resolved project cwd, `q` = the prompt) and runs `open <url>` via `execFile`
   (args array, no shell). It returns 200 with a response that says `surface: 'desktop'` and carries **no** `sessionId` — the app mints its own, and
   the row appears on a later scan (its transcript says `claude-desktop`).
2. **The default setting only preselects a control.** It lives in Shared settings (`ServerSettings`, server-stored), not Local, so the dashboard's
   launch form on every device and the board's pick start from the same value. `/api/health` exposes it with `desktopAvailable` so the board can
   preselect without a second read. The server never applies it to a request (decision 1).
3. **Fields a desktop launch ignores are greyed out** in the launch form when Desktop is picked, with one line saying the app's defaults apply. The server
   rejects nothing for carrying them; it ignores them on a desktop launch (an old client must not break).
4. **`resume` combined with `surface: 'desktop'` is the hand-over**, offered on **dashboard-spawned rows only** (the `dashboard` pill — the user's moment 2).
   The server validates the id exactly as a headless resume does today, `sdk-cli`/dashboard-entrypoint restriction included, and fires
   `claude://resume?session=<id>`. The link carries no prompt, so a `{resume, surface: 'desktop'}` body **has none**: `parseSpawnRequest`
   (`server/lib/spawn.ts`, which today answers 400 `prompt is required`) is relaxed for exactly that shape and no other. Test cases: that body without `prompt`
   → 200; the same body with `surface` absent → 400 `prompt is required`. Terminal and desktop rows are out: a live interactive terminal session may leave none
   of the liveness signals below, so a hand-over there could not rule out two writers.
5. **Hand-over is refused while a live process owns the transcript**: 409 when `spawn.ts` holds a live child for that id, or the row's `processLive` or
   the `ps` argv-id probe (`liveSessionIds`, `scan.ts`) says another process does, or a question/plan/reply socket is held, or a resume of it is
   already in flight — the same checks a headless resume's 409 makes. That last check reads the launch store, which a desktop hand-over never enters, so
   it cannot see a second tap (or a second device) in the gap before the app writes its registry row: each hand-over therefore sets a **per-id in-flight
   mark**, held for the desktop rail's window (decision 6), and a headless resume or a second hand-over of a marked id answers 409 `already resuming`.
   Once the registry row exists, decision 11 takes over. Test case: two `{resume, surface: 'desktop'}` bodies for one id back to back → 200, then 409.
   The row shows the action disabled with decision 12's hint; no automatic stop, because a stop mid-turn loses work.
6. **The accident rail covers desktop launches too, with its own counter.** There is no child to count, so a desktop launch (new or hand-over) takes a
   slot in a time-window counter of its own — cap 4 like `MAX_LAUNCHING`, released after a few seconds — and headless launches keep theirs unchanged.
   Over the cap: 429 `too many launches in flight`, the same body as today. Exact window is the builder's.
7. **The board's pick** is a Dashboard | Desktop control on its **item dispatch** only (groom / execute of one item) — not orchestrate, resume, watchdog
   resume, abort or Jira dispatch, which stay headless and send no `surface`. It is preselected from the dashboard's default via `/api/health`, sent as
   `surface` on the existing `POST /api/spawn`, and **hidden for a non-home machine**: `desktopAvailable` describes only the Mac that answered, and an
   older remote dashboard would ignore the field and launch headless while the user believed otherwise. backlog-manager builds no links. A desktop
   result carries no `sessionId`, so the board needs: a result type that allows it (`AgentDispatchResult` is `{sessionId: string}` today, and `spawn()`
   502s on a 200 without one), **no dispatch record** for it (abort and the holder claim key on the session id, and the app now owns the session), and a
   sheet message in place of following the session.
8. **Gates for a desktop launch:** the write gate (`refuseWrite`) and the remote-answer toggle stay — they decide who may make this Mac do things. `probeSpawn`
   (whether the `claude` CLI can be spawned) does not apply; `desktopAvailable` replaces it, and a desktop request while it is false is a 501 `desktop app
   unavailable`, the code the two other `open` routes give off macOS. Today `serveSpawn` runs `probeSpawn` and the `MAX_LAUNCHING` rail **before** reading the
   body (`server/api.ts`, its doc comment explains why), but `surface` is in the body. New order: remote-answer toggle → `refuseWrite` → read body →
   `parseSpawnRequest` → the chosen surface's probe → the chosen surface's rail → launch. The comment above `serveSpawn` is rewritten to match; a headless
   request still gets the same codes it gets today. `desktopAvailable` is darwin **and** a `stat` of `/Applications/Claude.app` succeeding, memoised like
   `probeSpawn` — never `open -R`/`open -Ra`, which reveal the app in a Finder window. The client's New-session entry points
   (`client/src/components/AsideBoard.tsx`, `client/src/components/sessions/AsideStrip.tsx`, hidden today when `spawnAvailable` is false) show when
   `spawnAvailable || desktopAvailable`, and the form offers only the surfaces that are available.
   **`open` failing** (scheme unregistered, app removed after the memoised probe, `execFile` error or timeout) answers 500 `open failed`, as
   `serveOpenFolder` does for the same program, takes no rail slot, and shows decision 12's failure line.
9. **Prompt length for Desktop is refused, never cut.** The board appends its safety clause (`--finish …`, or "do not push") at the **end** of the prompt
    (`backlog-manager/server/src/agents/prompt.util.ts`, `appendFinishClause`), so a silent tail cut would drop it. The effective Desktop limit is
    `min(PROMPT_CAP, app cap)`, which is `PROMPT_CAP` (4000) today, since the app cuts `q` at 14336 (Unverified, below). `parseSpawnRequest` already
    refuses a longer prompt with 400 before it knows the surface, so there is no second cap and no second counter: the form counts against `PROMPT_CAP`
    on both surfaces, and the URL-building module records the app's 14336 in a comment, so whoever raises `PROMPT_CAP` past it sees the cut coming.
10. **The response is a discriminated union**: `SpawnResponse` becomes `{ surface: 'dashboard'; sessionId: string } | { surface: 'desktop' }`
    (`shared/types.ts`). An old client reading `sessionId` still works for headless. `useSpawn.launch` today resolves `sessionId ?? null` and every
    caller reads `null` as failure (`client/src/hooks/useSpawn.ts`), so its contract changes to return the union (or `null` on failure), and the callers
    branch on `surface`; the ones typed against the old `{sessionId}` (`client/src/components/ResumePanel.tsx`, `client/src/hooks/useGitSync.ts`) narrow on it.
    Test case: a desktop 200 → decision 12's launch-form line, never `Launch failed`.
11. **A handed-over session is desktop-owned.** Two cases, split by what the transcript already says.
    - **Continued in the app.** The scanner reports the **newest** `entrypoint` in the 256 KB tail (`readTranscript`, `server/lib/transcript.ts`, a
      newest-first walk), so once the app writes a turn the row reads `claude-desktop` and `sessionSurface` yields `local`: the `dashboard` pill drops,
      `resumeEligible` (`client/src/lib/resume.ts`) is false, the hand-over is not offered (decision 4), and a headless resume already answers 400
      `only dashboard sessions can be resumed` (`server/api.ts`). Nothing new is needed; measured on this machine's hand-over probe transcript
      (23 `claude-agents-dashboard` records, then 9 `claude-desktop`, 2026-10-29).
    - **Imported, not yet continued.** The transcript still reads `dashboard`, and the app's `claude` child carries no session id in its argv, so
      `liveSessionIds`, `processLive` and `hasLiveChild` cannot see it. Rule: a session whose id is the `cliSessionId` of a **non-archived** record in the
      desktop app's registry (`claude-code-sessions/<install>/<account>/local_<uuid>.json`) is `desktopOwned`. `Session` gains `desktopOwned`
      (`shared/types.ts` first). A desktop-owned row is not `resumeEligible`, shows the hand-over disabled, and the server refuses both a headless resume
      and a hand-over of it with 409 `session is open in the desktop app`, checked among the other 409s, after the surface 400.

    The registry reader is a new sibling of `classify` in `server/lib/archived.ts` — that module reads the registry today; `scan.ts` only filters on the
    set the handler injects — returning the live ids, injected into the scan the way `archivedIds` is. Its failure direction is the inverse of
    `classify`'s, because here a false "not owned" admits a second writer (anti-goal 2): a record whose `isArchived` is absent or anything but `true`
    counts as live. What it cannot read it cannot attribute, so a missing `claude-code-sessions` root gives an empty set, and an unreadable or malformed
    record, or one with no string `cliSessionId`, is skipped while the rest are still read; decision 5's in-flight mark covers the import's first
    seconds either way. Test cases: live record, transcript `dashboard` → owned, 409; archived record, transcript `dashboard` → not owned; newest
    entrypoint `claude-desktop` → surface `local`, existing 400; root missing → nothing owned; one malformed record → skipped, the others still read;
    `isArchived` absent → owned.
12. **Copy for a desktop outcome** is fixed here, not left to the builder. The dashboard has no toast, so each line shows where the action was taken.
    - Launch form, success: the form closes and shows `Opened in the desktop app — the row appears in a few seconds.` instead of opening the chat drawer.
    - Hand-over, success: `Opened in the desktop app.` beside the action; the row is already on screen.
    - Either, on 500 `open failed`: `Couldn't open the desktop app.` where the success line would show.
    - Hand-over disabled: hint `Stop it first` while decision 5 refuses, `Already open in the desktop app` while the row is `desktopOwned`.

## Left to the builder

- Names: the request field, the setting key, the health fields.
- Where the Open-in-desktop action sits on each session view (row menu, inspector, chat drawer header), within the existing class-name conventions.
- The rail's window length.
- Test shape: URL building and validation are pure and get node-assert cases; `open` is injected the way `spawn.ts` injects its spawner.

## Unverified going in

- **Cold start**: both probes ran with the app already open. The handler has a `cold_start` path, but a launch with the app closed is untested.
- **Unknown folder**: whether `code/new` still sends unattended for a folder the app has never trusted. The probe folder was new and nothing asked, but
  that may be this account's trust setting.
- **Prompt length**: the handler truncates `q` at `nN = 14336` characters (read from `app.asar` beside `claudeURLHandler`, app 4.4212.0) — above
  spawn's `PROMPT_CAP` (4000) and the board's `PROMPT_MAX` (8000), so today no accepted prompt reaches it. Decision 9 keeps the number as a comment beside
  the URL builder, so a change on either side is visible.
