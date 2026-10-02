# Git fetch plan — review round 2 (narrow re-check)

Reviewed: the round-1 → now diff of `docs/superpowers/plans/2026-10-02-git-fetch.md` (508 lines), on `main` at `dbeb061`, 2026-10-02, against
`docs/superpowers/specs/2026-10-02-git-fetch-design.md` and `docs/superpowers/reviews/2026-10-02-git-fetch-review-1.md`. Only added or changed lines were
reviewed. Unchanged text comes up only where a change made it inconsistent. I read the file named for every code claim below.

**Verdict: APPROVE WITH FIXES.** 0 Critical, 4 Important, 9 Minor. Every round-1 Critical and Important finding is resolved. Three of the Important findings
are new inconsistencies that the fixes introduced: a constraint whose stated reason is false, a typecheck claim the unchanged Task 7 text cannot meet, and a
worktree mandate the browser steps were not updated for. The fourth is a spec assertion the I1 rewrite dropped. Each is a local edit.

## Round-1 resolution

| R1    | Status   | Where now                                                                                                      |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------- |
| C1    | resolved | plan:318-320 (schedule reported on every fire), test plan:367-369, live check plan:428                         |
| I1    | resolved, but dropped a spec assertion | plan:142-144 (see I3 below)                                                          |
| I2    | resolved | `createPollGate` / `createFollowTracker` / `fetchKeyState` plan:312-317, tests plan:357-361; strings plan:304-306 |
| I3    | resolved | plan:261-262 (prop widened)                                                                                    |
| I4    | resolved | plan:279-280 (`git-fetch-seg`, no media query; `Segmented` has no `className`, `SettingsRow.tsx:78-86`, so the wrapper branch applies) |
| I5    | resolved | plan:68-69, :99-101. Verified that only `git-stats.ts:315-325`/`:399` and the two test builders produce these types   |
| I6    | resolved | plan:438-439                                                                                                   |
| I7    | resolved | plan:298-299, :405                                                                                             |
| I8    | resolved | plan:43, :300-306 (see M2 for a side effect)                                                                   |
| I9    | resolved | plan:331-334, :408-409                                                                                         |
| I10   | resolved | plan:161-164                                                                                                   |
| I11   | resolved | plan:44-45, :136-139                                                                                           |
| I12   | resolved | plan:120-121, :188-190, :194-195 (see M3)                                                                      |
| M1–M17 | resolved except as noted | M2 partly (CSS declarations at plan:417-419 are still near-literal; taste only). M3 partly (M4 below). M14 resolved, but its worktree text opens I4 |

## Critical

None.

## Important

