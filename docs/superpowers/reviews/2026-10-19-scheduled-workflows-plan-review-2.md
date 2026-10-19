# Scheduled workflows plan — review 2 (narrow re-check)

Plan: `docs/superpowers/plans/2026-10-19-scheduled-workflows.md` (P). Spec: `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` (S).
Scope: only the lines changed in c2c2be9 ("address scheduled workflows plan review 1"), read against the working tree on `docs/scheduled-workflows-spec`.
Code claims were checked by reading the code (`grep`/`sed` over the named files). Line numbers are the plan's current lines.

## Verdict: APPROVE WITH FIXES

Review 1's findings are largely resolved. The fixes are correct: the example-file timeout, the `30s` grammar, the `ALLOWED` reversal, the
`PUBLISHED_PATHS` value, the refusal matrix, `step-start.session`, `timeoutMsFor`, `rotateIfLarge`, `sweepLocks`, boot wiring, the deep-link `run` and
the hook-test redesign. The groupRunsByDay date fixture is checked: 2026-04-19 is a Sunday, the 18th a Saturday and the 15th a Wednesday.

There are no Critical findings and eight Important ones. Each Important one is a small fix. Two carry the most weight:

- The new per-file run convention silently runs nothing for seven existing test files.
- The new `wrapperAlive` rule contradicts its own test fixture.

## Critical

None.

## Important

**I1. P:11–13, P:265–266: running a file on its own runs nothing for seven existing test files the plan extends.** The convention runs each task with
`pnpm tsx test/<file>.test.ts`. That relies on the `import.meta.url === file://…` main guard, and only new files are told to add it. These existing files
are extended but have no guard: `test/frontmatter.test.ts` (T2), `test/plugin-manifest.test.ts` and `test/sync-plugin.test.ts` (T3),
`test/notify.test.ts` and `test/settings.test.ts` (T9), `test/client-settings.test.ts` and `test/deep-link.test.ts` (T13). Running `grep -c
'process.argv\[1\]'` on each gives 0. Each file ends at `return f; }`, for example `test/sync-plugin.test.ts` at its tail. In total, 18 of 144 test files
have the guard.

On these files, `pnpm tsx` imports the module, defines `run()` and exits 0 with no output. As a result, every "run → FAIL" and "run → PASS" step for T2,
T3, T9 and T13 is a no-op that reads green. T15 Step 2 then reports these files as green with no evidence.

→ Extend the convention: "a task that extends an existing test file without the guard adds it (one line, as `test/scan.test.ts:1232`)". Alternatively,
list the seven files by name in their tasks' Files.

**I2. P:162–163 vs P:167: the `wrapperAlive` match rule fails its own fixture.** The rule says the `ps -o command=` output "contains `run-schedule <job>`".
The test's live command is `node …/run-schedule.mjs git-sync-all --trigger schedule`, and that string does not contain `run-schedule git-sync-all`
because `.mjs` sits between the two words. T10's argv (P:193, `[node, wrapperPath, name, …]`) and T4's own liveness rule (P:128) produce the same shape.
Built as written, the rule declares every real wrapper dead. `sweepLocks` would then delete held locks (Review Focus 5 inverted), and the reader would
mark running runs `lost`.

A plain substring rule would also let job `git-sync` match a `git-sync-all` command line.

→ State the rule as token match: an argv element whose basename is `run-schedule.mjs`, immediately followed by an element equal to `<job>`. Apply it at
P:128, P:163 and in T10's `stopJob`. Add the mirror case: job `git-sync` against a `run-schedule.mjs git-sync-all` command line → not alive.

**I3. P:166: "`sweepLocks` with a fake `ps`" has no seam in T7.** T7 produces `wrapperAlive` and `sweepLocks` but no runner override. The only process
seam in the plan is `setScheduleRunner`, which T8 produces later (P:175), so T7's test depends on a later task or on a seam it never names (checklist
items 4 and 5).

→ Give T7 its own `setProcessProbe(fn | null)` seam, or a `ps` reader parameter on `wrapperAlive` and `sweepLocks`. Alternatively, move the runner seam
into T7 and have T8 consume it.

