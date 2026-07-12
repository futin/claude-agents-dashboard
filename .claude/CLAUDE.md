# Claude Agents Dashboard

Live monitor for parallel Claude Code sessions. Reads `~/.claude/projects/*/*.jsonl`
transcripts off disk (no daemon, no hooks) and shows, per session: project, git branch,
model, context usage, and current tool activity. Polls every 3s.

## Architecture

Monolith split into three domains. The **only** thing crossing the FE/BE boundary is the
typed JSON payloads in `shared/types.ts` (`GET /api/sessions*`, `GET /api/management*`).

```
shared/types.ts   API contract (SessionsResponse, Session, ManagementIndex, ScopeConfig…).
server/           Node backend, TypeScript, run via tsx (no compile step)
  index.ts        HTTP entry: routes /api/sessions + /api/management; static-serves client/dist in prod
  api.ts          the /api/sessions + /api/management handlers (+ error fallbacks)
  lib/config.ts   .env loader — precedence process.env > .env > defaults
  lib/transcript.ts  tail-reads last 256KB of a transcript → tokens/model/window/activity
  lib/scan.ts     enumerates + ranks sessions across ~/.claude/projects
  lib/agents.ts   whole-file subagent parser: pure event parser + reducer → AgentJob[]
                  (tokens/toolUses/duration from toolUseResult + notification <usage> blocks)
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts, used only by the
                  on-demand GET /api/sessions/:id (see docs/ideas/agent-tracking-cache.md)
  lib/usage.ts    fetches account 5h/weekly limits from Anthropic (see "Usage limits")
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser (key:value + >/| scalars, fail-open)
  lib/management.ts   config scanner: global/project ScopeConfig, plugins, recent projects,
                  servable-path security set (see "Management section")
client/           Vite + React + TypeScript frontend
  src/App.tsx     section tabs (Sessions | Management), lazy-loads ManagementView
  components/SessionsView.tsx  the original live monitor (owns the 3s poll)
  components/{Header,SessionList,SessionRow,Toolbar,SectionTabs}
  components/management/       three-pane management UI (ScopeMenu, ItemList, DetailPane, FileViewer)
  hooks/useSessions, hooks/useManagement, lib/format, lib/managementEntries
  hooks/usePersistedState.ts  localStorage-backed useState (see "View persistence")
vite.config.ts    dev proxy /api → backend; reuses server loadConfig() for the port
test/             node-assert tests over backend domain logic, tmpdir JSONL fixtures
```

## Commands

- `pnpm dev` — API + Vite together. Open http://localhost:5173 (HMR, proxies /api).
- `pnpm build` — bundles client → `client/dist`.
- `pnpm start` — prod: serves built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `pnpm test` — runs `test/run-all.ts` via tsx (105 cases).
- `pnpm typecheck` — `tsc --noEmit`.

**Phone access on the same wifi:** the Vite dev server binds all interfaces
(`server.host: true` in `vite.config.ts`), so no tunnel is needed — just open
the `Network:` URL Vite prints (e.g. `http://192.168.x.x:5173`) on a phone
connected to the same wifi as the host machine. The backend (`server/index.ts`)
already binds all interfaces by default, so `pnpm start` (prod, port 4173) is
LAN-reachable the same way with no extra config.

## Session status (the left dot)

`Session.status` (4 states), computed in `scan.ts` from `transcript.ts` signals.
`question` (blue) overrides everything; otherwise it's a 2×2 of `recent` × `turnComplete`:

`recent` = last **conversational message** (`transcript.ts` `lastMessageTs`) is newer than
`activeWindowMin`. **Not file mtime** — selecting a session in Claude Code appends
timestamp-less `mode`/`last-prompt`/`custom-title` records that bump mtime with no turn
happening, which used to flip idle sessions to `working`. mtime is only a fallback when no
message timestamp exists (and still the coarse `lookbackHours` enumeration filter in `scan.ts`).

|                          | recent (< `activeWindowMin`) | stale               |
|--------------------------|------------------------------|---------------------|
| **pending** (no end_turn)| 🟢 `working`                 | 🟡 `incomplete`     |
| **finished** (end_turn)  | 🟡 `incomplete`              | ⚪ `idle`           |

- **question** (blue) — newest assistant action is an unanswered `AskUserQuestion`. Beats all.
  `ExitPlanMode` is NOT treated as a question.
- **working** (green, pulsing) — recent AND the turn is unfinished = machine actively churning.
  **Only this state** counts toward `totals.active`. A finished turn (end_turn) is NOT working
  even if recent — the ball is in the human's court.
