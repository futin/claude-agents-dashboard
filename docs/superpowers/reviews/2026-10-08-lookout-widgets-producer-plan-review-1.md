# Plan review 1 — lookout-widgets producer

Reviewed: the `## Plan` section of the task body (GitHub issue draft, scratchpad `task.md`, 611 lines) against
`docs/superpowers/specs/2026-10-08-lookout-widgets-producer-design.md` at `08b9603`. Contract source checked at `../lookout/shared/contract/*` and
`../lookout/docs/superpowers/specs/2026-10-07-lookout-design.md` §5/§8. Line numbers below are `task.md` lines unless prefixed.

**Verdict: REVISE.** One Critical: the plan names the widget's data-endpoint key `path`, the contract calls it `data`, so every widget built as written is
dropped by the validator and the dashboard would serve an empty catalog. Five Important findings, all cheap to fix.

## Critical

- **[C] task.md:172, :183 — widget data key is `path`; contract key is `data`.** `../lookout/shared/contract/types.ts:29-30` (`data: string` — "Relative path
  of the data endpoint"), `validate.ts:117` (`path(o, 'data', '')` fails with `data must be a relative path`), Lookout spec §5 line 160. A catalog built
  with `path:` loses every widget at `validateCatalog` (dropped, not fatal), so Task 3's creation step serves `widgets: []`, every data route is 404 and
  Task 5/9 `checkWidgets` fails. → Rename to `data: dataPath(id)` at :172 and `data: '/api/hub/widgets/usage'` at :183; add `data` to the Task 2 list of
  widget keys the test asserts on.

## Important

- **[I] task.md:185 — param key `kind:'choice'` does not exist; the contract field is `type`.** `types.ts:17` (`type: 'choice' | 'text'`), `validate.ts:100`.
  A decl literal with `kind` fails typecheck against "`ParamDecl` is the contract `Param` minus `optionsFrom`" (:169) or, if transcribed, the validator
  drops the widget (`param "project": type must be one of choice, text`). → `type: 'choice'`.

- **[I] task.md:143-145 — the jest→node:test mapping and the case count ignore `it.each`.** `../lookout/shared/contract/paths.test.ts:4,8` and
  `validate.test.ts:76,146,170,211,351` are `it.each` tables (paths: 1 plain `it` + 2 tables; validate: 42 plain + 5 tables). The listed mapping has no
  rule for them, and `grep -cE "^\s*(it|test)\("` counts a table as zero, so "ported count equals jest count" (1 and 42) is satisfiable while silently
  dropping every table row. → Add a mapping rule (`it.each(rows)(name, fn)` → `for (const row of rows) it(name, ...)`, one `it` per row) and count
  cases from the test runner's own `# tests` summary line on both sides (jest `--verbose` / `node --test` summary), not from grep.

- **[I] task.md:136 — `node --import tsx --test 'test/**/*.test.ts'` fails on Node 20, the package's declared engine (:46, :130).** Verified in a
  scratch dir with `~/.nvm/versions/node/v20.10.0` and `v20.19.5`: a quoted glob is taken literally (`Could not find '…/test/**/*.test.ts'`); Node 20's
  default discovery matches only `.js/.cjs/.mjs`, so a bare `--test` or a directory argument never sees `.ts`. Also the `.cjs` smoke test created at :352
  does not match `*.test.ts`, so even on Node 22 it never runs under `npm test`. → Let `sh` expand an unquoted list, e.g.
  `node --import tsx --test test/*.test.ts test/*/*.test.ts test/*.test.cjs` (verified: unquoted `test/*/*.test.js` runs on v20.10.0), and say in
  Task 6 that the CJS smoke file must be in that list.

- **[I] task.md:342 — the test-kit "dropped widget" case cannot observe a drop through the handler.** Task 3 (:214-215) serves the validator's
  *normalised* catalog, i.e. the dropped widget is already gone and the served catalog re-validates with `dropped: []` (`validate.ts:164`).
  `checkWidgets(handler)` at :321-322 receives only the handler, so step 1 (:327) never sees a drop and this test can only pass by accident
  (e.g. if the widget were also left in the catalog). Spec §3.4 has the same blind spot. → Either expose the creation-time drops on the handler
  (`HubHandler.dropped: Dropped[]`, produced in Task 3 next to `onDrop`) and have `checkWidgets` report each as `<widgetId>: dropped <reason>`, or
  delete the case and say the catalog-level check covers only what the handler serves.

- **[I] task.md:522 — "the existing `/api/...` table, which starts above `:330`" is false.** The table starts at `server/index.ts:177`
  (`if (u.pathname === '/api/configs/file')`), right after `const u = new URL(...)` at `:176`; `:330` is in the middle of the session write routes. An
  implementer who mounts "before :330" places the hub mid-table. Functionally harmless today (no existing branch matches `/api/hub/`), but the spec
  (§4 "before the existing routes") and the plan's own "before the table" disagree with the anchor. → Say "immediately after `const u = …` at
  `server/index.ts:176`, before the first `u.pathname ===` check at `:177`".

## Minor

- task.md:422 — `test/docs-links.test.js` does not exist; the file is `test/docs-links.test.ts` (the `.js` is the import specifier,
  `test/outbound.test.ts:14`). :567 has it right. Name the file `.ts` and the specifier separately.
- task.md:349 vs :377 — the `src/index.ts` export list omits `examples`, yet the ESM smoke test expects "an object for `examples`". Decide whether
  `examples` is public API (Task 1 :124 lists it as Produced) and make both lines agree.
- task.md:349 — "the decl types" does not obviously include `HubHandler`, `HubRequest`, `HubReply`, `ActionReply`, `AppInfo`, `Dropped`, which Task 9
  (:472) and the testkit import from the package root. List them.
- task.md:532 — on an over-cap POST, `readJsonBody` resolves `null` while `readBody` keeps draining (`server/api.ts:296-305`), and the repo's idiom is to
  reply then close the socket on `finish` (`sendBadBody`, `server/api.ts:443-447`). The plan's "null becomes undefined → 404" never closes, so the
  client finishes its upload before it sees the 404. Not a hang, so Review Focus 5 holds, but say whether to reuse the close-after-finish idiom.
- task.md:130, :383 — `"license": "MIT"` with no `LICENSE` file created; a public package should carry the text (npm auto-includes `LICENSE` in the
  pack, so :383's expected file list changes too).
- task.md:479 — "no icon (§2)": spec §2 says the pipeline does not *derive* the icon and "the app passes its path as `app.icon`"; it does not say the
  dashboard sends none. Spec §4 is silent. State it as a decision rather than citing §2.
- Global Constraints (:40-70) omit spec line 31, "The producer imports nothing but `../contract/*`". Add it, or an implementer may pull `node:` modules
  into `producer/`.
- task.md:46 — the dashboard's Docker `deps` stage (`Dockerfile:2-6`, `node:20-alpine`, `pnpm install --frozen-lockfile`, no `git`) will install a
  `github:` dependency for the first time. pnpm records a codeload tarball for GitHub refs so it should not need `git`, but nothing in the plan
  verifies it. Add `docker build --target deps` to Task 7 or to the PR's Unproven row.
- task.md:441 — "`test/api-read-endpoints.test.ts`, or a new `test/scan-snapshot.test.ts`": pick one so the registration step in `test/run-all.ts` is
  unambiguous.
- task.md:440 — "the scan call is around `:136–157`": it is `:146-157`, with its comments from `:134`. Cosmetic.

## Checklist results

1. **Coverage** — every spec section maps to a task: §2 decisions → Tasks 1, 6, 7, 11; §3.1/§3.2 → Task 2; §3.3 → Tasks 3, 4; §3.4 → Task 5; §3.5 → Task 6;
   §4 → Tasks 8, 9, 10, 11; §5 package tests → Tasks 2-6; §5 dashboard tests → Tasks 8-10 (null window, both null, usage-off, `usage: null`, status
   map, no `total`, deep link, route 200/404/foreign path, `/api/sessions` regression, dependency pin all present); §6 out-of-scope respected. No spec
   test case lacks a task. Spec line 31 (producer imports) is the one constraint not restated (Minor above).
2. **Values** — copy strings match (`Claude usage`, `5-hour`, `Weekly`, `Sessions`, `usage <status>`, `usage has no windows`,
   `<widgetId>: param <paramId> needs a case`, refresh 60/10, `open: '/'`, dependency string). Wrong values: `path` (Critical), `kind` (Important).
   Validator-derived expectations checked: gauge clamp output `{ bars: [{ label, percent: 100 }], updatedAt }` (`validate.ts:219-223, 245`, `compact`
   strips undefined keys), empty bars reason (`:244`), icon drop reason and `widgetId: null` (`:147`), absolute `open` drop (`:120`), `Action`
   shape `{ id, label, path, confirm?, input? }` (`types.ts:51-59`), `encodeURIComponent` expectations at :187 and :190 are correct.
3. **Reality** — Lookout files at :115 exist; `serveSessions` `server/api.ts:127`, `readJsonBody` `:336`, `UsageState` `server/lib/usage.ts:267`,
   `getCachedUsageState` `:439`, `UsageStatus` `shared/types.ts:745`, `Session` fields `:56-74` (`model: string`, `contextPct: number`, so the
   subtitle filter only ever drops `gitBranch`), CLAUDE.md bullet at `.claude/CLAUDE.md:69`, `findRepoRoot` in `test/docs-links.test.ts:19`,
   `withServer`/`userRecord` in `test/api-harness.ts:119,97` with `SHOW_USAGE=false` (`:27`), `MAX_SESSIONS` default 5 (`server/lib/config.ts:124`),
   `config.showUsage` (`:18`), `?session=` (`client/src/lib/deepLink.ts:17`), `docs/overview.md` §Map (`:323`), PR template present. Files to Create
   are all absent. No bare import exists under `server/` today, so Task 7's subset assertion starts true. `server/config.ts` is not a path the plan
   uses (it says `Config` only) — fine. Wrong anchors: `:330` (Important), `docs-links.test.js` (Minor).
4. **Interfaces** — each Consumed name is Produced earlier with the same spelling: path helpers (T2→T3), `HubHandler`/`HubRequest`/`HubReply` (T3→T4/5/9),
   `checkWidgets` (T5→T9), `scanSnapshot` (T8→T9), `createDashboardHub` (T9→T10), `readJsonBody` (existing). `run(): number` sync for Task 7 and
   `await runApiHub()` for Task 10 match `test/run-all.ts`'s two registration forms (`:118+`, 84 sync / 28 async).
5. **Order** — no forward dependency. Task 6 tags before Task 7 `pnpm add`; Task 8 before Task 9; the pin test's subset→equality tightening is stated in
   both Task 7 and Task 9. The "ask the user" gates (Task 6 publish, Task 11 follow-ups) are explicit.
6. **Tests** — each task's cases would fail red before implementation (module missing / route absent) and pin behaviour, not internals. Review Focus
   1-5 each have cases: 1 → :302-309; 2 → :256-259; 3 → :237-248, :295-299, :313; 4 → :253-254, :312; 5 → :544-549. The one unachievable case is
   :342 (Important above).
7. **Conventions** — no literal code blocks anywhere; size hints declared soft at :18; prose wrapped at 160. Followed.

## What I did not verify

- That pnpm resolves `github:futin/lookout-widgets#v0.1.0` to a codeload tarball in a `git`-less Alpine image (Minor above).
- The exact row-count of each `it.each` table; only that the tables exist and the grep rule misses them.
