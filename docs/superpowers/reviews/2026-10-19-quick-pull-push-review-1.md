# Plan review 1 — quick pull and push

Plan: `docs/superpowers/plans/2026-10-19-quick-pull-push.md`. Spec: `docs/superpowers/specs/2026-10-19-quick-pull-push-design.md`. Reviewed 2026-10-19 against the
worktree at `feat/quick-pull-push` (code identical to `main`; the branch carries docs only).

**Verdict: APPROVE WITH FIXES** — no Critical findings, six Important.

## 1. Coverage

Every spec section maps to a task:

| Spec section | Task |
|---|---|
| The UI (split, menu, keyboard, unclipped portal, no `title`, running caret, Inspector footer stays plain, `!sync.available` split) | 6 (behaviour), 8 (browser check) |
| Result line (own state, two tones, replace / clear on Sync launch / clear after poll > 30s, re-poll on answer) | 5 (`quickResultLine`, `quickNoteExpired`), 6 (hook + GitView) |
| Pull table rows 1–3, upstream exclusions, upstream gone, fetch first, dirty tree, diverged, detached | 3 (server), 5 (client) |
| `trunkCheckedOutElsewhere` | 1 |
| Push (origin-only, not `origin/<trunk>`, explicit refspec, never `-u`/force) | 3, 5 |
| Shared preconditions (in-progress files, 409 fetch running, per-common-dir lock, timer skip, `fetchAll` awaits locks, ordering vs D6) | 2, 3, 4 |
| Client-only "Sync is running" | 5 |
| Hooks run, 60s timeout, timeout copy | 3, 5 |
| Server route, `refuseWrite`, pin resolution, types first | 1, 4 |
| Never-prompt overlay reused, not copied | 2 (`promptlessEnv`) |
| CLAUDE.md sentence + outbound text pin | 7 |
| git-stats.md writer section, reader stays read-only | 7 |
| Copy table + Precedence | 5 |
| Remote use (write access / token disables) | 5, 6 |
| §Left to the builder test list (ff, dirty, diverged, trunk elsewhere, 403, same-common-dir, push non-ff, non-origin upstream, fetch-all awaits lock, reader test, client pure fn) | 1, 2, 3, 4, 5 — all present |

No spec section or spec test case is without a task. Review Focus items 1–5 each have a test (Task 3 dirty-tree; Task 1 + 3 worktree; Task 3 + 4 busy;
Task 2 fetch-all wait; Task 3 + 5 non-origin upstream).

## 2–7. Findings

### Important

**I1 — plan:105 vs plan:133, plan:201 — the runner seam contradicts itself, and Task 4's spy cannot reach `runQuickOp`.**
Task 2 produces `currentFetchRunner()` "so git-quick's tests can spy the same way" (via `overrideFetchRunner`), but Task 3 says `run` defaults to a *fresh*
runner with `timeoutMs: QUICK_TIMEOUT_MS`, which `overrideFetchRunner` never touches. `serveGitQuick(config, req, res)` takes no runner, so Task 4's
"LAN peer without the token → 403 and the runner spy saw nothing" has no way to install its spy. Defaulting to `currentFetchRunner()` instead would give the
real path git-fetch's 30s timeout (`server/lib/git-fetch.ts:22`, `:94`), breaking the 60s rule. An implementer has to guess.
→ Pick one seam: e.g. git-quick owns its own `overrideQuickRunner(run | null)` whose default is `makeFetchRunner({ timeoutMs: QUICK_TIMEOUT_MS })`, used by
both Task 3 and Task 4 tests; drop `currentFetchRunner` from Task 2, or state exactly how it interacts with the 60s timeout.

**I2 — plan:118 — `resetGitFetch` calling `resetRepoLocks` must happen before it awaits `inFlight`, or the reset deadlocks.**
`resetGitFetch` begins `if (inFlight) await inFlight` (`server/lib/git-fetch.ts:149`). After Task 2, an in-flight `fetchAll` waits on
`Promise.all(heldRepoLocks())`; if a test (Task 2's first case, Task 3's `fetch-running` case) fails or throws while it still holds a lock, the `finally`
reset awaits a promise that only `resetRepoLocks` can settle, and the whole suite hangs instead of reporting a failure. The plan says only "calls
`resetRepoLocks`", and appending it after the existing body is the natural reading.
→ State the order: `resetRepoLocks()` first, then await `inFlight`. Optionally add a case: lock held + `fetchAll` waiting → `resetGitFetch()` resolves.

