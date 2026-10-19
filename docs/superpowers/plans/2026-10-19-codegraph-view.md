# Management › CodeGraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Plan convention (overrides the writing-plans template):** this plan specifies behaviour, exact names and signatures, exact values and exact test
> *cases* — never literal code. Write the bodies yourself, and disagree with the plan where the code says otherwise (note it in your report). Every size
> figure here is a soft target, never a reason to drop a rule.

**Goal:** A third Management sub-view, *CodeGraph*, showing each pinned repo's code-graph index health (up to date, pending changes, watcher, size and shape)
with Sync and Reindex keys the server runs through the `codegraph` CLI.

**Architecture:** A server module reads `codegraph status --json` per pin into a per-repo cache that `GET /api/codegraph` answers from, plus pid-file
liveness checked on every GET; a second module owns runs (`codegraph sync` / `codegraph index`) behind a write-guarded `POST /api/codegraph/run`. The client
mirrors Management › Git: same band, `.seg` switcher, clock chip, level tiles, Inbox / Matrix / Inspector, reusing `startGitPoll`, `createPollGate`, `.git-*`
classes and adding `codegraph*` siblings for what is CodeGraph-specific.

**Tech Stack:** Node + TypeScript via `tsx` (built-ins only), Vite + React + TypeScript, node-assert tests (`test/run-all.ts`), Playwright visual suite.

