# Scheduled Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Management › Schedules — jobs defined as markdown files in a git-synced folder, installed into launchd/cron per machine, run by one wrapper, logged per run, shown with stats, created and edited from the dashboard.

**Architecture:** Three zero-dep `shared/` modules (cron, job file, frontmatter writer) are the one parser everyone runs; `plugin/lib/` holds generated `.mjs` copies plus the wrapper launchd/cron call. The server owns reconcile (files → OS jobs), the incremental run-log reader, pins/owner snapshots, the failure push and the HTTP surface; the client is a new Management tab over that surface, opening runs in the existing `ChatDrawer`.

**Tech Stack:** Node built-ins only on the server and in the wrapper; React + Vite client; `test/run-all.ts` node-assert suites with tmpdir fixtures; `typescript`'s `transpileModule` (already a dev dep) for the generated plugin modules.

**Spec:** `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` — every value below is the spec's; when they disagree, the spec wins and the plan is wrong.

**Plan conventions (override the template):** steps specify *behaviour and exact test cases* — signatures, expected values, edge cases — never literal implementation or test code. Handed code gets transcribed with its bugs; a named assertion gets thought about. Where a step shows a value in backticks it is an exact value, not an example. Line budgets are soft. Authored text wraps at 160 columns. Every test file follows the repo pattern: `function test(name, fn): boolean` counting passes, `export function run(): number` returning failures,
registered in `test/run-all.ts`, and ending with the main guard `if (import.meta.url === \`file://${process.argv[1]}\`) process.exit(run() > 0 ? 1 : 0);`
(as `test/scan.test.ts` does) so one file runs alone: **a task's run steps are `pnpm tsx test/<that file>.test.ts` plus `pnpm typecheck`, never the
whole `test/run-all.ts`** — CI is the full-suite gate (`.claude/CLAUDE.md` §Commands). Commits are one per task, `git add <the files>` then `git commit`, never `-A`; the branch is `feat/schedules` off `main`.

## Global Constraints

- `server/` and `plugin/lib/` use Node built-ins only; `test/server-deps.test.ts` pins the two allowed packages and fails on any other bare import.
- New process launches (`launchctl`, `crontab`, `pgrep`, `ps`, `node <wrapper>`) are local launches, not a new outbound kind: `test/outbound.test.ts`
  `ALLOWED` lists network modules only and stays untouched; the launches are named in `.claude/CLAUDE.md`'s zero-deps paragraph the way `git-fetch.ts`
  and `git-quick.ts` are.
- `shared/types.ts` first for every API field; `shared/cron.ts` and `shared/schedule-file.ts` join `frontmatter.ts` and `gitUpstream.ts` as modules both sides run — `.claude/CLAUDE.md` (§Orientation line 16, §Code rules line 63) and `docs/overview.md` line 6 are amended in the same PR.
- `plugin/` top level becomes `['.claude-plugin', 'lib', 'skills']` (`test/plugin-manifest.test.ts`); never `bin/`, which Claude Code puts on every session's PATH. `scripts/sync-plugin.ts` `PUBLISHED_PATHS` gains `'lib'`.
- CSS: tokens only below the theme block; new classes prefixed `.sch-`; no `.uk-*` rule.
- Job name pattern `^[a-z0-9-]+$`; reserved names `runs`, `validate`, `reconcile`, `reveal`.
- Machine-local state root `~/.claude/schedules/` with `runs/`, `locks/`, `launchd/`, `pins.json`, `owner.json`, `notified.json`.
- launchd label prefix `com.claude-dashboard.schedule.`; crontab markers `# >>> claude-dashboard schedules >>>` / `# <<< claude-dashboard schedules <<<`.
- `.env` keys: `SCHEDULES_DIR` (default `~/claude-global/schedules`), `SCHEDULE_MACHINE` (`mac` | `wsl`), `SCHEDULES_OWNER` (`true` opts in).
- Permission modes accepted in a file: `plan`, `acceptEdits`, `auto`; default when absent = `config.syncPermissionMode`; clamp to `config.spawnMaxPermission`.
- Stats windows 7 | 30 | 90 days, default 30, setting `scheduleWindow`.

## Review Focus

1. A cron the OS cannot express — `*/15 * * * *` (expandable), `0 9 1-5 * 1` (day-of-month AND weekday both set: cron ORs them, launchd ANDs them). Expected: expandable forms install; the OR form is a validation error on mac naming the rule. Test in Task 1.
2. A run-log file whose last line is torn (the wrapper was killed mid-write). Expected: the reader keeps the good lines, ignores the torn tail, and re-reads it once more bytes arrive. Test in Task 5.
3. `pins.json` naming two pins with the same `name` and a file using that name. Expected: `checkPins` reports the ambiguity with both `dirName`s; the wrapper refuses the run with `why: ambiguous pin <name>`. Test in Tasks 2 and 4.
4. A crontab PATH containing `Program Files (x86)`, a `'` and a `%`. Expected: the rendered line passes `sh -n` and round-trips through `crontab -l` parsing unchanged. Test in Task 8.
5. The owner server restarts while a wrapper holds a job lock. Expected: the lock is kept (live pid, same boot id, command line matches), the job reads `running`, reconcile defers its update. Test in Tasks 7 and 8.

---

## File structure