**I3 — plan:147–150 (and test plan:164) — the move part's condition contradicts itself and, as written, makes a refusal on every Pull from a linked-worktree pin.**
Line 147 gates the move on `%(worktreepath)` being empty; lines 149–150 then say "If the trunk *is* checked out elsewhere, still attempt the fetch". With the
second reading, every Pull from a `.claude/worktrees/*` pin whose main checkout sits on a behind trunk tries `fetch origin main:main`, gets git's refusal,
and reports a warn line, even though the menu item only offered `Fast-forward feat/y by N` (the client disabled the trunk part via
`trunkCheckedOutElsewhere`). That is the spec's "common case" (spec:91–92) and runs into its anti-goal of a fast path doing something other than its label
(spec:31). The spec's "reported, not worked around" (spec:98) is about the trunk being checked out *after the stats were read*. git still reports that race
if the server checks `%(worktreepath)` just before the fetch.
→ Keep line 147's gate, delete the "still attempt" sentence, and change the plan:164 expectation: main checkout on main + main behind → no move part
(`nothing` when no other part applies). Cover the race only if it can be made deterministic.

**I4 — plan:255–263 — result copy for "current branch pulled, trunk move refused" (and for "both parts failed") is unspecified.**
The tests pin only move-ok + ff-failed (`moved main forward 5 commits; fix/x refused — D. Use Sync.`), mirroring spec:179. The reverse order, ff ok and move
failed, is the case I3 makes common, and it comes up anyway in the race spec:98 describes. Its text has no test, and neither does the case where both
parts fail. Since parts arrive in `[ff, move]` order (plan:144–147), an implementer has to guess both the wording and whether ok parts are listed first.
→ Add test cases with exact strings, e.g. `guide-manager: pulled 3 commits into fix/x; main refused — D. Use Sync.` (warn), and say what two failed parts read as.

**I5 — plan:206 — "two concurrent POSTs → one 200, one 409 busy" depends on timing.**
Both requests do `readJsonBody`, pin resolution and an awaited `rev-parse` before `tryLockRepo` (plan:137–138). Against a local bare origin the first op's
whole pull can finish before the second reaches the lock, so the outcome can be 200 + 200 (the second answering `nothing`). Review Focus 3 relies on it.
→ Gate the first op inside the runner spy (block its `fetch` until the second response has arrived), then assert 200 + 409 `busy`. That needs the seam
from I1.

**I6 — plan:154 — the push part's `target` is `origin/<branch path>`, but the refspec goes to the *upstream's* path.**
For `feat/x` tracking `origin/feature/x`, the push goes to `refs/heads/feature/x` (plan:153), but the result line would read `pushed 2 commits to
origin/feat/x`, naming a ref that was not written. The menu sub-line uses the upstream (spec:164, plan:246). Per the spec's anti-goal (spec:31), the result
line must name what actually moved.
→ `target` = the upstream short name (`rev-parse --abbrev-ref @{u}`); add one Task 3 case where the branch name and upstream name differ.

### Minor

- **M1 plan:127** — "Maybe modify `server/lib/git-stats.ts` to export `trunkOf`": it is already exported (`server/lib/git-stats.ts:102`). It takes a
  `GitRunner` (`(cwd, args)`, `git-stats.ts:20`), not a `FetchRunner`; reuse needs a two-line adapter. Say so instead.
