# Review 1 — `docs/superpowers/specs/2026-11-09-routines-per-machine-design.md`

Reviewer: Fable 5.1 subagent, 2026-11-09. Checklist: facts vs code, internal consistency, edge cases, copy, scope, CLAUDE.md rules. Every code claim
below was read in the worktree at `6751659`; `<doc>` is the spec.

## Verdict

**APPROVE WITH FIXES.** The design is sound and every structural claim (parser keys, launchd rule, `onThisMachine`, the 409, `routineSummary`, the
wrapper's `dirname(this.dir)` cwd, the owner rule, reconcile's prefix-based installed set, the run log's free-string `why`, the docs sections, the test
files) checks out against the code and against this Mac's `~/claude-global/schedules` (8 files, all with `machines:`, none lacking both `cwd:` and
`foreach:`). The fixes are one contradiction about the import trigger, one unhandled edge case that makes the import throw, a rollout order that creates
the gap it claims to avoid, three false facts, and user-facing copy the spec does not name for removal.

## Critical

None.

## Important

1. **`<doc>:87-88` vs `<doc>:77` and `<doc>:123-125` — the import trigger is stated two ways.** Line 88 says the temp-then-rename keeps "the folder does
   not exist" trigger true for the next start; lines 77 and 123 say the trigger is the marker, which is written *after* the rename. An implementer must
   guess whether both conditions gate the import. → Delete the parenthetical at line 88 (the marker is the trigger) and state the rule in §The import once.

2. **`<doc>:87-88`, `<doc>:123-125` — no rule for `jobs/` already existing while the marker is absent.** The spec orders rename → marker, so a crash between
   the two (or a marker the user removed) leaves `jobs/` present and the marker absent; `fs.renameSync(tmp, jobs)` onto a non-empty directory throws
   `ENOTEMPTY` on POSIX, so every later start logs "import failed" and never writes the marker. → State what happens: either "if `jobs/` exists, write the
   marker (`count: 0`, `from: null`) and skip", or move files one by one without overwriting. Add the case to the test list at `<doc>:102-104`.

3. **`<doc>:94-95` — the stated rollout order (`plugin:sync` before the restart) creates the gap the paragraph says cannot happen.** Between `plugin:sync`
   and the owner restart, the *old* server's plists (`ROUTINES_DIR` baked to the old folder, `server/lib/routine-config.ts:134`) fire the *new* wrapper,
   whose `parseJob` now rejects `machines:` (`<doc>:55-57`), so every scheduled fire in that window is refused `invalid: <line>: …`
   (`plugin/lib/run-routine.mjs:152-153`). The paragraph only covers the opposite pairing (old wrapper, new files). → Either order it merge → restart the
   owner (import disables everything, reconcile removes the OS jobs) → `plugin:sync` → re-enable, where nothing scheduled ever meets a mismatched
   wrapper, or name this second gap and accept it.

4. **`<doc>:51` — "created with owner-only permissions, as the routines folder is today" is false.** The routines folder is created by `writeJob`
   with `fs.mkdirSync(dir, { recursive: true })` and no mode (`server/lib/routine-store.ts:65`); `claimOwner`'s state-root mkdir has none either
   (`server/lib/routine-store.ts:237`); no `0o700` exists under `server/` (the only `chmodSync` is the plist/cron-env file at
   `server/lib/routine-reconcile.ts:381`). → Either drop the clause (the folder follows the umask like today) or state owner-only as a *new* requirement
   with the mode (`0o700`) and a test.

5. **`<doc>:59` — "the client (which knows `ctl.machine`) … pass[es] their own" is false: the client never calls `parseJob`.** The drawer validates through
   `POST /api/routines/validate` (`client/src/components/routines/JobDrawer.tsx:78`); the client imports only `serializeEnabled`, `JobError`,
   `LABEL_PREFIX`, `NAME_RE`, `RESERVED`, `DEFAULT_TIMEOUT_MS`, `TIMEOUT_RE` from `shared/routine-file` (grep `parseJob` in `client/src`: no hit). Harmless
   in outcome (the server's machine is the one the drawer validates against) but it sends the builder hunting for a call site. → Say: the server (routes and
   `/validate`) and the wrapper each pass their own machine; the client has no call.

6. **`<doc>:63-65` — existing user-facing copy that becomes false is not named.** `client/src/components/routines/RoutinesView.tsx:126-127` reads
   "Files sync through git; each machine installs only the jobs that name it" and is neither a chip, a pill, a template nor the Machines section.
   `client/src/lib/routines.ts:322` maps `not-this-machine` to "the job is not set to run on this machine (its machines: line)". → Add both to the UI
   bullet (replace the subtitle sentence; drop the conflict copy with the conflict).

7. **`<doc>:70-71` — the default-cwd copy change is scoped to "server display and wrapper alike", but the copy also lives in the client and docs.**
   `client/src/components/routines/JobRows.tsx:94` ("Empty = the routines folder's parent"), `client/src/lib/routines.ts:247` (template comment
   `default = the routines folder's parent`), `client/src/lib/routines.ts:224` (JSDoc), `docs/subsystems/routines.md:76` (format table). Only the
   templates and the docs table are named elsewhere (`<doc>:99-100`); the hint at `JobRows.tsx:94` is not. → List the hint, and say the new wording
   ("your home folder" or equivalent) once so all five agree.

