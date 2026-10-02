# Git Stats — read-only local git state per pinned project

`GET /api/git-stats` answers, for every **pinned** project (`getPinnedProjects`, in pin order), whether its repo has uncommitted work, which local branches carry
unmerged work and how far they are from the trunk, and when the remote-tracking refs were last refreshed. The Management tab's Git sub-view draws it. The
reader is `server/lib/git-stats.ts`; the payload types (`RepoGitStats`, `GitBranch`, `GitStatsResponse`) are in `shared/types.ts`. Design record:
`docs/superpowers/specs/2026-10-01-git-stats-design.md`.

Repo paths come from `listPinRows` (the same rows `GET /api/pins` serves), never from the request: the route takes no parameters and, like the read routes
beside it, does not check the method. Git must be **2.31 or newer** (`rev-parse --path-format=absolute`).

## The reader stays read-only

Every git call the reader makes runs against local refs and is an array-form `execFile` (never a shell) with a 5s timeout and `GIT_OPTIONAL_LOCKS=0` (so
`git status` never takes `index.lock` while you run git yourself), `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`. The reader never fetches, pulls, pushes, calls `gh`
or writes to a repo; `commit-tree` is out for the same reason. The numbers are as fresh as the last fetch anybody ran, the server's own included, which is why
the payload carries `fetchedAtMs` and the client shows its age. Branches are **local only**: one pushed from another machine appears once it is checked out
here.

The 5s timeout is `makeGitRunner`'s own timer, not `execFile`'s `timeout` option. When the event loop stalls past the timeout, Node's option fires before the
already-exited child's exit is read, destroys stdout, and still reports success with empty output — an empty `for-each-ref` that reads as "no branches" (#168).
The runner's timer only kills the child; the child's real exit decides the result, so a finished call keeps its output and only a child that died by the kill
rejects `GitTimeoutError`.

## The fetch

`server/lib/git-fetch.ts` is the one place the server runs `git fetch` (design record: `docs/superpowers/specs/2026-10-02-git-fetch-design.md`, D1–D13). It
imports nothing from the reader and has its own runner. It is a module of its own so the reader above stays read-only; a fetch does write — refs, objects and
`FETCH_HEAD` — but only remote-tracking refs and the tags origin sends, never a local branch, the index or the working tree.

- **One timer per server process** (D1), started by `startGitFetchTimer` in `server/index.ts`'s main guard, never at module level, since the API test
  harness imports `index.ts`. A 1s unref'd tick reads `gitFetchSecs` from the settings cache (`getGitFetchSecs`), so a change in Settings needs no restart.
- **Off by default** (D3): `gitFetchSecs ∈ {0, 30, 60, 120, 300, 600}`, `0` = off, a Shared setting ([settings](settings.md)).
- **Watched-only** (D2). Every `GET /api/git-stats` answer calls `markGitWatched()`; the timer fires only while the last one is younger than
  `max(2 × interval, 90s)`. After the last tab closes the server runs at most two more fetches (three at 30s), then none. A hidden tab stops polling, so it
  stops watching too.
- **Entering or changing the schedule fetches if stale** (D11): on the first watched read after an unwatched stretch, Off to a value, or one value to another,
  a last fetch older than the new interval (or none) runs at once; a fresh one keeps `lastEndedMs + interval`.
- **What runs** (D4): `git -c core.hooksPath=/dev/null fetch origin --quiet --no-prune --no-recurse-submodules --no-auto-maintenance`, once per **common dir**
  (two pins in one repo, a linked-worktree pin included, are one fetch), groups in parallel, 30s timeout, origin only, no pull. A repo with no `origin` is
  skipped, and a skipped repo's last verdict is cleared.
- **Never prompts** (D5): spawned `detached: true` with stdin ignored, env overlay `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=''`, `SSH_ASKPASS=''`. ssh gets `GIT_SSH_COMMAND=ssh -o BatchMode=yes` unless the repo sets `core.sshCommand` or the environment sets
  `GIT_SSH_COMMAND` / `GIT_SSH`, which are left alone. A timeout kills the whole process group. An ssh-agent's own confirmation dialog is not git's and may
  still appear.
- **One fetch in flight** (D6): a call while one runs, timer or button, joins the same promise. `fetchAll` always resolves, and it owns the clock: it sets
  `runningSinceMs`, then `lastEndedMs` and the next `nextAtMs` when it ends.
- **Per-repo verdicts** (D10): `classifyFetchError` reads stderr into `auth`, `offline`, `timeout`, `lock` or `other`. All but `lock` show amber in the
  client; `lock` (a clash with another git process) shows nothing and the next scheduled fetch retries.
