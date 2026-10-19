# Scheduled workflows — design

Date: 2026-10-19. Issue: [futin/claude-agents-dashboard#247](https://github.com/futin/claude-agents-dashboard/issues/247). Mockups:
`docs/superpowers/specs/2026-10-19-scheduled-workflows-mockups.html` (the Ledger layout was picked; a tiles-and-inspector layout and a week strip were
drawn and dropped). Brainstormed 2026-10-19; every "theirs" decision below was answered by the user in that session. Where the mockup and this document differ, this
document wins: screen 6 is the existing `ChatDrawer` unchanged — its `schedule · git-sync-all` chip, `Open in Sessions` and `Run lookout again` are
not built (the drawer has no such controls and does not know the job; `run again` lives in the fold), and the mechanics board's `~/.claude/schedule-runs/mac.jsonl` is `~/.claude/schedules/runs/mac.jsonl` below.

## Intent

The same chores come round on both of this user's machines and get done by hand or forgotten: pull every pinned repo before work, run `/git-sync` across the
pins at night, `/docs-sync` the dashboard weekly, `/kaizen review` and `/backlog-retro` monthly. Each is a one-line prompt or a one-line shell command; what
is missing is a place that fires them on a clock, on the right machine, and shows afterwards what happened.

This adds **Management › Schedules**: jobs defined as markdown files in a git-synced folder, installed into the OS scheduler of each machine that the file
names, run through one wrapper, logged per run, and shown in the dashboard with the stats of the last N days. A job is a shell block or a Claude prompt;
either can fan out over the pinned repos.

### Why not Claude Code Routines

Routines run in Anthropic's cloud against a GitHub repo. They cannot see this machine's disk, its pins, its transcripts, or its WSL box; every run costs
tokens; nothing they do lands in the Sessions page. This feature is the complement, not a rival: **this machine's** repos and pins, zero-token shell jobs
beside Claude jobs, every Claude run a real transcript the dashboard already knows how to open, failures pushed through the ntfy topic the dashboard already
uses, and all of it keeps firing with the dashboard closed. A job that needs none of that belongs in a Routine.

## Goals

- A Jobs page that answers, per job, in one row: did the last run work, when is the next one, is it on — with a toggle that pauses or resumes it.
- Runs linked to evidence: a Claude run opens its transcript in the existing chat drawer, whatever its age; a shell run shows exit code and the last lines.
- Two runners — `shell` and `claude` — and a fan-out over pinned repos (all of them, or a picked subset), so "pull every pin" and "git-sync every pin" are
  each one file.
- Definitions travel with `~/claude-global` through git; each machine installs only the jobs that name it, and drops the ones that stop naming it.
- Stats for the last 7/30/90 days: runs, success rate, Claude cost and tokens, wall time, across all jobs and per job.
- Create and edit a job from the dashboard, with validation, without leaving the file model: the file is the form.
- Failures reach the phone through the existing `server/lib/notify.ts` ntfy path.
- Everything the OS scheduler needs works with the dashboard down: launchd/cron fire the wrapper, the wrapper writes the log, the dashboard reads it later.

## Non-goals

- A scheduler inside the dashboard server. No timers, no queue. The OS fires jobs; the server only installs, launches on demand, and reads.
- Running a job on a machine the file does not name, or on the machine the dashboard happens to be open on. `machines:` decides.
- An idle guard ("skip if the user is typing"). Considered and not chosen: jobs run at the hour they are given, or, on a Mac that was asleep at that
  hour, when it wakes — launchd fires a missed `StartCalendarInterval` on wake, cron on WSL skips it. The wrapper computes the slot a scheduled fire
  belongs to (`cron.ts` `lastBefore(expr, now)`) and sets `late: true` on the `start` record when it is more than 10 minutes past it; the row and the
  Runs page show `late` beside the time. Nothing is skipped.
- Secrets, tokens or credentials in job files. The folder is a git repo; the wrapper inherits the user's login environment and nothing more.
- A form-field editor over the frontmatter. The raw file in a drawer was chosen; the one helper above it (Repos) rewrites a single line.
- Windows outside WSL, Linux outside WSL, systemd timers. The two profiles `bootstrap.sh` knows are the two this ships for, and WSL means cron.
- Rendering stats as charts beyond the one bar-per-day strip in the band.

## Anti-goals

- A job that fires twice at once. One job runs one wrapper at a time, on one machine; a manual run while a scheduled one is in flight is refused, not queued.
- A `bypassPermissions` Claude run. Refused at validation and again by the wrapper.
- A run that vanishes. A run that started and never ended is shown as **lost**, never dropped, so a slept laptop or a killed process is visible.
- A reconcile that touches anything it did not install. Only launchd labels and crontab lines carrying this feature's marker are ever written or removed.
- Writing the run log into the git folder. Logs are machine-local; the files that sync are definitions only.

## Constraints

- Server stays zero-dep (`.claude/CLAUDE.md` §Code rules). The wrapper is plain Node with built-ins only, no TypeScript, no imports from `server/`.
- Launching `launchctl`, `crontab`, `git` and the `claude` CLI are local launches, not a new outbound kind; `test/outbound.test.ts` keeps pinning the list.
- `shared/types.ts` first for every new API field; `shared/frontmatter.ts` stays the one parser both sides run, and gains a writer beside it.
- CSS: theme tokens only, no literal colours; new class names prefixed `.sch-`; ui-kit `.uk-*` classes untouched.
- The sessions scan stays capped (`SCAN_CAPS`, 168 h / 50 rows). Old runs are reached by id, not by widening the scan.
- `pnpm plugin:sync` is how a wrapper change reaches the installed plugin; until then launchd runs the old copy. Reconcile bakes the *installed* plugin's
  wrapper path, never the repo checkout's.

## The job file

One file per job, `<name>.md`, in the schedules folder (default `~/claude-global/schedules/`, `.env` `SCHEDULES_DIR` overrides). The name is the filename
without `.md`, `[a-z0-9-]+`, and is the launchd label suffix and the log key. `runs`, `validate`, `reconcile` and `reveal` are reserved (they are route
segments) and refused by validation.

```markdown
---
cron: "0 22 * * *"            # five fields, local time of the machine that runs it
machines: [mac, wsl]          # which profiles install it; one or both
run: claude                   # shell | claude
foreach: pinned               # absent = run once in `cwd`; pinned = every pinned repo; [a, b] = only these pins, by name
cwd: ~/Documents/x            # only without foreach; default = the schedules folder's parent
enabled: true                 # absent = true
model: opus                   # claude only; absent = CLI default
effort: medium                # claude only
permission-mode: acceptEdits  # claude only; plan | acceptEdits | auto; default = the Sync button's (`SYNC_PERMISSION_MODE`, `auto`)
allowed-tools: [Bash, Read]   # claude only; absent = CLI default
max-turns: 60                 # claude only
timeout: 30m                  # both; wrapper kills the step after this; default 60m
---
/git-sync
```

- `run: shell` — the body's first fenced `bash` block is the script, run with `bash -e` in the step's cwd. Exit code, duration and the last 20 lines of
  stderr+stdout are logged. No tokens, no transcript.
- `run: claude` — the whole body is the prompt. A body that is one line starting with `/` is a skill invocation; anything longer is a plain prompt, and skills
  are reachable from it by name through the Skill tool. Launched as `claude -p --output-format json --session-id <uuid>` plus the keys above, cwd set per
  step; session id, model, cost, duration, turns and the result's `is_error` are logged.
- `foreach: pinned` and `foreach: [names]` — one **step** per repo, sequential, each its own cwd, exit, duration, cost and session. Names are the pin names
  shown on Management › Projects (the repo folder basename). A name not pinned on the running machine is skipped there and logged as `skipped: not pinned`.
  Two pins sharing a basename on a machine (a worktree, a fork) make that name ambiguous there: validation refuses the file naming both `dirName`s, and the
  file uses the `dirName` instead. The step's cwd is the pin's own path (`PinRow.path`), not the git toplevel.
- `permission-mode` accepts `plan`, `acceptEdits` and `auto` only — `bypassPermissions`, `dontAsk` and anything else is an error (never clamped to
  `auto` the way `spawn.ts` `modeIndex` does). `model` and `effort` are single tokens without whitespace, passed through as `--model` / `--effort`;
  a value the CLI rejects fails the step with the CLI's stderr as `why`. Frontmatter keys the parser does not know are rejected at validation with the
  key named. `machines:` and `foreach:` lists are the inline `[a, b]` form
  only; the parser's block-scalar support stays as is.

**Pins on disk.** The wrapper never calls the dashboard. The server writes `~/.claude/schedules/pins.json` — `[{ dirName, name, path }]` in pin order,
from the same `listPinRows` the Projects tiles use — on startup and every time pins change. The wrapper reads that file and matches `foreach:` entries
against `name` first, `dirName` second; a pin whose `listed` is false or `path` is null is skipped with `why: pin unlisted`. No `pins.json` at all ends
a fan-out run before its first step with `failed`, `why: no pins snapshot`. Pins change only through the dashboard, so the snapshot is current whenever
it matters.

## Machine identity

`SCHEDULE_MACHINE` in `.env` if set (`mac` or `wsl`; any other value is reported in the toolbar chip as `bad SCHEDULE_MACHINE` and installs nothing); otherwise the same detection as `~/claude-global/bootstrap.sh`: `Darwin` → `mac`, `/proc/version` containing
`microsoft` → `wsl`, else `wsl`. The toolbar shows the resolved name next to the title. The wrapper resolves it the same way, from the same env var, so a
file and its installed job agree on which machine they are on.

## Owning server

Pins, settings and the write routes are per checkout (`server/lib/settings.ts` keeps `.dashboard-settings.json` under `process.cwd()`), and this user
routinely runs a second server from a worktree on 4273 to verify a branch. Only one server per machine may install OS jobs, write `pins.json` or sweep
locks: a server opts in with `SCHEDULES_OWNER=true` in its `.env`, and on start takes `~/.claude/schedules/owner.json` (`{ pid, bootId, cwd, port, at }`)
if the file is absent or its pid is dead or from another boot. A second opted-in server that finds a live owner does not take it: it runs read-only
with the chip reading `owned by <cwd>:<port>`. A server without the flag never tries. A worktree copies `main`'s `.env` for its own ports, so the flag
alone would make two owners; the lock is what prevents it. A non-owner serves jobs, runs and stats, hides every write control, answers every write
route `409 not-owner`, never folds for pushes and never writes under `~/.claude/schedules/`. Only the owner sends `schedule-failed` and keeps
`notified.json`. The owner releases the file on clean exit; a crash leaves a dead pid the next start takes over.

## Reconcile: files in, OS jobs out

`reconcile()` is a pure diff applied idempotently:

- **desired** = every valid file where `enabled: true` and `machines` contains this machine.
- **installed** — mac: every plist under `~/Library/LaunchAgents/` whose label starts with `com.claude-dashboard.schedule.` *and* is loaded
  (`launchctl print gui/<uid>/<label>` exits 0); a plist on disk that launchd refused is the `drift` case; wsl: every line of the user's
  crontab between `# >>> claude-dashboard schedules >>>` and `# <<< claude-dashboard schedules <<<`. WSL is cron only; when no cron daemon is running
  (`pgrep -x cron|crond` empty) the chip reads `cron not running` in red, since installed lines fire nothing.
- **diff** → install (new file), update (the fully rendered plist or crontab line differs from the installed one: cron, wrapper path, node path or any
  baked env value), remove (file gone, disabled, or no longer names this machine), unchanged. A `.env` edit is picked up at the next server start, which
  reconciles.
- **apply** — mac: write the plist (`StartCalendarInterval` from the cron, `ProgramArguments` = absolute `node`, absolute wrapper path, job name; `WorkingDirectory`
  = schedules folder; `StandardOutPath`/`StandardErrorPath` under `~/.claude/schedules/launchd/`), then `launchctl bootout` + `bootstrap gui/<uid>`; wsl:
  rewrite only the marker block, `crontab -` with the rest of the file byte-identical. `bootout` kills a running job, so an update or remove of a job
  whose lock is held is deferred: reconcile reports it as `pending · running`, and re-runs when the lock goes (the runs watcher sees the `end`).
  Reconciles never overlap: one runs at a time, a trigger during a run schedules one trailing re-run, so the crontab read-modify-write cannot race. A cron expression launchd cannot express (step values, ranges across
  fields) is expanded to the equivalent list of `StartCalendarInterval` dicts; one that cannot be expanded is a validation error on mac.
- The plist and each crontab line carry the environment the job needs, one list built from `Config` by `scheduleEnv(config)` and used for both the
  installed job and the `/run` spawn: `PATH` and `HOME` as the server process sees them, `CLAUDE_BIN`, `SPAWN_MAX_PERMISSION`, `SYNC_PERMISSION_MODE`,
  `SCHEDULE_MACHINE` and `SCHEDULES_DIR` (`.env` values live in `Config`, never in `process.env`, so nothing reaches a child unless baked). launchd and
  cron give a job no shell rc, so without this `git`, `gh`, `pnpm` and `claude`'s own plugin launches exit 127 at 22:00. In the crontab the assignments
  are inline on the command (`PATH='…' HOME='…' node … job`), never as lines of their own, which would leak into the user's entries below the block;
  every value is single-quoted with `'` written as `'\''` (WSL's `PATH` carries `Program Files (x86)`), and `%` is written `\%` because cron turns a
  bare one into a newline — a test renders a PATH with both and runs the line through `sh -n`. The
  shell block runs under that env through `bash -e <file>`, not a login shell: no rc side effects, no `$SHELL` dependence.
- Runs on: server start; `fs.watch` on the schedules folder (debounced 500 ms — a `sync.sh pull` lands several files); after every save, toggle or delete
  from the UI; the **Reconcile** button; and a change to `~/.claude/plugins/installed_plugins.json`, because `pnpm plugin:sync` reinstalls the plugin
  into a new versioned directory and the baked wrapper path moves with it. `scripts/sync-plugin.ts` also POSTs `/api/schedules/reconcile` when a server
  is up, and its `PUBLISHED_PATHS` gains `lib`, or a wrapper edit never counts as drift. The button shows the diff first and applies on a second click.
- State surfaces as the toolbar chip: `in sync` (green), `drift N` (amber: files and installed set disagree after the last apply, e.g. launchd refused a
  plist), `reconcile failed` (red; the error in the Jobs fold). Drift is re-read from the OS on every Jobs poll, not remembered.

The paths baked into a plist are read once at reconcile time: `process.execPath` for node, the installed plugin's `bin/run-schedule.mjs` for the wrapper
(`~/.claude/plugins/…/claude-agents-dashboard/lib/run-schedule.mjs`, the directory `scripts/sync-plugin.ts` installs into). It is `lib/`, not `bin/`:
Claude Code puts every plugin's `bin/` on the Bash PATH of every session, which `test/plugin-manifest.test.ts` exists to prevent; that test's allowed
entries gain `lib`, and `sync-plugin.ts` `PUBLISHED_PATHS` gains it too. If the installed plugin is
missing, reconcile reports `plugin not installed` and installs nothing.

## The wrapper: `plugin/lib/run-schedule.mjs`

What launchd and cron call; the only process that runs jobs. Plain Node, built-ins only, no imports from `server/`.

`run-schedule <job> [--trigger schedule|manual] [--only <pin>...]`

1. Resolve machine, read `<dir>/<job>.md`, parse and validate exactly as the server does (the validator is one module both import — see Shared modules).
   The dashboard may have been down when the file was deleted, broken, disabled or stopped naming this machine, leaving the OS job installed: on a
   `--trigger schedule` fire with a missing, invalid, disabled or other-machine file the wrapper appends `refused` with `why` (`file gone`, `invalid:
   <line>`, `disabled`, `not this machine`) and exits 0 without running. A manual run of a disabled file is allowed (that is Run now on a paused job);
   the other three refuse it too.
2. Take the job lock `~/.claude/schedules/locks/<job>.lock` (`O_EXCL`, pid and boot id inside — `kern.boottime` on mac, `/proc/sys/kernel/random/boot_id`
   on wsl). If held by a live pid from this boot whose command line is `run-schedule <job>`: write a `refused` log line and exit 75. Any other lock is
   stale and taken over; the reader then shows its run as lost. The server does the same sweep on start, so a reboot never leaves a job reading
   `running`; that sweep is the only time the server writes under `locks/`. `/stop` applies the same command-line check before it signals.
3. Compute steps: one for a plain job, one per resolved pin for a fan-out, filtered by `--only`.
4. Append the run's `start` record, then per step: append `step-start`, launch, wait (kill at `timeout`), append `step-end`. Then `end`.
5. Exit 0 if every step exited 0, else 1. On SIGTERM: forward to the current child, wait up to 10 s, append `end` with `stopped: true`, exit 143.

Outcome mapping, the same in the wrapper and the reader: a step is `ok` when the shell exits 0 or the claude result has `is_error: false`; `skipped`
when its pin is missing or unlisted; otherwise `failed`, which includes `timeout`, `stopped` and a claude `is_error`. `end.failed` counts every
non-ok, non-skipped step. A run is failed when `failed > 0` or `error` is set; that is what the push and the row's pill read.

The claude launch is `claude -p --output-format json --session-id <uuid> [--model] [--effort] [--permission-mode] [--allowed-tools …] [--max-turns]` with
the prompt on stdin. `bypassPermissions` is refused here too, whatever the file says, and the mode is clamped to `SPAWN_MAX_PERMISSION` from the baked
environment exactly as `spawn.ts` `clampPermission` does; absent `permission-mode` means the baked `SYNC_PERMISSION_MODE`. The CLI path comes from
`CLAUDE_BIN` in the same environment; a machine with it unset cannot run claude jobs — reconcile reports `claude cli not configured` and installs no
claude job there, and the wrapper, if reached anyway, ends the step `failed` with that `why`.

The child gets `CLAUDE_DASHBOARD_SCHEDULE=<job>` in its env and `--disallowed-tools AskUserQuestion`. The marker exists for the user-global hooks: the Stop
hook (`scripts/stop-notify-hook.sh`) exits at once on it, like `CLAUDE_DASHBOARD_REFRESH`, so a step is never held for `answerSecs` and never pushes
"finished" — the schedule's own failure push is the only one; `ask-remote-hook.sh`, `remote-decision-hook.sh` (which would otherwise tell the step
to "ask in prose" and end the turn doing nothing), `plan-remote-hook.sh` and `permission-notify-hook.sh` exit on it too. With the tool disallowed a
step cannot stop to ask; a prompt that needs an answer must say what to do instead. The transcript itself records nothing: the run log is the join, and
the Sessions page does not badge schedule runs in this version.

## The run log

`~/.claude/schedules/runs/<machine>.jsonl`, append-only, one JSON object per line, never under git. Record kinds:

| kind | fields |
|---|---|
| `start` | `run` (uuid), `job`, `machine`, `trigger` (`schedule`/`manual`), `at` (ISO), `slot` (ISO, schedule only), `late` (boolean), `steps` (count), `pid` |
| `step-start` | `run`, `step` (index), `repo` (pin name or `null`), `cwd`, `at`, `session` (uuid, claude only) |
| `step-end` | `run`, `step`, `at`, `ms`, `exit`, `outcome` (`ok`/`failed`/`skipped`/`timeout`/`stopped`), `why` (short text), `tail` (shell: last lines), `cost`, `tokensIn`, `tokensOut`, `turns`, `model` (claude) |
| `end` | `run`, `at`, `ms`, `ok`, `failed`, `skipped` (counts), `stopped` (boolean: SIGTERM ended it), `error` (string, only when the run failed before its first step: `no pins snapshot`, `claude cli not configured`) |
| `refused` | `job`, `at`, `trigger`, `why` (`running`, `file gone`, `invalid: <line>`, `disabled`, `not this machine`), `heldBy` (pid, `running` only) |

The server folds the file into runs: a `start` with no `end` whose pid is dead (or alive but not running `run-schedule <job>`, checked by command
line) is **lost**; the age rule — older than its job's `timeout` × steps + 5 min — applies only when the pid cannot be checked (another machine's
file, no `ps`), never to a run whose lock is held by a live wrapper, so a laptop that slept mid-run shows `running` until the wrapper ends it. Lost is derived at read time, never written; a slept laptop that wakes and
appends `end` later supersedes it, and a lost push already sent is not followed by a second push for that run. The `end`
record is what the Runs page and the stats read; a run in flight is read from `start` + the `step-*` lines so far. The reader is incremental: it keeps,
per file, the byte offset and inode it last read to and appends only the new lines to its in-memory fold; a smaller size or a changed inode means
rotation or truncation and it re-reads from 0. `readTail` in `transcript.ts` reads trailing bytes only and is not reused. Rotation: when a file passes 20 MB
the server renames it `<machine>.<yyyymmdd>.jsonl` and the stats read every file in the folder within the window.

