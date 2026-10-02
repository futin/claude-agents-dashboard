# Git fetch — design

Management › Git shows how far each pinned repo's trunk is behind `origin`, but only as of whoever last ran `git fetch` there. WebStorm fetches the repos it has
open; the rest go stale, and the view can only say "fetched 2d ago". This adds the fetch: the **server** runs `git fetch origin` over every pinned repo on a
timer you set in Settings, only while somebody has the Git view open, plus a **Fetch all** you can press. Nothing pulls, pushes or prompts. No Claude session
is involved: a fetch is one git process per repo, about half a second and zero tokens.

Brainstormed 2026-10-02 in this repo. Builds on [the Git Stats spec](2026-10-01-git-stats-design.md) (§2 reader, §6 sub-view, §9 Sync button) and leaves
its reader read-only: the fetch is a module of its own.

Mockups: [2026-10-02-git-fetch-mockups.html](2026-10-02-git-fetch-mockups.html), the chosen shape (P1) at desktop and 375px with its states, the card copy and
the Settings card. Where the two disagree, **this spec wins**. Known differences:

- The mock's popover lists one failed repo ("needs auth"). §5 lists every repo whose last fetch failed, one line each, in pin order.
- The mock's band sub-line is built verbatim. Its Settings hint is built verbatim too.
- The mock draws the toggle row's chip only on the Git sub-view; Pinned never shows it. That is the design, not a mock shortcut.

## Decisions

| #   | Decision                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **The server owns the timer**, one per process. The browser's 30s poll stays a read of disk; three open tabs are one fetch schedule, not three.                      |
| D2  | **Watched-only.** The timer fires only while `GET /api/git-stats` was served within the last `max(2 × interval, 90s)`. A closed dashboard makes no network calls.    |
| D3  | **Off by default.** `gitFetchSecs ∈ {0, 30, 60, 120, 300, 600}`, a Shared setting; the card preselects nothing but Off until you pick. The precedent is `recordUsageHistory`: a server-side network timer is a switch the user throws. |
| D4  | **Origin only, refs only.** `git fetch origin --quiet --no-auto-gc --no-auto-maintenance`, once per **common dir** (two pins in one repo, a worktree pin included, are one fetch), 30s timeout, no `--prune`, no pull. |
| D5  | **Never prompts.** `GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND=ssh -o BatchMode=yes` unless the environment already sets `GIT_SSH_COMMAND` or `GIT_SSH`, so a user's ssh wrapper is kept. A repo that needs a passphrase or login fails as `auth` and says so. |
| D6  | **One fetch in flight.** A call while one runs returns the same promise, timer and button alike, so a mashed key or a tick landing on a click is one fetch.           |
| D7  | **No second poll.** The clock and each repo's last-fetch verdict ride in `GET /api/git-stats`; the chip counts down client-side from `nextAtMs`.                     |
| D8  | **`POST /api/git-fetch`** runs a fetch now; guarded by `tokenOk` exactly as `POST /api/settings` is. A phone without its answer token sees the key disabled with the reason. |
| D9  | **The band loses its right slot.** ↻ and "updated Ns ago" move into a clock chip beside the layout toggle; ↻ becomes the popover's *Local sync › now*.                |
| D10 | **Failures are per repo and quiet.** `auth`, `offline`, `timeout`, `other` show amber on the card and in the popover and the timer keeps going; `lock` (a clash with your own git) shows nothing and the next tick retries; a repo with no `origin` is skipped, not an error. |
| D11 | **Opening the view fetches if stale.** On the first watched read after an unwatched stretch, a last fetch older than the interval (or none) runs at once; a fresh one keeps its schedule. |
| D12 | **No memo work.** Git Stats memoises by `(toplevel, branch sha, base sha)`; a fetch that moves `origin/<trunk>` changes the base sha, so the next read recounts on its own. A manual fetch ends with the client's `refresh()`; a timer fetch shows on the next 30s poll. |

## §1 Server: `server/lib/git-fetch.ts`

New module, Node built-ins only. It never imports `git-stats.ts`' reader; it shares the runner shape (array-form `execFile`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`)
through the same `overrideGitRunner` seam so tests can swap it.

