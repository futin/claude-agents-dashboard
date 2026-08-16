---
docs-sync:
  sources:
    - server/lib/notify.ts
    - server/lib/settings.ts
    - server/lib/config.ts
    - server/api.ts
    - server/index.ts
    - scripts/stop-notify-hook.sh
    - client/src/lib/deepLink.ts
    - client/src/components/settings/SettingsView.tsx
  kind: subsystem
  verified: 03d7bbde0f76e700968e144af27cd6ddafd6e623
---

# Push notifications (ntfy)

The dashboard publishes a push to an [ntfy](https://ntfy.sh) topic when a session starts
needing you. Tapping it opens that session's chat. Off by default; every switch lives in
Settings → **Push notifications · every device**.

## Why this exists, and why it replaced the browser alerts

The dashboard used to ship its own in-browser layer: a `Notification` banner, a beep and a
tab-title count, fed by a poll diff and an SSE push stream. It could not reach an iPhone,
and no amount of configuration changed that. WebKit exposes **no `Notification` API in a tab
at all** — Safari *and* Chrome-on-iOS, which is the same engine — so permission read as
`'unsupported'` and the whole thing degraded to a count in a title you cannot see once you
have switched apps. That was the bug: the toggle looked on, and nothing ever arrived.

Doing it properly in the browser would need a web app manifest, a service worker,
`registration.showNotification()` (the `new Notification()` constructor does not exist on
iOS even inside an installed PWA), and — for anything to arrive while the app is closed —
VAPID Web Push with a subscription store. iOS also suspends backgrounded PWAs hard enough
that only true Web Push would be reliable.

ntfy sidesteps all of it: a native app already holds the push connection. The dashboard
only has to decide *when* to publish.

Once it landed, the browser layer was **deleted rather than kept as a fallback** — about 530
lines and 21 tests, including the SSE stream that existed only to feed it. On iOS it did
nothing; on a Mac it repeated the CLI's own notification on the same screen, so it was
duplication on the one platform where it worked at all. What survives is this, plus the row
colors you read when you are actually looking at the dashboard. The trade to know: a Mac
with no `NTFY_TOPIC` set now gets **no** ping from the dashboard — the CLI's own
notifications are the desk-side channel, and they fire on the machine running the session,
so a session in Docker or on a remote host posts nothing to your screen.

## Why the server sends, not the hooks

Three of the four events already arrive here as hook POSTs, at the moment they happen and
with exactly the granularity the user picks events at:

| Event | Enters at | Trigger |
|---|---|---|
| `question` | `POST /api/questions/wait` | `serveQuestionWait`, after the wait registers |
| `plan` | `POST /api/plans/wait` | `servePlanWait`, after the wait registers |
| `permission` | `POST /api/permissions/notify` | `servePermissionNotify` |
| `stop` | `POST /api/notify/event` | `scripts/stop-notify-hook.sh` |

Only `stop` needed a new route, because a finished turn registers nothing. So the whole
policy lives in one testable module instead of being re-implemented in four shell scripts —
which is what this replaced. The previous design kept a `CLAUDE_NTFY=1` prefix on one hook
command and an inline `curl` in another, and a slash command whose job was keeping those two
in sync by hand.

## The predicate

```
push(event) =
     notify.enabled                                    // master
  && notify.events[event]                              // per-event opt-in
  && (!requireRemoteAnswer || remoteAnswer)            // the dashboard toggle
  && (!requireAutoMode     || permissionMode is auto-ish)
  && (!requireAfk          || idle >= idleSecs)        // last: this one spawns ioreg
```

All AND, each layer independently optional. **Clause order is load-bearing**: `requireAfk`
is evaluated last and behind a thunk, so a policy that does not use it never pays the ~40ms
`ioreg` spawn. `test/notify.test.ts` asserts that directly.

`AUTO_MODES` is `auto`, `bypassPermissions`, `dontAsk` — deliberately duplicated from
`MODES` in `scripts/remote-decision-hook.sh` rather than shared: one is TypeScript and the
other is bash. Change one, change the other.

### Fail directions

Silence is the bug this feature exists to fix, so every failure gets an explicit direction.

| Failure | Direction | Why |
|---|---|---|
| `ioreg` unreadable (Docker, non-macOS) | **push anyway** | Failing silent reintroduces the missed notification. Note this is the *opposite* of `ask-remote-hook.sh`, which treats unreadable idle as at-the-desk — there a wrong guess hides a dialog, here it costs one extra push |
| `permissionMode` absent | **not auto-ish** | An unknown mode is not a known-auto mode |
| ntfy request fails or times out | **swallow — except in the test** | 2s cap, never awaited, never fails the caller. `sendTest` is the one send that *does* await the answer and reports a refusal (`HTTP 404: topic not found`) or an unreachable server, because a button whose job is proving delivery must be able to fail |
| session scan fails | **push with a short id** | A poor label beats no push |
| settings file unreadable | **all switches off** | Same fail-open read as the rest of `settings.ts` |

## The topic is a secret

`NTFY_TOPIC` and optional `NTFY_SERVER` live in `.env`, resolved by the usual
`process.env > .env > default` precedence. `notifyAvailable = topic !== ''`, mirroring how
`remoteAnswer` gates on `REMOTE_ANSWER`.

**No endpoint returns the topic.** ntfy topics are unauthenticated: the string is both the
address and the credential, so anyone who reads it can publish to your phone as well as
listen. `GET /api/settings` returns `notifyAvailable: boolean` and nothing else about it;
the Settings page can say "configured" and offer a test button, but cannot display or edit
the value. Changing it means editing `.env`.

`notifyAvailable: false` **disables the whole group** — every switch and the test button —
under one warning naming `NTFY_TOPIC`. Left live, they would flip, persist to
`.dashboard-settings.json` and read "On" while nothing could ever be sent, which is the
same invisible-failure this subsystem exists to remove. The rows stay visible rather than
hidden: they are how you learn the feature is there. Note what the flag does *not* claim —
it means a topic string exists, not that ntfy answers or that a phone is subscribed. The
second is only knowable by sending (hence the test button), the third only by looking at
the phone.

## What a push contains

Title `Claude Code`, body `<session label> — <event phrase>`. Never question text, plan
markdown, tool names, or any transcript content — the dashboard is where content is read.
`NotifyContext` deliberately has no field that could carry it, and a test asserts the
visible payload stays clean.

| Event | Body |
|---|---|
| `question` | `<label> — question waiting` |
| `plan` | `<label> — plan waiting for review` |
| `permission` | `<label> — permission dialog open` |
| `stop` | `<label> — task finished` |

The label comes from `scanSessions` (`sessionName || project`), resolved *after* the
predicate passes so the scan is never paid for a push that will not be sent. An id the scan
no longer covers falls back to its first 8 characters.

## Tapping the notification

ntfy's `Click` header carries `<DASHBOARD_PUBLIC_URL>/?session=<id>`.
`client/src/lib/deepLink.ts` consumes that once on load: force the Sessions section, seed
`chatId`, then `history.replaceState` the parameter away. You land in the chat drawer, where
`QuestionPanel`, `PlanPanel` and `PermissionBanner` already render — one tap from buzz to
answerable.

The parameter is stripped because session ids churn: a bookmarked or refreshed deep link
would otherwise reopen a drawer for a session that no longer exists. Same reasoning that
keeps `chatId` out of persisted state (`view-persistence.md`).

**`DASHBOARD_PUBLIC_URL` cannot be inferred.** A push is not triggered by a browser request,
so there is no `Host` header to read. It defaults to `http://localhost:<port>`, which works
at the desk and is useless on a phone — the tailnet hostname is what belongs there. Unset,
the push still sends, just without a `Click` header.

**This is the one relaxation of the no-content rule.** The session id and the dashboard's
address leave the machine, inside the link. Neither is work content, but together they point
at where the dashboard lives. On a tailnet-only deployment — the one this was built for —
that pointer is unusable without tailnet access. Expose the dashboard publicly and the
calculus changes.

## Answering "is it working?"

Every failure here is invisible from the outside: an off switch, a missing topic and a
dropped packet all look identical. So `POST /api/notify/test` fires one push **regardless of
policy** and returns what actually happened, including whether taps will open anything. The
Settings button surfaces that string verbatim.

## Deferred

**Per-session cooldown.** Four event types across several concurrent sessions could get
chatty. Not built; the predicate has an obvious place for it (a final clause over a
`Map<sessionId, lastSentAt>` ledger).

**iOS PWA / Web Push.** Still the only way to notify from the dashboard itself rather than
via ntfy. Manifest, icons, service worker, VAPID signing, subscription storage, and a second
server write path. ntfy makes it unnecessary for now.