## Launching on demand

`POST /api/schedules/:name/run` with optional `{ only: [pins] }` spawns the wrapper detached, `--trigger manual`, through the same `setSpawner` seam
`spawn.ts` uses so tests inject a fake; the child's env is exactly `scheduleEnv(config)`, not the server's (which carries `CLAUDE_CODE_ENTRYPOINT`
and the markers `spawn.ts` strips). It answers `202 { run }` with the run id read back from the log within 2 s, `409 already-running` when the lock
is held, `404` for an unknown job. `POST /api/schedules/:name/stop` sends SIGTERM to the pid in the lock file; `204`, or `409 not-running`. A paused job
can be run on demand — that is how a new job is tried before the toggle installs it.

## HTTP surface

| route | does |
|---|---|
| `GET /api/schedules` | `{ machine, dir, reconcile: { state, drift[], error, at }, jobs: Job[] }`; a `Job` carries the parsed file, its validity, `installed`, `nextAt`, the last run's summary and whether it is running now |
| `GET /api/schedules/runs?days=30&job=&outcome=&runner=` | folded runs, newest first, each with its steps; plus `stats` for the window and the previous one |
| `GET /api/schedules/:name` | the raw file text and the parsed job, for the editor |
| `PUT /api/schedules/:name` | `{ text }` → validate; on success write atomically (tmp + rename), reconcile, `200 { job }`; else `422 { errors[] }` and nothing written |
| `POST /api/schedules` | `{ name, text }` → `409` if the file exists, else as PUT |
| `DELETE /api/schedules/:name` | remove the file, reconcile; the log stays |
| `PATCH /api/schedules/:name` | `{ enabled }` → rewrite only the `enabled:` line (frontmatter writer), reconcile |
| `POST /api/schedules/reconcile` | `{ apply?: boolean }` → the diff; applies when `apply` |
| `POST /api/schedules/:name/run`, `/stop` | above |
| `GET /api/sessions/:id/row` | one `Session` row for any id `findTranscript` resolves, no lookback, built by the row builder extracted from `scanSessions` with the liveness set passed as `null` (fail open, as `skipProcScan` does) and the wait sets empty; it never applies the scan's `hasMessages` / `commandOnly` skips, so a run the scan would hide still opens; `404` only when no transcript exists |
| `POST /api/schedules/validate` | `{ text }` → `{ errors[], summary }`, what the drawer calls on each keystroke (debounced); read-only, outside the write gate |
| `POST /api/schedules/reveal` | opens the schedules folder in Finder (`openFolder`, darwin only, `501` elsewhere); the existing open-folder route accepts pin paths only |

