---
docs-sync:
  sources:
    - client/src/lib/settings.ts
    - client/src/lib/alerts.ts
    - client/src/hooks/useSettings.tsx
    - client/src/hooks/useServerSettings.ts
    - client/src/hooks/useSessionAlerts.ts
    - client/src/components/settings/
    - server/lib/settings.ts
    - client/index.html
  kind: subsystem
---

# Settings

The fourth section tab. Everything the dashboard used to need a `.env` edit, a rebuild, or a
shell export for is editable here and takes effect on the next tick.

## Where each setting lives, and why

There are two backends, and the page's group headings say which is which.

**Per-device — `localStorage['dashboard.settings']`.** Theme, density, text scale, landing tab,
refresh rate, row count, lookback, active window, alerts. A phone propped on the desk wants
five rows in the light theme and a slow poll; the laptop wants twenty, the dark theme and three
seconds. Sharing these would make one device wrong.

**Shared — `.dashboard-settings.json`** (repo-local, gitignored, never inside `~/.claude`).
Only settings a *separate process* has to agree on: `idleSecs` (how long until you count as
away) and `answerSecs` (how long the question then waits here), both read by the
remote-answer hooks, plus the `notify` policy, which the **server itself** acts on when it
decides whether to send a push. This is the app's second and last write to disk, after
[the remote-answer toggle](remote-answer.md).

The three scan knobs are the interesting case: they change what the **server** computes, but
they are still per-device, so they travel as query params on the poll the client already makes —
`GET /api/sessions?limit=20&lookback=48&active=5`. Request input, not stored state. Nothing new
is persisted and no device can change what another device sees.

## The two hook numbers, and why they needed a contract change

`CLAUDE_DASHBOARD_IDLE_SECS` and `CLAUDE_DASHBOARD_ANSWER_TIMEOUT` are read by
`scripts/ask-remote-hook.sh` and `scripts/plan-remote-hook.sh`, which run inside **Claude Code's**
process. A web app cannot set an environment variable in another process, so the values have to
be *pulled*.

Both hooks already `curl /api/health` as their reachability probe, immediately before the idle
check. So both numbers ride along on that one response and the hooks resolve:

```bash
IDLE_MIN_S="${CLAUDE_DASHBOARD_IDLE_SECS:-$(printf '%s' "$HEALTH" | jq -r '.idleSecs // 60')}"
case "$IDLE_MIN_S" in ''|*[!0-9]*) IDLE_MIN_S=60 ;; esac
TIMEOUT_S="${CLAUDE_DASHBOARD_ANSWER_TIMEOUT:-$(printf '%s' "$HEALTH" | jq -r '.answerSecs // 600')}"
case "$TIMEOUT_S" in ''|*[!0-9]*) TIMEOUT_S=600 ;; esac
```

Zero extra round trips, and three fallbacks deep each: an explicit env var wins, then the
dashboard's value, then the hook's own default — so an old server, a stopped server or a garbled
payload all behave exactly as they did before this existed. `TIMEOUT_S` is resolved *after* the
probe for that reason, not at the top of the script with `DASH`.

