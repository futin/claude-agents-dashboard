# Push notifications (ntfy)

The dashboard publishes a push to an [ntfy](https://ntfy.sh) topic when a session starts
needing you. Tapping it opens that session's chat. Off by default; every switch lives in
Settings → **Push notifications · every device**. Per-machine setup — choosing a topic,
subscribing the phone, the Stop hook — lives in
[push-notify-setup](../workflows/push-notify-setup.md).

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

What ntfy did **not** solve was which device rings. Everything above is about reaching the
phone; at the desk that is the wrong device. That gap is what desk routing below closes — by
adding a second ntfy topic rather than a second transport, so the desktop path inherits the
`Click` deep link that already worked on mobile.

Once it landed, the browser layer was **deleted rather than kept as a fallback** — about 530
lines and 21 tests, including the SSE stream that existed only to feed it. On iOS it did
nothing; on a Mac it repeated the CLI's own notification on the same screen, so it was
duplication on the one platform where it worked at all. What survives is this, plus the row
colors you read when you are actually looking at the dashboard. The trade to know: a Mac
with no `NTFY_TOPIC` set now gets **no** ping from the dashboard — the CLI's own
notifications are the desk-side channel, and they fire on the machine running the session,
so a session in Docker or on a remote host posts nothing to your screen.

## What came back: one narrow browser layer

The deletion above was right about every session it was judging — and it was judging every
session that existed at the time. A **headless session spawned from the dashboard** (the cyan
`dashboard` pill, `surface: 'dashboard'`) is the one class with no desk-side channel at all:
there is no CLI in front of it, so there is no CLI notification to duplicate. That is the whole
argument, and it is why this layer is scoped to exactly that surface and nothing else —
`notifyKind` in `client/src/lib/webNotify.ts` returns `null` for every other row before it looks
at anything else. Settings → **Notify this browser · this device**, off by default.

Three events, not four:

| Hold | Banner | Why |
|---|---|---|
| `remoteQuestion` | `<label> — question waiting` | answerable from the drawer |
| `remotePlan` | `<label> — plan waiting for review` | revisable from the drawer |
| `remoteReply` | `<label> — finished — reply window open` | the window is open here |
| `permissionWait` | **never** | a headless run has no TTY, so there is no dialog to answer — a banner would be asking for something impossible (see [spawn](spawn.md)) |

The three bodies are asserted against literals in `test/web-notify.test.ts` precisely because
they mirror `PHRASE` above: the desk channel and the away channel should read alike, and a
drift apart should fail a test rather than be discovered by someone holding a phone in one
hand and a laptop in the other.

**The banner's only styling is its icon.** Title, body, `tag`, `silent` and `icon` are the
entire surface a Web Notification exposes; the banner itself is drawn by the OS and no CSS
reaches it. So the icon carries the whole visual signal: a 64×64 canvas disc in the live theme
token (`--amber` question, `--cyan` plan, `--mustard` reply) with a solid glyph on it — `?`,
`▸` for the plan going out, `◂` for the reply coming back. Anything hairline vanishes at the
~20px the OS draws it at. `silent: true` is deliberate and paired with our own single `beep()`
per batch: one sound per batch whatever the OS would have done, and the beep still fires when
the banner is blocked.

The header's `N need you` pill is a different thing wearing a similar name: **it counts every
surface, not just headless ones.** It mirrors the row tabs (`answer` / `plan?` / `reply?` /
`allow?`) one for one, because a count labelled "need you" that omitted a row visibly saying it
needs you would be worse than no count. Same precedence ladder, `holdKind` in
`client/src/lib/holds.ts`, shared with the row tabs so the two cannot drift.

### Where it cannot reach

Written down rather than fixed — each one is a real limit of riding the existing poll, and ntfy
is the channel that has none of them:

1. **The poll's window.** Only the top `maxSessions` sessions by recency are in the payload at
   all (default 5). A sixth parked session announces nothing.
2. **Section-bound.** `SessionsView` owns the poll and unmounts on a section switch, so nothing
   fires while you sit on Management, Analytics, Usage or Settings. Chosen over lifting the poll
   to the shell, which would poll every 3s on every section and turn a contained feature into a
   shell-wide change.
3. **Hidden tabs are throttled.** A background tab's timers can stretch to ~1/minute, so a
   banner can be up to a minute late.
4. **iOS gets nothing**, on purpose. `Notification` does not exist in a WebKit tab, so the whole
   Settings group is absent there rather than present and dead — a switch that reads On while
   nothing can fire was the original bug. ntfy is that platform's channel.

## Why the server sends, not the hooks

Three of the four events already arrive here as hook POSTs, at the moment they happen and
with exactly the granularity the user picks events at:

| Event | Enters at | Trigger |
|---|---|---|
| `question` | `POST /api/questions/wait` | `serveQuestionWait`, after the wait registers |
| `plan` | `POST /api/plans/wait` | `servePlanWait`, after the wait registers |
| `permission` | `POST /api/permissions/notify` | `servePermissionNotify` |
| `stop` | `POST /api/notify/event` **or** `POST /api/messages/wait` | `scripts/stop-notify-hook.sh` — the plain fallback route at the desk / feature off, the [reply-window](remote-message.md) hold route away with remote answers on (headless sessions take the hold route at the desk too) |

All four are token-gated (`tokenOk`), so a hook that cannot read the token file reaches
none of them — see the last row of [Fail directions](#fail-directions).

Only `stop` needed a new route, because a finished turn registers nothing. So the whole
policy lives in one testable module instead of being re-implemented in four shell scripts —
which is what this replaced. The previous design kept a `CLAUDE_NTFY=1` prefix on one hook
command and an inline `curl` in another, and a slash command whose job was keeping those two
in sync by hand.

`stop` now enters at *two* routes because the hook itself branches (see
[remote-message](remote-message.md)): `serveMessageWait` calls `maybeSend(config, 'stop', …)`
with a phrase override, `finished — reply window open`, so the two routes read differently
even though both fire the same `stop` event and the same per-event switch. That call is
skipped outright when the hook reports `stopHookActive` — a re-fire mid phone-conversation,
where you are already in the drawer and do not need telling the turn finished again. This is
a suppression the *route* applies before the predicate below ever runs, not a new clause in
`shouldNotify` itself.

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

### The predicate is not the only AFK gate

`requireAfk` off does **not** make every event unconditional, and the difference is invisible
from this module. `question` and `plan` reach `maybeSend` only because a hook POSTed to
`/api/questions/wait` or `/api/plans/wait` — and `ask-remote.sh` / `plan-remote.sh` each run
their *own* idle check before that POST:

```
ask-remote.sh
if [ "$IDLE_MIN_S" != "0" ]; then
  IDLE_S=$(ioreg -c IOHIDSystem …)
  *) [ "$IDLE_S" -lt "$IDLE_MIN_S" ] && exit 0 ;;   # at the desk → terminal dialog
```

At the desk the hook exits, the POST never happens, and the server never learns a question
exists — so the predicate is never evaluated at all. `permission` has no idle check in its
hook, so it really does become unconditional. `stop` is the mixed case: `stop-notify-hook.sh`
now runs the same idle check `ask-remote.sh` does, but only in front of the *hold* route —
at the desk it falls through to the plain `notify_fallback` POST instead of exiting, so a
push attempt reaches the predicate either way. One exception on the routing side: a
**headless** session (a dashboard spawn) skips that idle check entirely and takes the hold
route at the desk too, because there is no terminal to type the follow-up into. "Headless"
is **not** simply "no controlling TTY": the desktop app runs the CLI with no pty and still
puts a composer in front of you, so the hook exempts it by entrypoint
(`CLAUDE_CODE_ENTRYPOINT=claude-desktop`) and the TTY verdict stands for everything else.
Only entrypoints measured to be interactive are listed, so an unfamiliar one still fails
closed to headless. Push eligibility is unchanged; only which route reached the notifier. The hook's check gates which route fires
(and so which phrase and suppression rule apply), not whether `stop` pushes at all — see
[remote-message](remote-message.md).

| Event | Idle gate in its hook | `requireAfk` off ⇒ always pushes? |
|---|---|---|
| `question` | yes — `ask-remote.sh` | **no**, still needs `idleSecs` of idle |
| `plan` | yes — `plan-remote.sh` | **no**, still needs `idleSecs` of idle |
| `permission` | none | yes, but see the two route-level suppressions in [permission-notify](permission-notify.md): one dialog reported twice pushes once, and a dialog that follows a wait the user handed to the terminal does not push at all |
| `stop` | only gates hold vs. fallback routing, not push eligibility | yes, from either route |

Not a bug in the layering: remote answering *is* an away-feature, and a question answered at
the terminal has no remote counterpart to notify about. But the Settings switch reads as
"always push" and cannot mean that for two of the four events, so `SettingsView` renders a
callout in exactly that state, and `Away after` says so in its hint. Setting `idleSecs` to 0
removes the hook gate too — at the cost of the terminal dialog, which then never appears.

`AUTO_MODES` is `auto`, `bypassPermissions`, `dontAsk` — deliberately duplicated from
`MODES` in `scripts/remote-decision-hook.sh` rather than shared: one is TypeScript and the
other is bash. Change one, change the other.

### Fail directions

Silence is the bug this feature exists to fix, so every failure gets an explicit direction.

| Failure | Direction | Why |
|---|---|---|
| `ioreg` unreadable (Docker, non-macOS) | **push anyway** | Failing silent reintroduces the missed notification. Note this is the *opposite* of `ask-remote-hook.sh`, which treats unreadable idle as at-the-desk — there a wrong guess hides a dialog, here it costs one extra push |
| `permissionMode` absent | **not auto-ish** | An unknown mode is not a known-auto mode |
| ntfy request fails or times out | **swallow — except in the test** | 2s cap, never awaited, never fails the caller — `maybeSend` `void`s the promise and catches it, since an un-awaited rejection would escape the surrounding `try` and take the process down. `sendTest` is the one send that *does* await the answer, distinguishing a refusal (`<server> refused it (HTTP 404): …  — check NTFY_TOPIC`, the first line of ntfy's own body) from an unreachable server (`couldn't reach <server>: …`), because a button whose job is proving delivery must be able to fail |
| session scan fails | **push with a short id** | A poor label beats no push |
| settings file unreadable | **all switches off** | Same fail-open read as the rest of `settings.ts` |
| hook POST rejected `403 bad token` | **swallowed by the hook — but the server says so** | The four entry routes are `tokenOk`-gated like every other write path, and the hooks read the token from `~/.claude/hooks/dashboard-token`. Missing or wrong there while `ANSWER_TOKEN` is set server-side, and every POST is refused before `maybeSend` runs; the hooks use `curl -sf`, so the 403 is still swallowed and the CLI itself never mentions it. What changed after this cost twelve silent hours: `tokenOk` now prints `[dashboard] rejected write: POST <path> (bad or missing token)` once per path per minute, and `/api/health` carries `tokenRequired`, which `remote-decision-hook.sh` uses to refuse to claim remote answering is armed when the token file is absent. Neither carries the token. The Settings switches still read On and `notifyAvailable` still reports `true` — both describe the topic, not the token — so if nothing arrives and the test button works, read the server's output, then check the token file ([remote-answer-setup](../workflows/remote-answer-setup.md#failure-modes)) |

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
| `stop` | `<label> — task finished`, or `<label> — finished — reply window open` on the [reply-window](remote-message.md) hold route |

`ctx.phrase` is the one per-send override this table's default `PHRASE[event]` lookup
allows — `maybeSend` uses it when given, so the same `stop` event reads differently
depending on which route produced it, without becoming a fifth event type.

The label comes from `scanSessions` (`sessionName || project`), resolved *after* the
predicate passes so the scan is never paid for a push that will not be sent. An id the scan
no longer covers falls back to its first 8 characters.

## Tapping the notification

ntfy's `Click` header carries `<DASHBOARD_PUBLIC_URL>/?session=<id>`.
`client/src/lib/deepLink.ts` consumes that once on load: force the Sessions section, seed
`chatId`, then `history.replaceState` the parameter away. You land in the chat drawer, where
`QuestionPanel`, `PlanPanel`, `MessagePanel` and `PermissionBanner` already render — one tap
from buzz to answerable. That last one is why the reply-window `stop` push carries a link at
all: the panel it lands you in is the composer the hold is waiting on.

The parameter is stripped because session ids churn: a bookmarked or refreshed deep link
would otherwise reopen a drawer for a session that no longer exists. Same reasoning that
keeps `chatId` out of persisted state (`view-persistence.md`).

**`DASHBOARD_PUBLIC_URL` cannot be inferred.** A push is not triggered by a browser request,
so there is no `Host` header to read — the tailnet hostname is what belongs there. Unset, it
stays **empty** and the push still sends, just without a `Click` header.

It briefly defaulted to `http://localhost:<port>` instead, "so the link at least works at the
desk". That silently disabled the two places that handle an absent value: `clickUrl` could
never return `''`, so every push carried a link only the server's own machine could open, and
`sendTest`'s "you never set this" warning became unreachable — the test button reported the
synthesized localhost URL exactly as it reports a configured one. A push exists to reach the
device you are *not* sitting at, so an absent value has to stay distinguishable from a chosen
one rather than be guessed.

**This is the one relaxation of the no-content rule.** The session id and the dashboard's
address leave the machine, inside the link. Neither is work content, but together they point
at where the dashboard lives. On a tailnet-only deployment — the one this was built for —
that pointer is unusable without tailnet access. Expose the dashboard publicly and the
calculus changes.

## Desk routing: which device rings

With an `NTFY_TOPIC_DESK` set, a push raised **while you are at the keyboard** goes to that
topic instead of `NTFY_TOPIC`. Walk away past Settings → "Away after" and it goes back to the
phone. Unset — the default — every push behaves exactly as the rest of this document
describes, including the number of `ioreg` spawns per push.

**Exclusive, never both.** `settings.idleSecs` is already tuned for the remote-answer hooks,
and a double-buzz on every alert is a worse default than the rare missed one: an alert raised
while you are at the desk does not reach the phone if you walk away ten seconds later.

The rule is `atDesk(idleSecs, thresholdSecs)` in `notify.ts` — one predicate, three callers:
`backAtDesk()` releasing held waits, the `requireAfk` clause suppressing a push, and this
routing. Three cases fall back to the **phone**, all meaning "cannot tell":

| Reading | Routes to | Why |
|---|---|---|
| idle ≥ threshold | phone | you are away — the phone is the point |
| `null` (Docker, non-macOS) | phone | unreadable; the phone works without a browser running |
| `idleSecs === 0` | phone | zero disables the idle gate everywhere else, so it disables this |

**The desk topic has no `NotifyPolicy` of its own** — it mirrors the phone's events. This is
routing, not a second policy, so nothing in `NotifyPolicy`, `DEFAULT_NOTIFY`, `mergeNotify` or
the settings file moved, and there is no migration.

**One `ioreg` per push.** `PredicateContext.readIdle` is a thunk precisely so a policy without
`requireAfk` never pays ~40ms for a reading it will not use. Routing wants the same reading, so
`maybeSend` memoises it: two consumers, at most one spawn — and still zero when neither wants
it, because `ntfyTopicDesk` is checked before the thunk is touched. `test/notify.test.ts`
counts the calls; deleting the memoisation takes that count to 2.

## Tapping a desk push does nothing, on purpose

The desk push carries `Click: <DASHBOARD_LOCAL_URL>/api/dismiss`, and that page's only job
is to close the tab it arrived in. **The desk notification is an alert, not a deep link** —
it tells you a session needs you; you navigate yourself.

That is a choice, not a limitation, and it is worth knowing why it is not simply "no click
action". ntfy's service worker always acts on a click:

- with a `Click` header it `self.clients.openWindow(r.click)`;
- **without** one it falls to `t?t.focus():…:self.clients.openWindow(o)` where `o` is
  `https://ntfy.sh/<topic>` — it opens its own topic page and leaves that tab behind.

Verified against `https://ntfy.sh/sw.js` on 2026-09-04. So an inert notification is not on
offer; pointing at a self-closing page is the closest thing, and a tap becomes a flash.

The tab can close itself because `clients.openWindow` gives it a single history entry and no
opener, satisfying Blink's rule (`LocalDOMWindow::close`: closable when opened by DOM **or**
the back/forward list has one entry). Confirmed in real use. The page falls back to "You can
close this tab." for an engine that refuses.

**A deep link was built here first, worked, and was removed.** `/api/focus` recorded the
tapped session, the dashboard tab claimed it on a poll and opened that session's drawer, and
the throwaway tab closed — verified end to end. It cost a store, three endpoints, a client
poll and its own failure modes (a stale tab that claimed taps and rendered nothing; two
dashboards racing for one claim), and it still could not bring the dashboard tab to the
front, because a tab opened by `clients.openWindow` has no user activation and
`WindowClient.focus()` requires it. It is in git history (`server/lib/focus.ts`) if the
trade ever looks different.

## Answering "is it working?"

Every failure here is invisible from the outside: an off switch, a missing topic and a
dropped packet all look identical. So `POST /api/notify/test` fires one push **regardless of
policy** and returns what actually happened, including whether taps will open anything. The
Settings button surfaces that string verbatim.

### The failure a 2xx cannot see: a `.env` edited after startup

`loadConfig` runs once, at startup. Change `NTFY_TOPIC_DESK`, keep the process, and every
later push goes to the **previous** topic — ntfy accepts it (any topic string is a valid
topic; there is no registration), `httpsSend` reports 2xx, and `sendTest` truthfully says
"sent". Your browser is subscribed to the new topic and shows nothing. Every visible signal
says success.

This happened on **2026-09-04**. The desk push had been verified end to end earlier that day;
by evening the topic in `.env` had been replaced by hand without a restart. A test push
reported `sent to https://ntfy.sh (desk topic)`, a banner appeared at the same moment — Claude
Code's own notification, identical in shape — and the feature was recorded as proven. It was
diagnosed only by polling ntfy's message cache from outside the app
(`curl 'https://ntfy.sh/<topic>/json?poll=1&since=all'`), which showed no message at that
minute on either topic.

`staleEnvKeys()` (`server/lib/config.ts`) closes it. `loadConfig` keeps the parsed `.env` it
read; the function re-reads the file on demand and returns the **names** of keys whose value
now differs. Three deliberate limits:

- **Names, never values.** `NTFY_TOPIC`, `NTFY_TOPIC_DESK` and `ANSWER_TOKEN` are credentials
  and this list ships over the API — same posture as `notifyAvailable`.
- **Parsed values, not an mtime.** A comment or whitespace edit is not a changed setting, and
  a warning that cries wolf is ignored on the day it is right.
- **Keys pinned in `process.env` are skipped.** They beat the file whatever it says, so a
  restart would not move them and naming them would be false advice.

It surfaces in two places: `GET /api/settings` carries `staleEnvKeys` for the Settings page,
and `sendTest` appends the push-relevant subset to its own answer — because the string
someone reads while asking "why did nothing arrive?" is that one.

Detected, not fixed: the server does not reload itself, exactly like `idleOverride`. The
advice is always "restart".

## Deferred

**Per-session cooldown.** Four event types across several concurrent sessions could get
chatty. Not built; the predicate has an obvious place for it (a final clause over a
`Map<sessionId, lastSentAt>` ledger).

**iOS PWA / Web Push.** Still the only way to notify from the dashboard itself rather than
via ntfy. Manifest, icons, service worker, VAPID signing, subscription storage, and a second
server write path. ntfy makes it unnecessary for now.

<!-- docs-sync:
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
  verified: 69dc049345a08127684ec8813ccd31aaedf4ea84
-->
