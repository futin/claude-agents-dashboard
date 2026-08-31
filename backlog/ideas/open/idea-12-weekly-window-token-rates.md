---
id: idea-12
title: Weekly-window token rates
created: 2026-08-31
---

## Problem

Task-8 measures the token value of the **5-hour** window only. The weekly window has
the same unanswered question — what is 1% of the week worth, per model — and the
weekly number is the one that actually constrains a week of work. The 5h answer does
not transfer: the two windows are different series with different budgets.

## Rough shape

`.usage-history.jsonl` records the 5h series only (`recordTick` is fed
`limits.fiveHour`), so there is nothing for a weekly fitter to join against. The
prerequisite is persisting the weekly series too — a second sample stream, or a
second field per line. Once that exists, `usage-rate.ts` is already window-agnostic
apart from `sameWindow` slack and the floors: the ledger is shared, since tokens are
tokens whichever window they were charged to.

Deferred deliberately at task-8's execution, not forgotten.

## Open questions

- One log with both windows per line, or a second file? A second field is cheaper but
  changes the sample shape every existing reader parses.
- The weekly window's true length is still unproven (see the ⚠️ in
  `docs/subsystems/usage-limits.md`) — does a weekly rate care, given it only needs
  Δutil rather than the window's span?
- Are the confidence floors right for a series that moves in ~1% integer steps? The
  5h floors assume a sensor that sweeps.