Write routes sit behind the same write-trust guard every other write route has (`docs/subsystems/remote-access.md`). The schedules folder's path and the
wrapper's are never taken from a request.

## Shared modules

- `shared/schedule-file.ts` — `parseJob(text) → { job, errors }`, `checkPins(job, pins) → errors` (the ambiguous-name check, run by the server at validation
  and by the wrapper at step time against `pins.json`) and `serializeEnabled(text, enabled) → text` (rewrites the `enabled:` line, inserting it after
  `run:` when absent, everything else byte for byte). `parseJob` reads the raw frontmatter lines itself rather than trusting `parseFrontmatter`'s data:
  a nested block, an empty value, a duplicate key or an unknown key is an error naming the line, inline lists are `[a, b]` only, a line whose first non-blank character is `#` is a comment, and a ` #` outside quotes starts one — so the example
  file above and the drawer templates parse as written. Zero deps, runs on server and client (the drawer's live summary). The wrapper runs `plugin/lib/schedule-file.mjs`, `cron.mjs` and `frontmatter.mjs`: generated
  from the TS by `pnpm plugin:gen` (`typescript`'s `transpileModule`, already a dev dep), and `test/plugin-manifest.test.ts` regenerates and compares, so a
  TS edit without the regen fails CI, and `plugin/lib/frontmatter.mjs` is generated the same way since `parseJob` imports it. The generated files are
  `.mjs` (`schedule-file.mjs`, `cron.mjs`, `frontmatter.mjs`): the plugin has no `package.json`, so a `.js` would load as CommonJS on the Node 18–20
  this repo still allows and the wrapper would die before its first log line. The plugin is still never
  imported by server or client. `.claude/CLAUDE.md` names `frontmatter.ts` and `gitUpstream.ts` as the only modules both sides run (§Orientation and
  §Code rules) and `docs/overview.md` repeats it: the same PR adds `schedule-file.ts` and `cron.ts` to both lists.
- `shared/cron.ts` — parse five-field cron, `nextAfter(expr, date)`, `toCalendarIntervals(expr)` for launchd, `describe(expr)` for the row ("07:00
  Mon–Fri"). Zero deps.
- `shared/frontmatter.ts` — unchanged parser; `writeFrontmatterLine(text, key, value)` added beside it.

## UI: Management › Schedules

A new `managementTab` value `schedules` beside `projects`, `codegraph`, git. The screens are the mockup's; the behaviour per screen:

**Jobs (screen 1).** `.mgmt-bar` with the machine chip; `.git-toolbar` with the Jobs | Runs seg, the 7d | 30d | 90d seg (default **30d**, remembered in
settings), the reconcile chip, Reconcile and New job buttons. The stats band (`.sch-stats`) sums the window across jobs: runs with ok/failed split and a
bar per day, success %, Claude cost with the delta against the previous window, tokens, wall time. The ledger (`.sch-ledger`) is one row per file, sorted
by name; columns: status dot, name + cron description + fan-out chip + machine chips, runner pill, last run (pill on its own line, then when · duration ·
cost), next run, toggle, Run now + caret. A job that does not name this machine shows `wsl only` in its runner column and no Run now. Every cell is a
stack of short lines; a pill always has a line to itself; pill columns are fixed width, prose columns ellipsize. Polls `/api/schedules` every 3 s like
Sessions.

**Fold (screen 2).** Clicking the row body unfolds the job's stats for the window and its last 3 runs, each run a kicker line and one line per step
(repo, duration, outcome pill, cost, model, `session →` or `run again`). `all runs →` switches to Runs filtered to the job.

**Runs (screen 3).** Flat list grouped by day, newest first; filters: window, outcome (All | Failed | Lost), runner, job. A fan-out run is one row with its
steps folded; failed steps open by default, ok steps count. A lost run reads `lost` in mustard with its reason in the mono line under the name.

**New job (screen 4).** A drawer. Kind picker (Shell script | Claude prompt | Claude skill) fills the template; Name (checked live for pattern and
collision); Repos helper (All pinned | Pick | Single cwd — Pick lists pin chips) which only rewrites the `foreach:` / `cwd:` lines; the file in a textarea
with the validation message under it, from `/api/schedules/validate`. **Save and install** writes with `enabled: true`; **Save, keep paused** with
`enabled: false`. Both reconcile.

**Edit (screen 5).** The caret menu: Edit file, Run now on one repo… (fan-out only), Pause/Resume, Reveal in Finder/Explorer (the existing open-folder
route), Copy launchd label, Delete…. Edit is the same drawer with the current text; the Repos helper reads `foreach:` on every change and rewrites it when
used. Reveal calls `/reveal` and is hidden on wsl. Delete confirms inside the drawer. The toggle calls PATCH. A file changed on disk while the drawer is open shows an `on disk changed` chip and
Save is refused until reloaded.

**Run now (screen 5b).** Run now calls `/run`; the row flips to `running · n of N` and the button to Stop on the next poll. Run now on one repo opens a
popover listing the job's pins with each one's last outcome, Run per row and `Run the N failed`; on phone width it is a sheet with checkboxes. A step's
`run again` is the same call with `only: [repo]`.

**Session (screen 6).** A claude step's `session →` opens the existing `ChatDrawer` exactly as the Git Sync pill does (`GitView.tsx`), with the row from
`GET /api/sessions/:id/row`, so a run older than the Sessions window opens the same way as yesterday's.

Phone width (375 px): the ledger collapses to dot · name block · toggle, the stats band to two tiles, the Runs rows to dot · block · link, the drawer to
full screen. No horizontal scroll.

## Notifications

A run that is failed (`failed > 0` or `error`), a `refused` record whose `why` is not `running`, or a run marked lost sends one ntfy push through `notify.ts` as a fifth event kind, `schedule-failed`: title `<job> · <n> of
<N> failed`, body the first failed step's `why`, click → `/?view=schedules&run=<id>`. It sits under the master switch and the desk/phone routing
like the other four, with its own checkbox in Settings and `NOTIFY_EVENTS`, but is exempt from `requireAfk`, `requireRemoteAnswer` and `requireAutoMode`:
those gate interactive sessions, and a 22:00 job has none. It needs no session id, so it goes through a sibling of `maybeSend` that takes the run instead.
The server folds the log and sends on an `fs.watch` of `runs/`, on every poll and on start, so a push goes out with no browser open. A run that
becomes lost without a log write (SIGKILL, the age rule) is noticed at the next log write, poll or start; that delay is accepted — no timer. A lost
run's push is titled `<job> · lost`, body `started <time>, no end record · machine slept?`; a pre-step failure's is `<job> · failed before start`, body
`end.error`; a refusal's is `<job> · not run`, body the `why`. the
click URL is `config.publicUrl` + `/?view=schedules&run=<id>`, and `deepLink.ts` `readViewParam` learns `schedules` beside `git`, with `run` opening
that run's fold. Sent by the server when it folds the log and sees the record for
the first time (an id set in memory plus a `~/.claude/schedules/notified.json` so a restart does not resend). Shell-only failures push too; success never.

## Security

- Job files are code. The folder is the user's own private git repo and the wrapper runs as the user; nothing in the dashboard elevates. The write routes
  are behind the write-trust guard, so a tailnet viewer without trust can read jobs and runs but not create, edit, toggle, run or reconcile.
- `permission-mode: bypassPermissions` is rejected by the validator and by the wrapper. `acceptEdits` shows an amber note in the drawer.
- The plist's `ProgramArguments` are absolute paths and the job name; nothing from the file body reaches a shell line. The shell body runs as a file via
  `bash -e <tmpfile>`, never through `sh -c` interpolation.
- Names are validated `[a-z0-9-]+` before they touch a path; the schedules dir is resolved once from config, never from a request.

## Calls I made (check these while reading)

- Environment baked into the plist/crontab (`PATH`, `HOME`, `CLAUDE_BIN`, `SPAWN_MAX_PERMISSION`, `SYNC_PERMISSION_MODE`) rather than a login shell.
- Reconcile also fires on `installed_plugins.json` changes; `sync-plugin.ts` POSTs reconcile and publishes `lib/`.
- `CLAUDE_DASHBOARD_SCHEDULE` marks a step's env for the hooks only; nothing in the transcript marks it, and the Sessions page does not badge schedule runs.
- Pins keyed by `name`, falling back to `dirName`; ambiguous names are a validation error; step cwd = `PinRow.path`.
- The row endpoint reuses an extracted row builder; it never 404s an existing transcript.
- The wrapper's parser and cron modules are generated JS from the `shared/` TS, compared in CI.
- Locks carry pid + boot id; the server sweeps stale locks on start.

- Log location `~/.claude/schedules/`, with `runs/`, `locks/`, `launchd/`, `pins.json`, `notified.json` under it — one folder for everything machine-local.
- Steps run sequentially, never in parallel; one job, one process. Parallel fan-out is a later decision.
- `timeout` default 60 m per step; lost-grace = `timeout × steps + 5 m`.
- Shell runner takes the first ` ```bash ` fence; a body with none is a validation error. Claude runner takes the body verbatim, fences included.
- `cwd:` default (no foreach) is the schedules folder's parent, i.e. `~/claude-global`.
- A cron launchd cannot express is an error on mac rather than a nearest-approximation.
- Window seg default 30d, kept in `settings.scheduleWindow`.
- Rotation at 20 MB.
- `--trigger` and `--only` are the wrapper's only flags.
- Log retention: never pruned by this feature.

## Left to the builder

- Exact plist template and the `launchctl` invocation sequence on macOS 15+ (`bootstrap`/`bootout` vs `load`/`unload`).
- Component split under `client/src/components/management/schedules/`; hook shape (`useSchedules`, `useScheduleRuns`).
- Test fixtures: a tmpdir schedules folder, a fake spawner, a fake `launchctl`/`crontab` via the same override seam `git-fetch.ts` uses for its runner.
- The docs: `docs/subsystems/schedules.md` and a line in `docs/overview.md` §Map; `docs/subsystems/spawn.md` gains the wrapper launch; `test/outbound.test.ts`
  and `test/plugin-manifest.test.ts` updated for the new launches and `plugin/lib/`.