- **No memo work** (D12): a fetch that moves `origin/<trunk>` changes the base sha, so the reader's next read recounts on its own.

`POST /api/git-fetch` runs one now: token-guarded by `tokenOk` like `POST /api/settings` (`403 { error: 'bad token' }`), marks the view watched, awaits
`fetchAll` and answers `200 { fetch }`; `500` only if `fetchAll` throws despite the above, `405` for any other method. A manual fetch resets the schedule.

## What each number means

Every variant carries `dirName`, `name` and `path` (the pin's cwd). `state` is one of:

- `missing`: a dead pin (`path: null`) or a folder that is gone. `fs.stat` runs before any git call, so none is made.
- `not-git`: the folder exists but `rev-parse` says it is in no repo.
- `error`: a git call failed or timed out; `message` says which (`git status timed out after 5s`, `git not found`). Failure is **per repo**: the other repos
  and the response are unaffected.
- `ok`, with:

| Field           | Meaning                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `toplevel`      | `--show-toplevel`. A pin may be a subdirectory (a session cwd); every git call runs from here.                                                   |
| `branch`        | current branch, `null` when detached (`detachedSha` is then `rev-parse --short HEAD`). An unborn HEAD reports the name HEAD points at.          |
| `onTrunk`       | `branch === trunk`                                                                                                                               |
| `uncommitted`   | entries of `status --porcelain=v1 -z`, counted as `git status` lists them: a rename or copy is one entry, an untracked directory is one, ignored files none |
| `trunk`         | `origin/HEAD`'s branch, else `main`, else `master`, the remote-tracking ref checked before the local one (`trunkOf`, copied from git-sync, not imported). `null` = none |
| `hasOrigin`     | a remote named `origin` exists                                                                                                                   |
| `trunkVsOrigin` | local trunk ahead/behind `origin/<trunk>`; `null` with no origin, no trunk, no `origin/<trunk>` or no local trunk                                |
| `trunkRefs`     | `{ local, origin }` — whether the local `<trunk>` and `origin/<trunk>` exist; `null` exactly when `trunk` is `null`. It lets the client tell "not on origin" from "only on origin", which `trunkVsOrigin: null` cannot |
| `fetchedAtMs`   | newest mtime of `FETCH_HEAD` (see below); `null` = never fetched                                                                                 |
| `branches`      | unmerged local branches, trunk excluded, newest commit first (ties by name), at most **50**                                                      |
| `unmergedTotal` | all unmerged branches, before the 50 cap                                                                                                         |
| `mergedCount`   | branches proven merged, hidden behind this count                                                                                                 |
| `lastFetch`     | `{ atMs, error }` from this server process's own last fetch of the repo (`error` is `null` or a `FetchError`); `null` = never fetched by it. Not the same fact as `fetchedAtMs`, which counts any tool's fetch |

A `GitBranch` is `{ name, ahead, behind, lastCommitMs, worktreePath }`. `ahead` is commits only on the branch, `behind` is commits only on the base.

The response itself carries `fetch: FetchClock` beside `repos`: `intervalSecs` (the setting, `0` = off), `nextAtMs` (server clock of the next timer fetch,
`null` when off or unwatched), `runningSinceMs` (`null` when idle) and `lastEndedMs` (`null` before the first fetch).

## The base (D8)

Branches are compared against **`origin/<trunk>` when it exists**, else the local trunk, because a local trunk that has not been pulled would make every branch
that origin already merged look unmerged. Two corners follow:

- A trunk that exists only as `origin/<trunk>` (e.g. `origin/HEAD` points at `develop` and there is no local `develop`) is still `ok`: `trunkVsOrigin` is `null`,
  `onTrunk` is `false`, and branches are compared against `origin/<trunk>`. No call names `refs/heads/<trunk>`.
- A named trunk with **no base ref at all** (a dangling `origin/HEAD` and no local trunk) is different: nothing exists to compare against, so branches are
  listed with `ahead`/`behind` `null` and `mergedCount` is 0. A repo with no trunk (`trunk: null`) reads the same way.

## The merged proof, and its accepted error

A branch is hidden (counted in `mergedCount`) when either holds:

1. **ahead is 0**: it is an ancestor of the base. This includes a branch cut at the base's tip with no commits of its own; it has nothing to show yet.
2. **Patch-equivalent** (git-sync's M2 test, re-implemented): `git cherry <base> <branch>` prints at least one line, **every line is `-`**, *and*
   `git rev-list --merges <base>..<branch>` is empty.

The no-merges rule is what makes the cherry test safe. `git cherry` skips merge commits, so a branch whose patches all appear on the base but which **also
carries a merge commit** would pass the cherry check while the merge may carry real work; a non-empty `rev-list --merges` refuses it, and it is shown. The
"at least one line" rule is belt and braces: cherry prints nothing only for a branch that is ahead by merge commits alone, which the no-merges rule already
refuses. Cherry runs first because an unmerged branch almost always fails it, which saves the merges walk.

**Accepted error:** a multi-commit branch that was squash-merged as one commit has no patch-equivalent per commit, so it is **shown** as unmerged. The proof
errs only toward showing a branch, never toward hiding one.

A timeout inside the proof (the cherry or the merges walk) means "not proven", the same direction: the branch is shown with its counts instead of the repo
going to `error`, and that verdict is memoised like a computed one, while any other failure or a timeout elsewhere still errors the repo, keeping in the memo
the entries computed before the throw but pruning nothing until a read finishes.

## Worktrees and `FETCH_HEAD`

- `%(worktreepath)` is set for a branch checked out in *any* worktree, the main one included. `worktreePath` is that path only when it differs from the **main
  worktree**, compared by realpath; the main worktree is the common dir's parent, not `--show-toplevel`. For a pin that is itself a linked worktree those two
  differ, so the pin's own branch gets the badge and the main worktree's branch does not.
- A pin whose cwd is a linked worktree is dropped from the Projects list (`isListedProjectPath`) but is still read here like any other.
- `FETCH_HEAD` is **per worktree**: a fetch run inside a linked worktree writes `<common-dir>/worktrees/<name>/FETCH_HEAD` and leaves `<common-dir>/FETCH_HEAD`
  alone. `fetchedAtMs` is the newest of all of them, since orchestrator runs fetch from linked worktrees and the main file alone would read "stale".

## The memo, and per-repo sequencing

Ahead/behind (`rev-list --left-right --count <base>...<branch>`, with full `refs/heads/...` names, never a bare name) and the merged proof are the expensive
calls, 2–3 per unmerged branch. They are **memoised by `(toplevel, branch sha, base sha)`**, so a poll in which no sha moved makes only the cheap per-poll
calls (`rev-parse`, `symbolic-ref`, `status`, `for-each-ref`, `remote`, the trunk probes). The memo is module-level and outlives a request:

- Each read of a repo **replaces** that repo's entries with the ones it touched, so a deleted branch's key is gone after the next poll.
- After a read in which no repo errored, keys of any toplevel that was not read are dropped too, so an **unpinned repo leaves nothing behind**. When a repo
  errored its toplevel is unknown, so that read prunes nothing and the next clean one does.
- Repos are read **in parallel**; within one repo calls run **strictly one at a time**, so a pinned repo never has more than one git process alive. (Two pins
  that resolve to the same toplevel are shown twice and read concurrently; deduping would hide one pin's name, and it is rare.)
- That rule is about the reader's own calls. The fetch is a second process per repo by design (D13): it can collide with your own git or with a Sync run's
  `fetch --all --prune`, which then stops with `fetch-failed` and is pressed again. The window is one fetch (~0.5s) per repo per interval, accepted rather
  than detected.
- A request that arrives while a read is in flight gets the **same promise**, so a second tab or the ↻ button never starts a second round.

## Tests

`overrideGitRunner(run | null)` swaps the runner behind the route process-wide (the `overrideClaudeRoots` pattern); `gitStatsMemoKeys()` exposes the memo to
tests and nothing else. `test/git-stats.test.ts` drives `readRepo` over real repos built by `test/git-fixture.ts`; `test/api-git-stats.test.ts` drives the
route.

The fetch has the same kind of seams: `overrideFetchRunner(run | null)` swaps its runner, `overrideFetchClock(now | null)` its clock, and `resetGitFetch()`
clears the clock, the in-flight promise, the verdicts and the watched stamp. `test/git-fetch.test.ts` runs real fetches against `GitFixture` bare origins (no
network) and pins the classifier table, the argv and env overlay, worktree dedupe, single flight, the timer rules and the process-group kill;
`test/api-git-fetch.test.ts` drives the POST and the payload fields. The client's clock logic (`client/src/lib/gitClock.ts`) is pure and tested in
`test/git-stats-client.test.ts`.

## Client

Management › Git (`client/src/components/management/GitView.tsx`) draws the payload. `ManagementView` mounts it only while `managementTab` is `git`, so
the Pinned sub-view and every other section run no poll.

**The poll.** `useGitStats` fetches on mount, then every **30s** while the page is visible; a `visibilitychange` back to visible polls at once and restarts
the 30s, and going hidden drops the timer, so a backgrounded tab makes no requests. The schedule is `startGitPoll` in `client/src/lib/gitPoll.ts`, written
against injected timer and visibility functions so `test/git-stats-client.test.ts` drives it with fakes; the hook only hands it `document` and `window`.
`startGitPoll` also reports when it next fires, which the hook exposes as `nextPollAtMs` beside `polling` and `skewMs` (client receipt minus the payload's
`generatedAt`; every server clock is read shifted by it). A `refresh()` asked while a poll is out queues one more poll after it, so a poll that predates a
fetch is never the last word. A failed poll keeps the last payload and sets `error`. Before the first payload the body reads a muted "Loading…", as
Management › Pinned does; a first poll that fails turns it into "Couldn't load git stats. Retrying every 30s."

**The clock chip** (`GitClockChip.tsx`). The band has no right slot any more; beside the layout switcher, in `.git-toolbar`, sits one button holding two
meters, SYNC (the 30s re-read) and FETCH (the server's timer), and a caret. Its readings are pure functions in `client/src/lib/gitClock.ts`: SYNC reads
`syncing…`, `failed`, or the countdown; FETCH reads `fetching…` (payload running, or this tab's own POST out), `off`, `…` (no schedule known), `overdue`,
`0s`, or the countdown. When FETCH first reaches `0s` for a given `nextAtMs` the chip asks for one early poll 3s later, and while a payload says a fetch is
running it polls every 3s until it clears; both only while the tab is visible, since a hidden tab that kept polling would keep the server watched forever.
The chip opens a popover (`.git-pop`, dismissed by `useDismiss`) with two rows — **Local sync** (`now` = the old ↻) and **Fetch all** (`now` = `POST
/api/git-fetch` through `useGitFetch`, then a poll) — and, under them, one amber line per repo whose last fetch failed with anything but `lock`. The Fetch
all key is disabled with a reason when the server wants an Answer token this device has not stored, or after a `403`.

**The layouts.** A `.seg` switcher offers `gitLayoutsFor(narrow)` and stores the pick per device in `management.gitLayout` (default `cards`); what is drawn is
`drawableGitLayout`, so a phone draws Cards while a stored Table waits for the next wide window (`client/src/lib/gitLayouts.ts`). All three shapes take the
same repos in pin order and share `GitParts.tsx`:

| Layout | Shape |
| ------ | ----- |
| Cards  | one card per repo, auto-filling columns. Below `md` (768px), or in a branch list narrower than 400px (a container query), the divergence bar drops and the numbers stay |
| Table  | one row per repo: On / Uncommitted / Trunk vs origin / Branches (`unmergedTotal`) / Fetched. A click opens the branches as sub-rows. Wide-only |
| Triage | groups from `triageGitRepos`, drawn Needs you, In flight, Quiet, Can't read, empty groups omitted. Quiet rows are one dashed line, expanding on click |

**The triage rule** (`client/src/lib/gitTriage.ts`), first match wins: any non-`ok` state is Can't read; uncommitted work or a non-zero `trunkVsOrigin` is
Needs you; `unmergedTotal ≥ 1` is In flight, which includes a repo with no remote or no trunk; everything else is Quiet. Within a group repos keep pin
order, so a repo moves between groups but never reorders inside one. The same group colours each repo's status dot in Cards and Triage.

**A branch row** is the name (plus a "worktree" badge when `worktreePath` is set), the divergence bar, "behind | ahead", and the last-commit age. The bar
grows behind to the left and ahead to the right on one scale per repo: the largest count among the repo's listed branches fills its 44px half, and a
non-zero count never drops below 2px (`client/src/lib/gitBar.ts`). A branch whose `ahead`/`behind` are null draws neither bar nor numbers; that is keyed
on the branch's own counts (`gitBranchCounts`), not on `repo.trunk`, because a named trunk with no base ref also yields null counts. The newest five rows
show and "+N more" expands the rest inline (N = `branches.length − 5`); once expanded, a list the server capped adds "N more not shown (over 50)"; a
non-zero `mergedCount` adds "N merged branches hidden". A non-`ok` repo shows its one sentence instead of a body.

**The fetched text.** Each layout's "fetched" fact is `gitFetchedText(repo, clock)`: cyan `fetching…` while the payload says a fetch runs and the repo has an
origin; the verdict and the age in amber (`offline · fetched 2m ago`, `needs auth · never fetched`) when its last fetch failed; else the plain age. Triage's
Quiet summary is one plain string, so it carries the words without the colour. A failed fetch never moves a repo between Triage groups.

**The copy.** Every string is in `client/src/lib/gitStatsText.ts`, verbatim from the copy tables of the git-stats spec §6 and the git-fetch spec §4; the
components never build their own. The empty state's "Pinned" is a link that sets `managementTab: 'pinned'`.

**Sync** (spec §9). Every `ok` repo with an origin gets a Sync button while `/api/health` reports `spawnAvailable` (`canSync` in `client/src/lib/gitSync.ts`):
pinned to the first line at the right of a card's or busy Triage row's head (`.git-head-end` is a sibling of the wrapping `.git-head`, never an item in it, so
the button holds its place however long the name), in the Table's seventh column, and beside a quiet row's line. It is drawn as a raised key — `--strip-hi`
paper, 8px corners, a two-arrow glyph that turns while a run is live — where the fact chips are round and outlined, so the two never read alike
([mockups](../superpowers/specs/2026-10-01-git-sync-button-mockups.html)). "fetched" is a fact, so on a card it ends the facts row and on a busy Triage row it
trails the chips. A click launches at once,
with no sheet: `POST /api/spawn` with the repo's `dirName`, the prompt `/claude-agents-dashboard:git-sync`, the session name `git-sync <repo>` (characters
the server's `NAME_RE` would reject become `-`, cut at 60, because a bad name is dropped without a word), the Settings › Local › Git Sync model and effort,
the host's `SYNC_PERMISSION_MODE` (default `auto`, published on `/api/health` as `syncPermissionMode` already clamped to `SPAWN_MAX_PERMISSION`), and
remote control on exactly when Remote answers is (`remoteAnswer`, so the `REMOTE_ANSWER` kill switch turns it off too) (`syncRequest`). The session runs in the pin's path, the cwd the server resolves for that `dirName`.
Every sync is one-shot (`oneShot: true`, [spawn](spawn.md#close-when-done-oneshot)): the run closes when its last turn finishes instead of holding for a
reply, so its row ends and the button returns to Sync; a follow-up goes through Resume.

`useGitSync` (`client/src/hooks/useGitSync.ts`) remembers each launch per device in `localStorage['management.syncRuns']`, keyed by the repo's toplevel, so
two pins on one repo share a run. `syncPhase` reads a run against the sessions payload: a `launching` entry, or a row not seen yet, is "Syncing…" and
disabled; a `working` or `question` row is "Syncing" (no "open" suffix: the cyan tint and the turning glyph say it is live), which opens that session's
`ChatDrawer` over Management; an ended row or a failed launch is
forgotten (`reconcileRuns` in `client/src/lib/gitSyncRuns.ts`), and each payload that forgets any run re-polls git stats once. A row missing from the
payload is not an end, since the scan caps rows by recency and a sync parked on its question writes nothing, so absence ends a run only 24h after launch
once its row has shown, or 10 min after launch if it never has: a launch that failed while no tab watched leaves no trace once the server drops it.
That sessions poll runs only while a run is remembered or the drawer is open, and asks for the server's maximum of 50 rows. A refused launch (no Answer
token), a launch error, or a launch the server reports failed leaves one amber line under the band. One launch at a time: every pill disables while one is
in flight, and only the clicked one reads "Starting…". The runs key is not a setting, so Settings › Reset leaves it alone.

<!-- docs-sync:
  sources:
    - server/lib/git-stats.ts
    - server/lib/git-fetch.ts
    - client/src/lib/gitClock.ts
    - client/src/hooks/useGitFetch.ts
    - client/src/components/management/GitClockChip.tsx
    - client/src/hooks/useGitStats.ts
    - client/src/components/management/GitView.tsx
    - client/src/components/management/GitCards.tsx
    - client/src/components/management/GitTable.tsx
    - client/src/components/management/GitTriage.tsx
    - client/src/components/management/GitParts.tsx
    - client/src/lib/gitLayouts.ts
    - client/src/lib/gitTriage.ts
    - client/src/lib/gitStatsText.ts
    - client/src/lib/gitBar.ts
    - client/src/lib/gitPoll.ts
    - client/src/lib/gitSync.ts
    - client/src/lib/gitSyncRuns.ts
    - client/src/hooks/useGitSync.ts
  kind: subsystem
-->
