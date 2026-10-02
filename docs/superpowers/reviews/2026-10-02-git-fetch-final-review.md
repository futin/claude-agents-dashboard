# Git fetch — final whole-branch review

Branch `feat/git-fetch` (11 commits, `git diff main...HEAD`, 37 files, +2288/−165), reviewed 2026-10-02 against the spec
(`docs/superpowers/specs/2026-10-02-git-fetch-design.md`), the plan (`docs/superpowers/plans/2026-10-02-git-fetch.md`) and `.claude/CLAUDE.md`. Read-only:
nothing was edited, staged or started besides this report.

## Verdicts

- **Spec compliance: compliant**, with one plan-sanctioned divergence (M1) and wording drift in docs (M6, M7).
- **Critical: none. Important: none.**
- **Task quality: good, mergeable.** The server module is small, its invariants are tested with real git, and the client rules are pure and tested.

## Commands run

- `pnpm test` → exit 0, every suite `N passed, 0 failed` (log grepped for `[1-9][0-9]* failed`, `✖`, `FAIL`: no hits).
- `pnpm typecheck` → exit 0 (`tsc --noEmit`, no output).
- `pnpm build` was not run (read-only brief; it writes `client/dist`). The PR must quote it.

## Correctness walk (what was checked and held)

| Area | Where | Result |
| ---- | ----- | ------ |
| Process-group kill | `server/lib/git-fetch.ts:44-50,61,72-77` | `detached: true` makes the child its own group leader, `process.kill(-pid,'SIGKILL')` kills git + ssh; `child.kill` fallback; `settled` guards double-resolve; `error` before spawn clears the timer, so `-undefined` is never reached. Test 12 proves the grandchild dies. |
| No prompts | `git-fetch.ts:33-41,297-298` | `GIT_ASKPASS=''` is deliberately empty (non-null → skips `core.askPass`, empty → falls to the disabled terminal prompt). User ssh (`core.sshCommand`, env `GIT_SSH_COMMAND`/`GIT_SSH`) is left alone because the overlay omits the key and the runner spreads over `process.env`. |
| Single flight | `git-fetch.ts:221-226` | `inFlight` set synchronously before any await; POST does `markGitWatched(); fetchAll()` in one tick, so a tick landing in the same second joins it. `.finally` clears only its own promise. |
| Always resolves | `git-fetch.ts:228-243,284-311` | Outer try/finally restores the clock; each group catches its own failures. |
| Watched gate | `git-fetch.ts:163-180` | Derived from the stamp and the live interval, never stored. `serveGitStats` marks before `readGitStats` (`server/api.ts:1633`), and `readAll` reads `getFetchClock()` at its end, so even a coalesced in-flight read answers with the post-mark clock. A refused POST does not mark (token check first, `api.ts:1646`). |
| D11 | `git-fetch.ts:171,183-185,189-199` | Entry via `markGitWatched` (unwatched → watched), Off→value and value→value via the tick's `seenIntervalSecs` compare; `scheduleFrom` never sees a null `lastEndedMs`. Interval change mid-fetch: the tick may set `now`, but `runFetch`'s `finally` re-plans from the new `lastEndedMs`. Review Focus 3 (Off mid-fetch) holds and is tested. |
| `lastFetch` keying | `git-fetch.ts:254-257` vs `git-stats.ts:233-235` | Same `rev-parse --path-format=absolute` call on both sides, so toplevels match. `lastFetch` is read per answer in `readGitFacts`, outside the counts memo, so it is never stale. |
| Token guard | `api.ts:1645-1654`, `index.ts:213-217` | Router 405s non-POST; handler 403s on `tokenOk` failure before any side effect; client sends `Bearer` like `useServerSettings`. Tested: none sent, wrong one, right one, GET → 405. |
| Settings | `server/lib/settings.ts:120-122,187,290-294,304-307` | `parseGitFetchSecs` is exact-membership (`'300'`, `45`, `30.5`, `null` → null); hand-edited bad values read back `0` without disturbing siblings; `{gitFetchSecs: 0}` uses `!== undefined`, so the falsy-0 trap is closed, and the test would catch a regression to a truthiness check (Review Focus 1 and 2 pinned in `test/settings.test.ts`, route-level in `test/api-body.test.ts`). |
| Settings card | `client/src/components/settings/SettingsView.tsx:423-435`, `SettingsRow.tsx:79-91` | Same shape as the Usage forecast card; `className` prop is additive; options typed `readonly`. |
| Client clock | `client/src/lib/gitClock.ts` | Precedence matches §4 (running/own POST > off > pending > overdue > 0s > countdown); null `nextAtMs` short-circuits before the `null + interval` trap; skew applied once. `followUp` returns null when hidden; tracker spends a `due:` key once and re-keys `run:` per payload. `createPollGate` queues exactly one. |
| Hidden tab | `GitClockChip.tsx:59-69`, `gitPoll.ts` | Follow-ups are neither armed nor fired while hidden (checked at arm time and at fire time); the 30s poll stops when hidden, so the server's watched window lapses. |
| Text | `client/src/lib/gitStatsText.ts:79-133` | `lastFetch?.` tolerates an older payload (Review Focus 5); `lock` reads plain; `never fetched` corner present; period strings match §4. |
| CLAUDE.md invariants | — | Server imports only `node:child_process` + local modules; `outbound.test.ts` `ALLOWED` unchanged plus the launcher-sentence assertion. All cross-boundary imports are `import type`. `shared/types.ts` carries `FetchError`, `RepoLastFetch`, `FetchClock`, `gitFetchSecs`, `lastFetch`, `fetch` first. CSS: every new rule uses tokens (`--shadow2`, `--steel`, `--strip-hi`, `--hairline2`, … all defined in all five themes); no new width `@media` (the chip/popover rules joined the existing `min-width:768px` block; the reduced-motion rule joined the existing one-liner); every new class `git-`-prefixed except the `set-seg` modifier `git-fetch-seg`, which is also prefixed. |

