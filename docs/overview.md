# Architecture overview

A **monolith split into three domains**: a Node backend (`server/`), a Vite + React +
TypeScript frontend (`client/`), and the shared API contract (`shared/`). One repo, one
deploy. The **only** data crossing the frontend/backend boundary is the typed JSON
payloads defined in `shared/types.ts` (the only code both sides run is `shared/frontmatter.ts`, `shared/gitUpstream.ts`, `shared/cron.ts` and `shared/schedule-file.ts`) — when adding an API field, edit that file first,
then the server producer, then the client consumer.

Everything the dashboard shows is read straight off disk from
`~/.claude/projects/*/*.jsonl` (the transcripts Claude Code already writes). Monitoring
needs no daemon, no hooks, and no config in Claude Code — hooks are installed only by the
opt-in features that need one ([remote answers](subsystems/remote-answer.md),
[remote plan verdicts](subsystems/remote-plan.md), the
[`Allow?` tab](subsystems/permission-notify.md), and the `Stop` hook that backs both the
finished-turn [push](subsystems/push-notify.md) and
[remote messages](subsystems/remote-message.md)). One hook ships alongside them but feeds
nothing here: `kill-guard.sh`, a `PreToolUse`/`Bash` guard that refuses unanchored
`pkill`/`killall` — see [hooks-setup](workflows/hooks-setup.md).

## Data flow

1. The client polls `GET /api/sessions` every 3 seconds (the Settings tab retunes this, and
   attaches the row count and time windows as query params).
2. `server/lib/scan.ts` enumerates transcripts across `~/.claude/projects`, ranks them by
   recency, and calls `server/lib/transcript.ts` to tail-read the last 256 KB of each —
   enough to derive tokens, model, context window, current activity, and status.
3. Detail views fetch lazily: subagents (`/api/sessions/:id`), chat pages
   (`/api/sessions/:id/chat`), Claude config, analytics reports.

No database, no cache layer beyond in-memory maps, no build step for the server (it runs
via `tsx`, dev and prod alike).

## Principles

