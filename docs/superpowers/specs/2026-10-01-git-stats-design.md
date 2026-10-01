# Management restructure + Git Stats — design

Show the git state of every pinned project on one page, so knowing whether a repo needs `/git-sync` no longer means opening it and checking by hand. The page
lives in a new **Management** tab; today's Management tab, which only ever held Claude config, becomes **Claude Configs**.

Brainstormed in futin/claude-agents-dashboard#166 (2026-10-01). This spec covers **Phase 0 + Phase 1** of the line set out in
[the plugin spec](2026-10-01-dashboard-plugin-design.md), whose order is now P (done) → 0 → 1 → 2:

| Phase | What                                                                                                           | Status                                    |
| ----- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P     | Dashboard ships git-sync + kaizen as a plugin                                                                   | merged, `62c22a8`                         |
| **0** | Nav reshuffle: Management → **Claude Configs**; a new **Management** tab holds Pinned Projects + Git Stats        | this document                             |
| **1** | **Git Stats**: read-only local git state per pinned project                                                       | this document                             |
| 2     | **Sync** button per repo, spawning `/claude-agents-dashboard:git-sync` there                                     | §9, planned 2026-10-01                    |
| —     | Multi-machine hub                                                                                                | parked: futin/claude-agents-dashboard#164 |

The plugin spec's Phase 1 row says Git Stats "reuses P's git-sync engine". It does not: see §1 for why.

Mockups: [2026-10-01-git-stats-mockups.html](2026-10-01-git-stats-mockups.html). Every layout in this spec is drawn there with the same six sample repos.
Where the two disagree, **this spec wins**. Known differences:

- Every band uses §6's fixed sub-line. The mockup's Triage band ("2 of 6 pinned repos need attention.") is not built.
- The mockup puts ixray (no remote, one unmerged branch) in Quiet. Under §6's rule it is **In flight**.
- The mockup draws only the "Quiet" group header. All four groups get one.
- The merged line is always "N merged branches hidden". The mockup's "— cleanup candidates for Sync" and its short "7 merged hidden" are not built.
- The mockup's "3 branches" / "no other branches" chips and its "8 · 0 merged" Branches cell come from §6's copy table instead: the Branches column shows
  the unmerged total.
- The phone's "wt" badge is "worktree" at every width. The error sentences keep §6's casing in every layout.
- The Table's cells and the phone layout use §6's copy-table strings unchanged. The mockup's "— even", bare "2 behind", "4" / "—", "6h", "main 2 behind"
  and "fetched 6h" short forms are not built.
- The mockup's `●` current-branch marker in a branch row is not built: the current branch is already the header chip. Triage's "3 unmerged branches" chip
  is not built either.
- The mockup's Sync buttons are Phase 2 (§9). Phase 1 renders none.

## Decisions

| #   | Decision                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Full rename**, not label-only: rail id, hooks, components, `/api/management*` paths and localStorage keys move to `configs`. CSS class names stay. |
| D2  | The freed `management` id becomes the new tab, with sub-nav **Git** (default) and **Pinned**. Settings loses its Pinned sub-view.                     |
| D3  | **Pinned projects only.** Repo paths come from `listPinRows` (`server/lib/management.ts`), never from the request.                                   |
| D4  | **Read-only, zero network.** The server never runs `git fetch`, `gh`, or anything that writes to a repo. `test/outbound.test.ts` does not change.     |
| D5  | **Local branches only.** A branch pushed from another machine appears once it is checked out here (or after a Phase 2 Sync).                        |
| D6  | **Own reader in `server/`**, not the git-sync engine. The server never runs plugin code; `survey` measures branches against `origin/<branch>`, not the trunk, and calls `gh`. |
| D7  | Trunk = git-sync's `trunkOf` rule: `origin/HEAD`, else `main`, else `master`, remote-tracking ref before local. Copied, not imported.             |
| D8  | Branches are compared against **`origin/<trunk>` when it exists**, else the local trunk.                                                          |
| D9  | Proven-merged branches are **hidden behind a count** ("7 merged branches hidden"). Proof = ancestor of the base, or git-sync's M2 `git cherry` test (§2).   |
| D10 | A branch checked out in a linked worktree gets a **worktree badge**. Worktrees get no status of their own.                                         |
| D11 | Three layouts behind a switcher, **Cards \| Table \| Triage**, same pattern as Sessions. Default Cards; Table is withheld on a phone.               |
| D12 | Client polls **every 30s, only while the Git sub-view is open and the page is visible**, plus a ↻ button.                                          |
| D13 | The rename **does not migrate** stored state: the old keys are cosmetic, and a stored `'management'` section still names a real tab.              |

