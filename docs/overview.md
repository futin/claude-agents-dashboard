# Architecture overview

A **monolith split into three domains**: a Node backend (`server/`), a Vite + React +
TypeScript frontend (`client/`), and the shared API contract (`shared/`). One repo, one
deploy. The **only** thing crossing the frontend/backend boundary is the typed JSON
payloads defined in `shared/types.ts` — when adding an API field, edit that file first,
then the server producer, then the client consumer.

Everything the dashboard shows is read straight off disk from
`~/.claude/projects/*/*.jsonl` (the transcripts Claude Code already writes). Monitoring
needs no daemon, no hooks, and no config in Claude Code — hooks are installed only by the
opt-in features that need one ([remote answers](subsystems/remote-answer.md),
[remote plan verdicts](subsystems/remote-plan.md), the
[`allow?` tab](subsystems/permission-notify.md), and the `Stop` hook that backs both the
finished-turn [push](subsystems/push-notify.md) and
[remote messages](subsystems/remote-message.md)).

## Data flow

1. The client polls `GET /api/sessions` every 3 seconds (the Settings tab retunes this, and
   attaches the row count and time windows as query params).
2. `server/lib/scan.ts` enumerates transcripts across `~/.claude/projects`, ranks them by
   recency, and calls `server/lib/transcript.ts` to tail-read the last 256 KB of each —
   enough to derive tokens, model, context window, current activity, and status.
3. Detail views fetch lazily: subagents (`/api/sessions/:id`), chat pages
   (`/api/sessions/:id/chat`), management config, analytics reports.

No database, no cache layer beyond in-memory maps, no build step for the server (it runs
via `tsx`, dev and prod alike).

## Principles

