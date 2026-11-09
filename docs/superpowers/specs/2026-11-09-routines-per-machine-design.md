# Routines per machine — design

Date: 2026-11-09. Status: draft, awaiting approval.

## Intent

Routine job files live today in `~/claude-global/routines/` (on this Mac still its legacy name `~/claude-global/schedules/`), a folder that syncs between
the Mac and the WSL machine through the `claude-global` git repo. Each file carries `machines: [mac, wsl]` and one shared `enabled:` flag. In practice that
means toggling a job on one machine toggles it on the other after the next sync, every file needs a `machines:` list, and the user has to remember what is
enabled where. The jobs are also the app's own data kept outside the app's scope.

The user's words: syncing between machines is annoying, since I need to remember what I enabled where, and it makes no sense to be kept outside of the
app's scope.

**Each machine owns its own jobs.** A job file exists on one machine, runs on that machine, and its `enabled:` means "on this machine". Nothing syncs.

## Goals

- Job files live in a machine-local folder under the dashboard's existing state root: `~/.claude/routines/jobs/<name>.md`. Never under git.
- The `machines:` key is gone from the job format, the parser, the editor drawer, the ledger, the API types and the wrapper.
- On the first start of the new version, the owning server imports every file from the old shared folder into the new one, **each with `enabled: false`**,
  so the user re-enables, per machine, only what should run there (the user's pick, over "import only the ones naming this machine").
- Everything else about Routines keeps working as it does: the markdown format and its other keys, the editor drawer, reconcile against launchd / crontab,
  the run log, the owner rule, pushes, Run now / Stop.

## Non-goals

- No sync, export or copy-to-other-machine feature. A job wanted on both machines is created on both.
- No change to machine identity (`ROUTINE_MACHINE`, mac / wsl detection): it still picks launchd vs crontab, names the run log `runs/<machine>.jsonl`, and
  drives the launchd-only cron rule.
- No edits to the `claude-global` repo. Deleting `schedules/` (or `routines/`) from it, and any reference in its `sync.sh` / `bootstrap.sh`, is the user's
  follow-up once both machines have imported.
- No change to the job file format beyond dropping `machines:` (and the import adding `cwd:`, below).

## Anti-goals

- The import must never leave a job running that the user did not re-enable on this machine. All imported jobs arrive disabled; the next reconcile then
  removes every OS job the old files had installed. Briefly nothing runs — that is the intended state, not a regression.
- The import must never touch or delete the old folder. It reads it only.
- The import must run at most once per machine: a user who deletes an imported job must not see it come back on the next restart.

## Decisions

### Where the files live

- Default `ROUTINES_DIR` becomes `~/.claude/routines/jobs`. The state root (`~/.claude/routines/`, or `ROUTINES_STATE_ROOT`) does not change; the jobs folder
  is the default *inside* it only by default — `ROUTINES_DIR` stays an override, honoured verbatim, server and wrapper alike.
- The `orLegacy` fallback to `~/claude-global/routines` / `~/claude-global/schedules` for the **jobs folder** goes away on both sides (server
  `routine-config.ts`, wrapper `run-routine.mjs`). Those two paths survive only as import sources. The state-root `orLegacy` (`~/.claude/schedules`) and the
  `SCHEDULES_DIR` → `ROUTINES_DIR` env-name fallback are untouched.
- The folder is created with owner-only permissions, as the routines folder is today.

### The `machines:` key

- Removed from `KNOWN` / `LIST_KEYS` in `shared/routine-file.ts` and from `RoutineJob`. A file that still has it fails to parse with a message naming the
  line and saying the key is no longer used because every job runs on the machine that holds it (my call: an explicit error beats a silent ignore, since the
  drawer would otherwise keep writing it back, and beats the generic `unknown key machines`).
- The launchd rule ("cron: launchd cannot combine day-of-month and weekday") used to fire when `machines` named mac. It now fires when the machine doing the
  validation is mac. `parseJob` is shared and pure, so it takes the machine as an input; the server, the client (which knows `ctl.machine`) and the wrapper
  each pass their own. How it is threaded through is the builder's call.
- `onThisMachine` on `RoutineJobRow`, the `not-this-machine` run conflict (409), and the wrapper's `refused · not this machine` all go away: every job in the
  folder is on this machine. Run-log readers must still accept old `refused` records whose `why` is `not this machine`.
- The UI loses the Machines section of the editor drawer, the machine chips and `<machines> only` pill in the ledger, and the `machines:` lines in the new-job
  templates. The drawer and the ledger may say once, somewhere unobtrusive, that jobs here belong to this machine (`ctl.machine`); exact wording and place
  are the builder's call, following existing class names.
- The routine summary string (`routineSummary` in `server/api.ts`) drops its machines segment.

### Default working directory

A job with neither `cwd:` nor `foreach:` runs today in the routines folder's parent, `~/claude-global`. With the folder at `~/.claude/routines/jobs` that
parent becomes a dashboard-internal directory, which is wrong. The default becomes **the user's home directory** (my call), server display and wrapper alike.
The import writes `cwd: <old folder's parent, with ~>` into every imported file that had neither key, so an imported job runs where it ran before.

### The import

- Who: only the owning server (the one that holds `owner.json`), on start, right after it claims ownership (boot order below). A non-owner never writes.
- When: only while the run-once marker is absent **and** `ROUTINES_DIR` is not set explicitly. A set `ROUTINES_DIR` means the user picked a folder; no
  import happens and no folder is created on their behalf beyond what writes already do.
- From: the old default folder as the old `orLegacy` resolved it — `~/claude-global/routines` if it exists, else `~/claude-global/schedules`. If neither
  exists, just create the empty jobs folder.
- What, per `*.md` file:
  - remove the `machines:` line;
  - set `enabled: false` (`serializeEnabled`, which already knows where to put the key);
  - add `cwd:` as above when the file had neither `cwd:` nor `foreach:`;
  - every other byte as it was, comments included. A file that does not parse is still copied, with the same line edits applied as text where they can be,
    so the user sees and fixes it in the drawer rather than losing it.
- How: write into a temporary sibling folder, then rename it to `jobs/`, so a crash mid-import leaves no half-filled folder (and the "folder does not exist"
  trigger stays true for the next start).
- Afterwards: log one line naming how many files were imported and from where. The usual reconcile then removes the OS jobs the old files had installed,
  because everything is disabled.

### Rollout order (unchanged rule, restated)

The wrapper is a plugin snapshot, so the order on each machine is: merge, `pnpm plugin:sync`, restart the owner server. Until `plugin:sync` runs, an old
wrapper would refuse new-format files (`machines is required`); since everything imports disabled, only Run now could hit that in the gap.

## Docs and tests

- `docs/subsystems/routines.md` (layout table, format table, machine identity, reconcile's desired set, wrapper refusals, API conflicts), `docs/overview.md`
  (the `ROUTINES_DIR` default and the Routines line), `.env.example` if it names `ROUTINES_DIR`, and the client's new-job templates.
- Tests that pin `machines` or the old folder: `test/routine-file`, `routine-config`, `routine-store`, `routine-reconcile`, `routine-run`, `run-routine`,
  `api-routines`, `routine-form`, `routines-view`, `routine-boot`, and the visual fixture `test/visual/fixtures/routines.ts`. New tests cover the import:
  imports all files disabled with `machines:` stripped, adds `cwd:` only when needed, keeps comments, copies an unparseable file, runs once (no re-import
  after a delete), never runs on a non-owner or with `ROUTINES_DIR` set, leaves the old folder byte-identical, and a crash mid-import leaves no `jobs/`.
- `pnpm plugin:gen` after editing `shared/routine-file.ts`.

## Settled after the builder check

Calls made by the author session (not asked of the user), each a sensible default:

1. **Jobs folder = `<resolved state root>/jobs`**, not a literal path: `~/.claude/routines/jobs` on a normal machine, still inside a not-yet-renamed
   `~/.claude/schedules`, or inside `ROUTINES_STATE_ROOT` when that seam is set. Server and wrapper already resolve the state root the same way, so they agree.
2. **"`ROUTINES_DIR` set explicitly" is carried on `Config`.** `routinesDir` becomes `''` when neither `ROUTINES_DIR` nor `SCHEDULES_DIR` is set, and
   `routineDirs` resolves the default. Any set value — including one pointing at `~/claude-global/routines` — is explicit: honoured verbatim, no import.
3. **Overlap guard.** The import is skipped (and logged) if the old folder and the new jobs folder resolve to the same path or one contains the other.
4. **Orphan OS jobs are already handled.** Reconcile's installed set is every launchd label / crontab line under the `com.claude-dashboard.routine.` prefix,
   independent of files, so an installed job with no enabled file behind it — a failed copy included — is removed. A test pins that for the import case.
5. **The added `cwd:` is the old folder's parent written with `~`** — `~/claude-global` for both old names, since a customised `ROUTINES_DIR` never imports.
   Files with `foreach:` are left alone (their cwd comes from the pins).
6. **Text edits are text-level and server-only** (no `plugin:gen` impact beyond `routine-file.ts`'s own change): `enabled:` and `cwd:` go through
   `writeFrontmatterLine` / `serializeEnabled`, which already work on unparseable text and keep each line's own ending. Removing `machines:` drops the key's
   line plus any following indented `- item` lines (block-list form). CRLF files keep CRLF.
7. **Run-once marker.** The import writes `<state root>/jobs-imported.json` (`{at, from, count}`) and runs only while that marker is absent — so deleting the
   whole `jobs/` folder does not re-import, and a machine with no old folder records the marker with `count: 0`. The temp-folder-then-rename rule stays for the
   folder itself; the marker is written after the rename.
8. **Boot order:** `migrateLegacyState` → `claimOwner` → **import** → lock sweep → pins snapshot → log rotation → reconcile. The import is its own `step`, so a
   failure is logged and the rest of boot, reconcile included, still runs (against an empty or missing jobs folder, which reads as no jobs).

## Left to the builder

- How `parseJob` receives the machine for the launchd rule.
- Exact UI copy for "these jobs belong to <machine>" and the parse-error wording for a leftover `machines:` line.
- Whether the import lives in `routine-store.ts` or `routine-boot.ts`.
