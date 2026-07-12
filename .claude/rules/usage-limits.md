# Usage limits (header bars)

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