| path | responsibility |
|---|---|
| `shared/cron.ts` | five-field cron: parse, next/last occurrence, launchd intervals, English description |
| `shared/schedule-file.ts` | job file: parse + validate, pin check, enabled-line rewrite; `Job` type |
| `shared/frontmatter.ts` | existing parser + new `writeFrontmatterLine` |
| `shared/types.ts` | `ScheduleJob`, `ScheduleRun`, `ScheduleStep`, `ScheduleStats`, `SchedulesResponse`, `ScheduleRunsResponse`, `ReconcileReport`, `NotifyEvent` union |
| `plugin/lib/run-schedule.mjs` | the wrapper |
| `plugin/lib/{cron,schedule-file,frontmatter}.mjs` | generated from `shared/` by `scripts/gen-plugin-lib.ts` |
| `server/lib/schedule-config.ts` | machine name, dirs, `scheduleEnv(config)` |
| `server/lib/schedule-store.ts` | read the folder → jobs; atomic write; `pins.json`, `owner.json` |
| `server/lib/schedule-log.ts` | incremental reader, fold into runs, lost rule, stats |
| `server/lib/schedule-reconcile.ts` | desired/installed/diff/apply, plist + crontab rendering, serialisation, watchers |
| `server/lib/schedule-run.ts` | `/run` and `/stop`: spawn the wrapper, signal the lock's pid |
| `server/lib/schedule-notify.ts` | `schedule-failed` pushes, `notified.json` |
| `server/api.ts` | `serveSchedules*` handlers; `GET /api/sessions/:id/row` |
| `server/lib/scan.ts` | `sessionFromRef` extracted from `scanSessions` |
| `client/src/lib/schedules.ts` | pure view helpers (row text, day grouping, stat formatting, validate summary) |
| `client/src/hooks/useSchedules.ts` | polls `/api/schedules`; `useScheduleRuns.ts` polls runs |
| `client/src/components/management/schedules/*.tsx` | `SchedulesView`, `StatsBand`, `JobLedger`, `JobFold`, `RunsList`, `JobDrawer`, `RunNowPopover`, `JobMenu` |
| `docs/subsystems/schedules.md` | the subsystem doc |

---

### Task 1: `shared/cron.ts`

**Files:** Create `shared/cron.ts`; Test `test/cron.test.ts`; register in `test/run-all.ts`.

**Interfaces — Produces:**
- `parseCron(expr: string): { ok: true; cron: Cron } | { ok: false; error: string }` — `Cron` = five sets of allowed integers plus `domRestricted` / `dowRestricted` booleans.
- `nextAfter(cron: Cron, from: Date): Date | null` (local time; null when no match within 5 years).
- `lastBefore(cron: Cron, from: Date): Date | null`.
- `toCalendarIntervals(cron: Cron): Array<{ Minute?: number; Hour?: number; Day?: number; Month?: number; Weekday?: number }> | null` — null when launchd cannot express it (dom and dow both restricted).
- `describeCron(cron: Cron): string`.

- [ ] **Step 1: failing tests** — `parseCron`: `"0 22 * * *"` ok; `"0 22 * *"` error `cron needs five fields (minute hour day month weekday); got 4`; `"60 0 * * *"` error naming `minute`; `"*/15 * * * *"` ok with minute set `{0,15,30,45}`; `"0 7 * * 1-5"` ok with weekday `{1..5}`; `"0 9 * * 7"` normalises 7 → 0. `nextAfter`: from `2026-10-19T21:59:00` local with `"0 22 * * *"` → `2026-10-19T22:00`; from `22:00:00` exactly → next day; `"0 9 1 * *"` from Oct 19 → Nov 1 09:00; `"0 0 31 2 *"` → null. `lastBefore` mirrors the first two. `toCalendarIntervals`: `"0 22 * * *"` → `[{Minute:0,Hour:22}]`; `"0 7 * * 1-5"` → five dicts; `"*/15 * * * *"` → four dicts; `"0 9 1-5 * 1"` → null. `describeCron`: `"0 22 * * *"` → `22:00 daily`; `"0 7 * * 1-5"` → `07:00 Mon–Fri`; `"30 9 1 * *"` → `1st of month 09:30`; `"0 9 * * 0"` → `Sun 09:00`; anything else → the expression itself.
- [ ] **Step 2: run** `pnpm tsx test/cron.test.ts` → the new cases fail with the module missing.
- [ ] **Step 3: implement** the five functions; expansion of `*/n`, `a-b`, lists; `nextAfter` iterates minute by minute at most 5 years, skipping whole days when the day sets do not match.
- [ ] **Step 4: run** `pnpm tsx test/cron.test.ts` → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: commit** `feat(schedules): cron parser, next/last occurrence, launchd intervals`.

### Task 2: `shared/schedule-file.ts` and the frontmatter writer

