# Remote answers (the first write path)

When a session calls `AskUserQuestion`, the [chat drawer](chat.md) can render its options
as buttons and deliver the pick **into the live session** — tap one on your phone and the
answer reaches the model. This is the single deliberate exception to the app's read-only
charter — and even here nothing is written to disk: the store is RAM only. The same
mechanism also holds a *finished* turn open for a free-text follow-up, the third write
path — see [remote-message](remote-message.md). Per-machine hook installation lives in
[remote-answer-setup](../workflows/remote-answer-setup.md).

## How it works

A `PreToolUse` hook fires on `AskUserQuestion` and offers the question to the dashboard,
holding the tool call while it waits. You answer in the drawer; the hook then denies the
tool call with a reason naming your choice, which the model reads and acts on. Everything
else — dashboard down, nobody answers in time, you hit **answer in the terminal** — falls
through to the normal terminal dialog, so the feature can only ever add an option, never
take one away. If the dashboard isn't running, the probe gives up in under a second.

- **Three gates, because a question can't be in both places.** The terminal dialog
  renders only once the hook exits, so "visible in the terminal" and "answerable from the
  phone" are mutually exclusive for one tool call. Three gates arbitrate — each with a
  single job, checked in this order by `ask-remote-hook.sh`:
  1. `REMOTE_ANSWER` env (`config.remoteAnswer` → `state.available`) — is the feature
     there at all? A hard kill switch; the toggle endpoint 409s while it's false.
  2. The **toggle** (`lib/remoteState.ts` → `state.enabled`) — accepting remote answers
     right now? Flipped from the toolbar pill or the [Settings tab](settings.md) (both read
     the same `/api/health` poll, so they never disagree). Switching it off also releases
     every hold in all three stores — `dismissAll() + dismissAllPlans() +
     dismissAllMessages()` — so waits already held are handed back instead of parked until
     their deadlines (~25ms measured).
  3. **Keyboard idle** — actually away? macOS `ioreg -c IOHIDSystem` `HIDIdleTime`,
     ~40ms. Below the threshold the hook exits 0 immediately, so at-the-desk behaviour is
     byte-for-byte the pre-hook behaviour. **Unreadable idle counts as at-desk** — never
     hide the dialog on a guess, which also means non-macOS effectively opts out unless the
     threshold is `0` (skip the check, always wait).

     The threshold resolves as `${CLAUDE_DASHBOARD_IDLE_SECS:-<idleSecs from /api/health>}`,
     falling back to 60 — so Settings → Away after drives it, an explicitly exported env var
     still wins, and an unreachable or older server behaves exactly as before. See
     [settings](settings.md) for the override trap that comes with that ordering.

  `state.remoteAnswer` (= `available && enabled`) is the only field the hook *acts* on from
  `/api/health`; the rest exists so the pill can explain *why* it's off, while `idleSecs` rides
  along for gate 3 and `answerSecs` for the wait that follows it. With everything on, sitting at
  your keyboard behaves exactly as before the hook existed — remote answering only engages once
  you've actually stepped away.

  Once the gates pass, **`answerSecs` sizes the wait** — how long the question stays answerable
  here before the hook gives up and the terminal dialog appears. Same three-fallback resolution
  as the threshold (`${CLAUDE_DASHBOARD_ANSWER_TIMEOUT:-<answerSecs from /api/health>}`, then
  600), so it is Settings → **Answer window**, and it drives `curl --max-time` *and* the
  `timeoutMs` the server arms its own deadline with. See [settings](settings.md) for the hook
  `timeout` ceiling that caps the UI at 600s.
- The POST body also carries **`permissionMode`**, which this feature never reads. It exists
  for the [push notifier](push-notify.md)'s auto-mode layer — the mode is visible only inside
  a hook payload, and a registered question is exactly where a push may be worth sending.
  Optional, so an un-upgraded hook keeps working.
