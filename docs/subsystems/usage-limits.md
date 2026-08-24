# Usage limits (header bars)

The header shows two mini progress bars — **5h** and **Week** — the same account
rate-limit utilization Claude Code's `/usage` reports. Unlike everything else in the app,
these are **not on disk**: `lib/usage.ts` fetches them live from Anthropic using your
local credentials. Under each bar sits a **time strip** (`lib/usage-pace.ts` +
`client/src/lib/pace.ts`) that answers the question a bare percentage can't: *at this
pace, do I run dry before the window resets?*

## Mechanism

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`, headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`. **Private/undocumented** — may change between CLI
  versions. **Always hits api.anthropic.com** — first-party account API; must NOT follow
  `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_API_BASE_URL` (those aim model inference at a
  proxy/gateway — Bedrock/Vertex/Ollama/LiteLLM — with no such route; that misroute
  returned `null` bars in practice). `CLAUDE_USAGE_BASE_URL` overrides for tests only;
  the request is protocol-aware (http vs https).
- **Response shape:** windows are **top-level**
  (`{ five_hour:{utilization,resets_at}, seven_day:{…}, … }`), *not* wrapped in
  `rate_limits`. `mapUsage()` accepts both shapes defensively and is the one pure/
  unit-tested piece (`test/usage.test.ts`).
- **Token:** read from the macOS keychain
  (`security find-generic-password -s "Claude Code-credentials"`), falling back to
  `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`. Expired tokens are
  skipped. ⚠️ The first keychain read by the dashboard process triggers a macOS GUI
  prompt — approve once with **"Always Allow"**. In Docker the keychain isn't reachable;
  pass the blob in as `CLAUDE_CREDENTIALS_JSON` instead — see
  [docker](../workflows/docker.md).
- **Caching:** `getCachedUsageState()` is **synchronous** — it returns the last value and
  fires a **non-blocking** background refresh when older than 60s. So the 3s
  `/api/sessions` poll never blocks on the network, and Anthropic is hit at most
  ~once/min. First load shows no bars until the first fetch lands (next poll picks it up).
- **Wiring:** `SessionsResponse.usage?: UsageLimits | null` (in `shared/types.ts`);
  attached in `api.ts` (both success and error branches) only when `config.showUsage`.
  Still **zero npm deps** — `https` + `child_process` are Node built-ins.
- **Status:** `SessionsResponse.usageStatus` says why bars are/aren't shown: `ok`,
  `token-expired` (stored token past expiresAt), `unavailable` (any other fail-open
  cause, incl. the endpoint's own 429 rate limit). The client renders bars only on `ok`;
  `token-expired` shows a plain "token expired" hint (no bars, no action).
- **Toggle:** `SHOW_USAGE=false` disables the feature entirely (no fetch, no keychain
  read). Default on.

## Pace + the time strip

**What the 5h window actually is.** It is a **fixed session window**, not a sliding one:
it anchors on the first message after an idle gap and fully resets to 0% at
`resets_at`. Spend does *not* age out token-by-token. Verified empirically on
2026-08-24: `resets_at` stayed at 23:50:00Z across fetches while utilization climbed
32 → 35 → 51, and 23:50 − 5h = 18:50 is exactly when transcripts show the first message
after a 1.5h idle gap. A sliding window would have pushed `resets_at` forward on every
fetch. The richer `limits[]` array in the same payload names this window `kind: "session"`.
This matters because the natural reading of "5h limit" — that you get a fraction back
each hour — is wrong, and the strip exists to make the real shape visible.

- **Sampling:** `lib/usage-pace.ts` keeps a RAM-only ring of `{t, utilization}` per window
  (cap 720 ≈ half a day at one sample/min), appended by `refreshNow()` on each successful
  fetch. No persistence — after a restart the pace fields are null for a few minutes.
- **Slope:** `computePace` is pure: least-recent → most-recent over a lookback window
  (5h: 30 min lookback / 5 min min-span; weekly: 6h / 30 min, since the weekly number
  moves in ~1% integer steps). Under the min span → `null`, and the header renders
  exactly as it did before. A non-positive slope reports `ratePerHour: 0` and no projection.
- **Window rolls** are handled twice over: `prunedSamples` drops anything older than the
  anchor (`resetsAt − window length`), and any utilization *drop* clears the history —
  otherwise a pre-reset 90% would poison the post-reset slope.
- **Contract:** `RateLimit` gained optional `ratePerHour` and `projectedExhaustAt`
  (both `number | null` / `string | null`). Optional on purpose — every consumer must
  survive their absence.
- **The strip** (`client/src/lib/pace.ts`, pure + unit-tested): a second thin track under
  the token bar whose axis is the window's *clock* — elapsed fill, a cyan `now` tick, and
  a red tick where the current pace projects 100%. Verdict on the right: `wall 1:37am ▮
  reset 1:50am` (red) when the projection lands before the reset, `lasts → 1:50am` (green)
  otherwise. The title attribute states the mechanics in words: window start, "fully
  resets to 0%", current burn.
- **`User-Agent`:** `requestHeaders()` sends `claude-code/…`. Without a claude-code UA the
  endpoint routes to an aggressively rate-limited bucket and answers persistent 429s
  ([anthropics/claude-code#30930](https://github.com/anthropics/claude-code/issues/30930)).

⚠️ **Unproven:** the *weekly* window's length is assumed to be exactly 7 days
(`SEVEN_DAY_MS`), which is what its elapsed fill is drawn against. Anthropic doesn't
document the weekly reset mechanism and community reports conflict (some observed
72-hour intervals). The weekly **verdict** doesn't depend on this — it only compares
`projectedExhaustAt` to `resetsAt` — but the weekly strip's *position* would be wrong if
the window isn't 7 days. The 5h window is the verified one.

## Invariants

- **Fail-open everywhere:** no token / expired / network error / non-2xx / unparseable →
  `usage: null` → the header simply omits the bars. Never throws into `scanSessions`
  (which stays pure).
- **We never refresh the token** — that would mutate your credentials. An expired token
  just hides the bars; the CLI renews its own token the next time it runs (on host use),
  and the next poll flips `usageStatus` back to `ok`. A "Sync" button that spawned
  `claude -p` to force-refresh was removed — too much machinery (CLI-spawn + Docker/PATH
  resolution) for a cosmetic header feature, and it could never work in Docker (no CLI in
  the container, `~/.claude` mounted read-only). See
  `backlog/tasks/done/task-1-remove-in-app-oauth-token-refresh.md` for the removed design + a
  platform-independent Docker approach to revisit **if** a future feature genuinely needs
  the dashboard to make its own authenticated Anthropic API call.

<!-- docs-sync:
  sources:
    - server/lib/usage.ts
    - server/lib/usage-pace.ts
    - client/src/lib/pace.ts
    - server/api.ts
    - client/src/components/Header.tsx
  kind: subsystem
  verified: fa9fdbc0d1f74c5ba2d43f90ecb63806e5b39b14
-->
