---
docs-sync:
  sources:
    - server/lib/config.ts
    - server/lib/transcript.ts
    - server/lib/usage.ts
    - scripts/ask-remote-hook.sh
    - .env.example
  kind: workflow
  verified: 806bf718d0d7efa721645dd30f36fe591c457d55
---

# Configuration

**Most of this is now optional twice over.** The [Settings tab](../subsystems/settings.md) edits
the row count, time windows, refresh rate, theme and idle threshold from the browser, with no
restart — what follows are the *defaults* those settings start from, plus the things only a
config file can set (ports, feature kill switches, the shared token).

Copy `.env.example` to `.env` and edit. Everything is optional. Precedence: real
environment variables override `.env`, which overrides the defaults
(`server/lib/config.ts` `DEFAULTS`).

## Server (`.env` or environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4173` | Port the API/prod server listens on |
| `WEB_PORT` | `5173` | Port the Vite dev UI serves on (`pnpm dev` only; prod ignores it). Set when another Vite project already occupies 5173 |
| `MAX_SESSIONS` | `10` | How many sessions to show, most-recent first. **Per-browser override** in Settings → Sessions shown (sent as `?limit=`, capped at 50) |
| `ACTIVE_WINDOW_MIN` | `5` | A "recent" session is one whose last message is within this many minutes. **Per-browser override** in Settings → Active window (`?active=`, capped at 120) |
| `LOOKBACK_HOURS` | `24` | Only consider sessions modified within this many hours. **Per-browser override** in Settings → Lookback (`?lookback=`, capped at 168) |
| `SHOW_USAGE` | `true` | Show the header [usage bars](../subsystems/usage-limits.md). `false` disables the fetch and the keychain read entirely |
| `SHOW_ANALYTICS` | `true` | Show the [Analytics tab](../subsystems/analytics.md) |
| `ANALYTICS_KEEP` | `5` | How many `/kaizen`-logged sessions the Analytics tab shows |
| `REMOTE_ANSWER` | `true` | Whether [remote answers](../subsystems/remote-answer.md) are available at all — the hard kill switch for the app's only write path |
| `ANSWER_TOKEN` | _(empty)_ | Shared secret required by the remote-answer POSTs. Empty = open, matching the app's LAN-trust posture |
| `SKIP_PROC_SCAN` | _(auto)_ | Skip the `lsof` process-liveness gate. Defaults to `true` inside a Docker container, `false` otherwise |

## Process-environment only (not read from `.env`)

These are read straight off `process.env` by their consumers, so export them in the shell
that starts the server:

| Var | Read by | Meaning |
|-----|---------|---------|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `server/lib/transcript.ts` | Force the context-window size (tokens) used for the `%` bar |
| `CLAUDE_CREDENTIALS_JSON` | `server/lib/usage.ts` | OAuth creds blob for the usage bars when the host keychain isn't reachable (Docker — see [docker.md](docker.md)) |

## Hook-side (remote answers)

The `AskUserQuestion` hook runs inside **Claude Code's** process, not the dashboard's —
it reads its own environment (e.g. exported in your shell profile), **not** the
dashboard's `.env`:

| Var | Default | Meaning |
|-----|---------|---------|
| `CLAUDE_DASHBOARD_URL` | `http://127.0.0.1:4173` | Where the hook looks for the dashboard |
| `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` | `600` | Seconds the hook waits for a remote answer. Keep the hook's `timeout` in `settings.json` above it |
| `CLAUDE_DASHBOARD_IDLE_SECS` | _(dashboard, else `60`)_ | Seconds of keyboard idle before you count as "away". Below it a question goes straight to the terminal. `0` skips the check and always waits. **Normally leave this unset** and use Settings → Away after, which the hooks read off `/api/health`; setting it here wins and makes that control inert |

⚠️ If you set `CLAUDE_DASHBOARD_IDLE_SECS` in the `env` block of `~/.claude/settings.json`, the
Settings page detects it and says so, but cannot change it — the app never edits `~/.claude`.
Remove it there to drive the threshold from the dashboard.

The hook also reads `~/.claude/hooks/dashboard-token` for the `ANSWER_TOKEN` value, if
you set one. Full setup in [remote-answers.md](../subsystems/remote-answer.md).
