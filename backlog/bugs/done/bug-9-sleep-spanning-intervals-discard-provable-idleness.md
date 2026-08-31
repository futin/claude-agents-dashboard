---
id: bug-9
title: Sleep-spanning intervals discard provable idleness
created: 2026-08-31
tags: usage, forecast
updated: 2026-08-31T17:26:58Z
groom-elapsed: 92
started: 2026-08-31T17:14:05Z
execute-elapsed: 773
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

Seven hours discarded, of which **70 minutes are provably idle** and recoverable: the old
window expired at 05:59:59Z and the new window — the one that reads 16% at wake — cannot
have opened before 07:09:59Z, because its own `resetsAt` of 12:09:59Z is exactly five hours
later. No window was open between those two stamps, so nothing was spent between them.
The rest of the span stays unattributable and stays discarded. (Grooming reversed the
original reading of this line, which called the whole pair unattributable.)

Synthetic repro of the plainest recoverable shape:

- `a = { t: 23:00, utilization: 46, resetsAt: '02:00' }` — evening session, window open
- `b = { t: 08:00 next day, utilization: 0, resetsAt: null }` — wake, no window open

`classifyInterval(a, b)` returns `reset`; `accumulate` credits nothing. Expected: the
span from the old window's expiry (02:00) to `b.t` (08:00) is provably idle.

## Affects

- server/lib/usage-history.ts:153 — `classifyInterval`, the `sameWindow` gate runs first
- server/lib/usage-history.ts:84 — `sameWindow`, `null` vs a stamp is "a real change"
- server/lib/usage-history.ts:14 — the docstring premise this contradicts
- server/lib/usage-history.ts:236 — `accumulate` discards on any non-active/idle kind
- server/lib/usage-history.ts:560 — `recordTick`'s ring push; checked during grooming and
  it needs **no** change, see `## Fix`
- client/src/components/usage/UsageProfile.tsx:122 — `RecordingStatus`, the surface where
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

The asymmetry that makes recovery sound: `utilization` is cumulative *within* a window,
so it says nothing across a window boundary — but the **existence** of a window does.
Between the moment one window expires and the moment the next one opens, no window is
open at all, and no window open means nothing has been spent. Both of those moments are
in hand:

- the old window's expiry is `Date.parse(a.resetsAt)` directly;
- the new window's opening is `Date.parse(b.resetsAt) - 5h`, because the payload's own
  field is named `five_hour` and carries only `resets_at` (server/lib/usage.ts:134) —
  deriving the start is the only way to date it, and `usage-pace.ts:57` already encodes
  the same 5-hour length.

Either end can also be a sample rather than a stamp: `resetsAt === null` at a sample means
no window was open *at that instant*, so that sample's own `t` is a valid bound.

## Fix

Credit the provable sub-span instead of discarding the interval, as a **separate helper**
consulted by `accumulate` — `classifyInterval` keeps its `IntervalKind` return unchanged.
That was a grooming decision between two shapes; the alternative (`classifyInterval`
returning `{ kind, fromMs?, toMs? }`) reads better in one place but rewrites the ring push
and all eleven classifier assertions in `test/usage-history.test.ts` for no behaviour gain,
because — see below — the ring does not want the split. The cost of the chosen shape is
that a reader of `classifyInterval` cannot see the recovery, so its docstring must point
at the helper.

**New constant.** `WINDOW_MS = 5 * HOUR_MS`, exported or not as convenient, documented
with its failure direction: if the plan tier ever serves a window *longer* than 5h, the
derived start lands too late and the fix injects idle credit over a stretch that did have
a window open. A shorter real window only under-credits, which is harmless. `five_hour` is
the API's own field name, so this is as solid as that name.

**New helper.** `provableIdleSpan(a: UsageSample, b: UsageSample): [fromMs, toMs] | null` —
the sub-span of `[a.t, b.t]` during which no 5-hour window was open. Returns `null` when
nothing is provable. Behaviour:

- `sameWindow(a.resetsAt, b.resetsAt)` → `null`. Not a window change; `classifyInterval`
  already handles those and this helper must never second-guess it.
- **from**: `a.resetsAt` non-null and parseable → its parsed value (the old expiry).
  `a.resetsAt === null` **and** `a.utilization === 0` → `a.t`. `a.resetsAt === null` with
  a non-zero utilization → `null`; that sample claims spend with no window open and is
  self-contradictory, so it is not evidence of anything. Unparseable → `null`.
