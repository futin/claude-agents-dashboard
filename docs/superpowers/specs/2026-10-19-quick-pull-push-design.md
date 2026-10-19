# Quick pull and push from the Sync key — design

Date: 2026-10-19. Mockups: `docs/superpowers/specs/2026-10-19-quick-pull-push-mockups.html` (variant C was picked; A, B and the git console were not).

## Intent

Management › Git's **Sync** key launches a full `/claude-agents-dashboard:git-sync` session for every click: a Claude session that scans for secrets, runs the
repo's checks, prunes branches and asks a decision round. Many rows need far less — the trunk is one commit behind origin, or a feature branch has two
unpushed commits. For those, a plain `git` fast-forward or push is the whole job, and paying a Claude session for it is slow and wasteful.

This adds a **fast path**: Pull and Push run plain git on the server, in a second or two, with no session. Sync stays the answer for anything that needs a
judgement call — committing, merging, diverged branches, PR-only trunks.

## Goals

- One menu on the Sync key that offers Pull, Push and the full Claude sync, in every Git layout (Inbox, Matrix, Inspector, Branches).
- Pull and Push only ever do what git can do without a decision: a fast-forward, or a push that the remote accepts as a fast-forward.
- Each menu item says what it would do, or why it is unavailable, before it is clicked.
- The outcome of a click is visible: a one-line result, and the row's pills re-read right after.

## Non-goals

- Committing, stashing, rebasing, merging, resolving conflicts, setting an upstream, opening a PR. All of that stays with Sync.
- Pushing the trunk. The trunk is PR-only on this user's repos (`main-pr-only` ruleset here); git-sync already carries trunk commits to a PR.
- A git console or raw output view (the mockups' "Left out" artboard).
- Changing what Sync itself does.

## Anti-goals

- **A fast path that can lose or rewrite work.** No `--force`, no `reset`, no merge commits, no rebase. If git cannot fast-forward, the op fails and says so.
- **A fast path that silently does a different thing than its label.** The menu line and the result line name the branch and the direction.
- **Weakening the write gate.** These are write routes and get exactly the gate every other write route gets.

## The UI (variant C)

The Sync key becomes a split control: the existing Sync key on the left, unchanged in look and behaviour, and a caret on the right that opens a menu. The
split is what `GitSyncButton` itself renders, so every caller gets it: `GitKeys` (Inbox, Matrix, Inspector) and Branches, which draws `GitSyncButton`
directly (`GitBranches.tsx:68`). Its primary/quiet styling follows Sync's current rules. Inspector's footer "Clean up via Sync" key stays a plain Sync key
(a prop on `GitSyncButton` opts out): it is a cleanup call to action, and a second menu for the same repo on the same pane would be noise.

Visibility: the split is hidden when `!canSync(repo)` (not `ok`, or no origin), exactly as the key is today — Pull and Push need an origin too. When the
host cannot spawn sessions (`!sync.available`, where today the key is absent), the split renders with the Sync half and the menu's Sync item disabled, sub-line
`This host can't start sessions`, so Pull and Push stay usable. While a quick op runs on the repo, the Sync half is disabled as well (git would be racing a
session over the same refs).

Menu, top to bottom:

1. **Pull** — sub-line names what it would move, from the current stats: `Fast-forward main by 1 commit`, `fix/x by 3 · main by 5`.
2. **Push** — sub-line: `2 commits to origin/feat/x`.
3. divider
4. **Sync with Claude** — sub-line: `Commit, check, push, prune branches`. Same effect as the left half (launch, or open the chat while one runs).

A disabled Pull or Push stays in the menu, greyed, with its reason as the sub-line (copy table below). The menu closes on outside click, on Escape, and after
an item runs; it is keyboard-operable (arrow keys between enabled items, Enter to run, focus returns to the caret). A click on the caret or an item never
toggles the row it sits in (same rule as the Sync key today).

The menu must not be clipped by Matrix's horizontal scroll container (`.git-mx-wrap` is `overflow-x:auto`, which clips vertically too) — the mockup cheated
with bottom padding; the real one must escape the container. Pointer tooltips are out: no `title` attributes (project rule).

While an op runs, the caret shows the running state (the Sync glyph's spin, cyan, as `.git-sync.on` does) and the menu cannot reopen for that repo.

### Result line

After an op, one line reports it, prefixed with the repo name (exact strings in the copy table). **My call:** it sits under the band beside the other notes
(`GitView.tsx:79-81`), because that place exists in every layout; the mockups drew it under the row, which only Matrix could do cheaply. It is **its own
state**, owned by the quick-op hook, not `GitSyncControl.note` (that one belongs to `useGitSync`, which nulls and overwrites it on its own schedule). Two
tones: a success is neutral ink (`--ink2`), a refusal or failure is the existing amber `.git-sync-note` look. The line is replaced by the next quick op's
result, and cleared when a Sync launch starts or after a successful stats poll that follows by more than 30s. The stats poll re-runs as soon as the op
answers, so pills update without waiting for the 30s poll (`GIT_POLL_MS`, `client/src/lib/gitPoll.ts:10`).

## What Pull and Push do

Both operate on the repo at the pin's `toplevel` (a linked worktree's own root when the pin is one).

### Pull — fast-forward only

Pull fast-forwards **every ref it safely can**, from origin, in one click:

| Situation (from `RepoGitStats`) | Pull does |
|---|---|
| On the trunk, `trunkVsOrigin.behind > 0`, `ahead == 0` | fast-forward the checked-out trunk from `origin/<trunk>` |
| On a branch whose upstream is on `origin` and is not `origin/<trunk>`, `currentVsUpstream.counts.behind > 0`, `ahead == 0` | fast-forward the checked-out branch from its upstream |
| On a branch other than the trunk, `trunkVsOrigin.behind > 0`, `ahead == 0`, trunk not checked out in any worktree | move the local trunk ref forward without a checkout |

Upstream cases row 2 leaves out: an upstream on another remote, or `origin/<trunk>` itself (a branch tracking the trunk), gets no current-branch pull —
the trunk row still applies on its own. `currentVsUpstream.counts: null` (upstream gone) disables it with `Upstream gone — use Sync`.

Row 3 needs to know where the trunk is checked out, which the client cannot see today (`branches` excludes the trunk). The reader gains one read-only
field, `trunkCheckedOutElsewhere: boolean` on the `ok` variant: true when the local trunk ref's `%(worktreepath)` (already read for every ref,
`git-stats.ts:148`) is set and is not this pin's `toplevel`. Every linked-worktree pin of a repo whose main checkout sits on the trunk reads true — the
common case for `.claude/worktrees/*` pins — and Pull's trunk part is disabled there with `main is checked out in another worktree`.

