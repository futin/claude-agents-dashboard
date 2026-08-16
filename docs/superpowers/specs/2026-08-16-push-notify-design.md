# Server-sent push notifications — design

**Date:** 2026-08-16
**Scope:** a new `notify` subsystem — the server sends ntfy pushes for four session
events, gated by a layered policy stored in `.dashboard-settings.json` and edited from
Settings. Replaces the `CLAUDE_NTFY` env flag and the JSON-surgery
`notify-remote-toggle` skill. No change to remote-answer, plans, permissions, or the
in-browser alert path.
**Supersedes:** the ad-hoc ntfy `curl` in `~/.claude/hooks/stop-notify.sh` and the
inserted `PreToolUse` push entry the old skill managed.

## Concept

### The problem this exists to fix

The dashboard's in-browser alerts (`useSessionAlerts` + `/api/alerts/stream`) cannot
reach an iPhone. WebKit exposes no `Notification` API in a tab at all — Safari *and*
Chrome-on-iOS — so `alertPermission()` returns `'unsupported'` and
`announce()` silently degrades to a tab-title count. Real iOS notifications would need a
web app manifest, a service worker, `registration.showNotification()`, and — for
anything to arrive while the app is closed — VAPID Web Push. None of that exists in this
repo, and iOS suspends backgrounded PWAs hard enough that only true Web Push would be
reliable anyway.

ntfy sidesteps the entire problem: a native app already holds the push connection. The
dashboard just has to decide *when* to publish.

### Why the existing ntfy setup is not that

Today the push lives in two hand-edited places in `~/.claude/settings.json` — a
`CLAUDE_NTFY=1` prefix on the `Stop` hook command, and a whole extra `PreToolUse` entry
carrying an inline `curl`. The `notify-remote-toggle` skill's job is to keep those two in
sync via JSON surgery, and its own instructions have to warn (three times) against
clobbering unrelated array entries. The policy is a single boolean, the topic is
hardcoded in a shell script, and there is no way to say "only when I'm actually away".

### The shape instead

This app already solved the same problem once, for remote answers: orthogonal gates,
resolved server-side, published on `GET /api/health`, with the dashboard owning the
knobs. `notify` reuses that shape exactly.

Three of the four events already arrive at the server as hook POSTs
(`/api/questions/wait`, `/api/plans/wait`, `/api/permissions/notify`), so the server
already knows about them with per-event granularity, at the moment they happen. The
server also runs on the same machine as the hooks, so it can read HID idle time itself.
That makes server-side delivery strictly less code than the alternatives, and puts the
whole policy in one testable module.

## 1. The predicate

The core of the feature, and the only part with edge cases worth a test table.

```
push(event) =
     notify.enabled                                    // master
  && notify.events[event]                              // per-event opt-in
  && (!notify.requireRemoteAnswer || health.remoteAnswer)
  && (!notify.requireAfk          || idleSecs >= settings.idleSecs)
  && (!notify.requireAutoMode     || permissionMode is auto-ish)
```

All AND, each layer independently optional. Adding a layer later means adding one
clause; that is the property to preserve.

| Layer | Source | Notes |
|---|---|---|
| `enabled` | settings store | Master. Default `false` — opt-in, matching `alertsEnabled`. |
| `events[event]` | settings store | Four independent booleans, all default `false`. |
| `requireRemoteAnswer` | `remoteState.getState().remoteAnswer` | Already computed: env gate AND toggle. |
| `requireAfk` | `ioreg -c IOHIDSystem` vs `settings.idleSecs` | Same source and same threshold the hooks use. |
| `requireAutoMode` | `permissionMode` on the request body | The one value only a hook can see. |

### Auto-ish permission modes

`auto`, `bypassPermissions`, `dontAsk` — the same default set
`remote-decision-hook.sh` uses, and for the same reason.

The two lists cannot literally share a definition: one is a TypeScript constant, the
other a bash `MODES` default. They are duplicated on purpose, the same way `NEEDS_YOU` is
duplicated between `alertStream.ts` and `client/src/lib/alerts.ts` — three words of rule
is not worth coupling a shell script to a module. Each side carries a comment naming the
other. `CLAUDE_DASHBOARD_DECISION_MODES` stays a hook-local override and is deliberately
*not* mirrored server-side; the dashboard's own list is the one the pushes obey.