**Spec:** `docs/superpowers/specs/2026-10-19-codegraph-view-design.md` (approved mock: https://claude.ai/artifact/5vLTCjf2napbWdQCrdkV6g). Read it before
any task; it wins over this plan on behaviour, this plan wins on names.

## Global Constraints

- `shared/types.ts` first, then server, then client (CLAUDE.md §Code rules). Cross-boundary imports are `import type`.
- Server: Node built-ins only, `.js` import suffixes, `execFile`/`spawn` with argv, never a shell. No new dependency anywhere.
- Every `codegraph` launch: env = `process.env` plus `CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_NO_DOWNLOAD=1`.
- Status read: `codegraph status --json`, `cwd` = the **pin's path**, timeout `CODEGRAPH_STATUS_TIMEOUT_MS = 15_000` via its own timer (as
  `server/lib/git-stats.ts` does, see its #168 note). Runs: argv exactly `['sync']` / `['index']`, no path arg, no `-q`, `cwd` = graph root,
  `stdio: ['ignore', 'pipe', 'pipe']`, no timeout.
- Paths never come from a request: pins come from `listPinRows` exactly as `server/lib/git-stats.ts` `readAll` builds them.
- `styles.css`: no literal color or shadow below the theme-token block; reuse `.git-*` classes; new classes are `cg-*`.
- Copy lives in `client/src/lib/codegraphText.ts` only; strings below are exact.
- Settle-by-plan (the spec left these to the builder): watcher source = `<root>/.codegraph/daemon.pid` with a live pid (`startedAt` → "Running since");
  cache TTL `CODEGRAPH_TTL_MS = 25_000`; concurrency cap `CODEGRAPH_CONCURRENCY = 2`; **no background timer** — refreshes are driven by GETs only, so a
  closed tab costs nothing and Git's watched flag is not shared; no Matrix row expansion; no per-language counts.
- Wrap new comments and docs at 160 columns.

## Review Focus

1. A pin that is a **subdirectory** of an indexed repo: resolves to the repo's graph root, reads `ok`, Sync is allowed, pid files are read from the root
   (test in Task 1 and Task 3).
2. **Server restarted mid-reindex** (rebuild started elsewhere, no cached stats): repo is `building`, ranked quiet, run synthesised; when the rebuild pid dies
   the next GET reads fresh (test in Task 2).
3. **Double-click / two tabs** on Sync: the second POST answers `409`, the CLI is launched once (test in Task 3).
4. **A run ends**: the next GET re-reads that repo instead of showing pre-run "N pending" for the rest of the TTL (test in Task 2).
5. **Folder deleted after pinning**: spawn `ENOENT` with the cwd gone reads as that repo `missing`, never `cli: 'missing'` for the page (test in Task 1).

---

### Task 1: Shared types + status reader

**Files:**
- Modify: `shared/types.ts` (after the Git block, ~line 1740)
- Create: `server/lib/codegraph.ts`
- Create: `test/fixtures/codegraph-status-1.6.2.json` — capture with `CODEGRAPH_NO_UPDATE_CHECK=1 codegraph status --json` in this repo; values below are
  from the 2026-10-19 capture (fileCount 416, nodeCount 8254, edgeCount 33969, dbSizeBytes 36786176, extraction 27/27, state `complete`). If your capture
  differs, use the capture's numbers in the assertions.
- Create: `test/codegraph.test.ts`; register in `test/run-all.ts`

**Interfaces:**
- Produces (types, `shared/types.ts`):
  - `CodegraphRunKind = 'sync' | 'reindex'`
  - `CodegraphRun { kind: CodegraphRunKind; startedAtMs: number }`
  - `CodegraphLastRun { kind: CodegraphRunKind; ok: boolean; endedAtMs: number; message: string }`
  - `CodegraphIndexState = 'indexing' | 'complete' | 'partial' | 'failed'` (a CLI `null` is mapped to `'complete'` by the parser)
  - `CodegraphStats { lastIndexedMs: number | null; fileCount; nodeCount; edgeCount; dbSizeBytes: number; nodesByKind: Record<string, number>;
    languages: string[]; pending: { added: number; modified: number; removed: number }; worktreeMismatch: { worktreeRoot: string; indexRoot: string } | null;
    version: string; indexState: CodegraphIndexState; reindexRecommended: boolean; builtWithVersion: string | null; builtWithExtractionVersion: number | null;
    currentExtractionVersion: number | null }`
  - `CodegraphRepo` = `{ dirName; name; path: string | null; watching: boolean; watcherSinceMs: number | null; rebuildLive: boolean; run: CodegraphRun | null;
    lastRun: CodegraphLastRun | null }` & one of `{ state: 'ok'; root: string; stats: CodegraphStats }` | `{ state: 'building'; root: string }` |
    `{ state: 'none' }` | `{ state: 'missing' }` | `{ state: 'error'; root: string; message: string }`
  - `CodegraphResponse { generatedAt: number; cli: 'ok' | 'missing'; repos: CodegraphRepo[] }`
  - `CodegraphRunRequest { dirName: string; kind: CodegraphRunKind }`
- Produces (`server/lib/codegraph.ts`):
  - `type CodegraphRunner = (cwd: string, args: string[], timeoutMs: number | null) => Promise<{ code: number; stdout: string; stderr: string }>` —
    resolves on any exit code; rejects only when the spawn fails (error keeps its `code`, e.g. `'ENOENT'`) or the timeout fires (`code: 'ETIMEDOUT'`).
  - `defaultCodegraphRunner: CodegraphRunner`, `overrideCodegraphRunner(r: CodegraphRunner | null): void`, `currentCodegraphRunner(): CodegraphRunner`
  - `findGraphRoot(dir: string): Promise<string | null>` — `dir` or nearest ancestor with `.codegraph/codegraph.db` (a file), else null
  - `parseCodegraphStatus(stdout: string): CodegraphStats | 'uninitialized'` — throws `Error` with a one-line reason on non-JSON / missing numeric fields
  - `readPidFile(file: string): Promise<{ pid: number; startedAtMs: number | null } | null>` — JSON `{pid, startedAt}` or a bare integer; null when absent
    or unparsable
  - `isPidAlive(pid: number): boolean` — `process.kill(pid, 0)`; `EPERM` counts as alive
  - `livePid(file): Promise<{ pid; startedAtMs } | null>` — `readPidFile` + `isPidAlive`
  - `readCodegraphStatus(pin: PinRow, run: CodegraphRunner): Promise<StatusRead>` where `StatusRead = { kind: 'ok'; root; stats } | { kind: 'none' } |
    { kind: 'missing' } | { kind: 'error'; root; message } | { kind: 'cli-missing' }` (internal to the server, not in `shared/`)
  - `CODEGRAPH_ENV` (the env object), `CODEGRAPH_STATUS_TIMEOUT_MS = 15_000`, `LOCK_LOSS_TEXT = 'could not acquire the file lock'`

- [ ] **Step 1: Write the failing tests** in `test/codegraph.test.ts` (tmpdir repos; a `.codegraph/codegraph.db` is an empty file; a dead pid is the pid of a
  spawned `node -e ''` after it exits):
  - `parseCodegraphStatus` on the fixture → `fileCount 416`, `nodeCount 8254`, `edgeCount 33969`, `dbSizeBytes 36786176`, `indexState 'complete'`,
    `builtWithExtractionVersion 27`, `currentExtractionVersion 27`, `reindexRecommended false`, `pending {0,0,0}`, `worktreeMismatch null`,
    `languages ['javascript','tsx','typescript','yaml']`, `lastIndexedMs === Date.parse('2026-10-19T08:14:07.660Z')`.
  - `index.state: null` → `indexState 'complete'`; `builtWithVersion`/`builtWithExtractionVersion` absent or null → both null.
  - `{"initialized":false}` → `'uninitialized'`; `''`, `'not json'`, `'{}'` → throws.
  - `findGraphRoot`: repo with DB → itself; `repo/a/b` (no own DB) → repo; folder with bare `.codegraph/` and no DB, under no indexed parent → null.
  - `readPidFile`: JSON object → `{pid, startedAtMs}`; bare `"12345\n"` → `{pid: 12345, startedAtMs: null}`; missing → null; garbage → null.
  - `livePid`: own `process.pid` → non-null; dead pid → null.
  - `readCodegraphStatus` with a fake runner: dead pin (`path: null`) → `missing`, runner never called; no graph root → `none`, runner never called;
    subdirectory pin → runner called with `cwd` = the **pin path** and args `['status','--json']`, result `ok` with `root` = repo root; runner exit ≠ 0 →
    `error` whose message is the last non-empty stderr line; runner rejects `ETIMEDOUT` → `error` "codegraph status timed out"; runner rejects `ENOENT`
    with the cwd present → `cli-missing`; `ENOENT` after the folder was removed → `missing`; `initialized:false` answer → `none`.
- [ ] **Step 2: Run** `pnpm exec tsx test/run-all.ts` (or the module alone if the harness allows) — expect the new cases to fail on missing exports.
- [ ] **Step 3: Implement** the types and `server/lib/codegraph.ts` to the Interfaces above. `defaultCodegraphRunner` uses `execFile('codegraph', args,
  { cwd, env: CODEGRAPH_ENV, maxBuffer: 8 MiB })` with its own `setTimeout` kill when `timeoutMs` is non-null; for runs (null timeout) use `spawn` with the
  stdio above and collect output. One-line JSDoc on exports; the why lives in `docs/subsystems/codegraph.md` (Task 7).
- [ ] **Step 4: Run** the tests and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(codegraph): status reader and shared types` (`git add` the four files + `test/run-all.ts`, then `git commit -- <paths>`).

### Task 2: Cache and runs

**Files:**
- Create: `server/lib/codegraph-store.ts`
- Create: `test/codegraph-store.test.ts`; register in `test/run-all.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `readCodegraph(config: Partial<Config>): Promise<CodegraphResponse>`
  - `startCodegraphRun(config: Partial<Config>, dirName: string, kind: CodegraphRunKind): 'started' | 'not-pinned' | 'not-indexed' | 'busy'`
    (synchronous decision; the launch continues in the background)
  - `resetCodegraph(): void` (test seam: clears cache, runs, lastRuns, seen-rebuild set), `codegraphRunsSettled(): Promise<void>` (test seam: resolves when
    every in-flight run has ended)
  - `CODEGRAPH_TTL_MS = 25_000`, `CODEGRAPH_CONCURRENCY = 2`, `WATCHER_SYNCING_TEXT = 'watcher is syncing it'`

Behaviour (spec §Source, §Cost, §API, §Levels last paragraph):
- Cache is a `Map<root-or-dirName, { read: StatusRead; atMs: number }>`. On a GET: a repo with **no entry** is read now (awaited, through a limiter of
  `CODEGRAPH_CONCURRENCY`); an entry older than the TTL answers from the cache and starts **one** background refresh (never two for one repo); a fresh entry
  answers from the cache. No timer anywhere.
- Every GET also reads, per repo with a root: `daemon.pid` (→ `watching`, `watcherSinceMs`), `rebuild.pid` (→ `rebuildLive`). Rebuild live and no own run →
  `run = { kind: 'reindex', startedAtMs: <its startedAt ?? now> }`. A root seen with a live rebuild on the last GET and dead now → drop its cache entry first.
- Rebuild live and the read is `error` (or the refresh failed): keep the previous `ok` stats; with no previous stats → `state: 'building'`.
- Any read of kind `cli-missing` → `cli: 'missing'` on the payload.
- `startCodegraphRun`: pin not in the stored pin list → `not-pinned`; dead pin or no graph root → `not-indexed`; own run on that root, a live `rebuild.pid`,
  or a live `codegraph.lock` while `daemon.pid` is not live → `busy`; else record `run`, note `watchingAtLaunch`, launch via the runner with `timeoutMs` null.
- Run end: clear `run`; `lastRun = { kind, ok, endedAtMs, message }` where `ok` is exit 0, **or** (exit ≠ 0 **and** stdout+stderr contains
  `LOCK_LOSS_TEXT` **and** `watchingAtLaunch`) with message `WATCHER_SYNCING_TEXT`; otherwise message = last non-empty stderr line, else stdout's, else
  `exit <code>`. A spawn rejection is a failed lastRun with its message. A successful lastRun replaces any failed one (that is how a failure clears). Drop the
  repo's cache entry.

- [ ] **Step 1: Write the failing tests** (fake runner counting calls per `(cwd, args[0])`, injectable clock or real time with small waits; pins via
  `setPinned` + planted transcripts the way `test/api-git-fetch.test.ts` `plantProject` does):
  - Cold GET reads each indexed repo once; a second GET within the TTL makes **zero** status calls; a GET after the TTL answers the old stats and makes
    exactly one background call; two GETs after the TTL still make one.
  - Seven repos cold with a runner that records concurrency → peak concurrency ≤ 2.
  - No GET → runner never called (no timer exists).
  - `daemon.pid` with `process.pid` → `watching true`, `watcherSinceMs` = its `startedAt`; dead pid → `false`.
  - Live `rebuild.pid` (own pid, `startedAt: 1000`) and no own run → `run {kind:'reindex', startedAtMs:1000}`, `rebuildLive true`; runner answering
    `error` while rebuild live and earlier stats cached → `state 'ok'` with the earlier stats; with no earlier stats → `state 'building'`.
  - Rebuild pid live on GET 1, dead on GET 2 (rewrite the file with a dead pid) → GET 2 makes a fresh status call although the TTL has not passed.
  - `startCodegraphRun`: unknown dirName → `not-pinned`; pinned folder without DB → `not-indexed`; second call while the first run is pending →
    `busy`; live `codegraph.lock`, no watcher → `busy`; live `codegraph.lock` **with** live `daemon.pid` → `started`; live `rebuild.pid` → `busy`.
  - Run launched with cwd = graph root (subdirectory pin) and args exactly `['sync']` / `['index']`.
  - Run exit 0 → `lastRun.ok true`, and the next GET makes a fresh status call (cache dropped) — mirror: a GET with no run ending inside the TTL makes none.
  - Run exit 1 with stderr `Failed to sync: Sync could not acquire the file lock; retry when the index is available.` and watcher live at launch →
    `ok true`, message `watcher is syncing it`; same exit with no watcher at launch → `ok false`, message = that stderr line.
  - Failed run then a successful run → `lastRun.ok true`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `server/lib/codegraph-store.ts` to the behaviour above.
- [ ] **Step 4: Run** the tests and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(codegraph): status cache and sync/reindex runs`.

### Task 3: API routes

**Files:**
- Modify: `server/api.ts` (next to `serveGitStats` / `serveGitFetch`, ~line 1725)
- Modify: `server/index.ts` (route table next to `/api/git-fetch`, ~line 266)
- Create: `test/api-codegraph.test.ts`; register in `test/run-all.ts`

**Interfaces:**
- Consumes: `readCodegraph`, `startCodegraphRun`, `resetCodegraph`, `overrideCodegraphRunner`; `refuseWrite`, `sendJson`, `methodNotAllowed`.
- Produces: `serveCodegraph(config, res)`, `serveCodegraphRun(config, req, res)`; routes `GET /api/codegraph`, `POST /api/codegraph/run`.

- [ ] **Step 1: Write the failing tests** through the real route table (`withServer` from `test/api-harness.js`, env as `api-git-fetch.test.ts` uses with
  `ANSWER_TOKEN=secret`, the LAN header for a token-required peer):
  - `GET /api/codegraph` → 200, `repos` in pin order, `cli 'ok'`; an indexed pin reads `state 'ok'` with `stats.fileCount` from the fixture.
  - Refusal order on `/api/codegraph/run`: `GET` → 405; LAN peer, no token → 403 `bad token`; LAN + token, body `{}` → 400; `{dirName:'nope',
    kind:'sync'}` → 403 `{error:'not a pinned project'}`; pinned folder without DB → 404 `{error:'not indexed'}`; `kind:'rebuild'` → 400;
    valid → 200 `{ok:true}`; the same POST again before the fake run resolves → 409 `{error:'already running'}`, and the runner saw exactly one `sync`.
  - A refused request (each of 403/400/404) launches nothing (runner spy saw no `sync`/`index`).
  - Subdirectory pin → 200 and the runner's cwd is the repo root.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the two handlers. Body parse and 400 the way `serveOpenFolder` does; a 500 only when the pin list itself cannot be read.
- [ ] **Step 4: Run** the three codegraph test modules and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(api): /api/codegraph and /api/codegraph/run`.

### Task 4: Client domain — levels, copy, layouts, settings

**Files:**
- Create: `client/src/lib/codegraphLevels.ts`, `client/src/lib/codegraphText.ts`, `client/src/lib/codegraphLayouts.ts`
- Modify: `client/src/lib/settings.ts` (`ManagementTab`, `MANAGEMENT_TABS`), `client/src/hooks/useSettings.tsx` (`OWNED_KEYS`),
  `client/src/components/SideRail.tsx:88` (third item `{ value: 'codegraph', label: 'CodeGraph' }` after Git)
- Create: `test/codegraph-client.test.ts`; register in `test/run-all.ts`

**Interfaces:**
- Produces (`codegraphLevels.ts`):
  - `CodegraphLevel = 'needs' | 'look' | 'quiet' | 'none'`; `CODEGRAPH_LEVELS` (key + tile label: Needs you / Worth a look / All good / Not indexed);
    `CODEGRAPH_LEVEL_DOT` mapping to Git's dot classes (`needs`, `flight`, `quiet`, `dead`)
  - `CodegraphProblemKey = 'reindex' | 'partial' | 'failed' | 'unfinished' | 'error' | 'lastRun' | 'pending' | 'worktree'`
  - `CodegraphProblem { key; sev: 2 | 3 }`; `codegraphProblems(repo: CodegraphRepo): CodegraphProblem[]` (in table order)
  - `codegraphLevelOf(repo, problems): CodegraphLevel`
  - `CodegraphAssessed { repo; problems; level; order: number }`; `rankCodegraphRepos(repos): CodegraphAssessed[]` — level rank needs, look, quiet, none;
    then summed severity descending; then pin order
  - `kindGroups(nodesByKind): { key: 'functions'|'imports'|'properties'|'constants'|'types'|'other'; count: number }[]`
- Produces (`codegraphText.ts`): every string in spec §Client and §Levels' copy table, as named constants / small functions. At minimum:
  `CODEGRAPH_BAND_SUB`, `codegraphFirstLoadText(error)`, `CODEGRAPH_NO_PINS` (Git's sentence), `CODEGRAPH_CLI_MISSING = "codegraph isn't on the server's
  PATH."`, `codegraphVerdict(problem, repo)`, `codegraphSteps(problem, repo)`, `codegraphChip(problem, repo)`, `codegraphPill(problem, repo)`,
  `codegraphQuietLine(repo, nowMs)`, `CODEGRAPH_UP_TO_DATE = 'up to date'`, `CODEGRAPH_NOT_INDEXED(dir)`, `CODEGRAPH_FOLDER_GONE = 'Folder gone'`,
  `CODEGRAPH_BUILDING_LINE = 'Indexing… — numbers when it finishes'`, `reindexConfirmText(name, watching)`, `compactCount(n)`, `formatDbSize(bytes)`,
  `extractorCell(stats)`, key labels `Sync` / `Syncing` / `Reindex` / `Reindexing`, popover rows and subs, `CODEGRAPH_NEEDS_TOKEN`.
- Produces (`codegraphLayouts.ts`): `CodegraphLayout = 'inbox' | 'matrix' | 'inspector'`, `CODEGRAPH_LAYOUTS`, `DEFAULT_CODEGRAPH_LAYOUT = 'inbox'`,
  `parseCodegraphLayout(v)`, `codegraphLayoutsFor(narrow)`, `drawableCodegraphLayout(layout, narrow)` — same contract as `gitLayouts.ts`.

Exact copy not spelled out in the spec (author's call, keep the voice): reindex confirm = "Reindex `<name>`? This throws the graph away and rebuilds it from
scratch — a few minutes on a large repo." plus, when watching, "The codegraph watcher here stops first, so open sessions in this repo lose codegraph until it
restarts."; buttons `Reindex` / `Cancel`. `CODEGRAPH_NEEDS_TOKEN` = "Sync and Reindex need the Answer token — set it under Settings › Local › Connection."
POST notes: 409 → "`<name>` is already running a sync or reindex."; 404 → "`<name>` has no code graph."; other → "Couldn't start `<kind>` on `<name>`."

- [ ] **Step 1: Write the failing tests** (`codegraph-client.test.ts`, repos built from small factory helpers over the shared types):
  - One case per Levels-table row: `reindexRecommended` → needs; `partial` → needs; `failed` → needs; `indexing` with `rebuildLive false` → needs
    (`unfinished`); `indexing` with `rebuildLive true` → quiet, no problem; `state 'error'` → needs; failed `lastRun` → needs; pending 7 + no watcher →
    look; `worktreeMismatch` set → look; clean → quiet; `building` → quiet; `none` → none; `missing` → none.
  - Mirrors: pending 7 **with** watcher → quiet; `reindexRecommended` **with** watcher → needs; `lastRun.ok true` with message `watcher is syncing it` →
    no problem.
  - Ranking: [quiet A, none B, needs C (sev 3), look D, needs E (two sev-3 problems)] in pin order → E, C, D, A, B.
  - Copy: `reindexRecommended` with 26 → 27 → verdict exactly "Built by an older codegraph extractor (v26, now v27). Queries can miss symbols until it is
    rebuilt."; pending `{modified:5, added:2, removed:0}` → verdict "7 files changed since the last index.", steps first line "5 modified · 2 added".
  - `compactCount(8254)` → `8.3k`, `compactCount(19400)` → `19.4k`, `compactCount(587)` → `587`; `formatDbSize(36786176)` → `35 MB`
    (MiB, integer at ≥ 10, one decimal below).
  - `extractorCell`: 27/27 → `v27`; 26/27 → `v26 → v27`; null/27 → `—`.
  - `kindGroups` on the fixture's `nodesByKind` → functions 2637, imports 1968, properties 1481, constants 1145, types 436, other 587 (sum 8254).
  - `codegraphQuietLine` on the fixture with watcher, indexed 2 h ago → "416 files · 8.3k symbols · watching · indexed 2h ago".
  - Layouts: `parseCodegraphLayout('branches')` → `inbox`; `drawableCodegraphLayout('matrix', true)` → `inbox`; `codegraphLayoutsFor(true)` has no matrix.
  - Settings: `clampSettings({ managementTab: 'codegraph' })` keeps it; `OWNED_KEYS` includes `management.codegraphLayout` (as
    `test/git-stats-client.test.ts:88` pins `management.gitLayout`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the three modules and the settings/rail edits. `ManagementView` keeps rendering Git for `'codegraph'` until Task 6.
- [ ] **Step 4: Run** the module and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(codegraph): client levels, copy and layouts`.

### Task 5: Client hooks — poll and runs

**Files:**
- Create: `client/src/hooks/useCodegraph.ts`, `client/src/hooks/useCodegraphRun.ts`, `client/src/lib/codegraphPoll.ts`
- Modify: `test/codegraph-client.test.ts`

**Interfaces:**
- Consumes: `startGitPoll`, `createPollGate` (as `useGitStats` uses them), `authHeaders`, `useAnswerToken`, `refusalKind`, `READ_ONLY_TEXT`, the
  remote-answer state the way `useGitSync` reads `tokenRequired` / `writeAccess`.
- Produces:
  - `codegraphPoll.ts`: `CODEGRAPH_FAST_POLL_MS = 3000`; `hasLiveRun(data: CodegraphResponse | null): boolean`; `runNote(status: number, body: unknown,
    name: string, kind: CodegraphRunKind): string | null` (null on 200)
  - `useCodegraph(): { data; error; updatedAt; refresh(); nextPollAtMs; polling }` — `useGitStats`'s schedule over `/api/codegraph`, plus: whenever a payload
    with `hasLiveRun` arrives, one refresh `CODEGRAPH_FAST_POLL_MS` later (cleared on unmount and on the next payload)
  - `useCodegraphRun(onChange: () => void): { run(dirName, name, kind): Promise<void>; runAll(targets: { dirName; name }[]): Promise<void>; pendingKey: string
    | null; note: string | null; tokenRequired; writeAccess }` — POST `{dirName, kind}`, `note` from `runNote`, `onChange()` after each POST; `runAll` is
    sequential syncs and stops at the first refusal

- [ ] **Step 1: Write the failing tests:** `hasLiveRun` null → false, no runs → false, one `run` → true; `runNote(200)` → null, `409` → "brickwright is
  already running a sync or reindex.", `404` → "brickwright has no code graph.", `403 {error:'bad token'}` → `CODEGRAPH_NEEDS_TOKEN`, `403 read-only` →
  `READ_ONLY_TEXT`, `500` → "Couldn't start sync on brickwright.".
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(codegraph): poll and run hooks`.

### Task 6: Views, clock chip, CSS

**Files:**
- Create: `client/src/components/management/CodegraphView.tsx`, `CodegraphInbox.tsx`, `CodegraphMatrix.tsx`, `CodegraphInspector.tsx`,
  `CodegraphClockChip.tsx`, `CodegraphParts.tsx` (chips, keys, confirm, kinds strip)
- Modify: `client/src/components/management/ManagementView.tsx` (three-way switch + doc comment names CodeGraph), `client/src/styles.css` (`cg-*` only)

**Interfaces:**
- Consumes: Tasks 4–5; `useNarrow`, `usePersistedState('management.codegraphLayout', …)`, `useOpenFolder`, `useDismiss`, `formatAgo`, `Band`, Git's meter
  (export it from `GitClockChip.tsx`/`GitParts.tsx` if it is not, rather than copying).

Behaviour: spec §Client, item by item, against the approved mock v2 (open it in the built-in browser for reference). Matrix is wide-only. The Reindex confirm
is in-page (no `window.confirm`), opens under the repo's keys, Escape and outside-click cancel (`useDismiss`). Keys are disabled while `pendingKey` or the
repo's `run` is set, or when `writeAccess === 'none'`. `cli: 'missing'` draws the toolbar and the one sentence, nothing else.

- [ ] **Step 1:** Build the components; `pnpm typecheck` and `pnpm build` — PASS.
- [ ] **Step 2: Verify in the browser** against the user's running dev server (http://localhost:5174 — **never start or kill a server on 5174/4173**; if
  none is up, start your own on spare ports and kill it by its recorded pid). Check: each layout renders the real pins; tile click filters and clears;
  phone width (375) draws Inbox for a stored Matrix with no horizontal scroll; Sync on a repo with pending changes shows `Syncing`, polls at 3 s, then the
  repo reads quiet; Reindex opens the confirm and Cancel closes it (do **not** confirm a reindex on the user's repos); midnight and daylight themes show no
  hardcoded color. Screenshot each layout.
- [ ] **Step 3: Commit** `feat(management): CodeGraph sub-view`.

### Task 7: Docs, visual baselines

**Files:**
- Create: `docs/subsystems/codegraph.md` (docs-sync stamp like `docs/subsystems/git-stats.md`; data source, cache/TTL, runs, lock-loss rule, levels,
  settle-by-plan calls, the 2026-10-19 timings)
- Modify: `docs/overview.md` (§Map line, API table rows for both routes, `lib/` map for both server modules), `.claude/CLAUDE.md` (§Code rules: one sentence
  that `lib/codegraph.ts` launches the `codegraph` CLI, whose update check is disabled by `CODEGRAPH_NO_UPDATE_CHECK=1` / `CODEGRAPH_NO_DOWNLOAD=1` — a local
  launch, not a third outbound kind), `test/visual/` (a `codegraph` fixture beside `fixtures/git-stats.ts` and shots for the three layouts plus phone Inbox,
  per `docs/subsystems/visual-tests.md`)

- [ ] **Step 1:** Write the docs; run `pnpm exec tsx test/outbound.test.ts` (or the full harness module) — PASS (the doc half must still pass).
- [ ] **Step 2:** Add the visual fixture and specs; `pnpm build && pnpm test:visual --update-snapshots`, then `pnpm test:visual` — PASS.
- [ ] **Step 3: Commit** `docs: codegraph subsystem` and `test(visual): codegraph baselines` (two commits).

## Not in this plan (spec non-goals)

Init, unpinned repos, hub tile, ntfy alert, spawned Claude session, config editing, `uninit`, per-language counts, Matrix row expansion.
