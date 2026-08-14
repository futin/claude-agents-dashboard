---
docs-sync:
  sources:
    - server/lib/pending.ts
    - server/lib/remoteState.ts
    - server/api.ts
    - scripts/ask-remote-hook.sh
    - client/src/components/QuestionPanel.tsx
    - client/src/components/RemoteAnswerToggle.tsx
---

# Remote answers (optional)

When a session calls `AskUserQuestion`, the [chat drawer](chat-drawer.md) can show its
options as buttons — tap one on your phone and the answer goes into the **live session**.
This is the only part of the dashboard that writes anything, and the only part that needs
a hook installed in Claude Code.

## Setup

Four steps, ~2 minutes. Needs `curl` and `jq` on the PATH — **without `jq` the hook
exits silently**, which looks exactly like "not installed", so check that first if
nothing happens.

**1. Run the dashboard.** `pnpm dev` (or `pnpm build && pnpm start`). No `.env` needed —
remote answers are on by default. To answer from a phone, open the dashboard from that
phone over LAN or Tailscale (see [remote access](remote-access.md)).

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

> ⚠️ **macOS only, in practice.** Gate 3 (below) reads keyboard idle from `IOHIDSystem`.
> Elsewhere that read fails, which counts as "at the desk", so remote answering never
> engages. On Linux/WSL set `CLAUDE_DASHBOARD_IDLE_SECS=0` to skip the check — every
> question then waits for the dashboard until answered or timed out, and the panel's
> **answer in the terminal** button is your way back.

Steps 2 and 3 live in `~/.claude/`, outside this repo, so they're per-machine. Only
step 1 travels with a clone.

## How it works

A `PreToolUse` hook fires on `AskUserQuestion` and offers the question to the dashboard,
holding the tool call while it waits. You answer in the drawer; the hook then denies the
tool call with a reason naming your choice, which the model reads and acts on (there is
no supported way for a hook to *fill in* an answer — deny-with-reason is the mechanism).
Everything else — dashboard down, nobody answers in time, you hit **answer in the
terminal** — falls through to the normal terminal dialog, so the feature can only ever
add an option, never take one away. If the dashboard isn't running, the probe gives up in
under a second.

**A question can't be both places at once.** The terminal dialog only renders once the
hook exits, so three gates decide who gets the question — the third is the one that
matters day to day:

| Gate | Where | Question goes to |
|---|---|---|
| `REMOTE_ANSWER` | server config | `false` → terminal, always. Hard kill switch |
| **phone answers** toggle | dashboard toolbar | off → terminal, always. Off also releases anything already waiting |
| keyboard idle | the hook | **at your desk → terminal, instantly.** Away ≥ `CLAUDE_DASHBOARD_IDLE_SECS` (60s) → waits for your phone |

With everything on, sitting at your keyboard behaves exactly as before the hook existed.
Remote answering only engages once you've actually stepped away.

> ⚠️ Gates are checked when the question is *asked*. Walk away 10 seconds after a
> question lands and it's already the terminal's. The reverse is safe: **answer in the
> terminal** hands a waiting question back within a second.

A session with a waiting question shows a pulsing **answer** pill in its row and a blue
status dot — visible without the drawer open.

## Security

These POSTs let anyone on your LAN steer a live session — including free text ("Other…")
that reaches the model. On a shared network set `ANSWER_TOKEN` and put the same value in
`~/.claude/hooks/dashboard-token` (`chmod 600`); the browser asks for it once. Plain HTTP
with a static bearer token is a tripwire, not real auth. `REMOTE_ANSWER=false` turns the
feature off server-side. Over a tailnet the network itself is the perimeter, so
`ANSWER_TOKEN` can stay empty unless you share the tailnet — behind a *public* tunnel it
is the minimum (see [remote access](remote-access.md)).

## One file on disk

The toolbar toggle persists to a gitignored `.remote-answer.json` in the repo root,
because `tsx watch` restarts the server on every edit and a switch flipped before walking
away must survive that. It's the only thing this app writes, and it fails open.

State machine, endpoint table, and the design rationale:
[.claude/rules/remote-answer.md](../../.claude/rules/remote-answer.md).