### Fail directions

Every failure mode gets an explicit direction, because silence is the bug this feature
exists to fix.

| Failure | Direction | Why |
|---|---|---|
| `ioreg` unreadable (Docker, non-macOS) | **push anyway** | Failing silent reintroduces the missed-notification bug. Diverges from `ask-remote-hook.sh`, which fails toward *not* hiding the terminal dialog — different stakes: there, a wrong guess hides a dialog; here, a wrong guess costs one extra push. |
| `permissionMode` absent from the body | **treat as not auto-ish** | Only reachable from an un-upgraded hook. Matches `remote-decision-hook.sh`, which exits silently on a missing mode. |
| ntfy request fails / times out | **swallow** | Never blocks or fails the caller's request. |
| Settings file unreadable | **defaults (all off)** | Same fail-open read as `settings.ts` today. |

## 2. Module — `server/lib/notify.ts`

Shaped like `remoteState.ts` and `settings.ts`: module cache, fail-open, `reset*` test
seam, no new dependencies.

```ts
export type NotifyEvent = 'question' | 'stop' | 'permission' | 'plan';

export interface NotifyContext {
  sessionId: string;
  label: string;            // session name or project — the only content in the body
  permissionMode?: string;
}

/** Pure. The whole policy, and the whole test surface. */
export function shouldNotify(
  event: NotifyEvent,
  policy: NotifyPolicy,
  ctx: { remoteAnswer: boolean; idleSecs: number | null; thresholdSecs: number; permissionMode?: string }
): boolean;

/** Evaluate + deliver. Fire-and-forget: returns immediately, never throws. */
export function maybeSend(event: NotifyEvent, ctx: NotifyContext): void;

/** Deliver unconditionally and report what happened. Backs the test button. */
export function sendTest(): Promise<string>;

/** Test seam: swap the transport so no test touches the network. */
export function setSender(fn: Sender | null): void;
export function resetNotify(): void;
```

`sendTest` returning a human-readable outcome string mirrors `fireTestAlert` in
`client/src/hooks/useSessionAlerts.ts`, and for the same stated reason: every failure in
this feature is invisible from the outside, so the only honest answer to "is this
working?" is to fire one and say what happened.

Transport is `node:https` — the backend's zero-runtime-dep rule holds. What changes is
posture: the backend has until now only read from disk, and now makes an outbound
request. That is stated in the module header, capped at 2s, and never awaited by a
request handler.

### Idle reading

`ioreg -c IOHIDSystem | awk '/HIDIdleTime/ …'` via `node:child_process`, the same
command `ask-remote-hook.sh` uses. Spawn cost is ~40ms and only paid when
`requireAfk` is on and every cheaper clause already passed — the predicate short-circuits
in written order, cheapest first.

### Resolving the label

Every caller has a `sessionId` and none has a display name: the hooks do not know it
(it is derived from the transcript) and the registration handlers never needed it. The
server resolves it the way the rest of the app does — `scanSessions`, then
`sessionName || project`, the same expression `diffAlerts` uses to build an
`AlertTarget`.

That is a disk scan per push, which is only acceptable because pushes are rare (a
question, a finished turn) and already gated behind every cheaper clause. It happens
after the predicate passes, never before. If the session is not found — a scan window
that has already moved past it — the label falls back to the first 8 characters of the
`sessionId`, and the push still goes out. A push with a poor label beats no push.

## 3. Configuration — the topic is a secret

`NTFY_TOPIC`, optional `NTFY_SERVER` (default `https://ntfy.sh`) and optional
`DASHBOARD_PUBLIC_URL` (default `http://localhost:<port>`) join `server/lib/config.ts`,
resolved by the existing `process.env > .env > default` precedence. `notifyAvailable` is
`topic !== ''`, exactly mirroring how `remoteAnswer` gates on `REMOTE_ANSWER`.

**No endpoint ever returns the topic.** ntfy topics are unauthenticated: anyone who
learns the string can both read the notifications and publish to them. `GET
/api/settings` returns `notifyAvailable: boolean` and nothing else about it. The UI can
say "configured" or "not set", and offers a test button; it cannot display or edit the
value. Changing it means editing `.env`, which is already gitignored and already how
`REMOTE_ANSWER` works.

### Push bodies carry no work content

