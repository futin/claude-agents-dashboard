---
docs-sync:
  sources:
    - server/lib/messages.ts
    - server/api.ts
    - server/index.ts
    - server/lib/scan.ts
    - scripts/stop-notify-hook.sh
    - client/src/components/MessagePanel.tsx
    - client/src/hooks/usePendingMessage.ts
    - client/src/components/SessionRow.tsx
  kind: subsystem
  verified: eeca21c754c09572be041a6806452abba4afe875
---

# Remote messages (the `reply?` tab)

When a session's turn ends while you are away, the [chat drawer](chat.md) can hold that
turn open for a short window and let you send free text back from your phone — the model
reads it as your next instruction and continues, exactly as if you had typed a follow-up at
the terminal. No reply, and the session just stops, same as it always has.

Mechanically this is [remote-answer](remote-answer.md) with a different hook event and a
different resolution shape: a hook holds something open, the browser resolves it, the hook
feeds your answer back into the model. Here the "something" is the whole turn rather than
one tool call, and the hook *blocks the stop with your text as the reason* instead of
denying a call. Read that doc first; only the differences are below.

## ⚠️ The block is top-level JSON, not `hookSpecificOutput`

`AskUserQuestion`'s deny and `ExitPlanMode`'s deny both nest under `hookSpecificOutput` (see
[remote-answer](remote-answer.md) and [remote-plan](remote-plan.md)). A `Stop` hook's block
does not:

```json
{"decision": "block", "reason": "…"}
```

exit 0. The CLI reads `decision === "block"` at the top level and feeds `reason` into the
model's next messages. The `hookSpecificOutput` shape for `Stop` exists too, but it only
carries `additionalContext` — background the model may or may not act on, not an
instruction it continues with. This was confirmed by grepping the installed CLI binary
(2.1.233) rather than trusting its docs, after two documentation lookups gave contradictory
shapes for a Stop block. Get the nesting wrong and the failure is silent, exactly like the
`PermissionRequest` trap `remote-plan.md` documents: the hook exits 0, the JSON is ignored,
and the turn just stops.

## Why `Stop`, not `PreToolUse`

A question or a plan holds one specific `tool_use` open — there is a call waiting for a
decision. A finished turn has no call to hold: `Stop` fires once the model has nothing left
to do, carrying `session_id`, `permission_mode`, `stop_hook_active`, `last_assistant_message`,
`background_tasks`, `session_crons` on stdin (also verified against the 2.1.233 binary).
There is nothing to *deny*, so the mechanism differs in kind, not just in shape: blocking a
`Stop` re-opens the turn, with `reason` delivered as the model's next message, rather than
cancelling a call the model already made.

One guard predates this feature and still runs first: `background_tasks`/`session_crons` in
flight means the turn is not really "done," so the hook exits 0 before even probing the
dashboard — no notify, no hold.

**`stop_hook_active` does not short-circuit the hold**, which is the one place this hook
stops mirroring its own past self. The plain notify path (`notify_fallback`) still exits
early on a re-fire, preserving the original push behaviour — but a phone conversation *is* a
sequence of re-fired, blocked stops, so the hold path holds on every one of them regardless.
`stopHookActive` still rides into the `/api/messages/wait` body, read for exactly one thing:
`serveMessageWait` skips the `stop` push when it's true, because you're already in the
drawer replying and do not need telling the turn finished again.

