---
docs-sync:
  sources:
    - scripts/ask-remote-hook.sh
    - server/api.ts
  kind: workflow
---

# Remote answers — per-machine hook setup

Wires the [remote-answer](../subsystems/remote-answer.md) hook into Claude Code on one
machine. Four steps, ~2 minutes. Needs `curl` and `jq` on the PATH.

Steps 2 and 3 live in `~/.claude/`, outside this repo, so they're per-machine. Only
step 1 travels with a clone.

## Steps

**1. Run the dashboard.** `pnpm dev` (or `pnpm build && pnpm start`). No `.env` needed —
remote answers are on by default. To answer from a phone, open the dashboard from that
phone over LAN or Tailscale (see [remote-access](../subsystems/remote-access.md)).

**2. Link the hook**, from the repo root. A symlink rather than a copy, so `git pull`
keeps it current:

```bash
mkdir -p ~/.claude/hooks && ln -s "$PWD/scripts/ask-remote-hook.sh" ~/.claude/hooks/ask-remote.sh
```

**3. Register it** in `~/.claude/settings.json`. Create the `AskUserQuestion` matcher if
you don't have one; keep any existing entry — hooks under one matcher run in parallel:

```json
{ "matcher": "AskUserQuestion", "hooks": [
  { "type": "command", "command": "bash \"$HOME/.claude/hooks/ask-remote.sh\"", "timeout": 630 }
]}
```

> ⚠️ That `timeout` **must** exceed the wait window (`CLAUDE_DASHBOARD_ANSWER_TIMEOUT`,
> default 600s), or the CLI kills the hook first and the window silently shrinks. Keep
> `timeout ≥ window + 30`.

**4. Verify the chain** without waiting for a real question:

```bash
curl -s localhost:4173/api/health
```

`{"ok":true,...,"remoteAnswer":true}` means the hook will engage — if `remoteAnswer` is
false, check the **phone answers** pill in the toolbar and `REMOTE_ANSWER` in your
config. Then drive the hook itself (`IDLE_SECS=0` forces the away branch, 20s window):

```bash
echo '{"session_id":"SID","tool_input":{"questions":[{"question":"Works?","header":"Test","options":[{"label":"Yes"},{"label":"No"}]}]}}' | CLAUDECODE=1 CLAUDE_DASHBOARD_IDLE_SECS=0 CLAUDE_DASHBOARD_ANSWER_TIMEOUT=20 bash ~/.claude/hooks/ask-remote.sh
```

Swap `SID` for a real id from `GET /api/sessions`. Open that session's chat drawer, tap
an option, and the command prints the `permissionDecision: "deny"` JSON that carries your
answer into a session. Silence after 20s means a gate stopped it.

## Verification

The end of step 4 **is** the verification: the health probe proves the server side, the
hook-drive test proves the whole chain (hook → held wait → drawer buttons → deny JSON)
without waiting for a real question.

## Failure modes

- **Nothing happens at all** — `jq` missing: **without `jq` the hook exits silently**,
  which looks exactly like "not installed". Check `jq --version` first.
- **Remote answering never engages** — you're not on macOS: gate 3 reads keyboard idle
  from `IOHIDSystem`; elsewhere that read fails, which counts as "at the desk". On
  Linux/WSL set `CLAUDE_DASHBOARD_IDLE_SECS=0` to skip the check — every question then
  waits for the dashboard until answered or timed out, and the panel's **answer in the
  terminal** button is your way back.
- **The window feels shorter than configured** — the `settings.json` `timeout` is below
  the wait window; the CLI kills the hook first (see the warning in step 3).
- **403 from the POSTs** — `ANSWER_TOKEN` is set server-side but missing/wrong in
  `~/.claude/hooks/dashboard-token` or the browser prompt (see the security section of
  [remote-answer](../subsystems/remote-answer.md)).
