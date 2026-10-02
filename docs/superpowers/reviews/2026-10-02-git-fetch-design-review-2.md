# Review 2 — `docs/superpowers/specs/2026-10-02-git-fetch-design.md`

Reviewed 2026-10-02 against `main` at `43fc6ca` ("docs: address spec review 1"), the linked mockup and the parent spec (`2026-10-01-git-stats-design.md`).
Claims were checked against the code. git's own behaviour was checked on this machine (git 2.50.1, Apple Git-155) in a scratchpad repo: the D4 argv, the
`offline` and `lock` stderr, and whether `GIT_ASKPASS` runs under `GIT_TERMINAL_PROMPT=0` (a throwaway local HTTP server that answers 401, killed by its pid).
Nothing left the host.

**Verdict: APPROVE WITH FIXES.** Nothing is Critical. Round 1's fourteen Important findings are addressed, except the second half of its #7 (a stale
`fetching…`), which comes back below as I2. Six Important findings remain. Four are edge transitions in the clock and early-poll model (I2–I5), one is a
prompt path that D5 and the verbatim Settings hint say cannot happen (I1), and one is an unspecified failure path (I6). Each fix is a sentence or two in
the spec plus one test case, and none needs a redesign.

## Critical

None.

## Important

**I1. Lines 5–6, 16 and 29 (D5): the fetch can still prompt, and the verbatim Settings hint says it never will.**

- **User ssh commands.** When `core.sshCommand`, `GIT_SSH_COMMAND` or `GIT_SSH` is set, D5 leaves ssh untouched, so `BatchMode` is never added.
  - OpenSSH reads a key passphrase from `/dev/tty`, not stdin.
  - `execFile` passes the child the server's controlling terminal, which is the `pnpm dev` / `pnpm start` terminal.
  - So a `core.sshCommand = ssh -i ~/.ssh/id_work` setup, with a passphrase key that is not in the agent, prints `Enter passphrase for key …` in the
    dashboard's terminal on every interval and hangs until the 30s timeout.
  - The result is classified `timeout` ("fetch timed out"), not `auth`.
- **Askpass.** `GIT_TERMINAL_PROMPT=0` does not stop git's askpass.
  - Probed here: with `GIT_ASKPASS` set, `git fetch` over an HTTP remote that answers 401 still ran the askpass program twice (Username, then Password).
    Only then did it fail with `Authentication failed`. Without `GIT_ASKPASS`, it failed with `could not read Username … terminal prompts disabled`.
  - git consults `GIT_ASKPASS`, then `core.askPass`, then `SSH_ASKPASS`, before it checks `GIT_TERMINAL_PROMPT`.
  - VS Code's integrated terminal exports `GIT_ASKPASS`, so a server started there pops VS Code's credential dialog on every interval.
  - That prompt is inside git's control, not "outside git's control" as D5 says.
- **The copy.** The Settings hint, built verbatim from mockups.html:278, says "Never pulls, never asks for a password or passphrase: a repo that needs one
  shows "needs auth"". D5's own last sentence contradicts it.

→ Pick one mechanism and state it:

- either spawn the fetch `detached: true`, a new session with no controlling tty (ssh then cannot open `/dev/tty`), and kill the process group on timeout;
- or append `-o BatchMode=yes` to a user's `core.sshCommand` / `GIT_SSH_COMMAND`.

Also blank `GIT_ASKPASS` / `SSH_ASKPASS` and pass `-c core.askPass=`, or say that they are kept and why. Then correct D5's "outside git's control"
sentence. Finally, either soften the hint or list it as a deliberate deviation from the mock (line 16). Test 6 needs a case for each choice.

**I2. Lines 122–123 (with 36, 120 and 142): the 3s early poll lands before the 5s tick about half the time, and a poll that catches the fetch leaves
`fetching…` stuck.**

- The timer is a 5s `setInterval` that fires at the first tick ≥ `nextAtMs` (line 66–68). So the fetch starts 0–5s after the chip reads `0s`, and runs
  for about 0.5s.
- The early poll fires at `nextAtMs + 3s`. It sees the finished fetch only when tick lag plus fetch time < 3s, which is about 50% of cycles.
- About 40% of cycles: the poll arrives before the tick. The answer carries the same `nextAtMs`, the early poll is "not again for the same value", and the
  chip sits at `0s` until the next 30s poll.
- About 10% of cycles: the poll arrives during the fetch. The answer carries `runningSinceMs`. The chip then shows `fetching…`, every card shows
  `fetching…` (.live, line 142), and the Fetch-all key stays disabled (line 131) until the next 30s poll, all for a fetch that ended within a second.
