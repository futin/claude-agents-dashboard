# Installing the hooks, all five at once

`pnpm hooks:install` wires this repo's hooks into your own `~/.claude`. It replaces the
symlink-plus-settings-entry recipe that each of the five hook docs still carries, and it is
the recommended way in: those recipes are the explanation, this is the button.

```bash
pnpm hooks:install
```

Idempotent — re-run it after a `git pull`, after adding a hook, or when you are not sure
what state you are in. It prints one line per link and per settings entry, saying `ok` for
everything already correct.

```bash
pnpm hooks:install -- --dry-run     # print the plan, write nothing
pnpm hooks:install -- --uninstall   # remove this repo's links and entries
pnpm hooks:install -- --force       # replace a real file sitting on a link path
```

(Or call `scripts/install-hooks.sh` directly and skip the `--` that `pnpm` needs to stop
eating the flags.)

## What it does

**Five symlinks** into `~/.claude/hooks/` — links, never copies, so `git pull` updates the
hooks in place:

| Repo script | Installed as |
|---|---|
| `scripts/ask-remote-hook.sh` | `ask-remote.sh` |
| `scripts/plan-remote-hook.sh` | `plan-remote.sh` |
| `scripts/permission-notify-hook.sh` | `permission-notify.sh` |
| `scripts/stop-notify-hook.sh` | `stop-notify.sh` |
| `scripts/remote-decision-hook.sh` | `remote-decision.sh` |

**Six entries** in `~/.claude/settings.json`:

| Event | Matcher | Hook | Timeout |
|---|---|---|---|
| `PreToolUse` | `AskUserQuestion` | `ask-remote.sh` | 630 |
| `PermissionRequest` | `ExitPlanMode` | `plan-remote.sh` | 630 |
| `PermissionRequest` | — | `permission-notify.sh` | 5 |
| `Notification` | — | `permission-notify.sh` | 5 |
| `Stop` | — | `stop-notify.sh` | 630 |
| `UserPromptSubmit` | — | `remote-decision.sh` | 5 |

Six entries, five scripts: `permission-notify.sh` is registered twice on purpose —
`PermissionRequest` is the live signal, `Notification` the legacy fallback
([permission-notify](../subsystems/permission-notify.md)).

The 630s timeouts are load-bearing, not padding: a held hook must outlive the dashboard's
answer window (≤600s) or the CLI kills it mid-hold.

## Why an installer and not a checked-in `.claude/settings.json`

A project `settings.json` would wire itself on clone, which sounds strictly better and
isn't. **Registration has to be user-global for the feature to mean anything:** the
dashboard scans every project under `~/.claude/projects`, so a session in *any* repo
deserves a reply window. Project-scoped hooks fire only for sessions started in this repo
and silently drop every other one — the dashboard would keep listing those sessions while
quietly being unable to answer them.

It also keeps consent explicit. These hooks make network calls and one of them *blocks the
Stop event*; that belongs behind a command someone chose to run, not behind `git clone`.

## What it will not touch

- **A real file where a symlink should go.** Someone who copied and edited a hook keeps
  their copy; the installer says `SKIPPED` and tells you about `--force`.
- **An entry that already exists.** Including a timeout you have tuned by hand — presence
  is keyed on the command string, and a match is left exactly as it is.
- **Anything else in `settings.json`.** Other people's hooks, your `permissions`, your
  `model`. The previous file is copied to `settings.json.bak.<stamp>` before any write, and
  the new one is validated as JSON before it replaces anything.
- **Your token.** `~/.claude/hooks/dashboard-token` is written only if it does not exist
  *and* this checkout's `.env` has an `ANSWER_TOKEN` to copy. Otherwise you get the command
  to run yourself. It is never read from or written to the repo.

## After installing

Three things the installer cannot do for you:

1. **Set `ANSWER_TOKEN`** in `.env` (and in the token file) — it gates every write endpoint.
   See [remote-answer-setup](remote-answer-setup.md).
2. **Turn remote answering on** in the dashboard. It is off by default, and every hook
   checks it before doing anything ([remote-answer](../subsystems/remote-answer.md)).
3. **Point the hooks at the right port** if you are not serving on `127.0.0.1:4173` —
   export `CLAUDE_DASHBOARD_URL`. A hook that cannot reach the dashboard exits 0 within its
   1s probe, so the failure mode is "nothing happens", which is hard to tell from "not
   installed".

## Not macOS?

The hooks install and run, but the **at-desk gate does not work**: it reads keyboard idle
time via `ioreg`, which is macOS-only. Unreadable idle fails to "at the desk", so remote
questions and plans still travel to your phone, while the turn-end reply window
([remote-message](../subsystems/remote-message.md)) never opens. The installer prints this
warning on any non-Darwin host rather than letting you discover it as silence.

<!-- docs-sync:
  sources:
    - scripts/install-hooks.sh
    - scripts/stop-notify-hook.sh
    - scripts/ask-remote-hook.sh
    - scripts/plan-remote-hook.sh
    - scripts/permission-notify-hook.sh
    - scripts/remote-decision-hook.sh
    - package.json
  kind: workflow
-->