**`fetchAll(pins): Promise<FetchClock>`.** Resolves each pin to its toplevel and common dir with the two `rev-parse` calls Git Stats already makes (a dead or
non-git pin is skipped). Repos are grouped by common dir; one `git fetch origin …` per group, groups in parallel, each with the D4 flags and D5 environment, cwd the
group's first toplevel. A group whose repo has no remote named `origin` is skipped. Per **toplevel** it records `{ atMs, error, message }` where `error` is
`null | 'auth' | 'offline' | 'lock' | 'timeout' | 'other'` and `message` is the first stderr line (≤ 160 chars) for `other`, else `null`. One module-level
in-flight promise (D6).

**`classifyFetchError(stderr, timedOut): FetchError`** is a pure function, tested as a table. Case-insensitive, first match wins, in this order:

| Kind      | stderr contains any of                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `timeout` | — (`timedOut` is true)                                                                                                               |
| `auth`    | `Permission denied (publickey`, `Authentication failed`, `could not read Username`, `terminal prompts disabled`, `Host key verification failed` |
| `offline` | `Could not resolve host`, `Network is unreachable`, `Connection refused`, `Connection timed out`, `Could not connect`, `No route to host` |
| `lock`    | `cannot lock ref`, `.lock': File exists`, `Unable to create` … `.lock`                                                               |
| `other`   | anything else, non-zero exit                                                                                                         |

**The timer.** `startGitFetchTimer()` is called once from `server/index.ts` at boot and never from a request. A 5s `setInterval` (unref'd) reads
`getSettings().gitFetchSecs` every tick, so a change in Settings needs no restart (the `usage-history.ts` shape). It runs `fetchAll` when all of: interval > 0,
watched (D2), `Date.now() ≥ nextAtMs`, nothing in flight. `nextAtMs` is `lastEndedMs + interval`, recomputed when the interval changes; on becoming watched
it is `now` when `lastEndedMs` is null or older than the interval (D11). While off or unwatched `nextAtMs` is `null`. `markGitWatched()` is called by
`serveGitStats` on every answer; the timer owns the clock state, `getFetchClock()` reads it.

## §2 API

`shared/types.ts` first (the rule), then the producers, then the client.

`GET /api/git-stats` gains a top-level `fetch: FetchClock`:

| Field            | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `intervalSecs`   | the setting; `0` = off                                                                                    |
| `nextAtMs`       | server clock of the next timer fetch; `null` when off, unwatched or never scheduled                       |
| `runningSinceMs` | server clock the in-flight fetch started; `null` when idle                                                |
| `lastEndedMs`    | server clock the last fetch finished; `null` before the first                                             |

and every `ok` repo gains `lastFetch: { atMs, error, message } | null`, `null` for a repo never fetched by this process (its `fetchedAtMs` still says what
`FETCH_HEAD` says — the two are different facts: "when any tool last fetched" and "what the server's own last fetch said").

`POST /api/git-fetch` — no body. `403 { error: 'bad token' }` when `tokenOk` fails. Otherwise awaits `fetchAll` (joining one in flight) and answers
`200 { fetch: FetchClock }`. Method-checked: anything but POST is `405`. `/api/health` already reports `tokenRequired`; the client reads it for D8.

## §3 Settings

`gitFetchSecs` joins `Stored` and `ServerSettings` (`shared/types.ts`), default `0`. `clampGitFetchSecs(value)` accepts exactly the six values, anything
else is `null` and the patch is refused like a bad `idleSecs`. It is read on every timer tick, never cached by the timer. The Shared page gets a **Git fetch**
card after Usage forecast: title "Git fetch", sub "How Management › Git learns what landed on origin", one row "Auto-fetch" with the mock's hint verbatim and
a `Segmented` of `Off · 30s · 1m · 2m · 5m · 10m`. `docs/subsystems/settings.md` documents the key beside `recordUsageHistory`, with the same reasoning.

## §4 Client: the clock chip

**Where.** `GitView`'s toggle row becomes `.git-toolbar`: the `.seg` switcher, then `GitClockChip`, wrapping under the switcher below `md`. `Band` renders
no `right`; `GitBandStatus` is deleted. The band's sub-line becomes "Local state of your pinned repos. Fetches from origin on the timer set in Settings;
nothing here pulls or pushes."

**The chip** (`client/src/components/management/GitClockChip.tsx`) is one `<button aria-haspopup="dialog">` at the switcher's 38px height, `--strip-hi` paper,
12px corners, holding two meters and a caret. Its accessible **name** is fixed ("Sync and fetch clocks") and the meters are its `aria-describedby`, because a
name that changes every second is re-announced every second. The meters are a `.ui-meter` port of backlog-manager's (label 11px/500 `--ink3`, value 11px/700
`--ink`, 3.5px track `--steel`, fill `--green`; `data-tone="amber"` fills and colours the value amber, `data-tone="live"` fills `--cyan` and pulses, still
under `prefers-reduced-motion`), tokens only. A 1s tick re-renders it while mounted, as `GitBandStatus` did.

