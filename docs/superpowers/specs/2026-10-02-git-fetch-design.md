# Git fetch — design

Management › Git shows how far each pinned repo's trunk is behind `origin`, but only as of whoever last ran `git fetch` there. WebStorm fetches the repos it has
open; the rest go stale, and the view can only say "fetched 2d ago". This adds the fetch: the **server** runs `git fetch origin` over every pinned repo on a
timer you set in Settings, only while somebody has the Git view open (plus a short grace period, D2), and a **Fetch all** you can press. Nothing pulls,
pushes or prompts in the terminal. No Claude session is involved: a fetch is one git process per repo, about half a second and zero tokens.

Brainstormed 2026-10-02 in this repo. Builds on [the Git Stats spec](2026-10-01-git-stats-design.md) (§2 reader, §6 sub-view, §9 Sync button) and leaves
its reader read-only: the fetch is a module of its own. It **supersedes** the parent's D4 ("the server never runs `git fetch`") and its Out-of-scope line for
`git fetch`. Review round 1: [2026-10-02-git-fetch-design-review-1.md](../reviews/2026-10-02-git-fetch-design-review-1.md).

Mockups: [2026-10-02-git-fetch-mockups.html](2026-10-02-git-fetch-mockups.html), the chosen shape (P1) at desktop and 375px with its states, the card copy and
the Settings card. Where the two disagree, **this spec wins**. Known differences:

- The mock's popover lists one failed repo ("needs auth"). §4 lists every repo whose last fetch failed, one line each, in pin order.
- The mock's band sub-line and Settings hint are built verbatim; the Settings card's sub drops the mock's trailing period, as the other cards' subs do.
- The mock preselects `5m`. D3 makes a fresh install **Off**.
- The mock's chip shows no `0s`, `overdue` or `failed` readings; §4's table has them.
- The mock draws the toggle row's chip only on the Git sub-view; Pinned never shows it. That is the design, not a mock shortcut.

## Decisions

| #   | Decision                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **The server owns the timer**, one per process. The browser's 30s poll stays a read of disk; three open tabs are one fetch schedule, not three.                      |
| D2  | **Watched-only.** The timer fires only while `GET /api/git-stats` was served within the last `max(2 × interval, 90s)`. After a tab closes the server may run at most one or two more fetches inside that grace period, then none. |
| D3  | **Off by default.** `gitFetchSecs ∈ {0, 30, 60, 120, 300, 600}`, a Shared setting; a fresh install is Off until you pick. The precedent is `recordUsageHistory`: a server-side network timer is a switch the user throws. |
| D4  | **Origin only, refs only.** `git fetch origin --quiet --no-prune --no-recurse-submodules --no-auto-maintenance`, once per **common dir** (two pins in one repo, a worktree pin included, are one fetch), 30s timeout, no pull. The flags make the guarantee hold against a user's `fetch.prune` / `remote.origin.prune` / `fetch.recurseSubmodules`; `--no-auto-maintenance` needs git ≥ 2.29, under Git Stats' existing 2.31 floor. |
| D5  | **Never prompts in the terminal.** `GIT_TERMINAL_PROMPT=0` always. ssh: when the repo configures `core.sshCommand`, or the environment sets `GIT_SSH_COMMAND` or `GIT_SSH`, ssh is left exactly as the user set it; otherwise `GIT_SSH_COMMAND=ssh -o BatchMode=yes`. A passphrase key or a login then fails as `auth` and says so. A GUI agent prompt (1Password, Secretive, a credential manager) is outside git's control and may still appear; Verification names it. |
| D6  | **One fetch in flight.** A call while one runs returns the same promise, timer and button alike, so a mashed key or a tick landing on a click is one fetch.           |
| D7  | **No second poll.** The clock and each repo's last-fetch verdict ride in `GET /api/git-stats`; the chip counts down client-side from `nextAtMs`, and asks for one early poll when the clock comes due (§4). |
| D8  | **`POST /api/git-fetch`** runs a fetch now; guarded by `tokenOk` exactly as `POST /api/settings` is. A browser without its answer token sees the key disabled with the reason. |
| D9  | **The band loses its right slot.** ↻, "updated Ns ago" and "couldn't update" move into a clock chip beside the layout toggle; ↻ becomes the popover's *Local sync › now*. |
| D10 | **Failures are per repo and quiet.** `auth`, `offline`, `timeout`, `other` show amber on the card and in the popover and the timer keeps going; `lock` (a clash with another git process) shows nothing and the **next scheduled fetch** retries; a repo with no `origin` is skipped, not an error. |
| D11 | **Entering the schedule fetches if stale.** Whenever the clock becomes schedulable — the first watched read after an unwatched stretch, or the interval going from Off to a value — a last fetch older than the new interval (or none) runs at once; a fresh one keeps `lastEndedMs + interval`. |
| D12 | **No memo work.** Git Stats memoises by `(toplevel, branch sha, base sha)`; a fetch that moves `origin/<trunk>` changes the base sha, so the next read recounts on its own. A manual fetch ends with the client's `refresh()`; a timer fetch shows on the early poll (§4) or the next 30s one. |
| D13 | **A second git process per repo, by design.** Git Stats' "one git process per repo" rule is about the reader's own calls; the fetch is a separate process and can collide with your own git or with a Sync run's `fetch --all --prune` (`plugin/skills/git-sync/tools/git-sync.mjs:556`), which then stops with `fetch-failed` and is pressed again. The window is one fetch (~0.5s) per repo per interval; accepted rather than detected. |

