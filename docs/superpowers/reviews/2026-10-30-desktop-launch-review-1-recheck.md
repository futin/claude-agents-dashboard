# Desktop-launch plan — review 1 re-check

Date: 2026-10-30. Scope: only the lines `plan-r1.diff` adds or changes in `docs/superpowers/plans/2026-10-30-desktop-launch.md` (the round-1 fixes),
checked against `docs/superpowers/specs/2026-10-29-desktop-launch-design.md` and the code on this worktree (`main` differs from it only in
`test/ci-scope.test.ts`, `test/run-all.ts`, `test/run-some.ts`).

## Verdict

**APPROVE WITH FIXES** — two Important findings, both local to the task they sit in; nothing contradicts the spec or a hard rule.

## Important

- **[I] plan:68-70 vs plan:114-120 — the rail tests still assert string results after the signature became an object.** `reserveDesktopLaunch` now
  answers `{ status: 'ok'; at } | { status: 'rail-full' | 'in-flight' }` (plan:68), but every Step 1 case — including the two lines this round added
  (plan:118-119) — reads `→ 'ok'`, `→ 'rail-full'`, `→ 'in-flight'`. An implementer must guess whether to compare `.status` or the whole object, and
  nothing pins the `at` the ok branch returns, which Task 4 (plan:191) hands straight to `releaseDesktopLaunch`. → Write the cases as `.status === 'ok'`
  (etc.) and add one check on the ok branch, e.g. `reserveDesktopLaunch(null, 1000).at === 1000`.
- **[I] plan:298-299 — `client/src/hooks/useServerSettings.ts` is listed as Modify "(`SavingKey` and `save`, following `gitFetchSecs` end to end)", but
  that file never mentions `gitFetchSecs`** (grep count 0; the two mentions are in `SettingsView.tsx`). `SavingKey` is `keyof ServerSettingsPatch`
  (`client/src/hooks/useServerSettings.ts:9`) and `save` takes a `ServerSettingsPatch` (`:72`), so both cover `launchSurfaceDefault` the moment Task 1
  extends the patch type — there is nothing to edit there. → Drop the hook from Modify, or say "no edit expected: `SavingKey`/`save` derive from
  `ServerSettingsPatch`; typecheck confirms". The `SettingsView.tsx` half is right.

## Minor

- plan:178-180 — "needs `surface` and `resume` parsed **before** the prompt checks" and "all other prompt rules and their order of errors are unchanged"
  pull against each other for a body with a malformed `resume`, no prompt and no desktop surface: today it gets `prompt is required`
  (`server/lib/spawn.ts:163`); moving the whole `resume` block (`:196`) ahead of the prompt checks would give `bad resume id`. No test in `test/` pins
  that order (grep for `bad resume id` finds none), so this is a wording fix: say only the *shape* test (`resume !== undefined && surface === 'desktop'`)
  runs before the prompt checks, and the `resume` validation stays where it is. The listed cases (plan:195-200) pass either way.
- plan:200 — `{surface:'Desktop'}` with no prompt → `bad surface` is good; the combined case `{resume:'a b', surface:'Desktop'}` is left open. One
  sentence ("`bad surface` wins over `bad resume id`") removes the guess.
- plan:219-221 — `parseSpawnResponse` has no case for an extra field on a desktop body (`{surface:'desktop', sessionId:'x'}` → `{surface:'desktop'}`,
  dropping the id) or for a wrongly typed id (`{surface:'dashboard', sessionId: 42}` → null). Both are the cases that would catch a `'sessionId' in body`
  guard instead of a `typeof === 'string'` one.
- plan:71-72 — "never another entry, even one with the same `at`": for `null` ids the four entries reserved at `(null, 0)` are indistinguishable, so
  "exactly the one entry" cannot be literal there; the test on plan:119 ("exactly one more `'ok'` fits") says what is meant. Say "one entry" for the
  null case.

## Checked and found right

- plan:60 — `test/visual/fixtures/settings.ts:4` is a full `ServerSettings` literal; the only other `ServerSettings` value in the repo is the spread in
  `server/api.ts:576-584`, which needs no edit.
- plan:67-69 — `resetSettings()` exists (`server/lib/settings.ts:383`) and `test/settings.test.ts:66` already uses it for "simulate the server restarting".
- plan:94-95 — `OpenRunner` and `overrideOpenFolder({ run?, platform? })` are at `server/lib/open-folder.ts:11,39`; the 5000 ms timeout is `:15`.
- plan:127-130 — `ScanOptions` (`server/lib/scan.ts:33`), `RowOptions extends Pick<ScanOptions, …>` (`:549`), the `rowOptions` literal inside
  `scanSessions` (`:765-769`); the sessions list's `scanSessions` call with `archivedIds` is in `server/lib/scan-snapshot.ts:61-67`, not `api.ts`;
  `serveSessionRow` → `sessionFromRef` is `server/api.ts:1900-1908`. `desktopLiveSessionIds` is produced by Task 3 (plan:137) before Task 4 consumes it.
- plan:167-168 — `client/src/lib/spawnResponse.ts` and `test/spawn-response.test.ts` do not exist; `test/run-all.ts:53-66` shows the import-and-run
  registration the plan asks for.
- plan:179 — prompt checks at `server/lib/spawn.ts:163-172`, `resume` at `:196`: the cited line numbers are right.
- plan:199 — `RESUME_ID_RE = /^[A-Za-z0-9._-]+$/` (`spawn.ts:138`) rejects `'a b'`.
- plan:223-224 — `postWrite`'s `ok` is `res.ok` (`client/src/lib/postWrite.ts:41`), i.e. 2xx, so "returns `parseSpawnResponse(body)` on a 2xx" is the
  current branch at `useSpawn.ts:59`.
- plan:277-278, 287 — `Session.status` is exactly `'working' | 'idle' | 'question' | 'incomplete'` (`shared/types.ts:82`); `offer` for `idle`/`incomplete`
  and `stop-first` otherwise mirrors `resumeEligible` (`client/src/lib/resume.ts:39`), and the new `status:'question'` case makes all four statuses
  pinned.
- plan:300 — `test/client-settings.test.ts` imports only `client/src/lib/settings.js`, `filterSort`, `sections`, `config`, `useSettings`, `spawnOptions`
  (`:6-15`); it does not touch the server-settings patch, so "typecheck + build are the gate" is true.
- Copy and codes on the changed lines match the spec: 501 `desktop app unavailable`, 500 `open failed`, 409 `session is open in the desktop app`,
  409 `already resuming`, 429 `too many launches in flight` (spec decisions 5, 6, 8, 11); `Stop it first` / `Already open in the desktop app` (decision
  12); "a desktop 200 is a success, never `Launch failed`" (decision 10's test case).
- Conventions: no added line exceeds 160 columns; the added text states behaviour, signatures and cases, no code bodies.
