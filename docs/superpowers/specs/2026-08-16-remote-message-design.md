# Remote messages (turn-end reply window) — design

Send free text into a live session from the dashboard. The third write path: after a
turn finishes while you are away, the session holds briefly; anything you type in the
chat drawer is delivered to the model, which continues with it as its next instruction.
No reply → the session stops exactly as it does today.

Approved 2026-08-16 (delivery model, window sizing, and sections A–D each confirmed via
dashboard remote answers).

## Verified mechanism (against CLI 2.1.233's binary, not docs)

These four facts are load-bearing; all were confirmed by grepping the installed
`~/.local/share/claude/versions/2.1.233` binary, because two documentation lookups
returned contradictory shapes:

1. **A Stop hook blocks with top-level JSON** `{"decision":"block","reason":"…"}`
   (exit 0). The CLI reads `decision==="block"` and feeds `reason` into the model's
   messages (`blockingErrors` → `messages:[…]`). It is NOT nested under
   `hookSpecificOutput` (that variant only carries `additionalContext`).
2. **Stop input carries `stop_hook_active`** (true when this stop follows a prior
   block), plus `session_id`, `permission_mode`, `last_assistant_message`,
   `background_tasks`, `session_crons`.
3. **The Stop hook re-fires after a blocked continuation** — consecutive blocks are
   counted and **capped at 8** (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8`), after which the
   CLI force-ends the turn with a warning. So a phone conversation is ≤8 replies per
   stretch; the cap is env-raisable.
4. **The CLI kills a hook at its configured `timeout`** — the Stop entry in
   `~/.claude/settings.json` must carry `"timeout": 630` (window + margin), same rule as
   the ask/plan hooks. A killed hook degrades to a normal stop.

## Non-goals

- **No mid-turn queue.** Text can only be sent while a hold is open (hold-window model
  was chosen over queue/hybrid). A queue can be added later without reshaping this.
- **No per-session mute/arm.** Gates are global, matching remote-answer.
- **No native delivery path.** If the CLI ever grows one, swap the hook's step-4 block,
  nothing else — same isolation promise as `ask-remote-hook.sh`.

## A. Hook — extend `scripts/stop-notify-hook.sh` in place

One Stop hook, not two: a second script would race the notify POST and double-push.
Same symlink name (`~/.claude/hooks/stop-notify.sh`), so existing installs gain the
feature by pulling — but holding requires the settings.json entry to add
`"timeout": 630` (update `docs/workflows/push-notify-setup.md`).

Flow (after today's CLAUDECODE/jq guards):

1. **Background-work guard unchanged**: `background_tasks`/`session_crons` in flight →
   exit 0 (no notify, no hold — the turn is not really "done").
2. **Health probe, 1s cap.** Down → exit 0.
3. **Gates** (identical resolution to `ask-remote-hook.sh`): `remoteAnswer === true`
   AND idle ≥ `idleSecs` (`CLAUDE_DASHBOARD_IDLE_SECS` > `/api/health.idleSecs` > 60;
   unreadable idle = at-desk; `0` = skip the check).
   - **Gates fail** → today's fire-and-forget `POST /api/notify/event` → exit 0.
     Server-side push policy applies exactly as now.
   - **Gates pass** → `POST /api/messages/wait` held open. Window = `answerSecs`
     (reuse: `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` > `/api/health.answerSecs` > 600;
     curl `--max-time` window+15). Body:
     `{sessionId, timeoutMs, permissionMode, stopHookActive}`.
4. **`stop_hook_active` no longer exits early.** It now only rides in the POST body so
   the server can skip the push mid-conversation. Re-holding on subsequent stops IS the
   chat loop; it cannot run away because each block requires fresh human input and the
   CLI caps consecutive blocks at 8.
5. Response `{status:"answered", reason}` → print `{"decision":"block","reason":<r>}`,
   exit 0. A **failed wait POST** (non-2xx — e.g. the feature flipped off between probe
   and POST) falls back to the plain notify POST first, so the "task finished" push
   never regresses. **Every other outcome exits 0** — dashboard down, feature off, timeout,
   dismissed, superseded, malformed, server restart. The feature only ever adds an
   option.

## B. Server

### `server/lib/messages.ts` — parallel store

Same state machine as `pending.ts`/`plans.ts` (deliberately a third parallel module,
per the documented "same machine, different payload, no discriminated union" rule):

```
register ─┬─ answer({text}) ────────→ answered   (reason = composeReason(text))
          ├─ answer({dismiss:true}) → dismissed  ("let it stop" — session ends now)
          ├─ deadline timer ────────→ timeout
          ├─ auto-release (idle<thr)→ released   (hook exits 0; session stops)
          ├─ register again ────────→ superseded
          └─ held socket closed ────→ cancelled  (no resolve)
```

API mirrors `plans.ts` exactly: `register(sessionId, timeoutMs, resolve) → messageId`
(`stopHookActive` stays in the handler — it only steers the push, never the store), `getPendingMessage(sessionId)` (returns `{messageId, askedAt,
expiresAt}` — `expiresAt` feeds the panel countdown), `messageSessionIds()`,
`answer(sessionId, body) → 'ok'|'not-found'|'mismatch'|'malformed'`,
`cancel(sessionId, messageId)`, `dismissAll()`, `resetStore()`. `TEXT_CAP = 4000`.

`composeReason(text)` (server-side, hook only echoes it):

> The user is away from the terminal and sent this follow-up from the dashboard;
> treat it as their next message: «text»
> Continue working on it now. Because they are still away: put any decision through
> the AskUserQuestion tool, never end the turn on a prose question, and prefer
> already-permitted tools — a permission dialog would park the session.

The suffix matters: `UserPromptSubmit` hooks (the remote-decision instruction) do NOT
fire on hook-continued turns, so the reason itself must carry the away-mode reminder.

### Auto-release on keyboard return

While the store is non-empty, a 5s interval calls `readIdleSecs()`
([notify.ts:161](../../../server/lib/notify.ts)); when idle < `idleSecs`, every entry
settles as `released` → hooks exit 0 → parked sessions stop within ~5s of you touching
the keyboard. Guards: unreadable idle (Docker/non-macOS) → never auto-release;
`idleSecs === 0` → check disabled (matches its "always wait" meaning). The interval is
started on first register and cleared when the store empties — an idle server spawns no
`ioreg`. Injected reader + fake timers in tests.

### Endpoints (handlers in `api.ts`, routes in `index.ts`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/messages/wait` | held; 400 malformed; 403 bad token; 404 feature off/unknown session; 405 |
| `GET` | `/api/sessions/:id/message` | `{pending: PendingMessage \| null}`; open like the question GET |
| `POST` | `/api/sessions/:id/message-answer` | `{messageId, text}` or `{messageId, dismiss:true}`; token-gated; 404 nothing waiting; 409 different message now waiting |

⚠️ Both `:id` routes `$`-anchored **above** the detail regex in `index.ts` — same trap
as chat/question/plan. Session id validated by `ID_RE` + `listTranscripts` resolution,
never joined into a path.

### Push + toggle integration

- `serveMessageWait` ends with `maybeSend(config, 'stop', …)` after registration —
  reusing the existing `stop` event (users' per-event switches keep meaning), body
  phrase `finished — reply window open`. Skipped when `stopHookActive` (you are already
  in the conversation). When the hook takes the notify-fallback path instead, the
  existing `/api/notify/event` flow is untouched — exactly one push source per stop.
- `POST /api/remote-answer` off → `dismissAll()` on all **three** stores.
- `serveHealth` unchanged — the hook already gets `idleSecs`/`answerSecs` from it.

### `shared/types.ts` (edited first — the contract)

`PendingMessage {messageId, askedAt, expiresAt}`, `SessionMessage {sessionId, pending}`,
`MessageAnswerRequest {messageId, text?, dismiss?}`, `MessageWaitResult {status:
'answered'|'timeout'|'dismissed'|'released'|'superseded', reason?}`, and
`Session.remoteReply: boolean`.

## C. Client

- **`MessagePanel`** — pinned action bar in `ChatDrawer`, mirror of `PlanPanel`:
  textarea, **Send**, **Let it stop** (dismiss → session ends now), countdown from
  `expiresAt`. No tap-to-send.
- **`usePendingMessage`** — mirror of `usePendingPlan`: polls the GET at `refreshMs`,
  phases `idle → submitting → submitted | gone`, reset keyed on `messageId` alone,
  404/409 → `gone`, 403 → the shared token prompt.
- **`scan.ts`**: `ScanOptions.messageIds` → `Session.remoteReply` + forces
  `status:'question'` (blue), injected from `messageSessionIds()` in `serveSessions` —
  same copied-Set pattern as `pendingIds`/`planIds`.
- **`SessionRow`**: pulsing `reply?` pill (styling twin of `plan?`), opens the drawer.
- Deep link unchanged — the push already lands in the drawer via `?session=<id>`.

## D. Tests, docs, risks

**Tests** (`test/`, node-assert, mirroring the pending/plans suites): store state
machine incl. `released` + supersede + late-cancel no-op; `composeReason` wording; the
auto-release reaper (injected idle reader, fake timers, `idleSecs=0` and `null` idle
guards); handler status codes + route order; push suppression on `stopHookActive`;
`dismissAll` joins the toggle.

**Docs**: new `docs/subsystems/remote-message.md` (differences-only, like
remote-plan.md); update `push-notify.md` (the `stop` event now enters at two routes;
suppression rule), `settings.md` (Answer window now governs three waits),
`docs/workflows/push-notify-setup.md` (`"timeout": 630` on the Stop entry),
`docs/overview.md`, and the `CLAUDE.md` tree (lib/messages.ts, MessagePanel).

**Risks / accepted limits**

- **Cap 8** consecutive replies per stretch, then the CLI force-ends the turn
  (raisable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Documented, not worked around.
- **Missing `timeout: 630`** in settings.json → CLI kills the hook mid-hold → session
  stops normally; a later Send finds nothing → 404 → panel shows "gone". Degrades, never
  wedges.
- **Esc at the terminal** during a hold interrupts the turn — that is the manual
  override at the desk, alongside the ~5s auto-release.
- **Docker / non-macOS**: unreadable idle means the hook treats you as at-desk, so the
  hold never engages (same opt-out as remote-answer; `idleSecs=0` opts in, and also
  disables auto-release).
- **Security widening**: steering was possible only when a session *asked* (question /
  plan); now every AFK turn-end accepts arbitrary instructions. Same posture:
  `ANSWER_TOKEN` gates the POSTs, tailnet is the perimeter, public tunnels need the
  token. Called out in the new subsystem doc.