⚠️ **The env var winning is a real trap**, because `~/.claude/settings.json` commonly sets these
in its `env` block — and then changing the number here does nothing, silently. `detectEnvOverride`
reads that file (and the server's own environment) on every `getSettings()` and reports what it
finds as `idleOverride` / `answerOverride`; the page shows a warning naming the exact file.
Detection only — the app never edits `~/.claude`.

⚠️ **A second trap is specific to the window:** the CLI kills a hook at the `timeout` on its
`settings.json` entry (installed as `630`). A window above ~615s means the hook dies mid-wait, so
the question silently falls back to the terminal dialog early. The UI therefore offers **5–600s**
and warns above 600; the server still clamps to 5–1800 (`MIN/MAX_ANSWER_SECS`, mirroring
`MIN/MAX_TIMEOUT_MS` in `pending.ts`) so an env var or a hand-edited file with a matching hook
timeout is not blocked.

`setSettings` takes a **partial** patch — one row saves one key — but a key that is present and
unusable rejects the whole patch rather than half-applying it, since a half-applied save is the
one outcome the UI cannot report honestly. A file written before `answerSecs` existed still loads:
each key falls back independently.

Hooks installed by **symlink** (the documented install) pick the new script up automatically.
A copied hook must be re-copied.

## Themes

`client/src/styles.css` was already fully tokenized: ~20 custom properties on `:root` and every
rule below consuming them. So a theme is one override block and nothing else — no component
churn, no JS, no bundle cost.

| id | look | scheme |
|---|---|---|
| `midnight` | the original deep-navy scope room | dark |
| `graphite` | neutral dark, blue cast removed | dark |
| `amber` | black glass, amber phosphor (statuses become amber tints, not hues) | dark |
| `nightshift` | deep green radar scope | dark |
| `daylight` | manila paper, dark ink — the actual thing the strip metaphor comes from | light |

Adding one means: copy a `[data-theme=…]` block, set `color-scheme`, add the id to `THEMES` in
`client/src/lib/settings.ts`, and add its three preview colors to `SWATCHES` in `SettingsView`.
Nothing else.

Four tokens exist purely so the light theme works: `--on-accent` (ink on a filled accent —
the amber Send button), `--scrim` (drawer backdrop), and `--shadow` / `--shadow2` (a lift that
reads as depth on black reads as dirt on paper). **No color or shadow may be hardcoded below the
token block** — that is the invariant the whole theme system rests on.

**Anti-flash:** an inline script in `client/index.html` stamps `data-theme` / `data-density` /
`--font-scale` from localStorage before first paint. Without it every load renders in Midnight
until React mounts, which is very visible on the light theme. It duplicates three lines of
`useSettings.tsx` on purpose — it has to run before the module graph loads, so it cannot be one.

## Density and text scale

`[data-density="compact"]` retunes four spacing variables and nothing else — never a color,
never a font size — so it composes with every theme. The text scale is `body { zoom: … }`:
this stylesheet is px throughout, so a root font-size would do nothing, and `zoom` is the only
one-line option that scales the whole board. Verified against the fixed-position chat drawer at
110%: the backdrop still covers the viewport and the drawer stays flush right.

## Alerts

`lib/alerts.ts` is a pure diff (`diffAlerts`) over consecutive snapshots; `useSessionAlerts`
does the effects. Fed by the same 3-second poll the rows render from, so it costs no request.

- Fires only on a **transition into** `question` or `incomplete`. A session already waiting is
  not news, and re-firing every poll while it sits there would be unusable.
- The first snapshot after a load seeds the baseline and alerts on nothing.
- The baseline is tracked **even while alerts are off**, so switching them on doesn't replay a
  backlog.
- The tab title always shows a count, permission or not. On iOS Safari — the single likeliest
  device to be watching this — `Notification` exists only for a home-screen PWA. Returning to
  the tab clears the count.
- The sound is two oscillator tones, no asset and no dependency. **One** `AudioContext` is held
  for the tab's lifetime rather than one per beep: a context built without user activation
  starts `suspended`, and scheduling into a suspended context is a silent no-op that a
  poll-driven beep can never recover from. `unlockAudio()` opens it from a real click (the
  Sound toggle, the test button) and later beeps ride on it.
- Permission is requested from the toggle's click, because every engine requires a gesture.
- **Test alert** fires the whole path on demand and reports which halves got through
  (`fireTestAlert`). Every failure mode here — `default` permission, a suspended context, an OS
  that swallowed the banner — looks identical from the page: nothing. That is fine for a
  background poll and useless for someone asking why they got nothing.

Alerts are fed the **unfiltered** session list: a session you filtered out of view still needs
you, and a filter is about what you're reading, not what you're told.

### Why a poll alone cannot do this

The alert-worthy statuses are **transient**. `incomplete` decays to `idle` once the session
falls outside `activeWindowMin` (`scan.ts` — `recent`), typically five minutes. A hidden tab is
throttled by the browser to roughly one timer tick a minute and may be frozen outright, so it
thaws to observe `working → idle` — a pair `diffAlerts` correctly ignores. The alert is
**lost, not delayed**. That is the failure mode reported in practice, and no amount of tuning
the client diff fixes it, because the evidence is already gone by the time the tab runs again.

So detection moved off the client timer: `server/lib/alertStream.ts` runs the scan on a Node
interval, which nothing throttles, and pushes each transition down an open SSE connection
(`GET /api/alerts/stream`). Delivery is event-driven, so the bytes sit on the socket waiting
for a tab that is not currently allowed to execute JavaScript.

| | poll diff (`useSessionAlerts`) | push stream (`useAlertStream`) |
|---|---|---|
| mounted in | `SessionsView` | `AppShell` — survives section switches |
| detects while tab hidden | no | yes |
| survives a frozen tab | no | yes, delivered on thaw |
| costs | rides the existing 3s poll | one long-lived connection |

Both funnel into one `announce()`, deduped on `${id}:${status}` for 60s (`dedupe` in
`lib/alerts.ts`), so a foreground tab seeing the same transition twice still alerts once. The
poll half is kept as the fallback for when the stream cannot connect.

Server-side properties worth knowing:

- **The scan runs only while someone is listening.** No subscribers, no timer — the app keeps
  its no-daemon posture.
- **Each connection seeds its own baseline and alerts on nothing**, so an `EventSource`
  reconnect never replays a backlog.
- It scans with the **server's** configured knobs, not the caller's `?limit=`. The per-device
  row count is about what you are reading; a session you trimmed off the list still needs you.
- `X-Accel-Buffering: no` and a `: ping` heartbeat every 20s keep the stream alive through a
  buffering reverse proxy.

Still not covered by anything in this group: a **closed** tab, a browser that isn't running,
or an iPhone — WebKit has no `Notification` API in a tab at all, so on iOS these controls only
ever move the tab-title count. That is what the next group exists for.

## Push notifications

A second group, **Push notifications · every device**, and the heading difference is the
point: alerts above are this browser's localStorage, these are server-backed and shared by
every browser pointed at this dashboard. Nine rows — a master switch, one per event
(question / permission dialog / plan / task finished), three optional AND-layers
(only-while-accepting-remote-answers, only-when-away, only-in-auto-modes), and a test button.

The server sends them, so nothing here depends on a tab being open. Full mechanism, fail
directions and the topic's secrecy rules: [push-notify](push-notify.md).

Two things worth knowing from this page's side:

- **`notify` patches merge.** The UI sends the one checkbox that changed, not the whole
  policy. A key that is present but unusable rejects the *entire* patch (400) rather than
  half-applying — the one outcome the page could not report honestly.
- **The test button reports what actually happened**, including "no `NTFY_TOPIC` set" and
  whether taps will open the dashboard. Same reasoning as the alert test above: every failure
  in a notification feature is invisible from the page.

## HTTP

| Route | Purpose |
|---|---|
| `GET /api/settings` | the non-per-device settings + any detected override, plus `notifyAvailable` (never the topic itself) |
| `POST /api/settings` | change them (`{idleSecs?, answerSecs?, notify?}` — any subset); token-guarded like the other writes |
| `POST /api/notify/test` | fire one push regardless of policy and report the outcome |
| `GET /api/health` | now also carries `idleSecs` and `answerSecs`, for the hooks |
| `GET /api/sessions?limit=&lookback=&active=` | per-request scan overrides |

`scanOverrides` (in `server/api.ts`) clamps to `limit ≤ 50`, `lookback ≤ 168`, `active ≤ 120`.
The `limit` cap is the one that matters: unclamped, one typo'd query string would make the
server tail-read thousands of transcripts on every poll. `LIMITS` in the client mirrors these,
and a test asserts they haven't drifted — a UI offering a number the server clamps would show
a value the rows never reflect.

## Related

- [view-persistence](view-persistence.md) — the other localStorage keys, and the Reset button's blast radius
- [remote-answer](remote-answer.md) — the three gates, of which `idleSecs` is the third, and the wait `answerSecs` sizes
- [push-notify](push-notify.md) — where the `notify` policy is actually acted on
- [configuration](../workflows/configuration.md) — the `.env` defaults these settings override
