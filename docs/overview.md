---
docs-sync:
  sources:
    - shared/types.ts
    - server/index.ts
    - server/api.ts
    - server/lib/
    - client/src/
    - vite.config.ts
    - package.json
  kind: overview
---

# Architecture overview

A **monolith split into three domains**: a Node backend (`server/`), a Vite + React +
TypeScript frontend (`client/`), and the shared API contract (`shared/`). One repo, one
deploy. The **only** thing crossing the frontend/backend boundary is the typed JSON
payloads defined in `shared/types.ts` — when adding an API field, edit that file first,
then the server producer, then the client consumer.

Everything the dashboard shows is read straight off disk from
`~/.claude/projects/*/*.jsonl` (the transcripts Claude Code already writes). Monitoring
needs no daemon, no hooks, and no config in Claude Code — only the optional
[remote answers](../features/remote-answers.md) feature installs a hook.

## Data flow

1. The client polls `GET /api/sessions` every 3 seconds.
2. `server/lib/scan.ts` enumerates transcripts across `~/.claude/projects`, ranks them by
   recency, and calls `server/lib/transcript.ts` to tail-read the last 256 KB of each —
   enough to derive tokens, model, context window, current activity, and status.
3. Detail views fetch lazily: subagents (`/api/sessions/:id`), chat pages
   (`/api/sessions/:id/chat`), management config, analytics reports.

No database, no cache layer beyond in-memory maps, no build step for the server (it runs
via `tsx`, dev and prod alike).

## Principles

- **Read-only charter.** The app never writes to `~/.claude` or the transcripts. The two
  deliberate exceptions are documented in
  [remote answers](../features/remote-answers.md): the answer POST endpoints (RAM-only
  store) and the gitignored `.remote-answer.json` toggle file.
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
| `GET /api/sessions` | the 3s snapshot: sessions + totals + usage bars |
| `GET /api/sessions/:id` | one session's subagent timeline |
| `GET /api/sessions/:id/chat` | paged chat history (byte-offset cursors) |
| `GET /api/sessions/:id/question` | pending remote question, if any |
| `POST /api/sessions/:id/answer` | deliver a remote answer (write path) |
| `POST /api/questions/wait` | the hook's held-open wait (write path) |
| `POST /api/remote-answer` | flip the remote-answer toggle (write path) |
| `GET /api/health` | liveness + remote-answer state + connection origin |
| `GET /api/management`, `/project`, `/file` | config browser index / scope / file body |
| `GET /api/analytics` | `/kaizen` post-mortem reports |
| anything else | static files from `client/dist` (production only) |

⚠️ Route order in `index.ts` is load-bearing: the `:id` detail regex would swallow
`/api/sessions/:id/chat|question|answer`, so those matches sit above it.

## Dev vs prod

- **Dev** (`pnpm dev`): Vite serves the page on `WEB_PORT` (default 5173) with HMR and
  proxies `/api` to the Node server on `PORT` (default 4173). The proxy sets `xfwd`, so
  the origin badge still sees the real client address.
- **Prod** (`pnpm build` + `pnpm start`): the Node server static-serves `client/dist` and
  answers the API on `PORT`, auto-opening the browser.

Both servers bind all interfaces, so LAN/tailnet access works with zero app config — see
[remote access](../features/remote-access.md).

## Repo layout

```
shared/types.ts   the API contract (SessionsResponse, Session, ManagementIndex,
                  SessionAnalysis, AnalyticsReport, …)
server/
  index.ts        HTTP entry + routing; static-serves client/dist in prod
  api.ts          all /api handlers (+ error fallbacks)
  lib/config.ts   .env loader — process.env > .env > defaults
  lib/transcript.ts  tail-reads a transcript → tokens/model/window/activity
  lib/scan.ts     enumerates + ranks sessions; status machine; liveness gate
  lib/agents.ts   whole-file subagent parser → AgentJob[]
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts
  lib/chat.ts     byte-offset paged chat history
  lib/usage.ts    account 5h/weekly limits from Anthropic (OAuth)
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser
  lib/management.ts   config scanner + servable-path security set
  lib/analyze.ts  whole-session post-mortem → SessionAnalysis
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md
  lib/analytics.ts  reader for the Analytics tab
  lib/pending.ts  in-memory pending-question store (the only write path)
  lib/remoteState.ts  remote-answer switch (env gate + persisted toggle)
  lib/origin.ts   connection classifier → local | lan | tailnet | public
client/src/
  App.tsx         section tabs (Sessions | Management | Analytics), lazy views
  components/     Header, Toolbar, SessionList/Row, ChatDrawer, QuestionPanel,
                  RemoteAnswerToggle, OriginBadge, Markdown, management/, analytics/
  hooks/          useSessions (3s poll), useSessionChat, useManagement, useAnalytics,
                  usePendingQuestion, useRemoteAnswer, usePersistedState
  lib/            filterSort, chatFilter, markdown, managementEntries, format
vite.config.ts    dev proxy /api → backend; reuses the server config loader
test/             node-assert tests over backend + client domain logic
scripts/          ask-remote-hook.sh, host-credentials.sh, lan-ip.sh
```

## Contributor deep dives

Per-domain invariants and gotchas live in `.claude/rules/` — read the relevant one before
changing that area: [session-status](../../.claude/rules/session-status.md),
[chat-tail](../../.claude/rules/chat-tail.md),
[management](../../.claude/rules/management.md),
[analytics](../../.claude/rules/analytics.md),
[remote-answer](../../.claude/rules/remote-answer.md),
[remote-access](../../.claude/rules/remote-access.md),
[usage-limits](../../.claude/rules/usage-limits.md),
[view-persistence](../../.claude/rules/view-persistence.md).
