# Review 1 — `docs/superpowers/specs/2026-10-02-git-fetch-design.md`

Reviewed 2026-10-02 against `main` at `bf47975`, the linked mockup and the parent spec (`2026-10-01-git-stats-design.md`). Claims were checked against the code,
and git's own behaviour was checked on this machine (git 2.50.1, Apple Git-155) with a scratch repo whose `origin` pointed at `127.0.0.1:1`, so nothing left
the host.

**Verdict: REVISE.** Nothing is Critical, but the timer and clock model (§1 together with §4's FETCH table) has four separate holes, and two of the D5/§1
classifier facts don't hold on this machine. Each fix is a local edit. The state machine is the core of the feature, so it deserves a second look once fixed.

## Critical

None.

## Important

1. **Line 26 (D5): setting `GIT_SSH_COMMAND` replaces the user's `core.sshCommand`.** The spec skips the override only when `GIT_SSH_COMMAND` or `GIT_SSH` is
   already in the environment, and says this is "so a user's ssh wrapper is kept". `man git-config` says `core.sshCommand` "is overridden when the environment
   variable is set". So a repo or global config that picks its key with `core.sshCommand = ssh -i ~/.ssh/id_work` (the usual multi-account setup) loses that key
   on every timer fetch and fails with `Permission denied (publickey)`. The repo then shows "needs auth" even though nothing is wrong with it. (This machine has
   no `core.sshCommand` set, so the live check would not catch it.)
   → Before choosing the env, read `git config --get core.sshCommand` in the group's toplevel. When it is set, use `GIT_SSH_COMMAND="<that value> -o BatchMode=yes"`,
   or leave both alone. Add a test-6 case for it.

2. **Lines 37–38 and 136: the shared `overrideGitRunner` seam can't carry D4's timeout or D5's env.** `GitRunner` is `(cwd, args) => …`, with no env and no
   timeout (`server/lib/git-stats.ts:18`). The module's `runner` is a private `let` with no getter (`git-stats.ts:359-364`). The default runner is fixed at
   `GIT_TIMEOUT_MS = 5000` with `GIT_ENV` (`git-stats.ts:38,44,55-63`). That leaves the implementer two options. Reusing the seam gives a 5s fetch timeout and an
   env no test can see, so test 6's "the runner receives `GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND`…" cannot be written. Building a second runner means it is no
   longer swappable through `overrideGitRunner`. On top of that, "never imports git-stats.ts' reader" is in tension with sharing a module-private variable.
   → Name the seam. One option: a `FetchRunner = (cwd, args, env) => …` built by `makeGitRunner({ timeoutMs: 30_000 })` with an env parameter, behind its own
   `overrideFetchRunner`. Then restate test 6 against that seam.

3. **Line 52: the `offline` patterns miss what curl actually prints here.** Probe: `git fetch origin` over `https://127.0.0.1:1/x.git` printed
   `fatal: unable to access '…': Failed to connect to 127.0.0.1 port 1 after 1 ms: Couldn't connect to server`. That line contains neither "Connection refused"
   nor "Could not connect", because "Couldn't" ≠ "Could not" even case-insensitively. So any HTTPS remote that resolves but can't be reached is classified
   `other` and reads "fetch failed". The ssh variant (`ssh: connect to host … : Connection refused`) does match. Test 5's table would pass while live behaviour
   is wrong.
   → Add `Failed to connect to` and `Couldn't connect to server` to `offline`, and add the probed line to test 5.

4. **Line 58 vs line 31 and line 142: the rule for retrying a `lock` result contradicts itself.** D10 says a `lock` result means "the next tick retries", and
   test 9 says "the timer's next tick runs again". A tick is the 5s `setInterval` (line 56). But §1 sets `nextAtMs = lastEndedMs + interval` after every run and
   makes no exception for `lock`. So one of them is wrong. It is also unstated whether a `lock` in one group re-runs only that group or every group.
   → Pick one: either `lock` is ordinary and the retry waits for the next interval (then fix D10 and test 9), or a run containing a `lock` sets
   `nextAtMs = lastEndedMs + 5s` for that group only. State which.

5. **Line 60 vs lines 78 and 144: unclear who owns `lastEndedMs`, `runningSinceMs` and `nextAtMs`.** §1 says "the timer owns the clock state". But
   `POST /api/git-fetch` calls `fetchAll` directly, and the API test expects `fetch.lastEndedMs` to be set afterwards. The API harness builds its server from
   `createRequestListener(cfg)` alone (`test/api-harness.ts:132`), so `startGitFetchTimer` never runs there. If the timer owns the state, that test fails. If
   `nextAtMs` is only recomputed on the next tick, the POST's answer carries a `nextAtMs` that is already ≤ now, and the timer may fire again right after the
   manual fetch.
   → Say that `fetchAll` itself sets `runningSinceMs` when it starts, and sets `lastEndedMs` and recomputes `nextAtMs` (when watched and on) as it settles,
   before it resolves. The timer only decides when to call it.

6. **Lines 58–59: turning auto-fetch on (Off → N) while the view is open is undefined.** The formula `nextAtMs = lastEndedMs + interval` is "recomputed when
   the interval changes". But `lastEndedMs` is `null` until the first fetch, and "on becoming watched" (D11) doesn't obviously cover "became on while already
   watched". Test 7 only covers 60 → 300 after a run.
   → Apply the D11 rule to an Off→on change as well, so `nextAtMs = now` when `lastEndedMs` is null or older than the new interval. Add that case to test 7 or 8.

7. **Line 103: the FETCH reading between polls is unspecified, and the client hits it every cycle.** Because of D7 the client learns the next `nextAtMs` only
   from the next 30s poll. Example: the server fires at `nextAtMs` (within 5s), but the client's countdown has already reached zero and has no new value. From
   then until `now > nextAtMs + interval`, the table defines no reading. At a 30s interval that gap is up to 30s of every cycle. The same staleness makes
   `fetching…` stick for a whole poll whenever a poll happens to land during a ~0.5s fetch. The precedence between `off` and `fetching…` when a manual fetch runs
   with auto-fetch off is also unstated.
   → Add a row for `nextAtMs ≤ now ≤ nextAtMs + interval` (for example `0s` with a full bar, or `due`). State the order of precedence: `fetching…` >
   `off` > `overdue` > `due` > countdown. Say whether the client's own POST in flight (not only the payload's `runningSinceMs`) drives `fetching…` on the chip
   and on the cards.

