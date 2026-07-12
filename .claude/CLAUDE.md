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
  index.ts        HTTP entry: routes /api/sessions + /api/management + /api/analytics; static-serves client/dist in prod
  api.ts          the /api/sessions + /api/management + /api/analytics handlers (+ error fallbacks)
  lib/config.ts   .env loader — precedence process.env > .env > defaults
  lib/transcript.ts  tail-reads last 256KB of a transcript → tokens/model/window/activity
  lib/scan.ts     enumerates + ranks sessions across ~/.claude/projects
  lib/agents.ts   whole-file subagent parser: pure event parser + reducer → AgentJob[]
                  (tokens/toolUses/duration from toolUseResult + notification <usage> blocks)
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts, used only by the
                  on-demand GET /api/sessions/:id (see docs/ideas/agent-tracking-cache.md)
  lib/usage.ts    fetches account 5h/weekly limits from Anthropic (see .claude/rules/usage-limits.md)
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser (key:value + >/| scalars, fail-open)
  lib/management.ts   config scanner: global/project ScopeConfig, plugins, recent projects,
                  servable-path security set (see .claude/rules/management.md)
  lib/analyze.ts  whole-file session post-mortem → SessionAnalysis (the /kaizen analyzer; pure)
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md → lesson per session (fail-open)
  lib/analytics.ts  read-only reader: last N /kaizen-logged sessions, each re-analyzed live
                  (see .claude/rules/analytics.md)
client/           Vite + React + TypeScript frontend
  src/App.tsx     section tabs (Sessions | Management | Analytics), lazy-loads Management/Analytics views
  components/SessionsView.tsx  the original live monitor (owns the 3s poll)
  components/{Header,SessionList,SessionRow,Toolbar,SectionTabs}
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
- `pnpm test` — runs `test/run-all.ts` via tsx (114 cases).
- `pnpm typecheck` — `tsc --noEmit`.

**Phone access on the same wifi:** the Vite dev server binds all interfaces
(`server.host: true` in `vite.config.ts`), so no tunnel is needed — just open
the `Network:` URL Vite prints (e.g. `http://192.168.x.x:5173`) on a phone
connected to the same wifi as the host machine. The backend (`server/index.ts`)
already binds all interfaces by default, so `pnpm start` (prod, port 4173) is
LAN-reachable the same way with no extra config.

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
