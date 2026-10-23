# Re-check of plan review 1 changes — quick pull/push plan

Plan: `docs/superpowers/plans/2026-10-19-quick-pull-push.md`. Scope: the diff in `plan-r1.diff` only (checked against the spec and the code).

**Verdict: APPROVE WITH FIXES.** Every code fact the diff states checks out. Two real problems remain, both small. The rest is stale text that the "binding clarifications" rule already overrides.

## Verified against the code
- `trunkOf` is exported at `server/lib/git-stats.ts:102` as `trunkOf(run: GitRunner, cwd)` — the clarification is right, and the adapter is needed because the order of arguments differs from `(cwd, args)`.
- `makeFetchRunner({ timeoutMs })` and `FetchRunner` are exported (`git-fetch.ts:20,53`). Dropping `currentFetchRunner` is sound: Task 3 now owns `overrideQuickRunner`, and nothing later consumes the removed name.
- `READ_ENV` carries `GIT_OPTIONAL_LOCKS=0` (`git-fetch.ts:33`), so the Task 3 clarification is accurate.
- `sendBadBody` exists (`server/api.ts:454`) and `/api/codegraph/run` uses it (`api.ts:1781`).
- `refusalKind(status, body)` returns `'token' | 'read-only' | null` (`writeRefusal.ts:10`), so the three-way `kind` mapping is implementable. `READ_ONLY_TEXT` is at line 7.
- `sync.pending` disables today's key (`GitParts.tsx:57`).
- `.git-sync.on svg` has a reduced-motion rule (`styles.css:2956`).
- `docs/overview.md:103` has the `POST /api/git-fetch` row the Task 7 clarification points at.
- `useGitStats.ts:55` already measures clock skew between `generatedAt` and the receipt, so the clarification that the note must not use the server's `generatedAt` is justified.
- `resetGitFetch` (`git-fetch.ts:148`) does `await inFlight` first, so resetting locks first is the correct order for the new hang case.
- `fetchAll`'s join check is first (`git-fetch.ts:221-226`), so the Task 2 ordering is implementable as written.
- The Task 4 two-pin test is sound. The second POST does its `rev-parse` through the quick runner, then gets `busy` from the lock.
- The new Task 3 push case (`feat/x` tracking `origin/feature/x`) is consistent with the refspec rule and with the Task 1 `target` JSDoc.

## Important

**I1. Review Focus 2 contradicts Task 3's new move-part rule, and the failed move part has no server test.**
- Plan line 42 says "if the client is stale, the server's `fetch origin main:main` refusal is reported, not worked around. (Task 1 + Task 3 tests.)"
- Plan lines 150-153 now say a trunk checked out elsewhere at re-read time gets no move part. So a stale client gets refusal `nothing` (`nothing to pull.`), and `fetch origin main:main` is never issued for it.
- Spec §Pull ("If the trunk was checked out elsewhere after the stats were read, git refuses the trunk move; that refusal is reported") describes the other behaviour. The new behaviour is defensible, since the spec also says the server re-reads and refuses with a reason. But Focus 2 now promises something no test covers.
- The only way a failed move part arises is the checkout-lands-between-re-read-and-fetch race, and no Task 3 case produces one.
- Fix: reword Focus 2 to "stale client → server re-read finds the trunk checked out → no move attempted (Task 3 case)". Add one Task 3 case with a spy runner that fails `fetch origin main:main` with a stderr line, and assert a failed `move` part with a non-empty `detail`. Optionally note the deviation in the spec's "Calls I made".

**I2. Empty `detail` has no result-line rule.**
- Plan lines 263 and 341 make `detail: ''` reachable: `promptlessEnv` null gives a failed push part with `detail ''` or `fetch-failed` with `detail ''`.
- The Task 5 result-line strings are all `… refused — D. Use Sync.` and `fetch failed — D. Use Sync.`. With `D = ''` they render `git refused — . Use Sync.` The implementer has to guess.
- Fix: add a Task 5 case: empty `detail` drops the ` — D` clause (`<repo>: git refused. Use Sync.`, `<repo>: fetch failed. Use Sync.`).

## Minor (file only)
- Plan line 162: the bullet still reads `[ff fix 3, move main 5]` while the Task 3 clarification says the case uses `feat/x` throughout. Make it `ff feat/x 3`.
- Plan line 305 (Task 6) still says `quickNoteExpired(note.atMs, data.generatedAt)`. The Task 5 clarification forbids this and the binding rule resolves it, but edit the line so a reader of Task 6 alone is not misled. `useGitStats` already holds the receipt time.
- Plan line 232 (Task 5 Interfaces) still shows `kind: 'refused' | 'failed'`. Update it in place to the three-way type rather than relying on the clarification.
- Plan line 200 (Task 4) says 400 `{error:'bad request'}`. The clarification says the body goes through `sendBadBody` with the expected-shape message. Both give 400, but the bodies differ, so align the line.
- Plan line 196 (Task 4) Consumes omits `overrideQuickRunner` (tests) and `tryLockRepo` (busy cases). Task 4's tests use both.
- Plan line 352: `syncPending` has no test case. Add "sync item disabled with `syncPending: true`, pull/push unaffected". Task 6 should also say where `QuickCtx` is built (`syncState`, `syncPending`, `quickRunning`), since it never mentions the call site.
- Plan line 356 (Task 8): planting a transcript lists the project but does not pin it. Pins live in `.dashboard-settings.json` in the server's cwd (`settings.ts:102`, gitignored). `test/api-git-fetch.test.ts` uses `setPinned` after `plantProject`. Add "then pin it through the Sessions UI" or the Git view will not show the repo. The cwd-relative settings file is gitignored and local to the worktree, so there is no risk to the user's own pins.
- Task 2 reset case: after `resetRepoLocks()` frees the waiter, the waiting `fetchAll` goes on to `runFetch`. The test must keep the runner spy and pins harmless, or the reset awaits a real fetch.
- Task 5 both-failed line reports only D1, so a failed move is silent when the ff also failed. This is acceptable and stated; just confirm it is intended.