## Minor findings

- **M1 (spec divergence, plan-sanctioned).** Spec §1: "A runner that rejects (`ENOENT` when the folder went away …, or `git` missing) records `other` for that
  group." The code records `other` only when the *fetch* call rejects; a rejecting `rev-parse` drops the pin and a rejecting `git remote`/`git config` skips
  the group and clears its verdict (`git-fetch.ts:258-260,306-307`). The plan (lines 182-185) chose this, so it is deliberate; but with `git` missing from
  PATH every repo silently shows no verdict rather than "fetch failed". Acceptable (Git Stats itself would show every repo as `error` in that case). Either
  amend the spec sentence or leave it; not blocking.
- **M2 (credential helpers, unverified).** D5 covers askpass and ssh but not `credential.helper`. A GUI helper (Git Credential Manager) generally honours
  `GIT_TERMINAL_PROMPT=0` on the same OS, but under WSL a Windows `git-credential-manager.exe` does not receive env vars missing from `WSLENV`. This machine
  has no helper configured (`git config --get-all credential.helper` empty, checked 2026-10-02), so it is not a live bug here; add it to the PR's
  "not verified" line beside the ssh-agent confirmation.
- **M3 (dead code).** `GIT_UPDATE_FAILED` (`client/src/lib/gitStatsText.ts:19`) is now read only by its own test; `SYNC_ROW_FAILED_SUB` replaced it. Same family
  as the deferred `useGitStats.updatedAt`.
- **M4.** `gitTroubleLines(repos, _clock)` takes a parameter it never reads (`gitStatsText.ts:117`); already noted in the plan's rulings.
- **M5.** A `refused` Fetch-all key stays disabled until the stored token changes (`useGitFetch.ts:31`); fixing the server's `.env` token instead leaves it
  disabled until reload. Edge case.
