---
id: task-18
title: Deliver desk pushes over dashboard-owned web push so the tap focuses the tab
created: 2026-09-04
from: idea-21
updated: 2026-09-04T20:55:25Z
rejected: 2026-09-04
groom-elapsed: 30
---

## What was proposed

Replace the *desk* notification transport with dashboard-owned Web Push: the server signs a
VAPID JWT (RFC 8292), encrypts an `aes128gcm` payload (RFC 8291) with `node:crypto` alone,
and POSTs it straight to the browser's push service. A service worker at the dashboard
origin (`client/public/sw.js`) would then handle `notificationclick` — an event that *does*
carry user activation — and, on a tap, focus the existing dashboard tab and navigate it to
`/?session=<id>`. ntfy would have kept the phone.

The point was that the ntfy path can never do this: its service worker is cross-origin, so
`clients.matchAll()` cannot see a dashboard tab by spec, and the throwaway tab it opens has
no user activation to spend on `WindowClient.focus()`.

The plan was fully groomed — seven tasks, 35 test cases, the RFC 8291 §A.2 vector executed
on this machine — and none of it was built.

## Why rejected

The tap it was meant to improve no longer exists. `c6b806c` ("desk pushes alert only — drop
the deep link") made the desk push inert on purpose: the deep link, `server/lib/focus.ts`,
`/api/focus`, `/api/focus/pending`, `/api/focus/claimed`, `FocusPendingResponse` and
`useFocusWatch` are all gone, and the push now points at `/api/dismiss`, whose page closes
the tab it arrived in. A desk notification is an alert now, by decision, not a link.

So the entire payoff of this task — "the tap lands you on the dashboard with zero further
clicks" — is a behaviour the repo deliberately removed. Building ~700 lines of VAPID JWT
signing, RFC 8291 encryption, a service worker, a subscription store and a signing key on
disk to improve a tap that is designed to do nothing is cost with no return.

Note that the deep link was *not* removed because it failed: it was verified working end to
end, and `docs/subsystems/push-notify.md` records both that and the one thing it could never
do (bring the tab to the front). This rejection follows that decision; it does not restate it.

`bug-18` is unaffected and stays open — it describes the ntfy path, which is still the
transport in use.

## What would change the answer

Wanting the tap-through back. If a desk tap should ever land you on the dashboard again,
dashboard-owned web push is the *only* transport that can do it — ntfy's cross-origin worker
provably cannot, for the two spec reasons above, so this is not a case where a cheaper fix
might turn up later. File a fresh item citing this one; the groomed plan in git history
(`8f51241`) is still valid, including its RFC test vectors.
