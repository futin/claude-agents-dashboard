# Review 1 — Management › CodeGraph design spec

Document: `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` (169 lines, commit 5307254). Reviewer: Fable 5.1 subagent, 2026-10-19.
Verified against the repo at `feat/codegraph-view` and the installed codegraph CLI 1.6.2 (`~/.nvm/versions/node/v22.23.1/lib/node_modules/@colbymchenry/codegraph`,
runtime JS under `node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist`, types under `@colbymchenry/codegraph/dist/index.d.ts`). Read-only: `codegraph --help`
and `codegraph status --json` on this repo only; no `sync`/`index` run. The v2 mockup (`claude.ai/artifact/5vLTCjf2napbWdQCrdkV6g`) was read in full.

## Verdict: REVISE

One Critical: the index-state mapping inverts what the CLI means by `indexing`, so a truncated index can never be repaired from the page. The rest is a
clean mirror of Git and needs only the Important clarifications below before planning.

## Critical

### C1 — spec:92-94 (and :85): `index.state: 'indexing'` at rest is a killed build, not a run

Spec draws `index.state: 'indexing'` as "a build in progress … keys disabled … adds no problem and does not change the level", and puts
`partial` in *Needs you* as "an interrupted build". The CLI says the opposite:

- `bin/codegraph.js` (status command) warns on `state === 'indexing'`: "The last index run never finished — the index is truncated. Re-run `codegraph index`",
  on `partial`: files were silently dropped, on `failed`: the run reported failure. A persisted `indexing` marker is the *truncated* case; the live run is
  signalled by `rebuild.pid` (`mcp/writer-lock.js` `tryAcquireWriterLock(projectPath, 'rebuild', 'rebuild.pid')`), not by the marker.
- The mock's own *Needs you* rule reads "a build that never finished" — that is `indexing`-at-rest, which the spec instead maps to a permanent run.

Consequence: a repo whose `codegraph index` was killed (laptop lid, ctrl-C, `tsx watch` restart mid-run) sits forever as cyan "Indexing…" with both keys
disabled, never reaches *Needs you*, and the only fix is the terminal. **Fix:** treat `indexing` as a run only while `rebuild.pid` holds a live pid; `indexing`
without a live pid → `needs` with a "never finished — reindex" verdict; keep `partial` in `needs` but word it "dropped files", not "interrupted".

## Important

### I1 — spec:94 / :85: "the CLI's three index states" is false; `failed` and `null` are unmapped

`dist/index.d.ts:303` declares `state: 'indexing' | 'complete' | 'partial' | 'failed' | null` (null = index predates the marker). The spec names three and maps
none of `failed`/`null`. **Fix:** `failed` → `needs` (same Reindex fix); `null` → treated as `complete` (older index, no evidence of trouble).

### I2 — spec:59-60: `.codegraph/daemon.pid` is JSON, not a bare pid

Watcher sources are listed as if the file holds a pid. `daemon.pid` is `{pid, version, socketPath, startedAt}`; `writer.pid` is `{pid, mode, startedAt, ready}`;
`rebuild.pid` is the same writer-lock shape; `~/.codegraph/daemons/*.json` is `{root, pid, version, socketPath, startedAt}` (all from `mcp/writer-lock.js`
and the daemon registry writer in `lib/dist`). Only the engine's `codegraph.lock` (`FileLock`) stores a bare integer. **Fix:** say "JSON `{pid,…}`" for the
three `.codegraph/*.pid` files so the server parses, not `parseInt`s; note `startedAt` feeds the Inspector "Running since" fact for free.

### I3 — spec:48 / :70 / :117: dead pins have `path: null` and no state covers them

`listPinRows` (`server/lib/management.ts:713-730`) emits `path: null, listed: false` for a pin whose directory is gone; `PinRow.path` is `string | null`
(`shared/types.ts:1622`). `readRepo` in git-stats maps that to `missing` (`server/lib/git-stats.ts:190`), and `RepoGitStats.state` has `missing | not-git | error | ok`
(`types.ts:1681`). The spec's state set is `ok | none | error`, and the *Not indexed* line prints "No .codegraph/ in <~path>" — with a null path. **Fix:** add
`missing` (or fold it into `error` with "folder is gone") and give it a line copy; say which level it ranks under (`none` is the natural slot, with a different
sentence).

