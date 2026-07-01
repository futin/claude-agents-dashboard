# Claude Agents Dashboard

Live monitor for parallel Claude Code sessions. Reads `~/.claude/projects/*/*.jsonl`
transcripts off disk (no daemon, no hooks) and shows, per session: project, git branch,
model, context usage, and current tool activity. Polls every 3s.

## Architecture

Monolith split into three domains. The **only** thing crossing the FE/BE boundary is the
typed `GET /api/sessions` JSON payload.

```
shared/types.ts   API contract (SessionsResponse, Session, Activity). Imported by both sides.
server/           Node backend, TypeScript, run via tsx (no compile step)
  index.ts        HTTP entry: routes /api/sessions; static-serves client/dist in prod
  api.ts          the /api/sessions handler (scanSessions + error fallback)
  lib/config.ts   .env loader — precedence process.env > .env > defaults
  lib/transcript.ts  tail-reads last 256KB of a transcript → tokens/model/window/activity
  lib/scan.ts     enumerates + ranks sessions across ~/.claude/projects
client/           Vite + React + TypeScript frontend
  src/App.tsx, components/{Header,SessionList,SessionRow}, hooks/useSessions, lib/format
vite.config.ts    dev proxy /api → backend; reuses server loadConfig() for the port
test/             node-assert tests over backend domain logic, tmpdir JSONL fixtures
```

## Commands

- `pnpm dev` — API + Vite together. Open http://localhost:5173 (HMR, proxies /api).
- `pnpm build` — bundles client → `client/dist`.
- `pnpm start` — prod: serves built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `pnpm test` — runs `test/run-all.ts` via tsx (14 cases).
- `pnpm typecheck` — `tsc --noEmit`.

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

Signals come from the **newest message record** (newest tail record with `message.role` of
`user`/`assistant`): `transcript.ts` exposes `turnComplete` (default true; false unless that
record is an assistant with `end_turn`), `waitingOnQuestion`, and `lastMessageTs` (that
record's timestamp — the recency signal). Records without a role (usage-only, meta,
last-prompt, queue-operation) are ignored for state.

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