## §1 Server: `server/lib/git-fetch.ts`

New module, Node built-ins only. It does not import `git-stats.ts`' reader and does not reuse its runner: `GitRunner` is `(cwd, args)` with a fixed 5s timeout
(`server/lib/git-stats.ts:18,38`). The fetch has its own **`FetchRunner = (cwd, args, env) => Promise<{ code, stdout, stderr, timedOut }>`**, default
`execFile` with a 30s timeout, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, behind its own `overrideFetchRunner(run | null)` seam for tests.

**`fetchAll(config): Promise<FetchClock>`.** Reads the pins through `listPinRows(config, …)` as `readGitStats` does (`git-stats.ts:389`). Per pin, one
`rev-parse --path-format=absolute --show-toplevel --git-common-dir` (a dead or non-git pin is skipped); repos are grouped by common dir. Per group, `git remote`
decides whether `origin` exists — a group without it is skipped. One `git fetch origin …` per remaining group with the D4 flags, groups in parallel, cwd the
group's first toplevel. The ssh rule (D5) is decided per group: `git config --get core.sshCommand` set → env untouched; else env already has `GIT_SSH_COMMAND`
or `GIT_SSH` → untouched; else `GIT_SSH_COMMAND=ssh -o BatchMode=yes`. Per **toplevel** it records `lastFetch: { atMs, error }`, `atMs` the moment the
group's fetch ended, `error` one of `null | 'auth' | 'offline' | 'lock' | 'timeout' | 'other'`.

`fetchAll` **owns the clock state** (module-level, read by `getFetchClock()`): it sets `runningSinceMs` when it starts, clears it and sets `lastEndedMs` when it
ends, then sets `nextAtMs = lastEndedMs + interval` when the interval is non-zero (else `null`). The timer only decides *when* to call it; the POST calls it
directly, so a manual fetch resets the schedule. One module-level in-flight promise (D6).

**`classifyFetchError(stderr, timedOut): FetchError`** is a pure function, tested as a table. Case-insensitive, first match wins, in this order:

| Kind      | stderr contains any of                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `timeout` | — (`timedOut` is true)                                                                                                               |
| `auth`    | `Permission denied (publickey`, `Authentication failed`, `could not read Username`, `terminal prompts disabled`, `Host key verification failed` |
| `offline` | `Could not resolve host`, `Network is unreachable`, `Connection refused`, `Connection timed out`, `Could not connect`, `Couldn't connect to server`, `Failed to connect to`, `No route to host` |
| `lock`    | `cannot lock ref`, `.lock': File exists`, `Unable to create` … `.lock`                                                               |
| `other`   | anything else, non-zero exit                                                                                                         |

