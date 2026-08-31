---
id: idea-16
title: Second way out of the chat drawer on a phone
created: 2026-08-31
tags: ui, chat, mobile
---

## Problem

bug-10 trapped a phone inside the chat drawer: its close button was pushed off
the right edge of the screen, and nothing else could close it. At <=700px the
drawer is `width:100%`, so there is no scrim left to tap, and a phone has no
Escape key — the two escapes the desktop relies on (`.chat-back` onClick,
the keydown handler in `ChatDrawer.tsx`) are both desktop-only by accident.

bug-10's fix stops the viewport from widening, so the button stays on screen.
It does not give the drawer a second exit: any future layout slip in
`.chat-head` puts the user back in a modal they can only reload out of.

## Rough shape

Push a history entry when the drawer opens and close it on `popstate`, so the
Android back gesture and Safari's back swipe both close the drawer instead of
leaving the app. Pairs with the existing Escape handler — same intent, the
input a phone actually has.

Watch: the deep-link path already rewrites the URL (`deepLinkSession()` strips
`?session=` via `replaceState`), so the pushed entry and that strip have to be
ordered deliberately rather than fighting each other.

## Open questions

- Does back-closes-the-drawer surprise anyone who expects back to leave the page?
- Should a swipe-down-to-close come with it, or is that a second mechanism for
  the same job?
