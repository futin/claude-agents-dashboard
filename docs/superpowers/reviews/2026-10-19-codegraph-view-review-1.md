# Plan review 1 — Management › CodeGraph implementation plan

Reviewed: `docs/superpowers/plans/2026-10-19-codegraph-view.md` (plan) against `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` (spec), on
branch `feat/codegraph-view` at `920d9c9`. Reviewer: Fable 5.1, fresh session, checklist as dispatched. Every code claim below was read from the repo or from
the installed codegraph 1.6.2 bundle (`~/.nvm/.../@colbymchenry/codegraph-darwin-arm64/lib/dist`); `codegraph status --json` was run read-only once in this
repo to recompute the fixture numbers. No file in the repo was edited.

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Seven Important findings, all cheap to fold in; the plan's names, anchors, fixture values and derived numbers
check out, and every Review Focus item has a test in the task it names.

## Checklist results

| # | Check | Result |
| - | ----- | ------ |
| 1 | Coverage | Every spec section maps to a task. Three spec test/verification items have no task case: watcher "no file → false" (spec:200), `PATH` under `pnpm start` (spec:60), garbage stdout through `readCodegraphStatus` (spec:197). See I-4, I-6, M-9. |
| 2 | Values | All recomputed and exact — see §Values verified. |
| 3 | Reality | Every Create path is absent; every Modify path and anchor exists (`shared/types.ts:1743` GitStatsResponse, `server/api.ts:1725/1739/1796`, `server/index.ts:266`, `SideRail.tsx:88`, `git-stats-client.test.ts:88`). Two name slips: `methodNotAllowed` (M-1) and `formatAgo`'s contract (I-3). |
| 4 | Interfaces | Consumed names are produced earlier with the same spelling, except `startCodegraphRun`'s return type contradicts its own behaviour (I-2). |
| 5 | Order | No forward dependency. Task 4 ships a rail item that renders Git until Task 6 (M-10, acceptable). |
| 6 | Tests | Tests would fail red on missing exports and pin behaviour. Review Focus 1–5 each have the test the plan says (plan:100/181, 148–150, 179, 154, 102). One test is unrunnable as specified (I-3), one is racy by construction (I-2). |
| 7 | Conventions | "Behaviour not code" held throughout; no literal code blocks; size figures soft. |

## Important

**I-1 — plan:99, plan:134 — a `listed: false` pin with a path is not treated as dead.**
Spec:48 defines a dead pin as `path: null` **or** `listed: false`. `listPinRows` (`server/lib/management.ts:726-729`) returns rows whose `path` is set
but `listed` is false (cwd now a linked worktree, or the dedupe loser), and `serveOpenFolder` (`server/api.ts:1807`) refuses exactly those with
`403 not a pinned project`. The plan keys `missing` on `path: null` only (plan:99) and `not-indexed` on "dead pin or no graph root" (plan:134), so a
worktree pin would get a status read and a Sync.
→ Task 1: `readCodegraphStatus` returns `missing` when `pin.listed === false` (which covers `path: null`); add the case "listed false with a path → missing,
runner never called". Task 2: `startCodegraphRun` answers `not-pinned` for an unlisted pin (spec:98 "must be a listed pin"), matching open-folder; add the case.

**I-2 — plan:120 vs plan:134-135 — `startCodegraphRun` is declared synchronous but its checks are async.**
The signature returns `'started' | 'not-pinned' | 'not-indexed' | 'busy'` "synchronous decision", yet the behaviour needs `findGraphRoot` (plan:79,
`Promise<string | null>`) and `livePid` (plan:84, `Promise`). An implementer either reads the root from the cache — wrong after a run end or a dead
rebuild drops the entry (plan:131, 139): the next POST before a GET answers `404` for an indexed repo — or makes it async, and then two POSTs in one tick
(Review Focus 3, plan:44) can both pass the "own run" check before either records `run`. The Task 3 test (plan:179) awaits the first POST before sending
the second, so it would not catch that race.
→ Make it `Promise<…>`; add a synchronous in-flight mark per `dirName` taken before the first `await` and answering `busy` while held, cleared when the
run is recorded or refused. Add a Task 2 (or 3) case: two POSTs fired with `Promise.all` → one `started`/200, one `busy`/409, runner saw one launch.

