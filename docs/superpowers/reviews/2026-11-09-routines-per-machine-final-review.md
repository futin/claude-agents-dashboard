# Routines per machine — final whole-branch review

Range `2fd42a1..d4fc547` (14 commits). Binding spec `docs/superpowers/specs/2026-11-09-routines-per-machine-design.md`, plan
`docs/superpowers/plans/2026-11-09-routines-per-machine.md`. Reviewed in one pass per boundary: server + shared + plugin, then client, then tests, then
docs/subsystems + docs/overview + `.env.example`. PNG hunks and the spec/plan/review docs were skipped as instructed.

Verification run here (read-only):

- `pnpm typecheck` — clean (`tsc --noEmit`, exit 0).
- `npx tsx test/<name>.test.ts`: routine-import 19/19, routine-config 26/26, routine-boot 13/13, routine-file 44/44, plugin-manifest 11/11 (includes the
  `pnpm plugin:gen` parity check, so `plugin/lib/routine-file.mjs` matches `shared/routine-file.ts`), run-routine 54/54, routine-reconcile 44/44.
- Not run: full `pnpm test`, the visual suite, `pnpm test:skills`.

## Strengths

- The jobs folder is resolved once on each side and the two cannot drift for an installed job: `routineDirs` (`server/lib/routine-config.ts:106`) is
  `ROUTINES_DIR` verbatim or `<state>/jobs`, and `routineEnv` (`:131`) bakes that resolved path into every plist, crontab line and `/run` spawn, so the
  wrapper's own default (`plugin/lib/run-routine.mjs:127-128`, `<state>/jobs` with the same `orLegacy` state root) only matters for a hand-run wrapper.
  `test/routine-config.test.ts` pins `routineEnv().ROUTINES_DIR === routineDirs().routines` for set and unset.
- Default cwd agrees: wrapper `home()` (`run-routine.mjs:207`), server summary "your home folder" (`server/api.ts:1773`), drawer hint, template comment and
  docs. The wrapper test would fail on revert (fixture dir is `~/claude-global/routines`, whose parent is not `$HOME`).
- Import is well-shaped: owner-only (it runs after `claim !== 'owner'` returns, `routine-boot.ts:131-138`), marker-first skip, temp-folder-then-rename,
  marker written last, never writes under the old folder, `enabled: false` through `serializeEnabled`. The crash test genuinely provokes a mid-copy failure
  (chmod 000) and proves the retry cleans the temp folder. The "old folder byte-identical" and "runs once after delete / after rmdir" tests are real.
- `parseJob(name, text, machine)` keeps the launchd rule on the validating machine; `test/routine-file.test.ts:251-252` proves mac rejects and wsl accepts
  the same text. The leftover-`machines:` error is explicit and tested inline and block form, server and wrapper.
- Run-log reader is `why`-agnostic (`routine-log.ts:68`), so old `refused · not this machine` records still fold.
- No leftover `onThisMachine`, `not-this-machine`, `job.machines` or `RoutineRunConflict` member anywhere in server, client, shared, plugin or scripts
  (grep across all five).

## Issues

### Critical

1. **The import never runs on this Mac, and every existing job turns invalid, because the live `.env` sets `SCHEDULES_DIR`.**
   - `server/lib/routine-import.ts:60` (`if (config.routinesDir) return … 'explicit-dir'`), `server/lib/config.ts:363`, `server/lib/routine-boot.ts:139-141`
     (explicit-dir is not logged), `docs/subsystems/routines.md:55` (rollout order has no `.env` step).
   - Evidence: the main checkout's `.env:67` is `SCHEDULES_DIR=~/claude-global/schedules` (and `SCHEDULES_OWNER=true` at `:75`);
     `~/claude-global/schedules` exists, `~/claude-global/routines` does not.
   - What happens after merge + restart, following the documented rollout exactly: `routinesDir` is non-empty, so the import returns `explicit-dir`
     silently; the server keeps reading the git-synced folder; every file there still has `machines:`, which is now a parse error; reconcile treats every job
     as `invalid` and removes every installed OS job; the ledger shows every row red; nothing is imported and no log line says why. The same `.env` is
     likely on the WSL machine. Spec Settled #2 deliberately made "any set value, including one pointing at `~/claude-global/routines`" explicit, so the
     code follows the spec — this is a spec gap that the real deployment hits on its first restart, and it defeats the spec's first Goal.
   - Fix (pick one, smallest first): (a) add a rollout step "delete `ROUTINES_DIR` / `SCHEDULES_DIR` from `.env` if it names `~/claude-global/…`, then
     restart", **and** log the `explicit-dir` skip when the explicit folder resolves to one of `OLD_SHARED_DIRS`, so the miss is visible; or (b) treat a set
     value that expands to an `OLD_SHARED_DIRS` entry as unset (import + `<state>/jobs`), with a one-line log telling the user to remove it — this needs a
     spec amendment to Settled #2. Either way, tell the user before merge that their `.env` line must go.

### Important

1. **`docs/workflows/configuration.md:48-49` still documents the old world.** `ROUTINES_DIR` default is listed as `~/claude-global/routines`, and
   `ROUTINE_MACHINE` says "a job installs only where its `machines:` names it". This is the `.env` reference a user copies from; setting the documented
   "default" disables the import (see Critical 1). Fix: default `_(empty)_ = <state root>/jobs (~/.claude/routines/jobs)`, per machine, a set value skips
   the import; drop the `machines:` clause from `ROUTINE_MACHINE` (it picks launchd vs cron, the log name and the launchd cron rule). Optionally add `jobs/`
   and `jobs-imported.json` to the `ROUTINES_STATE_ROOT` row's list (`:51`).

