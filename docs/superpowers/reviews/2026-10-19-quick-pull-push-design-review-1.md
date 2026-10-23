# Review 1 — Quick pull and push from the Sync key (design spec)

Document: `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md` (179 lines). Reviewer: fresh session, Fable 5.1, 2026-10-19. Every claim below was
checked against the worktree at `.claude/worktrees/quick-pull-push` (branch `feat/quick-pull-push`, HEAD 46c6d66 plus the two untracked spec files).

## Verdict: REVISE

No Critical findings. Eight Important ones; two of them (I6, I7) need a design decision rather than a sentence, which is why this is REVISE and not
APPROVE WITH FIXES. Everything the spec says about `refuseWrite`, `git-fetch.ts`'s launch shape, the common-dir grouping, the `lock` fetch error, the
`core.hooksPath=/dev/null` flag, the reader's 5s timeout, `GitSyncControl.note`, `.git-sync.on`, `.git-mx-wrap`, `phaseFor`, the localStorage runs,
`toplevel`, `currentVsUpstream`, `trunkVsOrigin`, the Inspector footer key and the `outbound.test.ts` text pin checks out.

## Important

### I1 — L37: Branches does not get the Sync key from `GitKeys`
Spec: "The split replaces `GitSyncButton` where `GitKeys` draws it, so all four layouts get it from the one component." False for Branches:
`client/src/components/management/GitBranches.tsx:69` renders `<GitSyncButton repo={repo} sync={sync} />` directly; only Inbox (`GitInbox.tsx:60,75,108`),
Matrix (`GitMatrix.tsx:116,134`) and Inspector (`GitInspector.tsx:168`) go through `GitKeys`. An implementer following L37 ships Branches without the menu,
contradicting goal L16 ("in every Git layout"). → Say the split replaces `GitSyncButton` both inside `GitKeys` and at `GitBranches.tsx:69` (or make the split
the thing `GitSyncButton` exports, leaving the Inspector footer on a `plain` prop).

### I2 — L36 vs L172: "unchanged in look and behaviour" contradicts call 4
Today `GitSyncButton` returns `null` when `!sync.available || !canSync(repo)` (`GitParts.tsx:48`), so no Sync key exists at all on a host that cannot
spawn. Call 4 (L172) says the split then renders with Sync disabled — a behaviour change L36 denies. The spec also never says what the split does when
`canSync` is false (no origin, or not `ok`), where Pull and Push are impossible too (L106). → State: the split is hidden when `!canSync(repo)`; when
`canSync` but `!sync.available`, the left half draws disabled with the label/sub-line to use (copy table entry), and the menu's "Sync with Claude" item is
greyed with the same reason.

### I3 — L62: the git-stats poll is 30s, not 3s
`client/src/lib/gitPoll.ts:10` `GIT_POLL_MS = 30_000`; `useGitStats.ts:25-27` says "every 30s while the page is visible". The 3s figure is the sessions
poll (CLAUDE.md intro). → "without waiting for the 30s poll".

### I4 — L92: `gitTracked` is not "upstream on origin and not origin/<trunk>"
`client/src/components/management/GitParts.tsx:170-173` drops only an absent upstream and `origin/<trunk>`; an upstream on another remote
(`upstream/feat/x`) passes it. So "the same upstreams the Pushed cell counts" is false, and an implementer who reuses `gitTracked` for the Push predicate
offers Push to a non-origin upstream, which L92's own rule forbids. → Define Push's predicate on its own (`gitTracked(r) !== null && upstream starts with
`origin/``) and note the Pushed cell may count more than Push offers.

