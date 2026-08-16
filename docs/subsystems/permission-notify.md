---
docs-sync:
  sources:
    - server/lib/permissions.ts
    - server/index.ts
    - server/lib/scan.ts
    - scripts/permission-notify-hook.sh
    - client/src/components/PermissionBanner.tsx
  kind: subsystem
  verified: 8dc61663925c310e9517576f5c456b0c8b4b4516
---

# Permission prompts (the `allow?` pill)

When the CLI shows its interactive permission dialog — *"Do you want to allow Bash:
`pnpm dev`?"* — the dashboard shows a blue dot, an `allow?` pill on the row, and a banner in
the chat drawer naming the command. **Display-only**: you still answer in that terminal.

## Why it needs a hook at all

The dialog is drawn by the UI and **never written to the transcript**. The `tool_use` record
that triggered it *is* on disk (which is why `Session.activity` can name the command), but a
session parked on the dialog is byte-for-byte identical to a session whose tool is genuinely
running: `stop_reason: 'tool_use'` ⇒ `turnComplete: false` ⇒ recent + pending ⇒ green
`working`. Nothing on disk distinguishes "churning" from "blocked on you".

## Two signals, and which one to install

| Event | When it fires | Use it? |
|---|---|---|
| `PermissionRequest` | on the ask path, immediately before the prompt is drawn; carries `tool_name` + `tool_input` | **Yes** — this is the one |
| `Notification` (`notification_type: permission_prompt`) | ~6s after the dialog opens, cancelled if you answer first | legacy fallback |

`PermissionRequest` (matcher = tool name) fires only when a decision is genuinely needed, so
the event itself is the signal — no filtering, no delay, and it works in the desktop app.

`Notification` is scheduled on a timer and is emitted by fewer engines than you'd expect:

```js
let t = setTimeout((r) => { BV(…, {message: `Claude needs your permission to use ${r}`,
  notificationType: "permission_prompt"}) }, Xwn /* = 6000 */, e)
```

That call sits on the SDK/control-protocol path only from **CLI 2.1.233**. Older engines emit
it from the TUI dialog component instead, so a desktop-app session — which draws its own card
over the control protocol — fires nothing at all. Confirmed empirically: with only the
`Notification` hook installed, desktop sessions never once invoked it. `PermissionRequest`
exists on 2.1.229 and fixes exactly this.

## ⚠️ Why there is no answer button (and must not be one)

`PermissionRequest` *can* return a decision (`{decision:{behavior:"allow"|"deny"}}`), so unlike
before, the mechanism now exists. It stays unused deliberately:

- `behavior: "allow"` **bypasses the permission system entirely**. Wiring that to a LAN HTTP
  POST would turn the dashboard into a remote permission bypass — the exact thing the dialog
  exists to prevent. The transport here is HTTP plus an optional static token; that is a
  tripwire, not an authorization system.
- `deny`-with-reason can only *remove* an option. For a question that's a legitimate answer
  (see `remote-answer.md`); for a permission prompt it's just a rejection you could have made
  by ignoring it.

Hence `PermissionBanner` is a **sign, not a control** — no buttons, deliberately. Compare
[remote-plan](remote-plan.md), where the deny half *is* worth having because "send this plan
back with feedback" is a real instruction, not merely a refusal.

## The pieces

| Piece | What it does |
|---|---|
| `scripts/permission-notify-hook.sh` | Serves **both** events, keyed on `hook_event_name`. POSTs `{sessionId, message, permissionMode}` — the mode is read by the [push notifier](push-notify.md)'s auto-mode layer and is present on `PermissionRequest` but not always on the legacy `Notification` payload. Prints nothing, exits 0 always — for `PermissionRequest`, empty stdout means "no decision", so the prompt renders untouched |
| `POST /api/permissions/notify` | `servePermissionNotify` in `api.ts` — `tokenOk` 403, `ID_RE` 400, unknown session 404, else `notifyPermission()` followed by `maybeSend(config, 'permission', …)`. The route notifies inline rather than through `/api/notify/event`, because the hook is already POSTing here (see [push-notify](push-notify.md)) |
| `server/lib/permissions.ts` | RAM-only `Map<sessionId, {notifiedAt, message, timer}>`. No held socket, no resolve — a notify is a fact, not a wait |
| `scan.ts` `ScanOptions.permissionWaits` | injected `sessionId → notifiedAt`; sets `Session.permissionWait` and forces `status: 'question'` |
| `SessionRow` pill + `PermissionBanner` | mustard `allow?` pill (suppressed when `remoteQuestion` or `remotePlan` already owns the row) and the pinned drawer strip |

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

`remoteQuestion` → `remotePlan` → **dead** → `permissionWait` → `waitingOnQuestion` → the
2×2 (see [sessions](sessions.md)).

Below the liveness gate **on purpose**: a fire-and-forget notify is a fact about the past and
carries no evidence the session is still alive, unlike `pending.ts`'s held socket (which
outranks `lsof` precisely because the socket is open *now*). A session killed at its prompt
reads `idle`, not a permanent blue dot. Below `remoteQuestion` and `remotePlan` too, so a
session that somehow has both keeps the actionable `answer` / `plan?` pill rather than the
informational one.

## Install (manual, user-consented)

```bash
ln -s "$PWD/scripts/permission-notify-hook.sh" ~/.claude/hooks/permission-notify.sh
```

then **append** to the `PermissionRequest` hooks array in `~/.claude/settings.json` — and, if
you also run older/terminal engines, to `Notification` alongside whatever is already there (an
osascript banner, ntfy, …), never replacing it:

```json
{ "type": "command", "command": "bash \"$HOME/.claude/hooks/permission-notify.sh\"", "timeout": 5 }
```

Registering both is safe: one entry per session, so whichever arrives first shows the pill and
the second just re-arms it.

## Gotchas

- **`Notification` fires for more than permissions** (`idle_prompt`, auth, elicitation). Newer
  CLIs name the reason in `notification_type`; older payloads carry only `message`, so the hook
  takes `notification_type == "permission_prompt"`, **or** — when that field is absent
  entirely — a `message` containing `permission`. A *known* other type is never sniffed.
- **The hook targets the API port (4173), not Vite's 5173.** In dev the page is on 5173 but
  `/api` lives on the Node server; the hook talks to it directly. Override with
  `CLAUDE_DASHBOARD_URL`.
- **⚠️ `PermissionRequest` runs INLINE**, before the prompt is drawn — a slow hook delays the
  dialog you are about to look at. That is why the curl keeps its hard 1s cap and why this hook
  must never grow a wait (contrast `plan-remote-hook.sh`, which waits *on purpose*).
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