**Files:** Create `shared/schedule-file.ts`; Modify `shared/frontmatter.ts` (append a writer); Modify `shared/types.ts` (`ScheduleJob`); Test `test/schedule-file.test.ts`, extend `test/frontmatter.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:**
- `interface ScheduleJob { name; cron: string; machines: ('mac'|'wsl')[]; run: 'shell'|'claude'; foreach: 'pinned' | string[] | null; cwd: string | null; enabled: boolean; model: string|null; effort: string|null; permissionMode: 'plan'|'acceptEdits'|'auto'|null; allowedTools: string[]|null; maxTurns: number|null; timeoutMs: number; body: string; script: string|null }` in `shared/types.ts`.
- `parseJob(name: string, text: string): { job: ScheduleJob | null; errors: JobError[] }` where `JobError = { line: number; message: string }` (line 0 = whole file).
- `checkPins(job: ScheduleJob, pins: PinSnapshot[]): JobError[]` with `PinSnapshot = { dirName; name; path: string|null; listed: boolean }`.
- `serializeEnabled(text: string, enabled: boolean): string`.
- `writeFrontmatterLine(text: string, key: string, value: string, afterKey?: string): string` in `frontmatter.ts`.

- [ ] **Step 1: failing tests** — the spec's example file (with its `#` comments; its `cwd:` line is itself a comment) parses with `timeoutMs = 1_800_000`, `permissionMode = 'acceptEdits'`, `allowedTools = ['Bash','Read']`, `maxTurns = 60`, `body = '/git-sync'`. Errors, each with its line: name `Runs` → `name must match [a-z0-9-]+`; name `runs` → `name is reserved`; four cron fields → the Task 1 message; `machines: [linux]` → `machines: unknown machine linux`; `run: python` → `run must be shell or claude`; `permission-mode: bypassPermissions` → `permission-mode must be plan, acceptEdits or auto`; `permission-mode: dontAsk` same; `foreach: pinned` with `cwd:` → `cwd is not used with foreach`; `run: shell` with no ` ```bash ` fence → `shell job needs a ```bash block`; shell body with a fence → `script` is the fence's inner text; `model: claude opus` → `model must be one token`; unknown key `foo:` → `unknown key foo`; duplicate `cron:` → `cron given twice`; a nested block (`machines:` then indented `- mac`) → `machines must be an inline list [a, b]`; empty value `cron:` → `cron is empty`; a whole-line `# note` inside the frontmatter is ignored; `enabled` absent → `true`; `timeout: 30s` → `30_000`, `timeout: 30m` → `1_800_000`, `timeout: 2h` → `7_200_000`, `timeout: x` → `timeout must be like 30s, 30m or 2h`; absent →
`3_600_000`. Mac expressibility: `cron: "0 9 1-5 * 1"` with `machines` containing `mac` → `cron: launchd cannot combine day-of-month and weekday; use
one` (Review Focus 1); the same cron with `machines: [wsl]` parses. `checkPins`: `foreach: [lookout]` with pins `[{name:'lookout', listed:true}]` → `[]`; two pins named `lookout` → one error `foreach: lookout is ambiguous here (dir-a, dir-b); use the dirName`; a `dirName` match resolves. `serializeEnabled`: flips `enabled: true` → `false` leaving every other byte equal (assert on the full string); absent line → inserted directly after the `run:` line; `writeFrontmatterLine` on a file with no frontmatter returns it unchanged.
- [ ] **Step 2: run** → FAIL. **Step 3: implement** reading the raw frontmatter lines (not `parseFrontmatter`'s data) per the spec's parser rules. **Step 4: run** → PASS.
- [ ] **Step 5: commit** `feat(schedules): job file parser, pin check, enabled rewrite`.

### Task 3: generated plugin modules and manifest rules

**Files:** Create `scripts/gen-plugin-lib.ts`, `plugin/lib/{cron,schedule-file,frontmatter}.mjs` (generated); Modify `package.json` (`"plugin:gen"`),
`scripts/sync-plugin.ts` (`PUBLISHED_PATHS` becomes `['.claude-plugin', 'hooks', 'lib', 'skills']`; after a successful install it POSTs
`http://127.0.0.1:<PORT from .env>/api/schedules/reconcile` with `{ apply: true }`, best effort, connection errors ignored), `test/sync-plugin.test.ts`
(the `PUBLISHED_PATHS` deep-equal at its line 108; a recording listener sees exactly one POST after install; a closed port does not fail the sync),
`test/plugin-manifest.test.ts`, `.claude/CLAUDE.md`, `docs/overview.md`.

- [ ] **Step 1: failing tests** in `plugin-manifest.test.ts`: `plugin/` entries equal `['.claude-plugin','lib','skills']`; for each of the three modules, `transpileModule(shared source, { module: ESNext, target: ES2022 })` text with import specifiers rewritten `./x.js` → `./x.mjs` equals the file on disk; `plugin/lib/` holds exactly the three `.mjs` plus `run-schedule.mjs` (Task 4 adds it; until then assert the three).
- [ ] **Step 2: run** → FAIL. **Step 3: implement** the generator (`pnpm plugin:gen` writes the three files) and run it; add `'lib'` to `PUBLISHED_PATHS`; amend the two CLAUDE.md lines and overview.md line 6 to name `cron.ts` and `schedule-file.ts`. **Step 4: run** → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: commit** `chore(plugin): generated lib modules for the schedule wrapper`.

### Task 4: the wrapper `plugin/lib/run-schedule.mjs`

**Files:** Create `plugin/lib/run-schedule.mjs`; Test `test/run-schedule.test.ts` (spawns the wrapper as a child with `HOME` = tmpdir, a fake `claude` shell script on `CLAUDE_BIN` that echoes a JSON result and records its argv/stdin/env to a file, and a tmp schedules dir).

**Interfaces — Consumes:** Tasks 1–3 modules via `./*.mjs`. **Produces:** the run-log record shapes in the spec's table (`start`, `step-start`, `step-end`, `end`, `refused`), the lock file format `{ pid, bootId, job }`, exit codes 0 / 1 / 75 / 143, and the flags `--trigger schedule|manual`, `--only <pin>...`.

- [ ] **Step 1: failing tests**, each reading `~/.claude/schedules/runs/<machine>.jsonl` afterwards: shell job `echo hi` → `start` (steps 1), `step-start`, `step-end` with `exit 0`, `outcome ok`, `tail` ending `hi`, `end` with `ok 1`, exit 0; shell `exit 3` → `outcome failed`, `end.failed 1`, exit 1; `foreach: pinned` with a `pins.json` of 3 (one `listed:false`) → 3 `step-start` with the right `cwd`s, one `outcome skipped why "pin unlisted"`; `foreach: [a]` with no `pins.json` → `end.error "no pins snapshot"`, no steps, exit 1; `--only b` on a 3-pin job → one step; ambiguous name → a `start` then `end.error "ambiguous pin lookout"` and no steps;
`foreach: [ghost]` with no such pin → `step-start` for it then `step-end outcome skipped why "not pinned"`; a held lock with a live pid whose command line is the wrapper → `refused why running`, exit 75, log unchanged otherwise; a lock with a dead pid → taken over; the refusal matrix, each a `refused` record with no `start` and exit 0: schedule + file deleted → `why "file gone"`; schedule + invalid file →
`why "invalid: <line>"`; schedule + disabled → `why disabled`; schedule + `machines: [wsl]` on mac → `why "not this machine"`; manual + gone / invalid /
other machine → the same three; manual + disabled → runs; claude job → fake `claude` saw argv containing `-p`, `--output-format json`, `--session-id <uuid matching /^[0-9a-f-]{36}$/>` equal to the `session` on that step's `step-start`, `--permission-mode acceptEdits`,
`--disallowed-tools AskUserQuestion`, `--max-turns 60`, env `CLAUDE_DASHBOARD_SCHEDULE=<job>`, stdin = body; `step-end` carries `cost`, `tokensIn`,
`tokensOut`, `turns`, `model` from the fake's result; no `permission-mode` + env `SYNC_PERMISSION_MODE=acceptEdits` → argv has `--permission-mode
acceptEdits`; `permission-mode: auto` + env `SPAWN_MAX_PERMISSION=plan` → argv has `--permission-mode plan` (clamped); fake result `is_error: true` → `outcome failed`; a file with `permission-mode: bypassPermissions` is invalid → `refused why "invalid: <line>"`, no `start`, nothing launched; `CLAUDE_BIN` unset + claude job → `end.error "claude cli not configured"`; `timeout: 1s` on `sleep 5` → `outcome timeout`, child gone; SIGTERM to the wrapper mid-step → `end.stopped true`, exit 143, child gone; `--trigger schedule` 20 min after the slot → `start.late true`, `start.slot` the slot's ISO; manual → no `slot`.
- [ ] **Step 2: run** → FAIL. **Step 3: implement**; boot id from `sysctl -n kern.boottime` (mac) or `/proc/sys/kernel/random/boot_id`; liveness via `process.kill(pid, 0)` plus `ps -o command= -p <pid>` containing `run-schedule <job>`; shell body to a tmp file run with `bash -e`; `tail` = last 20 lines of combined output. **Step 4: run** → PASS; `plugin-manifest.test.ts` updated for the fourth file.
- [ ] **Step 5: commit** `feat(schedules): run-schedule wrapper`.

### Task 5: run-log reader and stats

**Files:** Create `server/lib/schedule-log.ts`; Modify `shared/types.ts` (`ScheduleRun`, `ScheduleStep`, `ScheduleStats`); Test `test/schedule-log.test.ts` (writes JSONL fixtures in a tmpdir).

**Interfaces — Produces:**
- `createLogReader(dir: string, liveness: (pid: number, job: string) => boolean | null, timeoutMsFor: (job: string) => number): { read(): ScheduleRun[];
  watch(onChange: () => void): () => void }` — incremental per spec; `liveness` returns null when it cannot tell; `timeoutMsFor` feeds the age rule.
- `rotateIfLarge(dir: string, limitBytes = 20 * 1024 * 1024): string[]` — renames `<machine>.jsonl` over the limit to `<machine>.<yyyymmdd>.jsonl`, returns the names moved; called by the owner only (Task 11 wiring).
- `ScheduleRun = { id; job; machine; trigger; startedAt; endedAt: string|null; ms: number|null; late: boolean; state: 'running'|'ok'|'failed'|'lost'|'refused'; ok; failed; skipped; stopped; error: string|null; why: string|null; steps: ScheduleStep[] }`.
- `computeStats(runs: ScheduleRun[], days: 7|30|90, now: Date): ScheduleStats` with `{ runs, ok, failed, lost, costUsd, tokensIn, tokensOut, wallMs, byDay: Array<{ day; ok; failed }>, prev: { costUsd; runs } }`.
- `pushableEvents(runs): Array<{ run: ScheduleRun; title: string; body: string }>` — the spec's three copies.

- [ ] **Step 1: failing tests** — a complete run folds to `state ok` with 2 steps; `failed 1` → `failed`; `error` set → `failed`; a `start` with no `end`, liveness false → `lost`; liveness true → `running`; liveness null with `timeoutMsFor` = 60 min and 2 steps: age 124 min → `running`, 126 min → `lost` (rule = timeout × steps + 5 min); a torn last line (`{"kind":"step-e`) is ignored and the fold is the same as without it; appending the rest of that line then more records and calling `read()` again includes them (offset cache); a rotated file (`mac.20261001.jsonl`) is read too; `rotateIfLarge` on a 21 MB file renames it to today's `mac.<yyyymmdd>.jsonl` and a 1 MB one is
untouched, and `read()` after the rename still folds every run; an `end` arriving after a run was read as lost flips it to `ok`; `refused why running` is not a run (dropped), `refused why "file gone"` is a `state refused` row. `computeStats` over a fixture of 61 runs across 30 days → the mock's numbers for the window you build (assert your own fixture's totals, and that `byDay` has 30 entries oldest first); `prev` covers days 31–60. `pushableEvents`: a failed run → title `git-sync-all · 2 of 12 failed`, body = first failed step's `why`; a lost run → `git-sync-all · lost` / `started 22:00, no end record · machine slept?`; `error` → `pull-pins · failed before start` / the error; refused (not running) → `pull-pins · not run` / the why.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): incremental run-log reader and stats`.

### Task 6: config, machine, env

**Files:** Create `server/lib/schedule-config.ts`; Modify `server/lib/config.ts` (`schedulesDir`, `scheduleMachine`, `schedulesOwner` on `Config` + `DEFAULTS`), `.env.example`; Test `test/schedule-config.test.ts`.

**Interfaces — Produces:** `machineName(config): { name: 'mac'|'wsl'; error: string|null }`; `scheduleDirs(config): { schedules; state; runs; locks; launchd }`; `scheduleEnv(config): Record<string,string>` with exactly `PATH, HOME, CLAUDE_BIN, SPAWN_MAX_PERMISSION, SYNC_PERMISSION_MODE, SCHEDULE_MACHINE, SCHEDULES_DIR`;
`scheduleStateRoot(config)` — `SCHEDULES_STATE_ROOT` from `.env` when set (a test and verification seam, not documented for users), else `~/.claude/schedules`.

- [ ] **Step 1: failing tests** — `SCHEDULE_MACHINE=wsl` wins over Darwin; `SCHEDULE_MACHINE=linux` → `error "bad SCHEDULE_MACHINE"`; unset on Darwin → `mac`; unset with `/proc/version` containing `microsoft` (injected reader) → `wsl`; `scheduleEnv` has exactly those seven keys and nothing from `process.env` beyond `PATH`/`HOME`; `SCHEDULES_DIR` default expands `~`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): config keys and baked environment`.

### Task 7: store, pins snapshot, owner lock

**Files:** Create `server/lib/schedule-store.ts`; Test `test/schedule-store.test.ts`. (The pins writer is called from `servePinsWrite` / `servePinsOrder`
in Task 11 — `settings.ts` already imports `management.ts`, so a call from there would cycle — and start-up wiring is Task 11's too.)

**Interfaces — Consumes:** Tasks 2, 6. **Produces:** `readJobs(dir): Array<{ name; text; job: ScheduleJob|null; errors: JobError[]; mtimeMs }>`; `writeJob(dir, name, text)` (tmp + rename; `409`-style `exists` error for create); `deleteJob(dir, name)`; `writePinsSnapshot(config)`; `claimOwner(config): 'owner' | { ownedBy: string }`; `releaseOwner()`; `isOwner(): boolean`; `wrapperAlive(pid: number, job: string): boolean | null`
(`process.kill(pid, 0)` then `ps -o command= -p` contains `run-schedule <job>`; null when `ps` is unavailable); `sweepLocks(config): string[]` (names of
locks removed).

- [ ] **Step 1: failing tests** — a folder with two valid files, one invalid and one `.txt` → two jobs, one error entry, the `.txt` ignored; `writeJob` leaves no `.tmp` behind and a concurrent reader never sees a partial file (write 1 MB, read in a loop); `writePinsSnapshot` writes `[{dirName,name,path,listed}]` in pin order; `claimOwner` with no file → `owner` and the file has this pid + boot id; with a live foreign pid → `{ ownedBy: '<cwd>:<port>' }`; with a dead pid → `owner`; a pid from another boot id → `owner`; a server without `SCHEDULES_OWNER` never claims (`isOwner()` false, file untouched). `sweepLocks` with a fake `ps`: a lock whose pid is dead → removed;
live pid whose command is `node …/run-schedule.mjs git-sync-all --trigger schedule` for job `git-sync-all` → kept (Review Focus 5); live pid running
something else → removed; matching command but another boot id → removed.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): job store, pins snapshot, owner lock`.

