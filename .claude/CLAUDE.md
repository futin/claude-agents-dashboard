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

- `npm run dev` — API + Vite together. Open http://localhost:5173 (HMR, proxies /api).
- `npm run build` — bundles client → `client/dist`.
- `npm start` — prod: serves built client + API on http://localhost:4173 (`NODE_ENV=production`).
- `npm test` — runs `test/run-all.ts` via tsx (14 cases).
- `npm run typecheck` — `tsc --noEmit`.

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
