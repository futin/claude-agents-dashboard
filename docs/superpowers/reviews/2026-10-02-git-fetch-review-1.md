# Git fetch plan — review round 1

Reviewed: `docs/superpowers/plans/2026-10-02-git-fetch.md` (450 lines) against `docs/superpowers/specs/2026-10-02-git-fetch-design.md` (262 lines), on `main`
at `6df17f0`, 2026-10-02. Every code claim below was checked by reading the file named; one claim (readonly assignability) was checked with `tsc`.

**Verdict: REVISE** — 1 Critical, 12 Important, 17 Minor. Most fixes are local edits to the plan; the Critical is a one-line contract change plus a test.

## Coverage map (checklist 1)

| Spec item                                            | Task | Note                                                                                       |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| D1–D13                                               | 2–4, 6–7 | covered                                                                                |
| §1 module, runner, fetchAll, classifier, timer       | 2, 3 | covered                                                                                    |
| §2 API                                               | 4    | covered                                                                                    |
| §3 settings + card                                   | 1, 5 | covered                                                                                    |
| §4 chip, poll, popover, cards, copy                  | 6–8  | gaps: I7, I8, I9                                                                           |
| §5 server 1–12                                       | 2, 3 | 1 weakened (I1); 12 loosened and racy (I10)                                                |
| §5 API list                                          | 4    | covered                                                                                    |
| §5 settings list                                     | 1    | `POST /api/settings` 45 case tested at `setSettings` level only (M3)                       |
| §5 outbound                                          | 4    | covered                                                                                    |
| §5 client list                                       | 6    | missing: queued refresh, once-per-key firing, Fetch-all key's three failure states (I2)     |
| §6 docs                                              | 1, 4, 9 | covered                                                                                 |
| Verification                                         | 5, 7, 8, 9 | gaps (I6, M9)                                                                        |

Review Focus 1–5 each have a test (Tasks 1, 1, 3, 2, 6); RF5's is partial (M6).

## Critical

**C1 — plan:282 (test at :325-326).** `gitPoll.ts` is to call `onSchedule(now() + GIT_POLL_MS)` "whenever the interval is armed" and `null` when disarmed.
But `startGitPoll`'s timer is a repeating interval (`client/src/lib/gitPoll.ts:23` arms once; `useGitStats.ts:56` passes `window.setInterval`;
`test/git-stats-client.test.ts:268` fires it twice for 3 polls). After the first 30s fire nothing updates `nextPollAtMs`, so `syncReading`
(`countdownText(nextPollAtMs − now)`, floored at 0, plan:286) reads `0s` with a full bar for the rest of the visit, until a visibility change re-arms. The spec
asks for "when its interval next fires" (spec:127). The plan's own gitPoll test never fires the fake timer, so it passes against the bug.
→ Report on every interval fire as well (`onSchedule(now() + GIT_POLL_MS)` inside the timer callback), and add a case: start visible at `now = 500` →
`[30_500]`; fire at `now = 30_500` → `[30_500, 60_500]`.

## Important

**I1 — plan:124-125.** Case 1's D12 check says "`gitStatsMemoKeys()` unchanged across the call (`readGitStats` not involved — use `readRepo` with a
private memo and compare `memoKeys` before/after)". Without `readGitStats` the module memo is empty on both sides, and `fetchAll` cannot reach a private memo,
so either reading cannot fail. Comparing before/after the *reads* instead would differ by design: the trunk-vs-origin entry is keyed by the origin sha
(`server/lib/git-stats.ts:257-277`). The pins `fetchAll` needs already exist in this case, so `readGitStats` costs nothing extra.
→ Populate the module memo with `readGitStats`, compare `gitStatsMemoKeys()` immediately before and after `fetchAll`, then `readGitStats` again for
`behind === 1` (spec:179-180).

**I2 — plan:374 (and the self-review claim at :443 "client → Task 6").** Three spec §5 client cases (spec:218-221) have no test in any task:
- "a `refresh()` during an in-flight poll runs one more poll after it". The queued flag lives in `useGitStats` (Task 7, plan:351), and Task 7 has no tests.
- "the early poll fires `refresh()` once per `nextAtMs` … and not again for the same value". Task 6 tests only that `followUp` returns the same key. The
  once-per-key `Set` is chip code (plan:358-359) and untested.