The second and third rows can both apply; Pull then does both and the result line names both. Pull fetches first (**my call**): the counts on screen are
from the last fetch, which may be minutes old, and pulling a stale ref is a surprise. The result line reports the real count, which may exceed the menu's.

A checked-out branch with uncommitted changes may still be pulled (**decided with the user**): git itself refuses a fast-forward that would overwrite a local
change, and that refusal becomes the result line. If the trunk was checked out elsewhere after the stats were read, git refuses the trunk move; that
refusal is reported, not worked around.

Pull is disabled when nothing in the table applies, and when the repo is detached (which disables Pull outright: row 3 means "on a named branch other than
the trunk"), or the current branch or trunk has diverged
(`ahead > 0` and `behind > 0`) — though a diverged *current branch* does not block moving a behind-only trunk, and vice versa.

### Push — current branch, fast-forward only

Push pushes the checked-out branch to its configured upstream when `currentVsUpstream.counts.ahead > 0` and `behind == 0`. Never `--force`, never the
trunk, never `-u` (a branch without an upstream is Sync's job). "Never the trunk" covers the target too: Push is offered only when `gitTracked(repo)` is
non-null (which already drops an `origin/<trunk>` upstream, `GitParts.tsx:170-173`) **and** its upstream starts with `origin/` — `gitTracked` alone does not
exclude other remotes — and the server pushes with an explicit refspec to that one
branch rather than a bare `git push`, so `push.default` cannot widen it. A push the remote rejects (non-fast-forward because origin moved, a hook, a protected
branch) reports git's reason in the result line.

### Shared preconditions (server re-checks every one)

The server never trusts the client's view: it re-reads the repo's state right before running and refuses with a reason when the op is no longer valid
(another session moved the branch, the user committed, origin moved again). Also refused:

- a merge, rebase, cherry-pick, revert or bisect is in progress — the server checks `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`,
  `REVERT_HEAD`, `BISECT_LOG` via `git rev-parse --git-path <name>` (per-worktree, not the common dir). No reader field for this: the client only knows
  "Detached HEAD" (branch null), and a mid-merge repo shows Pull enabled until the server's refusal comes back as the result line;
- the server's fetch-all is in flight (answer 409, copy `A fetch is running — try again in a moment`), or another quick op is running on the same **git
  common dir** (linked worktrees share refs, so the lock is keyed the way fetch-all already groups repos); a different repo may run in parallel. The other
  direction: the fetch timer's tick does not start fetch-all while any quick-op lock is held, and `fetchAll` (timer or Fetch all key) awaits every held
  quick-op lock before `runFetch` starts, so the button just takes a second or two longer and no `lock` fetch error is recorded;
- the repo has no origin, or is not `ok`.

A running git-sync session is **client-side only**: runs live in each browser's `localStorage`, the server has no record of them, so the menu disables Pull
and Push with `Sync is running` when `phaseFor` says so, and the server does not check. A sync started from a terminal or another device is not seen; git's
own ref and index locks are the backstop.

Git hooks **run** (unlike fetch-all, which sets `core.hooksPath=/dev/null`): a `pre-push` or `post-merge` hook is the user's own gate, and turning it off
would be `--no-verify` by another name. The timeout is therefore 60s per git call (fetch-all's is 30s, `git-fetch.ts:22`; the reader's 5s), and a hook's
rejection is reported like any other refusal. A timed-out op reports `<repo>: git took over 60s and was stopped. Use Sync.`

## Server

One new write route, `POST /api/git-quick` (matching `/api/git-stats` and `/api/git-fetch`; it gets a row in `server/index.ts`'s route comment), body
`{ dirName, op: 'pull' | 'push' }`, behind `refuseWrite` exactly as `serveGitFetch` is. It resolves
`dirName` against the pins (never a client-supplied path), re-checks the preconditions, runs git, and answers with what happened in a shape the client can
turn into the result line (direction, branch names, commit counts moved, or a failure kind plus git's first stderr line). The response type goes in
`shared/types.ts` first.

Git is launched the way `lib/git-fetch.ts` launches it: array-form, never a shell, with the same never-prompt overlay (`GIT_TERMINAL_PROMPT=0`,
`GIT_ASKPASS=''`, `SSH_ASKPASS=''`, `ssh -o BatchMode=yes`, `LC_ALL=C`, `git-fetch.ts:33-40` — reuse it rather than copy it), a timeout of its own. It is a git
launch, so it is not a third kind of outbound call under the server rules. `test/outbound.test.ts` does not track git launchers by import; it pins
`lib/git-fetch.ts` by checking that `.claude/CLAUDE.md` names it. The new module follows the same pattern: the CLAUDE.md "Keep new deps out of `server/`"
paragraph gains one sentence naming it (a git launch, not a third kind), and `test/outbound.test.ts` gains the matching text assertion.

`docs/subsystems/git-stats.md` §"The reader stays read-only" stays true: the reader only gains the read-only `trunkCheckedOutElsewhere` field. The new
module is a writer and gets its own section in that doc (or a sibling doc with a line in `docs/overview.md` §Map) saying so.

## Copy table

| Where | Text |
|---|---|
| Pull sub-line, trunk on it | `Fast-forward main by N commit(s)` |
| Pull sub-line, trunk elsewhere | `Move main forward N commit(s)` |
| Pull sub-line, both | `fix/x by N · main by M` |
| Push sub-line | `N commit(s) to origin/feat/x` |
| Disabled: nothing | `Nothing to pull` / `Nothing to push` |
| Disabled: diverged | `fix/x has diverged — use Sync` |
| Disabled: trunk ahead | `main is PR-only — use Sync` (Push only) |
| Disabled: no upstream | `No upstream — use Sync` (Push only) |
| Disabled: upstream gone | `Upstream gone — use Sync` |
| Disabled: trunk elsewhere | `main is checked out in another worktree` (Pull, trunk part) |
| Disabled: detached (mid-rebase reads the same) | `Detached HEAD` |
| Disabled: sync running | `Sync is running` |
| Disabled: quick op running | caret shows the running state; menu does not open |
| Disabled: no spawn | `This host can't start sessions` (Sync item) |
| Disabled: write access | `READ_ONLY_TEXT` whole (`client/src/lib/writeRefusal.ts:7`) / `Needs the Answer token` |
| Result, pulled | `claude-global: pulled 1 commit into main.` |
| Result, trunk moved | `guide-manager: moved main forward 5 commits.` |
| Result, both | `guide-manager: pulled 3 commits into fix/x, moved main forward 5.` |
| Result, pushed | `claude-agents-dashboard: pushed 2 commits to origin/feat/x.` |
| Result, refusal | `claude-global: git refused — <git's first stderr line>. Use Sync.` |
| Result, fetch running | `claude-global: a fetch is running — try again in a moment.` |
| Result, timeout | `claude-global: git took over 60s and was stopped. Use Sync.` |

The mockups' copy (`Fast-forward main by 1 commit`, `Pulled 1 commit into main.` without a prefix, `Read-only…` truncated) is superseded by this table.

Wording is the builder's to polish; the rule is that every disabled item says why, and every result names repo, branch and direction.

## Constraints

- Project rules: zero new server deps; `shared/types.ts` first, then server, then client; no hardcoded colors in `styles.css`; keep `.git-*` class names
  stable; no `title` tooltips (a project convention, `docs/subsystems/usage-limits.md:388`, not a `.claude/CLAUDE.md` line).
- Remote use: the route works over the tailnet with the same token rules as Fetch all; the client disables items when `writeAccess === 'none'` or a token is
  required and not stored, exactly as the Retry fetch key does.

## Left to the builder

- Menu component shape and how it escapes the scroll container (portal vs fixed positioning), as long as it is keyboard-operable and unclipped.
- The exact git commands and how counts moved are measured (before/after rev-parse is fine).
- Response shape details beyond what the result line needs.
- Whether the precondition check shares code with the reader in `lib/git-stats` or reads the few refs it needs itself.
- Test layout: server tests over tmpdir repos with a bare origin (fast-forward, refused-by-dirty-tree, diverged, trunk-in-another-worktree, write-gate 403,
  a second op on the same common dir refused, a push rejected as non-fast-forward, a non-origin upstream refused, fetch-all awaiting a held lock), reader
  test for `trunkCheckedOutElsewhere`, and client tests for the menu's enabled/disabled/sub-line logic as a pure function.

## Calls I made (check these)

1. Pull fetches before it fast-forwards.
2. The result line sits under the band beside the other notes (own state, two tones), not under the row.
3. Push never sets an upstream (`-u`); a new branch goes through Sync.
4. When the host cannot spawn sessions, the split still renders with Sync disabled, so Pull and Push stay usable.
5. "Sync is running" is a client-side disable only; the server does not detect git-sync runs.
6. No new reader field for merge/rebase-in-progress; the server refuses those and the client learns from the result line. The reader does gain
   `trunkCheckedOutElsewhere`, so the common "trunk is in the main checkout" case is disabled up front instead of refused on every click.
7. Git hooks run on Pull and Push (fetch-all disables them); the timeout is sized for that.
8. The lock is per git common dir; the fetch timer skips while a quick op runs, and `fetchAll` awaits held locks; a quick op during a fetch gets 409.
9. Push targets only an `origin` upstream that is not `origin/<trunk>`, via an explicit refspec.
10. Inspector's "Clean up via Sync" footer key stays plain.
11. The new git launcher is named in `.claude/CLAUDE.md`'s server-deps paragraph, pinned by a text test like `git-fetch.ts`.
