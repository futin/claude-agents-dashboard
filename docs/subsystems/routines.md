# Routines (the Routines section)

Jobs are markdown files in a folder that syncs through git (default `~/claude-global/routines/`). The dashboard turns them into launchd jobs (macOS) or
crontab lines (WSL), shows the ledger and the run log, and pushes a phone notification when one fails. **No scheduler runs in the server.** The OS fires
a plain-Node wrapper, `plugin/lib/run-routine.mjs`; the server installs jobs, launches one on demand and reads what the wrapper wrote. A server that is
down at 22:00 costs nothing: the job still runs, and the run shows up in the log when the server is back.

The design spec is `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md`. Where this page and the spec differ, the code and this page win;
each difference is an "Amended 2026-10-20 in implementation:" note in the spec.

**After merging a change under `plugin/` (the wrapper, `plugin/lib/*`), run `pnpm plugin:sync`.** The installed plugin is a snapshot, not a link, so
launchd and cron keep running the old wrapper until it is reinstalled; `scripts/sync-plugin.ts` then POSTs `/api/routines/reconcile {apply: true}` to a
running server so the baked wrapper path moves with the new versioned directory. `PUBLISHED_PATHS` includes `lib`, or a wrapper edit would never count as
a change.

## Renamed from Schedules (2026-10-23)

The section was called Schedules until 2026-10-23. Every name moved, and every name that persists outside the repo is still read under its old
spelling, so a machine set up before the rename keeps working untouched — the WSL machine included — until its owner moves it:

| Old | New | How the old one is still honoured |
|---|---|---|
| `SCHEDULES_DIR`, `SCHEDULE_MACHINE`, `SCHEDULES_OWNER`, `SCHEDULES_STATE_ROOT` | `ROUTINES_*`, `ROUTINE_MACHINE` | `loadConfig` and the wrapper read the old name when the new one is unset; the new one wins |
| `~/claude-global/schedules` | `~/claude-global/routines` | the default job folder falls back to the old one while only it exists (`orLegacy`, server and wrapper alike); a set `ROUTINES_DIR` is never swapped |
| `~/.claude/schedules` | `~/.claude/routines` | read while only it exists; the owner renames it on start (`migrateLegacyState`) |
| `com.claude-dashboard.schedule.<name>` | `com.claude-dashboard.routine.<name>` | reconcile boots out and deletes each old-label plist, then installs the new one; a running one waits as `pending · running` |
| `# >>> claude-dashboard schedules >>>` block | `# >>> claude-dashboard routines >>>` | reconcile reads an old-marker block and replaces it in place |
| `run-schedule.mjs`, `CLAUDE_DASHBOARD_SCHEDULE` | `run-routine.mjs`, `CLAUDE_DASHBOARD_ROUTINE` | a still-running old wrapper counts as live; the hooks stay quiet under either marker |
| `schedule-failed` notify key, `?view=schedules`, `schedulesTab` / `scheduleWindow` / landing `schedules` | the `routine*` spellings | read and mapped to the new name |

The run log's `trigger: 'schedule'` value is not a name of the section — it means "fired by its cron" — and did not change.

The state move waits for two things: the new wrapper must be installed (`run-routine.mjs` found), or an old wrapper would go on appending to the old run
log; and no `.lock` may be held, or a running job would. So the order on each machine is: merge, `pnpm plugin:sync`, restart the owner server. Renaming
the `.env` keys and `git mv`-ing the job folder are optional and can come any time after.

| Path | Holds | Written by |
|---|---|---|
| `ROUTINES_DIR` (default `~/claude-global/routines`) | `<name>.md`, one job per file | the user, git, the editor drawer (owner only) |
| `~/.claude/routines/` (the *state root*) | everything below, machine-local, never under git | |
| `runs/<machine>.jsonl` | the append-only run log; rotated to `<machine>.<yyyymmdd>.jsonl` at 20 MB | the wrapper (appends), the owner (rotates) |
| `locks/<job>.lock` | the job lock: pid and boot id | the wrapper; the owner sweeps dead ones on start |
| `launchd/` | the plists' stdout and stderr files (mac) | reconcile creates it, launchd writes the files in it |
| `pins.json` | `[{dirName, name, path}]` in pin order, what `foreach:` resolves against | the owner, on start and when pins change |
| `owner.json` | `{pid, bootId, cwd, port, at}`, the owner claim | the owner |
| `notified.json` | `{seen: {<run id>: <ms>}, floor?}`, the runs already pushed, pruned at 7 days | the owner |
| `cron.env` | the baked environment, WSL only (0600) | reconcile |