- At a 30s interval the stale `0s` can also turn into a false amber `overdue` for a few seconds before the next regular poll, since the threshold
  `nextAtMs + interval` equals the poll period.
- §4's claim that a timer fetch "shows within seconds instead of at the next 30s tick" therefore holds for roughly half the fetches. This is the second
  half of round 1's #7, which was not addressed.

→ Do two things:

- Time the early poll after the tick can have fired and finished, for example `nextAtMs + 5s + ~2s`, or replace the 5s tick with a `setTimeout` at `nextAtMs`.
- Say what a payload that caught `runningSinceMs` does next, for example one more early poll a few seconds later.

Alternatively, state the accepted staleness, including the disabled key, in D12. Add the chosen delay to the client tests.

**I3. Line 122 vs D2 (line 26): the early poll is not gated on visibility, so a hidden tab can keep the server fetching indefinitely.**

- The 30s poll stops while the page is hidden (`client/src/lib/gitPoll.ts:6-7,23-33`). That is what lets the server see a hidden tab as unwatched.
- The early poll calls `refresh()`, which polls whatever the visibility (`client/src/hooks/useGitStats.ts:66`). Browsers keep running a background tab's 1s
  interval, throttled to about once a minute after 5 minutes hidden.
- So a hidden tab still notices `0s`, sends one `GET /api/git-stats` per `nextAtMs`, and re-marks the server watched.
- At 2m or more, the grace `max(2 × interval, 90s)` is longer than the gap between those GETs. Under throttling the GET also lands after the fetch has
  finished, so the answer carries a fresh `nextAtMs`. The loop keeps itself going.
- That contradicts D2's watched-only rule, and the intro's "only while somebody has the Git view open".

→ Fire the early poll only while `document.visibilityState === 'visible'`, or route it through `startGitPoll`'s visibility rule. Add a client test: a
hidden page never early-polls.

**I4. Lines 52–53 and test 7 (167–168) contradict lines 69–70 and the §2 field table (line 82) on `nextAtMs` while unwatched.**

- §1 says `fetchAll` sets `nextAtMs = lastEndedMs + interval` whenever the interval is non-zero.
- Test 7 expects that value "with no timer started", which means unwatched: nothing has called `markGitWatched()`.
- Lines 69–70 and §2 say `nextAtMs` is `null` "when off or unwatched".
- A POST, or test 7 itself, therefore has two required answers. A timer fetch that started while watched and ends after the grace expired leaves the
  same question open.

→ Make `fetchAll` set `nextAtMs` only when the interval is on **and** watched (watched is computable from the last-read time without the timer). Have test 7
call `markGitWatched()` first, and add an unwatched case that expects `null`.

**I5. Line 69 (test 8, line 170): a change between two non-zero intervals skips D11's clamp.**

- `lastEndedMs + newInterval` is right when the interval grows. When it shrinks, the result can lie far in the past. Example: 600 → 30 with the last fetch
  100s old gives `nextAtMs = now − 70s`.
- Any Git view whose poll lands before the next tick reads `now > nextAtMs + interval`, which is amber `overdue` (line 120).
- That view never reaches `0s` for that `nextAtMs`, so the early poll never fires. `overdue` stays up to 30s, although the fetch ran within 5s.
- If the change lands before the first fetch has ended, `lastEndedMs` is still `null`. In JS `null + 300_000` is 300000, so `nextAtMs` becomes 1970.
- While unwatched, the rule should leave `nextAtMs` `null`, and the sentence doesn't say so.

→ Apply D11 on every interval change while watched: `now` when `lastEndedMs` is null or older than the new interval, else `lastEndedMs + new`. Add a
600 → 30 case and a change-before-first-fetch case to test 8.

**I6. Lines 45–50, 52–53 and 89–90: the failure of every call other than the fetch is unspecified.**

- §1 specifies only how the fetch's own stderr is classified. Three other calls can fail:
  - the per-pin `rev-parse`;
  - the per-group `git remote`;
  - `git config --get core.sshCommand`.
- A spawn error is the concrete case. A pin folder deleted after `listPinRows`, or a missing `git`, fails `execFile` with `ENOENT`. The reader handles
  exactly this race (`server/lib/git-stats.ts:180-181`), and its runner rejects on a spawn error (`git-stats.ts:68-69`).
