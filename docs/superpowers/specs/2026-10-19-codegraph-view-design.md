# Management › CodeGraph — design

Date: 2026-10-19. Mockups: https://claude.ai/artifact/5vLTCjf2napbWdQCrdkV6g (v2, "in Git's shape" — the approved one; v1's four directions were superseded).

## Intent

The user indexes most of their repos with CodeGraph (`.codegraph/` at the repo root) and leans on it in every session — the global CLAUDE.md tells sessions to
reach for `codegraph_explore` before grep. A stale or half-built graph silently degrades every session in that repo, and today the only way to know is to `cd`
into each repo and run `codegraph status`. This view answers three questions at a glance for the pinned projects: **is each graph up to date**, **how much is
graphed** (files, symbols, edges, size), and **which pins have no graph at all** — and lets the user fix the first one with a click.

It is a third sub-view of Management, beside Projects and Git, and it deliberately **replicates the Git sub-view's flow**: same band, same layout switcher, same
clock chip, same four level tiles that filter, same loud-panels-then-quiet-box Inbox, same Matrix and Inspector. The user asked for that flow by name; a user who
knows Git's tab should know this one without reading anything.

## Goals

- One row of state per **pinned** project, in pin order, from `codegraph status --json` run in the pin's folder.
- Four levels, ranked like Git's (see §Levels), driving the tiles, the Inbox grouping and the Matrix/Inspector ordering.
- **Sync** and **Reindex** keys that make the server run `codegraph sync` / `codegraph index` directly in the pin's folder.
- Size and shape per graph (files, symbols, edges, DB size, symbols by kind, languages) in Matrix and Inspector.
- Works at phone width (Inbox and Inspector; Matrix is wide-only, as in Git).

## Non-goals

- **No Init.** A pin without `.codegraph/` shows as *Not indexed* with no key. The global CLAUDE.md says indexing is the user's decision; a one-click Init would
  make it the dashboard's. (Author's call — the user never answered the Init question directly, and the approved mock draws no Init key.)
- No unpinned projects, no filesystem scan for other indexed repos.
- No Lookout hub tile, no ntfy alert on a stale graph.
- No Claude session for sync: unlike Git's Sync, nothing here needs judgment, so no `/api/spawn`, no ChatDrawer.
- No editing of codegraph config, no `uninit`.

## Anti-goals

- **The page must never make the graph worse.** No concurrent writers on one repo: never start a sync or reindex on a repo that already has one running. The
  CLI already guards its own database — `index` takes `.codegraph/rebuild.pid` and stops the daemon before rebuilding, `sync` takes `codegraph.lock` — so the
  server leans on those guards rather than inventing its own, and adds only the per-repo `409`. Silently corrupting `codegraph.db` would be the worst outcome.
- **The poll must not make the machine slow.** `codegraph status --json` took 0.82 s on release-kit and 2.32 s on microservice (2,672 files), measured
  2026-10-19. Seven indexed pins run back to back every 30 s is ~8 s of CPU per poll. The server must not run the CLI once per request per repo.
- No new npm dependency in `server/` (CLAUDE.md §Code rules).

## Data

### Source

Per pinned project (`listPinRows`, same as `/api/git-stats` — paths never come from the request):

- No `.codegraph/` directory → `state: 'none'`.
- Otherwise run `codegraph status --json` with `cwd` = the pin's path, through `execFile` (argv, no shell) with its own timer, as `git-stats.ts` does (see its
  #168 note on `execFile`'s `timeout`). Non-zero exit, timeout or unparsable JSON → `state: 'error'` with a one-line reason.
- CLI missing from the server's `PATH` → the whole payload says so once (`cli: 'missing'`), not one error per repo. Note that this machine's `codegraph` is under
  nvm's bin dir; the builder confirms the server process inherits that `PATH` under both `pnpm dev` and `pnpm start`.

The fields the status JSON carries today (codegraph 1.6.2) and this view uses: `lastIndexed`, `fileCount`, `nodeCount`, `edgeCount`, `dbSizeBytes`,
`nodesByKind`, `languages` (names only), `pendingChanges.{added,modified,removed}`, `worktreeMismatch`, `version`, and `index.{state, reindexRecommended,
builtWithExtractionVersion, currentExtractionVersion}`. Pass them through typed in `shared/types.ts`; the client never sees raw CLI output.

**Watcher running.** Whether a codegraph daemon is watching the repo (it picks up edits within ~1 s, so pending changes then resolve themselves). Two candidate
sources on disk: `<repo>/.codegraph/daemon.pid`, and `~/.codegraph/daemons/*.json` (`{root, pid, version, socketPath, startedAt}`). Either way the pid must be
checked alive (`process.kill(pid, 0)`), since a crashed daemon leaves its file. Which source wins is the builder's call.

### Cost