### I4 — spec:48: pin path may be a subdirectory; CLI walks up, and `.codegraph/` alone is not "initialised"

`PinRow.path` "may be a subdirectory of the repo" (`shared/types.ts:1673`). The CLI's `resolveProjectPath` walks parent dirs to the nearest `.codegraph/codegraph.db`,
and `isInitialized` requires `codegraph.db`, not the folder (`lib/dist/utils.js`). An uninitialised path returns `{initialized:false, …}` with exit 0. **Fix:** state
whether the server runs `codegraph status --json` with `cwd = pin.path` and trusts `projectPath` in the JSON (recommended: yes, then `none` ⇔ `initialized === false`),
and that a bare `.codegraph/` folder without a DB is `none`, not `error`.

### I5 — spec:97-98: "loses `codegraph.lock` to a live watcher" has no detection rule

Engine `sync()` throws `LockUnavailableError("Sync could not acquire the file lock; retry when the index is available. …")`; the CLI prints `Failed to sync: <msg>`
and exits 1. Nothing in the exit code distinguishes it from a real failure. **Fix:** spell out the rule: exit ≠ 0 **and** stderr contains "could not acquire the file
lock" **and** the repo had `watching: true` at launch → `ok`, message "watcher is syncing it"; otherwise failure. Pin the stderr substring in a test.

### I6 — spec:92 / :110-111 / :75: who reports a foreign rebuild as a `run`?

Line 92 says a live `rebuild.pid` is drawn as a run "whatever started it"; line 110 polls every 3 s "while any repo has a `run`"; line 75 defines `run` from the
server's in-memory launch table. Unstated whether the server synthesises `run: {kind:'reindex', startedAtMs}` from the pid file or the client derives it from
`index.state`. **Fix:** server-side — the server already parses `rebuild.pid` (I2), and `startedAt` is in it; the client then has one `run` shape.

### I7 — spec:92-93: `codegraph status` during a live rebuild may fail or hang

`codegraph index` stops the daemon and holds the writer lock; a concurrent `status --json` can time out or error on a half-written DB. Under the spec that read
becomes `state: 'error'` → `needs`, flickering the repo amber mid-run. **Fix:** precedence rule: a live `rebuild.pid` wins over an errored read (draw the run,
keep the last good stats); only an error with no live pid is `needs`.

### I8 — spec:118: `builtWithExtractionVersion` / `builtWithVersion` can be null

`dist/index.d.ts:305-306` types both as `number | null` / `string | null` for an index older than the marker. The Matrix *Extractor* cell and the Inspector
"Last indexed … codegraph X, extractor vN" fact have no null copy. **Fix:** Extractor cell `—` (grey) and the fact "extractor unknown (older index)"; do not infer
`reindexRecommended` from the null — the CLI already sets that flag.

### I9 — spec:108: `management.codegraphLayout` must join `OWNED_KEYS`

`client/src/hooks/useSettings.tsx:24` lists the keys Reset sweeps; `test/git-stats-client.test.ts:88-89` pins `management.gitLayout` there. The spec names the
key but not the registration, so Reset would leave a stale Matrix choice behind. **Fix:** one line: "added to `OWNED_KEYS`; test pins it as Git's does".

## Minor

- spec:102 "the meter" is reusable only after extraction: `GitMeter` is a non-exported local in `client/src/components/management/GitClockChip.tsx:14`. Say
  "extract `GitMeter` into its own module" or the builder will copy it.
- spec:138-141: the "update check" sentence is imprecise — `upgrade/update-check.js` is required only by `mcp/session.js` (daemon / MCP server); one-shot CLI
  commands do not phone home. Setting `CODEGRAPH_NO_UPDATE_CHECK=1` / `CODEGRAPH_NO_DOWNLOAD=1` is harmless and still worth doing (the shim's download path
  runs when the platform binary is missing). Reword to "the daemon's update check" so `test/outbound.test.ts` reviewers don't look for a call that isn't there.
- spec:160: `client/src/components/SideRail.tsx` comments at lines 38 and 79 also say "(Projects | Git)" and `ManagementView.tsx:6` says "two sub-views" — add
  them to the docs/comments touch list.
