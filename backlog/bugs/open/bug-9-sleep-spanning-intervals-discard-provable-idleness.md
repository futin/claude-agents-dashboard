---
id: bug-9
title: Sleep-spanning intervals discard provable idleness
created: 2026-08-31
tags: usage, forecast
---

## Symptom

The duty-cycle profile cannot learn night hours from a sleeping Mac, which is the exact
case `usage-history.ts`'s premise 1 claims it handles best ("a sleeping laptop is the
best teacher this module has", module docstring).

`classifyInterval` checks `sameWindow(a.resetsAt, b.resetsAt)` *before* the flat-interval
rule, so any interval spanning a 5-hour window expiry returns `reset` and is discarded
whole. An overnight sleep is longer than 5h, so the window always expires mid-sleep and
the whole span is thrown away.

Consequence: night buckets only gather evidence on nights the machine happens to stay
awake. The 23 at-floor overnight buckets in the live profile all read 0% active and were
learned on 26/28/29/30 Aug, when the machine ran through the night — an anomaly, not the
habit. Under normal sleep they never recur, never fold, and stay hatched in the heatmap
forever, so the forecast walk falls back to `globalMean` for them, in the pessimistic
direction.

Short sleeps *do* land correctly (`util 0->0, resets null->null` → `idle`), which is why
the bug is invisible in unit tests and in the parts of the log where no window was open.

## Repro

Live evidence, the single genuine long sleep in `.usage-history.jsonl` as of 2026-08-31:

```
8/27/2026, 3:46:24 AM +427m -> reset  util 0->16  resets 2026-08-27T05:59:59Z -> 2026-08-27T12:09:59Z
```

Seven hours discarded. That particular pair is genuinely unattributable (`util 0->16`, so
activity did occur somewhere in the span), but the shape that matters is the same and is
recoverable — see `## Fix`.

Synthetic repro of the recoverable shape:

- `a = { t: 23:00, utilization: 46, resetsAt: '02:00' }` — evening session, window open
- `b = { t: 08:00 next day, utilization: 0, resetsAt: null }` — wake, no window open

`classifyInterval(a, b)` returns `reset`; `accumulate` credits nothing. Expected: the
span from the old window's expiry (02:00) to `b.t` (08:00) is provably idle.

## Affects

- server/lib/usage-history.ts:153 — `classifyInterval`, the `sameWindow` gate runs first
- server/lib/usage-history.ts:84 — `sameWindow`, `null` vs a stamp is "a real change"
- server/lib/usage-history.ts:14 — the docstring premise this contradicts
- server/lib/usage-history.ts:221 — `accumulate` discards on any non-active/idle kind
- client/src/components/usage/UsageProfile.tsx:120 — `RecordingStatus`, the surface where
  the missing night rows show up as permanent hatching

## Cause

Ordering plus an all-or-nothing return type.

1. **Ordering.** The window check precedes the flat check, so "the window changed" wins
   over "nothing was spent". For a *short* interval that is right — a window change means
   the delta is uncomparable. For a long one it throws away a sub-span whose idleness is
   still provable.
2. **Return type.** `IntervalKind` is one label for the whole span, so there is no way to
   say "the first two hours are unattributable, the last six are idle". `accumulate`
   credits the whole interval or none of it.

Note the asymmetry that makes the recovery sound: `utilization` is cumulative *within* a
window, and a wake sample with `resetsAt === null` means no window is open at all. No
open window ⇒ nothing has been spent since the previous window ended. The old window's
end time is already in hand as `Date.parse(a.resetsAt)`.

## Fix

Credit the provable sub-span instead of discarding the interval.

**Condition.** `!sameWindow(a.resetsAt, b.resetsAt)` && `b.resetsAt === null` &&
`b.utilization === 0` && `a.resetsAt !== null` && `Date.parse(a.resetsAt) < b.t`.

**Credit.** `[Date.parse(a.resetsAt), b.t]` as `idle`. The span from `a.t` to the old
window's expiry stays discarded — tokens could have been spent there and the counter that
would have shown it has since reset.

**Shape.** `IntervalKind` is a single label, so this needs either a new kind carrying a
start override, or for `classifyInterval` to return `{ kind, fromMs? }`. The second is
probably cleaner but touches every call site: `accumulate`, `recordTick`'s ring push, and
the tests. Decide during grooming; the ring's `spanMs` accounting must stay consistent
with whatever `accumulate` credits, or the weekly active rate and the profile disagree.

**Do not** widen `sameWindow`. Its 2-minute slack is calibrated against measured
sub-second jitter (docstring at server/lib/usage-history.ts:70) and a wider window would
merge genuinely different 5-hour windows.

## Test cases

Per CLAUDE.md, these are cases and expected values, not code — and each guard needs to be
mutation-proved: delete the guard, watch the test go red.

1. **The recoverable sleep.** `a = { t: T, utilization: 46, resetsAt: T+3h }`,
   `b = { t: T+9h, utilization: 0, resetsAt: null }`. Expect idle credit for exactly
   `[T+3h, T+9h]` = 360 min, and zero credit for `[T, T+3h]`. Assert the per-bucket split
   too, not just the total — the credit must land in the 6 hour-of-week buckets covering
   T+3h..T+9h and in no others.
2. **Wake with a fresh window open — still discarded.** Same `a`;
   `b = { t: T+9h, utilization: 16, resetsAt: T+14h }`. Expect `reset`, zero credit. This
   is the real 8/27 line above; activity occurred somewhere in the span and cannot be
   placed.
3. **Wake at 0% but with a window open.** `b = { t: T+9h, utilization: 0, resetsAt: T+14h }`.
   A window exists and reads 0, so nothing has been spent *in it*; but it opened at an
   unknown moment, so the old window's expiry is still the only defensible start.
   Expect the same credit as case 1 — decide during grooming whether that is right, and
   record the decision either way. This is the complement case the mirror-bug rule is about.
4. **The untested complement: no window before.** `a.resetsAt === null`,
   `b.resetsAt === null`, both utilizations 0, 9-hour gap. Already `idle` today; assert it
   stays `idle` with full credit so the fix does not narrow the working path.
5. **Utilization dropped across the boundary.** `a.utilization = 46`,
   `b = { utilization: 12, resetsAt: null }`. `b` is non-zero, so the condition must not
   fire. Expect `reset`.
6. **Short window change.** 90-second gap across a window change. Must stay `reset` — the
   fix must not fire on ordinary window rollovers during active use, or every rollover
   injects a bogus idle span.
7. **`a.resetsAt` in the future relative to `b.t`.** Clock skew or a very short sleep:
   `Date.parse(a.resetsAt) > b.t`. Expect `reset`, no negative-length credit.
8. **Unparseable `a.resetsAt`.** Expect `reset`, no `NaN` reaching `accumulate`.

## Done when

- The recoverable sub-span is credited as idle, with the pre-expiry remainder still
  discarded.
- All 8 cases above pass, and each guard has been mutation-proved.
- `pnpm test` and `pnpm typecheck` green, with output pasted.
- The `usage-history.ts` docstring premise 1 is amended to state the actual rule — a
  sleeping laptop teaches only the post-expiry part of the sleep — so the next reader is
  not told the module handles a case it partly discards.
- `docs/subsystems/usage-limits.md` updated to match.
- Probed against live data: rerun the classification sweep over `.usage-history.jsonl` and
  report how many minutes move from `reset` to `idle`. Green unit tests are not enough
  here; the last profile bug hid behind them.