- **to**: `b.resetsAt` non-null and parseable → `Date.parse(b.resetsAt) - WINDOW_MS` (the
  derived opening of the new window). `b.resetsAt === null` **and** `b.utilization === 0`
  → `b.t`. `b.resetsAt === null` with non-zero utilization → `null`, same contradiction.
  Unparseable → `null`.
- **clamp**: `lo = max(from, a.t)`, `hi = min(to, b.t)`; return `[lo, hi]` only when
  `hi > lo`, else `null`. This clamp is what makes clock skew, overlapping stamps and
  a-future-expiry all fall out as `null` rather than as negative-length credit.

**accumulate.** When `classifyInterval` returns `reset`, consult the helper; a non-null
span is credited as `idle` over exactly `[lo, hi]` through the existing hour-slicing loop,
so week stamping, folding and `lifetimeObservedMin` all keep working unchanged. Anything
else about `accumulate` stays as it is: `active`/`idle` credit the full interval,
`ambiguous` is still discarded, and the function still never mutates `state`. `ambiguous`
never reaches the helper anyway — it can only arise inside one window.

**The ring needs no change, and this was verified during grooming.** `observedActiveMs`
sums only entries whose `kind === 'active'` and otherwise uses `spanMs` for contiguity, so
a partly-idle interval contributes zero active time whether it is labelled `reset` or
anything else, while the full `spanMs` keeps coverage unbroken. Push the whole span with
the label `classifyInterval` gives, exactly as today. Changing `spanMs` to the credited
sub-span would punch a hole in coverage and make `observedActiveMs` return `null`.

**Do not** widen `sameWindow`. Its 2-minute slack is calibrated against measured
sub-second jitter (docstring at server/lib/usage-history.ts:70) and a wider window would
merge genuinely different 5-hour windows.

**Measured before choosing.** Sweeping the 908-sample log (140h, 991 minutes currently
classified `reset`): the condition originally written into this bug recovers 29 min and
leaves the 8/27 sleep at zero; adding only the `a.resetsAt === null` side reaches 82 min
and still leaves it at zero; the rule above reaches **152 min, 15.3% of all reset
minutes**, and is the only one of the three that recovers the overnight sleep this bug
was filed about.

## Test cases

Per CLAUDE.md, these are cases and expected values, not code — and each guard needs to be
mutation-proved: delete or invert the guard, watch a *named* test go red. `T` is a Monday
00:00 local unless a case says otherwise; use offset 0 so the bucket arithmetic is legible.

1. **Sleep, no window at wake.** `a = { t: T, utilization: 46, resetsAt: T+3h }`,
   `b = { t: T+9h, utilization: 0, resetsAt: null }`. Expect idle credit for exactly
   `[T+3h, T+9h]` = 360 min. Assert the per-bucket split, not just the total: the six
   hour-of-week buckets covering T+3h..T+9h each hold `observedMin` 60 and `activeMin` 0,
   and the three covering T..T+3h are untouched (`observedMin` 0, `lifetimeObservedMin` 0).
2. **Sleep, fresh window at wake — the 8/27 shape.** `a = { t: T, utilization: 0,
   resetsAt: T+2h }`, `b = { t: T+7h, utilization: 16, resetsAt: T+11h }`. Derived new
   window start is T+6h. Expect idle credit for exactly `[T+2h, T+6h]` = 240 min, with
   `[T, T+2h]` and `[T+6h, T+7h]` both uncredited. **This reverses the expectation this
   bug was filed with** — the pair is not wholly unattributable.
3. **Wake at 0% with a window open.** Same `a` as case 1;
   `b = { t: T+9h, utilization: 0, resetsAt: T+13h }`. Derived start T+8h. Expect credit
   for `[T+3h, T+8h]` = 300 min, and the final hour `[T+8h, T+9h]` uncredited. Decision
   recorded: a window that reads 0 has still been *opened*, and the moment it opened is
   only bounded, not known — so the derived start is the end of what is provable, not
   `b.t`. This is the complement the mirror-bug rule is about; case 1 differs only in that
   no window exists to bound.