## §1 Why not the git-sync engine

`plugin/skills/git-sync/tools/git-sync.mjs` is plugin code: the server never imports or runs anything under `plugin/`. That is a `.claude/CLAUDE.md` rule ("never
imported by server or client at runtime"), and §7 adds a sweep test for it. `test/plugin-manifest.test.ts` pins only what may live under `plugin/`. Its `survey` also answers a different question. It reports a branch ahead of `origin/<branch>` (unpushed), while this page wants ahead/behind the
trunk, and it calls `gh` for PR state, which is network. Two ideas are borrowed and re-implemented, each in a few lines: `trunkOf` (D7) and the `git cherry`
squash-merge proof (`cherrySigns`, its M2 case). git-sync's M3 probe is not borrowed, because it writes a probe commit object with `commit-tree`, and D4 rules
out writes.

## §2 Server: `server/lib/git-stats.ts`

One module, Node built-ins only.

- **Input:** the pin rows from `listPinRows`, in pin order. A row with `path: null` is a dead pin and never reaches git.
  - A row with `listed: false` but a non-null path is read like any other. It is usually a linked worktree, which the projects list drops
    (`isListedProjectPath`). Such a pin shows that worktree's state, and its own branch gets the worktree badge (see below).
- **Runner:** every git call goes through one injectable async runner, built on `child_process.execFile` in array form, never `shell: true`. Each call has a
  **5s timeout**. Env adds `GIT_OPTIONAL_LOCKS=0`, so `git status` never takes `index.lock` while the user runs git themselves, plus `GIT_TERMINAL_PROMPT=0`
  and `LC_ALL=C`. Tests swap the runner to simulate a timeout.
- **Concurrency:** repos are read in parallel, but **calls within one repo run one at a time**, so at most one git process per pinned repo is alive.
  - A cold poll costs 2–3 calls per unmerged branch (all of them, not only the 50 served). After that, the memo keeps polls to the cheap calls.
  - A request that arrives while a read is in flight gets the same promise rather than starting a second round.
- **Failure is per repo.** A timeout or unexpected exit puts that one repo in the `error` state with a short message. The other repos and the response itself
  are unaffected.

### Per poll, per repo (cheap calls, never cached)

| Question                       | How                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Does the folder exist          | `fs.stat` before any git call. Missing or not a directory → `missing`, with no git run.   |
| Is this a repo, where is it    | `rev-parse --show-toplevel --path-format=absolute --git-common-dir`. A non-zero exit → `not-git`. The main worktree is the common dir's parent. |
| Current branch                 | `symbolic-ref -q --short HEAD` → `branch`. Failure = detached: `branch: null`, `detachedSha` = `rev-parse --short HEAD`. |
| Uncommitted files              | `status --porcelain=v1 -z`, default untracked mode. Counted the way `git status` lists them (see below).                 |
| Local branches                 | `for-each-ref refs/heads` with name, sha, committer date and `%(worktreepath)`.          |
| Trunk, has origin              | D7's rule; `hasOrigin` = `remote` lists `origin`.                                         |
| Fetched age                    | newest mtime of `<common-dir>/FETCH_HEAD` and `<common-dir>/worktrees/*/FETCH_HEAD`; none → `null` ("never fetched"). |

A pin's path is the session cwd, which can be a subdirectory of the repo. The reader works from `--show-toplevel`. Two pins that resolve to the same toplevel
are shown twice; this is rare, and deduping would hide one pin's name.

**Counting uncommitted entries.** A rename or copy (`R`/`C` in either column) is one entry, even though `-z` emits two paths for it. An untracked
directory counts once, not once per file, because that is how the default untracked mode reports it. Ignored files are not counted.

**Unborn HEAD** (a fresh `git init`, no commits yet): `branch` is the name HEAD points at, there are no branches, and trunk is `null`.

**Worktree badge.** `%(worktreepath)` is set for every branch checked out in *any* worktree, the main one included (checked on git 2.50.1).
`worktreePath` is that path when it differs from the **main worktree**, comparing realpaths, and `null` otherwise. The main worktree is the common dir's
parent, not `--show-toplevel`; for a pin that is itself a linked worktree, those two differ. Only branches checked out in a *linked* worktree get the D10
badge.

**Fetched age.** `FETCH_HEAD` is per worktree: a fetch run inside a linked worktree writes `.git/worktrees/<name>/FETCH_HEAD` and leaves `.git/FETCH_HEAD`
alone (checked on git 2.50.1). The newest one across all worktrees is when this repo's remote-tracking refs were last refreshed. Orchestrator runs fetch
from linked worktrees, so on this machine that case is common.

**Trunk with no local branch.** D7 can name a trunk that exists only as `origin/<trunk>`, e.g. `origin/HEAD → develop` with no local `develop`. Then
`trunkVsOrigin` is `null`, `onTrunk` is `false`, and branches are still compared against `origin/<trunk>` (D8). No call names `refs/heads/<trunk>`.

### Memoised (only recomputed when a sha moves)

Keyed by `(repo toplevel, branch sha, base sha)`:

- **Ahead/behind:** `rev-list --left-right --count <base>...<branch>`, using full refnames (`refs/heads/x`), never a bare name.
- **Merged:** ahead = 0 (ancestor of the base), or else git-sync's M2 test (`git-sync.mjs` `patchEquivalence`). That test requires three things:
  `git cherry <base> <branch>` prints **at least one** line, every line is `-`, and `rev-list --merges <base>..<branch>` is empty.
  - The ≥ 1 rule is belt and braces. Cherry prints nothing only for a branch that is ahead only by merge commits, and the no-merges rule already
    refuses that branch. It is kept so the proof never rests on an empty list. No test isolates it.
  - The no-merges rule matters because cherry skips merge commits, so a merge that carries real work would otherwise hide.
  - A multi-commit branch that was squash-merged does not pass this test and is shown as unmerged. That error is accepted: it always errs toward showing a branch, never hiding one. The converse is
  intended: a branch created at the base's tip with no commits of its own is ahead 0, so it counts as merged and is hidden. It has nothing to show yet.

The trunk's own row, local trunk vs `origin/<trunk>` ahead/behind, uses the same memo. Each poll replaces the memo with the entries it touched, so it never
holds a branch that no longer exists.

### What a repo reports

`RepoGitStats` is a discriminated union on `state`, defined in `shared/types.ts` first:

Every variant carries `dirName` and `name` (from the pin row) and `path: string | null` (the pin's cwd).

- **`missing`**: dead pin (`path: null`), or the folder is gone.
- **`not-git`**: the folder exists but is not in a repo.
- **`error`**: adds `message: string`. A git call failed or timed out.
- **`ok`** adds:

| Field           | Type                                     | Meaning                                                                                    |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `toplevel`      | `string`                                 | `--show-toplevel`                                                                          |
| `branch`        | `string \| null`                         | current branch; `null` when detached                                                       |
| `detachedSha`   | `string \| null`                         | `rev-parse --short HEAD` when detached, else `null`                                        |
| `onTrunk`       | `boolean`                                | `branch === trunk`                                                                         |
| `uncommitted`   | `number`                                 | §2's count                                                                                 |
| `trunk`         | `string \| null`                         | D7; `null` = no trunk                                                                      |
| `hasOrigin`     | `boolean`                                | a remote named `origin` exists                                                             |
| `trunkVsOrigin` | `{ ahead: number; behind: number } \| null` | local trunk vs `origin/<trunk>`; `null` when there is no origin, no trunk, no `origin/<trunk>`, or no local `<trunk>` |
| `fetchedAtMs`   | `number \| null`                         | `FETCH_HEAD` mtime (epoch ms); the client derives the age                                  |
| `branches`      | `GitBranch[]`                            | unmerged, trunk excluded, newest commit first, at most **50**                              |
| `unmergedTotal` | `number`                                 | all unmerged branches, before the cap                                                      |
| `mergedCount`   | `number`                                 | proven-merged branches, hidden                                                             |

`GitBranch` = `{ name: string; ahead: number | null; behind: number | null; lastCommitMs: number; worktreePath: string | null }`. Ahead and behind are `null`
only when there is no trunk.

With no trunk at all, every branch is listed without ahead/behind and the merged count is 0. Without a base, nothing can be proved merged.

## §3 API

`GET /api/git-stats` → `GitStatsResponse { repos: RepoGitStats[]; generatedAt: number }`, with repos in pin order. It takes no parameters, routed in
`server/index.ts` beside `/api/pins`, with its handler in `server/api.ts`. Its exposure matches `/api/sessions`: branch names and paths, readable by anyone who
can reach the dashboard. `docs/subsystems/remote-access.md` lists it.

## §4 Phase 0: the rename

`management` → `configs` everywhere it names the Claude-config tab:

- `Section` gains `'configs'`. Rail order becomes Sessions, Usage, Management, **Claude Configs**, Analytics, Settings. The landing picker follows, since it
  derives from `SECTIONS`.
- Components move from `client/src/components/management/` to `components/configs/`. `ManagementView` becomes `ConfigsView`, and `useManagement` /
  `useManagementScope` become `useConfigs` / `useConfigsScope`. `useManagementIndex` becomes `useConfigsIndex`; `SpawnPanel` imports it. The rail's scope tree (`ManagementSubNav`) moves with them and hangs under Claude Configs.
- Routes move to `/api/configs`, `/api/configs/project` and `/api/configs/file`. The old paths are dropped, not aliased, because the client is the only
  consumer.
- localStorage keys become `configs.collapsed`, `configs.type` and `configs.scope`, with no migration (D13).
  - `OWNED_KEYS` (`client/src/hooks/useSettings.tsx`) is the list Settings → Reset clears. It gains the three `configs.*` keys and `management.gitLayout`
    (§6), so Reset keeps covering every view key.
  - It also keeps the three old `management.*` names, so Reset sweeps D13 leftovers.
- The server module `server/lib/management.ts` keeps its name for now: it also holds the project listing that pins and Git Stats use. Renaming it is out of
  scope (see Out of scope).
- **CSS class names do not change** (`.wide-mgmt` and the rest), per the repo rule. The new Management tab gets the plain `wrap wide`.
- Tests that hit the old routes (`test/api-management-analytics.test.ts`, `test/management.test.ts`) move to the new paths. A sweep test asserts that no
  `'/api/management` string remains under `client/src`.

## §5 Phase 0: the new Management tab

- Its sub-nav is **Git | Pinned**, driven by a new local setting `managementTab: 'git' | 'pinned'` (default `git`). It goes through the same `SUBNAV` table
  and validator as `usageTab` and `settingsTab`. That widens `SideRail.tsx`'s `SubKey` union and the `SUBNAV` record's value type.
- **Pinned** renders `PinnedProjectsGroup` unchanged, under a band "Management · Pinned". The band's sub-line drops "stay in Management" wording that no
  longer makes sense.
- **Settings** drops `'pinned'` from `SettingsTab`, `SETTINGS_TABS` and its `SUBNAV` entry. A stored `settingsTab: 'pinned'` fails the validator and falls
  back to `local`, which is the validator's existing behaviour.
- A stored `dashboard.section: 'management'`, or a landing pick of Management, now opens the new tab. No migration (D13).

## §6 Phase 1: the Git sub-view

### Band

The title is "Management · Git", with the sub-line "Local state of your pinned repos. Nothing here fetches — "fetched" says how old the remote data is." On the
right: "updated Ns ago" and a ↻ button that forces a poll now. Strings for every state are in the copy table below.

### Switcher

`GIT_LAYOUTS = cards | table | triage`, mirroring Sessions' `LAYOUTS`, `WIDE_ONLY_LAYOUTS` and `drawableLayout` in `client/src/lib/filterSort.ts`, as a
pure module under `client/src/lib/`.

- `table` is wide-only. A phone draws `cards`, and the stored choice is kept, so widening the window brings the table back.
- The choice persists per device in `management.gitLayout`, default `cards`. There is no Settings "default layout" picker for it.

### Shared repo facts

Every layout shows the same facts:

- name and current branch, as a chip
- uncommitted count
- trunk vs origin
- fetched age
- the unmerged branches: name, a GitHub-style divergence bar (behind ◂ | ▸ ahead) with both numbers, last-commit age, worktree badge
  - the newest 5 show, then "+N more" expands the rest inline
  - when merged > 0, a muted merged line follows

Chip and bar colours come from the existing theme tokens (`--amber`, `--mustard`, `--cyan`, `--green`). Per the repo rule, no new colour literal goes into
`styles.css`.

**Copy.** `<trunk>` is the trunk's name, and N, M are counts.

| State                                              | Text                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| Detached HEAD                                      | branch chip "detached at `<detachedSha>`"                             |
| Uncommitted > 0 / = 0                              | "N uncommitted" (amber) / "clean" (green)                             |
| `trunkVsOrigin` 0 / 0                              | "`<trunk>` = origin"                                                  |
| behind only / ahead only / both                    | "`<trunk>` N behind origin" / "`<trunk>` N ahead of origin" / "`<trunk>` N ahead, M behind origin" (mustard) |
| `hasOrigin: false`                                 | "no remote"                                                           |
| origin exists, no `origin/<trunk>`                 | "`<trunk>` not on origin"                                             |
| `origin/<trunk>` exists, no local `<trunk>`        | "`<trunk>` only on origin"                                            |
| `trunk: null`                                      | "no main branch"; branches show no bar and no numbers                |
| `fetchedAtMs` set / `null`                         | "fetched 2h ago" / "never fetched"                                    |
| no unmerged branches                               | "no open branches"                                                    |
| `branches` longer than 5                           | "+N more", where N = `branches.length − 5`. Expanding shows all `branches`.            |
| `unmergedTotal` > 50, once expanded                | muted "N more not shown (over 50)", where N = `unmergedTotal − 50`     |
| `mergedCount` > 0                                  | "N merged branches hidden"                                            |
| `missing`                                          | "Folder is gone — `<path>`. Unpin it under Pinned." (a dead pin with no path: "Folder is gone. Unpin it under Pinned.") |
| `not-git`                                          | "Not a git repository."                                               |
| `error`                                            | "Couldn't read: `<message>`"                                          |
| no pins at all                                     | "No pinned projects yet. Pin one under Pinned." with Pinned as a link |
| first fetch fails, no data yet                     | page body "Couldn't load git stats. Retrying every 30s."              |
| a later fetch fails                                | band right side reads "couldn't update" in place of "updated Ns ago", and the last data stays |

Non-`ok` states replace the repo body with their one sentence and never show broken numbers. The Table's Branches column shows `unmergedTotal`.

### Layouts

- **Cards:** one card per repo, in pin order, auto-filling columns (two on a laptop, one on a phone). On a phone the divergence bar drops and the numbers stay.
- **Table:** one row per repo with columns On / Uncommitted / Trunk vs origin / Branches / Fetched. A click expands that repo's branches as sub-rows beneath it.
- **Triage:** repos grouped by a pure function `triageGitRepos(repos)`. Within each group, repos keep pin order, so a repo only ever moves between groups.
  - The first matching rule wins:
    1. **Can't read:** `missing`, `not-git` or `error`. Shown as one muted line each, at the bottom.
    2. **Needs you:** uncommitted > 0, or `trunkVsOrigin` is non-null with ahead > 0 or behind > 0.
    3. **In flight:** `unmergedTotal` ≥ 1. This includes a repo with no remote, and a repo with no trunk, whose every branch counts as unmerged.
    4. **Quiet:** everything else.
  - Needs you and In flight rows show their branches. Quiet rows are one dashed line each, expandable.

### Polling

`useGitStats` fetches on mount, then every **30s** while the Git sub-view is mounted and `document.visibilityState === 'visible'`. A `visibilitychange` back
to visible polls immediately. Unmounting, or switching to Pinned, stops the timer. For failures, see the copy table's last two rows.

## §7 Tests

node-assert, in the existing `test/run-all.ts` style. The server tests build **real repos** with `git init` in a tmpdir (no mocks for git output). Cases:

| Case                                                        | Expected                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Clean repo on `main`, cloned from a local bare `origin`       | `ok`, `onTrunk: true`, uncommitted 0, `trunkVsOrigin` 0/0, `hasOrigin: true`                    |
| One modified tracked file + one untracked file at the root   | uncommitted 2                                                                               |
| One staged rename + one untracked dir holding 2 files         | uncommitted 2                                                                               |
| Detached HEAD                                               | `branch: null`, `detachedSha` = `git rev-parse --short HEAD`                                 |
| Unborn HEAD (fresh `git init`)                               | `ok`, `branch` = HEAD's name, no branches, trunk `null`                                     |
| No `origin` remote, branch `master`                         | trunk `master`, `hasOrigin: false`, `trunkVsOrigin` `null`                                    |
| No `main`/`master`/`origin/HEAD`, only branch `dev`           | trunk `null`; `dev` listed without ahead/behind; merged count 0                              |
| `origin/HEAD` → `origin/develop`                             | trunk `develop`                                                                             |
| Branch 3 ahead / 2 behind `origin/main`                       | ahead 3, behind 2                                                                           |
| Branch fast-forward merged into `main`                       | hidden; merged count 1                                                                      |
| Branch whose single commit was cherry-picked onto `main`     | hidden via `git cherry`; merged count 1                                                      |
| Branch of 2 commits squash-merged as 1                       | **shown** as unmerged (the accepted error, §2)                                              |
| Branch with commit X; X cherry-picked onto `main`; then `main` merged into the branch | **shown**: cherry prints only `-`, but the branch carries 1 merge, so the no-merges rule refuses |
| Local `main` behind `origin/main`, branch merged on origin   | hidden, since the base is `origin/main` (D8)                                                     |
| Branch checked out in a linked worktree; another checked out in the main worktree | linked one: `worktreePath` = that worktree; main worktree's branch: `null` |
| Pin whose path is that linked worktree (`listed: false`)     | `ok`; `branch` = the worktree's branch, with the badge; main worktree's branch: `null`       |
| Fetch run only from a linked worktree, 1h ago               | `fetchedAtMs` ≈ 1h ago, though `.git/FETCH_HEAD` is absent                                   |
| `origin/HEAD` → `origin/develop`, no local `develop`         | trunk `develop`, `trunkVsOrigin` `null`, `onTrunk: false`; branches compared against `origin/develop`; state `ok` |
| 60 branches, cold poll                                       | the runner spy never sees two calls in flight for one repo                                  |
| 7 unmerged branches                                          | newest-first by commit date, all 7 in payload, total 7                                     |
| 60 unmerged branches                                         | 50 in payload, total 60                                                                     |
| Pin with `path: null`; pin to a deleted folder               | `missing`, and no git call made (`fs.stat` first; runner spy)                                |
| Pin to a plain folder                                        | `not-git`                                                                                   |
| Pin to a repo subdirectory                                   | reads the toplevel; same stats as pinning the root                                          |
| Runner times out for repo A                                  | A is `error`; repo B in the same response is `ok`                                            |
| Two polls with no sha change                                 | second poll makes no `rev-list`/`cherry` calls (runner spy)                                 |
| A branch is deleted between polls                            | memo no longer holds its key                                                               |
| Concurrent requests                                          | one round of git calls, both resolve to the same object                                    |
| `FETCH_HEAD` absent / touched 2h ago                         | `null` / ≈ 2h                                                                              |
| `GIT_OPTIONAL_LOCKS=0` is in the runner env                  | asserted on the spy                                                                         |

Client domain logic (pure modules):

- `triageGitRepos` follows §6's precedence, and pin order holds within a group. A clean repo with no remote and no branches is Quiet. With one branch it
  is In flight. A no-trunk repo with any branch is In flight. A dirty repo with branches is Needs you.
- `OWNED_KEYS` holds the `configs.*` keys, the old `management.*` names and `management.gitLayout`.
- `drawableGitLayout('table', narrow=true)` → `cards`, and the stored choice is untouched.
- The settings validator maps a stored `settingsTab: 'pinned'` → `local`, and `managementTab: 'nonsense'` → `git`.
- The rename sweep (§4).
- No file under `server/` or `client/src/` imports from `plugin/` (§1).

Not testable here, and so to be verified by hand: the rendered layouts against the mockup, the 30s visible-only timer, and the phone fallback.

## §8 Docs

- `docs/subsystems/management.md` → `docs/subsystems/configs.md`, its routes and names updated. Every inbound link moves with it (`grep -rn
  subsystems/management.md`). The docs-links test catches any it misses.
- New `docs/subsystems/git-stats.md`: what each number means, why there is no fetch, the merged proof and its accepted error, the memo, and the triage rule.
- `docs/overview.md` §Map: both entries, plus the file map for the moved components.
- `.claude/DESIGN.md` §8.5 retitled for Claude Configs, plus a new subsection for Management (Git | Pinned and the three layouts).
- `docs/subsystems/remote-access.md` and the `scripts/tailnet.ts` comment: `/api/management/file` → `/api/configs/file`, and add `/api/git-stats` to the
  exposure list.
- `docs/subsystems/settings.md` and `view-persistence.md`: the Pinned move, `managementTab`, `management.gitLayout`, and the renamed keys.
- `docs/superpowers/specs/2026-10-01-dashboard-plugin-design.md`: a one-line note beside its Phase 1 row and its "Phase 1's server can `import` it"
  line, pointing here (§1 supersedes both).
- `.claude/CLAUDE.md` Orientation names the rail as "Sessions | Usage | Management | Analytics | Settings". Add Claude Configs there.

## §9 Phase 2: the Sync button

Recorded with Phase 1, amended 2026-10-01 when Phase 2 was planned ([plan](../plans/2026-10-01-git-sync-button.md)). Phase 2 adds one **Sync** button
per repo:

- **Cards:** the right end of the card header.
- **Table:** a last column.
- **Triage:** the right end of the repo row.
- It is not shown when git-sync would refuse the repo: `missing`, `not-git`, `error`, or `hasOrigin: false`. It is not shown either while the host
  cannot spawn (`HealthResponse.spawnAvailable` is not `true`).
- There is no "Sync all" and no separate Prune, because git-sync already prunes inside its own run and asks before doing so.
- **Click launches at once**, with no launch sheet and no confirm: `POST /api/spawn` with the pin's `dirName`, prompt `/claude-agents-dashboard:git-sync`
  and a session name `git-sync · <repo name>`. Model, effort, permission mode and remote control come from a new Settings › Local group, **Git Sync**,
  separate from the New sessions defaults so a sync can run cheaper than a hand launch. A stray tap costs one session's tokens and nothing else, because
  git-sync asks before every push and deletion.
- The session runs in the **pin's path**, not the toplevel: `/api/spawn` resolves a `dirName` and never takes a path, and git-sync works from any
  subdirectory of the repo.
- The launched session id is remembered **per device** in `localStorage`, keyed by toplevel, so two pins on one repo share one run and the state survives
  a tab switch or a reload. A sync started from a terminal is not detected.
- While that session runs (`working` or `question`), the button reads "Syncing · open" and opens its chat in a drawer **inside Management**, which is
  where git-sync's decision round gets answered. While the run is still launching, or is not in the sessions payload, it reads "Syncing…" and is
  disabled. When the session ends (`idle` or `incomplete`), the run is forgotten and the repo is re-polled.

Phase 2 needs **no server change**: Phase 1 already carries `hasOrigin`, the toplevel and the `dirName`, and the spawn route already accepts a pinned
`dirName`. Phase 1 renders **no** placeholder button.

## Verification

- `pnpm test`, `pnpm typecheck` and `pnpm build` are green, with the output quoted in the PR.
- Live probe against this machine's real pins: every pinned repo renders in each layout, and the numbers for this repo match `git rev-list --left-right
  --count origin/main...<branch>` run by hand.
- Phone width (375px): Table is not offered, Cards draws, and nothing scrolls sideways.
- Not verified by any test: how the layouts look against the mockup, and whether the visible-only timer actually stops. Both are for a human to check, and the
  PR says so.

## Out of scope

- `git fetch`, PR or CI state, and remote-only branches (D4, D5; #164 for cross-machine).
- The Sync button itself (Phase 2, §9).
- Per-worktree uncommitted counts (D10).
- Renaming `server/lib/management.ts` or splitting its project listing into its own module.
- A Settings "Git Stats opens in" default-layout picker.
- Migrating old localStorage keys (D13).
