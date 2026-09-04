---
id: idea-21
title: Bring the dashboard tab to the front when a desk push is tapped
created: 2026-09-04
tags: notify, focus, remote-access
from: task-17
---

## Problem

Tapping a desk notification now does everything task-17 promised **except put the dashboard
in front of you**. Confirmed in real use on 2026-09-04, after task-17 was verified working:

> "the session was changed, but I was not redirected to this tab, I had to manually click on it"

The sequence is: ntfy's service worker `openWindow`s the throwaway `/api/focus` tab (Chrome
comes forward to show it), the dashboard tab claims the tap and switches its drawer, the
throwaway closes — and Chrome then activates whatever tab was previously in front, which is
generally *not* the dashboard. The drawer is open and correct on a tab you cannot see.

This was predicted and deliberately deferred. task-17 dropped design 3's optional step 4
(`osascript` against Chrome) as YAGNI, with the note "if focus placement turns out to annoy
in daily use, file a follow-up idea". This is that follow-up.

Not a defect in task-17 — everything it specified works. It is the last part of "one tap
from buzz to answerable" that is still missing.

## Rough shape

Three routes, in ascending cost. **The page cannot do this on its own** — a tab opened by
`clients.openWindow` carries no user activation, and `WindowClient.focus()` requires an
event that has it, so no amount of same-origin messaging from the throwaway page will move
focus.

1. **`osascript` against Chrome**, from the server, on the `/api/focus` request: activate
   the app, then select the tab whose URL matches the dashboard. macOS-only, and it needs
   the Automation (Apple Events) TCC grant — the same one-time dialog that blocked the
   iTerm2 attempt on 2026-09-04, which has to be approved at the desk. It also means the
   dashboard shells out to drive the user's browser, which is a new kind of thing for this
   server to do (`docs/subsystems/remote-access.md` posture).

2. **Dashboard-owned web push** — idea-20's design 2, deferred at grooming time. Our own
   service worker on our own origin handles `notificationclick`, which *does* carry user
   activation, so `clients.matchAll()` → `client.focus()` → `client.navigate()` works
   natively. No shell-out, no TCC, no throwaway tab at all.

   Cost: VAPID + RFC 8291 payload encryption + a subscription store, ~200–300 lines, all
   within `node:crypto` so the zero-dep rule holds. Note it needs no tunnel: `http://localhost`
   is a secure context, so the subscription works at the desk with no `DASHBOARD_PUBLIC_URL`.

   It would also delete two other problems: the background-notifications trap (ntfy only
   honours `Click` when delivery goes through *its* service worker — see
   `docs/workflows/push-notify-setup.md`), and the throwaway tab flash entirely.

3. **Accept it and document it.** Chrome does come forward; you land one tab away. Cheapest
   answer, and honest if the tap is rare.

## Could design 2 replace ntfy on mobile too? (asked 2026-09-04)

Yes — with one platform caveat. Checked live on this machine rather than from memory:

- **`DASHBOARD_PUBLIC_URL` is already HTTPS** (`tailscale serve`), which is the gating
  requirement: web push needs a secure context, and a plain `http://…ts.net:4173` would
  have ruled this out entirely. `http://localhost` also qualifies, so the desk works with
  no tunnel at all.
- **`node:crypto` covers the whole protocol on Node 22**: `createECDH('prime256v1')`,
  `hkdfSync`, `createCipheriv('aes-128-gcm')`, and — the fiddly one — `sign` with
  `dsaEncoding: 'ieee-p1363'`, which is the raw R‖S form VAPID's ES256 JWT requires rather
  than the DER default. Zero new server deps holds.
- **No manifest or service worker exists in `client/` yet**; both would be new.

| Platform | Works | Friction |
|---|---|---|
| Desktop Chrome / Firefox / Edge | yes | none, and it fixes this idea natively |
| Android Chrome | yes | none — ordinary tab over HTTPS |
| **iOS 16.4+** | yes | **only from a Home-Screen-installed PWA.** Never from a Safari tab. |

The iOS row is the decision: the phone stops being "open the dashboard in Safari" and
becomes "install the dashboard". Note also that `new Notification()` does not exist on iOS
even inside an installed PWA — it must be `registration.showNotification()` from the worker.
`docs/subsystems/push-notify.md` already listed exactly these requirements when it justified
deleting the old in-browser layer.

**What replacing ntfy outright would buy**, beyond focus control: ntfy.sh currently sees
every notification body — project names, the phrase, and this dashboard's address. Owning
the transport means nobody does. It also deletes the topic-as-credential problem and the
background-notifications trap (`docs/workflows/push-notify-setup.md`), and collapses two
transports into one.

**What it costs:** a subscription store with pruning on 410/404, a VAPID keypair, a
manifest, a service worker, per-device subscribe UI — and on iOS, delivery that is
genuinely less reliable than a native app holding an OS-maintained connection.

**Recommended shape: phase it, desktop first.** Build design 2 for the desk channel only and
leave ntfy on the phone. Desktop is where the pain is, needs no install, and is verifiable
without a phone in the loop. Phase 1 builds ~90% of phase 2 — VAPID, the store, the worker,
the encryption — so mobile later reduces to "add to Home Screen, press Subscribe", and iOS
reliability gets to prove itself before anything depends on it.

## Open questions

- Is being one manual click away actually a problem, or just surprising the first few times?
  That decides whether this is worth 200+ lines.
- If (2), does ntfy stay as the phone channel? idea-20 assumed it must, because iOS had no
  other option. That assumption is now known to be **wrong** — iOS 16.4+ does support web
  push from an installed PWA — so keeping ntfy on mobile is a choice about reliability and
  install friction, not a platform limit. See the section above.
- If (1), is a server that runs `osascript` against the user's browser acceptable here at
  all? It is a bigger posture change than it looks.
- Does `bug-18` (two dashboards racing for one tap) get easier or harder under (2)? A
  per-subscription push would address the desk device directly, which may dissolve it.
