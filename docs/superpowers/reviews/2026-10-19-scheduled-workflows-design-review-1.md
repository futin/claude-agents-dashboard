# Scheduled workflows design — review 1

Document: `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` (292 lines), mockups `docs/superpowers/specs/2026-10-19-scheduled-workflows-mockups.html`.
Reviewed 2026-10-19 against the working tree at `f70420c` (main). Every code claim below was read in the file cited; `claude` CLI checks were run against
2.1.295 on this machine.

**Verdict: REVISE** — 3 Critical, 26 Important, 17 Minor.

## Critical

**C1 — lines 152–153, 267 (and 252): schedule runs carry no env marker, so the user-global hooks hold and push on every Claude step.**
`pnpm hooks:install` registers the Stop hook user-wide (`.claude/CLAUDE.md` §Commands). `scripts/stop-notify-hook.sh` exits early only for
`CLAUDE_DASHBOARD_REFRESH` (`:42`); `BM_ORCH_RUN` and `CLAUDE_DASHBOARD_ONESHOT` skip the hold but still push "finished" (`:156–167`); any other
headless run with remote answers on (`scripts/ask-remote-hook.sh:58` gate) and the user away holds a reply window of `answerSecs` (default 600 s,
`server/lib/settings.ts:47`). A 22:00 `git-sync` fan-out over 12 pins therefore stalls up to 12 × 10 min and sends 12 "task finished" pushes. That
contradicts line 252 ("success never") and the timeout budget of line 275. `/git-sync` asks a decision round before deletions (its SKILL description), and
`ask-remote-hook.sh` has no headless exemption, so it would push a question to the phone per repo too.
→ Reverse the "no env var" call: the wrapper sets a marker on every Claude step (reuse `CLAUDE_DASHBOARD_REFRESH`, or add `CLAUDE_DASHBOARD_SCHEDULE`
handled like it in the Stop and ask hooks). Say what a step that reaches `AskUserQuestion` does (deny, fail the step with a `why`).

**C2 — lines 99–101: every dashboard server writes `pins.json`, reconciles the OS jobs and sweeps locks, but pins live per checkout.**
Pins are stored in `<cwd>/.dashboard-settings.json` (`server/lib/settings.ts:39`, `:101–102`). The repo's routine verification setup runs a second server
from a worktree on 4273 against the real HOME (e.g. `docs/superpowers/plans/2026-10-19-quick-pull-push.md:331`,
`docs/superpowers/plans/2026-10-16-tailnet-write-trust.md:264`). Starting it overwrites `~/.claude/schedules/pins.json` with that checkout's pins (usually
none), so the next `foreach: pinned` run fans out over nothing; it also reconciles launchd/crontab with its own `.env` (`SCHEDULES_DIR`, `CLAUDE_BIN`) and
its own branch's wrapper logic. "Pins change only through the dashboard, so the snapshot is current whenever it matters" is false.
→ Name one owner per machine (e.g. only a server with `SCHEDULES_DIR` / a `SCHEDULES_OWNER=1` set in its `.env` writes `pins.json` and reconciles; every
other server reads only), and say so in Constraints.