- **incomplete** (yellow, "pending") — either recent + finished (your turn to reply) or
  stale + unfinished (stalled mid-task).
- **idle** (gray) — stale AND the last turn finished cleanly.

**Process-liveness gate (overrides the 2×2):** a cleaned/interrupted session's last
record often has no `end_turn`, so on disk it looks recent + pending = `working` forever
even though nothing runs. So `scan.ts` `liveCwds()` shells out to `lsof -c claude -a -d cwd
-Fn` for the set of cwds with a live `claude` CLI process; a session whose `projectPath`
isn't in that set is forced to `idle`, no matter the transcript. `-c claude` is
case-sensitive → CLI only, not the capital-`C` `Claude.app` shell. **Granularity is per-cwd**
(claude doesn't hold the `.jsonl` open and exposes no session id in argv/env), so two
sessions in the same directory can't be told apart — a dead one there still reads live.
Probe is fail-open: `null` (no lsof / timeout / error) skips the gate. Injectable via
`ScanOptions.liveCwds` for tests; `skipProcScan` also disables it.

**Docker:** the dashboard container only has its own process namespace — `lsof -c claude`
inside it can never see the host's real `claude` CLI process, so the gate would force every
session to `idle` even while genuinely working. `config.ts` `isDockerContainer()` detects
`/.dockerenv` and defaults `skipProcScan: true` in that case (override with `SKIP_PROC_SCAN`
env either way); `api.ts` passes `config.skipProcScan` into `scanSessions`.

**Empty-session filter:** `/clear` (and opening a new session) starts a fresh UUID
transcript holding only `queue-operation`/`attachment`/meta records with no user/assistant
message yet. Its fresh mtime would read recent + `turnComplete`(default) = `incomplete`,
showing a phantom "pending" row beside the real session `/clear` abandoned — and there's no
on-disk link from the new session back to the cleared one to dedupe by. So `scan.ts` drops
any transcript whose `hasMessages` is false (`transcript.ts` = `newestMessageSeen`, true
once a `message.role` user/assistant record appears in the tail). Nothing to show → not
shown. The old session ages to `idle` on its own once stale.

Signals come from the **newest message record** (newest tail record with `message.role` of
`user`/`assistant`): `transcript.ts` exposes `turnComplete` (default true; false unless that
record is an assistant with `end_turn`), `waitingOnQuestion`, and `lastMessageTs` (that
record's timestamp — the recency signal). Records without a role (usage-only, meta,
last-prompt, queue-operation) are ignored for state.

## Usage limits (header bars)

The header shows two mini progress bars — **5h** and **Week** — the same account
rate-limit utilization Claude Code's `/usage` reports. Unlike everything else in the app,
these are **not on disk**: `lib/usage.ts` fetches them live from Anthropic.

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`, headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`. **Private/undocumented** — may change between CLI versions.
  **Always hits api.anthropic.com** — first-party account API; must NOT follow
  `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_API_BASE_URL` (those aim model inference at a
  proxy/gateway — Bedrock/Vertex/Ollama/LiteLLM — with no such route; that misroute returned
  `null` bars in practice). `CLAUDE_USAGE_BASE_URL` overrides for tests only; request is
  protocol-aware (http vs https).
- **Response shape:** windows are **top-level** (`{ five_hour:{utilization,resets_at}, seven_day:{…}, … }`),
  *not* wrapped in `rate_limits`. `mapUsage()` accepts both shapes defensively and is the one
  pure/unit-tested piece (`test/usage.test.ts`).
- **Token:** read from the macOS keychain (`security find-generic-password -s "Claude Code-credentials"`),
  falling back to `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`. Expired tokens
  are skipped; **we never refresh** (that would mutate creds). ⚠️ The first keychain read by
  the dashboard process triggers a macOS GUI prompt — approve once with "Always Allow".
- **Caching:** `getCachedUsageState()` is **synchronous** — it returns the last value and fires a
  **non-blocking** background refresh when older than 60s. So the 3s `/api/sessions` poll never
  blocks on the network, and Anthropic is hit at most ~once/min. First load shows no bars until
  the first fetch lands (next poll picks it up).
- **Fail-open everywhere:** no token / expired / network error / non-2xx / unparseable →
  `usage: null` → header omits the bars. Never throws into `scanSessions` (which stays pure).
- **Wiring:** `SessionsResponse.usage?: UsageLimits | null` (in `shared/types.ts`); attached in
  `api.ts` (both success and error branches) only when `config.showUsage`. Still **zero npm deps**
  — `https` + `child_process` are Node built-ins.
- **Toggle:** `SHOW_USAGE=false` disables the feature entirely (no fetch, no keychain read).
  Default on.
- **Status:** `SessionsResponse.usageStatus` says why bars are/aren't shown: `ok`,
  `token-expired` (stored token past expiresAt), `unavailable` (any other fail-open cause,
  incl. the endpoint's own 429 rate limit). Client renders bars only on `ok`;
  `token-expired` shows a plain "token expired" hint (no bars, no action).
- **No in-app token recovery.** An expired token just hides the bars; the CLI renews its own
  token the next time it runs (on host use), and the next poll flips `usageStatus` back to
  `ok`. A "Sync" button that spawned `claude -p` to force-refresh was removed — it was too much
  machinery (CLI-spawn + Docker/PATH resolution) for a cosmetic header feature, and could never
  work in Docker (no CLI in the container, `~/.claude` mounted read-only). See
  `docs/plans/2026-07-06-usage-token-refresh-removal.md` for the removed design + a
  platform-independent Docker approach to revisit **if** a future feature genuinely needs the
  dashboard to make its own authenticated Anthropic API call.

## Management section (read-only config browser)

A **Management** tab (top-level `SectionTabs` in `App.tsx`, persisted as `dashboard.section`)
shows all Claude config on the machine in a three-pane layout: scope menu (Global +
recently-active projects) | filterable item list grouped by type | detail pane with the
selected item's file content. Read-only v1 — nothing is ever written.

- **Endpoints:** `GET /api/management` (ManagementIndex: global ScopeConfig + recent
  ProjectRefs), `GET /api/management/project?dir=<dirName>` (one project's ScopeConfig),
  `GET /api/management/file?path=<abs>` (FileContent). Handlers in `api.ts`, scanner in
  `lib/management.ts`, frontmatter metadata via `lib/frontmatter.ts`.
- **Scopes:** global = `~/.claude/{skills,agents,commands,rules,hooks,CLAUDE.md,settings*}`
  **plus every installed plugin's subtree** (`plugins/installed_plugins.json` →
  installPath → skills/agents/commands/rules/hooks.json), items tagged `plugin:<name>`.
  Project = `<cwd>/.claude/*` + root CLAUDE.md, items tagged `project`. Recent projects
  come from transcript cwds (same lookback as sessions), deduped by cwd, newest-first.
- **⚠️ File-endpoint security (the invariant to keep):** the endpoint serves ONLY paths
  present in `collectServablePaths()` — the exact set the scanner itself enumerated.
  **Never replace this with prefix/subtree checks**: `~/.claude` also holds
  `.credentials.json`/`history.jsonl`/`session-data/`, and project roots hold `.env`.
  `dirName` is resolved against the enumerated recent-project list, never joined into a
  path (same philosophy as `serveSessionDetail`). Content capped at 256 KB (`truncated`
  flag). `~/.claude.json` (huge, private) is never read.
- **No polling:** config changes over days. Index fetched on section mount / manual ↻;
  project scopes + file bodies fetched lazily on click and cached in ref-held Maps.
  Switching to Management unmounts SessionsView → the 3s poll stops.
- **Client:** ManagementView is a `React.lazy` default export (own chunk; sessions bundle
  unchanged). Entry normalization is pure (`lib/managementEntries.ts`, unit-tested).
  Stale persisted scope / dead selection resolve during render — no effects.

## View persistence (Toolbar filters/sort)

The Toolbar's `view` object (`projects`, `statuses`, `window`, `sortKey`, `sortDir` — the
`View` interface in `client/src/lib/filterSort.ts`) is persisted to **localStorage** under key
`dashboard.view` so filters/sort survive a page refresh and tab-close. Wired in `App.tsx` via
`usePersistedState<View>('dashboard.view', DEFAULT_VIEW)` instead of plain `useState`.

- `hooks/usePersistedState.ts` — generic `useState` replacement: lazy init reads+parses the
  stored JSON once; an effect writes on every change. **Fail-open** — missing/bad JSON or a
  throwing `localStorage` (private mode / quota) falls back to the passed default, never crashes
  render. Object values are shallow-merged over the default (`{ ...fallback, ...parsed }`) so a
  value stored by an older release still gains any newly-added `View` field's default.
- **Client-only, zero deps** — no backend, no URL params (not shareable/bookmarkable by design).
- **Not persisted:** row-expansion state (`SessionList.tsx` `expandedIds`) stays ephemeral —
  session IDs churn, so restored expansions would mostly be stale.

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