- "A dead or non-git pin is skipped" covers a `null` path and a non-zero `rev-parse`, but not a rejection.
- If `fetchAll`'s `Promise.all` rejects, three things go wrong:
  - every group's result is lost;
  - `runningSinceMs` stays set unless it is cleared in a `finally`, so the chip, every card and the disabled Fetch-all key read `fetching…` until a restart;
  - the POST's `void` handler never answers. `server/index.ts:68` only logs the rejection.
- §2 lists no 500 path, although §4 builds UI for one.

→ State that `fetchAll` always resolves:

- a probe call that rejects or times out skips that pin (or records `other` for a known toplevel);
- the clock is cleared in a `finally`;
- `POST /api/git-fetch` answers `500 { error }` if `fetchAll` throws anyway.

Add a test-4-style case with a runner that rejects.

## Minor

- **Line 26 (D2):** "at most one or two more fetches" is false at 30s. With the 5s tick, starts are 35s apart (`lastEndedMs + 30s`, rounded up to the
  next tick). So the starts T1, T1+35 and T1+70 all fall inside the 90s grace whenever T1 ≤ last read + 20s: that is three fetches. The count is two at
  every interval ≥ 60s. The prose is carried into `git-stats.md` by §6, so correct it there too.
- **Line 28 (D4):** git-sync neutralises hooks on its own fetch (`-c core.hooksPath=/dev/null`, `plugin/skills/git-sync/tools/git-sync.mjs:528,556`). Its
  comment at 551–554 explains why: `fetch` runs `reference-transaction`. The timer fetch runs the repo's hook unattended every interval. Test 6 pins the argv
  "exactly", so the spec has to decide this either way.
- **Line 34 (D10):** a `lock` failure still rewrites `FETCH_HEAD`. Probed: exit 1 with `cannot lock ref`, and the `FETCH_HEAD` mtime advanced. Since `lock`
  "shows nothing", the card's plain age then reads "fetched 0s ago" for a ref that did not move. Accepting that is fine, but say so.
- **Line 43:** `FetchRunner`'s `env` is unspecified: is it the whole environment or an overlay on `process.env`? It's also unstated whether the default runner
  adds `LC_ALL=C` and `GIT_OPTIONAL_LOCKS=0` itself. If it does, test 6 cannot see `LC_ALL=C`, and §1's English-pattern classifier depends on it.
- **Lines 49–50:** `lastFetch` is keyed by toplevel and never cleared. A repo whose `origin` is removed after an `auth` failure keeps "needs auth" on its
  card and in the popover until a restart. Say that a skipped group clears its toplevels' entries.
- **Line 66:** say `startGitFetchTimer` goes inside `server/index.ts`'s main guard beside `startUsageRecording` (`index.ts:387`). The API harness imports
  `createRequestListener` from `index.ts` (`test/api-harness.ts:36`), so a module-level call would start the timer in every API suite.
- **Line 67:** `getSettings()` on every 5s tick re-reads `~/.claude/settings.json` twice (`detectIdleOverride` / `detectAnswerOverride` →
  `readFileSync`, `server/lib/settings.ts:223-230`). That is about 34,560 reads a day for a value already in the module cache. A small cached getter, or
  reading `cached.gitFetchSecs`, does the job. (`usage-history.ts` ticks far less often.)
- **Line 108:** "Rendered only once there is a payload" removes ↻ from the first-load-failure state. Today `GitBandStatus` renders ↻ whatever the data
  (`client/src/components/management/GitView.tsx:72`). Call the loss out.
- **Line 111:** the mock's `live` tone also colours the value `--cyan` (mockups.html:112), but the spec mentions only the fill. The mock also gives the
  popover `role="dialog" aria-label="Sync and fetch"` and the chip `aria-expanded`, and the spec is silent on both.
- **Line 114:** `nextPollAtMs` needs `startGitPoll` to expose when its interval next fires. Today it hides that (`client/src/lib/gitPoll.ts:21-35`), and the
  module is tested apart from the DOM. Say that the poll module and its tests change.
- **Line 120:** taken literally as first-match-wins, `overdue` and `0s` are evaluated before the `…` row's `nextAtMs === null` case. In JS
  `now > null + interval` is true, so an implementer can produce `overdue`. Put the null row first.
- **Line 123:** "After a manual fetch's POST resolves, `refresh()` runs at once". But `refresh()` is a no-op while a poll is in flight
  (`useGitStats.ts:13,31`), and that poll, or a server read it joined (`server/lib/git-stats.ts:380-384`), may predate the fetch. The new counts then wait
  for the next 30s poll. This is rare. Either accept it or queue one poll after the in-flight one.