The server keeps a per-repo cache of the last status result and refreshes it in the background, at most one CLI run per repo at a time and a small concurrency
cap across repos. A `GET` answers from the cache immediately. Use Git's watched-only idea (`markGitWatched` in `git-fetch.ts`): refresh only while a client has
asked recently, so a closed tab costs nothing. Exact TTL, cap and whether to share Git's watch flag are the builder's call; the constraint is the anti-goal above.

### API

- `GET /api/codegraph` — `{ generatedAt, cli: 'ok' | 'missing', repos: CodegraphRepo[] }`, repos in pin order. Each repo: `dirName`, `name`, `path`, `state`
  (`ok | none | error`), the status fields above when `ok`, `watching: boolean`, `run: null | { kind: 'sync' | 'reindex', startedAtMs }`, and
  `lastRun: null | { kind, ok, endedAtMs, message }` so a failed sync is visible after it ends.
- `POST /api/codegraph/run` — `{ dirName, kind: 'sync' | 'reindex' }`. Write-guarded exactly like `POST /api/git-fetch`: `refuseWrite` (`server/api.ts`), so
  local and trusted-tailnet peers need no token and others need the Answer token; the client gates its keys on `tokenRequired` / `writeAccess` as `GitView`
  does. `dirName` must be a listed pin with `.codegraph/`; `409` if a run is already going on that repo (ours, or a `.codegraph/rebuild.pid` that is alive).
  Starts the CLI detached from the request and answers at once; the next poll shows `run`. Refusals in order: `405` non-POST, `403` (`refuseWrite`), `400` bad
  body, `403 not a pinned project` (as `open-folder` answers), `404 not indexed`, `409 already running`, then `200`.

## Levels

Read each repo into problems with a severity, exactly as `gitLevels.ts` does, and rank `needs`, `look`, `quiet`, `none`, then summed severity, then pin order.

| Level | Tile label | When |
| ----- | ---------- | ---- |
| `needs` (sev 3) | Needs you | `reindexRecommended`, `index.state: 'partial'` (an interrupted build), or `state: 'error'`; also a `lastRun` that failed |
| `look` (sev 2) | Worth a look | pending changes > 0 **and** no watcher running; `worktreeMismatch` non-null (author's call — the mock's legend did not place it) |
| `quiet` | All good | an `ok` repo with neither of the above. Pending changes with a watcher running are quiet: the watcher will catch up |
| `none` | Not indexed | no `.codegraph/`. Takes the slot Git gives *Can't read* |

`state: 'error'` is *Needs you*, not its own level, because the fix (Reindex) is the same.

**A build in progress** — `index.state: 'indexing'`, or a live `.codegraph/rebuild.pid` — is drawn as a run (cyan "Indexing…" chip, keys disabled) whatever
started it: a terminal, another session, or this server before a `tsx watch` restart dropped its in-memory `run`. It adds no problem and does not change the
level. (Author's call; the CLI's three index states are `complete`, `indexing`, `partial`.)

