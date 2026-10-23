# Scheduled workflows plan — review 1

Plan: `docs/superpowers/plans/2026-10-19-scheduled-workflows.md` (P). Spec: `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` (S).
Reviewed 2026-10-19 against the working tree on `docs/scheduled-workflows-spec` @ 358d203. Code claims were checked with codegraph and narrow reads.

## Verdict: REVISE

One Critical (a CLAUDE.md hard rule the test steps contradict, a one-line fix) and 22 Important findings. Several Important ones are wiring with no task
(server start-up, log rotation, the `sync-plugin.ts` POST, the server's lock/liveness helper, server-side `checkPins`). Several are test values that cannot
pass as written: the example file's `timeout`, `cwd` with `foreach`, `timeout: 1s`, the day labels, and the `step-end.session` field. Each one is small, but
together they leave an implementer guessing in most tasks.

## Critical

**C1. P:211 (and every task's Step 2/4, e.g. P:76, P:78) runs the whole `test/run-all.ts`.** `.claude/CLAUDE.md` §Commands says "locally run only the
suites the change … touched" and "never re-run the whole `pnpm test` locally just before a push". `pnpm test` is `tsx test/run-all.ts` plus kaizen's suite
(`package.json:14`), so T15 Step 2 runs nearly all of `pnpm test` right before the PR while saying it does not. The per-task steps repeat the full suite 15
times. → Give each new test file the `if (import.meta.url === \`file://${process.argv[1]}\`)` main guard (as `test/write-paths.test.ts` has). Run that task's
files alone with `pnpm tsx test/<file>.test.ts`, plus `pnpm typecheck`. Leave the full suite to CI.

## Important

**I1. P:92: the spec example's expected values are wrong or contradictory.** S:88 has `timeout: 30m`, so `timeoutMs` is `1_800_000`, not `3_600_000`.
The example also has `foreach: pinned` *and* `cwd: ~/Documents/x` (S:80–81), and the same step asserts `foreach` + `cwd` → `cwd is not used with
foreach`. The example cannot both parse cleanly and hit that error. S:261 says the example "parse[s] as written". → Set `1_800_000`. Then decide the cwd
rule (parked #3, recommended: keep the error and drop `cwd:` from the fixture and the spec example). Add a separate case for absent `timeout` → `3_600_000`.

**I2. P:110 uses `timeout: 1s`, but P:92 defines the grammar as `30m`/`2h` with the error `timeout must be like 30m or 2h`.** As written, T4's timeout
fixture is a validation error, so the wrapper refuses it instead of timing it out. → Either accept `s` in T2 (and add `1s` → `1000` to T2's cases) or give
T4 a fixture that is legal under T2's grammar.

**I3. P:18 and P:152: the instruction to "add each [launch] to `test/outbound.test.ts` `ALLOWED`" is false and breaks the test.** `ALLOWED`
(`test/outbound.test.ts:66-70`) maps files to *network modules and `fetch(`* found by `scanOutbound` (`:43-60`), deep-equalled at `:112`. Process launches
are never scanned, so any entry added for `launchctl`/`crontab`/`pgrep`/`ps` fails the deep-equal. The repo instead names launches in the CLAUDE.md
zero-deps paragraph and pins them with prose tests (`:115-125`, for `git-fetch.ts`/`git-quick.ts`). → Leave `ALLOWED` unchanged. Add `lib/schedule-reconcile.ts`
(launchctl, crontab, pgrep) and `lib/schedule-run.ts` (the wrapper, which launches `claude`) to the `.claude/CLAUDE.md` "Keep new deps out of `server/`"
paragraph. Add a matching `outbound.test.ts` prose case.

**I4. P:98/P:101: `test/sync-plugin.test.ts:108` pins `PUBLISHED_PATHS` to `['.claude-plugin', 'hooks', 'skills']`.** Adding `'lib'`
(`scripts/sync-plugin.ts:27`) fails that test, and T3 does not list it. → Add `test/sync-plugin.test.ts` to T3's Files with the new expected array, and
state where `'lib'` goes (order matters for `driftedPaths`, `:72-74`).

**I5. P:110 vs P:33: the ambiguous-pin outcome is inconsistent.** P:33 says the wrapper "refuses the run with `why: ambiguous pin <name>`". P:110 says
"`refused`? No: a `start` then `end.error \"ambiguous pin lookout\"`", which is drafting text left in a test list. S:215 allows `end.error` only for
`no pins snapshot` and `claude cli not configured`. → Pick one outcome (parked #2, recommended: pre-step `end.error "ambiguous pin <name>"`). Make P:33 and
P:110 agree, delete the "`refused`? No:" text, and flag the spec's `end.error` list for the addition.

**I6. P:110: the `bypassPermissions` expectation contradicts the spec.** The wrapper validates "exactly as the server does" (S:176), and `parseJob` rejects
`bypassPermissions` (P:92). S:178–180 says an invalid file appends `refused` with `why: invalid: <line>` and does not run, on both triggers. P:110 expects
`end.error`, which needs a `start` the spec says is never written. → Expect a `refused` record with `why` starting `invalid:` and no `start`. Separately,
test the wrapper's own guard (S:194) by mutating the parsed job, or drop that claim.

**I7. P:110 puts `session` on `step-end`; the spec has it on `step-start`** (S:213; `step-end` fields at S:214 have no `session`). The wrapper generates the
uuid before launch (`--session-id`), so it belongs on `step-start`. → Assert `step-start.session` matches `/^[0-9a-f-]{36}$/` and equals the `--session-id`
argv. Drop `session` from the `step-end` list.

**I8. P:110: the wrapper's refusal matrix is half-tested.** S:177–180 lists four refusals (`file gone`, `invalid: <line>`, `disabled`, `not this machine`).
A manual run is allowed only for `disabled`. P:110 tests `file gone` and `disabled` on schedule, and `disabled` on manual. → Add: invalid file + schedule →
`refused why invalid: <line>`; file naming only `wsl` with `SCHEDULE_MACHINE=mac` → `refused why "not this machine"`; manual + file gone, manual + invalid
and manual + other machine → each refused.

**I9. P:110: three spec-stated wrapper behaviours have no case.** (a) A `foreach:` name absent from `pins.json` → step `skipped`, `why "not pinned"` (S:99,
S:189–190). (b) The clamp to `SPAWN_MAX_PERMISSION` (S:194–195): a file asking `auto` with `SPAWN_MAX_PERMISSION=acceptEdits` must launch with
`--permission-mode acceptEdits`. (c) An absent `permission-mode` → `SYNC_PERMISSION_MODE` (S:195). The wrapper cannot import `spawn.ts` `clampPermission`
(`server/lib/spawn.ts:106`), so it re-implements the ladder. That re-implementation is a permission ceiling and needs a test. → Add these three cases to
T4 Step 1.

**I10. P:31, P:72, P:75: the "validation error on mac naming the rule" in Review Focus 1 is never produced.** T1 only returns `null` from
`toCalendarIntervals`. No task turns that into a `JobError`, gives its message, or says it applies only when `machines` includes `mac` (S:148), and T2's
test list has no such case. → Add to T2: `parseJob` calls `toCalendarIntervals` when `machines` includes `mac`. Give the exact message (e.g.
`cron: launchd cannot run a job on both a day of month and a weekday`). Add the `0 9 1-5 * 1` + `machines: [mac]` → error case, plus the
`machines: [wsl]` → ok mirror.

**I11. P:119: `createLogReader(dir, liveness)` cannot apply the age rule.** The rule is `timeout × steps + 5 min` per job (S:219, S:345), but the reader
has no access to job timeouts, and the `start` record carries `steps` but no `timeout` (S:212). → Add a `timeoutMsFor(job) => number` parameter, defaulting
to 60 m for a deleted job. Make P:124's "age under the rule / over" cases name exact ages (e.g. 1 step, 30 m timeout: 34 m → running, 36 m → lost).

**I12. P:124 and P:218: log rotation has no task.** S:225 has the server rename a file past 20 MB to `<machine>.<yyyymmdd>.jsonl`. T5 only *reads* rotated
files, yet the self-review (P:218) claims rotation is covered. Who rotates is open too: the owner only (S:128 forbids non-owner writes), and the wrapper
keeps appending. → Add a `rotateIfLarge(dir, now, limit)` produce to T5 (owner-only call site in the wiring task). Test: a 20 MB+1 B file is renamed, the
next append starts a new file, and the reader's offset cache resets via the inode change.

**I13. P:138: the pins writer is hooked into `setPinned`/`setPinOrder`, which cannot call it.** Both take no `config` (`server/lib/settings.ts:341`,
`:357`), but `writePinsSnapshot(config)` needs one for `listPinRows(config, …)` (`server/lib/management.ts:713`). `settings.ts` already imports
`management.ts` (`settings.ts:35`), so importing `schedule-store` there adds a `settings → schedule-store → settings` cycle. The route handlers have `config`
and already rebuild the rows (`server/api.ts:1842`, `:1857`, `pinsPayload` `:1702`). → Call `writePinsSnapshot(config)` from `servePinsWrite`/`servePinsOrder`
after a successful set, with the same `archivedIds`/`pinnedDirs` options `pinsPayload` uses. Make it a no-op on a non-owner, and test that mirror.

**I14. P:140–142: no task produces the server's lock sweep or its wrapper-liveness check, yet T5, T8 and T10 need them.** S:183 says the server sweeps
stale locks on start, the only time it writes under `locks/`. T5 takes `liveness` injected (P:119), T8 defers on "lock held by a live wrapper" (P:151), and
T10 checks the command line before SIGTERM (P:167). None names a function that does `kill(pid,0)` + boot id + `ps -o command=`. P:142 tests only that a held
lock *survives*, not that a stale one is removed. → Add to T7's Produces: `wrapperAlive(pid, job): boolean | null` and `sweepLocks(dirs)`. Test a dead pid,
another boot id, and a live pid running another command → removed, and a live matching wrapper → kept. T5, T8 and T10 consume these by name.

**I15. P:138, P:147, P:172: start-up and watcher wiring in `server/index.ts` has no task.** T7 adds the owner claim and pins write, and T11 adds routes.
Nothing wires these:
- reconcile on start (S:157)
- `startReconcileWatchers` (S:157–159)
- the stale-lock sweep (S:183)
- the log reader and its `fs.watch` + on-start fold for pushes (S:316)
- `releaseOwner()` on clean exit (S:129)

→ Add a wiring step (T11 or a new task) that lists each call and its owner-only guard. Test it with the existing `withServer` harness: a non-owner server
starts no watchers and writes nothing under the state root.

**I16. P:98: `scripts/sync-plugin.ts` POSTing `/api/schedules/reconcile` (S:159, S:336) has no task.** T3 touches that file only for `PUBLISHED_PATHS`.
→ Add it to T3 or T8 with its behaviour: best-effort, a server that is down is not an error, the configured port, a local-trust write. Test it with an
injected request function.

**I17. P:172/P:174: `test/write-paths.test.ts` will fail.** It deep-equals every `serve*` handler that calls `refuseWrite(config, req, res)` against
`GATE_ONLY_WRITES` (`test/write-paths.test.ts:33-36`, `:74-76`) and counts the gate calls (`:78-82`). Every new schedule write handler changes both. T11's
Files do not name it. → Add `test/write-paths.test.ts` to T11 with the new handler names listed.

**I18. P:174: the server never runs `checkPins` at validation.** S:100 and S:257 say "validation refuses the file naming both `dirName`s", run by the server
at validation. T2 produces `checkPins`, but T7/T11 never call it from `PUT`/`POST`/`/validate`/`readJobs`. → In T11, `PUT`, `POST` and `/validate` run
`checkPins(job, currentPinRows)`. Add a case: two pins sharing `lookout` + `foreach: [lookout]` → `422` with the ambiguity error.

**I19. P:186–190: the `run` deep-link param is lost, and opening the fold has no task.** `createDeepLink` reads the params once and strips the URL on the
first accessor call (`client/src/lib/deepLink.ts:55-70`). A standalone `readRunParam` called later sees an empty search. `DeepLink.view()` and
`takeManagementTab()` are typed `'git' | null` (`:43`, `:49`). T14 never says `?run=<id>` opens that run's fold (S:320). → Extend `DeepLink` with
`run(): string | null` read in the same `consume()`, and widen both types. Add a T13 case: `?view=schedules&run=abc` → `takeManagementTab() === 'schedules'`
and `run() === 'abc'`, with the URL stripped once. Add a T14 step: open the run's fold (Runs view filtered to its job) on load.

**I20. P:188: `ScheduleJobRow` is consumed but never produced, and the `GET /api/schedules` job shape is never specified.** P:46 lists the types without it.
T11 (P:172) adds `SchedulesResponse` with no fields. S:239 needs per job: the parsed file, validity, `installed`, `nextAt`, last-run summary and running
state. T14 also needs `mtimeMs` for the `on disk changed` chip (P:201) and the per-step `n of N`. The reconcile block lacks `drift[]` (S:239; P:149's
`ReconcileReport` has `changes`). → Define `ScheduleJobRow` (name the fields) and `SchedulesResponse` in T11's types step. Make T13 consume the same name.

**I21. P:190: the day labels are wrong for the plan's own dates.** `Yesterday · Sat 18` / `Wed 15` come from the mockup, but the plan's dates are October
2026 (P:75). 2026-10-19 is a Monday, so yesterday is Sun 18 and the 15th is a Thursday. No `now` is given, so the case passes or fails by guess. → Fix
`now` to `2026-04-19T12:00` local (a Sunday), and runs on 04-18 and 04-15.

**I22. P:203: the T14 verification can fire real jobs and pushes on the user's machine.** The run log lives under the real `~/.claude/schedules/`
(P:23), so "a seeded log" writes fake runs into the user's log. An owner server folds them and sends `schedule-failed` pushes to the phone (S:316).
"Toggle a job and confirm the file diff" needs an owner (S:127), and the toggle reconciles, writing plists for the mock jobs into `~/Library/LaunchAgents`
with an installed-plugin wrapper path that has no `lib/` until `plugin:sync`. No teardown is stated. → Say how the dev server is isolated:
- point `SCHEDULES_DIR` at a tmp folder
- make the state root injectable (`scheduleStateRoot(home)` exists at P:131) and point it at a tmp dir
- make every mock job `machines: [wsl]` on a Mac, so reconcile installs nothing
- leave notify off
- teardown: kill the recorded pid, remove the tmp dirs, and check `launchctl list | grep com.claude-dashboard.schedule` is empty

**I23. P:197: four spec behaviours outside S's UI section are not in T14.** They are `late` beside the time on the row and Runs page (S:44–45), hiding
every write control and showing `owned by <cwd>:<port>` on a non-owner (S:126–128), the `acceptEdits` amber note in the drawer (S:328), and the `?run=` fold
(I19). T14 says "behaviour per the spec's UI section", which does not reach them. → List them in T14 Steps 1–3, and put the non-owner read-only view in the
Step 5 checklist.

**I24. P:174: route name validation is untested and its status is unspecified.** S:331 says names are validated `[a-z0-9-]+` before they touch a path.
T11 tests `404` for an unknown name only. → Add: `GET/PUT/DELETE/PATCH /api/schedules/..%2Fx` and `/api/schedules/Bad` → `400 bad name`, with no
filesystem access (assert the folder is untouched).

**I25. P:181: T12's test passes before the guard exists, so it proves nothing.** Every hook exits at once unless `CLAUDECODE=1`
(`scripts/stop-notify-hook.sh:36`, `ask-remote-hook.sh:31`, `remote-decision-hook.sh:57`, `plan-remote-hook.sh:35`, `permission-notify-hook.sh:48`), and
the plan's env does not set it. A closed localhost port refuses in microseconds, so `curl -m 1` never waits and "elapsed < 200 ms" holds without the guard.
P:182 also says to place the guard "beside the `CLAUDE_DASHBOARD_REFRESH` one", but only `stop-notify-hook.sh:42` has that guard. → Set `CLAUDECODE=1`.
Point `CLAUDE_DASHBOARD_URL` at a local listener that records requests, and pass a payload that would reach the probe. Assert zero requests with the marker
and at least one without it (the mirror). Place the guard right after the `CLAUDECODE` line in the four scripts that have no `REFRESH` guard.

## Minor

- P:13 sets the 160-column wrap, but 71 plan lines are longer than 160 columns (e.g. P:92 at 1766, P:110 at 1887, P:151 at 1524). The checkbox paragraphs
  would read better as one sub-bullet per case.
- P:182 contains literal code (`[ -n "$CLAUDE_DASHBOARD_SCHEDULE" ] && exit 0`), against P:13's "never literal code". It is harmless as a one-liner.
- P:44 says `schedule-file.ts` holds the "`Job` type", but P:86 puts `ScheduleJob` in `shared/types.ts`. Pick one.
- P:87 `parseJob(name, text)` and P:73 `describeCron(cron)` differ from S:257 `parseJob(text)` and S:268 `describe(expr)`. The extra `name` parameter is
  justified; note the rename so the spec can follow.
- P:149 `planReconcile(config): ReconcileReport` is synchronous, but it needs `launchctl print` / `crontab -l` / `pgrep` through an async runner shaped like
  `FetchRunner` (`server/lib/git-fetch.ts:54-100`). Make it `Promise<ReconcileReport>`.
- P:151 "plist on disk but `print` exit 1 → `drift`": say whether that is the job's `action` or the report's `state`. Drift is post-apply per S:161.
- P:197 says to open the ChatDrawer "through the same `openChat` shape `useGitSync` exposes", but `openChat` is `setChatId` and resolves the row from the
  live sessions poll (`client/src/hooks/useGitSync.ts:122-123`), so an old run would get `null`. Say: keep the fetched `Session` row in state and pass it to
  `<ChatDrawer session=…>` as `GitView.tsx:98` does.
- P:142 says a "concurrent reader never sees a partial file (write 1 MB, read in a loop)", but a synchronous write and a loop in the same process cannot
  interleave. Use a child-process reader, or assert only "no `.tmp`, full content, rename used".
- P:124 says "assert your own fixture's totals" for `computeStats`. Name a small exact fixture instead (e.g. 3 runs: costs 1.20/0.00/2.40, one failed) so
  the expected numbers are written down.
- P:156: `PHRASE`/`TAGS` are `Record<NotifyEvent, string>` (`server/lib/notify.ts:133`, `:140`) and `DEFAULT_NOTIFY.events` is a full record
  (`server/lib/settings.ts:58`), so each needs a `schedule-failed` entry. `NOTIFY_EVENTS` is not exported (`settings.ts:65`), so test "five entries" through
  the policy parser. The desk route's click is `deskClickUrl` (`notify.ts:291`), not the run URL; say which applies when the desk route wins.
- P:19 names CLAUDE.md lines 16 and 63, but line 10 also says "two zero-dep modules both sides run". Amend all three, plus `docs/overview.md:159`'s
  `shared/` map.
- P:172: `/api/sessions/:id/row` must be routed before the catch-all `[^/?]+` session routes (`server/index.ts:417-425` comments). Say so.
- P:174: `SCAN_CAPS` is not exported (`server/api.ts:87`). Use a fixture older than 168 h, or export it.
- Missing mirror cases:
  - T1: `nextAfter` OR semantics when both day fields are restricted (`0 9 1 * 1`).
  - T4: `late` is false at 5 min past the slot.
  - T5: truncation and inode change re-read from 0.
  - T9: a successful run is never pushed.
  - T2: `effort: very high` → one-token error.
- P:110 does not say how to stage a lock held by a live process whose `ps` command line is `run-schedule <job>` (e.g. a spawned `node -e …` with that argv).
  It also does not say how to reach "20 min after the slot" without a clock flag (S:351 allows only `--trigger`/`--only`): derive the cron from
  `now − 20 min`, or add a test-only env clock and say so.
- P:110 does not assert `--model`, `--effort` or `--allowed-tools` in the fake CLI's argv.
- P:75 `toCalendarIntervals` uses a cartesian expansion with no cap. `*/5 */2 * * 1-5` gives 720 dicts. A cap with an error is cheap.
- P:129 and P:208 both modify `.env.example`. Keep it in T6.
- P:101 does not say where `'lib'` goes in `PUBLISHED_PATHS`.
- P:203 records what was not verified, but it does not name teardown of the dev servers by recorded pid (memory: kill by recorded pid).
- Spec inconsistencies the plan inherits:
  - `CLAUDE_BIN` unset: S:197 says the step ends `failed`, S:215 says `end.error`. The plan follows S:215.
  - Reveal: S:295 says "the existing open-folder route", S:250 and S:297 say `/reveal`.
  - Wrapper path: S:164 says `bin/run-schedule.mjs`, S:165 says `lib/`.

## Coverage map (spec → task)

| spec section | task | gap |
|---|---|---|
| Job file (S:69–106) | T2 | I1, I2, I10; S:99 `not pinned` → I9 |
| Pins on disk (S:108–112) | T7 | I13 |
| Machine identity (S:114–118) | T6, T4 | wrapper `not this machine` → I8 |
| Owning server (S:120–129) | T7 | sweep → I14; release on exit and non-owner UI → I15, I23 |
| Reconcile (S:131–168) | T8 | sync-plugin POST → I16; wiring → I15 |
| Wrapper (S:170–204) | T4, T12 | I5–I9, I25 |
| Run log (S:206–225) | T5 | I11, I12 |
| Launching on demand (S:227–233) | T10 | — |
| HTTP surface (S:235–253) | T11 | I17, I18, I20, I24 |
| Shared modules (S:255–270) | T1–T3 | I4 |
| UI (S:272–308) | T13, T14 | I19–I23 |
| Notifications (S:310–322) | T5, T9 | wiring → I15 |
| Security (S:324–331) | T2, T4, T11 | I24 |
| Left to the builder: docs (S:359–360) | T15 | — |

## Interfaces and order

- Consumed but never produced: `ScheduleJobRow` (P:188, I20); a server wrapper-liveness helper (I14); `readRunParam`'s data source (I19).
- `planReconcile` sync vs async (Minor).
- Order is otherwise sound. T1 → T2 → T3 → T4 holds for the generated modules, and T7 precedes T8–T11, which use `isOwner`.

## Decisions and parked questions (autopilot)

- Decision 8: C1 is graded Critical under the caller's rubric (it contradicts a CLAUDE.md hard rule), though the fix is one line.
- Parked #2: the ambiguous-pin outcome (I5).
- Parked #3: `cwd` with `foreach` in the spec example (I1).
