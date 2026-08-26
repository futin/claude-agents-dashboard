# Push notifications — setup

Wires [push notifications](../subsystems/push-notify.md) to your phone through
[ntfy](https://ntfy.sh). Six steps, ~5 minutes. Needs a phone and, for the *task finished*
event only, `curl` and `jq` on the machine running Claude Code.

This is the only channel that reaches you with the dashboard closed. Why it is ntfy rather
than a browser notification, and what the policy switches do, is in
[push-notify](../subsystems/push-notify.md); this page is just the procedure.

## Steps

**1. Choose a topic — and treat it as a password.**

```bash
openssl rand -hex 16
```

⚠️ ntfy topics are **unauthenticated**. The string is both the address and the credential:
anyone who learns it can read every notification you receive *and* publish to your phone.
A guessable topic like `claude-dashboard` is a topic other people are already subscribed
to. Use the random string, and see [Rotating the topic](#rotating-the-topic) below if it
ever leaks.

**2. Subscribe your phone.** Install ntfy (iOS App Store, Google Play, or F-Droid; there is
also a browser client at [ntfy.sh/app](https://ntfy.sh/app)), then add a subscription and
paste the topic from step 1. Nothing arrives yet — that is expected.

**3. Point the dashboard at it.** In `.env` at the repo root:

```bash
NTFY_TOPIC=<the string from step 1>
DASHBOARD_PUBLIC_URL=http://<host>.<tailnet>.ts.net:4173
```

`DASHBOARD_PUBLIC_URL` is how your *phone* reaches this dashboard, used for the
tap-through link. It **cannot be inferred** — a push is not triggered by a browser request,
so there is no `Host` header to read — and it has no default, because a guessed address is
indistinguishable from one you chose. Leave it out and pushes still arrive, carrying no
tap-through link. The tailnet hostname is what belongs there (see
[remote-access](../subsystems/remote-access.md)). Self-hosting ntfy? Set `NTFY_SERVER` too.

**Restart the server** — these are read once at startup, unlike the Settings page.

**4. Turn it on.** Settings → **Push notifications · every device** → *Send push
notifications* On, then pick which events you want. If the group is greyed out under a
warning naming `NTFY_TOPIC`, the server did not see step 3: check you restarted it, and
that you edited `.env` rather than `.env.example`.

**5. Install the Stop hook — only if you want *task finished*.** The other three events
arrive on hooks you may already have; this one has nothing to ride on, because a finished
turn registers nothing with the dashboard.

> `pnpm hooks:install` installs this hook along with the other four —
> see [hooks-setup](hooks-setup.md).

```bash
ln -s "$PWD/scripts/stop-notify-hook.sh" ~/.claude/hooks/stop-notify.sh
```

then add to `~/.claude/settings.json` under `Stop`:

```json
{ "type": "command", "command": "bash \"$HOME/.claude/hooks/stop-notify.sh\"", "timeout": 630 }
```

`"timeout": 630` is now required: this same hook also backs
[remote messages](../subsystems/remote-message.md), and away from the keyboard with remote
answers on it holds a finished turn open for a reply from the dashboard, exactly as the
ask/plan hooks hold a question or plan. The CLI kills a hook at its configured
`timeout`, so a missing or too-low value kills the hold mid-wait — the session just stops
early (there is no dialog to fall back to, unlike a killed ask/plan hook), and a reply typed
after that lands on a 404. At the desk, or with the feature off, the hook still just POSTs and
exits in under a second — this cost is paid only by the *away* path.

**6. Verify.** Settings → **Test push**. It fires one push *ignoring every switch above*
and reports what actually happened, because an off switch, a missing topic and a dropped
packet are indistinguishable from the page. Then **tap the notification** — that is the
only way to prove `DASHBOARD_PUBLIC_URL` is right, and it should land you in that session's
chat.

## Which events need which hook

An event you enable in Settings still needs something to tell the dashboard it happened.
Three of the four ride on hooks documented elsewhere — enabling the checkbox without the
hook installed produces silence, not an error.

| Event | Needs | Installed per |
|---|---|---|
| *A question is waiting* | `ask-remote-hook.sh` | [remote-answer-setup](remote-answer-setup.md) |
| *A plan is waiting* | `plan-remote-hook.sh` | [remote-plan](../subsystems/remote-plan.md#install) |
| *A permission dialog opened* | `permission-notify-hook.sh` | [permission-notify](../subsystems/permission-notify.md#install-manual-user-consented) |
| *A task finished* | `stop-notify-hook.sh` | step 5 above |

⚠️ **The question and plan events carry their own away-check**, independent of the
*Only when I'm away* switch. Both hooks run an idle check before the POST that would reach
the notifier, so at the keyboard they hand the question to the terminal dialog and the
dashboard never learns there was anything to push about. Turning that switch off makes
*permission* and *task finished* unconditional, but not those two. The Settings page says
so in a callout; the full layering is in
[push-notify](../subsystems/push-notify.md#the-predicate-is-not-the-only-afk-gate).

## Docker

`.env` never reaches the production image — it is in `.dockerignore`, and the runtime stage
copies only `server/`, `shared/` and the built client. The compose files therefore pass the
three variables through explicitly, resolved from your shell **or** from the project's
`.env` on the host:

```yaml
environment:
  - NTFY_TOPIC
  - NTFY_SERVER
  - DASHBOARD_PUBLIC_URL
```

Listed bare, without `=${...}`: Compose omits an unset variable in that form, whereas
`VAR=${VAR}` injects an empty string, and `loadConfig` tests `!== undefined`, so an empty
string counts as set.

⚠️ `DASHBOARD_PUBLIC_URL` matters most here. It has no default anywhere, and inside a
container even a hand-written `localhost` would resolve to the container's own network
namespace — so the tailnet hostname is the only useful value.

## Failure modes

Read the Test push result first; it distinguishes most of these.

- **"no NTFY_TOPIC set in .env — nothing to send to"** — the server never saw step 3.
  Restart it; confirm you edited `.env`, not `.env.example`. In Docker, confirm the
  passthrough above.
- **"couldn't reach `<server>`…"** — DNS, TLS, offline, or a 2s timeout. The dashboard is
  the only thing here that talks to the internet; a proxy or egress rule can block it.
- **"`<server>` refused it (HTTP …)"** — ntfy rejected the publish; the message carries its
  first line of explanation. Usually a malformed topic name or a rate limit.
- **Reports sent, phone shows nothing** — the phone is subscribed to a *different* string
  (retype it), notifications are muted for the ntfy app at the OS level, or the device is
  in a battery-saver mode that defers them.
- **Push arrives, tapping opens nothing** — `DASHBOARD_PUBLIC_URL` is unset or wrong. The
  Test push result names the URL taps will use, or says outright that there isn't one, so
  read it rather than guessing.
- **Works on home wifi, not on cellular** — `DASHBOARD_PUBLIC_URL` is a LAN address. Use
  the tailnet hostname, which is reachable from anywhere on the tailnet.
- **Nothing for questions or plans, but *task finished* works** — either the matching hook
  is not installed (see the table above), or you were at the keyboard and that hook's own
  idle check sent the question to the terminal instead.
- **Pushes for sessions you did not expect** — the policy is global, not per project. The
  three AND-layers (remote-answer on, away, auto-mode only) are the way to narrow it.

## Rotating the topic

There is no revocation: a topic is public the moment it is known. To rotate, generate a new
one, change `NTFY_TOPIC`, restart the server, and re-subscribe the phone. The old topic
keeps existing on the ntfy server and anyone holding it keeps being able to publish to it —
so the only thing that matters is that you stop listening to it.

Pushes carry no transcript content by design — the body is a session label and a short
phrase (see [what a push contains](../subsystems/push-notify.md#what-a-push-contains)) —
but the label is your project name, and the tap-through link is your dashboard's address.
Assume a leaked topic reveals both.

<!-- docs-sync:
  sources:
    - server/lib/config.ts
    - server/lib/notify.ts
    - scripts/stop-notify-hook.sh
    - client/src/components/settings/SettingsView.tsx
    - .env.example
    - docker-compose.yml
  kind: workflow
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
