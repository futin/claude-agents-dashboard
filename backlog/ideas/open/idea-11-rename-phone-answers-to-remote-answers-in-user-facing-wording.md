---
id: idea-11
title: Rename phone answers to remote answers in user-facing wording
created: 2026-08-30
tags: ui, docs, wording
---

## Problem

The feature is labelled **"phone answers"** in the toolbar pill, the Settings row and
several docs, but the code, the API contract and the env var all call it *remote answer*
(`RemoteAnswerToggle`, `useRemoteAnswer`, `RemoteAnswerState`, `server/lib/remoteState.ts`,
`REMOTE_ANSWER`, `docs/workflows/remote-answer-setup.md`). Only the human-readable strings
lag behind.

"Phone" is now actively misleading, not just inconsistent: the answer surface is whatever
browser is open — a laptop, a tablet, the same machine in another tab — and remote answers
also drive actions beyond a plain reply (backlog-style action prompts, plan approval via
`server/lib/plans.ts`, permission decisions). A user reading "phone answers: off" cannot
tell that this is the switch governing all of it.

Note the toggle currently reads `phone answers: disabled` when `REMOTE_ANSWER=false`,
which pairs a device word with an env var named for the concept — the same control, two
names, in one screen.

## Rough shape

Rename the **feature** to "remote answers" in every user-facing string and in prose that
names the feature. Leave "phone" alone wherever it genuinely means the device — LAN access
lines, ntfy push copy, the Claude phone app, CSS breakpoint comments, `vite.config.ts`'s
`Phone (LAN)` log line.

Sites that name the feature (not exhaustive; ~20 hits of the `phone answer(s)` phrasing):

- `client/src/components/RemoteAnswerToggle.tsx:20` — `phone answers: disabled`
- `client/src/components/RemoteAnswerToggle.tsx:40` — `phone answers: {on|off}`
- `client/src/components/settings/SettingsView.tsx:260` — row `name="Phone answers"`
  (its group is already titled "Remote answers · every device" — the row contradicts it)
- `scripts/remote-decision-hook.sh:3,61` — the injected `REMOTE DECISION MODE — the
  dashboard is accepting phone answers …` prompt text, which Claude itself reads
- `scripts/ask-remote-hook.sh:9`, `scripts/plan-remote-hook.sh:16` — comments
- `server/lib/remoteState.ts:4` — module doc "waits for a phone answer"
- `docs/subsystems/remote-answer.md:227` — states the wording rule as *"phone answers"*;
  this line has to be rewritten, not just find-replaced
- `docs/subsystems/remote-plan.md:104`, `docs/workflows/remote-answer-setup.md:52`
- `backlog/bugs/open/bug-6-…md:125` — expected banner text
- `docs/guides/learning/hooks/**` (`lifecycle.md`, `fail-open.md`, `index.html`,
  `tools/figures.mjs:174`) — the deck quotes the hook text verbatim, so it drifts the
  moment the script changes; a stale citation reports as `gone` on the guide board

Mechanically small (strings + comments, no behaviour, no API field), so it can ride along
as one task. `styles.css` class names (`ra-pill`, `ra-dot`) already use the `ra-` prefix
and need no change.

## Open questions

- "Remote answers" or singular "remote answer"? The docs/env use the singular
  (`REMOTE_ANSWER`, `remote-answer.md`), the Settings group header uses the plural.
  Pick one and apply it to both the pill and the row.
- Does the `remote-decision-hook.sh` prompt text count as user-facing? It is read by the
  model, not the user — changing it is safe but should be verified against the hooks deck
  (`docs/guides/learning/hooks/`) so the quoted figure and lesson text move with it.
- The learning-guide HTML under `docs/guides/learning/hooks/` is generated — confirm
  whether `tools/figures.mjs` regenerates `index.html` or whether the HTML is hand-edited,
  before touching either.
- ~~Any Settings string persisted in localStorage keyed by the label?~~ No: storage keys
  are code-side constants (`dashboard.settings` via `client/src/lib/settings.ts:4`,
  `usePersistedState`), never the visible label. Nothing to migrate.
