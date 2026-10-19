# Review 2 — Management › CodeGraph design spec

Document: `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` (185 lines, after commit e167036 "address spec review 1"). Reviewer: Fable 5.1 subagent,
2026-10-19. Round-1 report: `2026-10-19-codegraph-view-design-review-1.md`; findings it raised that the spec now addresses (C1, I1–I9) are not repeated.
Verified against the repo at `feat/codegraph-view` and codegraph CLI 1.6.2 (`~/.nvm/versions/node/v22.23.1/lib/node_modules/@colbymchenry/codegraph`,
runtime under `node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist`, cited below as `cli/…`). Read-only: `codegraph status --json` on this repo and on
an uninitialised dir only; no `sync`/`index` run. The v2 mockup (`claude.ai/artifact/5vLTCjf2napbWdQCrdkV6g`) was read in full.

## Verdict: REVISE

One Critical: the spec says in one place that the server never resolves the repo root (the CLI walks up from a subdirectory pin) and in two others that the
server short-circuits and gates on `.codegraph/` being *in the pin's folder*; the pid-file reads need the same root and have none. The rest are
Important gaps an implementer would have to guess at — the CLI argv (quiet mode hides the lock text the spec keys on), run-end cache invalidation, the
`cli: 'missing'` rule, and the per-problem copy.

## Critical

### C1 — spec:50-51 vs spec:88 and spec:166-167 — subdirectory pins: who finds the repo root?

Line 50-51: "The pin's path may be a subdirectory of the repo; the CLI walks up to the nearest `codegraph.db` itself, so no repo-root resolution is
needed." True for `status` and `sync` (`cli/bin/codegraph.js:276-296` `resolveProjectPath`, `:991`, `:928`). But:

- Line 88: `POST` requires "a listed pin with `.codegraph/`" → 404 `not indexed` for every subdirectory pin, whose own folder has no `.codegraph/`.
- Line 166-167: tests pin "no `.codegraph/` → `none` without launching the CLI" → the same pins read *Not indexed* on the page, contradicting line 51's
  `none` ⇔ `initialized: false`.
- Lines 65 and 70 read `<repo>/.codegraph/daemon.pid` and `.codegraph/rebuild.pid` — `<repo>` is undefined for a subdirectory pin, and the only source of
  it in the spec (`projectPath`/`indexPath` in the status JSON, `cli/bin/codegraph.js:1001-1003, 1028-1030`) is absent exactly when it matters most: a live
  rebuild whose status read fails (line 72) or a server that restarted mid-rebuild (line 71).
- Also: a bare `.codegraph/` without a DB is `none` per line 51, yet passes line 88's gate, so `sync`/`index` launch and exit 1 "not initialized"
  (`cli/bin/codegraph.js:930-934, 819-822`).

**Fix:** define the repo root once, server-side: walk up from the pin's path to the nearest `.codegraph/codegraph.db` (the CLI's own rule,
`cli/bin/codegraph.js:278-294`; `isInitialized` requires the DB, round-1 I4), null when none. Use it for the no-launch short-circuit (`null` → `none`),
the 404 gate, and every pid-file path. Keep running the CLI with `cwd` = that root (or the pin path; both resolve the same).

## Important

### I1 — spec:89 / :111-112 / :53 — the CLI argv is unstated, and the obvious choices break the spec's own rules

- `sync -q` suppresses the failure line (`cli/bin/codegraph.js:980-983`: `if (!options.quiet) error(\`Failed to sync: …\`)`), so the lock-loss rule at
  line 111 ("the output contains `could not acquire the file lock`") can never match under `--quiet`, and `lastRun.message` (line 85) is empty.
