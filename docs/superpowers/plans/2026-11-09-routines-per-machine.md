# Routines per machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures and exact test cases, never literal code bodies (user's global rule,
> 2026-08-16). Where a step names a value, use that value; everything else is the implementer's call, and the implementer may disagree with the plan.

**Goal:** Routine jobs belong to one machine: files move to `<state root>/jobs`, the `machines:` key disappears, and old shared files are imported once,
disabled.

**Architecture:** One removal (the `machines` concept, across `shared/`, server, wrapper and client), one relocation (the jobs folder default and the default
`cwd`), one new server module (`server/lib/routine-import.ts`) wired into the owner's boot, then docs.

**Tech Stack:** TypeScript (server via tsx, client via Vite/React), plain-JS plugin wrapper, node-assert tests (`test/*.test.ts`, each with a `run()` and a
main guard, registered in `test/run-all.ts`).

**Spec:** `docs/superpowers/specs/2026-11-09-routines-per-machine-design.md`

## Global Constraints

- Server keeps zero new deps; Node built-ins only. No new outbound kind (`test/outbound.test.ts`).
- `shared/routine-file.ts` changes need `pnpm plugin:gen` so `plugin/lib/routine-file.mjs` matches (`test/plugin-manifest.test.ts`).
- Keep CSS class names stable; no hardcoded colours. Removing elements is fine; renaming classes is not.
- New text wraps at 160 columns. Commit bodies at 72. Commit each task with `git add <paths>` then `git commit` (never `-A`).
- Run only the suites a task touches (`npx tsx test/<name>.test.ts`) plus `pnpm typecheck`. Never run the whole `pnpm test` locally before push (CI does).
- Never touch `~/claude-global`, `~/.claude/routines` or the user's crontab/LaunchAgents from tests: every test uses tmpdirs and the existing host seams.

## Review Focus

1. A job file still carrying `machines:` (copied by hand from the other machine) → parse error naming that line, not a silent pass and not a crash.
2. Owner restarts after a crash between the import's rename and its marker write → no throw, marker written with `count: 0`, nothing copied twice.
3. Old folder holds a non-`.md` file, a subfolder, or a dotfile temp from an earlier save → ignored by the import, exactly as `readJobs` ignores them.
4. An imported job with `foreach:` keeps no added `cwd:`; one with an explicit `cwd:` keeps its own value unchanged.
5. A WSL user who set `ROUTINES_DIR` in `.env` → no import, folder honoured verbatim, wrapper gets the same path baked.

Each has a test in the owning task below.

---

### Task 1: Drop `machines` from the job format and the contract

**Files:**
- Modify: `shared/routine-file.ts` (KNOWN, LIST_KEYS, the machines block ~137-148, the launchd rule ~158-162, `parseJob` signature, the returned job)
- Modify: `shared/types.ts:2242` (`RoutineJob.machines`), `:2331` (`RoutineRunConflict`), `:2350-2351` (`RoutineJobRow.onThisMachine`)
- Regenerate: `plugin/lib/routine-file.mjs` (`pnpm plugin:gen`)
- Modify: `server/lib/routine-store.ts:37,53` (`readJobs`), every `readJobs` caller (`server/api.ts` 1799/1840/1858/1870/1892/1927, `routine-reconcile.ts:264`,
  `routine-boot.ts:72`, `routine-run.ts:103`), `server/api.ts:1761,1938` (`parseJob` callers), `:1774` (summary), `:1808-1809` (row)
- Modify: `server/lib/routine-reconcile.ts:217` (drop the `not this machine` reason), `server/lib/routine-run.ts:107-108` (drop the 409)
- Modify: `plugin/lib/run-routine.mjs:152-154` (pass machine to `parseJob`, drop the refusal)
- Modify (compile fixes only): `client/src/components/routines/JobMenu.tsx:12`, `JobFold.tsx:72`, `RunsList.tsx:118`, `JobLedger.tsx:63,104-109`,
  `client/src/lib/routines.ts:104-122` (the `<machines> only` pill branch) and `:322` (the `not-this-machine` message)
