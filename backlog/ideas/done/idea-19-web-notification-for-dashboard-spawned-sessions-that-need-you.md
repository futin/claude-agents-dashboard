---
id: idea-19
title: Web notification for dashboard-spawned sessions that need you
created: 2026-09-02
tags: notifications, spawn, client
updated: 2026-09-04T11:42:03Z
promoted-to: task-16
groom-elapsed: 745
---

## Problem

A session started by the CLI or the desktop app notifies you natively when it needs
something — question, plan, permission prompt, turn end. A session **spawned by the
dashboard** (`POST /api/spawn` → detached headless `claude -p`, see
`docs/subsystems/spawn.md`) has no UI attached to it, so nothing native ever fires. It
is the one class of session with **no desk-side channel at all**.

`docs/subsystems/push-notify.md` states the trade explicitly: the browser notification
layer was deleted on purpose (~530 lines, 21 tests) because on iOS `Notification` does
not exist in a tab, and on a Mac it merely repeated the CLI's own notification on the
same screen. The reasoning holds for CLI-started sessions. It does **not** hold for
headless spawned ones — there is no CLI notification to duplicate. Today a Mac with no
`NTFY_TOPIC` configured gets nothing when a dashboard-spawned session parks on a
question, and the only signal is the row color, which requires you to already be looking.

Server side, the timing signal already exists and is already routed: `maybeSend(config,
'question' | 'plan' | 'permission' | 'stop', …)` fires at the exact moments this wants.
Nothing new has to be detected — only delivered to an open browser tab.

## Rough shape

Reintroduce a **narrow** browser notification, scoped so the old duplication argument
cannot come back:

- Fire only for sessions the dashboard itself owns — origin `dashboard` / spawned — not
  for every session in the list. That is the whole distinction that justifies it.
- Fire only for the events already classified as "needs you": `question`, `plan`,
  `permission`, `stop`. Reuse the existing per-event Settings toggles rather than
  inventing a second taxonomy.
- Delivery: the poll already runs every 3s. A diff over what the poll returns needs no
  new transport, unlike the SSE stream the old layer carried (which was deleted with it).
- Click behavior: reuse the existing notification deep link (opens that session's chat) —
  and mind bug-10's fix, which was about the drawer opening off-screen from a deep link.
- Feature-detect `window.Notification` and hide the toggle entirely where it is absent
  (iOS Safari / Chrome-on-iOS), instead of shipping a switch that looks on and does
  nothing — that was the original bug, not an implementation detail.
- Independent of ntfy: this is the desk channel, ntfy is the away channel. Both on should
  not double-notify the same event on the same machine.

## Open questions

- Scope: dashboard-spawned sessions only, or any session whose host machine is not the
  one running this browser? The second is more useful (a session in Docker or on a remote
  host also posts nothing to your screen) but needs a host identity the API does not
  expose today.
- Does the polling diff give a clean enough edge, or does a needs-you state that flaps
  across polls produce repeat notifications? Needs a per-session dedupe key.
- Settings: a third switch group, or a "also notify this browser" checkbox inside the
  existing push-notification block? The existing block is labelled "every device"; a
  browser-local toggle is per-device, so it does not belong under that heading as-is.
- Overlap with idea-14 (push on the first drift crossing) — same delivery question, and
  worth deciding whether both go through one notification path or two.
- Should permission prompts be included at all? A permission prompt is answerable only in
  the originating terminal, and a headless spawned session has none — so what does a
  notification for it ask the user to do?