4. **No window either side.** `a.resetsAt === null`, `b.resetsAt === null`, both
   utilizations 0, 9-hour gap. `sameWindow(null, null)` is true, so this stays plain
   `idle` through the ordinary classifier with full 540 min credit and the helper is never
   consulted. Guards the working path against being narrowed by the fix.
5. **No window before, window after.** `a = { t: T, utilization: 0, resetsAt: null }`,
   `b = { t: T+9h, utilization: 5, resetsAt: T+13h }`. `from` is `a.t`, `to` is T+8h.
   Expect credit for `[T, T+8h]` = 480 min. This branch is 52 of the 152 live minutes.
6. **Contradictory `a`.** `a = { resetsAt: null, utilization: 40 }`, `b` as in case 5.
   Expect `null` from the helper and zero credit — a sample claiming spend with no window
   open is not evidence.
7. **Contradictory `b` (utilization dropped across the boundary).** `a.utilization = 46`,
   `b = { t: T+9h, utilization: 12, resetsAt: null }`. Expect `reset` and zero credit.
8. **Short rollover during active use.** `a = { t: T, utilization: 96, resetsAt: T+30s }`,
   `b = { t: T+90s, utilization: 0, resetsAt: null }`. Expect **60 s of idle credit** for
   `[T+30s, T+90s]`, with the first 30 s discarded. The original filing expected zero here
   on the grounds that a rollover would inject a bogus span; that was wrong. The minute is
   real — the window had expired and no new one was open — and it is self-limiting, because
   a rollover where the next window opens promptly gives a derived start close to `b.t` and
   so credits almost nothing. What bounds this case is the clamp, not a duration floor.
9. **Clock skew, expiry after `b.t`.** `Date.parse(a.resetsAt) > b.t`. Expect `null`, no
   negative-length span, no credit.
10. **Overlapping stamps.** `a.resetsAt = T+6h`, `b.resetsAt = T+9h` (derived start T+4h,
    earlier than the old expiry). Expect `null` — `hi > lo` fails.
11. **Unparseable stamp,** on either side. Expect `null`, and assert no `NaN` reaches
    `accumulate`: the returned state deep-equals the input state and no bucket holds a
    `NaN` `observedMin`.
12. **Recovered span crossing a week boundary.** A recoverable sleep straddling Sunday
    00:00 local. Assert the Saturday-side and Sunday-side buckets carry *different*
    `weekStamp`s — the slicing loop's existing per-slice week key must still apply to a
    credit that starts mid-interval.
13. **Ring untouched.** Drive `recordTick` over a sleep-spanning pair and assert the ring
    entry still carries `spanMs === b.t - a.t`, that `observedActiveMs` over the whole span
    returns a number rather than `null` (coverage unbroken), and that the active total is
    unchanged by the fix.

## Done when

- The provable sub-span is credited as idle, with both remainders — before the old expiry,
  and after the new window's derived opening — still discarded.
- All 13 cases above pass, and each guard has been mutation-proved: the `sameWindow` early
  return, both contradictory-sample checks, the `- WINDOW_MS` subtraction, the `hi > lo`
  clamp, and both parse checks.
- `pnpm test` and `pnpm typecheck` green, with output pasted.
- The `usage-history.ts` docstring premise 1 is amended to state the actual rule: a
  sleeping laptop teaches the stretch of the sleep during which no window was open — most
  of a real overnight sleep, but never the tail after the next window opens.
- `WINDOW_MS` carries the failure-direction note from `## Fix`, and `classifyInterval`'s
  docstring points at `provableIdleSpan` so the split is discoverable from either side.
- `docs/subsystems/usage-limits.md` updated to match.
- Probed against live data: rerun the classification sweep over `.usage-history.jsonl` and
  report how many minutes move from `reset` to `idle`. The grooming baseline is **152 min
  across 27 intervals, 15.3% of the 991 reset minutes** in the 908-sample log as of
  2026-08-31; a materially different number means the implementation diverged from the
  rule above. Note the log is sparser than live sampling (write-on-change plus a
  heartbeat, versus one sample a minute), so the figure is a cross-check on the rule, not
  a prediction of what the live profile will gain.

## Outcome