**⚠️ The CLI caps consecutive blocks at 8** (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`,
env-raisable). Past the cap it force-ends the turn regardless of what the hook returns, so a
phone conversation tops out at 8 replies per stretch. Documented as an accepted limit, not
worked around.

## The pieces

| Piece | What it does |
|---|---|
| `scripts/stop-notify-hook.sh` | Extended in place, not duplicated — a second hook would race the notify POST and double-push. Away + remote answers on → holds; otherwise the pre-feature `notify_fallback` path (`POST /api/notify/event`), byte-for-byte unchanged. Failed wait POST (non-2xx) also falls back to plain notify POST |
| `POST /api/messages/wait` | `serveMessageWait` — held open until an answer, a dismiss, the deadline, an idle release, or a supersede |
| `GET /api/sessions/:id/message` | `serveSessionMessage` — what the browser polls, at the configured refresh rate (`usePendingMessage` reads `refreshMs` from `useSettings`, exactly as `usePendingPlan`/`usePendingQuestion` do) |
| `POST /api/sessions/:id/message-answer` | `serveSessionMessageAnswer` — `{messageId, text}` or `{messageId, dismiss: true}`. Token-gated |
| `server/lib/messages.ts` | RAM-only store; same state machine as `pending.ts`/`plans.ts` with an injected `resolve`, plus the idle-release reaper below |
| `scan.ts` `ScanOptions.messageIds` | sets `Session.remoteReply` and forces `status: 'question'` (blue) |
| `SessionRow` tab + `MessagePanel` | the `reply?` label on the row's right-edge tab (same `row-chat answer` tone as `answer`/`plan?`, just different text) and the pinned drawer composer |
| `MicButton` | optional mic in the composer's action row — records, transcribes locally, and hands text back for you to edit before you tap send; see [dictation](dictation.md) |
| `chat.ts` `REMOTE_MESSAGE_RE` | unwraps the delivered follow-up back out of `composeReason` so it shows in the drawer as an ordinary user message — see below |

## Seeing what you sent

The reply reaches the model as a Stop **block**, not a user turn, and the CLI records that
as an `isMeta` user record: `Stop hook feedback:` followed by the whole `composeReason`
string. `chat.ts` drops `isMeta` records, so before this was handled the message you had
just typed on your phone never appeared in the drawer you typed it into — you saw the reply
to a prompt that wasn't there.

So `chat.ts` carries an anchored pattern for that one shape, strips the preamble and the
away-mode postamble, and emits your text alone as a normal user message. No marker: a
message you sent is a message you sent, however it got there. The pattern is duplicated
there rather than imported — the chat read path should not pull in this store — and
`chat.test.ts` imports the real `composeReason` so a drift in the prose below breaks a test
rather than the drawer. Anchored at both ends, so drift **fails closed**: the record goes
back to being dropped, never shown half-unwrapped. See [chat](chat.md).

## Why a third parallel store

Same reasoning [remote-plan](remote-plan.md) already gives for keeping plans out of
`pending.ts`: a different payload and different verdicts (free text vs. structured picks vs.
reject-only prose) would force a discriminated union through a module whose whole value is
being small and exhaustively tested. `messages.ts` stays parallel for the same reason, and
joins the other two in the same one place: `POST /api/remote-answer` off calls all three —
`dismissAll() + dismissAllPlans() + dismissAllMessages()` in `serveRemoteAnswerToggle` —
because a held reply window is exactly as remote as a held question or plan.

## The `released` status and the idle sweep

Coming back to the keyboard has to end every held turn quickly without you touching the
drawer — walking away is what opened the window, so walking back should close it. A
5-second `setInterval` (started on the first `register`, cleared once the store empties,
`unref()`d so it can't hold the process open) calls `sweepIdle()`:

1. No entries → no-op; an idle server never spawns `ioreg`.
2. `getSettings().idleSecs === 0` → the idle gate is disabled everywhere else, so it's
   disabled here too.
3. `readIdleSecs()` returns `null` (Docker, non-macOS) **or** a value still at-or-above the
   threshold → no-op. Unreadable idle is treated as "never guess you're back," not as "push
   anyway" — the opposite fail-direction from the notifier's own predicate (see
   [push-notify](push-notify.md#fail-directions)), because guessing wrong here ends a
   session early instead of merely sending an extra ping. Same direction `ask-remote-hook.sh`
   takes for the same reason.
4. Otherwise (a real reading below the threshold) → every open entry settles as `released`;
   each hook's held `/api/messages/wait` call returns with that status, exits 0, and the
   session stops — within ~5s of the first keystroke.

`released` is never pushed into the model — it is not an `answered` result, so the hook
never prints a block. It differs from `dismissed` (you chose "let it stop" from the panel)
only in who triggered it; both end the session the same way. Tests inject the idle reader
(`setIdleReader`) so nothing in `test/messages.test.ts` spawns a real `ioreg`.

## Endpoints

Handlers `serveMessageWait` / `serveSessionMessage` / `serveSessionMessageAnswer` in `api.ts`:

| Method | Path | Codes |
|---|---|---|
| `POST` | `/api/messages/wait` | held → 200 `MessageWaitResult`; 400 malformed / bad `sessionId`; 403 bad token; 404 feature off; 405 non-POST |
| `GET` | `/api/sessions/:id/message` | 200 `SessionMessage` (`pending: null` when idle); 400 bad id |
| `POST` | `/api/sessions/:id/message-answer` | 200; 400 malformed / bad id; 403 bad token; 404 nothing waiting; 409 a *different* window is open now; 405 non-POST |

**⚠️ No `sessionExists` on the wait**, unlike `serveQuestionWait`/`servePlanWait`. A `Stop`
hook fires as the turn ends — exactly when the transcript may not yet be flushed for the
scan to find it — so rejecting on an unknown session would drop the common case. Same
reasoning as `serveNotifyEvent`. The id is still shape-checked (`ID_RE`) and never joined
into a path; the store is keyed in memory, same as the other two.

**⚠️ Route order:** `/message` and `/message-answer` are `$`-anchored and sit above the
`:id` detail regex in `index.ts` — same trap as chat, question, and plan.

## Invariants

- **Text is required to answer.** A blank `text` (after trimming) is `malformed`, the same
  reasoning as a feedback-less plan reject: a bare send gives the model nothing to continue
  with. `dismiss: true` is the deliberate alternative to sending text, not a fallback for it.
- **`TEXT_CAP = 4000`.** `answer()` truncates before composing the reason, so the cap bounds
  your text specifically, not the fixed prose wrapped around it.
- **`composeReason` carries the away-mode reminder, not just the text.** The
  [remote-decision](remote-plan.md#the-away-mode-alternative-skip-plan-mode-entirely)
  `UserPromptSubmit` injection does not fire on a hook-continued turn, so the "put decisions
  through `AskUserQuestion`, don't end on a prose question, prefer already-permitted tools"
  reminder has nowhere else to ride — it is baked into every composed reason instead.
- **One entry per session**, same as the other two stores: a re-`register` supersedes rather
  than queues, so a retried or duplicated hook releases the older waiter instead of leaking
  it.
- **RAM-only.** A restart drops every hold; the parked sessions simply stop — the same
  degrade-never-wedge posture as `pending.ts`/`plans.ts`.

## Security posture

This is a wider surface than the question and plan write paths ([spawn](spawn.md), added
since, is wider still — it starts a session rather than steering one). A question or a plan is only
steerable from the phone when the session *asked* for one; a reply window opens at the end
of **every** AFK turn, so from the moment you step away, the model's next instruction on any
session can come from whoever can reach these POSTs — not just whoever answers something a
session raised. The posture itself is unchanged, not new: `ANSWER_TOKEN` gates
`/api/messages/wait` and `/api/sessions/:id/message-answer` exactly as it gates the question
and plan POSTs (see [remote-answer](remote-answer.md#security-posture)), and the tailnet is
still the intended perimeter — set the token if you share the tailnet, and treat it as the
minimum behind a public tunnel. What changes is how much a leaked token, or an unwanted LAN
guest, can do with it: previously "answer a question that already exists," now "hand a
parked session brand-new instructions."

## Install

Same symlink as [push-notify-setup](../workflows/push-notify-setup.md) — existing installs
gain this feature by pulling, since the hook is extended in place rather than replaced:

```bash
ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
```

but the `Stop` entry in `~/.claude/settings.json` now needs a `timeout`, which it did not
before:

```json
{ "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"", "timeout": 630 }
```

Before this feature the hook never waited — it POSTed with a 1s cap and exited, so no
`timeout` was necessary. Now it can hold for up to the answer window (≤600s), and the CLI
kills a hook at its configured `timeout` — so `630` (window + margin) is required, same
number and same reasoning as the ask/plan hooks. Miss it and a held turn dies mid-wait: the
session stops early, exactly as if the gates had failed, and a Send that lands after that
finds nothing (404 → the panel shows "gone"). Degrades, never wedges.