**I4. P:207–209 and P:214: `schedule-boot.test.ts` "with fakes for every call" has no injection point.** `startSchedules(config)` takes only `config`.
The seven calls are ESM imports from four modules (T5, T7, T8, T9), and ESM bindings cannot be swapped from a test. The implementer has to invent a
dependency-injection shape.

→ Specify the seam, for example `startSchedules(config, deps = defaultDeps)` where `deps` holds the seven functions. The test passes recording fakes.

**I5. P:207–208 and P:214: "non-owner → none of them [the seven calls]" is wrong for an opted-in server that loses the claim.** `claimOwner` is the call
that decides ownership (S:124–126), so a `SCHEDULES_OWNER=true` server that finds a live owner necessarily calls it. The other six must then not run.
As written, the test expects zero calls and fails against a correct implementation.

The P:207 sentence "when owner — `claimOwner`, …" has the same circularity.

→ Rewrite the cases as two:

- Flag off: no calls at all.
- Flag on, `claimOwner` returns `{ ownedBy }`: exactly one call (`claimOwner`), and none of the other six.

**I6. P:212: "a name `../x`, `Runs` or `runs` on any route → `400 { error: 'bad name' }`" contradicts the spec and the route table.** S:71–73 treats
these names differently:

- A name outside `[a-z0-9-]+` is a route-level `400`. That covers `../x` and `Runs`.
- The reserved names match the pattern and are "refused by validation" (T2's `name is reserved`, P:97). So `POST /api/schedules {name:'runs'}` is a
  `422` with that error.
- `GET /api/schedules/runs` is the runs list itself (S:242). It must answer `200`, never `400`.

→ Split the case:

- `../x` and `Runs` on `GET`, `PUT`, `PATCH` and `DELETE /api/schedules/:name` → `400`.
- `POST /api/schedules` with `name: 'runs'` → `422` naming the reserved rule.
- `GET /api/schedules/runs` → the runs payload.

**I7. P:152 and P:253–256: the `SCHEDULES_STATE_ROOT` seam moves `owner.json`, which defeats the one-owner lock, while launchd and crontab stay
machine-global.** The verification recipe starts a second opted-in server (`SCHEDULES_OWNER=true`) with its own state root. It therefore finds no
`owner.json`, becomes owner and runs `applyReconcile`. On a mac, "installed" means every `com.claude-dashboard.schedule.*` plist in
`~/Library/LaunchAgents` (S:136–137), and "desired" is a tmp folder of wsl-only jobs. After this feature is merged and the main server owns real jobs,
that verification server would remove every one of them. That is exactly what the owner lock exists to prevent (S:122–129).

Two further gaps:

- The wrapper never sees the seam. `scheduleEnv` is "exactly" seven keys (P:151) and T4 resolves the root from `HOME` (P:117), so a Run now during
  verification writes to the real `~/.claude/schedules/runs/`.
- T6's Files and tests omit the Config field and give no test case for the key (see M2).

→ Pick one of these:

- Keep `owner.json` at the real `~/.claude/schedules/owner.json` regardless of the seam.
- Make the seam also redirect the LaunchAgents directory and the crontab runner.
- Have T14 verify with reconcile apply disabled.

Whichever is picked, say in P:152 that the wrapper does not honour the seam, or add the key to `scheduleEnv`.

**I8. P:107–108: "a recording listener sees exactly one POST after install" cannot be tested as written.** `scripts/sync-plugin.ts` `main()`
(`:146–200`) is a monolith. It runs `execFileSync('claude', …)` for the marketplace update, uninstall and install, and runs only under the main guard
(`:202`). No exported function covers "after a successful install", so the test can reach the POST only by faking the `claude` binary on `PATH` and a git
checkout. The plan names no seam, no function name and no timeout for the best-effort call.

→ Name an exported `postReconcile(port: number, timeoutMs: number): Promise<boolean>`, called from `main()` after the reinstall succeeds. Test it
directly: the listener sees one `POST /api/schedules/reconcile` with body `{ apply: true }`, and a closed port resolves `false` without throwing. Also say
whether the port comes from `loadConfig().port`, which gives `process.env` precedence over `.env`, or from the raw `.env` file.

## Minor

- **M1. P:21–23 vs S:62 and S:361.** The spec has `test/outbound.test.ts` "updated for the new launches". The plan leaves the file untouched and only edits
  the CLAUDE.md paragraph (P:173). The repo's pattern for launch-only modules is a prose test per file, `test/outbound.test.ts:115–125` for
  `git-fetch.ts`/`git-quick.ts`. Add the same cases for the new launching files so the CLAUDE.md line cannot silently drop them.
- **M2. P:149, P:152, P:154: Config has no field for `SCHEDULES_STATE_ROOT`.** `loadConfig` reads `.env` per field (`server/lib/config.ts:299–334`); there
  is no generic key bag. T6's Files list `schedulesDir`, `scheduleMachine` and `schedulesOwner` only, and Step 1 has no case for the state root (set,
  unset, `~` expansion).