**I-3 — plan:232, plan:273 — `codegraphQuietLine(repo, nowMs)` → "indexed 2h ago" cannot be built from `formatAgo`.**
`formatAgo` (`client/src/lib/format.ts:30-37`) reads `Date.now()` — there is no clock parameter — and returns `2h`, not `2h ago`. A test that passes
`nowMs` and expects a fixed string either ignores `nowMs` (then the parameter is decorative and the fixture must be built relative to real time) or
needs an ager that takes the clock.
→ State it: either `codegraphQuietLine(repo, nowMs)` uses a clock-taking helper (`formatAgoAt(ms, nowMs)` in `format.ts`, same thresholds as
`formatAgo`, with " ago" appended by the caller), or drop `nowMs` and build the fixture with `lastIndexedMs = Date.now() - 2h` in the test. Spec:163
writes `indexed <age>`; confirm the " ago" suffix is intended (the Git quiet line is the precedent to copy).

**I-4 — plan:147 — spec test "no `daemon.pid` → `watching false`" (spec:200) has no case.**
Task 1 covers `readPidFile` missing → null (plan:97) and `livePid` own/dead (plan:98); Task 2 covers live and dead pid (plan:147). The no-file path through
`readCodegraph` (`watching false`, `watcherSinceMs null`, `rebuildLive false`) is the common case and is untested.
→ Add to plan:147: "no `daemon.pid` → `watching false`, `watcherSinceMs null`; no `rebuild.pid` → `rebuildLive false`, `run null`".

**I-5 — plan:295 — Task 7 omits the two visual-suite files that must change for new shots.**
`test/visual/views.spec.ts:19` is a closed `kind` union (`'git-matrix' | 'git-inspector' | …`) and `:82` asserts `EXPECTED_SHOTS = 86` with the per-view
arithmetic in its comment (`:79-80`); `test/visual/fixtures/index.ts:49` is where a fixture is bound to its path (`docs/subsystems/visual-tests.md:81`).
"a `codegraph` fixture beside `fixtures/git-stats.ts` and shots" names neither, and the suite fails until both are edited.
→ List `test/visual/views.spec.ts` (three new `kind`s or a shared `codegraph-*` kind, four cases with `storage: { 'management.codegraphLayout': … }` as
`:64-68` do for Git, `EXPECTED_SHOTS` 86 → 90 and its comment) and `test/visual/fixtures/index.ts` (`'/api/codegraph': codegraph`) under Modify.

**I-6 — plan:281-285 — spec:60's builder duty (server `PATH` reaches `codegraph` and `node` under `pnpm dev` **and** `pnpm start`) has no step.**
Task 6 Step 2 verifies against the user's dev server only; `pnpm start` is the `NODE_ENV=production` path the user runs daily, and `codegraph` here is
an nvm shim (`/Users/andrejajevtic/.nvm/versions/node/v22.23.1/.../npm-shim.js`, `#!/usr/bin/env node`), so a launchd/cron-started `pnpm start` without
nvm's `PATH` would read every pin as `cli: 'missing'`.
→ Add to Task 6 Step 2 (or Task 7): run `pnpm build && PORT=<spare> pnpm start` on spare ports, GET `/api/codegraph`, expect `cli: 'ok'`; kill by the
recorded pid; note the result in the PR's Verification section.

**I-7 — plan:132 — the rebuild-live guard covers an `error` read only; `codegraph index` discards the DB, so the read can be `none`.**
The 1.6.2 `index` command recreates the database "from scratch (discard `.codegraph/codegraph.db` + its WAL)" (`bin/codegraph.js:849-861`,
`CodeGraph.recreate`). While the file is absent, `findGraphRoot` (plan:79, requires the DB file) returns null → `readCodegraphStatus` → `none` →
`rebuild.pid` is never read, the synthesised run disappears, and the row flips to *Not indexed* with no keys mid-rebuild; `startCodegraphRun` then
answers `not-indexed` instead of `busy`. The window is short (SQLite recreates the file on open) but a 25 s TTL would hold the wrong answer.
→ Resolve the root to "`.codegraph/` dir whose `codegraph.db` **or** live `rebuild.pid` exists", and widen plan:132 to "rebuild live and the read is
anything but `ok`: keep the previous stats, else `building`". Add the Task 2 case: live `rebuild.pid`, DB file removed → `state 'building'`, run shown.

