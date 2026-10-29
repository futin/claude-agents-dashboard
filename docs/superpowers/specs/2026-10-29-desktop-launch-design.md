# Launch in the desktop app — design

Date: 2026-10-29. Status: draft, awaiting approval. Repos: `claude-agents-dashboard` (this one) and the sibling `backlog-manager`.

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
- Every link is fired **on the Mac by the server** (`open "claude://…"`), so a tap on the phone acts on the Mac, not on the phone's own Claude app.

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
4. **`resume` combined with `surface: 'desktop'` is the hand-over**, offered on **dashboard-spawned rows only** (the `dashboard` pill — the user's
   moment 2). The server validates the id exactly as a headless resume does today, `sdk-cli`/dashboard-entrypoint restriction included, and fires
   `claude://resume?session=<id>`. The link carries no prompt, so a `{resume, surface: 'desktop'}` body **has none**: `parseSpawnRequest`
   (`server/lib/spawn.ts`, which today answers 400 `prompt is required`) is relaxed for exactly that shape and no other. Test cases: that body without
   `prompt` → 200; the same body with `surface` absent → 400 `prompt is required`. Terminal and desktop rows are out: a live interactive terminal session leaves none of the liveness signals below, so a
   hand-over there could not rule out two writers.
5. **Hand-over is refused while a live process owns the transcript**: 409 when `spawn.ts` holds a live child for that id, or the row's `processLive` or
   the `ps` argv-id probe (`liveSessionIds`, `scan.ts`) says another process does, or a question/plan/reply socket is held, or a resume of it is
   already in flight — the same checks a headless resume's 409 makes. The row shows the action disabled with a
   hint ("Stop it first"); no automatic stop, because a stop mid-turn loses work.
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
8. **Gates for a desktop launch:** the write gate (`refuseWrite`) and the remote-answer toggle stay — they decide who may make this Mac do things.
   `probeSpawn` (whether the `claude` CLI can be spawned) does not apply; `desktopAvailable` replaces it, and a desktop request while it is false is a
   404 `desktop app unavailable`. Today `serveSpawn` runs `probeSpawn` and the `MAX_LAUNCHING` rail **before** reading the body (`server/api.ts`, its
   doc comment explains why), but `surface` is in the body. New order: remote-answer toggle → `refuseWrite` → read body → `parseSpawnRequest` → the
   chosen surface's probe → the chosen surface's rail → launch. The comment above `serveSpawn` is rewritten to match; a headless request still gets the
   same codes it gets today. `desktopAvailable` is darwin **and** the app bundle present, memoised like `probeSpawn`. The client's New-session entry
   points (`AsideBoard.tsx`, `AsideStrip.tsx`, hidden today when `spawnAvailable` is false) show when `spawnAvailable || desktopAvailable`, and the
   form offers only the surfaces that are available.
   **`open` failing** (scheme unregistered, app removed after the memoised probe, `execFile` error or timeout) answers 500 `open failed`, as
   `serveOpenFolder` does for the same program, takes no rail slot, and the form shows `Couldn't open the desktop app.`
9. **Prompt length for Desktop is refused, never cut.** The board appends its safety clause (`--finish …`, or "do not push") at the **end** of the prompt
    (`backlog-manager/server/src/jira/prompt.util.ts`), so a silent tail cut would drop it. The builder measures the app's `q` cap first; the server
    answers a longer desktop prompt with 400 naming the number, the same way spawn's `PROMPT_CAP` does, and the form counts against it when Desktop is
    picked.
10. **The response is a discriminated union**: `SpawnResponse` becomes `{ surface: 'dashboard'; sessionId: string } | { surface: 'desktop' }`
    (`shared/types.ts`). An old client reading `sessionId` still works for headless. `useSpawn.launch` today resolves `sessionId ?? null` and every
    caller reads `null` as failure (`client/src/hooks/useSpawn.ts`), so its contract changes to return the union (or `null` on failure), and the callers
    branch on `surface`. Test case: a desktop 200 → the confirmation below, never `Launch failed`.
11. **A handed-over session is desktop-owned.** After a hand-over the row still reads `dashboard` — `entrypoint` is taken from the first record
    (`server/lib/transcript.ts`) — and the desktop app's own `claude` child carries no session id in its argv, so `liveSessionIds`, `processLive` and
    `hasLiveChild` cannot see it. Rule: a transcript whose id has a non-archived row in the desktop app's registry (`claude-code-sessions/**/local_<id>.json`,
    `cliSessionId`; `scan.ts` already reads that registry for `archivedIds`) **or** that contains any `claude-desktop`-stamped record is
    `desktopOwned`. A desktop-owned row is not `resumeEligible` (`client/src/lib/resume.ts`), offers no second hand-over, and the server refuses both a
    headless resume and a hand-over of it with 409 `session is open in the desktop app`. Test cases: imported but never continued (registry row only) →
    owned; continued in the app (a `claude-desktop` record, registry row archived) → owned; neither → not owned.
12. **After a desktop launch** the launch form closes and shows a short confirmation ("Opened in the desktop app — the row appears in a few seconds")
   instead of opening the chat drawer.

## Left to the builder

- Names: the request field, the setting key, the health fields, the confirmation copy.
- Where the Open-in-desktop action sits on each session view (row menu, inspector, chat drawer header), within the existing class-name conventions.
- How `desktopAvailable` is detected (bundle path check, `open -Ra Claude`, …).
- The rail's window length.
- Test shape: URL building and validation are pure and get node-assert cases; `open` is injected the way `spawn.ts` injects its spawner.

## Unverified going in

- **Cold start**: both probes ran with the app already open. The handler has a `cold_start` path, but a launch with the app closed is untested.
- **Unknown folder**: whether `code/new` still sends unattended for a folder the app has never trusted. The probe folder was new and nothing asked, but
  that may be this account's trust setting.
- **Prompt length**: the handler truncates `q` at `nN = 14336` characters (read from `app.asar` beside `claudeURLHandler`, app 4.4212.0) — above
  spawn's `PROMPT_CAP` (4000) and the board's `PROMPT_MAX` (8000), so today no accepted prompt reaches it. Decision 9's refusal stays as the guard
  should the app lower it.