- **M3. P:159–160: the stated cycle reason is not the real one.** `settings.ts:35` imports `management.ts` only for `claudeHome`, and `management.ts`
  does not import `settings.ts`. The actual cycle is that `writePinsSnapshot` needs the pin order from settings, because `listPinRows(config,
  dirNames)` takes the names (`server/lib/management.ts:713`). So `schedule-store` → `settings` → `schedule-store`. The conclusion stands; the reason
  is misleading.
- **M4. P:199: `server/index.ts` has no SIGINT/SIGTERM handler today.** The only one is `process.on('unhandledRejection')` at `:80`. The new handlers must
  call `process.exit` after `stopSchedules()`, or Ctrl-C and `tsx watch` restarts (`package.json` `dev`) stop exiting. Say so.
- **M5. P:138, P:143, P:207: `rotateIfLarge` has three gaps.** It takes no `now`, so "today's `<yyyymmdd>`" flakes across midnight in the test. A second
  rotation on the same day would `rename` over the first rotated file and lose it. It is called only at start, so a long-running owner never rotates.
  Add `now: Date`, a collision suffix or refusal, and a call on the runs watcher.
- **M6. P:136–137: no fallback for a deleted job.** `timeoutMsFor` has no stated value for a job whose file is gone, yet its runs stay in the log. Say
  `3_600_000` (the spec default).
- **M7. P:205–206 vs S:241: the reconcile shape differs from the spec.** `SchedulesResponse.reconcile` is `ReconcileReport` (`changes[]`, `unchanged`),
  while the spec's GET shape says `{ state, drift[], error, at }`. Fine as a refinement, but note that the spec's `drift[]` is `changes`.
- **M8. P:222–225: "a minimal payload" is per-script.** A request is reached only with these fields:
  - `ask-remote`: `session_id` and `tool_input`, with no `running` file under `$HOME/.claude/autopilot/<sid>.json` (`ask-remote-hook.sh:43–53`). An
    autopilot session on the dev machine would otherwise exit before the probe.
  - `remote-decision`: `permission_mode: auto` (`:65–71`).
  - `plan-remote`: `tool_name: ExitPlanMode` (`:45`).
  - `permission-notify`: a permission notification (`:64–86`).
  - `stop-notify`: `session_id` and no background tasks (`:50–55`).

  Name these fields and run every script with `HOME` set to a tmpdir.
- **M9. P:173: the CLAUDE.md edit does not say which files to name.** It should name `lib/schedule-reconcile.ts` (`launchctl`, `crontab`, `pgrep`),
  `lib/schedule-store.ts` (`ps`, from T7's `wrapperAlive`) and `lib/schedule-run.ts` (`node` plus the wrapper).
- **M10. P:276: elided path.** `…-plan-review-1.md` should be the full path `docs/superpowers/reviews/2026-10-19-scheduled-workflows-plan-review-1.md`.
- **M11. P:98–99: an exact message wraps inside backticks** (`… use` / `one`). Markdown renders it as one space, but an implementer copying the string
  from the raw file gets a newline. Keep exact strings on one line.
- **M12. P:122–124: manual refusals and `/run` disagree.** Manual refusals exit 0 with no `start`, so T10's `/run` returns `202 { run: null }` after 2 s
  for an invalid or other-machine file (P:193). The spec is silent; consider having `/run` validate first and answer `422`/`409` instead of a slow
  null.
- **M13. P:253, P:256: the server's pid is not the session's to record.** `preview_start` starts the server through `.claude/launch.json`, so "record the
  pid you started" does not hold. The repo's worktree recipe starts servers via Bash on 4273/5273 and records `$!`. Pick one.