- **M2 plan:80–81** — "compared … with the pin's `toplevel` the same way `branches[].worktreePath` is": branches compare against `mainWorktree` (the common
  dir's parent, `git-stats.ts:359-369`), not `toplevel`. Only the realpath step is shared; reword so nobody compares against `mainWorktree`.
- **M3 plan:229, plan:298** — `quickNoteExpired(note.atMs, data.generatedAt)` mixes the client's `Date.now()` with the server's clock. Over the tailnet a
  skewed device would clear the note at once or late. `skewOf` (`client/src/lib/gitClock.ts:39`) exists for exactly this; stamp the note in server time or
  correct by skew.
- **M4 plan:227** — `quickFailureLine` has no test case in Step 1 and no exact copy. A 403 is either read-only or a bad token (`refusalKind`,
  `client/src/lib/writeRefusal.ts:10`), and the signature cannot tell them apart.
- **M5 plan:195–196** — 400 body `{error:'bad request'}`. The house pattern is `sendBadBody` with the expected shape (`server/api.ts:1780`,
  `{dirName: string, kind: …}`). Also "a pinned project whose git read is `ok`" doesn't say whether the handler runs a git read. `runQuickOp` re-derives the
  toplevel and refuses `not-ok` itself, and its `pin.toplevel` parameter is really the pin row's `path`. Rename it, or say the handler resolves the toplevel.
- **M6 plan:235–236** — the Sync item ignores the global `sync.pending` that disables today's key (`client/src/components/management/GitParts.tsx:57`).
  `start` silently no-ops then (`client/src/hooks/useGitSync.ts:95`), so the item looks enabled but does nothing.
- **M7 plan:295** — spec:54 says focus returns to the caret after an item runs too; the plan states it for Escape only.
- **M8 plan:292–293** — the caret's spin needs the reduced-motion opt-out the Sync glyph has (`client/src/styles.css:2956`).
- **M9 plan:312** — `docs/overview.md` has an API table (`docs/overview.md:99-103`, with `POST /api/git-fetch` and `/api/codegraph/run` rows). Task 7 adds
  file-map lines only, not a `POST /api/git-quick` row.
- **M10 plan:102–103, plan:143** — `promptlessEnv` returns null when `config --get core.sshCommand` errors; Task 3 doesn't say what `runQuickOp` answers then
  (`fetch-failed` with empty detail is the obvious one).
- **M11 plan:31** — the constraint lists the overlay without `GIT_OPTIONAL_LOCKS=0`, which `FETCH_ENV` carries through `READ_ENV`
  (`server/lib/git-fetch.ts:33,39`). Harmless, but the list is not what `promptlessEnv` returns.
- **M12 plan:110–111** — "`lastFetchFor` error is `null`, never `'lock'`" can't fail before the change: an in-memory lock on `/x` never makes git see a lock
  file. The spy-ordering assertions are what prove the case; the `'lock'` clause adds nothing.
- **M13 plan:159** — "[ff fix 3, move main 5]" in a case set on `feat/x`; use one name.
- **M14 plan:242–245** — the Pull-reason precedence for a branch whose upstream is on another remote or is `origin/<trunk>` (no current-branch part at all)
  is not pinned. Spec:190 says "on a branch with an upstream"; say whether that means any upstream or only an eligible one, and add one case.
- **M15 plan:324** — the browser check pins a scratch fixture repo, but a pin needs a transcript under `~/.claude/projects` whose `cwd` is that repo
  (`test/api-git-fetch.test.ts:26` `plantProject`). The plan doesn't say how to make one, or that it must be removed afterwards.

## Reality checks performed

Exists as named: `RepoGitStats` ok variant (`shared/types.ts:1690`), `GitStatsResponse.generatedAt: number` (`:1751`), `WriteAccess` (`:963`),
`LOCAL_REF_FORMAT` with `%(worktreepath)` (`server/lib/git-stats.ts:148`), `localTrunk` (`:303`), `realpathOr` (`:216`), `FetchRunner`, `makeFetchRunner`,
`overrideFetchRunner`, `overrideFetchClock`, `getFetchClock`, `lastFetchFor`, `tickGitFetch`, `fetchAll`, `resetGitFetch`, `FETCH_ENV`, `SSH_BATCH`, `inFlight`
(`server/lib/git-fetch.ts`), `refuseWrite` (`server/api.ts:519`), `serveGitFetch` (`:1740`), route comment rows (`server/index.ts:13-14`) and handler
(`:267`), `OkRepo`/`canSync`/`phaseFor` (`client/src/lib/gitSync.ts`, `client/src/hooks/useGitSync.ts`), `GitSyncButton` (`GitParts.tsx:41`), `GitKeys` (`:127`),
`gitTracked` (`:170`), Branches' direct `GitSyncButton` (`GitBranches.tsx:69`), Inspector footer (`GitInspector.tsx:196`), GitView notes (`GitView.tsx:79-81`),
`GitLayoutProps`, `useGitFetch`, `fetchFailureOf`, `authHeaders`, `useAnswerToken`, `READ_ONLY_TEXT` (`writeRefusal.ts:7`), `GIT_POLL_MS` (`gitPoll.ts:10`),
`.git-mx-wrap` overflow (`styles.css:3040`), the outbound CLAUDE.md text test (`test/outbound.test.ts:115`), `test/tmp-root.ts`, `test/git-fixture.ts`
(`GitFixture`, `allowFail`), `docs-links`, `ui-kit-guard`, `git-sync-client` test modules, `docs/subsystems/git-stats.md` §"The reader stays read-only".
Not yet existing (correct for Create): `server/lib/git-quick.ts`, `server/lib/git-locks.ts`, `client/src/lib/gitQuick.ts`, `client/src/hooks/useGitQuick.ts`,
`GitQuickMenu.tsx`, `test/git-quick.test.ts`, `test/api-git-quick.test.ts`, `test/git-quick-client.test.ts`.

Interfaces: every name a task consumes is produced earlier with the same spelling, except the I1 runner seam. Order: no forward dependency. Plan conventions
(behaviour not code, soft budgets, 160-col prose) are followed.