Title `Claude Code`, body `<session label> — <event phrase>`. Never the question text,
the plan markdown, the tool name, or any transcript content. The topic is a third-party
unauthenticated channel; the dashboard is where the actual content is read. This is a
constraint on the feature, not an implementation detail — `NotifyContext` deliberately
has no field that could carry it.

| Event | Body |
|---|---|
| `question` | `<label> — question waiting` |
| `plan` | `<label> — plan waiting for review` |
| `permission` | `<label> — permission dialog open` |
| `stop` | `<label> — task finished` |

### Tapping the notification opens that session's chat

A push that only says "something needs you" still leaves you hunting for which row.
ntfy's `Click` header makes the notification itself the shortcut: tapping it opens

```
<DASHBOARD_PUBLIC_URL>/?session=<sessionId>
```

which the dashboard consumes on load — force the Sessions section, open that session's
chat drawer, then strip the parameter so a later refresh does not reopen it. The drawer
is where every action surface already lives (`QuestionPanel`, `PlanPanel`,
`PermissionBanner`), so one tap lands exactly on the thing that needs a decision.

**`DASHBOARD_PUBLIC_URL` is required for this to be useful, and cannot be inferred.** A
push is not triggered by a browser request, so there is no `Host` header to read; the
server genuinely does not know how you reach it. It defaults to
`http://localhost:<port>`, which works at the desk and is useless on a phone — the
tailnet hostname is what belongs there. When it is unset, the push is still sent, just
without a `Click` header.

**This relaxes the no-content rule, deliberately.** The session id and the dashboard's
address now leave the machine. Neither is work content, but together they are a pointer:
anyone who learns the topic learns where the dashboard lives. On a tailnet-only
deployment that pointer is unusable without tailnet access — which is the deployment this
was built for. Expose the dashboard publicly and the calculus changes, so the Settings
hint for the topic says as much.

## 4. Settings store

`server/lib/settings.ts` `Stored` grows one nested block. This is the right home rather
than browser localStorage for the same reason `idleSecs` lives here: a separate process
has to agree on it, and it is machine-wide, not per-device.

```ts
interface NotifyPolicy {
  enabled: boolean;
  events: { question: boolean; stop: boolean; permission: boolean; plan: boolean };
  requireRemoteAnswer: boolean;
  requireAfk: boolean;
  requireAutoMode: boolean;
}
```

All fields default `false`. `readStored` falls back per-key as it does today. `setSettings`
keeps its strict-patch rule — a key that is present but unusable rejects the whole patch,
because a half-applied save is the one outcome the UI cannot report honestly. A partial
`notify` patch merges into the existing block rather than replacing it, so the UI can
send one changed checkbox.

## 5. Contract — `shared/types.ts`

| Addition | Shape |
|---|---|
| `NotifyEvent` | `'question' \| 'stop' \| 'permission' \| 'plan'` |
| `NotifyPolicy` | as above |
| `ServerSettings` | `+ notify: NotifyPolicy`, `+ notifyAvailable: boolean` |
| `QuestionWaitRequest`, `PlanWaitRequest`, `PermissionNotifyRequest` | `+ permissionMode?: string` |
| `NotifyEventRequest` | `{ sessionId: string; event: NotifyEvent; permissionMode?: string }` |
| `NotifyTestResponse` | `{ outcome: string }` |

`permissionMode` is optional on all three so an un-upgraded hook keeps working — it just
never satisfies `requireAutoMode`.

## 6. Endpoints — `server/api.ts` + `server/index.ts`

| Route | Method | Purpose |
|---|---|---|
| `/api/notify/event` | POST | Stop's path. Fire-and-forget, `204`. Same posture as the existing `/api/permissions/notify`. |
| `/api/notify/test` | POST | Fires one push regardless of policy, returns the outcome string. |

The three existing handlers — `serveQuestionWait`, `servePlanWait`,
`servePermissionNotify` — each gain one `maybeSend(...)` call at registration, after the
request is validated and before the response is held or returned. `maybeSend` is
synchronous-returning, so none of them changes shape.

`/api/settings` POST already exists and needs no new route, only the widened patch.

## 7. Hooks — `scripts/`