### Task 8: reconcile

**Files:** Create `server/lib/schedule-reconcile.ts`; Modify `.claude/CLAUDE.md` (zero-deps paragraph names the launches); Test `test/schedule-reconcile.test.ts` (fake runner records every `launchctl` / `crontab` / `pgrep` invocation and serves canned output).

**Interfaces — Consumes:** Tasks 1, 2, 6, 7. **Produces:** `setScheduleRunner(run | null)` seam like `overrideFetchRunner`; `renderPlist(job, env, paths): string`; `renderCronLine(job, env, paths): string`; `planReconcile(config): ReconcileReport` (`{ state: 'in-sync'|'drift'|'failed'|'pending'|'not-owner'|'no-plugin'|'cron-down'|'bad-machine'|'no-claude'; changes: Array<{ name; action: 'install'|'update'|'remove'|'pending'; why }>; unchanged: number; error: string|null; at }`); `applyReconcile(config): Promise<ReconcileReport>`; `startReconcileWatchers(config)` (schedules dir, `installed_plugins.json`, runs dir end records → re-run), `stopReconcileWatchers()`.

- [ ] **Step 1: failing tests** — `renderPlist` for `"0 7 * * 1-5"` has five `StartCalendarInterval` dicts, `ProgramArguments` = `[node, wrapperPath, 'pull-pins']`, `EnvironmentVariables` = the seven keys, `WorkingDirectory` = schedules dir, log paths under `launchd/`; `renderCronLine` for the same is one line starting `0 7 * * 1-5 ` with every env value single-quoted, a PATH `/c/Program Files (x86)/x:/it's` rendered `'/c/Program Files (x86)/x:/it'\''s'`, a `%` as `\%`, and the line passes `sh -n` (run it); plan on mac: new file → `install`; plist present and `launchctl print` exit 0 with identical rendered text → `unchanged`; plist on disk but `print` exit 1 → `drift`; file disabled → `remove`; file names only `wsl` → `remove`; changed node path → `update`; job lock held by a live wrapper → `pending why running`, no `bootout` call recorded; plugin dir missing → `state no-plugin`, no calls; `CLAUDE_BIN` empty + claude job → that job `why "claude cli not configured"`, shell jobs still install; `SCHEDULE_MACHINE=linux` → `bad-machine`; wsl: `crontab -l` output with user lines above and below the markers → after apply the runner saw `crontab -` with those lines byte-identical and the block replaced; `pgrep` empty on wsl → `cron-down`; a `foreach: [lookout]` job whose pin is absent still installs (the wrapper skips at run time); two `applyReconcile` calls at once → the runner sees one sequence then one trailing sequence, never interleaved; non-owner → `not-owner`, no calls.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): reconcile files into launchd and cron`.

### Task 9: failure push

**Files:** Create `server/lib/schedule-notify.ts`; Modify `shared/types.ts` (`NotifyEvent` gains `'schedule-failed'`), `server/lib/settings.ts` (`NOTIFY_EVENTS`), `server/lib/notify.ts` (a `sendScheduleEvent(run, config)` sibling of `maybeSend`), the Settings page's notify checklist (`client/src/components/settings/*` where the four events are listed); Test extend `test/notify.test.ts`, `test/settings.test.ts`, new `test/schedule-notify.test.ts`.

- [ ] **Step 1: failing tests** — `NOTIFY_EVENTS` has five entries; the policy parser accepts `schedule-failed`; with master off nothing is sent; with master on and `requireAfk`/`requireRemoteAnswer`/`requireAutoMode` all true the schedule push is still sent (exempt); desk routing honoured; `click` = `publicUrl + '/?view=schedules&run=<id>'`, `''` without publicUrl; the same run id is sent once across two folds and across a `notified.json` reload; a non-owner sends nothing.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): schedule-failed push`.

### Task 10: on-demand run and stop

**Files:** Create `server/lib/schedule-run.ts`; Test `test/schedule-run.test.ts` (fake spawner via `setSpawner`, fixture lock files).

**Interfaces — Produces:** `runJob(config, name, only?: string[]): Promise<{ status: 202; run: string } | { status: 404 } | { status: 409; error: 'already-running' }>`; `stopJob(config, name): { status: 204 } | { status: 409; error: 'not-running' }`.

- [ ] **Step 1: failing tests** — spawn argv = `[node, wrapperPath, name, '--trigger', 'manual']` plus `--only a b`; env passed to the spawner equals `scheduleEnv(config)` exactly (no `CLAUDE_CODE_ENTRYPOINT`); detached + stdio ignored; `202` once the `start` record with `trigger manual` appears (fixture writer appends it); no record in 2 s → `202` with `run: null`; lock held by a live wrapper → `409`; unknown name → `404`; `stopJob` sends SIGTERM to the lock's pid only when its command line matches, else `409`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): run now and stop`.

### Task 11: HTTP surface and the session row endpoint

**Files:** Create `server/lib/schedule-boot.ts`; Modify `server/api.ts` (handlers; `servePinsWrite` / `servePinsOrder` call `writePinsSnapshot` when
`isOwner()`), `server/index.ts` (routes; `startSchedules(config)` after listen, `stopSchedules()` on SIGINT/SIGTERM), `server/lib/scan.ts` (extract
`sessionFromRef`), `shared/types.ts`, `test/write-paths.test.ts` (`GATE_ONLY_WRITES` gains `serveScheduleWrite`, `serveScheduleCreate`,
`serveScheduleDelete`, `serveSchedulePatch`, `serveScheduleReconcile`, `serveScheduleRun`, `serveScheduleStop`, `serveScheduleReveal`); Test
`test/api-schedules.test.ts` (the pattern of `test/api-pins.test.ts`), `test/schedule-boot.test.ts`, extend `test/scan.test.ts`.

**Interfaces — Produces** in `shared/types.ts`: `ScheduleJobRow = { name; text; job: ScheduleJob | null; errors: JobError[]; mtimeMs; onThisMachine:
boolean; installed: boolean; nextAt: string | null; last: ScheduleRun | null; running: ScheduleRun | null }`; `SchedulesResponse = { machine; dir;
owner: 'owner' | { ownedBy: string }; reconcile: ReconcileReport; jobs: ScheduleJobRow[] }`; `ScheduleRunsResponse = { runs: ScheduleRun[]; stats:
ScheduleStats }`. `startSchedules(config)`: when owner — `claimOwner`, `sweepLocks`, `writePinsSnapshot`, `rotateIfLarge`, `applyReconcile`,
`startReconcileWatchers`, and a runs watcher that folds and calls `sendScheduleEvent` for each pushable run; when not owner — nothing but the read
path. `stopSchedules()`: watchers off, `releaseOwner`.

- [ ] **Step 1: failing tests** — every route in the spec's table with its status codes: `GET /api/schedules` shape; `GET /api/schedules/runs?days=7&job=x&outcome=failed&runner=claude` filters; `PUT` with an invalid file → `422 { errors: [{ line, message }] }` and the file untouched; `PUT`, `POST` and `/validate` run `checkPins` against the
current pins → a `foreach` naming an ambiguous pin is a `422` too; a name `../x`, `Runs` or `runs` on any route → `400 { error: 'bad name' }` with the
store never called (fake store records calls); `POST` existing name → `409`; `PATCH { enabled:false }` → file diff is exactly the `enabled:` line; `DELETE` removes the file, log rows remain; `POST /validate` is reachable without write trust; every other write → `403` without trust (reuse the existing trust test helper) and `409 not-owner` on a non-owner; `POST /reveal` → `501` off darwin; `GET /api/sessions/:id/row` for a transcript older than `SCAN_CAPS.lookback` returns a `Session` with status derived from the transcript (liveness `null`), `404` for an unknown id, and does not 404 a `commandOnly` transcript. `scan.test.ts`: `sessionFromRef(ref, opts)` returns the same row `scanSessions` does for a fixture (deep-equal against the scan's output).
`schedule-boot.test.ts` with fakes for every call: owner → the seven calls happen in that order, pins written before reconcile; non-owner → none of
them; `stopSchedules` releases the owner file; a `pins` write through `servePinsWrite` on an owner rewrites `pins.json`, on a non-owner does not.
- [ ] **Step 2–4:** FAIL → implement → PASS; `docs/subsystems/remote-access.md` write-route list updated. **Step 5: commit** `feat(api): schedules routes and session row by id`.

### Task 12: hook markers

**Files:** Modify `scripts/stop-notify-hook.sh`, `scripts/ask-remote-hook.sh`, `scripts/remote-decision-hook.sh`, `scripts/plan-remote-hook.sh`, `scripts/permission-notify-hook.sh`; Test `test/hooks-schedule-marker.test.ts`.

- [ ] **Step 1: failing tests** — a recording HTTP listener on a free port stands in for the dashboard (`/api/health` answers `{ remoteAnswer: true,
  answerSecs: 1 }`); each script runs with `CLAUDECODE=1`, `CLAUDE_DASHBOARD_URL` at that port and a minimal payload on stdin. With
  `CLAUDE_DASHBOARD_SCHEDULE=x`: exit 0, empty stdout, **zero** requests recorded. Without it: at least one request recorded (the existing path), which is
  what makes the test red before the guard exists.
- [ ] **Step 2–4:** FAIL → add the `[ -n "$CLAUDE_DASHBOARD_SCHEDULE" ] && exit 0` guard directly after each script's `[ "$CLAUDECODE" = "1" ] || exit 0` line (only
`stop-notify-hook.sh` has a `REFRESH` guard to sit beside), with a one-line comment → PASS; `docs/workflows/hooks-setup.md` gains the marker. **Step 5: commit** `fix(hooks): schedule runs are never held or pushed by the session hooks`.

### Task 13: client settings, deep link, hooks

**Files:** Modify `client/src/lib/settings.ts` (`ManagementTab` + `'schedules'`, `scheduleWindow: 7|30|90` default 30), `client/src/lib/deepLink.ts`
(`readViewParam` → `'git'|'schedules'|null`; `readRunParam(search)`; `consume()` reads `run` in the same pass before `replaceState` strips the query;
`DeepLink.run()` and `deepLinkRun()` beside `deepLinkView()`; the `view` type widened wherever `'git' | null` is written), `client/src/components/management/ManagementView.tsx`; Create `client/src/hooks/useSchedules.ts`, `useScheduleRuns.ts`, `client/src/lib/schedules.ts`; Test extend `test/client-settings.test.ts`, `test/deep-link.test.ts`; new `test/schedules-view.test.ts`.

**Interfaces — Produces (pure, tested):** `rowText(job: ScheduleJobRow, now): { lastLine: string; nextLine: string; pill: { text; tone } }`; `groupRunsByDay(runs, now): Array<{ label; runs }>`; `formatStat(n, kind: 'usd'|'tokens'|'ms'|'pct'): string`; `foreachLine(mode: 'all'|'pick'|'cwd', picks: string[]): string`; `readForeach(text): { mode; picks }`.

- [ ] **Step 1: failing tests** — `'schedules'` round-trips through settings; unknown window → 30; `?view=schedules&run=abc` → `view()` `schedules`, `run()` `abc`, and both still answer after `consume()` stripped the URL; `?view=git` → `run()` null; `rowText` for the mock's rows: last run `6:00 today · 38s` with pill `14 ok`/green; running → `running · 4 of 12`; `wsl only` for a job not naming this machine; `groupRunsByDay` with `now = 2026-04-19T12:00` local (a Sunday) over runs on Apr 18 and Apr 15 labels `Yesterday · Sat 18` then `Wed 15`; `formatStat(24.1,'usd')` → `$24.10`, `(4_100_000,'tokens')` → `4.1M`, `(18_720_000,'ms')` → `5h 12m`, `(0.852,'pct')` → `85%`; `foreachLine('pick',['lookout','ixray'])` → `foreach: [lookout, ixray]`, `('all',[])` → `foreach: pinned`, `('cwd',[])` → `` (and the caller writes `cwd:`); `readForeach` inverts them.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5: commit** `feat(schedules): client settings, deep link, view helpers`.

### Task 14: Schedules tab components

**Files:** Create `client/src/components/management/schedules/{SchedulesView,StatsBand,JobLedger,JobFold,RunsList,JobDrawer,RunNowPopover,JobMenu}.tsx`; Modify `client/src/styles.css` (`.sch-*` block, tokens only), the side rail / Management sub-tab seg to add **Schedules**.

Behaviour per the spec's UI section and the mockup screens 1–6; the ChatDrawer is opened with the row from `GET /api/sessions/:id/row` through the same `openChat` shape `useGitSync` exposes. No component test file (the repo tests domain logic, not React); verification is the dev server and the built-in browser.

- [ ] **Step 1:** `SchedulesView` with toolbar (Jobs | Runs seg, window seg, reconcile chip, Reconcile, New job), `StatsBand`, `JobLedger` rows with stacked `.cell`s and fixed pill columns, fold on row click.
- [ ] **Step 2:** `RunsList` grouped by day with filters; `JobFold` with per-job stats and last 3 runs; `run again` and `session →` links.
- [ ] **Step 3:** `JobDrawer` (kind templates from the spec's example file and the mock's shell template, name check, Repos helper bound both ways to `foreach:`/`cwd:`, debounced `/validate`, Save and install / Save, keep paused, Delete confirm, `on disk changed` chip when the row's `mtimeMs` moves while open).
- [ ] **Step 3b:** the states the mock does not draw: `late` after the time on a row and a Runs line; a non-owner server renders every write control
  hidden with the chip `owned by <cwd>:<port>`; the drawer shows the amber note from the mock under a file with `permission-mode: acceptEdits`; on load
  with `deepLinkRun()` set, the Runs page opens with that run's fold expanded.
- [ ] **Step 4:** `JobMenu` (Edit file, Run now on one repo…, Pause/Resume, Reveal — hidden on wsl, Copy launchd label, Delete…) and `RunNowPopover` (per-pin last outcome, Run, `Run the N failed`; sheet with checkboxes under 640 px).
- [ ] **Step 5: verify** with `preview_start` on a dev server whose `.env` sets `SCHEDULES_DIR` to a tmp folder, `SCHEDULES_STATE_ROOT` (Task 6's
  test seam, default `~/.claude/schedules`) to another, `SCHEDULES_OWNER=true`, notifications off, and the five mock jobs all `machines: [wsl]` so a
  reconcile on this mac installs nothing real; seed that state root's log. Screenshot the Jobs page at desktop and 375 px, read console for errors,
  toggle a job and confirm the file diff, open a 10-day-old run's session. Record the pid you started and stop that pid. Record what was not verified
  (launchd on a real machine, WSL, a real push).
- [ ] **Step 6: commit** `feat(schedules): Management › Schedules tab`.

### Task 15: docs

**Files:** Create `docs/subsystems/schedules.md`; Modify `docs/overview.md` (§Map line, §HTTP surface rows), `docs/subsystems/spawn.md` (wrapper launch), `docs/subsystems/remote-access.md` (write routes), `docs/workflows/hooks-setup.md` (marker), `.env.example`.

- [ ] **Step 1:** write `schedules.md` from the spec: file format, machine identity, owner, reconcile, wrapper, log, pushes, routes, with the state-root layout; every measured figure carries its date.
- [ ] **Step 2:** `pnpm typecheck`, `pnpm build`, and each test file this branch created or changed run on its own (`pnpm tsx test/<file>.test.ts`),
  green with output in the PR body; never `pnpm test` whole before pushing (CI is the gate).
- [ ] **Step 3: commit** `docs(schedules): subsystem doc and map entries`.

---

## Self-review notes

- Spec coverage: job file → T2; pins on disk → T7; machine → T6; owner → T7; reconcile (triggers, chip states, deferral, serialisation, env, quoting, cron-down) → T8; wrapper (lock, refusals, late, outcome mapping, hooks marker) → T4, T12; log + lost + stats + rotation → T5; `/run`, `/stop` → T10; HTTP table + row endpoint → T11; shared modules + generated copies + CLAUDE.md lists → T2, T3; UI screens → T13, T14; notifications → T9; security (trust gate, name validation, no shell interpolation) → T4, T11; docs → T15.
- Types: `ScheduleJob` (T2) is what `readJobs` (T7), `renderPlist` (T8) and the client (T13) consume; `ScheduleRun`/`ScheduleStep` (T5) feed T9, T11, T13; `scheduleEnv` (T6) feeds T8 and T10; `setScheduleRunner` (T8) and `setSpawner` (existing) are the two seams every server test uses.
- Review Focus tests live in T1 + T2 (1), T5 (2), T2 + T4 (3), T8 (4), T7 + T8 (5).
- Plan review 1 (`docs/superpowers/reviews/…-plan-review-1.md`): per-file test runs, full wrapper refusal matrix, `rotateIfLarge`, `sweepLocks`, boot
  wiring in T11, deep-link `run`, verification isolation.
- Proportion: 15 tasks over a 340-line spec; no task carries a code body.