`ROUTINES_STATE_ROOT` moves the whole state root; it is a verification seam, see [Test seams](#test-seams).

## The job file

One file per job. The name is the filename without `.md`, matches `[a-z0-9-]+`, and is the launchd label suffix (`com.claude-dashboard.routine.<name>`)
and the log key. `runs`, `validate`, `reconcile` and `reveal` are reserved, because they are route segments. A route given a name outside the pattern
answers `400 {error: 'bad name'}` before touching the disk.

```markdown
---
cron: "0 22 * * *"
machines: [mac, wsl]
run: claude
foreach: pinned
model: opus
permission-mode: acceptEdits
timeout: 30m
---
/git-sync
```

| Key | Meaning |
|---|---|
| `cron` | five fields, local time of the machine that runs it, or `manual` (never installed; Run now only) |
| `machines` | `[mac]`, `[wsl]` or both; the job installs only where it is named |
| `run` | `shell` (the body's first fenced `bash` block, run as `bash -e <tmpfile>`) or `claude` (the body is the prompt; one line starting with `/` is a skill) |
| `foreach` | absent: one step in `cwd`; `pinned`: one sequential step per pinned repo; `[a, b]`: only those pins, by name (`dirName` when two pins share a basename) |
| `cwd` | only without `foreach`; default is the routines folder's parent |
| `enabled` | absent means true; `PATCH` rewrites only this line |
| `model`, `effort`, `allowed-tools`, `max-turns` | claude only, passed through to the CLI |
| `permission-mode` | claude only: `plan`, `acceptEdits` or `auto`, never anything else (`bypassPermissions` is refused, not clamped); absent means the baked `SYNC_PERMISSION_MODE` |
| `timeout` | `30s`, `30m` or `2h`; the wrapper kills the step after it; default 60m |

An unknown key is a validation error naming the key. A cron that launchd cannot express (day-of-month and weekday both restricted: cron ORs them, launchd
ANDs them) is an error for any file that names `mac`. Step values and ranges are expanded into a list of `StartCalendarInterval` dicts. The parser, the
writer and the validator are `shared/routine-file.ts` and `shared/cron.ts`, which the server, the client and the wrapper all run; the wrapper's copies are
generated (`pnpm plugin:gen` writes `plugin/lib/*.mjs`, and `test/plugin-manifest.test.ts` regenerates and compares, so an edit to the `.ts` without
regenerating fails CI).

A `foreach` name that is not pinned on the running machine is skipped there (`skipped: not pinned`). A pin that is unlisted or has no path is skipped with
`pin unlisted`. No `pins.json` ends a fan-out run before its first step with `end.error` `no pins snapshot`.

## Machine identity

`ROUTINE_MACHINE` (`mac` or `wsl`) if set; any other value is shown as `bad ROUTINE_MACHINE` on the chip and installs nothing. Otherwise the detection
`~/claude-global/bootstrap.sh` uses: Darwin is `mac`, everything else is `wsl`. The wrapper resolves it from the same variable, baked into its
environment, so a file and its installed job always agree. `server/lib/routine-config.ts` holds it, and the three folders, as pure functions of `Config`
and an injectable host.

## The owner

Pins, settings and the write routes are per checkout, and a second server from a worktree on another port is routine. Only one server per machine may
install OS jobs, write `pins.json` or sweep locks, so a server opts in with `ROUTINES_OWNER=true` and then takes `owner.json` if it is absent or its pid is
dead or from another boot. A second opted-in server that finds a live owner runs read-only.

| Server | `GET /api/routines` `owner` | Writes | Pushes |
|---|---|---|---|
| owner | `'owner'` | all | yes, and keeps `notified.json` |
| opted in, lost the claim | `{ownedBy: '<cwd>:<port>'}` | `409 not-owner` | no |
| not opted in | `{ownedBy: ''}` | `409 not-owner` | no |
| uses `ROUTINES_STATE_ROOT` | `{ownedBy: 'seam'}` | `409 not-owner` | no |

A non-owner serves jobs, runs and stats, the client hides every write control, and it never writes under the state root. The owner releases `owner.json`
on clean exit and on SIGINT or SIGTERM (`stopRoutines`); a crash leaves a dead pid the next start takes over. `startRoutines` (`routine-boot.ts`) does,
in order and each step failing on its own without taking `listen` down: lock sweep, pins snapshot, log rotation, first reconcile, reconcile watchers, then
the runs watcher that seeds and folds the log for pushes.

## Reconcile: files in, OS jobs out

`routine-reconcile.ts` plans a pure diff and applies it idempotently. **Desired** is every valid file with `enabled: true` and a `cron` other than `manual` whose `machines` names
this machine (the plan's removal reason for a manual file is `manual`, checked before `disabled`). **Installed** is, on mac, every plist under `~/Library/LaunchAgents/` labelled `com.claude-dashboard.routine.*` that `launchctl print
gui/<uid>/<label>` says is loaded (exit 0 loaded; 3 and 113 mean not loaded); on WSL, every line between the two marker comments of the user's crontab:

```
# >>> claude-dashboard routines >>>
# <<< claude-dashboard routines <<<
```

Checks run in this order, and the first that applies ends planning: not-owner, bad machine, plugin not installed (`no-plugin`), a control character in a
baked value, then the diff. The diff yields changes of kind `install` (why `new` or `not loaded`), `update` (why `changed` or `env changed`), `remove` (why
the skip reason or `file gone`) and `pending`. The chip state is one of:

| State | Meaning |
|---|---|
| `in-sync` | nothing to do |
| `drift` | at least one install, update or remove is outstanding, e.g. launchd refused a plist; re-read from the OS on every poll, never remembered |
| `failed` | an apply errored, planning could not proceed, or a crontab line is too long; `error` says why |
| `pending` | the only outstanding changes are deferred because the job is running |
| `no-claude` | the only outstanding changes are claude jobs held back because `CLAUDE_BIN` is unset |
| `not-owner`, `no-plugin`, `bad-machine` | the check that stopped it |
| `cron-down` | WSL only: `pgrep -x cron\|crond` found nothing, so installed lines fire nothing |

**Pending.** `bootout` kills a running job, so an update or remove of a job whose lock is held is deferred as `pending · running` and re-runs when the
runs watcher sees the `end`. Two further reasons are deferred rather than applied: `claude cli not configured` (a claude job on a machine without
`CLAUDE_BIN`; it installs nothing) and `crontab line too long` (below, which also makes the state `failed`).

**mac apply.** Write the plist (`StartCalendarInterval` from the cron, `ProgramArguments` = absolute `node`, the installed wrapper, the job name;
`WorkingDirectory` = the routines folder; stdout and stderr under `launchd/`), then `launchctl bootout` and `bootstrap gui/<uid> <plist>`.
`launchd/` is created first, because launchd never creates a log path's parent: without it every fire fails before exec and nothing is logged.

**wsl apply.** Rewrite only the marker block with `crontab -`, the rest of the crontab byte-identical. Unrecognised lines inside the block are removed. A
START marker with no END marker, or a `crontab -l` error other than "no crontab for", is `failed` and nothing is written. Each job line is

```
<cron> . '<state>/cron.env' && exec '<node>' '<wrapper>' '<job>'
```

and the environment is not on the line: `<state>/cron.env` (0600, written to a temp file and renamed) holds one `export K='v'` per key, with `'` written as
`'\''`. A line over **990 bytes** is refused (state `failed`, error `crontab line too long: <names>`, because some crons truncate near 1000). A control
character (`\n`, `\r`, `\0` or any other C0 character except tab) in a baked value is refused as `bad value in <KEY>` and also fails the state. A change in
the env file's content counts as an `update`.

**The baked environment.** `routineEnv(config)` builds one list for both an installed job and a `/run` spawn: `PATH`, `HOME`, `USER` and `LOGNAME` as the server sees them,
`CLAUDE_BIN`, `SPAWN_MAX_PERMISSION`, `SYNC_PERMISSION_MODE`, `ROUTINE_MACHINE` and `ROUTINES_DIR`. `.env` values live in `Config`, never in
`process.env`, so nothing reaches a child unless it is baked; without this `git`, `gh`, `pnpm` and the CLI's own plugin launches exit 127 under launchd
and cron, which hand a job no shell rc. `USER` (with `LOGNAME`, falling back to the OS account name when the server has neither) is what the `claude`
CLI looks its claude.ai login up by in the macOS Keychain; without it every claude step fails `Not logged in · Please run /login`. `RUN_ROUTINE_GRACE_MS` is a wrapper test seam and is not baked.

**Triggers.** Reconciles never overlap: one runs at a time and a trigger during one queues a single trailing re-run. They run on server start, on a
change in the routines folder, on a change to `installed_plugins.json` (a `pnpm plugin:sync` moves the wrapper's versioned directory), on `runs/` writes
while something is pending, after every save, toggle or delete, from the Reconcile button's Apply and from `pnpm plugin:sync`. `fs.watch` events are debounced
500 ms, because a `sync.sh pull` lands several files at once.

The wrapper path baked in is the **installed** plugin's `lib/run-routine.mjs`, never the repo checkout's. It is `lib/`, not `bin/`, because Claude Code
puts every plugin's `bin/` on the Bash PATH of every session.

## The wrapper

`plugin/lib/run-routine.mjs <job> [--trigger schedule|manual] [--only <pin>...]`: plain Node, built-ins only, nothing imported from `server/`. It is the
only process that runs a job. In order:

1. Read `<dir>/<job>.md` and validate it with the same module the server uses. On a `--trigger schedule` fire with a missing, invalid, disabled or
   other-machine file it appends a `refused` record and exits 0, because the dashboard may have been down when the file changed. A manual run of a disabled
   file is allowed (that is Run now on a paused job); the other three refuse manually too.
2. Take `locks/<job>.lock` with `O_EXCL`, pid and boot id inside. A live pid from this boot whose command line is `run-routine <job>` makes it append
   `refused` (`running`) and exit **75**; any other lock is stale and taken over, and the reader shows that run as lost. The boot id is the seconds of
   `sysctl -n kern.boottime` on mac and `/proc/sys/kernel/random/boot_id` on WSL.
3. A scheduled fire more than 10 minutes after its slot is marked `late` (never a manual one).
4. Compute the steps, append `start`, then per step `step-start`, launch in its own process group, wait (kill at `timeout`), `step-end`; then `end`.
5. Exit 0 if every step passed, **1** if not, and an `end` with `stopped: true` and exit **143**/**130**/**129** on SIGTERM/SIGINT/SIGHUP: the signal goes
   to the current step's process group, which has 10 s to exit before SIGKILL. A usage error is **64**. An error thrown mid-run exits 1 with no `end`
   record, so the run reads as lost.

A step is `ok` when the shell exits 0 or the claude result has `is_error: false`; `skipped` when its pin is missing or unlisted; otherwise `failed`, which
includes `timeout` and `stopped`. `end.failed` counts every non-ok, non-skipped step, and a run is failed when `failed > 0` or `error` is set.

The claude step is `claude -p --output-format json --session-id <uuid> --name '<job> · HH:MM'` plus the model, effort, permission mode, allowed tools and max turns from the
file, the prompt on stdin. The mode is clamped to `SPAWN_MAX_PERMISSION` the way `spawn.ts` does. With `CLAUDE_BIN` unset the run ends with `end.error`
`claude cli not configured`. `--name` (the run's local start time) writes a `custom-title` record, so the Sessions board leads with the job and shows the
project as a pill; every step of one run shares the name. See [spawn](spawn.md#routine-runs-the-other-detached-launch) for how Run now launches it.

**The hook marker.** The child gets `CLAUDE_DASHBOARD_ROUTINE=<job>` and `--disallowed-tools AskUserQuestion`. The five user-global hooks
(`ask-remote`, `plan-remote`, `permission-notify`, `stop-notify`, `remote-decision`) exit at once on the marker, so a step is never held for the answer
window and never pushes "finished"; the routine's own failure push is the only one. With the question tool disallowed a step cannot stop to ask, so a
prompt that needs an answer must say what to do instead. The marker is covered in [remote-message](remote-message.md) and
[hooks-setup](../workflows/hooks-setup.md).

## The run log

`runs/<machine>.jsonl`, one JSON object per line, never under git:

| Kind | Fields |
|---|---|
| `start` | `run`, `job`, `machine`, `trigger`, `at`, `slot` (scheduled only), `late`, `steps`, `pid` |
| `step-start` | `run`, `step`, `repo`, `cwd`, `at`, `session` (claude only) |
| `step-end` | `run`, `step`, `at`, `ms`, `exit`, `outcome` (`ok`, `failed`, `skipped`, `timeout`, `stopped`), `why`, `tail` (shell: last 20 lines), `cost`, `tokensIn`, `tokensOut`, `turns`, `model` |
| `end` | `run`, `at`, `ms`, `ok`, `failed`, `skipped`, `stopped`, `error` (only when the run failed before its first step) |
| `refused` | `job`, `at`, `trigger`, `why` (`running`, `file gone`, `invalid: <line>: <message>`, `disabled`, `not this machine`), `heldBy` |

`server/lib/routine-log.ts` folds the file into `RoutineRun` (`running`, `ok`, `failed`, `lost`, `refused`). **Lost is derived at read time, never
written**: a `start` with no `end` whose pid is dead, or alive but not running `run-routine <job>`, is lost. The age rule (older than the job's timeout
times its steps plus 5 minutes) applies only where the pid cannot be checked, so a laptop that slept mid-run shows `running` until the wrapper ends it, and
an `end` that arrives later supersedes the lost reading. A refusal gets the id `refused-<machine>-<job>-<epoch ms>`. The reader is incremental, keeping an
inode and byte offset per file and re-reading from 0 when either changes. Stats are over 7, 30 or 90 whole local days (`ROUTINE_WINDOWS`), built from
calendar arithmetic so a DST change cannot shift a run across a day, with the previous window of the same length beside it; refusals are not runs.

## Notifications

`routine-failed` is the fifth push event, next to the four session ones in [push-notify](push-notify.md#the-fifth-event-routine-failed). It sits under the
master switch and the desk or phone routing, has its own Settings checkbox, and is exempt from `requireAfk`, `requireRemoteAnswer` and `requireAutoMode`,
which gate interactive sessions that a 22:00 job does not have. `sendRoutineEvent` in `notify.ts` takes the run instead of a session id.

The owner folds the log on start, on an `fs.watch` of `runs/`, and on every poll, so a push goes out with no browser open. `notifyRoutineRuns` pushes each
run once, tracked in memory and in `notified.json`:

| Run | Title | Body |
|---|---|---|
| lost | `<job> · lost` | `started <time>, no end record · machine slept?` |
| refused (any `why` but `running`) | `<job> · not run` | the `why` |
| failed before its first step | `<job> · failed before start` | `end.error` |
| failed | `<job> · <n> of <N> failed` | the first failed step's `why` |

Success never pushes, and neither does a run that ended `stopped` (Stop, or SIGTERM from outside): it is marked seen and nothing is sent. A lost push is not
followed by a second one if the run later ends. On the first start, with `notified.json` absent, `seedRoutineNotify` marks every run older than 24 h as
notified without pushing, so installing the feature does not replay history. The click URL is `<publicUrl>/?view=routines&run=<id>`.

The fold has no window (rotation renames log files, never deletes them), so the dedupe is bounded by age, not by count. Only a run whose end, or for a lost
or refused run whose start, falls within `PUSH_HORIZON_MS` (7 days) can push. Each id in `notified.json` carries that time and is pruned once it passes the
same 7 days, so the ledger always covers every run the fold can offer. The 2000-id cap is a backstop: past it the oldest ids go and `floor` rises to the
newest dropped time, and nothing at or before `floor` pushes. The first shape, a plain `{ids: [...]}` list, is read as ids stamped with the load time.

## Launching on demand

`POST /api/routines/:name/run` spawns the wrapper detached with `--trigger manual` through `spawn.ts`'s `spawnProcess`, with exactly `routineEnv(config)` as
its environment, then reads the run id back from the log for up to 2 s (`READBACK_MS`) and answers `202 {run}`; `run` is `null` if the log had nothing yet.
A missing or empty body, or a body without `only`, is a whole run. An `only` that is not an array of non-empty strings, is `[]`, has more than 200 entries
(`ONLY_MAX`), or has an element starting with `-` or containing a control character is `400 bad-only` and nothing spawns; a body that is not valid JSON is
`400 bad body`. `POST /api/routines/:name/stop` sends SIGTERM to the pid in the lock file after the same command-line check the wrapper uses.

## HTTP surface

Write routes are gate-only writes ([who may write](remote-access.md#who-may-write)) and answer `409 not-owner` from a non-owner.

| Route | Does | Errors |
|---|---|---|
| `GET /api/routines` | `{machine, dir, owner, reconcile: {state, drift, error, at}, jobs}` | |
| `GET /api/routines/runs?days=&job=&outcome=&runner=` | folded runs, newest first, plus `stats` for the window and the one before; `days` outside 7/30/90 reads as 30, stats ignore `outcome` | `400 bad outcome` |
| `GET /api/routines/:name` | the raw text and the parsed job | `404 no such job` |
| `PUT /api/routines/:name` | `{text}`: validate, write atomically, reconcile; `200 {job, reconcile}` | `422 {errors}`, `404`, `500 write failed` |
| `POST /api/routines` | `{name, text}`, as PUT | `409 exists`, `422`, `500 write failed` |
| `PATCH /api/routines/:name` | `{enabled: boolean}`: rewrite only the `enabled:` line, reconcile; `200 {job, reconcile}` | `422` on an unparseable file, `404` |
| `DELETE /api/routines/:name` | remove the file, reconcile, `200 {reconcile}`; the log stays | `404`, `500 delete failed` |
| `POST /api/routines/validate` | `{text, name?}` → `{errors, summary}`; read-only, outside the write gate | |
| `POST /api/routines/reconcile` | `{apply?}` → the plan; applies when `apply` | |
| `POST /api/routines/reveal` | `{name?}`: open the folder, or reveal that job's file, with `open` / `open -R`; macOS only | `501 reveal needs macOS`, `404 no routines folder` or `no such job`, `500 open failed` |
| `POST /api/routines/:name/run` | see above | `400 bad body`, `bad-only`; `404`; `409 already-running`, `no-plugin`, `invalid`, `not-this-machine`, `not-owner`; `500 spawn-failed` |
| `POST /api/routines/:name/stop` | `204` | `409 not-running` |
| `GET /api/sessions/:id/row` | one `Session` row for any id a transcript resolves, no lookback, so a run older than the Sessions window opens in the ChatDrawer | `400 bad id`, `404 no such session`, `500 transcript unreadable` |

The owner's pin routes rewrite `pins.json` after every pin change, so a fan-out job that fires straight after reads the current list.

## The Routines page

The Routines section, second in the rail, `client/src/components/routines/`; its two pages, Jobs and Runs, are the rail's sub-items (`routinesTab`). `RoutinesView` owns the `/api/routines` poll (`useRoutines`, on
`settings.refreshMs`, through `createPollSeq` so a stale answer never lands over a newer one), the single write helper (`useRoutineWrite`: one status
line under the toolbar, one `busy` key so only the clicked control greys out, and a re-poll after every success), the drawer and the ChatDrawer.

- **Jobs:** the stats band (`StatsBand`) and the ledger (`JobLedger`, one row per file, with `JobFold` for the unfolded stats and last three runs and
  `JobMenu` for Edit, Run now on one repo, Pause or Resume, Reveal in Finder, Copy launchd label and Delete).
- **Reconcile** (owner only, Jobs page) applies nothing on its first click: it POSTs `/api/routines/reconcile` without `apply` and shows the dry plan
  under the toolbar (`.rtn-plan`, built by `reconcilePreview`: each change's action, name and why, or `Nothing to do`). **Apply** POSTs `{apply: true}`,
  which re-plans on the server, and closes the plan; **Cancel** closes it. Apply is disabled when only `pending` changes are planned.
- **Runs:** `RunsList`, grouped by day, filtered by outcome, runner and job; a fan-out run is one row with its steps folded, failed steps open. `SessionLink`
  fetches the row and opens the ChatDrawer, and its failure shows beside the link that was clicked.
- **Drawer:** `JobDrawer` shows one text two ways, switched by a `Form | File` seg in its header (Form by default). Form is `JobRows`: one summary row per
  setting the job's `run:` kind shows (Schedule, Machines, Repos, Script or Prompt, Model, Permission, Limits, Tools), one opened at a time, each control
  writing only the lines its field owns through the registry in `client/src/lib/routineForm.ts` (Schedule's six presets live in `ScheduleControl`). A
  `/validate` error shows inside the row that owns its line and turns that row's summary red; the rest show under the rows. A value the form cannot show
  reads `edit in File`. File is the raw textarea. The text is validated on each keystroke (debounced) in both views; **Save and install** writes
  `enabled: true`, **Save, keep paused** writes `false`, and a New job whose schedule is Manual has a single **Save** (`enabled: true`; nothing installs
  either way). Delete confirms inside it; a file changed on disk while it is open shows `on disk changed` and refuses Save until reloaded.
- **Run now:** `RunNowPopover` lists the job's pins with each one's last outcome (a sheet on a phone); a step's `run again` is `/run` with `only: [repo]`.

Write controls render only for the owner. They stay drawn but disabled when the network is read-only or the Answer token is missing, with the reason in
`.git-sync-note`. `routineWindow` (7, 30 or 90, default 30) is a device setting ([settings](settings.md)), and so is `routinesTab`. A deep link
`?view=routines&run=<id>` lands on Runs with that run's fold open, and `?view=routines` alone on Jobs ([view-persistence](view-persistence.md)).
A job menu's All runs switches the rail to Runs, filtered to that job.
All class names are `.rtn-` prefixed and colours are theme tokens.

## Security

- Job files are code. The folder is the user's private git repo, the wrapper runs as the user, and nothing in the dashboard elevates. The write routes are
  behind the write gate, so a tailnet viewer without trust can read jobs and runs but not create, edit, toggle, run, stop, reveal or reconcile.
- `bypassPermissions` is rejected by the validator and again by the wrapper.
- A plist's `ProgramArguments` are absolute paths and the job name, and a crontab line quotes every value; nothing from a file body reaches a shell line.
  A shell body runs as a file through `bash -e <tmpfile>`, never `sh -c` interpolation.
- Names are checked against `[a-z0-9-]+` before they touch a path, and the routines folder and the wrapper's path come from config and the installed
  plugin, never from a request.
- Launching `launchctl`, `crontab`, `pgrep`, `ps`, `sysctl`, `open` and the wrapper are local launches, not a new outbound kind;
  `test/outbound.test.ts` is unchanged.

## Test seams

- `ROUTINES_STATE_ROOT` points the state root somewhere else so a test or a verification run never touches `~/.claude/routines/`. A server using it is
  never an owner (`ownedBy: 'seam'`), so it can read but never install anything.
- `RUN_ROUTINE_GRACE_MS` shortens the wrapper's 10 s TERM-to-KILL grace in tests; it is a process-env variable and is never baked into a job.
- `setRoutineRunner` (reconcile's launcher for `launchctl`, `crontab`, `pgrep`) and `setSpawner` (the same seam `spawn.ts` uses) are how every server
  test fakes the OS; `startRoutines` takes its `deps` for the same reason; the log reader and `Probe` (pid liveness) take injected readers.

<!-- docs-sync:
  sources:
    - server/lib/routine-config.ts
    - server/lib/routine-store.ts
    - server/lib/routine-reconcile.ts
    - server/lib/routine-run.ts
    - server/lib/routine-log.ts
    - server/lib/routine-notify.ts
    - server/lib/routine-boot.ts
    - server/lib/open-folder.ts
    - server/lib/notify.ts
    - server/api.ts
    - server/index.ts
    - shared/types.ts
    - shared/cron.ts
    - shared/routine-file.ts
    - plugin/lib/run-routine.mjs
    - scripts/sync-plugin.ts
    - scripts/gen-plugin-lib.ts
    - client/src/components/routines/RoutinesView.tsx
    - client/src/hooks/useRoutines.ts
    - client/src/hooks/useRoutineRuns.ts
    - client/src/hooks/useRoutineWrite.ts
    - client/src/lib/routines.ts
    - client/src/lib/deepLink.ts
  kind: subsystem
  verified: 55ae263c1c834e6d8c942b91f0100e8d7508107e
-->