| Script | Change |
|---|---|
| `ask-remote-hook.sh` | one `--arg pm "$MODE"` in the existing `jq -cn` body; `MODE` read from `.permission_mode` |
| `plan-remote-hook.sh` | same |
| `permission-notify-hook.sh` | same |
| `stop-notify.sh` → `scripts/stop-notify-hook.sh` | moves into the repo and gets symlinked like its three siblings; body becomes one curl to `/api/notify/event` |

`stop-notify.sh` keeps its `background_tasks` / `session_crons` guards — in-flight
background work should still suppress the push, and only the hook payload carries that.
Everything below the guards collapses to one curl. `CLAUDE_NTFY` is deleted; the
hardcoded topic goes with it.

The three POSTing hooks gain no new network calls and no new failure modes: they already
send a body, this adds a field to it.

**`permission-notify-hook.sh` carries the mode only sometimes.** It serves two events:
`PermissionRequest`, whose payload does include `permission_mode`, and the legacy
`Notification` fallback, whose payload may not. The hook sends whatever it finds and
omits the field otherwise — which, per §1, means `requireAutoMode` simply is not
satisfied on that path. Turning that layer on therefore suppresses permission pushes from
older CLIs. That is the correct direction (an unknown mode is not a known-auto mode) and
is called out in the Settings hint for the layer.

## 8. UI — `client/src/components/settings/SettingsView.tsx`

A new group, **"Push notifications · every device"**, placed after "Alerts · this device".
The heading distinction is load-bearing: alerts are per-browser localStorage, these are
server-backed and shared by every browser pointed at this dashboard. Fed by
`useServerSettings`, not `useSettings`.

| Row | Control | Hint behaviour |
|---|---|---|
| Push notifications | On/Off | Disabled when `!notifyAvailable`, hinting `Set NTFY_TOPIC in .env to enable.` |
| Question waiting | On/Off | one row per event, all four |
| Task finished | On/Off | |
| Permission dialog | On/Off | |
| Plan waiting | On/Off | |
| Only while accepting remote answers | On/Off | names the toggle it depends on |
| Only when I'm away | On/Off | quotes the live `idleSecs` value |
| Only in auto permission modes | On/Off | names the three modes |
| Send test push | button | replaces its hint with the outcome string |

Every row below the master toggle is disabled while the master is off, so the layering is
visible rather than implied.

## 9. The skill

`notify-remote-toggle` is rewritten from ~80 lines of JSON-surgery instructions to a thin
toggle: read `GET /api/settings`, POST the flipped `notify.enabled`, report the new
state. No `~/.claude/settings.json` edits, nothing to keep in sync, no warnings about
clobbering sibling array entries — the failure mode it spent most of its length guarding
against stops existing.

## 10. Testing

`test/notify.test.ts`, registered in `test/run-all.ts`:

- **Predicate table** — each event × each layer on/off × satisfying and violating context.
  The one exhaustive part.
- **Short-circuit order** — `requireAfk` off means `ioreg` is never spawned.
- **Fail directions** — every row of the table in §1.
- **Body composition** — asserts no field beyond the label reaches the payload.
- **Settings validation** — partial `notify` patches merge; a bad key rejects the whole
  patch; unreadable file yields all-off defaults.

Transport is injected via `setSender`, so no test opens a socket. Existing
`test/settings.test.ts` gains cases for the widened patch.

## 11. Docs

- New `docs/subsystems/push-notify.md` — the subsystem doc, following the house pattern
  (why it exists, the gates, the fail directions, the contract).
- `docs/subsystems/settings.md` — the new group, and the device-vs-machine distinction.
- `docs/overview.md` — map entry.
- `.claude/CLAUDE.md` — architecture map: `server/lib/notify.ts` line, and the note that
  the backend now makes one outbound call.
- `docs/subsystems/remote-answer.md`, `remote-plan.md`, `permission-notify.md` — one line
  each for the added `permissionMode` field.

## Deferred

**Per-session cooldown.** Four event types across several concurrent sessions could get
chatty on a busy day. Deliberately not built now; the predicate has an obvious place for
it (a final clause with a `Map<sessionId, lastSentAt>` ledger, the same shape as
`dedupe()` in `client/src/lib/alerts.ts`). Revisit after living with it.

**iOS PWA / Web Push.** Still the only way to get notifications from the dashboard itself
rather than via ntfy. Much larger: manifest, icons, service worker, VAPID signing,
subscription storage, and a second server write path. Out of scope; ntfy makes it
unnecessary for now.