**C3 — lines 58, 198–206: two new runtime modules shared by both sides contradict a hard rule in `.claude/CLAUDE.md`.**
`.claude/CLAUDE.md:16` ("`frontmatter.ts` and `gitUpstream.ts` are the only modules both sides run") and `:63` ("no runtime coupling, `shared/frontmatter.ts`
and `shared/gitUpstream.ts` excepted"); `docs/overview.md:6` repeats it. `shared/schedule-file.ts` and `shared/cron.ts` run on server and client (line 201).
The docs list at lines 291–292 does not amend either file.
→ State that this PR adds both modules to the exception list in `.claude/CLAUDE.md` (§Orientation and §Code rules) and `docs/overview.md:6`.

## Important

**I1 — lines 121–122 vs 151, 265; 106–107; 141: the baked environment is incomplete and inconsistent.** Line 121 bakes `PATH`, `HOME`, `CLAUDE_BIN`,
`SPAWN_MAX_PERMISSION`; line 151 reads "the baked `SYNC_PERMISSION_MODE`"; line 265 lists five vars. The wrapper also needs `SCHEDULE_MACHINE` (line 107
says it reads "the same env var") and `SCHEDULES_DIR` (line 141 reads `<dir>/<job>.md`; on WSL there is no `WorkingDirectory`). `.env` values never reach
`process.env` (`server/lib/config.ts:299–305`), so they must be baked from `Config`, and the manual-run spawn (line 174) inherits only the server's
`process.env`. → One list of baked vars, sourced from `Config`, used by both the plist/cron line and the `/run` spawn.

**I2 — lines 149–152: `CLAUDE_BIN` defaults to empty, which this codebase treats as "spawn off".** `server/lib/config.ts:148`,
`server/lib/spawn.ts:252` and `:265–267`. The spec never says what a `run: claude` job does when it is unset. → Define it: validation or reconcile flags
claude jobs as `claude CLI not configured` (installed or not), and the wrapper fails such a step with that `why`.

**I3 — line 116: "update" fires only when the cron or wrapper path changed.** `process.execPath` moves when Node is upgraded (nvm/Homebrew), and the baked
env (I1) and `WorkingDirectory` change with `.env` edits; none of these trigger an update, so jobs keep exiting 127 or running with stale limits. A `.env`
edit is not a reconcile trigger either (line 124). → Diff the fully rendered plist / cron line byte for byte, and add `.env` change (the existing
`staleEnvKeys` signal) to the triggers.

**I4 — lines 116–118, 124: `launchctl bootout` of a running job kills it.** Reconcile runs after every save, toggle and delete, and on
`installed_plugins.json` change. A pause, an edit, or `pnpm plugin:sync` (which uninstalls before it installs, `scripts/sync-plugin.ts:176–179`, so the baked
wrapper path is briefly missing) during a 22:00 run SIGTERMs the wrapper. → State the rule: defer update/remove of a job whose lock is live until it ends,
or accept the kill and log the run as `stopped` with a `why`.

**I5 — line 121: environment lines inside the crontab marker block leak into the user's own entries.** cron applies `NAME=value` lines to every entry
parsed after them, so `PATH=`/`HOME=` in the block change user lines below it, against anti-goal line 51. → Put the env on each command
(`env PATH=… HOME=… node <wrapper> <job>`) and write no assignment lines.

**I6 — lines 124, 186–190: reconcile has several concurrent triggers and no serialisation.** A save calls reconcile and also fires the debounced
`fs.watch`, and the button and the plugin watch can overlap. Two applies race on the crontab read-modify-write and on bootout/bootstrap. → Single-flight:
one reconcile at a time, with a trailing re-run if a trigger arrives mid-apply.

**I7 — lines 96–97, 206: the unchanged parser cannot reject unknown keys.** `parseFrontmatter` skips lines that do not match `KEY_RE`, drops keys whose
value is empty along with their indented block, and lets a duplicate key win silently (`shared/frontmatter.ts:38–56`). A block-list `foreach:` (`- a` lines)
disappears, and the job silently runs once in `~/claude-global`. → `parseJob` validates the raw frontmatter lines itself: any line that is not
`key: value`, an empty value, or a duplicate key is an error that names the line.

**I8 — lines 71–82: the example job file does not parse.** Every line carries an inline `# …` comment, and `parseFrontmatter` keeps it in the value
(`shared/frontmatter.ts:58`), so `cron` reads `"0 22 * * *"            # five fields…` and fails. The mockup's Claude template does the same
(`model: opus # or sonnet, haiku; blank = CLI default`). → Either say comments are unsupported and move the annotations out of the code block, or define
comment stripping in `parseJob`. Make the drawer templates match whichever you choose.

**I9 — line 200 vs line 94: `parseJob(text)` takes no pins, but the ambiguous-name check needs this machine's pins.** The client runs it for the live
summary, the server and wrapper with different pin sources. → Split it: a pure `parseJob(text)` plus `checkPins(job, pins)` that only the server and
wrapper call; say what the drawer shows for pin errors.

**I10 — lines 92–95, 99–101: dead pins and a missing `pins.json` are unhandled.** `PinRow.path` is `null` and `listed` is `false` for a dead pin
(`shared/types.ts:1626–1634`, `server/lib/management.ts:727`). Step cwd = `PinRow.path` (line 95) is then null. On a machine whose server has not started
since install, `pins.json` does not exist. → `foreach: pinned` covers listed pins only, and a null path is `skipped` with a `why`. A missing `pins.json` fails
the run with `why: no pins snapshot`, which pushes.

**I11 — lines 147 vs 164; 91; 248: run outcomes are under-defined.** Line 147 writes `stopped: true`, while the `end` row lists `stopped` among counts. The
spec does not say whether a `timeout` step counts as failed, or whether a Claude step that exits 0 with `is_error: true` (logged per line 91, missing from the
`step-end` row) is `failed`. The push fires on `failed > 0` (line 248). → Give `end` as counts (`ok`, `failed`, `skipped`, `stopped`) plus
`stoppedBySignal: boolean`. State that `timeout` and `is_error: true` count as failed, and that `skipped` alone does not fail the run.

**I12 — lines 143, 157–167: "its run marked lost" has no record kind, and lost is not final.** The table has no `lost` record, so the wrapper has nothing to
write. A laptop that sleeps mid-run resumes and appends `end` after the grace, after the lost push has gone out (line 248). → Say lost is only ever derived
(the wrapper writes nothing), that a later `end` supersedes it, and whether the earlier push is accepted.

**I13 — lines 142–143, 176: pid liveness is pid-only.** Within one boot a reused pid keeps a dead wrapper's lock "held": every fire then writes `refused`
(never pushed), until reboot. `/stop` would SIGTERM whatever process now owns that pid. → Before treating a lock as live or signalling it, check that the
pid's command line is `run-schedule <job>` (`ps -o command= -p` on mac, `/proc/<pid>/cmdline` on WSL).

**I14 — line 169: "same shape as `readTail`" is false.** `readTail` (`server/lib/transcript.ts:145–162`) returns only the trailing N bytes and has no offset
cache. A tail read past 2 MB would drop older in-window runs from the 30/90-day stats. → Specify an incremental append-only reader (per-file byte offset
plus folded state, reset on shrink or rename), and drop the `readTail` comparison here and at line 288.

**I15 — line 193: `GET /api/schedules/validate` with a `{ text }` body.** `fetch` refuses a body on GET, and a job file is too long for a query string.
→ `POST /api/schedules/validate`, read-only and outside the write gate.

**I16 — lines 66–67, 184–193: job names collide with routes.** `[a-z0-9-]+` admits `runs`, `validate` and `reconcile`, so `GET /api/schedules/runs` and
`GET /api/schedules/:name` become ambiguous. → Reserve those names in validation.

**I17 — line 231: "Reveal in Finder/Explorer (the existing open-folder route)" cannot work.** `serveOpenFolder` answers 501 on any non-darwin host and 403
for any path that is not a listed pin (`server/api.ts:1867–1879`). The schedules folder is neither. → Name a schedules-specific reveal (fixed path from
config, macOS only), or drop the item on WSL and say so.

**I18 — lines 248–252 vs 38, 168: pushes depend on someone polling.** The log is folded on `/api/schedules` polls, so with no tab open a 22:00 failure
does not push until a page loads. A lost run needs time to pass, and the server has "no timers" (line 38). → Fold and notify on `fs.watch` of `runs/` and on
server start; check for lost runs on the same events. Also state that a run that fails while the dashboard is down pushes when the server next starts.

**I19 — line 248: the click URL has no consumer.** `deepLink.ts` reads only `?session=` and `?view=git` (`client/src/lib/deepLink.ts:29–35`, `:48`).
Existing pushes prefix `config.publicUrl` and omit Click when it is unset (`server/lib/notify.ts:249–252`). → Specify the link as an extension of the
existing grammar (`?view=schedules&run=<id>`), the `deepLink.ts` change, and the `publicUrl` prefix.

**I20 — lines 240–241, 152–153 vs mockup screen 6 and the mechanics board.** The mockup's drawer shows a `schedule · git-sync-all` chip, a "you · by
schedule" line, a "Run lookout again" button, and "Open in Sessions" for a 22-day-old run, which Sessions (168 h cap) cannot show. The spec says the drawer
opens "exactly as the Git Sync pill does" and that nothing badges schedule runs. The mockup also logs to `~/.claude/schedule-runs/mac.jsonl`, against
line 157. None of these differences are called out. → List them and say which wins.

**I21 — line 192: "liveness and wait sets passed in empty" forces every row idle.** In the row builder an empty `liveCwds` set means "no live process", so
`dead` is true (`server/lib/scan.ts:598–599`), and a step running right now opens as idle. → Pass `null` (fail open, `scan.ts:543`) or run the real
probe.

**I22 — line 43 vs 286–287, 114–115: the WSL scheduler is not decided.** "systemd-user timer form if cron is absent" is left to the builder, but the
installed set reads only the crontab block, so timers would never show as installed and would drift forever. WSL also often has no cron daemon running,
in which case jobs never fire and the chip still reads `in sync`. → Cron only, and reconcile reports `reconcile failed: cron not running` when the daemon is
absent. Otherwise specify the systemd form as a second installed-set source.

**I23 — lines 201–203: the generated set omits `frontmatter.js`.** `parseJob` sits on `shared/frontmatter.ts` (lines 58, 206), so
`plugin/bin/lib/schedule-file.js` imports it, and the wrapper fails to load without it. → Generate all three modules and rewrite relative import specifiers
to `.js`.

**I24 — lines 135, 292: plugin `bin/` goes on PATH in every session.** Claude Code 2.1.295 adds each installed plugin's `bin/` to the Bash tool's PATH
(the CLI's own strings: "plugin bin/ PATH entries"). `test/plugin-manifest.test.ts:58–61` exists to keep anything that "loads in every project" out of
`plugin/`. The spec relaxes that test without acknowledging the exposure. → Ship the wrapper in a non-loading folder (e.g. `plugin/schedule/`), or state
that the PATH exposure is accepted and why.

**I25 — lines 76, 113, 189: absent `enabled:` is undefined.** Desired requires `enabled: true`, so a hand-written file without the key is silently never
installed. PATCH "rewrites only the `enabled:` line", but no such line exists to rewrite. → Give a default (false, with a drawer hint) and say that
`writeFrontmatterLine` appends the key before the closing `---` when it is absent.

**I26 — lines 72, 105–107, 114–118: `SCHEDULE_MACHINE` values vs the installer.** Line 72 implies `machines:` ∈ {mac, wsl}, while `.env` can set any name.
Lines 114–118 key launchd and crontab off the machine name, not the platform. → Constrain `SCHEDULE_MACHINE` to `mac|wsl`, or select the installer by
`process.platform` and validate `machines:` against the known names.

## Minor

- **M1 — lines 126, 190:** `sync-plugin.ts` "POSTs reconcile", but without `apply: true` the route only returns the diff. The `installed_plugins.json` watch
  already covers it, so either send `apply: true` or drop the POST.
- **M2 — lines 128 vs 133:** `plugin not installed` is not one of the three chip states, and the `reconcile.state` enum at line 183 is unnamed.
- **M3 — line 174:** `setSpawner` swaps `spawn.ts`'s module-private `spawner` (`server/lib/spawn.ts:283–288`), which a new module cannot use. Say "a seam of
  the same shape".
- **M4 — lines 186, 233–234:** the "on disk changed" refusal is client-only, and PUT has no precondition. Add a base hash or mtime to the PUT body and
  answer 409 on mismatch.
- **M5 — lines 200 vs 206:** there are two writers (`serializeEnabled`, `writeFrontmatterLine`). Say that one wraps the other.
- **M6 — line 210:** the existing tab order is Projects | Git | CodeGraph (`client/src/components/SideRail.tsx:89`). Say where Schedules goes.
- **M7 — line 57:** `.claude/CLAUDE.md:76–81` names every module that launches a process. The new server module (launchctl, crontab, the wrapper) should be
  added there, and the docs list at line 291 omits CLAUDE.md. Line 57 also lists `git`, which nothing in this design has the server launch.
- **M8 — line 170:** two rotations on one day collide on `<machine>.<yyyymmdd>.jsonl`. A file named by its rotation date does not say where its records
  start, and a run can straddle a rotation.
- **M9 — line 82:** the `timeout` grammar (`30m`, `2h`, `90s`?) is unspecified.
- **M10 — line 75:** `~` expansion in `cwd:` is implied but not stated. Relative paths are not covered either.
- **M11 — lines 119–120:** every five-field cron can be expanded as a cartesian product, so "one that cannot be expanded" is vacuous. State a size cap
  instead.
- **M12 — line 142:** reading `kern.boottime` from built-ins-only Node needs a `sysctl` spawn, because `os.uptime()` only approximates it. Name which one.
- **M13 — lines 256–257:** shell jobs are not bounded by `SPAWN_MAX_PERMISSION`, so a trusted tailnet device can create and run arbitrary shell. Say so in
  Security.
- **M14 — line 252:** a missing or corrupt `notified.json` re-pushes every failure in the window. Bound first sight to runs that ended after server start
  minus a grace.
- **M15 — lines 91 vs 163:** `is_error` is logged per line 91 but absent from the `step-end` row; `tokensIn`/`tokensOut` appear in the row but not at
  line 91.
- **M16 — line 267:** schedule runs are `claude -p` (entrypoint `sdk-cli`), so Sessions labels them `dashboard` (`shared/types.ts:80–85`), and a
  12-pin fan-out takes 12 of the 50 scan rows. Acknowledge it.
- **M17 — mockup copy vs spec:** the phone shows "Keep paused" against "Save, keep paused" (line 228); the chip reads "5 installed · in sync" against
  `in sync` (line 128); screen 4 prose says the Repos helper rewrites only `foreach:` against `foreach:` / `cwd:` (line 227); the phone shows "New" against
  "New job"; and the run-now toast "started on lookout · open session" appears nowhere in the spec.

## Verified true

`SCAN_CAPS` 168 h / 50 rows (`server/api.ts:87`); `SYNC_PERMISSION_MODE` default `auto` (`server/lib/config.ts:150`); `clampPermission`
(`server/lib/spawn.ts:106`); the four notify events and the three `require*` clauses (`shared/types.ts:966`, `server/lib/notify.ts:72–78`);
`NOTIFY_EVENTS` (`server/lib/settings.ts:65`); `listPinRows` / `PinRow` (`server/lib/management.ts:713`, `shared/types.ts:1623`); `findTranscript`
(`server/lib/scan.ts:250`) and the `hasMessages` / `commandOnly` skips (`scan.ts:564`, `:570`); `PUBLISHED_PATHS` (`scripts/sync-plugin.ts:27`) and
`installed_plugins.json` (`:31`); `.mgmt-bar` and `.git-toolbar` (`client/src/styles.css:1211`, `:2884`); the `ChatDrawer` in `GitView.tsx:98`; the
git-fetch override seam (`server/lib/git-fetch.ts:98`); `typescript` as a dev dependency; profile detection matching `~/claude-global/bootstrap.sh:31–34`;
and CLI flags `--session-id`, `--effort`, `--allowed-tools`, `--output-format`, `--permission-mode` (2.1.295 `--help`), with `--max-turns` accepted as a
hidden flag.