- Test: `test/routine-file.test.ts`, `test/plugin-manifest.test.ts:80-84`, `test/routine-store.test.ts`, `test/routine-reconcile.test.ts`, `test/routine-run.test.ts`,
  `test/run-routine.test.ts` (fixture lines 70/74, refusal matrix 420-425), `test/api-routines.test.ts`, `test/routines-view.test.ts`, `test/routine-boot.test.ts`

**Interfaces:**
- Produces: `parseJob(name: string, text: string, machine: 'mac' | 'wsl'): ParsedJob` — machine is **required**, so the compiler finds every caller.
- Produces: `readJobs(dir: string, machine: 'mac' | 'wsl'): StoredJob[]`. Server callers pass `machineName(config).name`.
- Produces: `RoutineJob` without `machines`; `RoutineJobRow` without `onThisMachine`; `RoutineRunConflict = 'already-running' | 'no-plugin' | 'invalid'`.

- [ ] **Step 1: Write the failing tests in `test/routine-file.test.ts`**
  - `a file with machines: is an error on that line`: text with `machines: [mac]` on frontmatter line 3 → `job === null`, one error `{line: 3}` whose message
    contains `machines` and `no longer used`. Same for a block-list form (`machines:` then `  - mac`): the error is on the `machines:` line.
  - `a file without machines: parses`: `cron: "0 9 * * *"`, `run: claude`, body `/git-sync` → no errors, `job` has no `machines` property
    (`'machines' in job === false`).
  - `launchd rule follows the validating machine`: cron `0 9 1 * 1` (day-of-month and weekday) → on `'mac'` one error containing
    `launchd cannot combine day-of-month and weekday`; on `'wsl'` no errors. `manual` cron on `'mac'` → no error.
  - Rewrite every existing case in that file to drop its `machines:` line and pass a machine (use `'mac'` unless the case is about the launchd rule).
  - `test/plugin-manifest.test.ts:80-84`: drop `machines: [mac]` from the smoke fixture and call `parseJob('tiny', file, 'mac')`; still expects
    `{errors: [], cron: '0 9 * * *'}`.
- [ ] **Step 2: Run** `npx tsx test/routine-file.test.ts` → the new cases FAIL (`machines` still known; signature takes two args).
- [ ] **Step 3: Implement in `shared/routine-file.ts`.** `machines` leaves KNOWN and LIST_KEYS; a `machines` key is caught **before** the generic unknown-key
  error with the message `machines: no longer used — a job runs on the machine whose folder holds it; delete this line`. The launchd rule's condition becomes
  `machine === 'mac'`. Then `pnpm plugin:gen`.
- [ ] **Step 4: Run** `npx tsx test/routine-file.test.ts` and `npx tsx test/plugin-manifest.test.ts` → PASS.
- [ ] **Step 5: Update types and every consumer** listed under Files. Server: `serveRoutines` row loses `onThisMachine`; `desired` is `s.job !== null &&
  scheduled(s.job)`; `routineSummary` drops the machines segment. Reconcile: `notDesired` loses its `not this machine` line. Run: the `not-this-machine` 409 goes.
  Wrapper: `parseJob(this.job, text, this.machine)`; the `not this machine` refusal goes (run-log readers still accept old records with that `why` — they
  read `why` as a string, verify no enum narrows it). Client: every `row.onThisMachine` guard is dropped (true by construction); the ledger's machine chips
  (`.rtn-mach`) and the `<machines> only` pill branch go; `writeFailureText`'s `not-this-machine` entry goes.
- [ ] **Step 6: Update the fixtures** in every test file under Files: drop `machines:` lines from job texts, pass a machine to `readJobs`/`parseJob`, delete
  the `not this machine` / `not-this-machine` cases (`test/run-routine.test.ts:422,425,754`, `test/routine-run.test.ts:315`,
  `test/routines-view.test.ts:340`), and drop `onThisMachine` from row fixtures. `test/routine-reconcile.test.ts:345` combines a wsl-only file with a deleted
  file: keep only the deleted-file half (an installed label with no file behind it → `remove`), which is the spec's orphan case.
  Add to `test/run-routine.test.ts`: `a file still carrying machines: is refused invalid` → `refused` record, `why` starts with `invalid: ` and contains
  `machines`.
- [ ] **Step 7: Run** `pnpm typecheck` → clean; then each test file under Files with `npx tsx` → all PASS.
- [ ] **Step 8: Commit** `refactor(routines): drop the machines key — a job runs where its file lives`.