8. **`<doc>:101-102` — the test list misses `test/plugin-manifest.test.ts`, which will fail as written.** Its plain-node smoke test parses a fixture with
   `machines: [mac]` and asserts `errors: []` (`test/plugin-manifest.test.ts:80-84`); under `<doc>:55-57` that line is now an error. If `parseJob` grows a
   machine parameter (`<doc>:59`), the call at line 81 needs it too. → Add `plugin-manifest` to the list.

## Minor

- `<doc>:100` "`.env.example` if it names `ROUTINES_DIR`" — it does (`.env.example:155`, `# ROUTINES_DIR=~/claude-global/routines`); say "does".
- `<doc>:99` names the docs sections to touch but not the intro sentence `docs/subsystems/routines.md:3` ("a folder that syncs through git (default
  `~/claude-global/routines/`)") nor the rename table row `docs/subsystems/routines.md:24` (the `orLegacy` jobs-folder fallback, which this spec removes).
- `<doc>:111-112` "Server and wrapper already resolve the state root the same way" — the wrapper has no `ROUTINES_STATE_ROOT` (grep in
  `plugin/lib/run-routine.mjs`: no hit); under the seam the server never owns (`server/lib/routine-store.ts:234`, `{ ownedBy: 'seam' }`) and the wrapper
  always receives a baked `ROUTINES_DIR`, so nothing breaks, but the sentence should be "resolve it the same way outside the seam". Consequence for the
  builder: an import test cannot go through `startRoutines` with the seam set; it drives the import function directly or fakes `claimOwner` as
  `test/routine-boot.test.ts:47` already does.
- `<doc>:95` the refusal text is `invalid: 0: machines is required` (`plugin/lib/run-routine.mjs:153` prefixes `invalid: <line>:`; `shared/routine-file.ts:148`
  pushes it at line 0), and only when no cron error precedes it in `errors[0]`.
- `<doc>:115` overlap guard "skipped (and logged)" — say whether the marker is written then; otherwise the skip re-logs on every start.
- `<doc>:123` marker `{at, from, count}` — give `from`'s value when no old folder existed (`null`?), since the test at `<doc>:104` asserts `count: 0`.
- `<doc>:81` "per `*.md` file" — say dotfiles are skipped as `readJobs` does (`server/lib/routine-store.ts:42`), so a leftover `.name.pid.tmp` or `.DS_Store`
  is not copied.
- `<doc>:59` client fallback: `RoutinesView.tsx:75` reads `data?.machine ?? 'mac'`; irrelevant once finding 5 lands.
- `<doc>:101` `test/routine-notify.test.ts:29` also carries `routinesDir: '~/claude-global/routines'`; still valid as an explicit value, no change needed,
  but worth knowing it is not in the list for a reason.
- `<doc>:7-8` verified on this Mac: `~/claude-global/schedules` exists, `~/claude-global/routines` does not, all 8 files carry `machines:`; 1 has `cwd:`,
  7 have `foreach:`, so the `cwd:` insertion touches none of them here.

## Verified true (no finding)

`KNOWN`/`LIST_KEYS` hold `machines` (`shared/routine-file.ts:25-28`); the launchd rule keys on `machines?.includes('mac')` (`:159`); the generic error is
`unknown key machines` (`:98`); `serializeEnabled` inserts after `run` (`:253-254`); `writeFrontmatterLine` keeps CR and returns unfenced text unchanged
(`shared/frontmatter.ts:89-93,104`); `onThisMachine` on `RoutineJobRow` (`shared/types.ts:2351`), `not-this-machine` in `RoutineRunConflict` (`:2331`)
and `routine-run.ts:108`; `routineSummary` joins `job.machines` (`server/api.ts:1774`); wrapper cwd default `path.dirname(this.dir)`
(`plugin/lib/run-routine.mjs:208`), `orLegacy` jobs fallback (`:126-127`), `not this machine` (`:154`), run log `runs/<machine>.jsonl` (`:129`);
reconcile desired set filters by `machines` (`server/lib/routine-reconcile.ts:217`) and the installed set is prefix-based plist files / the crontab marker
block (`:286-305`); run-log `why` is a free string (`server/lib/routine-log.ts:68-74`); `src()` reads `process.env` then `.env` (`server/lib/config.ts:329`);
`routinesDir` default pinned at `test/routine-config.test.ts:126`; writes are owner-only (`server/api.ts:1749`); boot order and `step` wrapper
(`server/lib/routine-boot.ts:114-152`); all ten listed test files and the visual fixture exist; the six docs sections exist. No CLAUDE.md rule is touched
beyond the ones the spec already follows (`shared/types.ts` first, `plugin:gen` after `routine-file.ts`, class names kept, `backlog/` untouched).
