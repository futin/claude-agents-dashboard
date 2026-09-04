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

## Open questions

- Is being one manual click away actually a problem, or just surprising the first few times?
  That decides whether this is worth 200+ lines.
- If (2), does ntfy stay as the phone channel and the dashboard's own push serve only the
  desk? That was idea-20's assumption and it still looks right — iOS has no other option.
- If (1), is a server that runs `osascript` against the user's browser acceptable here at
  all? It is a bigger posture change than it looks.
- Does `bug-18` (two dashboards racing for one tap) get easier or harder under (2)? A
  per-subscription push would address the desk device directly, which may dissolve it.