- `index <path>` does **not** walk up (`cli/bin/codegraph.js:805-812`, #1524): a subdirectory pin passed as an argument exits 1 "not initialized".
- `index` without `-q` draws a clack UI and, on a 0-node result, offers an interactive prompt — gated on `process.stdin.isTTY`
  (`cli/bin/codegraph.js:545`), so it is safe only if stdin is not a TTY.

**Fix:** state the launches: `codegraph sync` and `codegraph index`, **no path argument, no `-q`**, `cwd` = repo root, `stdio: ['ignore', 'pipe', 'pipe']`,
env as line 157; `lastRun.message` = the last non-empty stderr line. Pin the no-`-q` rule in the lock-text test (line 166).

### I2 — spec:70-71, :77-79, :125-126 — run end is detected on the refresh schedule, and the cache is never invalidated when a run ends

Line 70 reads `rebuild.pid` "on every refresh"; line 77-79 makes the refresh TTL'd (builder's call) and a `GET` answer "from the cache immediately"; line
125 polls every 3 s while a run shows. So after a run ends the client keeps seeing `run` for up to one TTL, and when it clears the repo still carries the
pre-run `pendingChanges` / `index.state` until the next refresh — a just-synced repo flickers back to *Worth a look* with "N pending" and an enabled Sync.

**Fix:** (a) pid-file liveness (`rebuild.pid`, `daemon.pid`, the `run` synthesis) is read per `GET`, not per refresh — it is one stat and a `kill(pid, 0)`;
(b) a run's end — ours exiting, or a foreign `rebuild.pid` going dead — invalidates that repo's cache entry so the next `GET` re-runs `status` for it.
Add the mirror test: "after a run ends, the next GET re-reads status".

### I3 — spec:72-73 — "the last good stats are kept" has no rule when there are none

A live rebuild with a failing status read and no cached stats (server started mid-rebuild, or the first read ever) has no `state`: `error` is forbidden by
line 72, `ok` requires the status fields (line 83-84). **Fix:** say what the row carries — e.g. `state: 'ok'` with the stats fields nullable, or a fifth
state (`building`) that ranks `quiet`, draws the run chip and no stats. One line, plus one test case.

### I4 — spec:54 — `cli: 'missing'` has no detection rule, and the obvious one misfires

`execFile` reports a missing binary and a vanished `cwd` with the same `ENOENT`; git-stats handles exactly this (`server/lib/git-stats.ts:202-203`). A
builder keying `cli: 'missing'` on `ENOENT` turns the whole page into "codegraph isn't on the server's PATH." (line 147) the moment one pin's folder is
deleted between `listPinRows` and the launch. **Fix:** mirror `readRepo`: `ENOENT` with `cwd` still a directory ⇒ `cli: 'missing'`; otherwise that repo is
`missing`. Say whether `missing` is sticky for the process or re-probed per refresh.

### I5 — spec:35 vs spec:88 — the anti-goal says "never start a sync or reindex on a repo that already has one running"; the 409 rule checks only two of three locks

A terminal `codegraph sync` holds `.codegraph/codegraph.lock` (bare pid, `cli/utils.js` `FileLock`, written with `String(process.pid)` and unlinked on
release) and neither `rebuild.pid` nor the server's table. The page launches, the CLI exits 1 on the lock, and because the lock-loss rule (line 111-112)
requires `watching: true`, the run is recorded as a failure → *Needs you* with Reindex primary. **Fix:** a live `codegraph.lock` pid also answers `409
already running`, and the lock-loss rule reads "the repo had a watcher **or a live `codegraph.lock`** when the run launched".

### I6 — spec:130-137 — per-problem copy is missing for six of eight problem kinds

