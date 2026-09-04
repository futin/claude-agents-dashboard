---
id: idea-20
title: Route ntfy pushes to a desk topic when at the desk
created: 2026-09-04
tags: notify, server, remote-access
---

## Problem

Desktop gets no usable notification from the dashboard. `notify.ts` publishes to ntfy
only, which reaches the phone; at the desk that is the wrong device, and the phone push
is the one channel that deep-links (`Click:` → `clickUrl()`).

The obvious desktop fallbacks are both dead ends, checked on 2026-09-04 (macOS 26.5.1):

- `osascript -e 'display notification …'` delivers a banner and a sound, but the
  AppleScript API carries **no click action at all** — clicking activates the sending app
  (Script Editor), which just opens a Finder window. Confirmed delivered via the
  Notification Center db (`com.apple.scripteditor2` row), confirmed unclickable by the API
  surface.
- `terminal-notifier` 3.1.0 supports `-open <url>`, but is adhoc-signed with no Team ID
  and `spctl -a` rejects it, so macOS refuses it notification authorization outright:
  `Could not request notification permission: Notifications are not allowed for this
  application`. It never appears in `com.apple.ncprefs` even after `lsregister -f` + `open`.
- `tell application "iTerm2" to display notification` exits 0 but never delivers —
  Automation TCC is not granted, and granting it needs a dialog at the desk.

## Rough shape

Reuse ntfy for both devices and pick the topic by presence, so the desktop path inherits
the `Click:` deep link that already works on mobile.

Receiver side (no code): ntfy.sh has `enable_web_push: true` (verified in
`https://ntfy.sh/config.js`), and Chrome is already notification-allowed on this Mac
(present in `com.apple.ncprefs`). Subscribing Chrome to the desk topic gives real macOS
banners whose click follows the `Click:` header. Requires Chrome to be *running*; the tab may be
closed. Per `https://docs.ntfy.sh/subscribe/web/`, desktop Chrome/Firefox/Edge/Opera
deliver web push only while the browser runs — Safari 16.1+ on macOS 13+ is the one
desktop browser that delivers with the browser closed, so Safari may be the better
receiver for an always-on desk channel. Background notifications must be turned on
explicitly in the web app's Settings tab; without them an ntfy tab must stay open.

Server side, all building blocks already exist in `server/lib/notify.ts`:

- `readIdleSecs()` — `ioreg` `HIDIdleTime`, the at-the-desk signal, already used by
  `shouldNotify()` for `requireAfk`.
- `clickUrl()` — `<publicUrl>/?session=<id>`, unchanged.
- `config.ntfyTopic` / `config.ntfyServer` in `server/lib/config.ts`.

Proposed change: optional `NTFY_TOPIC_DESK`. When set and `readIdleSecs() <
settings.idleSecs`, publish there instead of `ntfyTopic`. Unset preserves today's
behaviour exactly. A live `curl` publish to `<NTFY_TOPIC>-desk` with a `Click:` header
returned 200, so no ntfy-side setup is needed beyond subscribing.

## Open questions

- Exclusive routing or both? At-desk-only means an alert raised while you are at the
  keyboard never reaches the phone if you walk away ten seconds later. Always-both never
  misses but double-buzzes. Exclusive is the cheaper default since `settings.idleSecs` is
  already tuned for the remote-answer hooks.
- Routing per push costs one `ioreg` spawn (~40ms) even for policies that never set
  `requireAfk`, which the current clause ordering in `shouldNotify()` deliberately avoids.
  Reuse the same reading for both decisions rather than spawning twice.
- Does the desk topic need its own `NotifyPolicy` events, or does it mirror the phone's?
- `readIdleSecs()` returns null off macOS — which topic wins then? Today null means
  "push anyway"; the analogous default is probably the phone topic.
- Whether the user's click on a Chrome web-push banner actually lands on the session
  drawer is **unverified** — needs one manual test.

## Competing design: dashboard-owned web push (raised 2026-09-04)

Confirmed in use: ntfy web push on desktop Chrome works, deep link lands on the right
session — but **every click opens a new tab**, and that cannot be fixed from ntfy's side.
Two independent reasons, both verified against `https://ntfy.sh/sw.js`:

- ntfy hardcodes `openWindow` for click URLs: `else if (r.click) self.clients.openWindow(r.click)`.
  Its focus-existing-tab branch (`t?t.focus():i?(i.focus(),i.navigate(o))…`) runs only on the
  no-click path.