## Minor

**M-1 — plan:171** — `methodNotAllowed` is a module-private function in `server/index.ts:141`, not an export of `server/api.ts`; it is usable from the
route table only. Say so, or the implementer looks for an import.

**M-2 — plan:81, plan:148** — say that `startedAt` in the pid JSON is epoch **milliseconds** (`WriterLockInfo.startedAt: number`,
`dist/mcp/writer-lock.d.ts:23`; this repo's `daemon.pid` carries `1792398668139`) and is passed through as `startedAtMs`. The test at plan:148 implies it;
the interface line does not.

**M-3 — plan:100-101** — status read with exit ≠ 0 and empty stderr: message unspecified (Task 2's run end has the fallback chain stderr → stdout →
`exit <code>`, plan:137-138). Reuse that chain here.

**M-4 — plan:199-200** — "in table order": the key union lists `pending` seventh while the spec copy table (spec:124) has it second. Name the table
(§Levels copy table, spec:121-130) so `problems[0]` is the verdict the spec expects for a repo with `reindexRecommended` and pending changes.

**M-5 — plan:205-210** — strings in spec §Source rather than §Client are not named: the Inspector fact "extractor unknown (older index)" (spec:68) and
the Matrix cells `complete` / `none` / `on` / `off` / *Not indexed* (spec:165-166). "At minimum" leaves them to the implementer; list them so the
text-module test can pin them.

**M-6 — plan:55-57** — the captured fixture carries `projectPath` / `indexPath` with the user's absolute home path, plus `walSizeBytes`, `backend`,
`journalMode`, `index.pendingRefs` the view never reads. Scrub the two paths to a neutral one before committing; the parser must ignore the extras
(worth one assertion).

**M-7 — plan:141, plan:143-144** — with `CODEGRAPH_TTL_MS = 25_000`, "real time with small waits" cannot exercise the TTL; only the injectable clock can.
Drop the alternative, or expose a test seam for the TTL as `resetCodegraph` is one for state.

**M-8 — plan:127** — the cache is keyed by root, so a repo pin and its subdirectory pin share one entry, one `run` and one `lastRun`. Intended and
sensible, but say it (and that the Inbox then shows the same run on both rows) so nobody "fixes" it.

**M-9 — plan:99-102** — spec:197 "garbage … → `error` with reason" is tested at the parser (throws, plan:95) but not through `readCodegraphStatus`
(parse throw → `{kind: 'error', message}`). One more case.

**M-10 — plan:237** — between Task 4 and Task 6 the rail offers *CodeGraph* and lands on Git. Fine for a branch, but say "do not merge between Tasks 4
and 6" or move the rail edit to Task 6.

**M-11 — plan:174** — `test/api-harness.js` is `test/api-harness.ts` imported with the `.js` suffix (`api-git-fetch.test.ts:11`); the plan's spelling is
the import spelling, so no change needed — noting only so the next reviewer does not flag it.

**M-12 — plan:248** — `createPollGate` lives in `client/src/lib/gitClock.ts:105`, not `gitPoll.ts`; the plan names no path, so this is only a pointer.

**M-13 — plan:273** — the meter is the private `GitMeter` in `GitClockChip.tsx:14-25`; the plan's "export it … rather than copying" is the right call and
accurate.

## Values verified

Recomputed from a read-only `CODEGRAPH_NO_UPDATE_CHECK=1 CODEGRAPH_NO_DOWNLOAD=1 codegraph status --json` in this repo (2026-10-19, codegraph 1.6.2):

| Plan line | Claim | Result |
| --------- | ----- | ------ |
| 55-57, 91-93 | fileCount 416, nodeCount 8254, edgeCount 33969, dbSizeBytes 36786176, extraction 27/27, state `complete`, languages `['javascript','tsx','typescript','yaml']`, lastIndexed `2026-10-19T08:14:07.660Z`, pending {0,0,0}, worktreeMismatch null, reindexRecommended false | all exact |
| 231 | kindGroups: functions 2637, imports 1968, properties 1481, constants 1145, types 436, other 587 | `nodesByKind` = class 8, constant 1145, file 405, function 2637, import 1968, interface 302, method 65, property 1481, type_alias 134, variable 109; types = 302+134 = 436; other = 8+405+65+109 = 587; sum 8254 — exact (note `method` and `variable` fall in *other*, which the plan's grouping implies; say it) |
| 228 | compactCount 8254 → 8.3k, 19400 → 19.4k, 587 → 587; formatDbSize 36786176 → 35 MB | 36786176 / 1048576 = 35.08 → `35 MB`; others exact |
| 225 | ranking E, C, D, A, B | E sum 6 > C sum 3 within `needs`; then D (`look`), A (`quiet`), B (`none`) — correct |
| 226-227 | verdict strings | match spec:123-124 verbatim; "5 modified · 2 added" drops the zero part as spec:124 says |
| 230 | extractorCell | matches spec:67, spec:165 |
| 156 | lock-loss stderr line | the 1.6.2 bundle's text is `could not acquire the file lock; retry when the index is available.` — the plan's `LOCK_LOSS_TEXT` substring (plan:87) is in it |
| 197-198 | tile labels and dot classes | `GIT_LEVELS` labels and `GIT_LEVEL_DOT` (`gitLevels.ts:45-53`) — `needs/flight/quiet/dead` exact |
| 177-179 | refusal bodies | `bad token` (`api.ts:524`), `not a pinned project` (`api.ts:1805-1807`), LAN header and `ANSWER_TOKEN=secret` (`api-git-fetch.test.ts:20-23`) — exact |

## Anchors verified

`shared/types.ts:1743` (`GitStatsResponse`, Git block ends ~1749) · `server/api.ts:1725` `serveGitStats`, `:1739` `serveGitFetch`, `:1796`
`serveOpenFolder` (reads the body with `readJsonBody`, 400 via `sendBadBody`) · `server/index.ts:266` `/api/git-fetch` · `client/src/components/SideRail.tsx:88`
management sub-nav · `client/src/lib/settings.ts:48,237,247` `ManagementTab`, `MANAGEMENT_TABS`, `clampSettings` · `client/src/hooks/useSettings.tsx:24-29`
`OWNED_KEYS` with `management.gitLayout` · `test/git-stats-client.test.ts:88` · `client/src/lib/gitLayouts.ts:28-45` contract · `useGitStats.ts:86` return shape ·
`useGitSync.ts:16-22,113-116` `tokenRequired` / `writeAccess` from `useRemoteAnswer` · `writeRefusal.ts:7,10` · `answerToken.ts:83` · `useAnswerToken.ts:9` ·
`Popover.tsx:10` `useDismiss` · `usage/Sheet.tsx:27` `Band` · `useNarrow.ts:69` · `usePersistedState.ts:10` · `useOpenFolder.ts:21` · `server/lib/settings.ts:341`
`setPinned` · `git-stats.ts:60` (#168 note), `:190-206` `readRepo` ENOENT rule, `:443-454` `readAll` pins · `docs/overview.md:96-98` API table, `:206-207` lib map,
`:367` §Map · `docs/subsystems/git-stats.md:257` docs-sync stamp · `test/outbound.test.ts:115-118` CLAUDE.md rule assertion (a codegraph sentence in the same
rule passes it; `scanOutbound` keys on network imports and `fetch(`, so `execFile('codegraph')` does not trip it).

Files the plan says to Create are all absent (`server/lib/codegraph*.ts`, `test/codegraph*.test.ts`, `test/api-codegraph.test.ts`, `test/fixtures/`,
`client/src/lib/codegraph*.ts`, `client/src/hooks/useCodegraph*.ts`, `client/src/components/management/Codegraph*.tsx`, `docs/subsystems/codegraph.md`).