**The timer.** `startGitFetchTimer(config)` is called once from `server/index.ts` at boot and never from a request. A 5s `setInterval` (unref'd) reads
`getSettings().gitFetchSecs` every tick, so a change in Settings needs no restart (the `usage-history.ts` shape). It calls `fetchAll` when all of: interval > 0,
watched (D2), `Date.now() ≥ nextAtMs`, nothing in flight. The D11 rule sets `nextAtMs` on either entry into the schedule: `now` when `lastEndedMs` is null or
older than the interval, else `lastEndedMs + interval`; a change between two non-zero intervals recomputes `lastEndedMs + newInterval`. While off or unwatched
`nextAtMs` is `null`. `markGitWatched()` is called by `serveGitStats` **before** it reads `getFetchClock()` for the same answer, so the first answer after an
unwatched stretch already carries the schedule.

## §2 API

`shared/types.ts` first (the rule), then the producers, then the client.

`GET /api/git-stats` gains a top-level `fetch: FetchClock`:

| Field            | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `intervalSecs`   | the setting; `0` = off                                                                                    |
| `nextAtMs`       | server clock of the next timer fetch; `null` when off or unwatched                                        |
| `runningSinceMs` | server clock the in-flight fetch started; `null` when idle                                                |
| `lastEndedMs`    | server clock the last fetch finished; `null` before the first                                             |

and every `ok` repo gains `lastFetch: { atMs, error } | null`, `null` for a repo never fetched by this process (its `fetchedAtMs` still says what `FETCH_HEAD`
says — the two are different facts: "when any tool last fetched" and "what the server's own last fetch said").

`POST /api/git-fetch` — no body. `403 { error: 'bad token' }` when `tokenOk` fails. Otherwise awaits `fetchAll` (joining one in flight) and answers
`200 { fetch: FetchClock }`. Anything but POST is `405`. `/api/health` already reports `tokenRequired`; the client reads it for D8.

## §3 Settings

`gitFetchSecs` joins `Stored` (`server/lib/settings.ts:75`) and `ServerSettings` (`shared/types.ts`), default `0`. `parseGitFetchSecs(value)` accepts exactly
the six values and returns `null` for anything else; a patch with a bad value is refused whole, like a bad `idleSecs`. It is read on every timer tick, never
cached by the timer. The Shared page gets a **Git fetch** card after Usage forecast: title "Git fetch", sub "How Management › Git learns what landed on origin",
one row "Auto-fetch" with the mock's hint verbatim and a `Segmented` of `Off · 30s · 1m · 2m · 5m · 10m` — six options where its doc comment says two to four;
the comment is relaxed to say so and the 375px fit is in Verification. `docs/subsystems/settings.md` documents the key beside `recordUsageHistory`: Shared
because only a server-side timer can act on it, and unlike that key it idles while nobody watches (D2).

## §4 Client: the clock chip

**Where.** `GitView`'s toggle row becomes `.git-toolbar`: the `.seg` switcher, then `GitClockChip`, wrapping under the switcher below `md`. `Band` renders
no `right`; `GitBandStatus` is deleted and its three readings (updated / couldn't update / ↻) live on in the chip. The band's sub-line becomes "Local state
of your pinned repos. Fetches from origin on the timer set in Settings; nothing here pulls or pushes."

**The chip** (`client/src/components/management/GitClockChip.tsx`) is one `<button aria-haspopup="dialog">` at the switcher's 38px height, `--strip-hi` paper,
12px corners, holding two meters and a caret. Rendered only once there is a payload, like the rest of the body. Its accessible **name** is fixed ("Sync and
fetch clocks") and the meters are its `aria-describedby`, because a name that changes every second is re-announced every second. The meters are a port of
backlog-manager's `.ui-meter`, `git-`-prefixed per `.claude/DESIGN.md` §8.4b: `.git-meter` (label 11px/500 `--ink3`, value 11px/700 `--ink`, 3.5px track
`--steel`, fill `--green`; `data-tone="amber"` fills and colours the value amber, `data-tone="live"` fills `--cyan` and pulses; static under
`prefers-reduced-motion`), tokens only. A 1s tick re-renders it while mounted, as `GitBandStatus` did.

`useGitStats` grows `nextPollAtMs` (client clock of its next poll), `polling` (a request is out) and `skewMs = clientReceiptMs − generatedAt` of the last good
answer; every server clock below is read as `serverMs + skewMs`.

| Meter   | Reading, first match wins                                                                                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC`  | `syncing…` live, full bar, while `polling` · `failed` amber, full bar, when the last poll failed (`error && data`, today's "couldn't update") · `12s` with the fraction of 30s elapsed |
| `FETCH` | `fetching…` live, full bar, while the payload's `runningSinceMs` is set **or this client's own POST is out** · `off` amber, empty bar, when `intervalSecs === 0` · `overdue` amber, full bar, when `now > nextAtMs + interval` · `0s` green, full bar, when `nextAtMs ≤ now` · `3:12` (`m:ss` ≥ 60s, else `Ns`) with the fraction of the interval elapsed · `…` empty bar in any other case (`nextAtMs` null with the interval on) |

**The early poll.** When the FETCH clock first reaches `0s` for a given `nextAtMs`, the chip calls `refresh()` once, 3s later, so a timer fetch shows within
seconds instead of at the next 30s tick; the regular schedule is otherwise unchanged. After a manual fetch's POST resolves, `refresh()` runs at once.

**The popover** (`.git-pop`, mounted only while open, 420px, left-anchored under the chip; below `md` anchored to the toolbar row so it spans the row) is dismissed
by this repo's `useDismiss` (pointerdown outside + Escape, [Popover.tsx](../../../client/src/components/Popover.tsx)). Rows, grid `name | 120px meter | key`:

| Row            | Sub-line                                                         | Meter                 | Key                                                                                    |
| -------------- | ---------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| **Local sync** | `re-reads the repos on disk · every 30s`; after a failed poll, amber `couldn't update · retrying every 30s` | `next` + SYNC reading | `now` → `refresh()`; a no-op while a poll is in flight (today's ↻)                      |
| **Fetch all**  | `git fetch origin · every 5 min` (`30s`, `1 min`, `2 min`, `5 min`, `10 min`: the long forms in prose, the short ones only in the Settings segments) or, off, amber `auto-fetch off · Settings › Shared` | `next` + FETCH reading | `now` → `POST /api/git-fetch` then `refresh()`; reads `fetching…` and is disabled while one runs (payload or own POST) |

The Fetch-all key's failure states, each replacing the sub-line in amber: no token stored while `tokenRequired` → key disabled, `Fetch all needs the Answer
token — set it under Settings › Local › Connection.` (`FETCH_NEEDS_TOKEN`, the shape of `SYNC_NEEDS_TOKEN`, `client/src/lib/gitSync.ts:25`); POST answered
`403` → key disabled, `fetch refused: bad token — check it under Settings › Local › Connection.`; POST failed any other way (network, 5xx) → key enabled again,
`couldn't start the fetch` until the next successful one.

Under the rows, when any `ok` repo's `lastFetch.error` is non-null and not `lock`: one line per such repo in pin order, `<name> needs auth · fetched 2d ago`
(`needs auth` / `offline` / `fetch timed out` / `fetch failed`, amber; the age is `gitFetchedAgeText`, today's `gitFetchedText` renamed). Nothing else: no
links, no per-repo keys.

**Cards, Table, Triage.** `gitFetchedText(repo, clock)` now composes: while `runningSinceMs` is set and the repo `hasOrigin`, `fetching…` (`.live`); when
`lastFetch.error` is one of the four shown kinds, `needs auth · fetched 2d ago` etc. (`.warn`), and `needs auth · never fetched` when `fetchedAtMs` is null;
`lock` and `null` read as the plain age. The Table's Fetched column and Triage's summary line (`GitTriage.tsx:62`) use the same string, so a Quiet row's
summary also carries the reason. Triage grouping is unchanged: a failed fetch does not move a repo between groups.

**Copy.** Every string above lives in `client/src/lib/gitStatsText.ts`; the components build none. "Local sync" is the user's name for the 30s re-read and
stays, although each card's **Sync** key means git-sync: the popover sub-line says what it is.

## §5 Tests

Plans and tasks specify cases and expected values, never literal code; the implementer writes the tests.

`test/git-fetch.test.ts`, over `GitFixture` repos using its existing `bare()` and `clone()` (`test/git-fixture.ts:78,93`; a plain-path origin, a real fetch
with no network):

1. A commit added to the bare origin: before `fetchAll`, Git Stats reads `trunkVsOrigin.behind === 0`; after, `1`. `gitStatsMemoKeys()` is identical before
   and after `fetchAll` (D12).
2. Two concurrent `fetchAll` calls return the **same promise** and the runner sees one `fetch` per repo.
3. Two pins in one repo (the main worktree and a linked one) produce **one** `fetch`, and both toplevels get the same `lastFetch`.
4. A repo without `origin` (the runner saw `git remote` answer without it): `lastFetch: null`, no `fetch` call, the other repos fetched.
5. `classifyFetchError` table: one line per pattern in §1, including `Failed to connect to 127.0.0.1 port 1 after 1 ms: Couldn't connect to server` → `offline`,
   plus `timedOut` beating an `auth` line, plus an unknown non-zero exit → `other`.
6. The runner receives `GIT_TERMINAL_PROMPT=0`; argv is exactly `['fetch', 'origin', '--quiet', '--no-prune', '--no-recurse-submodules', '--no-auto-maintenance']`;
   ssh, four cases: nothing configured → `GIT_SSH_COMMAND` is `ssh -o BatchMode=yes`; env `GIT_SSH_COMMAND` set → untouched; env `GIT_SSH` set → untouched;
   repo `core.sshCommand` set (and the env clean) → `GIT_SSH_COMMAND` absent.
7. Clock state is `fetchAll`'s: with no timer started, a call sets `runningSinceMs` while running, then `lastEndedMs`, and `nextAtMs = lastEndedMs + 60_000`
   at interval 60, `null` at interval 0.
8. Timer, with injected clock and setting: interval 0 → never runs; interval 60, unwatched → never runs; watched → runs when `now ≥ nextAtMs` and not before;
   changing 60 → 300 moves `nextAtMs` to `lastEndedMs + 300_000`; watched expires after `max(2 × interval, 90s)` with no read (`120s` at 60, `90s` at 30).
9. D11, four cases: becoming watched with no prior fetch → `nextAtMs = now`; with one 10s old at interval 60 → `lastEndedMs + 60_000`; Off → 60 with no prior
   fetch → `now`; Off → 60 with one 30s old → `lastEndedMs + 60_000`.
10. A `lock` result is recorded, `nextAtMs` is the ordinary `lastEndedMs + interval`, and the next scheduled run fetches that group again.

`test/api-git-fetch.test.ts`: `POST` with a token configured and none sent → 403, nothing fetched; with the bearer → 200 and `fetch.lastEndedMs` set; `GET`
→ 405; `GET /api/git-stats` carries `fetch` and each `ok` repo's `lastFetch`, and its first answer after an unwatched stretch has a non-null `nextAtMs` when the
interval is on.

Settings tests: `parseGitFetchSecs` accepts the six values, rejects `45`, `-1`, `'300'`, `null`; a `POST /api/settings` with `gitFetchSecs: 45` is refused
whole; the default is `0`.

`test/outbound.test.ts`: `ALLOWED` is **unchanged** — `git-fetch.ts` imports no network module and calls no `fetch(`; the doc half still passes because the
outbound sentence stays plural. Add one assertion: the CLAUDE.md launcher sentence names `lib/git-fetch.ts`.

Client (`test/git-stats-client.test.ts` or a sibling): each FETCH reading in §4's table with fixed clocks (`3:12` at 192s left of 300, `12s`, `0s` at
`nextAtMs ≤ now`, `overdue` at `nextAtMs + interval + 1`, `off`, `fetching…` from `runningSinceMs` and from an own POST, `…`); precedence: `fetching…` beats
`off`; skew: `generatedAt = S`, `nextAtMs = S + 10_000`, received at client clock `S − 5_000` → `skewMs = −5_000` and the reading at receipt is `10s` (the
uncorrected `15s` is the bug); SYNC `failed` when `error && data`; the early poll fires `refresh()` once per `nextAtMs`, 3s after `0s`, and not again for the
same value; `gitFetchedText` for the five error states and the never-fetched corner; the popover's trouble lines skip `lock`; the Fetch-all key's three failure
states and copy.

## §6 Docs

- `docs/subsystems/git-stats.md`: "Why there is no fetch" becomes "**The fetch**" (D1–D13 in prose, the env, the flags, the watched gate); line 15's "Nothing
  here fetches … or writes to a repo" is rewritten (a fetch writes refs, objects and `FETCH_HEAD`); the one-process-per-repo rule gains D13's caveat; the
  payload table gains `fetch` and `lastFetch`; "Client" gains the toolbar chip and loses the band's right slot and "couldn't update".
- `docs/subsystems/settings.md`: `gitFetchSecs` beside `recordUsageHistory`, §3's reasoning.
- `.claude/CLAUDE.md`: the outbound rule's launcher sentence adds `lib/git-fetch.ts` ("launches `git fetch`, which makes its own network call — not a third
  kind, like the CLI launchers"). `README.md:15`'s outbound sentence gets the same clause.
- `.claude/DESIGN.md` §8.4b: the band's right slot and "couldn't update" move to the chip; `.git-meter` joins the class list.
- `docs/overview.md`: `lib/git-fetch.ts` in the map, `POST /api/git-fetch` in the API table, `GitClockChip` in the components line, and line 325's "no fetch"
  dropped from the git-stats entry.
- Run `/docs-sync` after the merge so the stamps follow.

## Verification

- `pnpm test`, `pnpm typecheck`, `pnpm build` green, output quoted in the PR.
- Live, this machine, `gitFetchSecs: 30`: open Management › Git, watch the fetch stamp advance every 30–35s plus fetch time — `.git/FETCH_HEAD` of this repo's
  main worktree, or `.git/worktrees/<name>/FETCH_HEAD` when the group's first toplevel is a linked worktree (`git-stats.ts:144`); close the view, confirm no
  advance starts later than 90s after the last read (D2); press *Fetch all*, confirm one advance and the "behind" count matching
  `git rev-list --left-right --count main...origin/main`.
- Phone (375px): the chip wraps under the toggle, the popover stays inside the viewport, the six-segment Auto-fetch control fits one line, nothing scrolls
  sideways.
- Not verified by any test and needing a human: the `auth` path against a real passphrase key, and whether a GUI agent (1Password, Secretive) prompts despite
  BatchMode (this machine's keys don't prompt); whether the pulse and drop animations read right. The PR says so.

## Out of scope

- `--prune`, remotes other than `origin`, pulls, pushes — git-sync's job.
- Detecting a live Sync run to dodge it (D13 accepts the race).
- A per-repo fetch key, or fetching from the Sessions view.
- Backoff after repeated failures (≥ 30s between tries is already slow).
- Remote-only branches in the branch list (the parent spec's D5; the Multi-machine hub, futin/claude-agents-dashboard#164, covers cross-machine state).
- Showing the fetch clock anywhere but Management › Git.