### I5 — L70 "from origin" vs L75 "from its upstream": which upstreams qualify for Pull row 2?
Row 2 (L75) fast-forwards the current branch "from its upstream"; L70 says Pull is "from origin"; L78 says Pull "fetches first" with no remote named.
`currentVsUpstream.upstream` can be on any remote (`shared/types.ts:1711-1716`). Three cases are unspecified: (a) upstream on a non-origin remote — does
row 2 apply, and does the fetch hit that remote; (b) upstream is `origin/<trunk>` itself (`gitTracked` returns null for it, Push excludes it, Pull is
silent) — row 2 would then fast-forward `feat/x` onto `origin/main` and row 3 move `main` in the same click; (c) `counts: null` (upstream configured but
gone after a prune, `types.ts:1712`) — no copy-table row fits. → One sentence each: row 2 applies only to an `origin/…` upstream; whether an
`origin/<trunk>` upstream counts (recommend: it does, the sub-line reads `Fast-forward feat/x by N`); `counts: null` reads `No upstream — use Sync` or
`Nothing to pull`.

### I6 — L76, L82-83: row 3 is offered on every linked-worktree pin and fails on every click
On git 2.50 (this machine: `git version 2.50.1`), `git fetch origin main:main` refuses to update a branch checked out in any worktree. Every pin under
`.claude/worktrees/*` has `main` checked out in the main checkout, so for them "Move main forward N commits" is always offered and always refused. The
client cannot predict it: `branches` excludes the trunk (`types.ts:1721`) so `GitBranch.worktreePath` never says where the trunk is checked out, and no
other field does. That contradicts goal L18 ("Each menu item says what it would do, or why it is unavailable, before it is clicked") for the most common
pin shape in this user's repos. L82-83 only says the failure "is reported, not worked around". → Decide: either (a) extend the reader with where the trunk
is checked out (the reader already runs `worktree list --porcelain` for `worktreePath`) and disable row 3 with a sub-line (`main is checked out in
<worktree>`), or (b) keep the reader untouched and move row 3 off the menu's promise: say the sub-line hedges (`Move main forward N if no worktree has it`)
and add the refusal copy to the table. (a) is the one that keeps L18 true.

### I7 — L60-61, L146: the result line's slot has an owner, a tone and no clearing rule
`GitSyncControl.note` is state inside `useGitSync` (`useGitSync.ts:52`): set to `null` on every `start` (L96), overwritten by a launch refusal/failure
(L85-87) and by a sync that failed (L66). `GitView.tsx:79-81` stacks three `.git-sync-note` divs (sync, unpin, folder), and `.git-sync-note` is amber
(`styles.css:2957`, `--amber-text`) — the warning tone, so `Pulled 1 commit into main.` would read as a warning. The spec does not say whether the quick-op
result writes into `GitSyncControl.note` (then a Sync launch clears it and a sync failure overwrites it) or gets its own state; when it clears (next op?
next poll? never?); which note wins when two exist; or what tone a success takes. → Specify: own state in the quick-op hook, rendered as one more
`.git-sync-note`-shaped line with a tone (success neutral, refusal amber — needs a class or `data-tone`, no new colour literal), cleared on the next quick
op for any repo and on a Sync launch; a quick-op result and a sync note may both show.

### I8 — L105: "waits for or refuses" is two designs
`fetchAll` (`server/lib/git-fetch.ts:221-226`) joins an in-flight run; `fetchKeyState` (`client/src/lib/gitClock.ts:134-144`) has no "waiting" state, only
running/pending/refused. Waiting means the manual Fetch all's clock shows `runningSinceMs` while it blocks on the quick-op lock; refusing means a new
response shape and a new key sub-line. → Pick one (recommend: `fetchAll` awaits the quick-op lock before `runFetch`, so the existing clock and key copy
hold), and say the tick (`tickGitFetch`, L188-200) skips while the lock is held.

## Minor

- M1 — L59 vs L146-147: result-line copy disagrees with itself: `Pulled 1 commit into main.` (capital, no prefix) vs `claude-global: pulled 1 commit into
  main.`; `git refused: …` vs `git refused — …`. Pick one shape before "the builder polishes".