**When a failed run stops counting** (author's call): `lastRun` is held in memory, so a server restart clears it; otherwise it clears on the next successful run
of either kind. A `sync` that loses `codegraph.lock` to a live watcher is **not** a failure — the watcher is already doing the work — and is recorded as
`ok` with the message "watcher is syncing it".

## Client

Mirror `GitView` and its parts; reuse shared pieces where they are already generic (`startGitPoll` / `gitPoll.ts`, the meter, `.git-*` classes, `useDismiss`,
`useOpenFolder`) rather than copying them. Where a Git module is Git-specific (`gitLevels.ts`, `gitStatsText.ts`), write a `codegraph*` sibling.

- **Rail and tab.** `managementTab` gains `'codegraph'`; the rail's Management tree gets a third item, *CodeGraph*, after Git. `ManagementView` mounts
  `CodegraphView` only while that tab is picked, so the poll stops when the user leaves.
- **Band.** "Management · CodeGraph", sub: "Code graph index of your pinned repos. Sync re-parses changed files; Reindex rebuilds from scratch."
- **Switcher.** Inbox | Matrix | Inspector, stored per device as `management.codegraphLayout` (default Inbox); phone draws Inbox while a stored Matrix waits,
  exactly as `drawableGitLayout` does.
- **Poll.** 30 s while visible, immediate on becoming visible, none while hidden — `useGitStats`'s schedule. While any repo has a `run`, poll every 3 s until
  it clears.
- **Clock chip** (right end of the toolbar). Two meters: **READ** (countdown to the next poll) and **WATCHERS** (`n / m` indexed repos with a watcher; amber when
  any `look`-level repo lacks one). Popover rows: **Re-read status** · `now`, and **Sync all behind** · `now` (runs Sync on every `look` repo whose problem is
  pending changes, one POST each, sequentially; disabled with a reason when there are none, or when the Answer token is missing).
- **Inbox.** Four tiles (counts per level, click filters, click again clears). Loud repos as `.git-panel` items: dot, name, chips (`reindex` amber /
  `N pending` mustard / `no watcher` dashed / `watching`), a verdict sentence, steps, keys on the right. *All good* as one dashed box of lines: `files · symbols ·
  watching · indexed <age>` and a quiet Sync key. *Not indexed* as a second dashed box: name and "No .codegraph/ in <~path>", no key.
- **Matrix.** Wide-only. Columns: dot, Repo, Index (`complete` / pill), Changes (`none` / `N pending` pill), Extractor (`v27` / `v26 → v27` pill), Watcher
  (`on` / `off`; pill only when it matters, i.e. on a `look` repo), Files, Symbols, Edges, DB, Indexed (age), key. A `none` row spans one *Not indexed* cell.
  Row expansion (symbols by kind) is optional — builder's call.
- **Inspector.** Ranked list beside a pane: name + chips, four tiles (files, symbols, edges, database), a symbols-by-kind strip with a legend (functions,
  imports, properties, constants, types = interface + type_alias, other), facts (Languages, Last indexed + codegraph and extractor version, Changes, Watcher),
  footer keys Sync, Reindex, Open folder. Phone stacks the pane under the list. The mock's per-language file counts are **not** in the JSON; show the language
  list only unless the builder finds the counts cheaply (author's call).
- **Keys.** Git's raised `.git-sync` key. Reindex is `primary` on a `needs` repo. A running run turns the key cyan with the turning glyph ("Syncing" /
  "Reindexing") and disables both keys on that repo. Refusals and failed runs show one amber line under the toolbar, as Git's `sync.note` does. **Reindex asks
  first** (in-page confirm, not `window.confirm`) because it throws the DB away and can take minutes on a large repo — author's call, cheap insurance. When the
  repo has a watcher, the confirm also says so: `codegraph index` stops the watcher before rebuilding (the CLI's own guard), so open sessions in that repo
  lose codegraph until it restarts. Reindex stays allowed while watching — the user's decision, 2026-10-19.
- **Empty states.** Loading… / "Couldn't load CodeGraph status. Retrying every 30s." / no pins → Git's sentence with the Projects link / `cli: 'missing'` →
  "codegraph isn't on the server's PATH." with nothing else drawn.

All spec'd strings live in one `codegraphText.ts`, as Git's do.

## Constraints

- `shared/types.ts` first, then server, then client (CLAUDE.md).
- Server: Node built-ins only; `execFile`/`spawn` with argv. Running `codegraph` is a local process launch, like `git` and `claude`. The CLI keeps its own
  update check (`~/.codegraph/update-check.json`; telemetry is disabled on this machine), so it may make its own network call — the same standing as `git fetch`
  in CLAUDE.md §Code rules: not a third kind for the server, but the sentence in CLAUDE.md and `docs/overview.md` must name it, and `test/outbound.test.ts`'s
  doc half must still pass. Every launch sets `CODEGRAPH_NO_UPDATE_CHECK=1` and `CODEGRAPH_NO_DOWNLOAD=1` (the npm shim otherwise downloads its bundle from
  GitHub when missing); the outbound sentence names both. The shim is `#!/usr/bin/env node`, so the server's `PATH` must reach `node` as well as `codegraph`.
- No hardcoded colors in `styles.css`; reuse Git's classes where the shape is identical, add `cg-*` only for what is new (the kinds strip, Inspector tiles).
- Visual suite (`pnpm test:visual`) gains baselines for the new tab; macOS-only, on demand.

## Tests

- Levels and ranking: one case per row of the Levels table, plus the mirror cases (pending **with** a watcher is quiet; reindexRecommended **with** a watcher
  is still needs).
- Status parsing: real 1.6.2 JSON fixture → typed repo; garbage, empty stdout, non-zero exit, timeout → `error` with reason; no `.codegraph/` → `none` without
  launching the CLI.
- Watcher detection: live pid → true; dead pid file → false; no file → false.
- `POST /api/codegraph/run`: each refusal code in order, `409` on a second run, `dirName` not a pin, pin not indexed. The run itself through an injected
  runner, never the real CLI.
- Cache: a burst of `GET`s runs the CLI at most once per repo per refresh window; no client watching → no runs.

## Docs

New `docs/subsystems/codegraph.md` (with a docs-sync stamp like `git-stats.md`), a line in `docs/overview.md` §Map and the API table, the CLAUDE.md outbound
sentence, and the Management description in `ManagementView.tsx`'s comment.

## Left to the builder

Watcher source; cache TTL and concurrency cap; whether to share Git's watched flag; Matrix row expansion; whether per-language counts are cheap enough to show.

## Calls the author made (check these)

No Init key · `worktreeMismatch` is *Worth a look* · `partial` is *Needs you*, `indexing` is drawn as a run with no level change · a failed run clears on the
next success or a server restart, and a sync that loses the lock to a watcher is not a failure · Reindex asks first · languages without per-language counts.
