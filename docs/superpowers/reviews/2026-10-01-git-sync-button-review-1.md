# Review 1 — Git Sync button plan (`docs/superpowers/plans/2026-10-01-git-sync-button.md`)

Reviewed 2026-10-01 against spec `docs/superpowers/specs/2026-10-01-git-stats-design.md` §9 (context §6) and the code on `main` at `14e7734`. Read-only;
every claim about the code below was checked by reading the cited file:line.

## Verdict: REVISE

One Critical: the session name the spec and plan both mandate cannot survive the server's name validator, so every Sync launch ships unnamed. Four
Important items where an implementer must guess or where the stated procedure misses a repo test contract. Coverage of spec §9 is otherwise complete and
the expected values I could check against the code are right.

## Critical

### C1 — `git-sync · <repo name>` is rejected by the server's name charset; every sync launches unnamed

- Plan: line 38 (`session name sent with the launch: git-sync · <repo name>`), line 129, test R1 line 144-145 (asserts `name: 'git-sync · repo'`
  verbatim), Global Constraint line 25 ("No server change").
- Code: `server/lib/spawn.ts:91` — `const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;` and `server/lib/spawn.ts:178-180` — a name that fails `NAME_RE`
  or exceeds `NAME_CAP` (60, line 69) is silently replaced by `undefined` ("drop-don't-reject"). The middle dot `·` (U+00B7) is not in the class, so the
  exact string the plan tests for is dropped on every launch and the spawned session has no display name. The plan's R1 test would pass while the
  behaviour it describes never happens.
- The spec carries the same string (§9, spec line 152 of the §9 excerpt: `a session name git-sync · <repo name>`), so this is inherited, but the plan
  is where it becomes a tested value, and the plan forbids the server change that would otherwise rescue it.
- Also latent in the same rule: a repo name containing any character outside `[A-Za-z0-9 ._-]` (a pin named with `@`, `/`, `(`, a non-ASCII letter)
  or a name pushing the total past 60 characters drops the whole name the same way.
- → Fix in the plan (client-only, keeping "No server change"): make `syncRequest` build the name through a pure sanitiser that (a) uses a separator
  inside the charset (e.g. `git-sync - <repo name>` or `git-sync <repo name>`), (b) strips characters outside `NAME_RE`'s class and trims to
  `NAME_CAP` (both constants already mirrored in `client/src/lib/spawnOptions.ts:42` and could be joined by a mirrored `NAME_RE` with a
  `test/spawn-options.test.ts` parity case, as `NAME_CAP` already is). Update Global Constraints line 38 and R1 line 144-145, add a test case for a
  name with a disallowed character and one over 60 characters, and amend spec §9's string in the same commit so spec and plan stay equal.

## Important

### I1 — `start()` cannot read `needsToken` / `error` right after `await launch()`; the note derivation as written reads stale state

- Plan: lines 207-209 ("on null, set `note` from `needsToken` (→ `SYNC_NEEDS_TOKEN`) or `error` (→ `syncLaunchErrorText`)").
- Code: `client/src/hooks/useSpawn.ts:49-63` — `launch` reports the 403 and the server reason through `setNeedsToken` / `setError` (React state) and
  returns only `null`. Inside the `start` callback that awaited it, `needsToken` and `error` are still the values of the render that created the
  callback, so the branch "set `note` from `needsToken`" would see `false` on the first 403 and the previous attempt's reason on later ones.
- → State in Task 3 that `note` is derived from `useSpawn`'s `needsToken` / `error` in an effect (or at render) keyed on those two values, with the
  launch-failure note taking precedence rules spelled out (403 beats `error`), and that `start` itself only clears the note before calling `launch`.
  Alternatively have `start` inspect the response itself by extending `useSpawn` — but that is a change to a shared hook the plan does not list.

### I2 — `management.syncRuns` and the persisted-key sweep in `test/client-settings.test.ts`