2026-08-31 — fixed as planned. `provableIdleSpan(a, b)` added to
`server/lib/usage-history.ts`; `accumulate` consults it when `classifyInterval` returns
`reset` and credits the returned sub-span as `idle`. `classifyInterval` and the ring push
are byte-for-byte unchanged, so the weekly active rate and its coverage window are
untouched.

One deviation from the plan, and it made the code smaller. The two `Number.isNaN` checks
the plan called for turned out to be dead: `Math.max`/`Math.min` propagate `NaN` and every
comparison against it is false, so the `hi > lo` clamp already rejects an unparseable
stamp. Both were deleted rather than kept as an unprovable guard — mutation-proving found
them (G6/G7 below deleted cleanly with every test still green), and dropping the clamp now
fails the unparseable case too, which is the honest proof. The comment above the clamp
records why NaN checks must not be added back.

**Mutation proof.** Each guard deleted in turn, `test/usage-history.test.ts` re-run; every
one took a named test down with it:

```
### G1 delete sameWindow early return
      ✗ MUTATION GUARD: a same-window pair is never the helper’s business
### G2 delete a-side contradiction check
      ✗ MUTATION GUARD: a sample claiming spend with no window open proves nothing
### G3 delete b-side contradiction check
      ✗ MUTATION GUARD: a sample claiming spend with no window open proves nothing
      ✗ MUTATION GUARD: an unprovable window change still touches nothing
### G4 drop - WINDOW_MS
      ✗ provable: sleep ending with a fresh window open stops at its derived start
      ✗ provable: a window reading 0% still bounds the span at its derived start
      ✗ provable: no window before, one after — the sample itself is the start
      ✗ MUTATION GUARD: overlapping stamps yield nothing rather than a gap
      ✗ MUTATION GUARD: the derived start is a whole window before the reset
### G5 drop hi > lo clamp
      ✗ MUTATION GUARD: an expiry later than b.t yields no negative-length span
      ✗ MUTATION GUARD: overlapping stamps yield nothing rather than a gap
      ✗ MUTATION GUARD: an unparseable stamp on either side yields null, not NaN
### G8 accumulate ignores the recovered span
      ✗ accumulate: a recovered sleep credits its hours and leaves the rest alone
      ✗ accumulate: a recovered span crossing a week boundary stamps each side separately
```

**Live probe**, importing the shipped `classifyInterval` and `provableIdleSpan` rather
than a reimplementation — within a hair of the grooming baseline of 152 min / 27 intervals
(the log gained 7 samples in between, moving reset minutes 991 → 995):

```
samples 915, span 140.1h
minutes by kind (unchanged — classifyInterval is untouched): { active: 792, idle: 5169, ambiguous: 1450, reset: 995 }
reset -> idle: 27 intervals, 151.5 min (15.2% of reset minutes)
  a-null        6 intervals, 52.2 min
  b-null        19 intervals, 29.3 min
  both-stamped  2 intervals, 70.0 min
```

**Suite**, 985 cases:

```
$ pnpm typecheck
> tsc --noEmit
typecheck exit: 0

$ pnpm test
=== usage-history.ts ===
  66 passed, 0 failed        (was 58; +13 cases, -5 net after the two dead guards)
...
panelCollapse: 8 passed, 0 failed
ALL PASS
```

**Not verified, needs a human.** Three things:

1. **No UI check.** `RecordingStatus` and the heatmap hatching were not opened in a
   browser. The claim that night buckets stop reading as permanently hatched is inferred
   from the accumulation change, not observed.
2. **Nothing is retroactive.** The profile is learned live and `.usage-profile.json` keeps
   the buckets it already has; the 23 at-floor overnight buckets only recover as new
   sleeps are sampled. The 151.5 minutes above are what the *log* would have yielded, and
   the log is sparser than live 1-minute sampling — treat it as a cross-check on the rule,
   not a prediction of the profile's gain.
3. **The 5h window length is derived, not observed.** If the plan tier ever serves a
   longer window, the derived start lands too late and idle credit leaks into a stretch
   that did have a window open. Documented at `WINDOW_MS` and in
   `docs/subsystems/usage-limits.md`; nothing detects it automatically.

`docs/subsystems/usage-limits.md` gained a "provably-idle sub-span of a window change"
section and its `reset` table row now says what survives. Its `docs-sync` stamp was left
alone deliberately — re-baselining is `/docs-sync`'s job, not this fix's.
