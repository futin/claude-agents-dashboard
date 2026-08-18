---
docs-sync:
  sources:
    - server/
    - client/src/
    - shared/types.ts
    - package.json
  kind: index
  verified: 77e990f6b0511101b36683840048bf3870761157
---

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
  index.ts        HTTP entry: routes /api/sessions(+/:id/chat) + /api/management + /api/analytics + /api/settings; static-serves client/dist in prod
  api.ts          the /api/sessions + /api/management + /api/analytics handlers (+ error fallbacks)
  lib/config.ts   .env loader — precedence process.env > .env > defaults
  lib/transcript.ts  tail-reads last 256KB of a transcript → tokens/model/window/activity
  lib/title-cache.ts  remembers a session's custom-title once it sinks below that 256KB
                  window (chunked backward hunt, then a searched-byte-range cache)
  lib/scan.ts     enumerates + ranks sessions across ~/.claude/projects; `sessionSurface`
                  maps a transcript's `entrypoint` → Session.surface (local | dashboard |
                  cloud — see docs/subsystems/session-surfaces.md)
  lib/agents.ts   whole-file subagent parser: pure event parser + reducer → AgentJob[]
                  (tokens/toolUses/duration from toolUseResult + notification <usage> blocks)
  lib/agents-cache.ts  incremental byte-offset cache over agents.ts, used only by the
                  on-demand GET /api/sessions/:id (see docs/ideas/agent-tracking-cache.md)
  lib/chat.ts     byte-offset paged chat history for GET /api/sessions/:id/chat — tail /
                  ?after= (live) / ?before= (older) (see docs/subsystems/chat.md)
  lib/usage.ts    fetches account 5h/weekly limits from Anthropic (see docs/subsystems/usage-limits.md)
  lib/frontmatter.ts  zero-dep YAML-frontmatter subset parser (key:value + >/| scalars, fail-open)
  lib/management.ts   config scanner: global/project ScopeConfig, plugins, recent projects,
                  servable-path security set (see docs/subsystems/management.md)
  lib/analyze.ts  whole-file session post-mortem → SessionAnalysis (the /kaizen analyzer; pure)
  lib/sessionAnalyticsLog.ts  parses ~/.claude/session-analytics-log.md → lesson / status /
                  review-marker lines per session (append-only grammar; fail-open)
  lib/analytics.ts  read-only reader: last N /kaizen-logged sessions, each re-analyzed live
                  (see docs/subsystems/analytics.md)
  lib/pending.ts  in-memory pending-AskUserQuestion store + state machine — the first of
                  the app's four write paths (see docs/subsystems/remote-answer.md)
  lib/plans.ts    in-memory pending-ExitPlanMode store — same state machine, reject-only
                  verdicts (accept is refused upstream; see docs/subsystems/remote-plan.md)
  lib/messages.ts  in-memory turn-end reply-window store — same state machine, plus a 5s
                  idle sweep that auto-releases every hold (see docs/subsystems/remote-message.md)
  lib/permissions.ts  in-memory "a permission dialog is open in that terminal" flags, fed by
                  the PermissionRequest hook (Notification is the legacy fallback);
                  display-only (see docs/subsystems/permission-notify.md)
  lib/notify.ts   server-sent ntfy push: layered policy (4 events × remote-answer × AFK ×
                  auto-mode), pure `shouldNotify` + fire-and-forget `node:https` send.
                  Topic lives in .env and is NEVER returned by an endpoint; the push's
                  Click header deep-links to /?session=<id>
                  (see docs/subsystems/push-notify.md)
  lib/remoteState.ts  remote-answer switch: REMOTE_ANSWER env gate + UI toggle persisted to
                  gitignored .remote-answer.json (fails open)
  lib/settings.ts persisted idle threshold + answer window for the remote-answer hooks
                  (served on /api/health, since they can't read our env) + detection of
                  overriding CLAUDE_DASHBOARD_{IDLE_SECS,ANSWER_TIMEOUT}, plus the
                  notify policy lib/notify.ts acts on (see docs/subsystems/settings.md)
  lib/origin.ts   pure connection classifier → local | lan | tailnet | unknown, on
                  /api/health for the toolbar badge (see docs/subsystems/remote-access.md)
  lib/transcribe.ts  ffmpeg → whisper-cli pipeline for POST /api/transcribe: mime
                  allowlist, cached engine probe, single-flight guard, typed failures,
                  never a raw stderr dump to the client (see docs/subsystems/dictation.md)
  lib/spawn.ts    launches a detached, headless `claude -p` session: pure argv/validation
                  core (buildSpawnArgs, clampPermission, parseSpawnRequest) plus a RAM-only
                  launch-tracking store with no reaper (probeSpawn, launch, listLaunching,
                  adoptLaunched, stopLaunch) — the fourth write path, and the first the
                  dashboard initiates (see docs/subsystems/spawn.md)
client/           Vite + React + TypeScript frontend
  src/App.tsx     shell: side rail (Sessions | Management | Analytics | Settings), lazy-loads all but Sessions
  components/SessionsView.tsx  the original live monitor (owns the 3s poll + chat drawer state)
  components/{Header,SessionList,SessionRow,Toolbar,SideRail}
  components/ChatDrawer.tsx    full-height chat-history drawer (own lazy chunk;
                  hooks/useSessionChat — see docs/subsystems/chat.md)
  components/Markdown.tsx + lib/markdown.ts  zero-dep markdown-subset parser + renderer
                  for message text (no dangerouslySetInnerHTML; pure, unit-tested)
  lib/chatFilter.ts            drawer all/text/you message filter (pure; persisted)
  lib/surface.ts               the `dashboard`/`cloud` pill (label + tooltip) shown on a
                  row and in the drawer header; `local` renders nothing (pure)
  lib/deepLink.ts              the ?session=<id> entry point a tapped push opens —
                  read once, memoised for its two callers, then stripped from the URL
                  (see docs/subsystems/push-notify.md)
  components/QuestionPanel.tsx pinned action bar to answer a session's AskUserQuestion
                  (hooks/usePendingQuestion — see docs/subsystems/remote-answer.md)
  components/PlanPanel.tsx     pinned action bar to send a proposed plan back for revision
                  (hooks/usePendingPlan — see docs/subsystems/remote-plan.md)
  components/MessagePanel.tsx  pinned composer for a turn-end reply window: send free text
                  back, or let the session stop (hooks/usePendingMessage — see docs/subsystems/remote-message.md)
  components/MicButton.tsx + lib/dictation.ts  tap-to-record mic in that composer's action
                  row, plus its pure mime-pick/elapsed-fmt/transcript-append helpers
                  (hooks/useDictation + hooks/useTranscribeAvailable — see
                  docs/subsystems/dictation.md); hidden with no engine, disabled-with-reason
                  with no HTTPS
  components/SpawnPanel.tsx + lib/spawnOptions.ts  the launch form: pick a recent project,
                  write or dictate a prompt, tap launch — starts a detached headless
                  `claude -p` (own lazy chunk; hooks/useSpawn — see docs/subsystems/spawn.md)
  components/PermissionBanner.tsx  pinned drawer strip naming the tool call a terminal
                  permission dialog is asking about (display-only; no controls by design)
  components/RemoteAnswerToggle.tsx  toolbar pill for the remote-answer switch
                  (fed by hooks/useRemoteAnswer, which the Toolbar owns)
  components/OriginBadge.tsx   toolbar pill: how this browser reached the dashboard
                  (reads `origin` off the same /api/health poll; display-only)
  components/management/       three-pane management UI (ScopeMenu, ItemList, DetailPane, FileViewer)
  components/analytics/AnalyticsView.tsx  the report-card list (own lazy chunk; read-only)
  hooks/useSessions, hooks/useManagement, hooks/useAnalytics, lib/format, lib/managementEntries
  components/settings/         the Settings tab (own lazy chunk) — themes, density/text scale,
                  refresh rate, scan knobs, push policy, idle threshold (see docs/subsystems/settings.md)
  hooks/useSettings.tsx        per-device settings context (localStorage) — the source of
                  refreshMs for every poll and of the data-theme/data-density attributes
  hooks/usePersistedState.ts  localStorage-backed useState (see docs/subsystems/view-persistence.md)
vite.config.ts    dev proxy /api → backend; reuses server loadConfig() for the port
test/             node-assert tests over backend domain logic, tmpdir JSONL fixtures
```

## Commands

- `pnpm dev` — API + Vite together. Open http://localhost:5174 (HMR, proxies /api).
- `pnpm build` — bundles client → `client/dist`.
- `pnpm start` — prod: serves built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `pnpm test` — runs `test/run-all.ts` via tsx; it prints the case count.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm tunnel` — optional: `tailscale serve --bg 5174`, fronts that fixed port over HTTPS
  on the tailnet — keep it matching the port you actually serve (prod `PORT` or a dev
  `WEB_PORT`; see `docs/subsystems/remote-access.md`). Not needed for plain tailnet access.

**Phone access:** both servers bind all interfaces (`server.host: true` in `vite.config.ts`;
`server/index.ts` likewise), so **every route works with zero app config** and none is
required — localhost, LAN (the `Network:` URL Vite prints), **Tailscale** (recommended for
away-from-home: a stable MagicDNS hostname `http://<host>.<tailnet>.ts.net:4173`, device
identity as the auth, nothing public), or any other tunnel (ngrok/Cloudflare/`ssh -L` — but
a public URL exposes every read endpoint). Optional `pnpm tunnel` fronts one fixed port
(currently `5174`) over HTTPS on 443. The toolbar's origin badge says which route the current browser came in on. See
`docs/subsystems/remote-access.md`.

## Deep-dive docs

Per-domain docs are **NOT auto-loaded**. The map of every subsystem and workflow doc
lives in `docs/overview.md` — read the relevant `docs/subsystems/*.md` before changing
that area, and keep the vendored `/kaizen` skill (`.claude/skills/kaizen/`) in lockstep
with the log format above (contract details: `docs/subsystems/analytics.md`).

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
- **Never hardcode a color or a shadow in `styles.css`** below the theme-token block at the top —
  the 5 themes are pure `[data-theme]` token overrides, and one literal breaks the light one.
- Backend is zero-runtime-dep by design (only Node built-ins). Keep new deps out of `server/`.
  It reads from disk and makes exactly **one** kind of outbound call: the ntfy push in
  `lib/notify.ts`. Adding a second needs a reason.
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
- **Review subagents file their report; they return only the verdict.** The review
  templates say "your final message IS the report", which is right for the reviewer and
  wrong for the controller: a ~1500-word report replays through every later turn. Tell
  review agents to write the full report to a file and return the verdict plus the
  Critical/Important findings only — the same contract implementers already get. The rule
  above was read as covering implementers alone, which is why this recurred; reviewers are
  the larger half of the spend in a subagent-driven run.
- **Implementation plans specify behaviour and exact test *cases* — not literal code.**
  A plan that hands over complete code blocks gets transcribed verbatim (that is what
  "use the brief's code" means to an implementer), so a bug in the plan becomes a bug in
  the branch with nobody positioned to catch it. Test scaffolding is the worst offender:
  it looks like boilerplate, so it is read least closely. Give the signatures, the exact
  expected values, and the edge cases; let the implementer write the code and disagree
  with you.
- **Per-task review agents are for logic-heavy tasks.** A task that is pure transcription
  of a fully-specified brief gets self-review plus the final whole-branch review instead —
  dispatching a full review agent for one reliably finds nothing. Reserve the review seat
  for concurrency, subprocess handling, security surfaces, and anything with real design
  judgement in it.
