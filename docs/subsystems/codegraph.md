# CodeGraph — the `codegraph` CLI's state per pinned project

`GET /api/codegraph` answers, for every **pinned** project (`listPinRows`, in pin order), whether a CodeGraph index exists for it, how fresh and complete it is, whether a
watcher keeps it current, and whether a Sync or Reindex is running. `POST /api/codegraph/run` starts one. The Management tab's CodeGraph sub-view draws it. The readers are
`server/lib/codegraph.ts` (pure: status parser, graph-root walk, pid files, the CLI runner) and `server/lib/codegraph-store.ts` (cache, runs, the payload); the types
(`CodegraphRepo`, `CodegraphStats`, `CodegraphResponse`, `CodegraphRun`, `CodegraphLastRun`) are in `shared/types.ts`. Design record:
`docs/superpowers/specs/2026-10-19-codegraph-view-design.md`.

Repo paths come from `listPinRows`, never from the request. The CLI is launched through `execFile` / `spawn` with argv and no shell, never imported. Every launch runs with
`CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_NO_DOWNLOAD=1` (`CODEGRAPH_ENV`): the npm shim otherwise checks for a newer bundle on every launch and downloads one from GitHub when
it is missing. The shim is `#!/usr/bin/env node`, so the server's `PATH` must reach `node` as well as `codegraph`; that this holds under `pnpm dev` and `pnpm start` is
**not verified** (the machine's `codegraph` lives under nvm's bin dir).

## Data source

Per pin, `readCodegraphStatus`:

- A dead pin (`path: null` or `listed: false`) is `state: 'missing'`, no launch. It ranks with *Not indexed* and reads "Folder gone".
- The **graph root** is the pin's path or its nearest ancestor holding `.codegraph/codegraph.db` (a bare `.codegraph/` does not count) or a live `rebuild.pid`, since `index` unlinks
  and recreates the DB. This is the CLI's own walk (1.6.2). A pin may be a subdirectory of the repo, so the `none` short-circuit, the run's `404`, every pid file and every
  run's `cwd` go through the root. No root is `state: 'none'` with no launch.
- Otherwise `codegraph status --json` runs with `cwd` = the **pin's path**, not the root: the CLI's `worktreeMismatch` compares the start path with the root it walks up to, so a
  root `cwd` would always report null. `initialized: false` is `none` too. A non-zero exit, a timeout (`CODEGRAPH_STATUS_TIMEOUT_MS`, 15 s, its own timer as in `git-stats.ts`) or
  unparsable JSON is `state: 'error'` with a one-line reason.
- A spawn `ENOENT` with the `cwd` still a directory is `cli: 'missing'` for the **whole payload** (the page says so once, and draws no rows); with the `cwd` gone it is that one
  repo `missing`. Under `cli: 'missing'` the rows are placeholders, so callers check `cli` first.

Fields passed through: `lastIndexed`, the four counts, `nodesByKind`, `languages` (names only), `pendingChanges`, `worktreeMismatch`, `version` and
`index.{state, reindexRecommended, builtWith*, currentExtractionVersion}`. **Symbols** everywhere is `nodeCount`, file nodes included, so the kinds strip's "other" holds `file`. A
null `index.state` (an index older than the marker) is read as `complete`; a null `builtWithExtractionVersion` shows `—` and "extractor unknown (older index)".

**Watcher** is `<root>/.codegraph/daemon.pid` with a live pid (`process.kill(pid, 0)`; a crashed daemon leaves its file). `startedAt` is the Inspector's "Running since".
`~/.codegraph/daemons/*.json` is not read. **A live rebuild** is a live `rebuild.pid`; **a live sync lock** is a live `codegraph.lock` (a bare pid, the others are JSON). All
pid files are read on **every GET**, since that is a file read and a signal-0.

States: `ok`, `building` (a live rebuild and no good stats yet: ranks quiet, "Indexing… — numbers when it finishes"), `none`, `missing`, `error`. While a rebuild is live, a
failed status read keeps the last good stats (`lastOk`) and shows the run instead of turning the repo `error`.

## Cache

The store keeps one status result per **(graph root, pin path)**, since `worktreeMismatch` differs between two pins on one root. A GET with no entry reads now; an entry older than
`CODEGRAPH_TTL_MS` (25 s) answers as it is while **one** background refresh starts; a fresh one answers from cache. At most `CODEGRAPH_CONCURRENCY` (2) status reads run at once
across repos. There is **no timer and no Git-style watched flag**: a read only ever starts inside a GET, so a closed tab costs nothing, and the client's 30 s poll keeps each entry
fresh enough. Seven indexed pins read back to back are ~8 s of CPU, which is why the poll must not run the CLI per request (timings below).

