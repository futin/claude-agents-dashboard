---
id: idea-18
title: Distinguish a ledger that did not exist yet from a recorder that missed minutes
created: 2026-09-01
tags: usage, server, analytics
updated: 2026-09-02T18:44:44Z
promoted-to: task-15
groom-elapsed: 148
---

## Problem

On the live logs (measured 2026-09-01), **447 of 719** utilisation percentage points — 62% of
everything the 5-hour counter moved — are classified `gap` and dropped from every fit. The
card therefore prices under a quarter of reality (169 pts, 23%) while saying nothing about
the rest.

That number looks alarming and mostly is not. Probing the two logs:

- `.usage-history.jsonl` spans `2026-08-25T21:16Z` → `2026-09-01T16:18Z` (7 days).
- `.usage-ledger.jsonl` spans `2026-08-31T07:42Z` → `2026-09-01T16:18Z` (1.4 days).
- **758 of the 767** `gap` intervals (99%) have *zero* ledger coverage — not partial, none:
  no ledger line exists anywhere in the span. Only 9 are genuine partial-coverage cases
  falling under `LEDGER_COVERAGE_MIN` (median coverage 0.45).

So the bulk of `gap` is the six days of history that predate the ledger file existing at
all, and it will age out of the 3-day `CURRENT_MS` window on its own. `gap` is doing exactly
its job here.

The residual is real but small: inside the ledger's own span there are **11 non-abutting
breaks totalling 11.3 hours** — the recorder genuinely was not running. Median `gap` span is
6 minutes, p90 is 16, max 74.

The actual defect is not the dropping, it is that these two situations are indistinguishable
to anything downstream:

- "there was no ledger yet, nothing was ever recorded here" — benign, self-healing;
- "the recorder should have been running and was not" — a measurement hole worth surfacing;
- "the recorder ran but covered under 80% of the span" — the case `LEDGER_COVERAGE_MIN` was
  actually designed for, and 9 of 767 here.

All three land in one bucket named `gap`, so a user seeing a `collecting` badge on a
two-week-old install cannot tell whether they need to leave the dashboard running or simply
wait.

## Rough shape

Split `gap` by cause, and let the Usage tab say which one it is looking at.

- Classify on evidence already available at join time: zero ledger overlap versus partial
  overlap below the threshold. Zero overlap where the interval also predates the earliest
  ledger line is the "no ledger yet" case and is provably benign — the earliest ledger
  timestamp is one cheap read.
- Surface the split as counters, not a new fitted quantity. The card already has an honest
  place for this: it prints its evidence ("138 windows · 147.0 pts") beside every rate, and
  the footer already carries the `% external` pill for the same reason. "62% of the window's
  movement is unmeasured, of which almost all predates recording" is the same kind of
  statement.
- The 11.3 hours of in-span breaks are worth their own line, because the fix is behavioural:
  keep the dashboard running, or accept the hole. Fabricating tokens for those hours is the
  one thing not to do.
- Consider whether `docs/subsystems/usage-limits.md`'s classification table should name the
  three sub-cases; it currently documents `gap` as a single kind, which is what made this
  62% read as a defect rather than a startup artifact.

Small, self-contained, and it removes the largest scary number on the card without changing
a single fitted rate.

## Open questions

- Is the earliest-ledger-line boundary enough to separate "no ledger yet" from "recorder
  down", or does that need an explicit marker written when recording is enabled? The former
  is free but wrong in one case: a log rotated to its newest half (`MAX_LEDGER_BYTES`) would
  make old intervals look pre-ledger when they were in fact recorded.
- Should the split be exposed through `/api/usage/profile`, the rates payload, or a third
  place? The rates payload is where the reader already is.
- Does an 11.3-hour recorder hole deserve anything more assertive than a counter — for
  instance the same treatment the card gives `Record usage history` being off?
- `LEDGER_COVERAGE_MIN` at 0.8 fired on 9 intervals out of 1030. Is that threshold earning
  its keep, or was the whole-lines-only rule it replaced the only thing it was ever
  protecting against?
