# Configuration

**Most of this is now optional twice over.** The [Settings tab](../subsystems/settings.md) edits
the row count, time windows, refresh rate, theme, idle threshold, answer window and
[push-notification policy](../subsystems/push-notify.md) from the browser, with no
restart — what follows are the *defaults* those settings start from, plus the things only a
config file can set (ports, feature kill switches, the shared token, the ntfy topic).

Copy `.env.example` to `.env` and edit. Everything is optional. Precedence: real
environment variables override `.env`, which overrides the defaults
(`server/lib/config.ts` `DEFAULTS`).

Config is read once, at startup, so an edited `.env` needs a restart to take effect.
`staleEnvKeys()` compares the file against what this process loaded and the Settings
tab names the keys that changed since — names only, never values, because some of them
are credentials.

## Server (`.env` or environment)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4173` | Port the API/prod server listens on |
| `WEB_PORT` | `5174` | Port the Vite dev UI serves on (`pnpm dev` only; prod ignores it). Deliberately not Vite's stock 5173, which another project usually holds. Set it only if 5174 is taken too |
| `MAX_SESSIONS` | `5` | How many sessions to show, most-recent first. **Per-browser override** in Settings → Sessions shown (sent as `?limit=`, capped at 50) |
| `ACTIVE_WINDOW_MIN` | `5` | A "recent" session is one whose last message is within this many minutes. **Per-browser override** in Settings → Active window (`?active=`, capped at 120) |
| `LOOKBACK_HOURS` | `48` | Only consider sessions modified within this many hours. **Per-browser override** in Settings → Lookback (`?lookback=`, capped at 168). Pinned projects (Management › Projects) ignore it for the project list |
| `SHOW_USAGE` | `true` | Show the account [usage bars](../subsystems/usage-limits.md) in the Sessions aside. `false` disables the fetch and the keychain read entirely |
| `SHOW_ANALYTICS` | `true` | Show the [Analytics tab](../subsystems/analytics.md) |
| `ANALYTICS_KEEP` | `5` | How many `/kaizen`-logged sessions the Analytics tab shows |
| `REMOTE_ANSWER` | `true` | Whether [remote answers](../subsystems/remote-answer.md) are available at all — the hard kill switch in front of every [session write path](../subsystems/remote-access.md#who-may-write), not just questions: [plans](../subsystems/remote-plan.md), [replies](../subsystems/remote-message.md), [spawn](../subsystems/spawn.md) and [dictation](../subsystems/dictation.md) each check it too. Gate-only writes ignore it: settings, pins, open folder, git fetch, codegraph runs and the push routes keep working with it off. It is the app's only *runtime* switch (the `CLAUDE_BIN`/`WHISPER_MODEL` kill switches are restart-scoped), which is why it covers the widest path rather than excluding it |
| `ANSWER_TOKEN` | _(empty)_ | Optional pass for **every** write endpoint, from any address: the [push](../subsystems/push-notify.md) routes the hooks POST to, [spawn](../subsystems/spawn.md), [dictation](../subsystems/dictation.md) and the settings write all sit behind the same gate (`grep -c 'refuseWrite(config, req, res)' server/api.ts`). This machine always writes without it, and a tailnet device does while Settings › Shared › Trust tailnet devices is on; anyone else needs it, and with it empty a LAN client is read-only ([remote-access](../subsystems/remote-access.md)). A hook on loopback needs no token file; one in a container or pointed at a non-loopback `CLAUDE_DASHBOARD_URL` needs the same value in `~/.claude/hooks/dashboard-token`, or it is refused — silently from the hook's side (`curl -sf`), but the server prints `[dashboard] rejected write: …` once per path per minute, and `/api/health` reports `tokenRequired` so `remote-decision-hook.sh` stops claiming remote answering is armed. `pnpm hooks:install` copies the value across and warns if the file already there disagrees |
| `ALLOWED_HOSTS` | _(empty)_ | Extra `Host` names the server and Vite dev answer, comma-separated: an exact name, a `.suffix` (also matches its apex) or `*` to disable the check. Loopback, IP literals, single-label names and `*.localhost` / `*.local` / `*.ts.net` never need listing — anything else is a 403, the [DNS-rebinding guard](../subsystems/remote-access.md#browser-side-guards). Needed only for a public tunnel (`.ngrok.app`, a Cloudflare hostname) |
| `USAGE_AUTO_REFRESH` | `true` | Renew an expired OAuth token by asking the CLI to, rather than showing the "token expired" hint. A kill switch, not a feature flag: renewal spawns `claude` and may spend one turn, so a host that wants neither sets `false` |
| `SKIP_PROC_SCAN` | _(auto)_ | Skip the `lsof` process-liveness gate. Defaults to `true` inside a Docker container, `false` otherwise |
| `NTFY_TOPIC` | _(empty)_ | ntfy topic for [push notifications](../subsystems/push-notify.md). Empty disables pushes outright. **Treat it as a secret** — the string is both the address and the credential, so anyone who learns it can publish to your phone as well as read it. Never returned by any endpoint. Step-by-step: [push-notify-setup](push-notify-setup.md) |
| `NTFY_SERVER` | `https://ntfy.sh` | Base URL of the ntfy server. Override for a self-hosted instance |
| `DASHBOARD_PUBLIC_URL` | _(empty)_ | How your **phone** reaches the dashboard, used for the notification's tap-through link. Cannot be inferred (a push has no `Host` header to read) — set it to your tailnet hostname. Unset, pushes still arrive but carry no `Click` header, so tapping one opens nothing; the Test push button says so rather than reporting a guess |
| `NTFY_TOPIC_DESK` | _(empty)_ | Optional second ntfy topic for the **desk** channel — the browser on this machine. Set it and a push raised while you are at the keyboard rings there instead of your phone; once you are idle past Settings → Away after (`settings.idleSecs`, the same threshold the remote-answer hooks use) it goes to the phone again. Exclusive, never both, and `0` for that threshold disables the desk branch rather than pinning it on. Empty (the default) means every push routes to `NTFY_TOPIC` exactly as before; a desk topic with no `NTFY_TOPIC` behind it is a misconfiguration, not a supported mode — the Test push button refuses it and real pushes stay off. **Treat it as a secret too** — unauthenticated like `NTFY_TOPIC`, so the string is both the address and the credential. Generate it (`openssl rand -hex 16`) rather than deriving it from `NTFY_TOPIC`, or leaking one leaks the other. Never returned by any endpoint |
| `DASHBOARD_LOCAL_URL` | `http://localhost:<PORT>` | How a browser **on this machine** reaches this server, used for the desk push's tap-through — which points at `/api/dismiss` and does nothing but close the tab it opened in. Unlike `DASHBOARD_PUBLIC_URL` this *is* defaulted, deliberately: a desk URL is by construction "this machine", so there is nothing to distinguish an absent value from a chosen one. The default holds in dev too, because `/api/dismiss` is an API route rather than a page, so `PORT` serves it whether or not Vite is running the UI. The desk channel needs no `DASHBOARD_PUBLIC_URL` and no tunnel — this link never leaves the machine. Set it only for a non-default host or port |
| `WHISPER_MODEL` | _(empty)_ | Path to a GGML whisper model. **Empty disables [dictation](../subsystems/dictation.md) outright** — the same "unset means off" rule `NTFY_TOPIC` uses for pushes. Setting it arms `POST /api/transcribe`, an endpoint that spawns processes on this machine, behind the same write gate as every other write (this machine, a trusted tailnet, or `ANSWER_TOKEN` above — see [dictation's security posture](../subsystems/dictation.md#security-posture) before setting this where other devices can reach it). Step-by-step: [dictation-setup](dictation-setup.md) |
| `WHISPER_BIN` | `whisper-cli` | The whisper.cpp CLI, resolved from `PATH`. Override with an absolute path for a non-`PATH` install |
| `FFMPEG_BIN` | `ffmpeg` | Transcodes the browser's recording (AAC or Opus) to the 16kHz mono WAV whisper.cpp requires. Resolved from `PATH`; override with an absolute path for a non-`PATH` install |
| `CLAUDE_BIN` | _(empty)_ | Path or `PATH` name of the `claude` CLI to spawn for a new headless session (see [spawn](../subsystems/spawn.md)). **Empty disables the whole feature outright** — the same "unset means off" rule `NTFY_TOPIC`/`WHISPER_MODEL` already use, rather than a separate on/off flag. Setting it arms `POST /api/spawn`, an endpoint that spawns a whole new `claude` process on this machine, behind the same write gate as every other write (this machine, a trusted tailnet, or `ANSWER_TOKEN` above) |
| `SPAWN_MAX_PERMISSION` | `auto` | The permission-mode ceiling every launch request is clamped to, no matter what the launch form asks for — ladder `plan < acceptEdits < auto < bypassPermissions`. **Security note:** raising this to `bypassPermissions` lets anything that can reach `/api/spawn` run a fully unsandboxed `claude` process on this machine with no permission prompts at all — only raise it on a machine and network you fully trust (see [spawn's security posture](../subsystems/spawn.md#security-posture)). A present-but-unrecognized value (e.g. a typo'd case) does **not** fail silently like the rest of this table: it falls back to `auto` but also logs a warning, because this is the one knob that bounds the feature's blast radius |
| `SYNC_PERMISSION_MODE` | `auto` | The permission mode Management › Git's Sync button launches git-sync with (see [git-stats](../subsystems/git-stats.md)). The button has no launch sheet, so this is the whole choice; `/api/health` publishes it clamped to `SPAWN_MAX_PERMISSION`, never above. An unrecognized value falls back to `auto` with the same warning |
| `ROUTINES_DIR` | `~/claude-global/routines` | The folder of [routine](../subsystems/routines.md) job files, one `<name>.md` each (`~` expands to `$HOME`). Baked into every installed job so the wrapper reads the same folder |
| `ROUTINE_MACHINE` | _(auto)_ | Which machine this is, `mac` or `wsl`; a job installs only where its `machines:` names it. Unset detects it the way `~/claude-global/bootstrap.sh` does (Darwin = `mac`, a `microsoft` kernel = `wsl`, anything else = `wsl`). Any other value shows as `bad ROUTINE_MACHINE` on the Routines chip and installs nothing |
| `ROUTINES_OWNER` | `false` | Opts this server in to owning the machine's OS jobs, `pins.json`, the lock sweep and the `routine-failed` pushes. Only one server per machine may (`~/.claude/routines/owner.json` is the lock); a second opted-in server runs read-only. Leave it unset on a worktree server, which copies `main`'s `.env` |
| `ROUTINES_STATE_ROOT` | _(empty)_ | **A verification seam, not a setting.** Moves the whole machine-local state folder (`~/.claude/routines`: run log, locks, launchd logs, `pins.json`, `owner.json`, `notified.json`) so a test or a branch check can run against a scratch tree. The installed wrapper does not carry it, so a server under the seam is never an owner (`ownedBy: 'seam'`) and installs nothing. See [routines](../subsystems/routines.md#test-seams) |

The four routine keys were `SCHEDULES_DIR`, `SCHEDULE_MACHINE`, `SCHEDULES_OWNER` and `SCHEDULES_STATE_ROOT` before 2026-10-23. Those names are still
read when the new one is unset, so an older `.env` needs no edit; see [routines](../subsystems/routines.md#renamed-from-schedules-2026-10-23).

## Process-environment only (not read from `.env`)

These are read straight off `process.env` by their consumers, so export them in the shell
that starts the server:

| Var | Read by | Meaning |
|-----|---------|---------|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `server/lib/transcript.ts` | Force the context-window size (tokens) used for every session's `%` bar — a global override in the *dashboard's* env. A session's own window belongs in its settings files (`autoCompactWindow`), which `server/lib/compact-window.ts` reads per session |
| `CLAUDE_CREDENTIALS_JSON` | `server/lib/usage.ts` | OAuth creds blob for the usage bars when the host keychain isn't reachable (Docker — see [docker.md](docker.md)) |
| `RUN_ROUTINE_GRACE_MS` | `plugin/lib/run-routine.mjs` | A test seam for the wrapper's 10 s SIGTERM-to-SIGKILL grace on a stopped step. Never baked into an installed job, so it is only ever set by a test |

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
you set one — only a hook that reaches the dashboard off loopback needs it. Full setup in [remote-answers.md](../subsystems/remote-answer.md).

The hooks also stand down for a routine step: `plugin/lib/run-routine.mjs` stamps `CLAUDE_DASHBOARD_ROUTINE=<job>` on its child, and `ask-remote-hook.sh`
(like every hook here but `kill-guard.sh`) exits without a hold or a push when it, or the older `CLAUDE_DASHBOARD_SCHEDULE`, is set. Never set it by hand;
see [hooks-setup](hooks-setup.md#routine-runs).

<!-- docs-sync:
  sources:
    - server/lib/config.ts
    - server/lib/transcript.ts
    - server/lib/usage.ts
    - scripts/ask-remote-hook.sh
    - .env.example
  kind: workflow
  verified: 24f8d773dd459e02b1e4ef4a093aed285939555c
-->