- spec:121: `nodeCount` includes `file` nodes (405 of 8,254 on this repo, `status --json` 2026-10-19), so "symbols" over-counts by the file count and the mock's
  "other 587" = class + method + variable + file. Either exclude `file` from Symbols or say "other" includes files.
- spec:114 "Sync all behind … one POST each, sequentially" — sequential POSTs still start detached CLI processes in parallel; say "sequential launches" or "waits
  for each run" if the intent is one at a time (each repo has its own `.codegraph/` so parallel is safe).
- spec:112 renames Git's SYNC/FETCH meters to READ/WATCHERS — fine, but `METER_SYNC`/`METER_FETCH` constants (`client/src/lib/gitStatsText.ts:30-31`) show the
  pattern: say the new names live in `codegraphText.ts`.
- `index.pendingRefs > 0` warning (CLI `status` prints it) is not surfaced — acceptable out of scope; one line saying so avoids a builder question.
- Copy not in the spec but present in the mock (spec:115-116 says "a verdict sentence, steps" only): panel verdicts "Built by an older codegraph extractor (v26,
  now v27). Queries can miss symbols until it is rebuilt." / "7 files changed since the last index."; steps "5 modified · 2 added", "Indexed 3d ago", "2,672 files ·
  19.4k symbols · 95 MB: a full rebuild takes a few minutes"; popover subs "Every 30s while this page is open" / "1 repo has changes the graph hasn't seen";
  Inspector chip `up to date` (green) which spec:116's chip list omits; fact "Running since 10:31". Since spec:133 puts every string in `codegraphText.ts`,
  either adopt the mock copy by reference ("verdicts and popover subs as in the mock") or list them.
- Mock-vs-spec differences otherwise are as the spec calls out: per-language file counts (spec:124), `worktreeMismatch` (spec:86), row expansion (spec:120).
  The mock's *Needs you* legend ("a build that never finished") supports C1, not the spec's `partial` wording.

## Verified true (no finding)

- `listPinRows(config, getPinnedProjects(), {archivedIds, pinnedDirs})` is what git-stats uses (`server/lib/git-stats.ts:450-452`); #168 note at :60.
- `markGitWatched`/`isGitWatched`, 90 s grace (`server/lib/git-fetch.ts:160-178`); `serveGitStats` marks watched (`server/api.ts:1725`).
- `refuseWrite` 403 strings and the open-folder refusal order 400 → 501 → 403 `not a pinned project` (`server/api.ts:518-526, 1796-1812`); router 405
  (`server/index.ts:141`).
- Level labels, rank-then-severity-then-pin-order sort (`client/src/lib/gitLevels.ts:45-54, 155, 182`); `GIT_NO_PINS` Projects link (`GitView.tsx:97-103`).
- `startGitPoll` 30 s visible-only (`client/src/lib/gitPoll.ts`); `drawableGitLayout` (`gitLayouts.ts:43`); `useDismiss` (`components/Popover.tsx`).
- `.git-chip.{amber,green,mustard,dim}`, `.git-sync.on`, `.git-key.primary` exist (`client/src/styles.css:2922-2954`); no colour literal needed.
- CLI: `index` takes `rebuild.pid` and calls `stopDaemonAt(realpath, {preserveUnverified:true})`; `sync` takes `codegraph.lock`; shim is `#!/usr/bin/env node`;
  `CODEGRAPH_NO_DOWNLOAD`, `CODEGRAPH_INSTALL_DIR`, `CODEGRAPH_DOWNLOAD_BASE`, `CODEGRAPH_NO_UPDATE_CHECK` exist; commands init/uninit/index/sync/status/unlock/daemon.
- `status --json` field list at spec:54-56 matches the live output on this repo (2026-10-19).
- `test/outbound.test.ts` is unaffected: no net module is imported, and its CLAUDE.md check only needs the `lib/git-fetch.ts` sentence to survive.
- `docs/subsystems/git-stats.md` carries a docs-sync stamp, so spec:159's "stamped like git-stats" has a precedent.
- CLAUDE.md hard rules respected: types-first API field, no new server dep, no CSS literal, PR-only main, ESM.

## Not verified

- Timings at spec:38-39 (CLI wall-clock on large repos) — not measured here; `status --json` on this repo took well under a second.
- Behaviour of `codegraph status --json` while another process holds `rebuild.pid` (I7) — reasoned from the lock code, not reproduced, since running `index`
  was off-limits.