| Meter   | Source                                                                       | Value                                                                                   |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `SYNC`  | `useGitStats` exposes `nextPollAtMs` (the client clock of its next poll) and `polling` | `12s`, fraction elapsed of 30s; `…` with an empty bar while the first poll is out; `syncing…` live while a poll runs |
| `FETCH` | `fetch` from the payload, server clocks shifted by the skew measured at the last answer | `3:12` (`m:ss` ≥ 60s, else `Ns`), fraction elapsed of the interval; `off` amber, empty bar; `fetching…` live, full bar; `…` when scheduled but `nextAtMs` null; `overdue` amber, full bar when `now > nextAtMs + interval` |

**The popover** (`.git-pop`, mounted only while open, 420px, left-anchored under the chip; below `md` anchored to the toolbar row so it spans the row) is dismissed
by this repo's `useDismiss` (pointerdown outside + Escape, [Popover.tsx](../../../client/src/components/Popover.tsx)). Rows, grid `name | 120px meter | key`:

| Row            | Sub-line                                                         | Meter                 | Key                                                                                    |
| -------------- | ---------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| **Local sync** | `re-reads the repos on disk · every 30s`                         | `next` + SYNC reading | `now` → `refresh()`; a no-op while a poll is in flight (today's ↻)                      |
| **Fetch all**  | `git fetch origin · every {5 min}` or, off, `auto-fetch off · Settings › Shared` (amber) | `next` + FETCH reading | `now` → `POST /api/git-fetch` then `refresh()`; reads `fetching…` and is disabled while one runs; disabled with sub `needs the answer token (Settings › Connection)` when `tokenRequired` and none is stored |

Under the rows, when any `ok` repo's `lastFetch.error` is non-null and not `lock`: one line per such repo in pin order, `<name> needs auth · fetched 2d ago`
(`needs auth` / `offline` / `fetch timed out` / `fetch failed`, amber; the age is `gitFetchedText`). Nothing else: no links, no per-repo keys.

**Cards, Table, Triage.** `gitFetchedText` grows: while `runningSinceMs` is set and the repo has an `origin`, `fetching…` (`.live`); when `lastFetch.error`
is one of the four shown kinds, `needs auth · fetched 2d ago` etc. (`.warn`), and `needs auth · never fetched` when `fetchedAtMs` is null; `lock` and `null`
read as today. The Table's Fetched column shows the same string. Triage is unchanged: a failed fetch does not move a repo between groups.

**Copy.** Every string above lives in `client/src/lib/gitStatsText.ts`; the components build none. The interval reads `30s`, `1 min`, `2 min`, `5 min`,
`10 min`.

## §5 Tests

Plans and tasks specify cases and expected values, never literal code; the implementer writes the tests.

`test/git-fetch.test.ts`, over `GitFixture` repos with a **bare `file://` origin** (a real fetch with no network; extend the fixture with the helper if it lacks
one):

1. A commit added to the bare origin: before `fetchAll`, Git Stats reads `trunkVsOrigin.behind === 0`; after, `1`. No memo call is made (D12).
2. Two concurrent `fetchAll` calls return the **same promise** and the runner sees one `fetch` per repo.
3. Two pins in one repo (the main worktree and a linked one) produce **one** `fetch`, and both toplevels get the same `lastFetch`.
4. A repo without `origin` gets `lastFetch: null`, no `fetch` call, and the other repos are fetched.
5. `classifyFetchError` table: one line per pattern in §1 plus `timedOut` beating an `auth` line, plus an unknown non-zero exit → `other` with `message` the
   first stderr line truncated to 160.
6. The runner receives `GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND` is set to the BatchMode value when the env has neither var and left untouched when it has
   either; argv is exactly `['fetch', 'origin', '--quiet', '--no-auto-gc', '--no-auto-maintenance']`.
7. Timer, with injected clock and setting: interval 0 → never runs; interval 60, unwatched → never runs; watched → runs when `now ≥ nextAtMs` and not before;
   `nextAtMs` after a run is `lastEndedMs + 60_000`; changing the interval to 300 moves `nextAtMs` to `lastEndedMs + 300_000`; watched expires after
   `max(2 × interval, 90s)` with no read.
8. D11: becoming watched with no prior fetch sets `nextAtMs = now`; with one 10s old at interval 60 sets `lastEndedMs + 60_000`.
9. A `lock` result leaves `fetchedAtMs`-based copy unchanged and the timer's next tick runs again.

`test/api-git-fetch.test.ts`: `POST` with a token configured and none sent → 403, nothing fetched; with the bearer → 200 and `fetch.lastEndedMs` set; `GET`
→ 405; `GET /api/git-stats` carries `fetch` and each `ok` repo's `lastFetch`.

Settings tests: `clampGitFetchSecs` accepts the six values, rejects `45`, `-1`, `'300'`, `null`; a `POST /api/settings` with `gitFetchSecs: 45` is refused
whole; the default is `0`.

`test/outbound.test.ts`: `ALLOWED` is **unchanged** — `git-fetch.ts` imports no network module and calls no `fetch(`; the doc half still passes because the
outbound sentence stays plural. Add the one assertion that keeps the doc honest: the CLAUDE.md sentence names `lib/git-fetch.ts` among the git/CLI launchers.

Client (`test/git-stats-client.test.ts` or a sibling): the FETCH reading for each state in §4's table with fixed clocks (`3:12` at 192s left of 300, `12s`,
`off`, `fetching…`, `overdue`); skew: a server `nextAtMs` 10s ahead of a client clock 5s behind reads `15s`; `gitFetchedText` for the five error states
and the never-fetched corner; the chip is not rendered before the first payload; the popover's trouble lines skip `lock`.

