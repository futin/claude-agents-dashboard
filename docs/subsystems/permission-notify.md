---
docs-sync:
  sources:
    - server/lib/permissions.ts
    - server/index.ts
    - server/lib/scan.ts
    - scripts/permission-notify-hook.sh
    - client/src/components/PermissionBanner.tsx
  kind: subsystem
  verified: 806bf718d0d7efa721645dd30f36fe591c457d55
---

# Permission prompts (the `allow?` pill)

When the CLI shows its interactive permission dialog — *"Do you want to allow Bash:
`pnpm dev`?"* — the dashboard shows a blue dot, an `allow?` pill on the row, and a banner in
the chat drawer naming the command. **Display-only**: you still answer in that terminal.

## Why it needs a hook at all

The dialog is drawn by the TUI and **never written to the transcript**. The `tool_use` record
that triggered it *is* on disk (which is why `Session.activity` can name the command), but a
session parked on the dialog is byte-for-byte identical to a session whose tool is genuinely
running: `stop_reason: 'tool_use'` ⇒ `turnComplete: false` ⇒ recent + pending ⇒ green
`working`. Nothing on disk distinguishes "churning" from "blocked on you".

So the **`Notification` hook** is the signal: it fires exactly when the dialog appears.

## ⚠️ Why there is no answer button (and must not be one)

Unlike `AskUserQuestion` (see `remote-answer.md`), there is **no supported way for anything
outside the TUI to answer a permission dialog**. The CLI's only injection point is a
`PreToolUse` hook returning `permissionDecision`, and that doesn't work here:

- The hook fires on **every** tool call and cannot tell which ones would have prompted, so
  holding one open to offer it remotely would stall auto-allowed tools too.
- `permissionDecision: "allow"` **bypasses the permission system entirely**. Wiring that to a
  LAN HTTP POST would turn the dashboard into a remote permission bypass — the exact thing the
  dialog exists to prevent.
- `deny`-with-reason (the mechanism `remote-answer.md` uses) can only *remove* an option. For a
  question that's a legitimate answer; for a permission prompt it's just a rejection.

Hence `PermissionBanner` is a **sign, not a control** — no buttons, deliberately. If a native
"approve this call" path ever lands in the CLI, that is the moment to revisit; until then, an
approve button here would be a lie or a hole.

## The pieces

| Piece | What it does |
|---|---|
| `scripts/permission-notify-hook.sh` | `Notification` hook. Filters to permission prompts, POSTs `{sessionId, message}`, exits 0 always |
| `POST /api/permissions/notify` | `servePermissionNotify` in `api.ts` — `tokenOk` 403, `ID_RE` 400, unknown session 404, else `notifyPermission()` |
| `server/lib/permissions.ts` | RAM-only `Map<sessionId, {notifiedAt, message, timer}>`. No held socket, no resolve — a notify is a fact, not a wait |
| `scan.ts` `ScanOptions.permissionWaits` | injected `sessionId → notifiedAt`; sets `Session.permissionWait` and forces `status: 'question'` |
| `SessionRow` pill + `PermissionBanner` | mustard `allow?` pill (suppressed when `remoteQuestion` already owns the row) and the pinned drawer strip |

## ⚠️ Clearing is the scan's job, not the store's

The hook fires when the dialog **opens** and there is no second notification when it closes.
The clear comes from the transcript instead: answering the dialog — **allow or deny** — appends
a record (a `tool_result`, or on deny a `role:"user"` record whose content starts *"The user
doesn't want to proceed…"*). So:

```
permissionWait = flagged && !(lastMessageTs > notifiedAt)
```

The `tool_use` is stamped *before* the dialog appears, so while it's open `lastMessageTs <
notifiedAt` necessarily; the first record newer than the notify **is** the answer. Same host
clock on both sides, including Docker (containers share the host clock).

`PERMISSION_TTL_MS` (30 min) is a **backstop only**, for the paths that never append: session
killed at the prompt, dialog dismissed with Esc, notify lost. Don't shorten it into a primary
mechanism — a genuine "should I run this migration?" prompt can legitimately sit for an hour.

## Status ladder placement

`remoteQuestion` → **dead** → `permissionWait` → `waitingOnQuestion` → the 2×2
(see `session-status.md`).

Below the liveness gate **on purpose**: a fire-and-forget notify is a fact about the past and
carries no evidence the session is still alive, unlike `pending.ts`'s held socket (which
outranks `lsof` precisely because the socket is open *now*). A session killed at its prompt
reads `idle`, not a permanent blue dot. Below `remoteQuestion` too, so a session that somehow
has both keeps the actionable `answer` pill rather than the informational one.

## Install (manual, user-consented)

```bash
ln -s "$PWD/scripts/permission-notify-hook.sh" ~/.claude/hooks/permission-notify.sh
```

then **append** to the existing `Notification` hooks array in `~/.claude/settings.json` —
alongside whatever is already there (an osascript banner, ntfy, …), never replacing it:

```json
{ "type": "command", "command": "bash \"$HOME/.claude/hooks/permission-notify.sh\"", "timeout": 5 }
```

## Gotchas

- **`Notification` fires for more than permissions** (`idle_prompt`, auth, elicitation). Newer
  CLIs name the reason in `notification_type`; older payloads carry only `message`, so the hook
  takes `notification_type == "permission_prompt"`, **or** — when that field is absent
  entirely — a `message` containing `permission`. A *known* other type is never sniffed.
- **The hook targets the API port (4173), not Vite's 5173.** In dev the page is on 5173 but
  `/api` lives on the Node server; the hook talks to it directly. Override with
  `CLAUDE_DASHBOARD_URL`.
- **Fire-and-forget both ways.** Notification hook output is ignored by the CLI, and the curl
  is capped at 1s with `|| true`, so a down/unreachable dashboard cannot delay the dialog you
  are looking at. Every failure degrades to exactly the pre-hook behaviour.
- **RAM only.** A server restart drops every flag (fails open, rows read as before). No disk
  write — unlike `remote-answer.md`'s toggle, there's no state worth surviving a restart.
- **Token-gated** like the other POSTs (`ANSWER_TOKEN`, empty = open, hook reads
  `~/.claude/hooks/dashboard-token`). It steers no agent, but without the gate anyone on the
  LAN could light up rows.
- **Per-session, not per-call:** one entry per session id, a second notify supersedes the first
  and re-arms the TTL — matching the CLI, which shows one dialog at a time.