- M2 — L3, L43, checklist 4: the mockup's copy differs from the spec's and the differences are not called out: mockup `fast-forward main by 1 commit`,
  `nothing to pull`, `main has diverged from origin` (lowercase / different wording); mockup's combined result `Moved main forward 5 commits.
  fix/deck-paths has diverged: use Sync.` has no spec counterpart (the spec's "both" case covers two moves, not a move plus a refusal).
- M3 — L145: `Read-only from this network` truncates `READ_ONLY_TEXT` (`client/src/lib/writeRefusal.ts:7`, which the Fetch all key uses whole,
  `gitClock.ts:138`); say whether the sub-line uses the constant or a short form.
- M4 — L118: `/api/git/quick` breaks the `/api/git-stats` / `/api/git-fetch` shape (`server/index.ts:13-14`); whichever name, it needs rows in the
  `server/index.ts` header comment and the `docs/overview.md` route table (L99-103) — the spec lists neither.
- M5 — L128-129: a sibling doc needs a line in `docs/overview.md` §Map (CLAUDE.md: "§Map lists every subsystem and workflow doc").
- M6 — L123: `git-fetch.ts`'s never-prompt overlay is more than `GIT_TERMINAL_PROMPT=0`: `GIT_ASKPASS=''`, `SSH_ASKPASS=''` (L33-40) and `ssh -o
  BatchMode=yes` unless the user set their own ssh (L298-302). Push and Pull's fetch touch the network like fetch-all does; name the overlay so it is not
  reinvented.
- M7 — L101: `MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD` live in the per-worktree git dir (`git rev-parse --git-path <name>`), not the common dir
  the lock is keyed on; "reads the git dir" should say which.
- M8 — L113: "tens of seconds" is not a number (`FETCH_TIMEOUT_MS = 30_000`, `git-fetch.ts:22`); and no copy for a timed-out op.
- M9 — L99: "a fetch already pulled it" — a fetch moves remote-tracking refs only; reword (`origin moved again`).
- M10 — L55: while a quick op runs, is the left Sync half still clickable? Not stated.
- M11 — L164-165: the test list lacks the concurrent-op refusal on one common dir, a push rejected as non-fast-forward, a non-origin upstream, and
  `counts: null`.
- M12 — L85, L143 vs L76: "Detached HEAD" disables Pull outright, so row 3's "Not on the trunk" means "on a branch other than the trunk"; say it, since a
  detached pin's trunk-move would be safe and a reader may expect it.
- M13 — L153: the "no `title`" rule lives in `docs/subsystems/usage-limits.md:388` and the user's memory, not `.claude/CLAUDE.md`; "project rule" is right,
  the citation would help.

## Checked and true (no finding)

- L24 `main-pr-only` ruleset — CLAUDE.md §PR rules.
- L32, L118 `refuseWrite` as `serveGitFetch` — `server/api.ts:519-527, 1740-1749`.
- L52 `.git-mx-wrap{…overflow-x:auto}` — `styles.css:3040`; `overflow-x:auto` does force `overflow-y` to auto, so vertical clipping is real.
- L55 `.git-sync.on` cyan spin — `styles.css:2952-2953`.
- L66 `toplevel` is the worktree's own root — `types.ts:1692-1693`.
- L101 `branch` null mid-rebase — `types.ts:1694`.
- L103 fetch-all groups by common dir — `git-fetch.ts:263-276`.
- L105 `lock` fetch error exists — `git-fetch.ts:110`, `types.ts:1730`.
- L108 runs in localStorage — `useGitSync.ts:48` `usePersistedState('management.syncRuns')`.
- L112 fetch-all sets `core.hooksPath=/dev/null` — `git-fetch.ts:29`.
- L113 reader's 5s — `git-stats.ts:42`.
- L123 array-form, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` — `git-fetch.ts:33-40, 53-92`.
- L124-126 `outbound.test.ts` pins `git-fetch.ts` by CLAUDE.md text, in the slice before `` `client/dist/` `` — `test/outbound.test.ts:115-119`.
- L128 "The reader stays read-only" heading — `docs/subsystems/git-stats.md:11`.
- L152-156 Retry fetch key's disable rule — `GitParts.tsx:152`.
- L178 Inspector footer "Clean up via Sync" — `GitInspector.tsx:196`.
- `.claude/rules/` does not exist; no rules file is touched.