## §6 Docs

- `docs/subsystems/git-stats.md`: "Why there is no fetch" becomes "**The fetch**" (D1–D12 in prose, the env, the flags, the watched gate); the payload table
  gains `fetch` and `lastFetch`; "Client" gains the toolbar chip and loses the band's right slot.
- `docs/subsystems/settings.md`: `gitFetchSecs` beside `recordUsageHistory`, the same "server-side timer, so Shared" reasoning.
- `.claude/CLAUDE.md`: the outbound rule's launcher sentence adds `lib/git-fetch.ts` ("launches `git fetch`, which makes its own network call — not a third
  kind, like the CLI launchers").
- `docs/overview.md`: `lib/git-fetch.ts` in the map, `POST /api/git-fetch` in the API table, `GitClockChip` in the components line.
- Run `/docs-sync` after the merge so the stamps follow.

## Verification

- `pnpm test`, `pnpm typecheck`, `pnpm build` green, output quoted in the PR.
- Live, this machine, `gitFetchSecs: 30`: open Management › Git, watch `.git/FETCH_HEAD`'s mtime in this repo advance every ~30s; close the view, confirm it
  stops advancing within 90s (D2); press *Fetch all*, confirm one advance and the "behind" count matching `git rev-list --left-right --count main...origin/main`.
- Phone (375px): the chip wraps under the toggle, the popover stays inside the viewport, nothing scrolls sideways.
- Not verified by any test and needing a human: the `auth` path against a real passphrase key or an agent prompt (this machine's keys don't prompt), and
  whether the pulse and drop animations read right. The PR says so.

## Out of scope

- `--prune`, remotes other than `origin`, pulls, pushes — git-sync's job.
- A per-repo fetch key, or fetching from the Sessions view.
- Backoff after repeated failures (≥ 30s between tries is already slow).
- Remote-only branches in the branch list (futin/claude-agents-dashboard#164).
- Showing the fetch clock anywhere but Management › Git.