- Plan: line 63 (Q2: "Not in `OWNED_KEYS`"), line 202 (`usePersistedState(SYNC_RUNS_KEY, {})`).
- Code: `test/client-settings.test.ts:18-27` scans every `usePersistedState('<literal>')` in `client/src`; lines 326-335 fail the suite for any key
  that is neither in `OWNED_KEYS` (`client/src/hooks/useSettings.tsx:24-32`) nor in the test's `exempt` set (`dashboard.settings`,
  `dashboard.answerToken`). The test's own comment says the sweep exists precisely so a key added in a new component cannot "quietly survive Reset".
- Two outcomes, both unaddressed by the plan: written with the literal key, Task 3's Step 4 "`pnpm test` green" is false until the test is changed;
  written through the `SYNC_RUNS_KEY` constant as line 202 literally says, the regex never sees the key and the sweep's invariant is silently bypassed
  — the exact failure mode the test was written to prevent, with no record of the decision.
- → Task 3 must name the decision: either add `'management.syncRuns'` to the test's `exempt` set with Q2's reason beside the other two exemptions
  (and pass the key as a literal so the scan still sees it), or drop Q2 and put it in `OWNED_KEYS` (then line 337's `management.` carve-out already
  tolerates it). Either way list `test/client-settings.test.ts` as a Modify in Task 3.

### I3 — Table off rows: "an empty cell" plus the existing `colSpan={COLS - 1}` overflows the seventh column

- Plan: line 241 ("`COLS` becomes 7. Off rows get an empty cell.").
- Code: `client/src/components/management/GitTable.tsx:12` (`COLS = 6`) and `:36-39` — an off row is the name cell plus one `<td colSpan={COLS - 1}>`
  carrying the state sentence, i.e. it already spans the full width. Bumping `COLS` to 7 makes that span 6 and adding "an empty cell" gives the row
  1 + 6 + 1 = 8 columns' worth against a 7-column header.
- → Say which: keep the sentence at `colSpan={COLS - 1}` and add no cell (the sentence absorbs the Sync column), or make it `COLS - 2` and add the
  empty cell. The sub-row `colSpan`s at `:75-101` (`COLS`, `COLS - 3`) also shift meaning with `COLS = 7`; state that they are meant to widen with it.

### I4 — `SyncRun.name` is ambiguous between the repo name and the session name, and the copy depends on it

- Plan: line 115 (`name: string`, no comment), line 208 ("store `{ sessionId, dirName, name, launchedAtMs }`"), line 142 (fixture `name: 'repo'`),
  T2 line 169 (`syncFailedText('repo', 'boom')` → `git-sync in repo failed to start: boom`), line 205 (`failed: { name, error }` feeds the note).
- Task 3 line 208 sits directly after a sentence about the `name` sent with the launch (`git-sync · <repo.name>`, line 129). An implementer who stores
  the session name produces the note "git-sync in git-sync · repo failed to start: …" with every test still green, because the tests only ever pass
  `'repo'`.
- → Write `name` as `repo.name` on line 115 and line 208 (`/** the repo's display name, for the notes */`).

## Minor