- **Read-only charter.** The app never writes to `~/.claude` or the transcripts. It reads
  one file outside them — `~/.claude.json`, for `oauthAccount` (the account chip's name
  and plan, see [account-header](subsystems/account-header.md)) and the `mcpServers` the config browser lists (`lib/management.ts`, top-level and
  per-project) — and nothing else in that file. The
  deliberate exceptions are the answer POST endpoints (RAM-only stores); a handful of
  gitignored, repo-local files — `.remote-answer.json` (see
  [remote answers](subsystems/remote-answer.md)), `.dashboard-settings.json` (see
  [settings](subsystems/settings.md)), and the usage-recording set
  `.usage-history.jsonl` / `.usage-ledger.jsonl` / `.usage-profile.json`, written only while
  the Settings tab's recording switch is on (off by default — see
  [usage limits](subsystems/usage-limits.md)); and, going
  further than any of those, [spawning a new `claude -p` process](subsystems/spawn.md) on
  this machine — off by default (empty `CLAUDE_BIN`), and the first exception that reaches
  outside the dashboard's own state, since what it writes is a whole new session's
  transcript rather than a row in a RAM-only store. Where such a session can be
  continued afterwards — phone app, terminal resume, and the surfaces that will
  never show it — is mapped in [session surfaces](subsystems/session-surfaces.md),
  which is also where `Session.surface` (the row's `dashboard` pill) is specified.
  The second thing that reaches outside the dashboard's own state is [the Git fetch timer](subsystems/git-stats.md#the-fetch): off by default, it runs
  `git fetch origin` over the pinned repos while Management › Git is open, which writes their remote-tracking refs and `FETCH_HEAD`, never a branch or a
  working tree.
  The third thing the server launches is the `codegraph` CLI ([codegraph](subsystems/codegraph.md)): `codegraph status --json` per pinned project, cached 25 s and run only
  from inside a GET, and `codegraph sync` / `codegraph index` when the user presses Sync or Reindex. Every launch sets `CODEGRAPH_NO_UPDATE_CHECK=1` and
  `CODEGRAPH_NO_DOWNLOAD=1`, so the shim neither checks for nor downloads a newer bundle.
- **Zero runtime dependencies on the backend.** `server/` uses Node built-ins only, with two pinned exceptions, neither with deps of its own:
  `lookout-widgets` ([hub-widgets](subsystems/hub-widgets.md#the-dependency-exception)) and `release-kit`, whose memoised `createReleasesReader` backs
  [`GET /api/releases`](subsystems/releases.md); `test/server-deps.test.ts` pins both. Keep new npm deps out of it.
- **Fail-open everywhere.** A missing token, an unreadable file, a failed probe — every
  auxiliary feature degrades to "not shown" rather than crashing the monitor.
- **Path safety.** Endpoints never join request input into filesystem paths. IDs are
  validated and resolved against enumerated sets (`listTranscripts`,
  `collectServablePaths`); anything else is a 400/404.

## HTTP surface

All routes live in `server/index.ts` (dispatch) and `server/api.ts` (handlers). Every POST runs the write gate; a **session write path** also needs the
remote-answer switch on, a **gate-only write** needs the gate alone ([who may write](subsystems/remote-access.md#who-may-write) defines both):

| Route | Purpose |
|---|---|
| `GET /api/sessions` | the poll snapshot: sessions + totals + usage bars (`?limit=&lookback=&active=` override the scan) |
| `GET /api/sessions/:id` | one session's subagent timeline |
| `GET /api/sessions/:id/chat` | paged chat history (byte-offset cursors) |
| `GET /api/sessions/:id/question` | pending remote question, if any |
| `POST /api/sessions/:id/answer` | deliver a remote answer (session write path — answer) |
| `POST /api/questions/wait` | the hook's held-open wait (session write path — answer) |
| `GET /api/sessions/:id/plan` | pending proposed plan, if any |
| `POST /api/sessions/:id/plan-answer` | send a plan back for revision (session write path — plan) |
| `POST /api/plans/wait` | the plan hook's held-open wait (session write path — plan) |
| `GET /api/sessions/:id/message` | pending reply window, if any |
| `POST /api/sessions/:id/message-answer` | send free text into a finished turn, or let it stop (session write path — message) |
| `POST /api/messages/wait` | the Stop hook's held-open wait, away only — except headless sessions, which hold at the desk too (session write path — message) |
| `POST /api/transcribe` | a recorded clip in, transcribed text out — feeds the reply composer's mic (session write path — dictation, rides the switch, not counted) |
| `POST /api/spawn` | start a new headless `claude -p` session in a recent or pinned project, or `resume` an ended `dashboard` one by id (session write path — spawn, the one the dashboard initiates rather than answers) |
| `POST /api/spawn/:id/stop` | SIGTERM a still-launching session's child (session write path — spawn) |
| `POST /api/sessions/:id/stop` | stop a dashboard-spawned session at any point in its life — graceful by default, `{"force":true}` to skip the grace window; the row's button only ever calls this one (session write path — spawn) |
| `POST /api/permissions/notify` | "a permission dialog is open" flag (display-only) (gate-only write) |
| `POST /api/notify/event` | the Stop hook's push trigger — the other three events notify from the endpoint they already POST to (gate-only write) |
| `POST /api/notify/test` | fire one push regardless of policy and report what ntfy said (gate-only write) |
| `POST /api/remote-answer` | flip the remote-answer toggle (gate-only write) |
| `GET /api/dismiss` | where a tapped desk push lands — a page that closes the tab it opened in; carries no deep link |
| `GET /api/health` | liveness + remote-answer state + connection origin and this caller's `writeAccess` + the two hook numbers (idle threshold, answer window) |
| `GET /api/settings`, `POST /api/settings` | the non-per-device settings — idle threshold, answer window, push policy, usage-history recording, tailnet write trust, plus `notifyAvailable` (never the ntfy topic itself); the POST is a gate-only write |
| `GET /api/pins`, `POST /api/pins` | pinned projects — listed past `LOOKBACK_HOURS` — plus the recent and older ones on offer to pin; the POST is a gate-only write (see [configs](subsystems/configs.md)) |
| `POST /api/pins/order` | the whole pin list in a new order, accepted only as an exact permutation of the stored pins (409 otherwise); gate-only write, answers the `GET /api/pins` payload (see [configs](subsystems/configs.md)) |
| `POST /api/open-folder` | open a pinned project's folder with macOS `open` (gate-only write); path must be a listed pin's, 501 off macOS (see [git-stats](subsystems/git-stats.md)) |
| `GET /api/git-stats` | local git state of every pinned project, in pin order, plus the fetch clock and each repo's last-fetch verdict; a repo that fails is its own `error` row (see [git-stats](subsystems/git-stats.md)) |
| `GET /api/codegraph` | the `codegraph` CLI's state of every pinned project, in pin order: index health, watcher, run in flight, last run; `cli: 'missing'` once for the payload; `?fresh=1` (Re-read status) skips the status cache (see [codegraph](subsystems/codegraph.md)) |
| `POST /api/codegraph/run` | `{dirName, kind: 'sync' \| 'reindex'}`: start `codegraph sync` / `index` on a pinned, indexed repo and answer at once (gate-only write, like `git-fetch`); 404 not indexed, 409 already running (see [codegraph](subsystems/codegraph.md#runs)) |
| `POST /api/git-fetch` | `git fetch origin` over every pinned repo now, answering with the fetch clock; gate-only write (see [git-stats](subsystems/git-stats.md#the-fetch)) |
| `POST /api/git-quick` | `{dirName, op: 'pull' \| 'push'}`: fast-forward pull or push of one pinned repo for the Sync menu; gate-only write, 409 when busy or a fetch is running (see [git-stats](subsystems/git-stats.md#quick-pull-and-push--the-writer)) |
| `GET /api/configs`, `/project`, `/file` | config browser index / scope / file body |
| `GET /api/analytics` | `/kaizen` post-mortem reports |
| `GET /api/hub/widgets`, `/:id` | the Lookout hub catalog and widget data — usage gauge, sessions list and Git pending list; `POST` action paths are 404 (see [hub-widgets](subsystems/hub-widgets.md)) |
| `GET /api/account` | who the CLI is signed in as (`~/.claude.json` → `oauthAccount`, as display strings) + the two rate windows — the header chip's own 30s poll, so it does not ride the 3s session scan |
| `GET /api/releases` | the dashboard's own releases from the checkout's local annotated `vX.Y.Z` tags (release-kit's `createReleasesReader`), memoised on HEAD + the tag refs; the empty shape when there are none ([releases](subsystems/releases.md)) |
| `GET /api/usage/profile` | the duty-cycle profile behind the weekly projection — cells + the forward walk, never raw samples or file paths |
| `GET /api/usage/rates` | tokens per 1% of the 5h window per model: the pooled rate + drift verdict, the two-term split, the jointly-fitted rate and its gap against the pooled one, one cell per UTC day of the horizon, plus the coverage disclosure and the off-peak boost verdict (`lib/usage-boost.ts`) |
| `GET /api/usage/history?days=N` | recorded 5h and weekly utilization over the last N days (default 7, clamped 1–365): windows by observed `resetsAt`, gap-split step segments downsampled to ~1440 points, and the recording gaps; served with recording off too (`lib/usage-history-series.ts`) |
| `GET /api/schedules` | scheduled workflows: machine, schedules folder, who owns it (`owner`), the reconcile state and every job with its last run ([schedules](subsystems/schedules.md)) |
| `GET /api/schedules/runs` | folded runs of the run log, newest first, with stats for `days` (7/30/90) and the window before it; `?job=&outcome=&runner=` filter, 400 `bad outcome` |
| `GET /api/schedules/:name` | one job's raw file text and parsed shape, for the editor |
| `POST /api/schedules`, `PUT`, `PATCH`, `DELETE /api/schedules/:name` | create / replace / toggle `enabled` / delete a job file, then reconcile; 422 with `errors`, 409 `exists`; all gate-only writes, 409 `not-owner` off the owning server |
| `POST /api/schedules/validate` | `{text, name?}` → `{errors, summary}`; read-only, outside the write gate |
| `POST /api/schedules/reconcile` | `{apply?}`: the plan of installs, updates and removes against launchd / crontab, applied when `apply` (gate-only write) |
| `POST /api/schedules/reveal` | open the schedules folder, or one job's file, in Finder with `open` / `open -R`; 501 off macOS (gate-only write) |
| `POST /api/schedules/:name/run` | start the wrapper now (`{only?: [pins]}`), 202 with the run id read back from the log; 409 `already-running` (gate-only write) |
| `POST /api/schedules/:name/stop` | SIGTERM the running wrapper by its lock's pid; 204, or 409 `not-running` (gate-only write) |
| `GET /api/sessions/:id/row` | one session row for any id a transcript resolves, with no lookback — the Schedules page's `session →` link opens it in the ChatDrawer |
| anything else | static files from `client/dist` (production only) |

⚠️ The static catch-all resolves through `resolveStaticPath` in `index.ts`, which confines
the result to `client/dist` by comparing against the root **plus `path.sep`**. A bare
`startsWith(clientDist)` is a string-prefix test, so `../dist-old/x` — any sibling whose name
merely begins with `dist` — reads as inside the root and is served. It decodes through
`decodePath` for the same reason the `:id` routes do, which is also what makes the trailing
separator load-bearing rather than belt-and-braces: decoding is what turns `%2e%2e` into a
real `..`. This path is unauthenticated and answers on every interface, in dev as well as
prod — the "production only" in the table above is about what is *useful* there, not about
what the route will answer.

⚠️ Before any route — the hub included — the listener runs the two checks in `lib/request-guard.ts`: a `Host` that public DNS could have handed out
(DNS rebinding) and a cross-site state-changing request (CSRF) are both a 403. Loopback, IP literals and single-label names always pass; a public
tunnel's name needs `ALLOWED_HOSTS` ([configuration](workflows/configuration.md)), which Vite's `allowedHosts` reads too.

⚠️ Route order in `index.ts` is load-bearing: the `:id` detail regex would swallow
`/api/sessions/:id/chat|question|answer|plan|plan-answer|stop|message|message-answer`, so
all of those matches sit above it.

⚠️ Every `:id` route decodes its segment through `decodePath` in `index.ts`, never
`decodeURIComponent` directly. A malformed escape (a lone `%ZZ`) throws a `URIError`
*synchronously* inside the request listener — before any handler, before even `refuseWrite` — so
one unauthenticated request could otherwise end the process for every session it was
watching. A failed decode answers `400 {"error": "bad path encoding"}` instead. The async half
of the same problem has its own floor: handlers are dispatched as `void serveX(...)` and
nothing awaits them, so a process-wide `unhandledRejection` handler logs rather than throws —
one bad route is not a reason to stop serving the other twenty.

## Dev vs prod

- **Dev** (`pnpm dev`): Vite serves the page on `WEB_PORT` (default 5174) with HMR and
  proxies `/api` to the Node server on `PORT` (default 4173). The proxy sets `xfwd`, so
  the origin badge still sees the real client address.
- **Prod** (`pnpm build` + `pnpm start`): the Node server static-serves `client/dist` and
  answers the API on `PORT`, auto-opening the browser.

Both servers bind all interfaces, so LAN/tailnet access works with zero app config — see
[remote access](subsystems/remote-access.md).

## Repo layout

```
shared/types.ts   the API contract (SessionsResponse, Session, ManagementIndex,
                  SessionAnalysis, AnalyticsReport, …)
shared/frontmatter.ts  zero-dep YAML-frontmatter subset parser — shared because
                  both sides parse it (lib/management.ts and configs/FileBlock.tsx)
shared/gitUpstream.ts  zero-dep upstream rule (`gitUpstreamShown`) — shared so the Git view's chip and level
                  rule and the hub's Git pending tile cannot disagree about the same repo
shared/cron.ts    zero-dep five-field cron parser: `parseCron`, next and last fire time, the launchd `StartCalendarInterval` expansion, a plain-words
                  description — shared so the server, the client and the wrapper agree; `plugin/lib/cron.mjs` is its generated copy
shared/schedule-file.ts  zero-dep job-file `parseJob` (with its validation errors), `checkPins` and the `enabled:` writer `serializeEnabled` — the one
                  validator the server, the client and the wrapper all run; `plugin/lib/schedule-file.mjs` is its generated copy
server/
  index.ts        HTTP entry + routing; static-serves client/dist in prod
  api.ts          all /api handlers (+ error fallbacks)
  lib/config.ts   .env loader — process.env > .env > defaults
  lib/request-guard.ts  pure pre-route checks: `hostAllowed` (DNS rebinding) and `crossSiteWrite` (CSRF)
  lib/transcript.ts  tail-reads a transcript → tokens/model/window/activity
  lib/title-cache.ts  remembers a custom title once it sinks below the tail window
  lib/model-identity.ts  the session's model attachment id — its family/version (or `[1m]`) sizes the window, same tail-then-hunt
  lib/compact-history.ts  the newest compaction's `preTokens` — past 200k it proves a 1M window, same tail-then-hunt
  lib/compact-window.ts  the session's `autoCompactWindow` (per-model `modelSettings` first) off its settings files, pinned per session — caps the window
  lib/record-cache.ts  the shared tail-then-hunt search + remembered byte range both use
  lib/scan.ts     enumerates + ranks sessions; status machine; liveness gates (cwd, session id);
                  `listUsageTranscripts` is the second enumeration — top-level files plus
                  `<sessionId>/subagents/*.jsonl` — read by the usage ledger only, since a
                  subagent file must never become a session row (`analyze.ts` reads one
                  session's subagent files directly, through `subagent-usage.ts`)
  lib/archived.ts reads the desktop app's own session records (macOS Application
                  Support) for the `isArchived` flag, joined to transcripts by
                  `cliSessionId` — the only place that touches that store; the id
                  set is passed *into* `scanSessions`/`listRecentProjects` so they
                  stay pure. Fails open (no store → nothing hidden)
  lib/agents.ts   whole-file subagent parser → AgentJob[]
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts
  lib/tasks.ts    whole-file fold of the plan signals and TaskCreate/TaskUpdate → Session.tasks / taskPlan (plan wins), incremental by byte offset (the creates sit below the 256 KB tail)
  lib/plan-progress.ts  pure half of plan progress: signals from one tool_use input, the plan file's `Task N:` headings, the composed rows
  lib/chat.ts     byte-offset paged chat history
  lib/usage.ts    account 5h/weekly limits from Anthropic (OAuth) — the other
                  outbound call
  lib/usage-pace.ts  utilization sample ring → burn rate + projected 100% per window
  lib/usage-forecast.ts  forward walk over hour-of-week weights → projected 100%
  lib/usage-history.ts  persisted samples → the learned 168-bucket duty-cycle profile;
                  each sample also carries an optional `week` reading (weekly
                  utilization + resetsAt) that profile learning never reads
  lib/usage-history-series.ts  pure: history samples → the History tab's 5h and weekly
                  windows, gap-split segments, recording gaps and downsampling
  lib/usage-ledger.ts  per-minute per-model token ledger: reads new transcript bytes,
                  appends one line a tick (`.usage-ledger.jsonl`) — tokens and
                  request counts per model, counts absent on pre-upgrade lines
  lib/usage-rate.ts  joins history × ledger into classified intervals → tokens per 1%
                  of the 5h window per model, baseline vs trailing, drift verdicts,
                  plus the two-term (tokens + requests) split fit and the one-term
                  joint fit that prices mixed windows — with the refusals of both;
                  plus `joinWeeklyIntervals` (tick-to-tick pairing over the
                  weekly window), `WEEKLY_FLOORS`, `EXTERNAL_WEIGHTED_MAX_WEEKLY`
                  and the exported `poolRate`
  lib/usage-boost.ts  off-peak usage-limit boost detector over those intervals: weekday
                  off-peak vs same-day peak, weekend vs pooled weekday peak (pure)
  lib/token-refresh.ts  makes the CLI renew an expired OAuth token (auth status,
                  then one haiku turn) so the bars self-heal
  lib/management.ts   config scanner + servable-path security set
  lib/git-stats.ts    read-only git reader for the pinned repos: runner, trunk, memoised branch counts + merged proof
  lib/codegraph.ts    the `codegraph` CLI reader: runner (update check off), status parser, graph-root walk, pid files
  lib/codegraph-store.ts  CodeGraph's per-(root, pin) status cache, runs, lock-loss rule and the payload
  lib/git-fetch.ts    the Git fetch: detached `git fetch origin` per common dir, error classifier, watched-only timer + clock
  lib/git-quick.ts    the Sync menu's Pull and Push: fast-forward-only pull and push of one pinned repo, never forced, hooks run
  lib/git-locks.ts    one lock per git common dir, shared by git-quick and the fetch-all wait
  lib/open-folder.ts  `open <path>` through `execFile`, behind POST /api/open-folder (the pin-membership gate is in api.ts); `revealFile` is `open -R <file>` for the Schedules menu's Reveal in Finder
  lib/schedule-config.ts  machine name (`mac`/`wsl`), the schedules and state-root folders, and `scheduleEnv` — the environment baked into every installed job and `/run` spawn
  lib/schedule-store.ts   job files (read, atomic write, delete), the owner claim, `pins.json`, lock sweep and the pid-liveness `Probe`
  lib/schedule-reconcile.ts  the pure plan of installs, updates and removes against launchd / crontab, its apply, the serialised trigger and the watchers
  lib/schedule-run.ts     `POST /run` and `/stop`: spawn the wrapper through `spawn.ts`'s `spawnProcess`, read the run id back from the log
  lib/schedule-log.ts     the incremental run-log reader, the lost rule, 20 MB rotation and the window stats
  lib/schedule-notify.ts  the `schedule-failed` fold over runs: one push per run, `notified.json`, the first-start seed
  lib/schedule-boot.ts    what the owning server does on listen and on exit, and the shared log reader
  lib/hub-widgets.ts  the Lookout hub tiles (usage gauge, sessions list, Git pending list), declared through lookout-widgets
  lib/account.ts      `~/.claude.json` → `oauthAccount` as display strings, behind GET /api/account; fail-open to null
  lib/releases.ts     GET /api/releases: release-kit's memoised tag reader, pointed at the checkout, plus two test seams
  lib/analyze.ts  whole-session post-mortem → SessionAnalysis
  lib/subagent-usage.ts  sums one session's subagent transcripts → per-subagent token classes
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md
  lib/analytics.ts  reader for the Analytics tab
  lib/pending.ts  in-memory pending-question store (the first of the four session write paths)
  lib/plans.ts    in-memory pending-plan store (same machine, reject-only verdicts)
  lib/messages.ts in-memory turn-end reply-window store (same machine, plus a 5s
                  idle sweep that auto-releases every terminal-backed hold — headless
                  ones are exempt)
  lib/remote-message-prose.ts  the reply prose, wrap + unwrap in one import-free leaf
  lib/idle.ts     the shared `backAtDesk()` policy behind all three stores' 5s sweeps —
                  threshold, ioreg reading, test seam, fail directions (the rule
                  itself is `atDesk` in lib/notify.ts)
  lib/remoteState.ts  remote-answer switch (env gate + persisted toggle)
  lib/settings.ts persisted idle threshold, answer window, push policy + the
                  usage-recording switch
  lib/notify.ts   server-sent ntfy pushes — the layered policy, the `atDesk`
                  predicate, phone-vs-desk topic routing, and one of the backend's
                  two outbound calls (the other is `lib/usage.ts`)
  lib/origin.ts   connection classifier → local | lan | tailnet | unknown; `resolvePeer` is
                  both the badge and the write gate's verdict (`refuseWrite` in api.ts)
  lib/permissions.ts  in-memory "a permission dialog is open in that terminal" flags,
                  fed by the PermissionRequest hook; display-only
  lib/transcribe.ts  ffmpeg → whisper-cli pipeline behind POST /api/transcribe: mime
                  allowlist, cached engine probe, single-flight guard, typed failures
  lib/spawn.ts    launches a detached, headless `claude -p` session, or resumes an ended
                  one — the fourth session write path, and the first the dashboard initiates;
                  also owns stopping one (graceful SIGTERM, grace window, escalation)
                  (see docs/subsystems/spawn.md)
client/src/
  App.tsx         shell: side rail (Sessions | Usage | Management | Claude Configs |
                  Analytics | Settings) + lazy views
  components/     SideRail (section switcher — the rail on desktop, and below `sm`
                  (640px) the same markup as a menu dropped out of a top bar, every tree
                  open), SessionsView (the monitor — owns the 3s
                  poll, so leaving the section stops it; two columns: the list in one of
                  five views + a 320px aside), HeaderAccount (the shell's account
                  chip — identity + both rate windows, in the header band or the
                  phone nav bar; see subsystems/account-header.md), ReleasesDrawer (ui-kit's What's new
                  drawer behind the rail's version chip, plus the back gesture), Chevron (the one disclosure mark),
                  AsideBoard (clock, origin, counts, remote-answer switch, New session),
                  Toolbar (view switcher + filter/sort popovers; Popover is the shared
                  dismiss primitive), sessions/ (atoms, Expanded, EmptyState, AsideStrip
                  — the phone's one-bar aside — and the five views: Board, List, Split,
                  Tiles, Triage), SessionDetail (the subagent timeline),
                  ChatDrawer, TasksCard (the sidecar's checklist card and its phone fold), QuestionPanel, PlanPanel,
                  MessagePanel, PanelChrome (the head/stub the three panels share),
                  MicButton, SpawnPanel, PinPicker (the launch sheet's older projects to
                  pin), ResumePanel, PermissionBanner,
                  RemoteAnswerToggle, OriginBadge, Markdown, configs/, management/ (ManagementView —
                  the Projects | Git section — ProjectsView, the Projects sub-view: the pins and the
                  projects on offer as Tiles, Columns or Lists; and the Git sub-view: GitView
                  (band, switcher, poll owner), GitClockChip (the sync/fetch clock chip and
                  its popover), GitInbox / GitMatrix / GitInspector /
                  GitBranches (the four shapes, fed one `GitLayoutProps`), GitParts (chips, divergence bar, branch list they share, the split Sync key)
                  and GitQuickMenu (that key's Pull · Push · Sync with Claude menu); and the CodeGraph
                  sub-view: CodegraphView (band, switcher, poll owner), CodegraphClockChip, CodegraphInbox / CodegraphMatrix / CodegraphInspector (fed one
                  `CodegraphLayoutProps`) and CodegraphParts (chips, keys, Reindex confirm, kinds strip)), analytics/,
                  usage/ (UsageView + the three tabs, Sheet — the band / figure
                  strip / sheet / definitions
                  chrome the tabs draw, and
                  ReadingAids — the ⓘ button they both render), settings/
  components/management/schedules/  the Schedules sub-view, lazy with the rest of Management: SchedulesView (owns the poll, the write helper, the
                  drawer and the ChatDrawer), StatsBand, JobLedger / JobFold / JobMenu, JobDrawer (the editor), RunNowPopover, RunsList, SessionLink,
                  and `ctl.ts`, the one object of state and callbacks every part reads (see subsystems/schedules.md)
  hooks/          useSessions (the main poll), useSessionDetail, useSessionChat,
                  useConfigs, useConfigsScope (the scope + the one index
                  fetch, shared by the rail's tree and the page), useAnalytics,
                  useUsageProfile, useUsageRates, useUsageHistory, usePendingQuestion, usePendingPlan,
                  usePendingMessage, useRemoteAnswer, useSpawn, useStopSession, usePins, usePinReorder (Projects' pin grip), useOpenFolder (Git's Open folder
                  key),
                  useAccount (the header chip's 30s poll, owned by App), useGitFetch (Git's Fetch all key), useGitQuick (the Sync menu's Pull and Push),
                  useCodegraph (the CodeGraph sub-view's 30s visible-only poll, 3s while a run is live), useCodegraphRun (its Sync / Reindex keys),
                  useSchedules / useScheduleRuns (the Schedules sub-view's 3s polls, one `createPollSeq` each) and useScheduleWrite (its one write helper),
                  useGitStats (the Git sub-view's 30s visible-only poll), useGitSync (its
                  Sync button: runs per device, a sessions poll only while one is live),
                  usePersistedState, useAnswerToken (the page's one Answer token copy), useSettings, useServerSettings, useDictation, useFloatingTip
                  (the one hover/pin explanation panel, shared by both Usage tabs),
                  useTranscribeAvailable, useWebNotify (browser banners for headless
                  sessions), useBackClose, useHideOnScroll (the phone top bar's
                  auto-hide), useNarrow (the one JS read of the `md` breakpoint),
                  useStuckStrip (when the phone's aside strip pins)
  lib/            schedules (the Schedules page's pure helpers: pills, run folding, the Repos helper, write-failure text), filterSort, analyticsFilterSort, chatFilter, heldBody (which timeline body a pinned panel folds), markdown, configsEntries,
                  format, settings,
                  sections, deepLink, dictation, spawnOptions, pins, resume, pace, usageProfile,
                  usageRatesFormat, usageHistory (the History tab's step path, ticks and figures), panelCollapse, surface, walkChart (the headroom
                  chart's geometry), walkRows (the same walk as day rows), holds,
                  webNotify, backClose, stopControl, triage (the board/triage piles), answerToken (the token store + authHeaders),
                  stickyStrip, agentLabel (a subagent's type only when informative),
                  tasks (taskProgress — the one count the row pill and the Tasks card share),
                  gitLayouts / gitLevels / gitLinks / gitStatsText (the Git sub-view's switcher rules,
                  the problems → levels rule and session join, the compare link, the copy table), gitBar (the divergence bar's scale),
                  codegraphLayouts / codegraphLevels / codegraphText / codegraphPoll (the CodeGraph sub-view's switcher rules, the problems → levels rule,
                  the copy table, its poll schedule and run notes),
                  gitPoll (its poll schedule, apart from the DOM), gitClock (the fetch clock's meters,
                  re-poll timing and Fetch all key state), gitQuick (the Sync menu's rules and result copy), gitSync / gitSyncRuns
                  (the Sync button's rules, copy and run reconciler), projectsView (the
                  Projects sub-view's layouts, pinned / offered split, dir line and copy), releases (the
                  unseen dot's localStorage key; the chip and drawer logic are ui-kit's)
vite.config.ts    dev proxy /api → backend; reuses the server config loader;
                  allowedHosts = `.ts.net` + this node's bare MagicDNS short
                  name (probed via `tailscale status --json`), without which
                  the short-name tailnet URL 403s (subsystems/remote-access.md), plus
                  `ALLOWED_HOSTS` (`*` turns the check off), matching lib/request-guard.ts
test/             node-assert tests over backend + client domain logic
  visual/         the Playwright suite behind `pnpm test:visual` (config in playwright.config.ts at the
                  root): mocked API, screenshots, overflow and contrast (subsystems/visual-tests.md)
.github/workflows/  ci.yml (the PR gate) and release.yml (tags and publishes each release) — workflows/ci.md
scripts/          install-hooks.sh (`pnpm hooks:install`), ask-remote-hook.sh,
                  plan-remote-hook.sh, permission-notify-hook.sh,
                  remote-decision-hook.sh, stop-notify-hook.sh,
                  kill-guard-hook.sh (refuses broad pkill/killall — see
                  workflows/hooks-setup.md), host-credentials.sh,
                  lan-ip.sh, env-value.ts (the one .env reader the installer and
                  the server share — never a second grep),
                  tailnet.ts (`pnpm tailnet`, also `pnpm tunnel`, plus
                  `pnpm tailnet:local` = the same with `--http` preapplied) —
                  registers a `tailscale serve` onto this node, HTTPS/443 by
                  default or `--http` at the matching port, always fronting WEB_PORT as
                  loadConfig reports it; holds no port literal of its own
                  (subsystems/remote-access.md),
                  sync-plugin.ts (`pnpm plugin:sync`) — fetches origin and fast-forwards
                  a clean main that is behind *before* comparing, then reinstalls the
                  plugin from GitHub's main when plugin/ differs from the installed copy;
                  refuses a tree that is off main, dirty, unpushed or can't fast-forward;
                  after a reinstall POSTs `/api/schedules/reconcile` to a running server,
                  gen-plugin-lib.ts (`pnpm plugin:gen`) — transpiles shared/{cron,frontmatter,
                  schedule-file}.ts into plugin/lib/*.mjs; test/plugin-manifest.test.ts
                  regenerates and compares,
                  session-analytics.ts (`pnpm session-analytics`) — prints one
                  session's SessionAnalysis as JSON without the server running,
                  which is how `/kaizen` gets exact numbers,
                  probe-usage-split.ts (`pnpm probe:usage-split`) — runs both
                  joint rate fits against this machine's real logs, gated
                  exactly as the endpoint gates them; `--weekly` adds the weekly
                  window: sample coverage, every window boundary observed with
                  the gap between them, the weekly interval tally and rates,
                  check-token-weights.ts (`pnpm check:weights`) — re-measures the
                  cache-write TTL mix behind TYPE_WEIGHTS, exits 1 when it drifts
                  rates-audit.ts (`pnpm check:ledger`, `pnpm audit:rates -- <sub>`) —
                  re-derives the Token-value inputs from transcripts: `ledger`
                  exits 1 when the ledger misses ±5% of a day's spend, and
                  `surfaces` / `modifiers` / `offbook` / `gap` report; pipeline in lib/transcript-audit.ts
.claude-plugin/marketplace.json  the repo as a plugin marketplace — one plugin, sourced from plugin/
plugin/           the installable Claude Code plugin (`/plugin install`, README §Install the skills);
                  plain JS skills, never imported by server/ or client/ at runtime
  .claude-plugin/plugin.json  name + version
  lib/            generated `.mjs` copies of the shared schedule modules, for plain-`node` use
                  (never `bin/`: Claude Code puts that on every session's PATH)
  skills/git-sync/  repo chores across machines; engine tools/git-sync.mjs, own `node --test`
                  suite run by `pnpm test:skills` (~4 min, 2026-10-01)
  skills/kaizen/  session post-mortem; analyzer kaizen.mjs, own `node --test` suite run
                  inside `pnpm test`; its log line grammar is a contract with Analytics
                  (docs/subsystems/analytics.md)
```

## Map

Every subsystem and workflow doc, one line each — read the relevant one before changing
that area:

- [sessions](subsystems/sessions.md) — session rows, the status machine, subagent detail
- [chat](subsystems/chat.md) — the chat drawer + byte-offset transcript tail
- [remote-answer](subsystems/remote-answer.md) — answering `AskUserQuestion` remotely (the first session write path)
- [remote-plan](subsystems/remote-plan.md) — sending an `ExitPlanMode` plan back for revision (reject-only, by upstream design)
- [remote-message](subsystems/remote-message.md) — replying into a finished, away-from-keyboard turn (the third session write path)
- [dictation](subsystems/dictation.md) — the reply composer's mic: local whisper transcription, never auto-sent
- [spawn](subsystems/spawn.md) — starting a new headless session from the dashboard (the fourth session write path, and the first one it initiates), and stopping one from its row
- [session-surfaces](subsystems/session-surfaces.md) — where a session lives, and where you can continue it (also where `Session.surface` is specified)
- [remote-access](subsystems/remote-access.md) — the ways in + the origin badge
- [configs](subsystems/configs.md) — read-only config browser
- [git-stats](subsystems/git-stats.md) — `GET /api/git-stats`: read-only local git state of each pinned project — unmerged branches, ahead/behind the trunk, the merged proof, and the watched-only background fetch
- [analytics](subsystems/analytics.md) — kaizen-fed session post-mortems
- [account-header](subsystems/account-header.md) — the shell's account chip: its two homes, the `oauthAccount` profile reader, and `GET /api/account`
- [usage-limits](subsystems/usage-limits.md) — the rate-limit gauges the account chip draws, and the Usage tab behind them: pace, the duty-cycle forecast, and token value per model
- [hub-widgets](subsystems/hub-widgets.md) — `/api/hub/widgets`: the three Lookout tiles, served through the `lookout-widgets` package, and its pinned dependency exception
- [releases](subsystems/releases.md) — the rail's version chip and the What's new drawer, read from the local release tags at `GET /api/releases`
- [settings](subsystems/settings.md) — the Settings tab: themes, refresh rate, scan knobs, idle threshold, answer window, push policy
- [view-persistence](subsystems/view-persistence.md) — toolbar state in localStorage
- [permission-notify](subsystems/permission-notify.md) — the `Allow?` tab for terminal permission dialogs
- [push-notify](subsystems/push-notify.md) — server-sent ntfy pushes: the layered policy, and the one narrow browser layer that came back for headless sessions
- [breakpoints](subsystems/breakpoints.md) — the seven-tier mobile-first ladder in `styles.css`, the rail+measure lock, and the capped/full content-width matrix
- [codegraph](subsystems/codegraph.md) — `GET /api/codegraph`, `POST /api/codegraph/run`: the `codegraph` CLI's index state per pinned project — a status cache, Sync and Reindex runs, the lock-loss rule, and the levels the Management › CodeGraph layouts draw
- [schedules](subsystems/schedules.md) — Management › Schedules: job files in a git-synced folder, installed as launchd / cron jobs by reconcile, run by `plugin/lib/run-schedule.mjs`, the run log, the owning server and `schedule-failed` pushes
- [visual-tests](subsystems/visual-tests.md) — `pnpm test:visual`: Playwright screenshots of every view against fixture data, overflow and daylight contrast, macOS only
- [configuration](workflows/configuration.md) — the `.env` / hook-side variable reference
- [ci](workflows/ci.md) — the PR gate: `ci / checks`, `ci / pr-title`, `ci / skills` from release-kit's reusable workflow, and the `main-pr-only` ruleset
- [docker](workflows/docker.md) — running in containers, dev + prod
- [hooks-setup](workflows/hooks-setup.md) — `pnpm hooks:install`: all six hooks (seven `settings.json` entries — permission-notify registers twice), one command
- [remote-answer-setup](workflows/remote-answer-setup.md) — per-machine hook install
- [push-notify-setup](workflows/push-notify-setup.md) — ntfy topic, phone subscription, Stop hook
- [dictation-setup](workflows/dictation-setup.md) — installing whisper.cpp and a model, and the HTTPS tunnel phone use needs

<!-- docs-sync:
  sources:
    - shared/types.ts
    - shared/gitUpstream.ts
    - server/index.ts
    - server/api.ts
    - server/lib/
    - client/src/
    - vite.config.ts
    - package.json
  kind: overview
  verified: 142439e51a92c5c5faebaf0c867bc5a36fef7c57
-->
