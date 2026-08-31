---
id: bug-10
title: Deep link from notification opens chat drawer with head and foot off-screen
created: 2026-08-31
tags: ui, chat, push-notify, mobile
---

## Symptom

Tapping a push notification opens the dashboard on `?session=<id>`, which seeds
`chatId` and mounts the chat drawer immediately. The drawer body renders, but its
top bar (`.chat-head` — the row that carries the ✕ close button) and its bottom bar
(`.chat-foot`) are both off-screen, so there is no visible way to leave the drawer.

Opening the same drawer by tapping a session row inside an already-loaded page does
not show the problem.

## Repro

1. Have a session push a notification (ntfy `Click` header carries `<origin>/?session=<id>`
   — `server/lib/notify.ts`).
2. Tap the notification so the browser cold-loads the dashboard at that URL.
3. Drawer opens; `.chat-head` and `.chat-foot` are not visible on screen.

Unconfirmed: which device/browser, and whether scrolling or rotating brings the two
bars back. Fill in before grooming.

## Affects

- `client/src/lib/deepLink.ts:35` — `deepLinkSession()`, consumed once per load
- `client/src/components/SessionsView.tsx:31` — `chatId` seeded from the deep link,
  so the drawer mounts during the first render rather than on a user gesture
- `client/src/components/ChatDrawer.tsx:152` — `.chat-back` / `.chat` / `.chat-head` /
  `.chat-foot` markup
- `client/src/styles.css:476` — `.chat-back{position:fixed;inset:0}`
- `client/src/styles.css:477` — `.chat{height:100%}`, flex column with the head and
  foot as `flex-shrink:0` siblings of the scrolling body
- `client/src/styles.css:96` — `.shell{zoom:var(--font-scale,1)}`, the ancestor that
  already broke fixed-position geometry once (`.rail`, `.wrap.wide` both divide
  `100vh` by `--font-scale`); `.chat-back` does no such correction

## Cause

Confirmed by measuring the live page in a Chrome mobile emulation at 390x844
(CDP, `Emulation.setDeviceMetricsOverride` with `mobile:true`):

1. The sessions page overflows sideways at phone width. Both offenders are in the
   usage strip: `.usage .u-reset` (`white-space:nowrap` + `flex-shrink:0`) and
   `.usage .u-verdict` (`white-space:nowrap`), each inside a `.u` column only
   ~160px wide at that viewport. Measured right edges: 391.7px and 406.4px
   against a 390px screen.
2. A phone widens its layout viewport to fit that overflow. Measured
   `window.innerWidth` 396-413 while `documentElement.clientWidth` stayed 390,
   and the height scaled with it (844 to 857/892).
3. `.chat-back{position:fixed;inset:0}` is sized against that widened box, so the
   drawer is wider and taller than the screen: `.chat-x` measured at right 401
   (screen ends at 390), `.chat-foot` at bottom 857-892 (screen ends at 844). The
   head is still at y=0, but its close button is pushed off the right edge — the
   part that matters, since it is the only close affordance.
4. Nothing else closes it on a phone: at <=700px `.chat{width:100%}` leaves no
   scrim to tap, and there is no Escape key. Reloading is the only way out, and a
   reload also clears the drawer because `deepLinkSession()` consumes and strips
   `?session=` on first read — which is why only a reload fixes it.

Not deep-link specific in mechanism: a drawer opened by tapping a row on a phone
traps the same way. The notification is just the path that puts you inside the
drawer on a phone in the first place.

Probe that proved the chain: injecting
`.tool,.u-verdict,.u-reset{max-width:200px;overflow:hidden}` at runtime collapsed
the layout viewport from 396 back to 390 and put `.chat-foot` at bottom 844 and
`.chat-x` at right 378 — both back on screen.

## Fix

Branch `fix/drawer-viewport-overflow`, `client/src/styles.css` only:

- `.usage .u-reset` — drop `flex-shrink:0`, add
  `min-width:0;overflow:hidden;text-overflow:ellipsis` so the rate/reset text
  shrinks instead of overflowing.
- `.usage .u-verdict` — same three declarations.
- `.main{overflow-x:clip}` — containment, so a future long session name or MCP
  tool id cannot widen the viewport and re-trap the drawer. `clip` and not
  `hidden`: it creates no scroll container, so the sticky rail keeps sticking and
  the inner horizontal scrollers (`.md-pre`, `.md-table-wrap`, `.up-tablewrap`)
  keep their own scrolling.

`html{overflow-x:clip}` was tried first and measured ineffective — with a 3000px
unbreakable string on the page the layout viewport still widened to 1560 and the
drawer went off-screen with it. On `.main` the same probe leaves innerWidth at
390, the close button at right 378 and the foot at bottom 844.

Verified: mobile-emulated measurement (viewport 390, zero overflowing elements,
close button and foot on screen, unchanged with the 3000px string appended), the
close button click closes the drawer, sticky rail still pins to top 0 after a
600px scroll, `pnpm typecheck` clean, `pnpm test` ALL PASS (after `pnpm build` —
one API test needs a built `client/dist` and fails in a fresh worktree without it).

Not verified: a real phone. The report came from one, and the emulation is
Chromes; iOS Safari sizes fixed panels the same way, but that is reasoning, not a
measurement.
