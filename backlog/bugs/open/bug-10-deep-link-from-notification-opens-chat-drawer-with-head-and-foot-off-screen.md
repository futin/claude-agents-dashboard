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

unknown

## Fix

unknown