- **M6 (docs wording).** `docs/subsystems/git-stats.md:42`: "The first four but `lock` show amber" — the list just before it is `auth, offline, timeout, lock,
  other`, so "the first four" includes `lock` and excludes `other`. Should read "all but `lock` show amber".
- **M7 (docs wording).** `.claude/DESIGN.md:328` says the meters go amber "when off or failed"; `overdue` is amber too (`gitClock.ts:70`).
- **M8 (plan staleness).** The plan's Progress section still reads "paused after Task 7 … Tasks 8–9 … remain", though `fb7c6f0` (Task 8) and `854e953` (Task 9)
  are on the branch. Update when the PR is opened.
- **M9 (test gap, accepted).** The component glue — `GitClockChip`'s follow-up timer map and `useGitFetch` — has no test; the repo has no DOM harness, and the
  rules it calls are pure and tested. Covered only by the browser checks, of which the early follow-up poll is still unverified.

## Deferred Minor list — triage

| Deferred item | Fix before merge? | Reason |
| ------------- | ----------------- | ------ |
| Detached fetch group outlives a server restart mid-fetch | **No**, but correct the note | The plan says "bounded by the 30s timeout" — it is not: the timeout lives in the process that died, and a detached group does not get the terminal's SIGINT, so a stalled fetch can linger until the network gives up. Real exposure is small (fetch ~0.5s, BatchMode, no prompts). If wanted later: track live child pids and SIGKILL their groups on `exit`/`SIGINT`/`SIGTERM`. Backlog, and say it in the PR's Unproven row. |
| No mutation-killing test for the `nextAtMs === null` re-plan branch / `wasWatched` early return | No | Both are near-equivalent mutants: removing `wasWatched` makes every GET call `scheduleFrom`, which returns the same `lastEndedMs + interval` (or `now` exactly when already due); the null branch is defensive (every path that nulls `nextAtMs` while watched is re-entered by `markGitWatched`). A test would have nothing observable to pin. |
| Disabled chip key loses keyboard focus | No (follow-up) | Real a11y papercut for keyboard users pressing Fetch all; fix with `aria-disabled` + guarded click. Not a correctness issue. |
| StrictMode drops the early poll when a fetch is already due at mount (`pnpm dev`) | No | Dev-only double-invoke: the unmount-cleanup effect clears the timer and the tracker has spent the key. Production is unaffected; the 30s poll covers it. |
| `useGitStats.updatedAt` no longer read | Optional, cheap | Dead field (with M3's `GIT_UPDATE_FAILED`). A two-line cleanup; fine either way. |
| `POST /api/settings` bad-body message never named `recordUsageHistory` | Optional, cheap | Pre-existing; the branch already touched that string (`api.ts:975`), so adding `recordUsageHistory?: boolean` is a one-word fix if the PR wants it. |

## Docs check

`docs/subsystems/git-stats.md`, `docs/subsystems/settings.md`, `docs/overview.md`, `.claude/DESIGN.md`, `README.md`, `.claude/CLAUDE.md`: no statement
contradicts the code beyond M6 and M7. The stale sentences the spec §6 named (git-stats "Why there is no fetch", settings "second and last write", overview
"no fetch", `index.ts` "only write endpoints", `shared/types.ts` `RepoGitStats` "no network") are all rewritten; a repo-wide grep for `GitBandStatus`,
`git-band-act`, "Nothing here fetches", "only write endpoint" finds only a historical mention in a code comment (`GitClockChip.tsx:29`, accurate as history).

## Still unproven (carry to the PR)

From the plan plus this review: the early follow-up poll at `0s`; `FETCH_REFUSED` with a wrong token and the Fetch-all success click; the hidden-tab D2
lapse and the `FETCH_HEAD` cadence; reduced motion and the pulse; worktree dedupe in a browser (unit case 3 covers it); real passphrase/`core.sshCommand`
`auth`; ssh-agent GUI confirms; credential-helper GUIs (M2); nothing reaching the `pnpm dev` terminal; `pnpm build`.
