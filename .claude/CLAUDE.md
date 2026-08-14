# Claude Agents Dashboard

Live monitor for parallel Claude Code sessions. Reads `~/.claude/projects/*/*.jsonl`
transcripts off disk (no daemon, no hooks) and shows, per session: project, git branch,
model, context usage, and current tool activity. Polls every 3s.

## Architecture

Monolith split into three domains. The **only** thing crossing the FE/BE boundary is the
typed JSON payloads in `shared/types.ts` (`GET /api/sessions*`, `GET /api/management*`).

```
shared/types.ts   API contract (SessionsResponse, Session, ManagementIndex, ScopeConfig,
                  SessionAnalysis, AnalyticsReport…).
server/           Node backend, TypeScript, run via tsx (no compile step)
  index.ts        HTTP entry: routes /api/sessions(+/:id/chat) + /api/management + /api/analytics; static-serves client/dist in prod
  api.ts          the /api/sessions + /api/management + /api/analytics handlers (+ error fallbacks)
  lib/config.ts   .env loader — precedence process.env > .env > defaults
  lib/transcript.ts  tail-reads last 256KB of a transcript → tokens/model/window/activity
  lib/scan.ts     enumerates + ranks sessions across ~/.claude/projects
  lib/agents.ts   whole-file subagent parser: pure event parser + reducer → AgentJob[]
                  (tokens/toolUses/duration from toolUseResult + notification <usage> blocks)
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts, used only by the
                  on-demand GET /api/sessions/:id (see docs/ideas/agent-tracking-cache.md)
  lib/chat.ts     byte-offset paged chat history for GET /api/sessions/:id/chat — tail /
                  ?after= (live) / ?before= (older) (see .claude/rules/chat-tail.md)
  lib/usage.ts    fetches account 5h/weekly limits from Anthropic (see .claude/rules/usage-limits.md)
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser (key:value + >/| scalars, fail-open)
  lib/management.ts   config scanner: global/project ScopeConfig, plugins, recent projects,
                  servable-path security set (see .claude/rules/management.md)
  lib/analyze.ts  whole-file session post-mortem → SessionAnalysis (the /kaizen analyzer; pure)
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md → lesson / status /
                  review-marker lines per session (append-only grammar; fail-open)
  lib/analytics.ts  read-only reader: last N /kaizen-logged sessions, each re-analyzed live
                  (see .claude/rules/analytics.md)
  lib/pending.ts  in-memory pending-AskUserQuestion store + state machine — the ONLY write
                  path in the app (see .claude/rules/remote-answer.md)
  lib/remoteState.ts  remote-answer switch: REMOTE_ANSWER env gate + UI toggle persisted to
                  gitignored .remote-answer.json (the app's only disk write; fails open)
  lib/origin.ts   pure connection classifier → local | lan | tailnet | unknown, on
                  /api/health for the toolbar badge (see .claude/rules/remote-access.md)
client/           Vite + React + TypeScript frontend
  src/App.tsx     section tabs (Sessions | Management | Analytics), lazy-loads Management/Analytics views
  components/SessionsView.tsx  the original live monitor (owns the 3s poll + chat drawer state)
  components/{Header,SessionList,SessionRow,Toolbar,SectionTabs}
  components/ChatDrawer.tsx    full-height chat-history drawer (own lazy chunk;
                  hooks/useSessionChat — see .claude/rules/chat-tail.md)
  components/Markdown.tsx + lib/markdown.ts  zero-dep markdown-subset parser + renderer
                  for message text (no dangerouslySetInnerHTML; pure, unit-tested)
  lib/chatFilter.ts            drawer all/text/you message filter (pure; persisted)
  components/QuestionPanel.tsx pinned action bar to answer a session's AskUserQuestion
                  (hooks/usePendingQuestion — see .claude/rules/remote-answer.md)
  components/RemoteAnswerToggle.tsx  toolbar pill for the remote-answer switch
                  (fed by hooks/useRemoteAnswer, which the Toolbar owns)
  components/OriginBadge.tsx   toolbar pill: how this browser reached the dashboard
                  (reads `origin` off the same /api/health poll; display-only)
  components/management/       three-pane management UI (ScopeMenu, ItemList, DetailPane, FileViewer)
  components/analytics/AnalyticsView.tsx  the report-card list (own lazy chunk; read-only)
  hooks/useSessions, hooks/useManagement, hooks/useAnalytics, lib/format, lib/managementEntries
  hooks/usePersistedState.ts  localStorage-backed useState (see .claude/rules/view-persistence.md)
vite.config.ts    dev proxy /api → backend; reuses server loadConfig() for the port
test/             node-assert tests over backend domain logic, tmpdir JSONL fixtures
```

## Commands

