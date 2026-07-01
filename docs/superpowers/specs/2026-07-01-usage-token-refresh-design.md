# Usage-bar token refresh — design

Date: 2026-07-01
Status: approved (brainstorm session)

## Problem

The header's 5h/Week usage bars come from `server/lib/usage.ts`, which reads the
Claude Code OAuth access token from the macOS keychain (fallback:
`~/.claude/.credentials.json`). The access token lives ~8h and the dashboard
never refreshes it by design. When it expires, every fetch fails open →
`usage: null` → the bars silently vanish. The user has no way to tell "token
expired" apart from any other failure, and the only remedy is to manually run
`claude` in a terminal so the CLI refreshes its own token.

## Goal

Make recovery natural: tell the user *why* the bars are gone, and give them a
one-click way to fix the expired-token case from the header.

## Decision

**Hint + button (B+A).** Surface a `usageStatus` so the client can distinguish
an expired token; when expired, show a hint and a **Sync** button that makes the
server spawn a headless `claude -p` turn. The CLI refreshes and persists its own
token — the dashboard never writes credentials (direct OAuth refresh was
rejected: undocumented endpoint, refresh-token rotation race can log the CLI
out).

Button appears **only** when `usageStatus === 'token-expired'`. Other failure
modes get no button — spawning `claude` can't fix them.

## Design

### 1. Contract (`shared/types.ts`)

Add to `SessionsResponse`, alongside the existing `usage` field:

```ts
usageStatus?: 'ok' | 'token-expired' | 'unavailable'
```

- `ok` — fetch succeeded; `usage` is populated.
- `token-expired` — a token was found (keychain or creds file) but is past
  `expiresAt`.
- `unavailable` — every other fail-open cause: no token, network error,
  non-2xx, unparseable response.

Bars render only on `ok`.

### 2. Server — status plumbing (`server/lib/usage.ts`)

`getToken()` currently collapses "expired" into `null`. Change it to return a
discriminated result: `{ token } | { reason: 'expired' } | { reason: 'missing' }`.
The cache layer (`getCachedUsage()`) carries the status alongside the limits;
`api.ts` attaches both `usage` and `usageStatus` (success and error branches,
gated by `config.showUsage` as today). Fail-open behavior is unchanged —
nothing throws into `scanSessions`.

### 3. Server — refresh endpoint

`POST /api/usage/refresh`, routed in `server/index.ts`, gated by the same
`SHOW_USAGE` toggle (404/disabled when off).

Handler behavior:

- **In-flight guard:** module-level flag; a second request while one runs
  returns `409 { ok: false, error: 'refresh already running' }`.
- **Spawn:** `claude -p "ok" --model haiku` via `child_process` (argv array, no
  shell), `cwd` = `~/.claude/dashboard-refresh/` (created on demand), 60s
  timeout, stdin ignored.
- **Success (exit 0):** force the usage cache to re-fetch immediately, respond
  `200 { ok: true, usage, usageStatus }`.
- **Failure:** non-zero exit, timeout, or ENOENT (`claude` not on PATH) →
  `502 { ok: false, error: <message> }`.
- **Testability:** spawner injectable (same pattern as `ScanOptions.liveCwds`).
- Zero new npm deps — Node built-ins only.

### 4. Phantom-session mitigation

The spawned turn writes a transcript under
`~/.claude/projects/-Users-…-claude-dashboard-refresh/<uuid>.jsonl`, which the
scanner would show as a session. Export the refresh cwd as a constant;
`scan.ts` drops any session whose `projectPath` equals it — a one-line filter
next to the existing empty-session filter.

### 5. Client (`client/src/components/Header.tsx`)

- `usageStatus === 'ok'` → bars exactly as today.
- `'token-expired'` → text "usage: token expired" + **Sync** button.
  - Click → button disabled, label "refreshing…" → `POST /api/usage/refresh`.
  - Success → next 3s poll paints the bars (response also carries fresh usage).
  - Failure → brief inline error (e.g. "claude CLI not found").
- `'unavailable'` or absent → omit the section, as today.

Keep existing CSS class conventions; new styles go in `client/src/styles.css`.

### 6. Tests

- `test/usage.test.ts`: status mapping — expired token, missing token, ok.
- New `test/usage-refresh.test.ts` with a fake spawner: success path
  (cache re-fetch triggered), non-zero exit → 502, ENOENT → 502,
  concurrent request → 409.
- `test/scan.test.ts` (or equivalent): a transcript under the refresh dir is
  filtered out.

No test spawns the real `claude` binary.

## Accepted trade-offs

- Each click burns one haiku subscription turn (negligible quota).
- 5–15s latency per refresh; button communicates progress.
- Assumes `claude` is on the server process PATH; surfaced as an error if not.

## Out of scope

- Direct OAuth refresh (rejected above).
- Auto-refresh without user action (would burn turns silently).
- Force-refreshing the 60s usage cache when the token is *not* expired.