A run's end drops that root's entries, and so does a `rebuild.pid` seen live on one GET and dead on the next (a terminal's rebuild, or one that outlived a server restart), so the next
GET re-reads instead of showing pre-run numbers for the rest of the TTL. A run in flight with no record of its own but a live `rebuild.pid` is synthesised as
`run: { kind: 'reindex', startedAtMs: <its startedAt> }`, so the client's fast poll and disabled keys work for it. `seenRebuild` is cleared when our own reindex ends, so dropping
again on the dead pid does not discard the read that follows.

## Runs

`POST /api/codegraph/run` `{ dirName, kind: 'sync' | 'reindex' }`. Refusals, in order: `405` non-POST, `403` `refuseWrite` (local and trusted-tailnet peers need no token), `400` bad
body, `403 not a pinned project`, `404 not indexed`, `409 already running`, then `200 { ok: true }`. A `409` is: a run of ours on that root, a live `rebuild.pid`, or a live `codegraph.lock`
with **no** watcher (with one, the lock is the watcher's own write and a sync is allowed). Runs are recorded **per graph root**, so a repo pin racing its subdirectory pin launches once;
the per-`dirName` mark is taken before the first await.

The CLI starts detached from the request and the answer is immediate; the next poll shows `run`. Argv is exactly `codegraph sync` / `codegraph index`: no path argument (`index <path>`
does not walk up), no `-q` (it hides the lock-loss line below), `cwd` = the graph root, `stdio: ['ignore', 'pipe', 'pipe']` so `index` never prompts. There is no timer on a run.
`lastRun.message` is the last non-empty stderr line, else stdout's, else `exit <code>`.

**Lock-loss rule.** A non-zero exit whose output contains `could not acquire the file lock` (`LOCK_LOSS_TEXT`), with `watchingAtLaunch` true, is recorded `ok` with the message
`watcher is syncing it`: the watcher is already doing the work. Without a watcher at launch the same text is a failure. `lastRun` is per root and is replaced by the next run, so a
failure clears on the next success or a server restart (the map is in memory).

## Levels and ranking

`client/src/lib/codegraphLevels.ts`, pure, one table (the spec's Levels). A repo is read into problems with a severity; the worst is its level.

| Level | Problems |
| --- | --- |
| Needs you (3) | `reindexRecommended`, `partial`, `failed`, `indexing` with no live rebuild (a killed build), `error`, a failed `lastRun` |
| Worth a look (2) | pending changes with **no** watcher, `worktreeMismatch` |
| All good | none of the above; pending changes **with** a watcher are quiet, since it picks them up in about a second |
| Not indexed | `none` and `missing`: no graph, so nothing to be wrong with |

Rank is level, then summed severity, then pin order. A live rebuild is a run, not a problem. `cli: 'missing'` ranks nothing: the view draws one sentence.

## Client

`CodegraphView` is the band, a toolbar (Inbox | Matrix | Inspector, and the clock chip with READ and WATCHERS meters) and one layout. It ranks once per payload and hands every layout
the same `CodegraphLayoutProps`. `useCodegraph` polls every 30 s while the page is visible and every 3 s while any repo has a `run` (`codegraphPoll.ts`); it is mounted with the view, so
leaving the tab stops it. `useCodegraphRun` provides `run` and `runAll` and reuses Git's write gating (`tokenRequired`, `writeAccess`). The layout is stored per device under
`management.codegraphLayout` (default `inbox`, swept by Settings › Reset); Matrix is wide-only, and a phone draws Inbox for a stored Matrix while the choice waits for a wider window
(`drawableCodegraphLayout`). The shapes are Git's, so the classes are too (`.git-dot`, `.git-chip`, `.git-sync`); only the kinds strip and the Inspector tiles are `cg-*`. Every string is in
`codegraphText.ts`.

Inbox has four filtering tiles, the loud repos as panels with a verdict and every problem's steps, then *All good* and *Not indexed* as dashed boxes. Matrix is one row per repo. Inspector
is a list and a detail pane. Indexing is the user's call, so *Not indexed* repos have **no** Init key.

## Calls the author made

Each was settled in the spec rather than left to the builder:

- **No Init key.** A repo without a graph is shown, never initialised from here.
- **`worktreeMismatch` is Worth a look**, not Needs you: the numbers are for another checkout, the index is not broken.
- **`partial` is Needs you**; **`indexing` is drawn as a run** with no level change (only a build with no live rebuild is a problem).
- **A failed run clears on the next success or a server restart**, and a **sync that loses the lock to a watcher is not a failure** (above).
- **Reindex asks first**, in an in-page confirm that focuses Cancel, since it throws the DB away. It stays allowed while a watcher runs (the user's decision, 2026-10-19), and the text
  says the watcher will lose the graph until it restarts.
- **Languages are names only**: the CLI has no per-language counts.

## Timings

Measured 2026-10-19 on codegraph 1.6.2: `codegraph status --json` took 0.82 s on release-kit and 2.32 s on microservice (2,672 files); seven indexed pins back to back are ~8 s of CPU.
The 25 s TTL and the cap of 2 follow from those; `CODEGRAPH_STATUS_TIMEOUT_MS` (15 s) leaves the slowest repo several times its measured time.

<!-- docs-sync:
  sources:
    - server/lib/codegraph.ts
    - server/lib/codegraph-store.ts
    - shared/types.ts
    - client/src/lib/codegraphLevels.ts
    - client/src/lib/codegraphLayouts.ts
    - client/src/lib/codegraphText.ts
    - client/src/lib/codegraphPoll.ts
    - client/src/hooks/useCodegraph.ts
    - client/src/hooks/useCodegraphRun.ts
    - client/src/components/management/CodegraphView.tsx
    - client/src/components/management/CodegraphParts.tsx
    - client/src/components/management/CodegraphInbox.tsx
    - client/src/components/management/CodegraphMatrix.tsx
    - client/src/components/management/CodegraphInspector.tsx
    - client/src/components/management/CodegraphClockChip.tsx
  kind: subsystem
  verified: 39dcca06a8a1b600cf59b74c7adec6d4dc267895
-->