- That branch only ever matches `self.location.origin`. `clients.matchAll()` is same-origin
  by spec, so ntfy.sh's service worker can never see or focus a tab on the tailnet
  dashboard origin — fixing ntfy upstream would still not help.

The only design that focuses an existing dashboard tab is the dashboard owning the
subscription: its own service worker on its own origin, `notificationclick` doing
`matchAll` → `focus()` → `navigate()`, with `deepLinkSession()`
(`client/src/lib/deepLink.ts`) fed by the SW message instead of `?session=`. ntfy then
drops out of the desktop path; the phone keeps using it.

Cost: VAPID + RFC 8291 payload encryption, plus subscription storage. Notably this stays
within the no-new-server-deps rule — `node:crypto` covers all of it
(`createECDH('prime256v1')`, `hkdfSync`, `createCipheriv('aes-128-gcm')`, ES256 `sign`).
Estimate 200–300 lines. Requires HTTPS, which `DASHBOARD_PUBLIC_URL` over the tailnet
already provides.

Half-measures considered and not recommended: dropping the `Click:` header on the desk
topic (focuses your ntfy tab, loses the session deep link), or having the new tab hand off
over `BroadcastChannel` and close itself (stops tab accumulation, but focus does not land
on the dashboard).

Grooming decides: ship the cheap desk-topic routing above and accept a new tab per click,
or go straight to dashboard-owned push and skip the topic split for desktop entirely.

## Requirement added 2026-09-04: the desk topic clicks through to localhost

The desk push must not send you round the tailnet to reach a server on the same machine.
`clickUrl()` (`server/lib/notify.ts:197`) builds `<publicUrl>/?session=<id>`; the desk
variant should build `<localUrl>/?session=<id>` instead, with `localUrl` defaulting to
`http://localhost:${config.port}` and overridable by a new optional `DASHBOARD_LOCAL_URL`.
Verified working: a push carrying `Click: http://localhost:4173/?session=<id>` returned
200 and the target is the same route `deepLinkSession()` already consumes.

Two consequences worth keeping:

- The desk channel needs **no** `DASHBOARD_PUBLIC_URL` and no tunnel at all. `clickUrl()`
  returns `''` without a public URL and the header is dropped; the desk path has no such
  dependency, so desktop notifications with a working deep link become available to a
  user who never sets up Tailscale.
- Port ambiguity is real and unresolved: prod serves the built client on `PORT` (4173
  here), dev serves it from Vite on 5174 while Node answers API only. A desk URL built
  from `config.port` is wrong in dev. Decide whether to derive it, or require
  `DASHBOARD_LOCAL_URL` when running dev.

## Third design: a localhost focus endpoint (keeps ntfy, still lands on one tab)

Raised because a new tab per click is a dealbreaker, and the dashboard-owned-push design
above is the expensive answer. There is a cheaper one that keeps ntfy.

`Click:` points at `http://localhost:<fe-port>/api/focus?session=<id>` instead of the
dashboard route. ntfy still does its unavoidable `openWindow`, but that tab is a
throwaway:

1. the endpoint records the session as a pending deep link, server-side;
2. the already-open dashboard tab picks it up on its next 3s poll and opens the drawer —
   no new navigation, no new tab;
3. the endpoint responds with a page that calls `window.close()`, so the throwaway tab
   disappears instead of accumulating;
4. optionally the server also runs `osascript` against Chrome
   (`set active tab index of window N to i`, then `activate`) to bring the real dashboard
   tab to the front.

Trade-offs and unknowns, in the order they would sink it:

- **Unverified: whether `window.close()` is permitted on a tab opened by
  `clients.openWindow`.** Chrome blocks `window.close()` on tabs the user opened; tabs
  opened by script are allowed. If a service-worker-opened tab does not count as
  script-opened, step 3 fails and the tab count problem returns. Test this before costing
  the rest.
- Step 4 needs Automation (Apple Events) permission for whatever runs `osascript` — the
  same one-time TCC dialog that blocked the iTerm2 attempt on 2026-09-04. Without it the
  tab still closes but focus lands wherever Chrome decides, likely the previously active
  tab.
- Adds a pending-deep-link field to the poll payload, so `shared/types.ts` first, then the
  server producer, then the client — the usual order.
- macOS-only for the focus half; the close half is portable.

Compared with dashboard-owned push: much smaller, keeps one notification transport for
both devices, but leans on a shell-out and a browser behaviour that is not guaranteed.