- **⚠️ The gates are evaluated when the question is asked, not continuously.** Walking
  away after a question landed doesn't move it to the phone, and coming back doesn't move
  it to the terminal (the panel's dismiss button is the manual hand-back). Anything else
  would mean re-deciding mid-wait, which the deny-with-reason mechanism can't express.
- **Why deny-with-reason.** No hook (and nothing else outside the CLI) can *supply* an
  answer to `AskUserQuestion` — `updatedInput` is documented for Bash/Edit/Write only.
  The one supported injection is a `PreToolUse` hook returning
  `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
  permissionDecisionReason:"<prose>"}}`: the tool call is cancelled and the reason is fed
  to the model, which then continues with the stated choice. `composeReason` therefore
  always ends with "do not ask again" — a denied question is otherwise an invitation to
  re-ask.
- **The mechanism is isolated on purpose.** The server returns structured `answers`
  *plus* a ready-made `reason`; the hook only echoes `reason`. Swapping in a native
  answer path later means editing step 3 of `scripts/ask-remote-hook.sh` and nothing
  else.
- **Flow.** hook probes `GET /api/health` (1s cap) → `POST /api/questions/wait` **held
  open** → browser polls `GET /api/sessions/:id/question` →
  `POST /api/sessions/:id/answer` resolves the held response → hook prints the deny JSON.
  **Every** other outcome exits 0, which lets the terminal dialog appear: dashboard down,
  `REMOTE_ANSWER=false`, malformed anything, 403, no usable questions, timeout,
  dismissed, superseded, server restarted mid-wait.
- **The push rides on the same POST.** `serveQuestionWait` ends with
  `maybeSend(config, 'question', …)` — placed *after* registration on purpose, so a request
  that was refused (bad token, unknown session, no usable questions) never sends a push. It
  returns immediately; the held response above is unaffected either way. See
  [push-notify](push-notify.md).
- **One long-held request, not register-then-poll.** The held socket closing *is* the
  liveness signal (`res.on('close')` → `cancel`), so a killed hook or an interrupted
  session reaps its entry immediately; polling could not tell "between polls" from "dead"
  without TTL guesswork. A server restart resets the held socket → curl fails → terminal
  dialog. One failure path.

## Endpoints

Handlers `serveHealth` / `serveQuestionWait` / `serveSessionQuestion` /
`serveSessionAnswer` in `api.ts`:

| Method | Path | Codes |
|---|---|---|
| `GET` | `/api/health` | 200 `HealthResponse` = `{ok, ...RemoteAnswerState, origin?, idleSecs?, answerSecs?, transcribe?}` (`transcribe` is [dictation](dictation.md)'s engine-availability flag, unrelated to the gates) — the hook's probe (all three gates *and* the wait window off one round trip), the pill's read, and the origin badge's source |
| `POST` | `/api/remote-answer` | `{enabled}` → 200 `{...state, released}`; 400 non-boolean; 403 bad token; 409 `REMOTE_ANSWER=false`; 405 non-POST |
| `POST` | `/api/questions/wait` | held → 200 `WaitResult`; 400 malformed / no usable questions; 403 bad token; 404 unknown session or feature off; 405 non-POST |
| `GET` | `/api/sessions/:id/question` | 200 `SessionQuestion` (`pending: null` when idle); 400 bad id |
| `POST` | `/api/sessions/:id/answer` | 200; 400 malformed; 403 bad token; 404 nothing waiting (answered elsewhere / expired / hook gone); 409 a *different* question is waiting now; 405 non-POST |

## State machine

`lib/pending.ts`, pure + unit-tested via an injected `resolve`, so no HTTP types leak in.
One entry per session — the CLI only ever has one question open:

```
register ─┬─ answer(questionId ok) ──→ answered   (reason + structured answers)
          ├─ answer(dismiss:true) ───→ dismissed  ("answer in the terminal")
          ├─ sweepDecided(movedOn) ──→ dismissed  (the terminal card answered it)
          ├─ deadline timer ─────────→ timeout
          ├─ register again ─────────→ superseded (self-heals a re-asked question)
          └─ held socket closed ─────→ cancelled  (no resolve — nobody is listening)
```

Every transition deletes the entry and fires `resolve` **at most once**. The timer is the
guaranteed reaper, which is also the stale-answer guard: a late submit finds nothing →
404. A `cancel` with a stale `questionId` is a no-op, so a late socket close can't evict
a newer wait. Node is single-threaded and `answer` validates-deletes-resolves
synchronously, so two tabs racing means the first wins and the second gets a clean 404 —
no locking.

**The sweep is the *only* signal that the terminal card won** — it is not belt-and-braces
for the socket-close path. The question card renders *concurrently* with the hook, and when
you answer it there the CLI discards the hook's output without killing it: `curl` stays
connected, so no socket closes and no verdict ever arrives. Left alone the entry would sit
out its whole deadline while the dashboard kept offering picks nothing will read, and an
answer POSTed in that window would settle into an orphaned response. `sweepDecided(movedOn)`
releases it instead. `api.ts`'s `sweepTerminalDecisions` drives it off the scan tick and only
while holds exist — so an idle server does no extra IO — asking `scan.ts`'s `lastMessageMs`
whether the transcript has grown past the entry's `askedAt`. That is deliberately
`lastMessageTs` and not `lastTimestamp`: hook and queue records bump the file without a turn
happening, and treating one of those as a decision would yank a live question out of the
dashboard. It settles as `dismissed`, which is correct in both worlds — an orphaned hook
ignores it, and a hook still listening falls through to its card.

## Invariants

- **`sanitizeQuestions` / `validateAnswer` are tolerant like `parseChatRecord`:** ≤4
  questions × ≤4 options, length caps (question 2000 / label 200 / description 500 / one
  answer 500), malformed parts dropped, empty result → 400 → terminal dialog. Selected
  values are deliberately **not** matched against option labels — that is what makes the
  free-text "Other…" work, mirroring the terminal dialog's always-present Other.
- **⚠️ Route order:** the detail regex `/^\/api\/sessions\/([^/?]+)/` in `index.ts`
  swallows `/api/sessions/:id/<anything>` — the `question` and `answer` matches **must**
  stay above it (same trap as the chat route). They are `$`-anchored on `u.pathname` so
  it can't recur.
- **⚠️ Path safety:** unchanged from every other endpoint — `ID_RE` plus resolution
  against `listTranscripts(projectsRoot())`, **never joined into a path**. The store is
  keyed in memory.
- **⚠️ Hook timeout:** the CLI kills a hook at its `timeout`, so `settings.json` needs
  `"timeout": 630` ≥ curl's `--max-time` (window + 15) ≥ the server clamp (600s default,
  range 5s–30min). Each layer fails inward; a mis-set timeout degrades to the terminal
  dialog. Because the window is now editable from Settings, that ceiling is enforced in the
  UI too: the field offers 5–600s and warns above it (see [settings](settings.md)).
- **The toggle is the app's only disk write.** `.remote-answer.json` (gitignored,
  repo-root, cwd-relative) — needed because `tsx watch` restarts on every edit and a
  switch flipped before walking away must survive that. Deliberately **not** under
  `~/.claude` (read-only in Docker). Fails open: an unwritable path keeps the in-memory
  value and reports `persisted: false`, which the pill shows as `*`. A malformed/absent
  file falls back to the env default. The file is read **once per process** (`cached`),
  so hand-editing it while the server runs does nothing until a restart — flip it through
  the pill or `POST /api/remote-answer`, which updates both. It is cwd-relative, so a
  server started from another directory keeps its own state file.