8. **Line 102 vs line 155: the SYNC meter's first-poll state can never be shown.** The SYNC meter defines "`…` with an empty bar while the first poll is out",
   but the client tests require that "the chip is not rendered before the first payload". If the chip isn't rendered until the first payload arrives, the `…`
   state never appears.
   → Pick one. Either render the chip from mount (FETCH reads `…` until a payload arrives), or drop the SYNC `…` state.

9. **Line 91 (and D9, line 30): the "couldn't update" state disappears.** Today a failed poll after the first one shows `GIT_UPDATE_FAILED` ("couldn't
   update") in the band's right slot instead of the age (`client/src/components/management/GitView.tsx:69-71`). That is the last row of the parent spec's copy
   table (line 244) and is documented in `docs/subsystems/git-stats.md:113-114`. This spec deletes `GitBandStatus` and the right slot. The SYNC meter's states
   (`12s` / `…` / `syncing…`) have no failure state, so after the first payload a failing poll is silently invisible.
   → Add a SYNC failure reading (for example `couldn't update`, amber) and include it in the client tests.

10. **Line 41: a fetch now runs alongside the reader and the Sync button's git-sync, which breaks a documented invariant.** `docs/subsystems/git-stats.md:94-95`
    and the parent spec (line 71) promise that "a pinned repo never has more than one git process alive". A timer fetch running beside a read breaks that, and
    the spec doesn't say so. Worse, the dashboard's own Sync button launches git-sync, whose `sync` phase runs `git fetch --all --prune` and stops with
    `fetch-failed` on any non-zero exit (`plugin/skills/git-sync/tools/git-sync.mjs:556-558`). A timer fetch holding a ref lock at that moment can fail the
    user's Sync run. D10 only considers the dashboard's own side of a lock clash.
    → Either skip a repo while `useGitSync`/the server knows a Sync run is live for it, or accept the race explicitly. Either way, update the invariant sentence
    in `git-stats.md` §"The memo, and per-repo sequencing", which §6 currently doesn't list.

11. **Line 111: the failure paths of `POST /api/git-fetch` have no UI.** The key is disabled only when `tokenRequired` is true and no token is stored. Three
    cases are unspecified: a stored token that is wrong (403), a network error, and a 5xx (for example a server restart mid-fetch). In each, the implementer has
    to guess what the key and row show. Other token-guarded flows in this view report a 403 (`client/src/hooks/useGitSync.ts:75-81`, `SYNC_NEEDS_TOKEN`).
    → Specify the copy and state for a 403 (the same token sub-line) and for any other failure (for example `couldn't fetch`, amber, key re-enabled). Add both
    to the client tests.

12. **Line 111: the copy names a Settings path that doesn't exist.** "`needs the answer token (Settings › Connection)`" is wrong: the Connection card is on the
    **Local** page (`client/src/components/settings/SettingsView.tsx:431,684`). The existing string for the same condition in the same view says
    `Sync needs the Answer token — set it under Settings › Local › Connection.` (`client/src/lib/gitSync.ts:25`).
    → Use `Settings › Local › Connection`, matching `SYNC_NEEDS_TOKEN`.

13. **Line 40: "the two `rev-parse` calls Git Stats already makes" is false.** It makes one: `rev-parse --path-format=absolute --show-toplevel
    --git-common-dir` (`server/lib/git-stats.ts:240`). §1 also never says how a group with no `origin` is detected. Git Stats uses `git remote`
    (`git-stats.ts:247`). Without that check, `git fetch origin` exits 128 with `fatal: 'origin' does not appear to be a git repository` (probed), which
    classifies as `other` and breaks test 4.
    → Say "the one `rev-parse --show-toplevel --git-common-dir` call", plus one `git remote` per group to decide whether to skip it.

14. **Line 154: the skew test's expected value is what an uncorrected countdown would show.** Recomputed: server now `S`, client 5s behind (`S − 5s`), so the
    skew is server − client = +5s. If `nextAtMs = S + 10s` ("10s ahead" of the server), shifting to the client clock gives `S + 5s` = client now + 10s, so the
    reading is **`10s`**. If "10s ahead" means ahead of the client's raw clock, the corrected reading is `5s`. Neither reading gives `15s`. `15s` is exactly
    `nextAtMs − clientNow` with no correction, or with the sign flipped. An implementer who makes this test pass ships a countdown that is off by twice the
    skew. The spec also never says which server timestamp the skew is measured from (`generatedAt` is the only server clock in today's payload,
    `server/lib/git-stats.ts:399`).
    → Measure skew as `clientReceiptMs − generatedAt`, restate the case unambiguously ("server 5s ahead of the client; `nextAtMs` = server now + 10s"), and
    expect `10s`.

## Minor

- **Line 14:** "§5 lists every repo whose last fetch failed": the trouble lines are in §4; §5 is Tests.
- **Lines 12–16:** two mock differences aren't listed. The mock's Settings sub ends with a period ("…landed on origin.") and line 85's doesn't. The mock
  preselects `5m`, while D3 makes the default Off.
- **Line 5 / D2 (line 23):** "A closed dashboard makes no network calls" is true only after the `max(2 × interval, 90s)` grace period. At 600s the server can
  still run two fetches over the 20 minutes after the tab closes. The mock's hint ("only while a Git view is open on some device") has the same imprecision.
- **Line 25 (D4):** "origin only, no `--prune`" isn't guaranteed by the argv alone. `fetch.recurseSubmodules` defaults to on-demand (`man git-config`), so a
  repo with submodules also fetches the submodule remotes. A user's `fetch.prune=true` / `remote.origin.prune=true` makes the timer prune anyway.
  `--no-recurse-submodules` (and `--no-prune`, if the guarantee matters) would make it true. Separately, `--no-auto-gc` and `--no-auto-maintenance` are
  synonyms: `git fetch -h` describes both as "run 'maintenance --auto' after fetching". The minimum git version for the latter (2.29) is unstated; an older git
  fails every fetch with "unknown option".
- **Line 26 (D5):** "Never prompts" overclaims. A GUI credential helper (GCM) or an ssh-agent's approval prompt (1Password, Secretive) isn't stopped by
  `GIT_TERMINAL_PROMPT` or BatchMode. The Verification section already flags the agent case as unverified, so the decision text should say the same.
- **Line 43:** the meaning of `atMs` (start or end of the group's fetch) is unstated. `message` is never shown anywhere in §4, so either say where it appears
  or drop it. "First stderr line" should be the first non-empty one.
- **Line 56:** `startGitFetchTimer()` needs `config` to build the pins: `listPinRows(config, …)`, as in `server/lib/git-stats.ts:389`.
- **Line 60:** the order of `markGitWatched()` relative to reading `getFetchClock()` for the same answer is unstated. It decides whether the first answer after
  an unwatched stretch carries `nextAtMs: null`, which the chip shows as `…`.
- **Line 83:** `Stored` lives in `server/lib/settings.ts:75`, not `shared/types.ts`. `clampGitFetchSecs` validates and never clamps (unlike `clampIdleSecs`,
  `settings.ts:96-100`), so a name like `parseGitFetchSecs` would read truer.
- **Line 86:** `Segmented`'s own doc says "two to four options" (`client/src/components/settings/SettingsRow.tsx:74-76`), and this row has six. The 375px fit
  should be added to the phone verification line. Also, `docs/subsystems/settings.md`'s `recordUsageHistory` reasoning ("with nobody necessarily watching") is
  exactly what D2 avoids, so "with the same reasoning" is only half true.
- **Line 96:** `.ui-meter` breaks `.claude/DESIGN.md` §8.4b's "Every class is `git-` prefixed". Either call out the exception or prefix it.
- **Line 97:** "pulses, still under `prefers-reduced-motion`" reads either way. Write "pulses; static under `prefers-reduced-motion`".
- **Lines 110–111 and 120:** two vocabularies for the same values: the popover says `1 min` and `5 min`, the Settings segments say `1m` and `5m`. "Local
  sync" and the SYNC meter also sit one row above each card's **Sync** (git-sync) button, so "sync" means two things in one view.
- **Lines 113–117:** "the age is `gitFetchedText`" is circular once `gitFetchedText` grows to return "needs auth · fetched 2d ago". Name the age-only helper.
  Triage's summary line also calls `gitFetchedText` (`client/src/components/management/GitTriage.tsx:62`), and "Triage is unchanged" doesn't say whether that
  line gains the reason.
- **Line 127:** `GitFixture` already has `bare()` and `clone()` (`test/git-fixture.ts:78,93`). Clones of a plain path, not `file://`, but either fetches
  offline. "Extend the fixture if it lacks one" is moot.
- **Line 130:** "No memo call is made (D12)" doesn't say what to assert. Perhaps `gitStatsMemoKeys()` is unchanged by `fetchAll`.
- **§6, lines 159–165:** missing from the docs list: `.claude/DESIGN.md` §8.4b (which describes the band's right slot and "couldn't update");
  `docs/overview.md:325` ("…the merged proof, no fetch"); `docs/subsystems/git-stats.md:15` ("Nothing here fetches … or writes to a repo", and a fetch writes
  refs, objects and `FETCH_HEAD`); and README.md:15's outbound sentence. The spec also never says it supersedes parent D4 ("The server never runs `git fetch`")
  and the parent's Out of scope line 367.
- **Line 170:** with a 5s tick the cadence is 30–35s plus fetch time, not "~30s". The last fetch may *start* 90s after the last read, so "stops advancing
  within 90s" is borderline. When the group's first toplevel is a linked worktree, the write goes to `.git/worktrees/<name>/FETCH_HEAD`, not `.git/FETCH_HEAD`
  (`server/lib/git-stats.ts:144`).

## Checked and true

These were all confirmed against the code:

- The memo key is `toplevel\0refSha\0baseSha` and the base is `origin/<trunk>` when present (`git-stats.ts:258,271`), so D12's "recounts on its own" holds.
- The `usage-history.ts` timer shape: unref'd `setInterval` that re-reads the setting on each tick (`usage-history.ts:826-833`).
- `tokenOk` guards `POST /api/settings` (`server/api.ts:970`); `methodNotAllowed` exists for the 405 (`server/index.ts:131`); `/api/health` reports
  `tokenRequired` (`api.ts:520`), and the client already holds it through `useRemoteAnswer`.
- `setSettings` refuses the whole patch on a bad key (`settings.ts:246-280`).
- `useDismiss` handles pointerdown outside plus Escape (`Popover.tsx:10`). `GitBandStatus` has the 1s tick (`GitView.tsx:61-66`). `Band.right` is optional.
- Usage forecast is the last card on Shared (`SettingsView.tsx:409`).
- `test/outbound.test.ts`'s singular-claim regex doesn't match "exactly two kinds", and `fetchAll(` doesn't trip the `fetch(` scan.
- `git fetch origin --quiet --no-auto-gc --no-auto-maintenance` is accepted in that argv order on git 2.50.1.
- The mock's band sub-line matches line 91. 3:12 at 192s left of 300 is right (108/300 elapsed = the mock's 0.36), and SYNC 12s = 0.6 elapsed of 30s matches
  the mock.
