---
id: bug-18
title: A desk-push tap is claimed by whichever dashboard tab polls first
created: 2026-09-04
tags: notify, focus, remote-access
updated: 2026-09-04T21:30:00Z
---

## Symptom

Tapping a desk notification opens the session drawer in **exactly one** dashboard tab, and
which one is a race nobody can predict. With the dashboard open in two places — the desk
browser and a phone, say — the tap can land on the device you are *not* looking at, and the
one you are looking at shows nothing at all.

Observed live on 2026-09-04 while testing task-17: a second dashboard tab (real Chrome) beat
the tab under test three times running, over a 9-second window covering three of its poll
cycles. The losing tab was confirmed to be polling normally (2 polls in 7s, 3s apart), so it
was genuinely racing and losing, not idle.

The tap is never *lost* — a tab does open the drawer — so the failure reads as "nothing
happened" rather than as an error.

## Repro

1. Set `NTFY_TOPIC_DESK` and open the dashboard in two browsers (or a browser and a phone),
   both polling the same server.
2. `curl "http://localhost:<port>/api/focus?session=<a real session id>"`.
3. Watch both. Exactly one opens the drawer; the other never does.

Server-side, the same thing without a browser: hit `/api/focus`, wait 6s **without polling
yourself**, then `GET /api/sessions`. `focusSession` is already absent — another poller took
it.

## Affects

- `server/lib/focus.ts:67` — `takeFocus()` clears the slot on the first read, so the first
  poll to arrive anywhere consumes it for everyone.
- `server/api.ts` `serveSessions` — attaches `focusSession` from that single-claim read.
- `client/src/components/SessionsView.tsx` — the effect that opens the drawer, which
  therefore fires in at most one tab.

`server/lib/focus.ts` already documents the *related* imprecision for `dashboardOpen()` ("a
phone polling from the couch also counts"), but only for the open/closed decision. The
`takeFocus` race is a separate and more user-visible consequence and is documented nowhere.

## Cause

unknown — but the mechanism is not in doubt; what is unsettled is which behaviour is wanted.
Consume-once was chosen so a stale tap could not reopen a drawer on a later poll, and it does
achieve that. It was designed against one dashboard tab; nothing about it accounts for two.

## Fix

unknown. Two candidates, to be settled in grooming:

- **Broadcast within a short window.** Serve `focusSession` to every poll within ~5s of the
  tap rather than to the first one, then clear. Every open dashboard opens the drawer. Cheap
  — a comparison instead of a clear in `takeFocus`. Opens the drawer in tabs you are not
  looking at, which is benign (the drawer is per-tab UI with no side effects), and the client
  effect keyed on `data?.focusSession` will not re-fire for a repeated id. Watch the edge
  case: tapping the *same* session twice inside the window carries an unchanged id, so the
  dep does not change and a reopened drawer would not reopen.
- **Address the tap.** Give each dashboard tab an id and have the desk link name one. Exact,
  but the desk push would have to know which tab is at the desk, which is the problem this
  feature already declined to solve with `osascript`.

Worth deciding first whether this is a defect at all: "the drawer opened somewhere" may be
acceptable, in which case the honest fix is documenting it in
`docs/subsystems/push-notify.md` rather than changing the behaviour.

## Outcome — moot, closed without a behaviour fix (2026-09-04)

Neither candidate was taken. The deep link this bug is about was removed wholesale in
`c6b806c` (*feat(notify)!: desk pushes alert only*), by request: a desk push is now an
alert whose tap-through points at `GET /api/dismiss` and closes the tab it opened in. With
no `focusSession` on the poll there is no single claim left to race for, so the symptom is
gone by construction.

Everything this bug cites is deleted: `server/lib/focus.ts`, `GET /api/focus`,
`FocusPendingResponse`, `useFocusWatch`, and the `SessionsView` effect. The race itself is
still a real hazard for any future consume-once-on-poll channel, and the reasoning is
preserved here rather than in the code.

**If the deep link comes back**, it returns through `task-18` (dashboard-owned web push),
which delivers to a specific service-worker subscription rather than to whichever tab polls
first — so this bug's mechanism does not come back with it. Re-read this file before
designing that handoff anyway.