## Security posture

These POSTs let any device on the LAN steer a live agent, and "Other…" free text reaches
the model verbatim. `ANSWER_TOKEN` (empty = open, matching the app's existing posture)
gates **both** POSTs with `Authorization: Bearer`; the `GET question` route stays open
since it reveals no more than the transcript already does. The hook reads the token from
`~/.claude/hooks/dashboard-token` (user-created — a server-generated file would fight the
read-only Docker mount; `chmod 600`); the browser persists it as `dashboard.answerToken`
and asks for it once. HTTP + a static token is a tripwire, not real auth.
`REMOTE_ANSWER=false` turns the feature off server-side. Over a tailnet the network
itself is the perimeter, so `ANSWER_TOKEN` can stay empty unless you share the tailnet —
behind a *public* tunnel it is the minimum (see [remote-access](remote-access.md)).

## Client surfaces

- **The pill** (`RemoteAnswerToggle`) sits after `.tb-spacer` in the Toolbar, next to the
  connection-origin badge. The Toolbar owns the `useRemoteAnswer` call and passes the
  control in as a prop, so the two pills share one `/api/health` poll instead of starting
  two (see [remote-access](remote-access.md)). Polled every 15s, not fetched once,
  because the *other* surface can flip it — turning it on from your phone should show up
  on the laptop without a reload. Renders as an inert `<span>` (not a disabled button)
  when `available` is false, so a config kill switch can't look like a stuck control. Its
  wording is "phone answers", never "instead of the terminal": on only *allows* remote
  answers, gate 3 still sends desk-time questions to the terminal.
- **`usePendingQuestion`** polls the question endpoint at the configured refresh rate
  (`useSettings().settings.refreshMs`, same cadence as `useSessionChat`; the response is a
  ~50-byte in-memory lookup). The reset-on-new-question effect is deliberately kept in its
  own `useEffect` keyed on `id` alone, while the poll's effect also depends on `refreshMs` —
  retuning the rate restarts the interval, and that must not wipe the panel of a question
  already on screen. Phase is
  `idle → submitting → submitted | gone`, tracked against the current `questionId` so a
  new question resets the panel and a stale banner never leaks across questions.
  404/409 → `gone` ("answered in the terminal, or it expired"), 403 → the token prompt.
- **Visible without the drawer.** `QuestionPanel` only exists inside `ChatDrawer`, so a
  held question used to be invisible unless you already had that exact session's drawer
  open, and the transcript-derived blue dot can't cover it (the wait is registered during
  `PreToolUse`, before the `tool_use` record is written). So `serveSessions` passes
  `pendingSessionIds()` into `scanSessions` as `pendingIds`: a flagged session gets
  `status: 'question'` plus `Session.remoteQuestion`, and `SessionRow` puts its chat tab into
  a pulsing amber `answer` — first in `chatTab()`'s precedence, so a question outranks every
  other hold (see [sessions](sessions.md#the-tab-is-also-where-a-session-says-it-needs-a-human)). The store is still RAM-only and still read-only
  here — the scan only reads the key set, and gets a copied `Set`, never the store's own.
  `scan.ts` does not import `pending.ts` (injection keeps it pure and testable).
- **`QuestionPanel` is an action bar, not a message** — pinned between `.chat-body` and
  `.chat-foot`, since the question text already renders in the transcript as the existing
  `<details open>` `AskUserQuestion` body. It is fed **only** by the pending store's
  structured options, never by re-parsing that markdown. Submit is gated until every
  question has a pick (no tap-to-send: no fat-finger sends from a phone). The deny reason
  will **not** appear as a chat message — `parseChatRecord` drops `tool_result` blocks by
  design — so the banner bridges the gap until the model's follow-up arrives on the
  normal 3s tail.

<!-- docs-sync:
  sources:
    - server/lib/pending.ts
    - server/lib/remoteState.ts
    - server/api.ts
    - scripts/ask-remote-hook.sh
    - client/src/components/QuestionPanel.tsx
    - client/src/components/RemoteAnswerToggle.tsx
    - client/src/hooks/usePendingQuestion.ts
    - client/src/hooks/useRemoteAnswer.ts
    - client/src/components/SessionRow.tsx
  kind: subsystem
  verified: 8326b88586603f5ad72061c686d3d33bd8f50f67
-->