- **Line 142:** cards take only the payload clock, so during a manual fetch the chip reads `fetching…` while every card shows the old age. If that is
  intended, say so.
- **Lines 142–144:** Triage's Quiet summary is one joined plain string (`client/src/components/management/GitTriage.tsx:62`), so `.warn` and `.live` cannot
  tint the fetched part. Say whether the tone is dropped there.
- **§5:** tests 7–9 need an injected clock, an injected setting and a module reset. The harness's `resetStores()` (`test/api-harness.ts:129`) is the
  precedent. Only `overrideFetchRunner` is named. The API test's "first answer after an unwatched stretch" can't be reached in `run-all.ts`'s single
  process, after `api-git-stats.test.ts` has read the route, unless there is a reset or a clock seam.
- **Line 199:** `README.md:15` has no CLI-launcher clause, so "the same clause … like the CLI launchers" has nothing to point at there. Give the README its
  own wording.
- **Line 200:** `.claude/DESIGN.md` §8.4b has no class list (`DESIGN.md:340` says only "Every class is `git-` prefixed"). Name the sentence that changes.
- **§6:** five docs and comments become false and are not listed:
  - `docs/overview.md:35-49`, the Read-only charter. It names spawn as "the one exception that reaches outside the dashboard's own state", but the fetch now
    writes refs, objects and `FETCH_HEAD` into the user's repos.
  - `docs/subsystems/settings.md:48`: "the app's second and last write to disk".
  - `server/index.ts:226`'s comment: "The only write endpoints in the app".
  - `server/index.ts:11`'s route list.
  - `shared/types.ts:1554`'s `RepoGitStats` doc: "read-only and with no network", once `lastFetch` rides in it.

## Checked and true

- `GitRunner` is `(cwd, args)` (`git-stats.ts:18`), `GIT_TIMEOUT_MS = 5000` (`:38`), `listPinRows(config, …)` in `readAll` (`:389`), `generatedAt: Date.now()`
  (`:399`), the `FETCH_HEAD` worktree comment (`:144`), and the one `rev-parse --path-format=absolute --show-toplevel --git-common-dir` call plus `git remote`
  (`:231,248`).
- `Stored` is at `settings.ts:75`. `setSettings` refuses the whole patch on a bad key (`:246-280`). `readStored` falls back per key, so old stored data
  without `gitFetchSecs` reads the default.
- The usage-history timer shape is an unref'd `setInterval` that re-reads the setting on every tick (`usage-history.ts:826-833`).
- `tokenOk` guards `POST /api/settings` (`api.ts:970`), `methodNotAllowed` exists (`index.ts:131`), and `/api/health` carries `tokenRequired` (`api.ts:520`).
- `SYNC_NEEDS_TOKEN` is at `client/src/lib/gitSync.ts:25`. `useDismiss` is exported from `Popover.tsx:10`. Segmented's "two to four" comment is at
  `SettingsRow.tsx:74`.
- The git-sync `fetch --all --prune` is at `git-sync.mjs:556`, stopping with `fetch-failed` at 557–558. `GitFixture.bare()` and `.clone()` are at
  `test/git-fixture.ts:78,93`.
- `GitTriage.tsx:62` calls `gitFetchedText`.
- `ALLOWED` and the plural doc claim in `test/outbound.test.ts` are as stated. `fetchAll(` does not trip the `fetch(` scan.
- The D4 argv `fetch origin --quiet --no-prune --no-recurse-submodules --no-auto-maintenance` runs on git 2.50.1, and a real fetch from a local bare origin
  moved `behind` from 0 to 1.
- Probed stderr matches the classifier:
  - `Failed to connect to 127.0.0.1 port 1 after 1 ms: Couldn't connect to server` (https), which is `offline`;
  - `ssh: connect to host 127.0.0.1 port 1: Connection refused`, which is `offline`;
  - `error: cannot lock ref 'refs/remotes/origin/main': Unable to create '….lock': File exists.`, which is `lock`;
  - `could not read Username … terminal prompts disabled`, which is `auth`.
- The skew case recomputes: `skewMs = (S − 5000) − S = −5000`, and the reading is `S + 10000 − 5000 − (S − 5000) = 10s`; uncorrected it is `15s`.
- Test 8's grace values are right: `max(120, 90) = 120s` at 60 and `max(60, 90) = 90s` at 30. Test 9's four D11 cases agree with §1. `3:12` at 192s
  left of 300 is correct.
- The mock's band sub-line, Settings sub (minus the period), segment labels, popover sub-lines and chip accessible name match §3/§4.