- `pnpm dev` — API + Vite together. Open http://localhost:5173 (HMR, proxies /api).
- `pnpm build` — bundles client → `client/dist`.
- `pnpm start` — prod: serves built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `pnpm test` — runs `test/run-all.ts` via tsx (220 cases).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm tunnel` — optional: `tailscale serve --bg 4173`, fronts prod over HTTPS on the
  tailnet (see `.claude/rules/remote-access.md`). Not needed for plain tailnet access.

**Phone access:** both servers bind all interfaces (`server.host: true` in `vite.config.ts`;
`server/index.ts` likewise), so **every route works with zero app config** and none is
required — localhost, LAN (the `Network:` URL Vite prints), **Tailscale** (recommended for
away-from-home: a stable MagicDNS hostname `http://<host>.<tailnet>.ts.net:4173`, device
identity as the auth, nothing public), or any other tunnel (ngrok/Cloudflare/`ssh -L` — but
a public URL exposes every read endpoint). Optional `pnpm tunnel` fronts prod over HTTPS on
443. The toolbar's origin badge says which route the current browser came in on. See
`.claude/rules/remote-access.md`.

## Deep-dive rules

Detailed per-domain docs live in `.claude/rules/` and are **NOT auto-loaded** — read the
relevant one when a task touches that area:

- `.claude/rules/session-status.md` — the left-dot status machine (`scan.ts`/`transcript.ts`:
  the `recent`×`turnComplete` 2×2, `question` override, `lsof` process-liveness gate, Docker
  `skipProcScan`, empty-session filter).
- `.claude/rules/usage-limits.md` — header 5h/Week bars (`lib/usage.ts`: OAuth `/usage`
  endpoint, keychain token, sync cache + background refresh, fail-open, `SHOW_USAGE`,
  `usageStatus`).
- `.claude/rules/management.md` — Management tab config browser (`lib/management.ts`: global +
  plugin + project scopes, the ⚠️ file-endpoint security invariant).
- `.claude/rules/analytics.md` — Analytics tab session post-mortems (`lib/analytics.ts` +
  `lib/sessionAnalyticsLog.ts`; `/kaizen` is the sole producer; read-only invariant). The
  `/kaizen` skill is **vendored** at `.claude/skills/kaizen/` so collaborators can populate
  the tab (each user's own global log); keep it in lockstep with the log format above.
- `.claude/rules/view-persistence.md` — Toolbar filter/sort localStorage persistence
  (`hooks/usePersistedState.ts`, fail-open shallow-merge).
- `.claude/rules/chat-tail.md` — the chat-history drawer (`lib/chat.ts` byte-offset paging,
  what's filtered out of a transcript, the all/text/you view filter, the markdown subset
  renderer, the `/api/sessions/:id/chat` route-order gotcha).
- `.claude/rules/remote-answer.md` — answering a session's `AskUserQuestion` from the drawer
  (`lib/pending.ts` state machine, the held-request protocol, why deny-with-reason is the only
  injection mechanism, the **three gates** env/toggle/keyboard-idle that decide terminal vs
  phone, the ⚠️ route-order / hook-timeout / token traps, and the two deliberate charter
  exceptions: the write endpoints and `.remote-answer.json`).
- `.claude/rules/remote-access.md` — the ways in (localhost / LAN / Tailscale / other
  tunnels, all optional, all zero-config) and the **origin badge** (`lib/origin.ts`: the
  ⚠️ tailnet-before-ULA ordering, the XFF-only-from-loopback rule that makes `pnpm tunnel`
  work, the `xfwd: true` dev-proxy dependency, display-only invariant).

## Conventions / gotchas

- **ESM everywhere** (`"type": "module"`). Server imports use `.js` suffix (resolves to `.ts`
  under Bundler resolution + tsx). Cross-boundary imports use `import type` — no runtime coupling.
- **Server runs via `tsx`, not compiled.** Both dev and prod. No `dist/` for the server.
- **Dev vs prod page:** in dev, Vite serves the HTML; the Node server answers API only. In prod
  (`NODE_ENV=production`), the Node server static-serves `client/dist` and auto-opens the browser.
- **Adding an API field:** edit `shared/types.ts` first, then `scan.ts` (producer) and the client
  consumer — the type is the single source of truth for the contract.
- **UI is a faithful port of the original inline `renderPage()`.** CSS in `client/src/styles.css`
  is verbatim; keep class names stable so styling holds. React auto-escapes (no `esc()`).
- Backend is zero-runtime-dep by design (only Node built-ins). Keep new deps out of `server/`.
- `client/dist/` and `.env` are gitignored.
- **Subagents return terse findings, not prose.** When spawning Explore/Plan/Task
  subagents, instruct them to answer with compact `file:line` tables + short conclusions —
  not narrative reports. Verbose subagent output replays through the parent context every
  turn (dominates cacheRead), so terseness is the cheapest big token win. For pure
  locate-code work prefer the `caveman:cavecrew-investigator` agent (output is already
  ~60% smaller than vanilla `Explore`). Also cap subagent output at **~15 lines and forbid a
  closing recap/summary section** — the terse `file:line` table *is* the answer, so a restated
  summary just doubles the payload replayed into parent context. Surfaced by the global
  `/kaizen` skill — see `~/.claude/session-analytics-log.md`.