- "the Fetch-all key's three failure states and copy". `useGitFetch`'s `token`/`refused`/`failed` transitions (plan:353-356) are untested, and only
  `FETCH_NEEDS_TOKEN`'s suffix is asserted (plan:323). `FETCH_REFUSED` and `FETCH_START_FAILED` are never pinned.
→ Extract the queue, the once-per-key firing and the failure reducer as pure functions (the `startGitPoll` / `gitSync.ts` precedent: tested apart from React).
Add these cases to Task 6. Pin all three failure strings exactly.

**I3 — plan:244.** `GIT_FETCH_OPTIONS: readonly { value: number; label: string }[]` is passed to `Segmented`, whose prop is the mutable
`options: { value: T; label: string }[]` (`client/src/components/settings/SettingsRow.tsx:82`). `tsc` rejects it with TS4104 ("is 'readonly' and cannot be
assigned to the mutable type"), verified in a scratch file. Task 5 Step 4's `pnpm typecheck` fails.
→ Either drop `readonly` from the constant or widen `Segmented`'s prop to `readonly { … }[]` in the same Task 5 doc-comment edit.

**I4 — plan:254.** Task 5's fallback CSS targets `.set .seg>button` "below `640px`", which has two problems:
- No such selector exists. `Segmented` renders `.set-seg` buttons (`SettingsRow.tsx:91`, `client/src/styles.css:2013-2014`).
- "Below 640px" reads as a `max-width` query, and `test/breakpoints.test.ts:208-214` fails any `max-width` query. The plan's own constraint says "no new
  `@media` breakpoint (reuse `768px`)" (plan:34).

→ Name `.set-seg button` (scoped to the new card if only it needs it), and phrase it mobile-first: smaller values in the base rule, restored under the
existing `@media (min-width:640px)` or `768px` tier.

**I5 — plan:411 (also :84, :229).** The ok branch of `RepoGitStats` gains a required `lastFetch`. The `okRepo` builders in
`test/git-stats-client.test.ts:28-37` and `test/git-sync-client.test.ts:29-37` build that type without it. `tsconfig.json` includes `test/`, so
`pnpm typecheck` stays red after Task 8, which claims "now green end to end". No task lists `test/git-sync-client.test.ts`. Task 1 Step 4's diagnosis is also
wrong: "the client … now fail[s] on the missing `fetch`/`lastFetch` fields", yet client code only reads these types; the producers and these test fixtures
are what break. So the offered "placeholder in `readGitFacts`/`readAll`" fallback does not make Task 1 green either.
→ Add `lastFetch: null` to both builders in Task 1 (Files list) and correct the Step 4 note.

**I6 — plan:384.** The hidden-tab check is "switch tabs for > 40s with interval 30 and confirm … no fetch started after the grace window (D2)". At 30s the
grace is `max(60s, 90s) = 90s` (spec:26) and D2 allows up to three more fetches inside it. A 40s window cannot observe the gate. The spec's Verification
says "no advance starts later than 90s after the last read" (spec:247).
→ Hide (or close the view) for at least 120s and check that the last `FETCH_HEAD` advance starts within 90s of the last `GET /api/git-stats`.

**I7 — plan:298-299 (shape at :276).** `gitTroubleLines` returns `{ dirName, text }`, with `text` one flat `` `${name} ${word} · ${age}` `` string. The
spec makes the word amber: "(`needs auth` / `offline` / `fetch timed out` / `fetch failed`, amber; …)" (spec:158-159). The mock draws the name in `<b>` and
only the word in `.warn` (`2026-10-02-git-fetch-mockups.html:225`). From one string the component can only colour the whole line or re-parse the copy,
which breaks "components build none".
→ Return the parts, e.g. `{ dirName, name, word, age }` (or `text` plus `word`), and test the parts.

**I8 — plan:269-281 vs :35 and spec:169.** The spec and the plan's own constraint put every user-facing string in `gitStatsText.ts`, with components
building none. The plan breaks this in two ways:
- The meter values (`syncing…`, `failed`, `fetching…`, `off`, `overdue`, `…`) are literals inside `gitClock.ts`'s readings.
- No constant is produced for the row names `Local sync` / `Fetch all`, the meter labels `SYNC` / `FETCH` / `next`, or the Fetch-all key's running text. So
  `GitClockChip` would have to build them.

→ Add those constants to `gitStatsText.ts`'s list in Task 6 and have `gitClock.ts` import the meter words from it.

**I9 — plan:357-361.** Task 7's popover spec gives the Fetch-all key as a `.git-pop-key` button labelled `now` and stops there. The spec also requires it to
"read `fetching…` and [be] disabled while one runs (payload or own POST)" (spec:151), which includes a fetch another tab started (`runningSinceMs` set while
this client's `pending` is false). `useGitFetch.start()` only no-ops on its own `pending` (plan:355).
→ State the key's states in Task 7 (`fetching…` and disabled when `clock?.runningSinceMs != null || pending`; disabled on `failure` `token` / `refused`).
Give the label a constant (I8).

**I10 — plan:141-143 (case 12).** Three issues:
- (a) "in under 1500ms" loosens the spec's "within a second" (spec:201).
- (b) Only the grandchild's pid is checked. The spec asks for "neither the script's pid nor the sleep's" (spec:201-202).
- (c) `process.kill(pid, 0)` is asserted once, right after the promise resolves. A SIGKILLed process stays visible to `kill(pid, 0)` until it is reaped:
  the sleep is reparented to launchd, and `sh` is node's own child. A single immediate probe will sometimes see it and fail spuriously.

→ Keep the 1s bound. Have the script also write `$$`. Poll both pids for `ESRCH` with a short bounded retry (e.g. every 20ms up to 500ms).

**I11 — plan:119-121.** Task 2's tests plant pins through `setPinned` and read `getGitFetchSecs()`. Both go through the settings store, whose file is
cwd-relative (`server/lib/settings.ts:91-93`). The second option offered ("`setPinned` plus `overrideClaudeRoots([])` and transcripts under a tmp `$HOME`")
names a tmp `$HOME` but not a tmp cwd. Run from `pnpm test`, it would write test pins into the repo root's real `.dashboard-settings.json`, which is the live
dev server's store. It would also make case 7's "`intervalSecs` … `0`" depend on whatever the developer has set. Task 3 says "inside the tmp cwd" (plan:172);
Task 2 does not.
→ Require a tmp cwd plus `resetSettings()` either side in Task 2's harness (the `inTmpCwd` precedent, `test/settings.test.ts:21`, or the API harness, which
chdirs, `test/api-harness.ts:125-127`).

**I12 — plan:168 (assertions at :178-182).** `tickGitFetch` calls `fetchAll(config)` "(not awaited past this tick's own promise)". That phrase is ambiguous,
and the case-8 / case-9 assertions depend on it:
- The tick that applies D11 and sets `nextAtMs = t` also starts the fetch, because `now ≥ nextAtMs`. Expectations like "60 → 300 with `lastEndedMs === null`
  → `nextAtMs === t`" hold only if the test reads the clock before that fetch ends.
- Nothing says to drain a started fetch before `resetGitFetch()`. A real `git fetch` left running from one case finishes during the next and its `finally`
  writes `runningSinceMs` / `lastEndedMs` / `nextAtMs` into the fresh state, which makes the suite flaky.

→ State that the tick's promise resolves without awaiting `fetchAll`. Have each D11 assertion read `getFetchClock()` while a deferred spy holds the fetch.
Require each case to release and await any in-flight fetch before `resetGitFetch()`.

## Minor

- **M1 — plan:53, :199, :426.** Line ranges are slightly off. `ServerSettings` spans `shared/types.ts:907-958`, not `:907-930`. `readAll`'s return is
  `git-stats.ts:399`. `.claude/DESIGN.md:325` is blank; the right-slot sentence is `:326-327`.
- **M2 — plan:115, :163, :247-248, :296, :357, :364, :367, :396-397.** Literal code fragments, against the plan's own "never literal code" convention (plan:19).
  Two of them carry bugs if transcribed: `calc(100vw − 32px)` (plan:367) uses U+2212, which is invalid CSS, and I3's `readonly`. Nested backticks at
  plan:296 and :299 also break the markdown rendering.
- **M3 — plan:75.** The spec's settings case is "a `POST /api/settings` with `gitFetchSecs: 45` is refused whole" (spec:208). The plan tests `setSettings`
  directly. Add one route-level case beside `test/api-body.test.ts`, or state the substitution.
- **M4 — plan:248.** "Rendered only when `server.state` is non-null, like the row above it" is false. The Usage forecast row
  (`client/src/components/settings/SettingsView.tsx:409-419`) renders unconditionally on `server.state?.…`. Pick one.
- **M5 — plan:351.** The spec says both "`now` → `refresh()`; a no-op while a poll is in flight" (spec:150) and "queues one more poll … when asked during
  it" (spec:141-142). The plan does not say whether *Local sync › now* bypasses the queue or is disabled while `polling`.
- **M6 — plan:298, :309.** Review Focus 5 is tested only through `fetchReading(clock: undefined)`. If `gitTroubleLines` is written to the type
  (`lastFetch !== null`), it throws on an old payload whose repos have no `lastFetch`. Add such a repo to the RF5 case through `gitTroubleLines` and
  `gitFetchedText`.
- **M7 — plan:357 vs :369-370.** The chip is "one `<button>`" root, yet "the chip root is the anchor" for the popover, and the popover holds buttons, so it
  cannot nest inside one. Name the wrapper (the `.ctlwrap` pattern, `client/src/components/Popover.tsx:27-29`) and give it a `git-` class for the md rule.
  `useDismiss` needs that wrapper as its ref (`Popover.tsx:4-6`).
- **M8 — plan:370.** The toolbar wraps only when its content overflows (`flex-wrap: wrap`). The spec says the chip wraps under the switcher below `md`
  (spec:114). If both fit at 375px they will not wrap; make the below-md wrap explicit if that is the intent.
- **M9 — plan:375-387, :434-437.** Verification is thinner than the spec in four places:
  - The *Fetch all* "behind count matches `git rev-list --left-right --count main...origin/main`" check (spec:247-248) is missing.
  - So is the 30–31s cadence check (spec:245).
  - The Unproven row says "reduced-motion rendering" where the spec's item is "whether the pulse and drop animations read right" (spec:252-253).
  - It lists the 375px fit as unproven although Task 5 screenshots it.
- **M10 — plan:330.** Between the Task 6 and Task 8 commits, `GitParts.tsx:52` and `GitTriage.tsx:62` pass a number to the new
  `gitFetchedText(repo, clock)`, which renders "fetched NaNs ago" at runtime. Updating the two call sites in Task 6 keeps each commit working.
- **M11 — plan:142.** "called with `([], {})`" omits the runner's `cwd`. The `pid` file is cwd-relative, so `cwd` must be the fixture dir, and the script
  needs `chmod +x`.
- **M12 — plan:109.** The spec skips a group "whose `git remote` or `git config` call fails" (spec:50). The plan treats only `git config` exit 1 as unset
  and is silent on other non-zero exits.
- **M13 — plan:128-129.** "a repo whose previous `lastFetch` was planted as `{ error: 'auth' }`": there is no planting seam. Say how to produce it (a first
  `fetchAll` whose spy answers the fetch with `Permission denied (publickey).` exit 128).
- **M14 — plan:3, :21.** The plan drives subagent-driven-development but has two process gaps:
  - It names neither the logic-heavy tasks that get per-task review (`.claude/CLAUDE.md` Subagent rules: 2, 3, 4, 7) nor carries the reviewer contract.
  - "Work on branch `feat/git-fetch` off `main`" does not say to use a worktree. This is a shared checkout, and `checkout -b` there moves HEAD under
    parallel sessions.
- **M15 — plan:357.** The prop name `fetch` in `GitClockChip({ stats, fetch, tokenRequired })` shadows the global `fetch` inside the component.
- **M16 — plan:187-188.** The `startGitFetchTimer` idempotence test is underspecified. With the real 1s `setInterval` and no injected timer, "a spy that is
  never called after stop" needs a watched, due clock and a real wait. Either inject the interval or drop the case.
- **M17 — plan:381-383, :359.** Two smaller points:
  - "with the right one: works" cannot be clicked from the preview pane, which holds no answer token, so hand that click to the human. "stop the API
    (`pnpm dev` down)" also stops Vite: stop only the API, by its recorded pid.
  - The once-per-key `Set` is "cleared when the key's prefix no longer matches". `followUp` returns `null` while hidden, so a hide/show re-fires the same
    `due:<nextAtMs>`, against "not again for the same value" (spec:218).