### Task 2: Editor drawer and page copy without machines

**Files:**
- Modify: `client/src/lib/routineForm.ts:17,53,190,205-217,535-547` (the `machines` FieldId, KEY_ORDER entry, kinds row, FieldDef, field map)
- Modify: `client/src/components/routines/JobRows.tsx:45` (the Machines section's hint) and `:259` (`MachinesControl` case), plus `MachinesControl` itself
- Modify: `client/src/lib/routines.ts:244,273-274` (the new-job templates' `machines:` lines and their comment)
- Modify: `client/src/components/routines/RoutinesView.tsx:126-127` (the Jobs subtitle)
- Test: `test/routine-form.test.ts`, `test/routines-view.test.ts`

**Interfaces:**
- Consumes: Task 1's `RoutineJob` (no `machines`).
- Produces: `FieldId` without `'machines'`.

- [ ] **Step 1: Write the failing tests.**
  - `routine-form`: `no Machines field` — the field list for both run kinds has no entry with id `machines`; `KEY_ORDER`-driven insertion of `cwd` into a
    template lands after `run:`/`foreach:` as before (existing cases keep passing once their texts lose `machines:`).
  - `routine-form`: `every new-job template parses on mac and wsl` — each template text from `client/src/lib/routines.ts` gives `errors: []` from
    `parseJob(name, text, 'mac')` and `'wsl'` (fails today on the `machines:` line under Task 1's parser).
  - `routines-view`: the Jobs subtitle reads `Jobs defined in <dir>, run by launchd on this machine. They belong to this machine only — nothing syncs.`
    (`cron` in place of `launchd` when `machine` is `wsl`), and contains no `sync through git`.
- [ ] **Step 2: Run** both files with `npx tsx` → FAIL.
- [ ] **Step 3: Implement.** Remove the Machines field everywhere listed; drop `machines:` lines (and their comment line) from both templates; set the
  subtitle copy above exactly. Leave `.rtn-*` class names of surviving elements untouched.
- [ ] **Step 4: Run** both files and `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `refactor(routines): remove the Machines section from the job drawer`.

### Task 3: Jobs folder under the state root; default cwd is home

**Files:**
- Modify: `server/lib/config.ts:135-136,173,363` (`routinesDir` is `''` when neither `ROUTINES_DIR` nor `SCHEDULES_DIR` is set; drop the default)
- Modify: `server/lib/routine-config.ts:42-50,103-115` (`DEFAULT_ROUTINES_DIR`, `LEGACY_ROUTINES_DIR` become import-source constants; `routineDirs`)
- Modify: `plugin/lib/run-routine.mjs:126-128` (jobs dir default) and `:208` (default cwd)
- Modify: `server/api.ts:1773` (summary fallback), `client/src/components/routines/JobRows.tsx:94` (Repos hint), `client/src/lib/routines.ts:224,247`
- Modify: `.env.example:150-155`
- Test: `test/routine-config.test.ts`, `test/run-routine.test.ts`, `test/api-routines.test.ts`

**Interfaces:**
- Produces: `routineDirs(config, host)` returns `{ routines, state, runs, locks, launchd }` where `routines` is `expandHome(config.routinesDir)` when set, else
  `path.join(state, 'jobs')`. No `orLegacy` on `routines`.
- Produces: `export const OLD_SHARED_DIRS = ['~/claude-global/routines', '~/claude-global/schedules']` (or equivalent named export) in `routine-config.ts`,
  for Task 4 — the old default and its legacy name, in preference order.

- [ ] **Step 1: Write the failing tests.**
  - `routine-config`: unset env → `loadConfig` gives `routinesDir === ''`; `routineDirs` with home `/h` and no state-root override → `routines ===
    '/h/.claude/routines/jobs'`; with only `/h/.claude/schedules` existing (legacy state) → `'/h/.claude/schedules/jobs'`; with `routinesStateRoot: '/seam'`
    → `'/seam/jobs'`; with `ROUTINES_DIR=~/claude-global/routines` → `'/h/claude-global/routines'` even when `/h/claude-global/schedules` alone exists (no
    fallback); `SCHEDULES_DIR=/x` alone → `'/x'`. Update the existing cases at :126-134 to these values.
  - `routine-config`: `routineEnv(...).ROUTINES_DIR` equals `routineDirs(...).routines` in the unset and set cases.
  - `run-routine`: with `ROUTINES_DIR` unset in the wrapper's env and `HOME` a tmpdir, a job file at `$HOME/.claude/routines/jobs/<job>.md` is the one run;
    a job with neither `cwd:` nor `foreach:` gets its `step-start` `cwd === $HOME` (not the jobs folder's parent).
  - `api-routines`: `POST /api/routines/validate` on a job with neither key → `summary` ends `· your home folder`.
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement** per Interfaces. Wrapper: `this.dir` is `ROUTINES_DIR || SCHEDULES_DIR` when set, else `path.join(this.state, 'jobs')` — `this.state`
  must be computed first. Default cwd `home()`. Copy: server summary fallback `your home folder`; JobRows hint `Empty = your home folder.`; the two
  `client/src/lib/routines.ts` comments say `default = your home folder` / `the default (your home folder)`. `.env.example` comment:
  `# Folder of this machine's job files (one .md per job). Unset = <state root>/jobs, i.e. ~/.claude/routines/jobs. Never synced.` and
  `# ROUTINES_DIR=~/.claude/routines/jobs`.
- [ ] **Step 4: Run** the three files and `pnpm typecheck` → PASS. Run `npx tsx test/routine-store.test.ts` and `test/routine-boot.test.ts` (they build
  configs with `routinesDir`) → PASS.
- [ ] **Step 5: Commit** `feat(routines): keep job files under the machine's own state root`.

### Task 4: One-time import of the old shared folder

**Files:**
- Create: `server/lib/routine-import.ts`
- Modify: `server/lib/routine-boot.ts:19-40` (`RoutineDeps` + `defaultDeps`), `:124-135` (call it after the claim, before the lock sweep)
- Create: `test/routine-import.test.ts`; register its `run` in `test/run-all.ts`
- Modify: `test/routine-boot.test.ts` (order and failure isolation)

**Interfaces:**
- Consumes: Task 3's `routineDirs`, the old-dir constant; `serializeEnabled` (`shared/routine-file.ts`), `writeFrontmatterLine` (`shared/frontmatter.ts`).
- Produces: `importSharedJobs(config: Config, host?: Partial<RoutineHost>): ImportResult` where
  `ImportResult = { state: 'imported', from: string, count: number } | { state: 'skipped', why: 'explicit-dir' | 'done' | 'overlap' | 'jobs-exist' | 'no-old' }`.
  `'no-old'` and `'jobs-exist'` still write the marker (`count: 0`) and, for `'no-old'`, create the empty jobs folder.
- Produces: `rewriteImported(text: string, oldParentTilde: string): string` (exported for tests) — the three text edits.
- Produces: marker `<state root>/jobs-imported.json` = `{ at: ISO string, from: string | null, count: number }`.

- [ ] **Step 1: Write the failing tests in `test/routine-import.test.ts`** (tmp home via the host seam; no real home touched):
  - `rewriteImported`:
    - `machines: [mac, wsl]          # comment` line removed; `enabled: true` becomes `enabled: false` with its trailing comment kept; no `cwd:`/`foreach:`
      → `cwd: ~/claude-global` inserted; every other line byte-identical (assert full expected text).
    - block-list `machines:` + `  - mac` + `  - wsl` → all three lines removed, the next key untouched.
    - `foreach: pinned` present → no `cwd:` added. `cwd: ~/x` present → stays `~/x`.
    - no `enabled:` line → `enabled: false` inserted after `run:`.
    - CRLF file → output still CRLF on every line.
    - unparseable file (`run: bogus`) → the same edits apply; output is still unparseable only for `run`.
    - text with no frontmatter → returned unchanged.
  - `importSharedJobs`:
    - `imports every .md disabled`: old `~/claude-global/routines` with `a.md` (enabled, mac+wsl) and `b.md` (disabled, wsl) → state `imported`, `count: 2`,
      `jobs/a.md` and `jobs/b.md` parse on `'mac'` with `enabled: false`; marker `{from: '<home>/claude-global/routines', count: 2}`.
    - `falls back to the legacy schedules folder`: only `~/claude-global/schedules` exists → imported from it.
    - `prefers routines over schedules` when both exist.
    - `ignores non-.md files, subfolders and dotfiles` (`notes.txt`, `sub/`, `.x.123.tmp`) → `count` counts only `.md`.
    - `leaves the old folder byte-identical` (compare a recursive listing with contents before/after).
    - `runs once`: second call → `{state: 'skipped', why: 'done'}`; delete `jobs/a.md`, call again → still `done`, `a.md` not back; delete `jobs/` entirely,
      call again → still `done`.
    - `explicit ROUTINES_DIR`: `config.routinesDir = '~/claude-global/routines'` → `explicit-dir`, no marker, no `jobs/`.
    - `no old folder`: → `no-old`, empty `jobs/` exists, marker `count: 0`.
    - `jobs/ exists without marker`: pre-made `jobs/` with `z.md` → `jobs-exist`, marker `count: 0`, `z.md` untouched, nothing copied.
    - `crash mid-import leaves no jobs/`: inject a failing write on the 2nd file (host seam or a read-only file trick) → throws; `jobs/` absent; marker absent;
      the next call (failure removed) cleans the leftover temp folder and imports both.
    - `overlap`: state root override such that `<state>/jobs` equals or is inside the old folder → `overlap`, nothing written.
- [ ] **Step 2: Run** `npx tsx test/routine-import.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `server/lib/routine-import.ts`.** Order: explicit-dir check → marker check → overlap check → jobs-exist check → resolve old folder
  (first existing of the two constants) → copy into `<state>/.jobs-import.tmp` (removed first if left over) → `renameSync` to `jobs/` → write marker. Old
  folder's parent written with `~` when it is under home. Uses only `node:fs`/`node:path`.
- [ ] **Step 4: Wire into boot.** `RoutineDeps` gains `importSharedJobs`; `startRoutines` runs `step('job import', …)` immediately after the claim succeeds and
  before `lock sweep`, logging `[dashboard] routines: imported <n> job(s) from <from>, all disabled` on `imported` (nothing on `skipped`). Tests in
  `test/routine-boot.test.ts`: `import runs after the claim and before the lock sweep` (record call order with stub deps); `a throwing import still runs
  the reconcile`; `a non-owner never imports`.
- [ ] **Step 5: Run** `npx tsx test/routine-import.test.ts`, `npx tsx test/routine-boot.test.ts`, `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `feat(routines): import the old shared job folder once, every job disabled`.

### Task 5: Docs and visual fixture

**Files:**
- Modify: `docs/subsystems/routines.md` (intro :3-4, Renamed section :16-34 incl. the rollout order line, layout table :39-47 adds `jobs/` and
  `jobs-imported.json`, format table :60/:73 drops `machines`, :83 launchd rule wording, Machine identity :91-96, reconcile desired set :118-120, wrapper
  refusals :182 and :218, run conflicts :280, page section :302, docs-sync stamp block at the end), `docs/overview.md:62` and the `routine-*` map lines
  (add `routine-import.ts`)
- Modify: `test/visual/fixtures/routines.ts` (drop `machines` / `onThisMachine`)

- [ ] **Step 1: Update the docs** to describe exactly what Tasks 1-4 built: jobs live in `<state root>/jobs`, never synced; no `machines:`; the import and
  its marker; default cwd home; the new rollout order — merge, restart the owner, then `pnpm plugin:sync`, then re-enable jobs (spec §Rollout order). Add a
  short "Per machine since 2026-11-09" note in the Renamed section replacing the `~/claude-global/routines` fallback row.
- [ ] **Step 2: Update the visual fixture**; run `pnpm typecheck` → clean; run
  `grep -rn "machines:\|onThisMachine\|not-this-machine\|claude-global/routines" docs/subsystems/routines.md docs/overview.md client/src server shared plugin/lib/run-routine.mjs test`
  → only hits that describe the removed key as no longer used, the import-source constant and its tests, and the Renamed-section history.
- [ ] **Step 3: Commit** `docs(routines): jobs are per machine`.

### Task 6: UI check

- [ ] **Step 1:** Invoke `/ui-verify` against the Routines Jobs page and the job drawer (no mocks: the reference is the spec's UI bullets). Check: no Machines
  section, no machine chips, the new subtitle, the Repos hint, and no overflow at 1440 px and phone width. Fix defects on the branch.
