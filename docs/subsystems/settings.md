---
docs-sync:
  sources:
    - client/src/lib/settings.ts
    - client/src/hooks/useSettings.tsx
    - client/src/hooks/useServerSettings.ts
    - client/src/components/settings/
    - server/lib/settings.ts
    - client/index.html
  kind: subsystem
  verified: 9910962bd0d5d767482b3ba22fe11b8f7ba7a452
---

# Settings

The fourth section tab. Everything the dashboard used to need a `.env` edit, a rebuild, or a
shell export for is editable here and takes effect on the next tick.

## Where each setting lives, and why

There are two backends, and the page's group headings say which is which.

**Per-device — `localStorage['dashboard.settings']`.** Theme, density, text scale, landing tab,
refresh rate, row count, lookback, active window. A phone propped on the desk wants
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

⚠️ **Save feedback must be keyed to the row, because every control shares one `save`.** That is
why `useServerSettings` exposes `isSaving(key)` rather than a `saving` boolean: a single flag is
true for whichever row is saving *and* for every other row that renders a `saving…` span, so
flipping a push toggle lit up the indicator next to `Away after` and `Answer window` — two rows
the user never touched — while the row actually saving showed nothing. A new row wired to a
shared flag reintroduces exactly that. The in-flight keys are held as a multiset so two
overlapping saves can't have the first response clear the second's indicator.

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

## Push notifications

**Push notifications · every device** — the heading says the storage: server-backed and
shared by every browser pointed at this dashboard, unlike the per-device groups above.

This is the app's **only** way of telling you something needs you when you aren't looking at
the dashboard. An in-browser layer (`Notification` banner + beep + tab-title count, fed by a
poll diff and an SSE stream on `GET /api/alerts/stream`) used to sit above this group and was
deleted when this shipped: it could never fire on iOS, and on a Mac it only repeated the CLI's
own notification. The reasoning, and what that trade costs, is in
[push-notify](push-notify.md).

Nine rows — a master switch, one per event (question / permission dialog / plan / task
finished), three optional AND-layers (only-while-accepting-remote-answers, only-when-away,
only-in-auto-modes), and a test button. The server sends them, so nothing here depends on a
tab being open. Full mechanism, fail directions and the topic's secrecy rules:
[push-notify](push-notify.md).

Worth knowing from this page's side:

- **⚠️ "Only when I'm away" off does not mean "always push"** for `question` and `plan`.
  Their hooks run their own idle check *before* the POST that would reach the notifier, so
  at the desk the server never learns there is anything to push about and the predicate is
  never evaluated. Only `permission` and `stop` become unconditional. The page renders a
  callout in exactly that state (pushes on, the switch off, `idleSecs > 0`, and one of those
  two events enabled), and **Away after** says so in its hint — because the threshold gates
  those pushes whether or not the push-side switch is on. Full layering:
  [push-notify](push-notify.md).
- **`notify` patches merge.** The UI sends the one checkbox that changed, not the whole
  policy. A key that is present but unusable rejects the *entire* patch (400) rather than
  half-applying — the one outcome the page could not report honestly.
- **The test button reports what actually happened**, including "no `NTFY_TOPIC` set", a
  refusal from ntfy, an unreachable server, and whether taps will open the dashboard. It is
  the one send that waits for ntfy's answer. Every failure in a notification feature is
  invisible from the page, so the button reports rather than assumes.
- **Without a topic the group is disabled**, under one warning naming `NTFY_TOPIC` — the
  switches would otherwise persist and read "On" while nothing could send.

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
