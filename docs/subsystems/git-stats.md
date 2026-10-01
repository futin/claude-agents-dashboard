# Git Stats — read-only local git state per pinned project

`GET /api/git-stats` answers, for every **pinned** project (`getPinnedProjects`, in pin order), whether its repo has uncommitted work, which local branches carry
unmerged work and how far they are from the trunk, and when the remote-tracking refs were last refreshed. The Management tab's Git sub-view draws it. The
reader is `server/lib/git-stats.ts`; the payload types (`RepoGitStats`, `GitBranch`, `GitStatsResponse`) are in `shared/types.ts`. Design record:
`docs/superpowers/specs/2026-10-01-git-stats-design.md`.

Repo paths come from `listPinRows` (the same rows `GET /api/pins` serves), never from the request: the route takes no parameters and, like the read routes
beside it, does not check the method. Git must be **2.31 or newer** (`rev-parse --path-format=absolute`).

## Why there is no fetch

The server is read-only and makes exactly two kinds of outbound call (`.claude/CLAUDE.md`); this is not a third. Every git call runs against local refs and is
an array-form `execFile` (never a shell) with a 5s timeout and `GIT_OPTIONAL_LOCKS=0` (so `git status` never takes `index.lock` while you run git yourself),
`GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`. Nothing here fetches, pulls, pushes, calls `gh` or writes to a repo; `commit-tree` is out for the same reason. The
numbers are therefore as fresh as the last fetch somebody ran, which is why the payload carries `fetchedAtMs` and the client shows its age. Branches are
**local only**: one pushed from another machine appears once it is checked out here.

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

A `GitBranch` is `{ name, ahead, behind, lastCommitMs, worktreePath }`. `ahead` is commits only on the branch, `behind` is commits only on the base.

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
- A request that arrives while a read is in flight gets the **same promise**, so a second tab or the ↻ button never starts a second round.

## Tests

`overrideGitRunner(run | null)` swaps the runner behind the route process-wide (the `overrideClaudeRoots` pattern); `gitStatsMemoKeys()` exposes the memo to
tests and nothing else. `test/git-stats.test.ts` drives `readRepo` over real repos built by `test/git-fixture.ts`; `test/api-git-stats.test.ts` drives the
route.

## Client

Filled in with the client half (layouts, triage, copy table, poll). The copy table's source is spec §6; its module is `client/src/lib/gitStatsText.ts`.

<!-- docs-sync:
  sources:
    - server/lib/git-stats.ts
  kind: subsystem
-->
