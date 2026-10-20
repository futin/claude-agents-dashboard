# Scheduled workflows design — review 2

Document: `docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md` (338 lines), mockups `docs/superpowers/specs/2026-10-19-scheduled-workflows-mockups.html`.
Reviewed 2026-10-19 against the working tree at `1a19a79` (branch `docs/scheduled-workflows-spec`). Round 1: `docs/superpowers/reviews/2026-10-19-scheduled-workflows-design-review-1.md`.
Every code claim below was read in the file cited. CLI checks were run against `claude` 2.1.303 on this machine, launchd against `man launchd.plist`.

**Verdict: REVISE** — 0 Critical, 19 Important, 16 Minor.

All three round-1 Criticals were addressed (the env marker, the owning server, the CLAUDE.md exception list). Most Importants were applied. What remains is mostly
the edges of those fixes (owner exclusivity, lost runs, the generated modules) plus text the fixes left stale. A few new gaps showed up too: launchd catch-up on
wake, permission-mode values, and the wrapper's behaviour when it fires against a file that changed while the dashboard was down.

## Important

**I1 — line 6: the drawer controls the doc keeps from screen 6 do not exist.** Line 6 says screen 6's `schedule · git-sync-all` chip, `Open in Sessions` and
`Resume…` "stay (the drawer's own controls)". `ChatDrawer`'s head carries only the title, the project pill and the close button
(`client/src/components/ChatDrawer.tsx:212–216`). No component in `client/src` renders "Open in Sessions". Only `Resume…` exists (`ResumePanel`,
`ChatDrawer.tsx:331`). The drawer also cannot know the job name for a chip: line 187 says the transcript records nothing, and line 284 says the drawer opens
"exactly as the Git Sync pill does". Separately, "Open in Sessions" for a 22-day-old run lands on nothing, because Sessions is capped at 168 h.
→ Say the chip and `Open in Sessions` are dropped (mockup differs), or specify them as new drawer props: where the job name comes from, and what Open in Sessions
does for a run outside the scan window.

**I2 — line 42 (and 134): launchd runs a missed calendar job on wake, so "jobs run at the hour they are given" is false on mac.** `launchd.plist(5)`, under
`StartCalendarInterval`, says launchd "will start the job the next time the computer wakes up", and that it coalesces several missed intervals into one. A
laptop asleep at 22:00 fires `git-sync-all` at 08:30 when it opens, in the middle of the user's work, and possibly alongside the 07:00 pull job. WSL cron does
the opposite: when the VM is down the job is skipped. Neither behaviour is stated, and `nextAt`, the runs list and the stats all assume on-time fires.
→ State the catch-up behaviour per platform and pick one rule. Either accept it and mark such runs `late` (the wrapper compares now with the previous cron slot
from `nextAfter`), or have the wrapper skip a `--trigger schedule` fire that comes more than N minutes after its slot, with a `refused`-style record.

**I3 — lines 82, 179: permission-mode values are not validated, and the clamp silently raises unknown ones to `auto`.** Only `bypassPermissions` is refused.
`clampPermission` maps any value outside `PERMISSION_MODES` (`plan`, `acceptEdits`, `auto`, `bypassPermissions`; `server/lib/spawn.ts:57`) to `auto`'s index
(`modeIndex`, `spawn.ts:94–97`). The CLI also accepts `manual` and `dontAsk` (`claude --help`, 2.1.303). Both are less permissive than `auto`, and both run
as `auto` under the rule at line 179. → Validation accepts exactly `plan | acceptEdits | auto` and refuses everything else with the value named. Say the same of
`effort` (`EFFORTS`, `spawn.ts:63`) and `model` (`MODELS`, `spawn.ts:60`) or state that those pass through unchecked.