### Minor

1. `server/lib/routine-reconcile.ts:488` and `docs/subsystems/routines.md:194` still justify the folder debounce with "a `sync.sh pull` lands several
   files" — nothing syncs the folder now.
2. `server/lib/routine-import.ts:88`: `Dirent.isFile()` is false for a symlink, so a symlinked `*.md` job in the old folder is skipped silently (count does
   not include it). Use `fs.statSync` on the path, or at least note it.
3. `rewriteImported` (`routine-import.ts:36`) stops the block-list strip at the first non-`- item` line, so a comment between items leaves the remaining
   items as orphan indented lines (the file then fails to parse and is fixed in the drawer — acceptable, but untested).
4. No test pins that an old `refused` record with `why: 'not this machine'` still folds (spec asks readers to accept it). The reader is `why`-agnostic, so
   risk is low; a one-line fixture in `test/routine-log.test.ts` would lock it.
5. `test/routine-reconcile.test.ts:348`: `w.write('pull-pins', SHELL())` immediately followed by `fs.rmSync` of the same file is a dead write left from the
   removed `not this machine` half of the test.
6. The `overlap` skip writes no marker and logs on every boot; in practice unreachable for an owner (the only way to overlap is the `ROUTINES_STATE_ROOT`
   seam, under which `claimOwner` never returns `owner`), so the overlap test exercises a path production cannot reach. Harmless.
7. `jobsSubtitle` (`client/src/lib/routines.ts:239`) returns a plain string, so the folder path lost its `<code>` styling in the Jobs subtitle.
8. If the user deletes the whole `jobs/` folder after the import, the marker prevents re-creation and `startReconcileWatchers` has nothing to watch until
   the next restart (hand edits are missed; drawer writes still reconcile directly). Same class as an explicit missing `ROUTINES_DIR` before this branch.

## Seam checks (as asked)

1. **Jobs dir and default cwd, every env combination.** Neither set: server `<orLegacy state>/jobs`, wrapper same (identical `orLegacy`). `ROUTINES_DIR`
   or `SCHEDULES_DIR` set: both verbatim with `~` expansion (`config.ts:363`; wrapper `:126`). `ROUTINES_STATE_ROOT` set: server `<seam>/jobs`; the wrapper
   ignores the seam, but it always receives the baked `ROUTINES_DIR`, and a seam server is never an owner so it installs nothing. Legacy
   `~/.claude/schedules`: both sides resolve `~/.claude/schedules/jobs`; the import's `jobs/` and marker move with `migrateLegacyState`'s rename. Default
   cwd is `$HOME` on both sides (`HOME` is baked from the same `homeOf`). Agree in all cases.
2. **`routineEnv` and rollout.** `ROUTINES_DIR` is the resolved jobs folder (`routine-config.ts:131`). The spec's order (restart owner → import, all
   disabled, reconcile removes every old plist / crontab line → `plugin:sync` → re-enable) holds against the code, **except** when `.env` sets the folder
   (Critical 1). The gap before `plugin:sync` is only Run now, refused by the old wrapper (`machines is required`), as the spec says.
3. **Leftover readers.** None in server, client, shared, plugin or scripts. Docs: `docs/workflows/configuration.md:48-49` (Important 1). Nothing assumes
   `config.routinesDir` non-empty: every reader goes through `routineDirs`.
4. **Import + boot.** Owner-only, once (marker), crash-safe (temp + rename, marker last), never enables, reads the old folder only. Boot order matches spec
   Settled #8; a throwing import still runs the rest of boot (tested). Old `not this machine` records still parse (reader is string-agnostic; untested,
   Minor 4).
5. **Test quality.** The new tests would fail on revert: import tests on the module, boot order/log/non-owner/throw tests on `startRoutines`, wrapper
   cwd and `<state>/jobs` tests (fixture parent is not `$HOME`), launchd rule mac vs wsl, leftover `machines:` refused by the wrapper, `routineEnv` equals
   `routineDirs`. Gap: nothing would have caught Critical 1, since every config fixture is either empty or an arbitrary path.

## Declined to judge

- Whether `jobs-exist` should copy into an existing hand-made `jobs/` — the spec explicitly says no copy; left as specified.
- UI copy of the subtitle and the leftover-`machines:` error wording — spec leaves both to the builder.
- Visual baselines (PNG hunks) — skipped as instructed; ui-verify report exists on the branch.
- The wrapper ignoring `ROUTINES_STATE_ROOT` — pre-existing and documented ("the installed wrapper does not carry it").
- WSL machine's actual `.env` — not readable from here; flagged as likely in Critical 1.

## Recommendations

- Resolve Critical 1 before merge and say in the PR's *Unproven* row that the rollout was not exercised against the real `.env` / real
  `~/claude-global/schedules` folder.
- Add a config test with `SCHEDULES_DIR=~/claude-global/schedules` asserting whichever behaviour is chosen.

## Assessment

**Ready to merge: With fixes.**

The code is clean, consistent across server and wrapper, and well tested for the spec as written; but on the user's own machine the configured
`SCHEDULES_DIR` bypasses the import and turns every job invalid on the first restart, and the configuration reference still documents the old default.