**I1 — plan:41-42 (with plan:413-414).** The new constraint reads "no new `@media` query and no `max-width` query (`test/breakpoints.test.ts` rejects
them …)". That reason is half false. The test rejects only `max-width` width queries and width values off the ladder (`test/breakpoints.test.ts:208-224`).
Non-width families are filtered out before the check (`:120-140`), and a new `@media (min-width:768px)` block would pass. The blanket ban also collides with
Task 7's own rule, "`animation: none` under `prefers-reduced-motion`" (plan:413-414). Repo precedent writes that rule as its own one-line
`@media (prefers-reduced-motion:reduce){…}` per component (`client/src/styles.css:2058`, `:2311`, and the Git section's `:2707`). So the implementer has to
guess between breaking the constraint and folding the rule into someone else's block.
→ Scope the constraint to width queries: "no `max-width` query and no width off the ladder (`test/breakpoints.test.ts:208-224`); width rules go in the
existing `min-width:768px` block at `:2720`". Name `styles.css:2707` as the home for the meter's reduced-motion rule, or allow one new reduced-motion line.

**I2 — plan:442 (with unchanged plan:421-422 and plan:452).** Task 7 Step 3 used to say typecheck was "red only on Task 8's callers if any remain". It now
claims a plain green `pnpm typecheck`. The unchanged text still says "`GitBody` and the three layouts take `clock={data?.fetch}` (Task 8 consumes it)". But
the layouts' prop types are `{ repos; sync }` only (`GitCards.tsx:12`, `GitTable.tsx:19`, `GitTriage.tsx:21`), and declaring `clock` there is Task 8's
Files entry (plan:452), not Task 7's (plan:381-389). Passing `clock` to `<GitTable … />` at `GitView.tsx:96-98` in Task 7 is a TS2322, so as written the
Task 7 commit is red.
→ Say Task 7 threads `clock` into `GitBody` only (it lives in `GitView.tsx`), and Task 8 passes it on to the three layouts. Or move the three prop
declarations into Task 7's Files list.

**I3 — plan:142-144.** The I1 rewrite of case 1 now reads `readGitStats(cfg)` before `fetchAll` only to fill the memo, and never asserts its value. Spec §5
case 1 requires "before `fetchAll`, Git Stats reads `trunkVsOrigin.behind === 0`; after, `1`" (spec:179-180), and the round-1 text had it. Without the
before-value, the fixture's precondition is unproven: a scratch push that also updated `a`'s tracking ref would pass with a no-op fetch.
→ Assert `behind === 0` on the first `readGitStats`, then record the memo keys as now.

**I4 — plan:23-28 (with unchanged plan:277 and plan:424-441).** The new Process paragraph mandates a worktree, but the browser steps still say "`preview_start`
the dev server". In this repo that silently verifies the wrong tree. `.claude/launch.json:4-14` holds the only configs, with no `cwd`, and the file is
gitignored (`.gitignore:7`), so a worktree has none. `preview_start({name})` resolves it from the main checkout and runs main's code. This was recorded on
this machine on 2026-08-17 (`~/.claude/projects/…/memory/worktree-preview-server-workaround.md`). A fresh worktree also fails one unrelated test until
`pnpm build` has produced `client/dist`: `test/api-usage-rates.test.ts`, recorded on 2026-09-04 (`fresh-worktree-needs-build.md`). That contradicts Task 2
Step 4's "nothing else moves" (plan:169).
→ Add to Process:
- `pnpm install && pnpm build` on landing.
- A worktree `.env` with `PORT=4273 WEB_PORT=5273` (plus `ANSWER_TOKEN` for Task 7's token checks).
- `pnpm dev` started from the worktree by Bash in the background with its pid recorded, then `preview_start({url: 'http://localhost:5273'})`.
- Teardown by that pid only.

Point plan:277 and Task 7 Step 2 at it.

## Minor

- **M1 — plan:401 vs :417-419.** The chip root is "`git-clock-root` (position: relative, the dismiss ref)" with no breakpoint. The CSS paragraph makes it
  relative only inside the `min-width:768px` block, so the popover anchors to the toolbar below `md`. Both readings render the same at 375px, because the
  root is `flex-basis: 100%` there. Pick one sentence.
- **M2 — plan:43 vs :263, :268.** The strengthened constraint says `gitClock.ts` builds no user-facing string. Task 5 still puts the six labels `Off`, `30s`
  … `10m` in `gitClock.ts` (`GIT_FETCH_OPTIONS`), and the Settings card's copy sits inline in `SettingsView.tsx`, as every other card's does. Either scope
  the constraint to the spec's §4 copy ("Every string above", spec:169) or move the labels.
- **M3 — plan:199-201.** "The spy saw it while the tick's promise has already resolved" and "the spy saw a fetch start in that tick" cannot be read straight
  after `await tickGitFetch()`. The `fetch` argv reaches the spy only after the real `rev-parse` / `git remote` / `git config` calls complete. Say: right
  after the tick, `getFetchClock().runningSinceMs === t`; then await the spy's "fetch seen" deferred.
- **M4 — plan:91-92.** `test/api-body.test.ts` drives handlers directly (`:7`, `:144-153`), so "a following `GET /api/settings`" means `serveSettingsRead`
  (`server/api.ts:571`) or `getSettings()`. The route case also sends `{gitFetchSecs: 45}` alone, which proves a 400 but not "refused whole". Send
  `{idleSecs: 30, gitFetchSecs: 45}` and check `idleSecs` is unchanged.
- **M5 — plan:362 vs :344.** `gitFetchedAgeText` ages through `formatAgo`, which reads `Date.now()` (`client/src/lib/format.ts:31`). "`fetchedAtMs` two
  days back" must therefore be `Date.now() − 2 × 86_400_000`, not two days before the block's fixed `now = 1_000_000`. The existing assertions do the former
  (`test/git-stats-client.test.ts:179`).
- **M6 — plan:367-369.** `now: () => 500` then "with `now` returning `30_500`" needs a mutable clock. `startGitPoll` also calls `disarm()` on every
  visibility change (`client/src/lib/gitPoll.ts:30-33`), so say whether an already-disarmed `disarm()` reports `null`. The expected `[…, 70_000]` hides
  whether a second `null` precedes it.
- **M7 — plan:408.** `intervalSecs` for `fetchKeyState` when `clock` is `undefined` (an old server, or a first-load error) is unstated. `?? 0` would show
  amber "auto-fetch off · Settings › Shared" for a server that may well have it on. State the fallback (e.g. the row's plain sub with no amber).
- **M8 — plan:440 vs :491.** Step 2 sends "`prefers-reduced-motion` and the pulse/drop animations" to the Unproven row. The PR's list at :491 carries only
  the animations. Add the reduced-motion static rendering there.
- **M9 — plan:360, :366; :280.** Two small points:
  - "The five states above with their exact labels, subs" does not say literal strings. A test that compares against the imported constants never pins
    `FETCH_REFUSED` / `FETCH_START_FAILED` copy, which round-1 I2 asked for. Say literal.
  - The Task 5 fallback "tighten … `padding: 7px 9px`" raises the vertical padding over today's `6px` (`client/src/styles.css:2014`). If only width
    matters, keep `6px`.