- **Read-only charter.** The app never writes to `~/.claude` or the transcripts. The
  deliberate exceptions are the answer POST endpoints (RAM-only stores); two gitignored,
  repo-local files, `.remote-answer.json` (see [remote answers](subsystems/remote-answer.md))
  and `.dashboard-settings.json` (see [settings](subsystems/settings.md)); and, going
  further than any of those, [spawning a new `claude -p` process](subsystems/spawn.md) on
  this machine — off by default (empty `CLAUDE_BIN`), and the one exception that reaches
  outside the dashboard's own state, since what it writes is a whole new session's
  transcript rather than a row in a RAM-only store. Where such a session can be
  continued afterwards — phone app, terminal resume, and the surfaces that will
  never show it — is mapped in [session surfaces](subsystems/session-surfaces.md),
  which is also where `Session.surface` (the row's `dashboard` pill) is specified.
- **Zero runtime dependencies on the backend.** `server/` uses Node built-ins only. Keep
  new npm deps out of it.
- **Fail-open everywhere.** A missing token, an unreadable file, a failed probe — every
  auxiliary feature degrades to "not shown" rather than crashing the monitor.
- **Path safety.** Endpoints never join request input into filesystem paths. IDs are
  validated and resolved against enumerated sets (`listTranscripts`,
  `collectServablePaths`); anything else is a 400/404.

## HTTP surface

All routes live in `server/index.ts` (dispatch) and `server/api.ts` (handlers):

| Route | Purpose |
|---|---|
| `GET /api/sessions` | the poll snapshot: sessions + totals + usage bars (`?limit=&lookback=&active=` override the scan) |
| `GET /api/sessions/:id` | one session's subagent timeline |
| `GET /api/sessions/:id/chat` | paged chat history (byte-offset cursors) |
| `GET /api/sessions/:id/question` | pending remote question, if any |
| `POST /api/sessions/:id/answer` | deliver a remote answer (write path) |
| `POST /api/questions/wait` | the hook's held-open wait (write path) |
| `GET /api/sessions/:id/plan` | pending proposed plan, if any |
| `POST /api/sessions/:id/plan-answer` | send a plan back for revision (write path) |
| `POST /api/plans/wait` | the plan hook's held-open wait (write path) |
| `GET /api/sessions/:id/message` | pending reply window, if any |
| `POST /api/sessions/:id/message-answer` | send free text into a finished turn, or let it stop (write path) |
| `POST /api/messages/wait` | the Stop hook's held-open wait, away only — except headless sessions, which hold at the desk too (write path) |
| `POST /api/transcribe` | a recorded clip in, transcribed text out — feeds the reply composer's mic (write path) |
| `POST /api/spawn` | start a new headless `claude -p` session in a recent project, or `resume` an ended `dashboard` one by id (write path, the one the dashboard initiates rather than answers) |
| `POST /api/spawn/:id/stop` | SIGTERM a still-launching session's child (write path) |
| `POST /api/permissions/notify` | "a permission dialog is open" flag (display-only) |
| `POST /api/notify/event` | the Stop hook's push trigger — the other three events notify from the endpoint they already POST to |
| `POST /api/notify/test` | fire one push regardless of policy and report what ntfy said |
| `POST /api/remote-answer` | flip the remote-answer toggle (write path) |
| `GET /api/health` | liveness + remote-answer state + connection origin + the two hook numbers (idle threshold, answer window) |
| `GET /api/settings`, `POST /api/settings` | the non-per-device settings — idle threshold, answer window, push policy, usage-history recording, plus `notifyAvailable` (never the ntfy topic itself); write path |
| `GET /api/management`, `/project`, `/file` | config browser index / scope / file body |
| `GET /api/analytics` | `/kaizen` post-mortem reports |
| `GET /api/usage/profile` | the duty-cycle profile behind the weekly projection — cells + the forward walk, never raw samples or file paths |
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

⚠️ Route order in `index.ts` is load-bearing: the `:id` detail regex would swallow
`/api/sessions/:id/chat|question|answer|plan|plan-answer|message|message-answer`, so all of
those matches sit above it.

⚠️ Every `:id` route decodes its segment through `decodePath` in `index.ts`, never
`decodeURIComponent` directly. A malformed escape (a lone `%ZZ`) throws a `URIError`
*synchronously* inside the request listener — before any handler, before even `tokenOk` — so
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
server/
  index.ts        HTTP entry + routing; static-serves client/dist in prod
  api.ts          all /api handlers (+ error fallbacks)
  lib/config.ts   .env loader — process.env > .env > defaults
  lib/transcript.ts  tail-reads a transcript → tokens/model/window/activity
  lib/title-cache.ts  remembers a custom title once it sinks below the tail window
  lib/scan.ts     enumerates + ranks sessions; status machine; liveness gate
  lib/agents.ts   whole-file subagent parser → AgentJob[]
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts
  lib/chat.ts     byte-offset paged chat history
  lib/usage.ts    account 5h/weekly limits from Anthropic (OAuth)
  lib/usage-pace.ts  utilization sample ring → burn rate + projected 100% per window
  lib/usage-forecast.ts  forward walk over hour-of-week weights → projected 100%
  lib/usage-history.ts  persisted samples → the learned 168-bucket duty-cycle profile
  lib/usage-ledger.ts  per-minute per-model token ledger: reads new transcript bytes,
                  appends one line a tick (`.usage-ledger.jsonl`) — tokens and
                  request counts per model, counts absent on pre-upgrade lines
  lib/usage-rate.ts  joins history × ledger into classified intervals → tokens per 1%
                  of the 5h window per model, baseline vs trailing, drift verdicts,
                  plus the two-term (tokens + requests) split fit and its refusals
  lib/token-refresh.ts  makes the CLI renew an expired OAuth token (auth status,
                  then one haiku turn) so the bars self-heal
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser
  lib/management.ts   config scanner + servable-path security set
  lib/analyze.ts  whole-session post-mortem → SessionAnalysis
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md
  lib/analytics.ts  reader for the Analytics tab
  lib/pending.ts  in-memory pending-question store (the first of the four write paths)
  lib/plans.ts    in-memory pending-plan store (same machine, reject-only verdicts)
  lib/messages.ts in-memory turn-end reply-window store (same machine, plus a 5s
                  idle sweep that auto-releases every terminal-backed hold — headless
                  ones are exempt)
  lib/idle.ts     the shared `backAtDesk()` policy behind all three stores' 5s sweeps —
                  threshold, ioreg reading, test seam, fail directions
  lib/remoteState.ts  remote-answer switch (env gate + persisted toggle)
  lib/settings.ts persisted idle threshold, answer window, push policy + the
                  usage-recording switch
  lib/notify.ts   server-sent ntfy pushes — the layered policy and the one
                  outbound call the backend makes
  lib/origin.ts   connection classifier → local | lan | tailnet | unknown
  lib/permissions.ts  in-memory "a permission dialog is open in that terminal" flags,
                  fed by the PermissionRequest hook; display-only
  lib/transcribe.ts  ffmpeg → whisper-cli pipeline behind POST /api/transcribe: mime
                  allowlist, cached engine probe, single-flight guard, typed failures
  lib/spawn.ts    launches a detached, headless `claude -p` session, or resumes an ended
                  one — the fourth write path, and the first the dashboard initiates
                  (see docs/subsystems/spawn.md)
client/src/
  App.tsx         shell: side rail (Sessions | Management | Analytics | Usage |
                  Settings) + lazy views
  components/     Header, Toolbar, SessionList/Row, ChatDrawer, QuestionPanel, PlanPanel,
                  MessagePanel, PanelChrome (the head/stub the three panels share),
                  MicButton, SpawnPanel, ResumePanel, PermissionBanner,
                  RemoteAnswerToggle, OriginBadge, Markdown, management/, analytics/,
                  usage/, settings/
  hooks/          useSessions (the main poll), useSessionChat, useManagement, useAnalytics,
                  useUsageProfile, useUsageRates, usePendingQuestion, usePendingPlan,
                  usePendingMessage, useRemoteAnswer, useSpawn, usePersistedState,
                  useSettings, useServerSettings, useDictation, useTranscribeAvailable
  lib/            filterSort, chatFilter, markdown, managementEntries, format, settings,
                  sections, deepLink, dictation, spawnOptions, resume, pace, usageProfile,
                  usageRatesFormat, panelCollapse, surface, walkChart
vite.config.ts    dev proxy /api → backend; reuses the server config loader
test/             node-assert tests over backend + client domain logic
scripts/          install-hooks.sh (`pnpm hooks:install`), ask-remote-hook.sh,
                  plan-remote-hook.sh, permission-notify-hook.sh,
                  remote-decision-hook.sh, stop-notify-hook.sh, host-credentials.sh,
                  lan-ip.sh, env-value.ts (the one .env reader the installer and
                  the server share — never a second grep),
                  probe-usage-split.ts (`pnpm probe:usage-split`) — runs the
                  two-term rate fit against this machine's real logs,
                  check-token-weights.ts (`pnpm check:weights`) — re-measures the
                  cache-write TTL mix behind TYPE_WEIGHTS, exits 1 when it drifts
```

## Map

Every subsystem and workflow doc, one line each — read the relevant one before changing
that area:

- [sessions](subsystems/sessions.md) — session rows, the status machine, subagent detail
- [chat](subsystems/chat.md) — the chat drawer + byte-offset transcript tail
- [remote-answer](subsystems/remote-answer.md) — answering `AskUserQuestion` remotely (the first write path)
- [remote-plan](subsystems/remote-plan.md) — sending an `ExitPlanMode` plan back for revision (reject-only, by upstream design)
- [remote-message](subsystems/remote-message.md) — replying into a finished, away-from-keyboard turn (the third write path)
- [dictation](subsystems/dictation.md) — the reply composer's mic: local whisper transcription, never auto-sent
- [spawn](subsystems/spawn.md) — starting a new headless session from the dashboard (the fourth write path, and the first one it initiates)
- [remote-access](subsystems/remote-access.md) — the ways in + the origin badge
- [management](subsystems/management.md) — read-only config browser
- [analytics](subsystems/analytics.md) — kaizen-fed session post-mortems
- [usage-limits](subsystems/usage-limits.md) — header account usage bars
- [settings](subsystems/settings.md) — the Settings tab: themes, refresh rate, scan knobs, idle threshold, answer window, push policy
- [view-persistence](subsystems/view-persistence.md) — toolbar state in localStorage
- [permission-notify](subsystems/permission-notify.md) — the `allow?` tab for terminal permission dialogs
- [push-notify](subsystems/push-notify.md) — server-sent ntfy pushes: the layered policy, and why they replaced browser alerts outright
- [configuration](workflows/configuration.md) — the `.env` / hook-side variable reference
- [docker](workflows/docker.md) — running in containers, dev + prod
- [hooks-setup](workflows/hooks-setup.md) — `pnpm hooks:install`: all five hooks, one command
- [remote-answer-setup](workflows/remote-answer-setup.md) — per-machine hook install
- [push-notify-setup](workflows/push-notify-setup.md) — ntfy topic, phone subscription, Stop hook
- [dictation-setup](workflows/dictation-setup.md) — installing whisper.cpp and a model, and the HTTPS tunnel phone use needs

<!-- docs-sync:
  sources:
    - shared/types.ts
    - server/index.ts
    - server/api.ts
    - server/lib/
    - client/src/
    - vite.config.ts
    - package.json
  kind: overview
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
