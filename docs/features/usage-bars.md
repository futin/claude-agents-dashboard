---
docs-sync:
  sources:
    - server/lib/usage.ts
    - server/api.ts
---

# Account usage bars (header)

The header shows two mini progress bars — **5h** and **Week** — the same account
rate-limit utilization Claude Code's `/usage` reports. Unlike everything else in the
dashboard, these are **not on disk**: they're fetched live from Anthropic's OAuth usage
endpoint using your local credentials (macOS keychain, falling back to
`~/.claude/.credentials.json`).

- Cached and refreshed at most ~once/minute in the background, so the 3s poll never
  blocks on the network.
- Fail-open: no token / expired token / network error → the bars are simply omitted. An
  expired token shows a plain "token expired" hint; it heals itself the next time the
  Claude Code CLI runs and refreshes its own credentials.
- The dashboard **never refreshes the token itself** — that would mutate your
  credentials.
- Disable entirely with `SHOW_USAGE=false` (no fetch, no keychain read).

> ⚠️ On macOS the first keychain read triggers a GUI prompt — approve once with
> **"Always Allow"**.

In Docker the keychain isn't reachable; pass the blob in as `CLAUDE_CREDENTIALS_JSON`
instead — see [docker.md](../architecture/docker.md).

Endpoint details and caching internals:
[.claude/rules/usage-limits.md](../../.claude/rules/usage-limits.md).