**I4 — lines 105, 199: a run-level failure has no representation in the log.** Line 105 ends a fan-out run "before its first step with `failed`, `why: no pins
snapshot`". But `end` carries only step counts and no `why` (line 199). `end.failed` "counts every non-ok, non-skipped step" (line 175), so this run has
`failed = 0`. The push fires on `failed > 0` (line 292), so it never fires. The pill reads ok, and the title would read "0 of 0 failed". The same gap applies to
any refusal made before step 1: wrapper-side `bypassPermissions` (line 179) and an invalid file (I10). → Add `error` (a short why) to `end`, define
`failed > 0 || error` as a failed run for the pill and the push, and give the push title for it (e.g. `<job> · failed before any step`).

**I5 — line 120: "A worktree has no `.env`" is false for this repo's own verification setup.** The routine worktree server gets its own `.env` with
`PORT=4273 WEB_PORT=5273` (`docs/superpowers/reviews/2026-10-02-git-fetch-review-2.md:66`, `docs/superpowers/plans/2026-10-16-tailnet-write-trust.md:266`).
A session that copies main's `.env` to pick up `ANSWER_TOKEN` or `NTFY_TOPIC` also copies `SCHEDULES_OWNER=true` and makes a second owner. `loadConfig` also
honours `process.env` over the file (`server/lib/config.ts:3`, `:305`). → Drop the "has no `.env`" argument. Make ownership something a copy cannot
duplicate, e.g. an owner lock under `~/.claude/schedules/owner.lock` (pid + command-line check, same as job locks) that a second server sees and then
serves read-only with the chip naming the holder.

**I6 — lines 120–121: the two-owner detection rule fires on every restart and on every lock.** The rule is "finds a lock or plist it did not write in this
process's lifetime". Every plist on the machine was written by a previous lifetime of the same owner, so every restart reports a misconfiguration. Locks are
written by the wrapper, never by the server (line 166), so every lock qualifies too. → Fold this into I5's owner lock, or base the check on something a second
owner actually leaves behind.

**I7 — lines 117–119: a non-owner server's routes and pushes are unspecified.** "Every write control hidden" covers the UI only. The worktree API is
reachable, and PUT, POST, DELETE, PATCH, `/run`, `/stop` and `/reconcile` would write the shared `~/claude-global/schedules/` folder, spawn the wrapper or
signal it. Pushes are also unassigned. Line 296 has "the server" fold and send. A non-owner with an `NTFY_TOPIC` (`maybeSend` gates only on
`config.ntfyTopic`, `server/lib/notify.ts:351`) would push too. It cannot write `notified.json` (line 119), so it would re-push the window on every restart.
→ State that every schedules write route answers `409 { error: 'not-owner' }` on a non-owner, and that only the owner folds for notifications and sends
`schedule-failed`.

**I8 — lines 128, 150: drift as defined cannot see the example it gives.** On mac, installed means "every plist under `~/Library/LaunchAgents/`" with the
label prefix. Reconcile writes the plist before `bootstrap`, so a plist launchd refused is still on disk, counts as installed, and shows no drift. Yet line 150
gives "launchd refused a plist" as the drift example, and line 151 says drift is "re-read from the OS". → Define mac installed as the plists that are also
loaded (`launchctl print gui/<uid>/<label>` exits 0), and say what each 3 s poll spawns (see also M12).

**I9 — line 144: the inline crontab env has no quoting rule, and WSL's PATH breaks it.** cron hands the command line to `/bin/sh`. By default WSL appends the
Windows PATH, so the server's PATH contains `/mnt/c/Program Files/…` and `/mnt/c/Program Files (x86)/…`. Unquoted, `PATH=… node …` splits at the space
and fails with an sh syntax error at `(`. cron also turns an unescaped `%` into a newline. → Single-quote every baked value (with `'\''` for embedded quotes),
reject or escape `%` at render time, and add a test with a PATH containing a space, parentheses and `%`.

**I10 — line 165: the wrapper's behaviour when it fires against a file that changed while the dashboard was down is undefined.** With the server down (the
case line 36 promises works), a `sync.sh pull` can delete the file, make it invalid, set `enabled: false`, or drop this machine from `machines:`, and the
installed plist or cron line keeps firing. Step 1 says only "parse and validate". It never says what a missing or invalid file does, and it never checks
`enabled` or `machines`. Today such a fire writes nothing, so the run vanishes, against anti-goal line 52. → For `--trigger schedule`, the wrapper refuses
without running when the file is missing, invalid, disabled, or no longer names this machine. It writes a `refused` record with a `why`, and an invalid or
missing file also counts as a run-level failure (I4) so it pushes. `--trigger manual` keeps running paused jobs (line 215).

**I11 — lines 184–186: `remote-decision-hook.sh` ignores the marker and tells a scheduled step to stop and ask in prose.** It is registered user-globally on
`UserPromptSubmit` (`scripts/install-hooks.sh:88`). Its own comment says a headless `claude -p` matches both its gates (`scripts/remote-decision-hook.sh:25–31`):
the mode is `auto` by default (line 82; `MODES`, `:60`) and remote answers are on. With AskUserQuestion disallowed, it injects "ask in prose rather than
deciding silently" (`:113–115`). A step that ends its turn on a prose question returns `is_error: false`, which line 174 logs as `ok`: the job did nothing,
reads green, and pushes nothing. `plan-remote-hook.sh` (PermissionRequest[ExitPlanMode]) and `permission-notify-hook.sh` (PermissionRequest, pushes) are
not discussed either; `permission-mode: plan` is a legal job value. → List every user-global hook and its behaviour under `CLAUDE_DASHBOARD_SCHEDULE`. At
minimum, `remote-decision-hook.sh` exits 0 on the marker. Say whether the two PermissionRequest hooks fire under `-p` at all, and make them exit on the
marker if they do.

**I12 — lines 202–203: the age clause marks a demonstrably live run as lost.** A run is lost if its pid is dead or mismatched, *or* if it is older than
`timeout × steps + 5 min`. A laptop that sleeps mid-run wakes with the wrapper alive and its command line matching, but past the age limit. The run then
reads lost, and pushes, while the lock is live, `Job.running` is true (line 221) and Run now answers `409 already-running`. → Apply the age clause only when
liveness cannot be checked, or only when the lock is not live. Say what a run that is both lost and running displays.

**I13 — line 296: a lost run has no event that triggers its push.** Folding and sending happen "on an `fs.watch` of `runs/` and on start". A wrapper killed
with SIGKILL writes nothing, and a lost-by-age run needs only time to pass, so neither produces a file event. With no tab polling, the push waits for the
next append (often the next day's job) or a server restart. Line 296's "a push goes out with no browser open" is false for lost runs. → Either accept the
delay and say so, or allow one timer per in-flight run (armed at its `start`, firing at its grace) as a named exception to non-goal line 40.

**I14 — line 292: the push copy for a lost run is undefined.** The title is `<job> · <n> of <N> failed` and the body "the first failed step's `why`". A lost
run has no `end`, no failed count and possibly no failed step. → Give the lost copy explicitly, e.g. title `<job> · lost`, body `no end record · started
<time>`, and the same copy for I4's run-level failure.

**I15 — lines 140–142, 212: the `/run` child's environment is ambiguous.** "One list … used for both the installed job and the `/run` spawn" alongside "nothing
reaches a child unless baked" can be read either as baked-only or as `process.env` plus baked. If the server's env is inherited, a manual run carries what
launchd never gives: `CLAUDE_CODE_ENTRYPOINT` (which mislabels the transcript, so `spawn.ts:630–643` deletes it), `CLAUDE_DASHBOARD_ONESHOT`, `BM_ORCH_RUN`
from a server started inside a Claude shell. Manual and scheduled runs then behave differently. → State that the `/run` child gets exactly
`scheduleEnv(config)` and nothing else, so it matches launchd and cron.

**I16 — line 245: "`shared/frontmatter.js` is generated" names the wrong place.** The generated copies live in `plugin/lib/` (line 243). A real
`shared/frontmatter.js` beside `shared/frontmatter.ts` would be picked up by Vite and tsx for every `../shared/frontmatter.js` import in place of the TS source.
→ `plugin/lib/frontmatter.js`.

**I17 — line 243: generated ESM `.js` in a plugin with no `package.json` loads as CommonJS on Node before 22.7 / 20.19.** `plugin/` has no `package.json`,
and the installed copy under `~/.claude/plugins/cache/…/<version>/` has none either. Without `"type": "module"`, `.js` is CommonJS unless the runtime's
ESM-syntax detection is on (unflagged in 22.7 and 20.19). The repo allows `node >=18` (`package.json:28–29`). This machine runs 22.23.1; the WSL box is
unverified. On an older Node the wrapper's first `import` throws before `start` is written, so the run vanishes. Existing plugin code avoids this with
`.mjs` (`plugin/skills/kaizen/kaizen.mjs`). → Generate `.mjs` (rewriting specifiers to `.mjs`), or ship `plugin/lib/package.json` with
`{"type":"module"}` and allow it in the manifest test.

**I18 — line 242 vs mockup line 456: whole-line comments are unspecified.** The rule is "a ` #` outside quotes starts a comment", which a line starting at
column 0 with `#` does not match. Such a line is not `key: value` either, so by line 242 it is an error. The mockup's Shell template has exactly such a line
(`# pinned = every pinned repo; …`, mockups line 456). → Say whether a frontmatter line whose first non-blank character is `#` is a comment, and make the
drawer templates agree.

**I19 — lines 327, 334 vs 205–207: the log reader is decided in one place and left open in two others.** Lines 205–207 decide on an incremental offset+inode
reader and say `readTail` "is not reused". Line 334 still leaves "the `readTail` reuse or a new offset-cached reader" to the builder, and line 327 still
lists a "2 MB full-read threshold" that nothing else defines. → Delete the line-334 item and the "2 MB" clause.

## Minor

- **M1 — line 153:** "the installed plugin's `bin/run-schedule.mjs`" contradicts the next sentence ("It is `lib/`, not `bin/`"). The path example at line
  154 also omits the version segment: the real install path is `…/claude-agents-dashboard/0.3.0/` (`~/.claude/plugins/installed_plugins.json`
  `installPath`). It is versioned by `plugin.json`'s `version`, so an unbumped version reinstalls into the same directory (line 147 says "a new versioned
  directory").
- **M2 — line 275:** "Reveal in Finder/Explorer (the existing open-folder route)" contradicts lines 232 and 277 (`/reveal`, hidden on wsl). The mockup says
  "Reveal in Finder". "Copy launchd label" has no meaning on wsl either; say it is hidden there.
- **M3 — line 312:** the "Calls I made" env list omits `SCHEDULE_MACHINE` and `SCHEDULES_DIR`, which line 142 includes.
- **M4 — line 60:** "`shared/frontmatter.ts` stays the one parser both sides run" contradicts lines 243 and 246–247, where `schedule-file.ts` and `cron.ts`
  (both parsers) also run on both sides.
- **M5 — line 150 (round-1 M2, grown):** the chip now has at least eight states across the document (`in sync`, `drift N`, `reconcile failed`,
  `pending · running` (137), `cron not running` (130), `plugin not installed` (157), `claude cli not configured` (181),
  `read-only · owned by another server` (118), `bad SCHEDULE_MACHINE` (110)). `reconcile.state` at line 221 still has no enum. List them once with colour
  and precedence.
- **M6 — line 172 vs 174:** "Exit 0 if every step exited 0" disagrees with the outcome mapping: a claude step that exits 0 with `is_error: true` is failed, and
  a skipped step has no exit. Say "exit 0 when `failed == 0`".
- **M7 — line 137:** a deferred update re-runs "when the runs watcher sees the `end`". A run that goes lost never writes `end`, so the pending update waits for
  an unrelated trigger. Re-run on lock release as judged by the liveness check, too.
- **M8 — line 196:** `start` carries `pid` but no boot id, so after a reboot the lost check cannot tell a reused pid from the original. The lock has the boot
  id; copy it into `start`.
- **M9 — line 104:** `pins.json` is written only on start and on pin changes, but `listed` and `path` come from disk and transcripts
  (`server/lib/management.ts:713–729`). If a repo is deleted or moved after the snapshot, the step's cwd is missing. Say the wrapper checks that the cwd
  exists and skips with `why: cwd missing`. Line 105's "current whenever it matters" overstates it.
- **M10 — line 292:** a run the user stops with Stop counts as failed (line 175) and pushes. Say whether that is intended.
- **M11 — lines 293–297:** when the desk topic wins, `routePush` sets the click to `/api/dismiss`, not the run link (`server/lib/notify.ts:290–291`). With
  `publicUrl` unset, Click is omitted (`notify.ts:250`). Say which applies to `schedule-failed`. Existing pushes title every message "Claude Code"
  (`notify.ts:380`), and this one titles by job, so call that out.
- **M12 — lines 151, 262:** re-reading drift "from the OS on every Jobs poll" spawns `crontab -l` and `pgrep`, or `launchctl` per job, every 3 s per open
  tab. Cache it for a few seconds or read it on Jobs-tab polls only.
- **M13 — line 293:** the new `schedule-failed` checkbox defaults to off for every existing install. `DEFAULT_NOTIFY` has every event false, and
  `mergeNotify` fills absent keys from it (`server/lib/settings.ts:56–62`, `:187`). An older checkout reading a settings file that has the key rejects the
  whole notify block (`settings.ts:162`) and falls back to all-off. State the default and accept the downgrade case.
- **M14 — lines 59, 337:** `test/outbound.test.ts` pins network modules and `fetch` only (its header, `:1–8`), not process launches. The list of launching
  modules is `.claude/CLAUDE.md` §Code rules (`:76–81`), and the docs list should add the new server module there, for `launchctl`, `crontab`, `pgrep`,
  `ps` and `sysctl`. Line 59 still names `git`, which nothing here has the server launch (round-1 M7).
- **M15 — line 130:** `pgrep -x cron|crond` is a shell pipe as written; mean `pgrep -x 'cron|crond'`, or two calls.
- **M16 — still open from round 1, not repeated in full:** M1 (`sync-plugin.ts` POSTs reconcile without `apply`; line 148), M3 (`setSpawner` is
  module-private, line 212), M4 (no PUT precondition for `on disk changed`, line 277), M6 (tab position, line 254 vs `SideRail.tsx:89` order Projects | Git |
  CodeGraph), M8 (rotation naming and straddling runs, line 208; also re-reading a renamed file from 0 double-folds unless the fold is keyed by run and step),
  M11 (expansion size cap, line 139; also cron's day-of-month/day-of-week OR rule for `nextAfter` and the launchd dicts), M12 (`kern.boottime` needs a
  `sysctl` spawn, line 166), M13 (shell jobs are unbounded by `SPAWN_MAX_PERMISSION`, Security), M14 (`notified.json` first-sight bound, line 299), M16 (schedule
  runs take Sessions rows and read `dashboard`), M17 (mockup copy not called out: "Keep paused" at mockups line 510 vs "Save, keep paused", "5 installed · in
  sync" at 238, phone "New" at 296, the run-now toast "started on lookout · open session" at 635).

## Verified true

`PERMISSION_MODES` and `clampPermission` (`server/lib/spawn.ts:57`, `:106`); `SYNC_PERMISSION_MODE` and `SPAWN_MAX_PERMISSION` default `auto`, `CLAUDE_BIN`
default empty (`server/lib/config.ts:148–150`); `.env` read from `<cwd>/.env`, overlaid by `process.env` (`config.ts:299–305`); `listPinRows` dead-pin shape
(`management.ts:722–729`); `liveCwds` null fails open (`scan.ts:540–545`); `serveOpenFolder` is pin-only and darwin-only (`server/api.ts:1867–1879`);
`openFolder` (`server/lib/open-folder.ts:27`); `readViewParam` knows only `git` (`client/src/lib/deepLink.ts:29–35`); `maybeSend` needs a session id
(`notify.ts:345–349`); the Stop hook's `CLAUDE_DASHBOARD_REFRESH` exit (`scripts/stop-notify-hook.sh:42`); `PUBLISHED_PATHS` (`scripts/sync-plugin.ts:27`);
the manifest test pins `plugin/` to `.claude-plugin` and `skills` (`test/plugin-manifest.test.ts:55–58`); profile detection matches
`~/claude-global/bootstrap.sh:30–33`; the CLI's `--disallowed-tools`, `--permission-mode` choices, `--effort` and `--session-id` (2.1.303 `--help`); the
CLAUDE.md exception lines (`.claude/CLAUDE.md:16`, `:63`) and `docs/overview.md:6`.
