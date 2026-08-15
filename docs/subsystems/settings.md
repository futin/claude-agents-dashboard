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
Only settings a *separate process* has to agree on. Today that is exactly one: `idleSecs`, read
by the remote-answer hooks. This is the app's second and last write to disk, after
[the remote-answer toggle](remote-answer.md).

The three scan knobs are the interesting case: they change what the **server** computes, but
they are still per-device, so they travel as query params on the poll the client already makes —
`GET /api/sessions?limit=20&lookback=48&active=5`. Request input, not stored state. Nothing new
is persisted and no device can change what another device sees.

## The idle threshold, and why it needed a contract change

`CLAUDE_DASHBOARD_IDLE_SECS` is read by `scripts/ask-remote-hook.sh` and
`scripts/plan-remote-hook.sh`, which run inside **Claude Code's** process. A web app cannot set
an environment variable in another process, so the value has to be *pulled*.

Both hooks already `curl /api/health` as their reachability probe, immediately before the idle
check. So `idleSecs` rides along on that response and the hooks resolve:

```bash
IDLE_MIN_S="${CLAUDE_DASHBOARD_IDLE_SECS:-$(printf '%s' "$HEALTH" | jq -r '.idleSecs // 60')}"
case "$IDLE_MIN_S" in ''|*[!0-9]*) IDLE_MIN_S=60 ;; esac
```

Zero extra round trips, and three fallbacks deep: an explicit env var wins, then the dashboard's
value, then 60 — so an old server, a stopped server or a garbled payload all behave exactly as
they did before this existed.

⚠️ **The env var winning is a real trap**, because `~/.claude/settings.json` commonly sets it in
its `env` block — and then changing the number here does nothing, silently. `detectIdleOverride`
reads that file (and the server's own environment) on every `getSettings()` and reports what it
finds as `idleOverride`; the page shows a warning naming the exact file. Detection only — the
app never edits `~/.claude`.

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
- The sound is two oscillator tones, no asset and no dependency.
- Permission is requested from the toggle's click, because every engine requires a gesture.

Alerts are fed the **unfiltered** session list: a session you filtered out of view still needs
you, and a filter is about what you're reading, not what you're told.

## HTTP

| Route | Purpose |
|---|---|
| `GET /api/settings` | the non-per-device settings + any detected override |
| `POST /api/settings` | change them (`{idleSecs}`); token-guarded like the other writes |
| `GET /api/health` | now also carries `idleSecs`, for the hooks |
| `GET /api/sessions?limit=&lookback=&active=` | per-request scan overrides |

`scanOverrides` (in `server/api.ts`) clamps to `limit ≤ 50`, `lookback ≤ 168`, `active ≤ 120`.
The `limit` cap is the one that matters: unclamped, one typo'd query string would make the
server tail-read thousands of transcripts on every poll. `LIMITS` in the client mirrors these,
and a test asserts they haven't drifted — a UI offering a number the server clamps would show
a value the rows never reflect.

## Related

- [view-persistence](view-persistence.md) — the other localStorage keys, and the Reset button's blast radius
- [remote-answer](remote-answer.md) — the three gates, of which `idleSecs` is the third
- [configuration](../workflows/configuration.md) — the `.env` defaults these settings override
