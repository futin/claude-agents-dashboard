# Configuration

**Most of this is now optional twice over.** The [Settings tab](../subsystems/settings.md) edits
the row count, time windows, refresh rate, theme, idle threshold, answer window and
[push-notification policy](../subsystems/push-notify.md) from the browser, with no
restart — what follows are the *defaults* those settings start from, plus the things only a
config file can set (ports, feature kill switches, the shared token, the ntfy topic).

Copy `.env.example` to `.env` and edit. Everything is optional. Precedence: real
environment variables override `.env`, which overrides the defaults
(`server/lib/config.ts` `DEFAULTS`).

## Server (`.env` or environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4173` | Port the API/prod server listens on |
| `WEB_PORT` | `5174` | Port the Vite dev UI serves on (`pnpm dev` only; prod ignores it). Deliberately not Vite's stock 5173, which another project usually holds. Set it only if 5174 is taken too |
| `MAX_SESSIONS` | `10` | How many sessions to show, most-recent first. **Per-browser override** in Settings → Sessions shown (sent as `?limit=`, capped at 50) |
| `ACTIVE_WINDOW_MIN` | `5` | A "recent" session is one whose last message is within this many minutes. **Per-browser override** in Settings → Active window (`?active=`, capped at 120) |
| `LOOKBACK_HOURS` | `24` | Only consider sessions modified within this many hours. **Per-browser override** in Settings → Lookback (`?lookback=`, capped at 168) |
| `SHOW_USAGE` | `true` | Show the header [usage bars](../subsystems/usage-limits.md). `false` disables the fetch and the keychain read entirely |
| `SHOW_ANALYTICS` | `true` | Show the [Analytics tab](../subsystems/analytics.md) |
| `ANALYTICS_KEEP` | `5` | How many `/kaizen`-logged sessions the Analytics tab shows |
| `GUIDES_DIR` | `<cwd>/docs/guides` | Directory the [Guides tab](../subsystems/guides.md) lists, and the root `GET /guides/<relPath>` serves out of. **Unset means the default directory, not off** — the opposite of the `NTFY_TOPIC`/`WHISPER_MODEL`/`CLAUDE_BIN` rule below; there is no on/off flag, and a missing directory renders an empty tab rather than hiding it |
| `REMOTE_ANSWER` | `true` | Whether [remote answers](../subsystems/remote-answer.md) are available at all — the hard kill switch in front of **every** write path, not just questions: [plans](../subsystems/remote-plan.md), [replies](../subsystems/remote-message.md), [spawn](../subsystems/spawn.md) and [dictation](../subsystems/dictation.md) each check it too. It is the app's only *runtime* switch (the `CLAUDE_BIN`/`WHISPER_MODEL` kill switches are restart-scoped), which is why it covers the widest path rather than excluding it |
| `ANSWER_TOKEN` | _(empty)_ | Shared secret required by the remote-answer POSTs. Empty = open, matching the app's LAN-trust posture |
| `SKIP_PROC_SCAN` | _(auto)_ | Skip the `lsof` process-liveness gate. Defaults to `true` inside a Docker container, `false` otherwise |
| `NTFY_TOPIC` | _(empty)_ | ntfy topic for [push notifications](../subsystems/push-notify.md). Empty disables pushes outright. **Treat it as a secret** — the string is both the address and the credential, so anyone who learns it can publish to your phone as well as read it. Never returned by any endpoint. Step-by-step: [push-notify-setup](push-notify-setup.md) |
| `NTFY_SERVER` | `https://ntfy.sh` | Base URL of the ntfy server. Override for a self-hosted instance |
| `DASHBOARD_PUBLIC_URL` | _(empty)_ | How your **phone** reaches the dashboard, used for the notification's tap-through link. Cannot be inferred (a push has no `Host` header to read) — set it to your tailnet hostname. Unset, pushes still arrive but carry no `Click` header, so tapping one opens nothing; the Test push button says so rather than reporting a guess |
| `WHISPER_MODEL` | _(empty)_ | Path to a GGML whisper model. **Empty disables [dictation](../subsystems/dictation.md) outright** — the same "unset means off" rule `NTFY_TOPIC` uses for pushes. Setting it arms `POST /api/transcribe`, an endpoint that spawns processes on this machine, gated only by the same `ANSWER_TOKEN` above (empty there means this is open too — see [dictation's security posture](../subsystems/dictation.md#security-posture) before setting this where other devices can reach it). Step-by-step: [dictation-setup](dictation-setup.md) |
| `WHISPER_BIN` | `whisper-cli` | The whisper.cpp CLI, resolved from `PATH`. Override with an absolute path for a non-`PATH` install |
| `FFMPEG_BIN` | `ffmpeg` | Transcodes the browser's recording (AAC or Opus) to the 16kHz mono WAV whisper.cpp requires. Resolved from `PATH`; override with an absolute path for a non-`PATH` install |
| `CLAUDE_BIN` | _(empty)_ | Path or `PATH` name of the `claude` CLI to spawn for a new headless session (see [spawn](../subsystems/spawn.md)). **Empty disables the whole feature outright** — the same "unset means off" rule `NTFY_TOPIC`/`WHISPER_MODEL` already use, rather than a separate on/off flag. Setting it arms `POST /api/spawn`, an endpoint that spawns a whole new `claude` process on this machine, gated only by the same `ANSWER_TOKEN` above (empty there means this is open too) |
| `SPAWN_MAX_PERMISSION` | `auto` | The permission-mode ceiling every launch request is clamped to, no matter what the launch form asks for — ladder `plan < acceptEdits < auto < bypassPermissions`. **Security note:** raising this to `bypassPermissions` lets anything that can reach `/api/spawn` run a fully unsandboxed `claude` process on this machine with no permission prompts at all — only raise it on a machine and network you fully trust (see [spawn's security posture](../subsystems/spawn.md#security-posture)). A present-but-unrecognized value (e.g. a typo'd case) does **not** fail silently like the rest of this table: it falls back to `auto` but also logs a warning, because this is the one knob that bounds the feature's blast radius |

## Process-environment only (not read from `.env`)

These are read straight off `process.env` by their consumers, so export them in the shell
that starts the server:

| Var | Read by | Meaning |
|-----|---------|---------|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `server/lib/transcript.ts` | Force the context-window size (tokens) used for the `%` bar |
| `CLAUDE_CREDENTIALS_JSON` | `server/lib/usage.ts` | OAuth creds blob for the usage bars when the host keychain isn't reachable (Docker — see [docker.md](docker.md)) |

## Hook-side (remote answers)

The remote-decision hooks run inside **Claude Code's** process, not the dashboard's — so
they read their own environment (e.g. exported in your shell profile), **not** the
dashboard's `.env`. Both `ask-remote-hook.sh` (`AskUserQuestion`) and `plan-remote-hook.sh`
(`ExitPlanMode`) resolve all three of these identically:

| Var | Default | Meaning |
|-----|---------|---------|
| `CLAUDE_DASHBOARD_URL` | `http://127.0.0.1:4173` | Where the hook looks for the dashboard |
| `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` | _(dashboard, else `600`)_ | Seconds the hook waits for a remote answer or reply. Governs `AskUserQuestion`, `ExitPlanMode`, and the `Stop` hook's turn-end reply hold. Keep the hook's `timeout` in `settings.json` above it. **Normally leave this unset** and use Settings → Answer window, which the hooks read off `/api/health`; setting it here wins and makes that control inert |
| `CLAUDE_DASHBOARD_IDLE_SECS` | _(dashboard, else `60`)_ | Seconds of keyboard idle before you count as "away". Below it a question goes straight to the terminal; governs questions, plans, and the `Stop` hook's reply window. `0` skips the check and always waits. **Normally leave this unset** and use Settings → Away after, which the hooks read off `/api/health`; setting it here wins and makes that control inert |

⚠️ If you set `CLAUDE_DASHBOARD_IDLE_SECS` or `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` in the `env`
block of `~/.claude/settings.json`, the Settings page detects each one and says so, but cannot
change it — the app never edits `~/.claude`. Remove it there to drive that number from the
dashboard. (`detectEnvOverride` in `server/lib/settings.ts` also checks the server's own
environment, and reports which of the two places it found.)

The hook also reads `~/.claude/hooks/dashboard-token` for the `ANSWER_TOKEN` value, if
you set one. Full setup in [remote-answers.md](../subsystems/remote-answer.md).

<!-- docs-sync:
  sources:
    - server/lib/config.ts
    - server/lib/transcript.ts
    - server/lib/usage.ts
    - scripts/ask-remote-hook.sh
    - .env.example
  kind: workflow
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