- M1 — Plan line 265: `docs/subsystems/settings.md` has no "where each setting lives" *table*; §"Where each setting lives, and why"
  (`docs/subsystems/settings.md:6-40`) is prose that also enumerates the Local groups ("Display, Live data, New sessions, Notify this browser,
  Connection and Reset", line 17-18). Task 5 should name both edits: the four keys in the per-device paragraph and the new **Git Sync** group in that
  list.
- M2 — Plan line 90: "reuse the launch sheet's `SPAWN_MAX_PERMISSION` wording" — that string is a local template literal in
  `client/src/components/SpawnPanel.tsx:100`, not an export. Say "duplicate" or name where the shared constant goes.
- M3 — Plan line 117 and 110: `syncRequest` takes `Pick<Settings, …>` but `Settings` (from `client/src/lib/settings.ts`) is not in Task 2's Consumes list.
- M4 — Plan line 181 vs 183/197: `reconcileRuns` lives in `gitSyncRuns.ts` only "if created", yet Task 3's tests and Task 5's docs cite it by name.
  Pick the module so the test's import path is not a guess.
- M5 — Plan line 193: `phaseFor(repo)` has no parameter type; `RepoGitStats` is implied by `runFor` (line 121).
- M6 — Plan line 231: `useGitSync` calling `useRemoteAnswer()` opens a third independent `/api/health` poll (one already runs in `SettingsView.tsx:69`,
  and `useRemoteAnswer.ts:30-44` polls per hook instance). Consistent with the existing pattern; note it so the implementer does not "fix" it mid-task.
- M7 — Plan line 141-142: the `session(id, status)` fixture must satisfy `Session` (`shared/types.ts:44-…`, ~25 required fields); say the fixture may
  cast, so an implementer does not hand-fill every field in a test file.
- M8 — Plan line 45-46 (Review Focus 1): a run that falls out of the top-50 while parked on git-sync's question reads `Syncing…` *disabled*, so the user
  cannot reach the drawer to answer it from Management. That is spec Q6's accepted trade ("rare"), but the sentence should say the cost plainly.

## Checklist results

1. **Coverage.** Every §9 bullet maps to a task: placement (Cards/Table/Triage → Task 4), hide rules incl. `spawnAvailable` (Task 2 `canSync`, Task 3
   `available`, Task 4 render guard), no Sync-all/Prune (no task, correctly), click-launches-at-once with `dirName` + prompt + name + Git Sync settings
   (Task 1, Task 2 `syncRequest`), pin's path not toplevel (Q4 / Task 2), per-device `localStorage` keyed by toplevel (Task 2 `SyncRuns`, Task 3), the
   three button states and the drawer inside Management (Tasks 2-4), forget-and-re-poll on `idle`/`incomplete` (Task 3 `reconcileRuns` + `onEnded`),
   "no server change" (Global Constraints). The spec has no §9 test cases of its own; the plan's cases are its own. No gap.
2. **Values.** `Syncing · open`, `Syncing…`, `Sync`, `working`/`question` running, `idle`/`incomplete` ended, prompt `/claude-agents-dashboard:git-sync`,
   `management.syncRuns`, limit 50 = `SCAN_CAPS.limit` (`server/api.ts:78`), `scanQuery(DEFAULT_SETTINGS)` = `?limit=5&lookback=48&active=5`
   (`client/src/lib/settings.ts:130-134, 277-279`) all check out. The session name is C1.
3. **Reality.** Every Modify path exists; every Create path (`gitSync.ts`, `gitSyncRuns.ts`, `useGitSync.ts`, `test/git-sync-client.test.ts`) does not.
   `OkRepo` is exported at `GitParts.tsx:18` and imported by GitTable/GitTriage; `ChatDrawer` default-exports `{ session, onClose, spawnAvailable }`
   (`ChatDrawer.tsx:99-103`) and is lazy in `SessionsView.tsx:23`, keyed by id at `:175`; `useSessions()` has one caller (`SessionsView.tsx:41`);
   `useGitStats().refresh` exists (`useGitStats.ts:66-67`); `.git-head` is `flex-wrap` (`styles.css:2616`); `.git-band-off` exists (`:2606`);
   `git-stats-client` is registered in `test/run-all.ts:77,171`; `okRepo` builder at `test/git-stats-client.test.ts:28`; spawn.md sections named at
   lines 230, 277, 475, 509 all exist; the SpawnPanel preselect is `auto` when allowed else the ceiling, remote control `true`
   (`SpawnPanel.tsx:83,95`) as line 81 states. Line 265's "table" is M1.
4. **Interfaces.** Task 3 consumes Task 2's names with the same spelling; Task 4 consumes `GitSyncControl` as produced. `SyncRun.name` is I4; `Settings` is M3.
5. **Order.** Tasks are in dependency order; no forward references except `gitSyncRuns.ts`'s conditional existence (M4).
6. **Tests.** Task 1 C1-C4, Task 2 (import failure, then each case), Task 3 Q1/H1-H6 all fail before implementation and pin behaviour. Review Focus 1 →
   P5/P6, 3 → R4/R5, 4 → S1-S5, 5 → P8/H3 each have a test; Focus 2's "neither can start a second one" is hook logic with only the Task 4 manual check,
   which the plan says. R1 passes against behaviour that never ships (C1). Task 4 is UI with a live check and says so.
7. **Conventions.** The plan's own override (behaviour, not code) is followed throughout; size budgets are soft as stated; 160-column wrap holds.