Line 149 puts every string in `codegraphText.ts`, line 130 says "a verdict sentence, steps", and the mock draws verdicts for only two problems:
`reindexRecommended` ("Built by an older codegraph extractor (v26, now v27). Queries can miss symbols until it is rebuilt." · "2,672 files · 19.4k symbols ·
95 MB: a full rebuild takes a few minutes") and pending ("7 files changed since the last index." · "5 modified · 2 added" · "Indexed 3d ago"). Nothing
anywhere for `partial`, `failed`, `indexing`-at-rest, `state: 'error'`, a failed `lastRun`, or `worktreeMismatch`; nor the Matrix Index pill text for
those (line 134 says only "`complete` / pill"), the Inspector `up to date` green chip the mock draws (line 131's chip list omits it), the popover subs
("Every 30s while this page is open" / "1 repo has changes the graph hasn't seen"), or the Changes/Watcher fact values ("None pending", "Running since
10:31"). Round-1 Minor, unaddressed; promoted because an implementer now has to invent copy for most of the Levels table. **Fix:** a short copy table
keyed by problem (verdict, steps, chip, Matrix pill), adopting the mock's by reference for the two it draws.

### I7 — spec:21, :132, :135, :137 — "symbols" is `nodeCount`, which includes `file` nodes; say so or subtract

Live `status --json` on this repo (2026-10-19): `nodeCount` 8,254, `nodesByKind.file` 405. The mock's Inspector tile reads **8,254 symbols** and its legend
"other 587" = class 8 + method 65 + variable 109 + **file 405**, so the mock counts files as symbols. The spec never says which; a builder subtracting
`file` shows 7,849 and the strip's "other" shrinks to 182 — and the test fixture (line 166) will assert one of the two. Round-1 Minor, unaddressed.
**Fix:** one sentence: "Symbols = `nodeCount` (file nodes included; 'other' covers class, method, variable, file)".

## Minor

- spec:38-39 "~8 s of CPU per poll": the figures are wall-clock, not CPU — on this repo `status --json` took 1.25 s real for 0.57 s CPU (2026-10-19).
  Say "wall-clock"; the anti-goal holds either way.
- spec:66 `daemon.pid` "JSON objects, not bare pids": 1.6.2 writes JSON, but its own reader still accepts a legacy bare pid
  (`cli/mcp/daemon-paths.js:224-233`). Accept both so an older daemon's file is not read as "no watcher".
- spec:116 "the meter": `GitMeter` is a non-exported local (`client/src/components/management/GitClockChip.tsx:14`); say "extract `GitMeter`" or it
  gets copied. Round-1 Minor, unaddressed.
- spec:119 / :176 touch list: `ManagementTab` (`client/src/lib/settings.ts:48`) and `MANAGEMENT_TABS` (`:237`) are where `'codegraph'` is accepted;
  `SideRail.tsx:38, 79` comments say "(Projects | Git)"; `test/visual/stage.ts:57` defaults the tab. `deepLink.ts:48,103` type the deep-link tab as
  `'git' | null` — fine to leave, say so.
- spec:146 "Retrying every 30s." mirrors `GIT_LOAD_FAILED` (`client/src/lib/gitStatsText.ts:19`) but is wrong during the 3 s run poll; acceptable, note it.
- spec:83 `generatedAt`: say epoch ms (number), as `GitStatsResponse.generatedAt` (`shared/types.ts:1745`) — `skewOf` and the READ meter need it.
- spec:98 / :141 a failed **sync** `lastRun` lands in *Needs you* with Reindex primary; the fix for a failed sync is usually Sync. Author's call; say it.
- spec:35 `codegraph status` opens the DB read-write (`cli/index.js:340`, `readOnly` unset) and heals an oversized WAL on open (`cli/bin/codegraph.js:1092`
  comment) — the poll is not a pure read. SQLite makes it safe; a sentence keeps the anti-goal honest.
- spec:155 the update check runs only in the daemon/MCP session (`cli/mcp/session.js:80`; `cli/upgrade/update-check.js:103`), never in a one-shot
  command. The "may" hedge is fine; "the daemon's update check" is exact. Round-1 Minor, unaddressed.
- spec:128 WATCHERS `n / m` "indexed repos": define `m` (`ok` only, or `ok` + `error`).
- spec:100 pending changes with a watcher are quiet with no ceiling: a daemon that is alive but no longer syncing keeps the repo green forever.
  Author's call; one line saying it is accepted.
- spec:109 a failed run clears on "the next successful run of either kind" — a fix made in the terminal leaves *Needs you* until a page-run or a server
  restart. Author's call; say it.

## Verified true (no finding)

- `listPinRows` dead pin → `path: null, listed: false` (`server/lib/management.ts:727`); `readRepo` → `missing` (`server/lib/git-stats.ts:192`); #168 note at
  `git-stats.ts:60`.
- `status --json` on an uninitialised dir: `{"initialized":false,…}`, exit 0 (run in `/private/tmp`, 2026-10-19); field list at spec:57-59 matches live
  output on this repo (`languages` names only; `index.{builtWithVersion, builtWithExtractionVersion, currentExtractionVersion, reindexRecommended, state,
  pendingRefs}`).
- `getIndexState` union incl. `null` (`dist/index.d.ts:303`); null stamp ⇒ `isIndexStale()` true (`cli/index.js:1271-1274`), so an older index is
  `needs` via `reindexRecommended` as the spec implies.
- `rebuild.pid` / `writer.pid` / `daemon.pid` JSON with `startedAt: Date.now()` (`cli/mcp/writer-lock.js:113`; this repo's files read live); registry
  `~/.codegraph/daemons/*.json` `{root, pid, version, socketPath, startedAt:number}`; `codegraph.lock` bare pid (`cli/utils.js` FileLock).
- `index` takes `rebuild.pid` then `writer.pid`, calls `stopDaemonAt(realpath, {preserveUnverified:true})`, recreates the DB (`cli/bin/codegraph.js:830-868`);
  `sync` throws `LockUnavailableError("Sync could not acquire the file lock; …")` (`cli/index.js:768`); CLI prints `Failed to sync: <msg>` non-quiet.
- `offerIndexIgnoredRepos` prompt gated on `process.stdin.isTTY` (`cli/bin/codegraph.js:545`).
- Telemetry disabled (`~/.codegraph/telemetry.json` `enabled: false`); `CODEGRAPH_NO_UPDATE_CHECK` / `DO_NOT_TRACK` (`cli/upgrade/update-check.js:103`);
  `CODEGRAPH_NO_DOWNLOAD` blocks the shim's GitHub fallback (`npm-shim.js:121-126`); shim is `#!/usr/bin/env node`; `codegraph` under nvm's bin.
- `refuseWrite` and `requestWriteAccess` (`server/api.ts:503, 518-526`): local and trusted-tailnet peers are `open`. Open-folder order refuseWrite → 400 →
  501 → 403 (`:1797-1807`); router 405 (`server/index.ts:142`).
- `OWNED_KEYS` (`client/src/hooks/useSettings.tsx:24-34`); `drawableGitLayout` (`gitLayouts.ts:43`); `startGitPoll` 30 s visible-only with `onSchedule`
  countdown (`gitPoll.ts:10-49`); `useGitStats` (`useGitStats.ts:29`); `useDismiss` (`Popover.tsx:10`); `useOpenFolder` (`useOpenFolder.ts:21`);
  `.git-sync.on` cyan + `git-spin` (`styles.css:2938-2939`); `.git-key.primary` (`:2951`); `GIT_LOAD_FAILED`, `GIT_NO_PINS` (`gitStatsText.ts:18-19`).
- `test/outbound.test.ts:115-118` needs only `lib/git-fetch.ts` named before `client/dist/` in the zero-deps rule; adding a `codegraph` launcher sentence
  cannot break it, and no `node:http(s)` import is added so `ALLOWED` (`:63-69`) is untouched.
- `docs/subsystems/git-stats.md:257` carries the `<!-- docs-sync:` stamp.
- Mock agrees with the spec on: band sub (verbatim), tile labels, "All good" line shape, "No .codegraph/ in <~path>", Matrix columns and `off` pill only on a
  `look` row, phone switcher without Matrix, popover row names, Inspector tiles/strip/facts/footer, Reindex `primary` on `needs`, cyan "Syncing".
  Differences the spec already calls out: per-language counts (:139), `worktreeMismatch` (:99), row expansion (:136).
- CLAUDE.md hard rules: types-first (:153), no new server dep (:40, :154), no CSS literal (:159), measured figures dated (:38), `main` PR-only (unaffected).

## Not verified

- spec:38 timings on release-kit and microservice (status was run only on this repo, per the review brief).
- spec:55 that the server inherits nvm's `PATH` under `pnpm dev` and `pnpm start` — left to the builder as the spec says.
- Behaviour of `status --json` while another process holds `rebuild.pid` — reasoned from `recreate()` unlinking the DB (`cli/index.js:355-370` comment),
  not reproduced.
