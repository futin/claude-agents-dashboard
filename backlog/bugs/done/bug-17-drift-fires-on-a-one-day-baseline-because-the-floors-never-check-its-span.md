---
id: bug-17
title: Drift fires on a one-day baseline because the floors never check its span
created: 2026-09-03
tags: usage, rates
updated: 2026-09-04T11:33:03Z
groom-elapsed: 493
started: 2026-09-04T11:15:19Z
execute-elapsed: 1064
---

## Symptom

The token-value card shows `claude-opus-5` as **DRIFT**, weighted 219,031/1% against a
baseline of 171,421 (+27.8%), on a baseline that is *one day* of intervals — the
recorder's very first day.

`BASELINE_FLOORS` counts intervals and cumulative points but never the baseline's
**span**, so 52 intervals from a single calendar day clear a floor meant to certify a
14-day window. That contradicts the stated intent that **`thin` outranks everything**
(`server/lib/usage-rate.ts:281`, `docs/subsystems/usage-limits.md:555`) so the badge
never fires hardest when it knows least. Here it fires hardest on the thinnest baseline
the ledger will ever have.

Direction is also worth stating, since the badge does not: the deviation is *positive*,
meaning 1% of the window now buys ~28% **more** weighted tokens than baseline. Whatever
the badge is reporting, it is not a price rise.

## Repro

Live, on this machine's own logs at 2026-09-03T17:05Z — `curl -s localhost:5174/api/usage/rates`:

```
model            claude-opus-5   verdict drift
weighted/1%      219,031         baseline 171,421   dev +27.8%
raw/1%           1,468,790       baseline 1,126,873  dev +30.2%
intervals 424    utilSum 452
pctPerMWeighted 2.2527   pctPerRequest 0.03517   splitVerdict fitted
```

The ledger's first line is `2026-08-31T07:42:01Z`. Every interval before that classifies
`gap` (no ledger coverage), so the baseline range `[now−17d, now−3d)` contains **only**
Aug 31 intervals: 52 intervals / 56.0 points, against floors of 30 / 15 — cleared.

Per-day `claude-opus-5` weighted/1%, same join:

| day | intervals | util pts | weighted/1% |
|---|---|---|---|
| 08-25 → 08-30 | 0 | 0 | all `gap`, pre-ledger |
| 08-31 | 76 | 82 | 173,195 |
| 09-01 | 139 | 146 | 281,389 |
| 09-02 | 181 | 197 | 191,844 |
| 09-03 | 81 | 84 | 186,240 |

Day-to-day variation (173k → 281k, +62%) is already wider than `DRIFT_PCT` (20). The
verdict is comparing one startup day against a 3-day pool that contains the 281k day.

Not a mix shift, and the weighting did its job: cache-read share moves only 96.8% → 97.1%,
and raw (+30.2%) and weighted (+27.8%) move together, which is why `mix-shift` was
correctly refused. The defect is the baseline's span, not the weighting.

## Affects

- `server/lib/usage-rate.ts:186` — `BASELINE_FLOORS = { minIntervals: 30, minUtil: 15 }`,
  no span term.
- `server/lib/usage-rate.ts:237` — `pool()` returns count and `utilSum` only; nothing
  downstream can know how many distinct days or what time range backed the fit.
- `server/lib/usage-rate.ts:281` — `driftRow`'s "thin outranks everything" contract.
- `server/lib/usage-rate.ts:217` — `baselineRange`, which names a 14-day window that the
  floors do not enforce the width of.
- `docs/subsystems/usage-limits.md:555` — documents the floors and the verdict order.
- `docs/subsystems/usage-limits.md:711` — already warns drift detection is unproven; this
  is the first live instance of *how* it misfires.
- `client/src/components/usage/UsageRates.tsx:51` — the meta line shows `intervals` and
  `utilSum` but not the baseline's date range, so nothing on screen discloses that the
  baseline is one day.

## Cause

**The floors measure how much evidence a pool holds and never how far apart it is
spread.** `pool()` (`server/lib/usage-rate.ts:237`) returns `intervals` and `utilSum` and
nothing else; `rateFor` (`:262-266`) tests exactly those two against `RateFloors`
(`:174`). A window's time extent is invisible to the only gate that can hold a verdict at
`thin`, so 60 intervals from one morning satisfy a floor written for a 14-day window.

Re-measured live at **2026-09-03T18:41Z** (the Repro's numbers moved with the clock —
60 baseline intervals now, not 52, and +34.6% not +27.8%):

| window | intervals | distinct UTC days | span | utilSum | weighted/1% | `reqUsable` |
|---|---|---|---|---|---|---|
| baseline `[now−17d, now−3d)` | 60 | **1** (08-31) | **0.45 d** | 65.0 | 163,184 | 0 |
| current `[now−3d, ∞)` | 428 | 4 | 2.99 d | 455.0 | 219,654 | 193 |

The baseline is not loosely "one day" — it is the first **10.8 hours** the recorder ever
ran, and 30/15 clears it with room to spare.

**Candidate 1 is the defect**: the floors are span-blind, and nothing else downstream can
compensate, because `pool()` never reports the span in the first place.

**Candidate 2 is not a defect, and is disposed of.** `reqUsable` is read in exactly one
place — `usableForSplit` (`server/lib/usage-rate.ts:477`), which gates the *two-term fit*.
`pool()`, `rateFor` and `driftRow` never look at it, so a baseline holding zero `reqUsable`
intervals cannot bias the deviation: both sides of the comparison are the same single
pooled ratio, fitted the same way. What stays true is the interpretation — a fall in
requests-per-token raises that ratio with no repricing, and it cannot be checked for
Aug 31 because the counts were never written. That is a limit on reading a *correct*
number, not the reason a wrong verdict fired.

**The dispersion is the argument, not just the principle.** Per-day weighted/1% for
`claude-opus-5`, every day that exists (util-weighted mean **212,595**):

| day | intervals | util pts | weighted/1% | vs mean |
|---|---|---|---|---|
| 08-31 | 76 | 82.0 | 173,195 | −18.5% |
| 09-01 | 139 | 146.0 | 281,389 | **+32.4%** |
| 09-02 | 181 | 197.0 | 191,844 | −9.8% |
| 09-03 | 92 | 95.0 | 183,911 | −13.5% |

sd/mean = **24.0%**, min→max = **+62.5%**. Day-to-day dispersion alone is wider than
`DRIFT_PCT` (20). Treating a day as one draw, the 1σ error of a deviation is
`√(cv²/base_days + cv²/cur_days)`:

| baseline days | 1 current day | 2 | 3 |
|---|---|---|---|
| 5 | 26.3% | 20.1% | 17.5% |
| 7 | 25.7% | **19.2%** | 16.6% |
| 14 | 24.8% | 18.1% | 15.3% |

Two things fall out. A one-day pool on **either** side clears the band by itself, so the
span-blindness is a defect in both floors and the title names only the half that fired
first. And the current window — 3 days wide by construction — is the *dominant* noise
term: even a perfect 14-day baseline against a one-day current window sits at 24.8%,
still over the band.

## Fix

Give the pool a day count, and make both floors require days. Distinct **UTC dates**, not
`max(toT) − min(toT)`: a span is cleared by two clusters at either end of the window with
nothing in between, which is the same lie one day tells in a different shape.

**Server — `server/lib/usage-rate.ts`**

1. `pool()` (`:237`) also counts the distinct UTC dates of the intervals it pooled, keyed
   on `toT` (the stamp `ownedBy` already windows on), and returns it as `days` on
   `ModelRate` (`:190`).
2. `RateFloors` (`:174`) gains a **required** `minDays`. Required, not optional — an
   optional floor defaults to off, and defaulting to off is the bug.
3. `rateFor` (`:262-266`) refuses when `fitted.days < floors.minDays`, beside the two
   refusals already there.
4. `BASELINE_FLOORS` → `minDays: 7`; `CURRENT_FLOORS` → `minDays: 2`. That pair is the
   cheapest one putting the measured 1σ (19.2%) under `DRIFT_PCT` (20) — see the table
   above. 7 is also half the baseline window's 14-day width, so a verdict now requires the
   baseline to be at least half-populated.
5. `SPLIT_FLOORS` (`:343`) gains `minDays: 1`, and the check at `:689` tests it beside the
   other two — which needs a day count on the split diagnostic. A no-op today, and
   deliberately so: the split publishes no cross-window verdict, so it is not what
   misfired. Wire it anyway, or the required field is a decoration that does nothing if a
   later reader raises it.
6. `driftRow` (`:281`) pools the baseline **unfloored** too, mirroring the `evidence` call
   it already makes for the current window, and reports `baselineDays` and `days` on
   `DriftRow`. The evidence has to survive the refusal exactly as `intervals`/`utilSum`
   already do — otherwise the card can say it went quiet but not why.

**Contract — `shared/types.ts`**

7. `ModelRateRow` (`:203`) gains `days` and `baselineDays`, documented as evidence
   reported whatever the verdict.

**Client**

8. `client/src/lib/usageRatesFormat.ts`: `evidenceText` (`:39`) takes the day count —
   `428 windows · 4 days · 455.0 pts`. A new `baselineText(weightedPerPct, days)` returns
   `no baseline yet` at 0 days, `baseline forming · 1 day` when days > 0 but the rate was
   refused, and `baseline 163k · 9 days` when it was fitted. The `thin` hint (`:45`)
   becomes a sentence naming both floors — "a verdict needs 7 separate days behind the
   baseline and 2 behind the current window". Literal numbers in copy match the existing
   `drift` hint, which already hardcodes 20%.
9. `client/src/components/usage/UsageRates.tsx:51` uses `baselineText` in the meta line in
   place of its local `baseline` string. This is the disclosure half of the bug: nothing on
   screen currently says the baseline is one day.

**Docs**

10. `docs/subsystems/usage-limits.md:551` — the floors sentence gains the day floors and
    the reason. `:711` — the ⚠️ unproven note records this misfire as the first live
    instance, and what was changed. Leave the `docs-sync` stamp to `/docs-sync`.

**Test cases** (`test/usage-rate-drift.test.ts` unless named otherwise)

- **Do this one first.** `series()` (`:64`) packs intervals a minute apart, so every
  existing fixture window is a single UTC date. Give it a day step and re-base the `rows()`
  helper (`:242`) so its baseline covers ≥7 dates and its current ≥2. Without this every
  drift / stable / mix-shift case silently turns `thin` and the suite stops testing
  verdicts at all.
- `LOOSE` (`:34`) and both `NO_FLOOR` literals in `scripts/probe-usage-split.ts:43` take
  `minDays: 0` — the probe reports evidence rather than hiding it.
- New: 60 intervals summing 65 util points, all on one UTC date → `rateFor` with
  `BASELINE_FLOORS` returns `null`; the same 60 spread across 7 dates → non-null. The
  numbers are the live baseline's, so the test *is* the bug. Mutation-prove it: delete the
  day check and the first assert must fail.
- New: days counts dates, not elapsed time. Intervals at `2026-08-20T23:59Z` and
  `2026-08-21T00:01Z` (2 minutes apart) → `days === 2`; at `2026-08-20T00:01Z` and
  `2026-08-20T23:59Z` (23.97 hours apart) → `days === 1`.
- New: baseline on one date, current across 3 → verdict `thin`, `deviationPct` null,
  `baselineWeightedPerPct` null, `baselineDays === 1`.
- New, the mirror case: baseline across 7+ dates, current on one date → verdict `thin`,
  `days === 1`, and `baselineWeightedPerPct` still reported.
- `both floors bind independently` (`:210`) becomes three floors — add the day case.
- The `SPLIT_FLOORS` `deepStrictEqual` (`:321`) gains `minDays: 1`.
- `test/api-usage-rates.test.ts`: its fixtures are minute-scale and therefore one date, so
  `CURRENT_FLOORS.minDays: 2` nulls `weightedPerPct`. At `:167` that breaks the exact-rate
  assert loudly; at `:124` it does something worse — `assert.ok(row.weightedPerPct! <
  4_000_000)` **passes on null**, because `null < 4_000_000`, so that case would go green
  while asserting nothing. Re-base both fixtures across two UTC dates and tighten `:124` to
  a non-null check first. Note `joinIntervals` drops any pair whose `resetsAt` differ, so
  each date needs its own block of samples with its own `resetsAt`; pairs inside a block
  survive, the pair straddling the two blocks is dropped, and the expected interval counts
  (`25` at `:123`, `10` at `:169`) move accordingly.
- `test/usage-rates-format.test.ts`: cases for `baselineText`'s three states and for
  `evidenceText`'s new day term.

**Verification**

`pnpm test` and `pnpm typecheck`, then the live endpoint: `curl -s
localhost:5174/api/usage/rates` must return `claude-opus-5` as `thin` with
`baselineDays: 1`. Recording started 2026-08-31T07:42Z, so with daily use the first
legitimate verdict lands around **2026-09-09**, once 7 dates fall inside
`[now−17d, now−3d)` — anyone running this check after that date should expect a real
verdict rather than `thin`, and should confirm against `baselineDays` rather than the
badge.

In the browser (playwright MCP tools): open `http://localhost:5174`, go to **Usage** →
*Token value per model*. The `claude-opus-5` row must disclose its baseline's recorded-day
count in the meta line (`baseline forming · 1 day`), and must not show the `drift` badge
while that count is under 7.

**Residual, stated rather than fixed.** At 7/2 the measured 1σ is 19.2% against a 20%
band, so a crossing by chance alone is still not rare. Widening `DRIFT_PCT` is out of
scope — four days of data cannot set a threshold — but it is the open question behind the
next paragraph.

Distinct from `task-15`, which discloses the `gap` split without moving a fitted rate —
this is about a fitted rate that should not have been judged at all. Related to `idea-14`:
notifying on the first drift crossing would push exactly this false positive to the phone,
so that idea should not ship before this bug is fixed *and* the residual above is settled.

## Outcome

**2026-09-04 — fixed.** The floors now count distinct UTC dates, and both windows
require them. `pool()` returns `days`; `RateFloors` carries a **required** `minDays`;
`rateFor` refuses on it beside the two refusals already there. `BASELINE_FLOORS` is
30 / 15 / **7**, `CURRENT_FLOORS` 10 / 5 / **2**, `SPLIT_FLOORS` 20 / 10 / **1** (wired,
a no-op today, as specified). `driftRow` pools the baseline unfloored so `baselineDays`
survives the refusal, and both day counts reach the client through `ModelRateRow`. The
card's meta line now discloses them — `baseline forming · 2 days · 462 windows · 4 days ·
495.0 pts` — and the `collecting` hint names both floors.

Two deviations from the Fix, both in the tests. `series()` kept its minute step and a new
`daily({ count, days, … })` helper was added beside it rather than the step being changed:
a plain day step pushes a 30-interval baseline 34 days back, outside the 14-day window it
is meant to sit in, and both single-date *and* multi-date fixtures are now needed. `daily`
distributes round-robin across dates rather than by a step, so a fixture asking for 7
dates holds exactly 7 whatever its count. And `scripts/probe-usage-split.ts` has one
`NO_FLOOR` literal, not two — it took `minDays: 0`.

### Verification

`pnpm test` — 867 cases, and the `docs links` suite confirms the doc edits broke no anchor:

```
=== usage-rate.ts (rates + drift) ===
  ✓ all three floors bind independently
  ✓ MUTATION: a one-day baseline is refused however many intervals it holds
  ✓ days counts distinct UTC dates, not elapsed time
  ✓ a one-day baseline is thin, and its day count is still reported
  ✓ a one-day current window is thin too, and the baseline is still reported
  35 passed, 0 failed

=== usageRatesFormat.ts ===
  ✓ evidenceText states windows, days and cumulative movement
  ✓ baselineText tells a forming baseline apart from an absent one
  ✓ baselineText: a rate with no days behind it is still no baseline
  10 passed, 0 failed

=== usage rates endpoint ===
  7 passed, 0 failed

=== docs links ===
  4 passed, 0 failed

867 cases passed
0 cases failed
ALL PASS
```

`pnpm typecheck` — clean, exit 0. `pnpm build` — `✓ built in 2.41s`.

**Mutation-proved.** Deleting `if (fitted.days < floors.minDays) return null;` from
`rateFor`:

```
MUTANT: day refusal deleted
  ✗ all three floors bind independently
  ✗ MUTATION: a one-day baseline is refused however many intervals it holds
  ✗ a one-day baseline is thin, and its day count is still reported
  ✗ a one-day current window is thin too, and the baseline is still reported
  31 passed, 4 failed
```

The guard restored, `ALL PASS`. Before the guard existed the first of those failed with
`'drift' !== 'thin'` — the badge this bug is about, reproduced in a unit test.

**Live**, `curl -s localhost:5174/api/usage/rates` at 2026-09-04T11:28Z:

```
claude-opus-5             verdict thin  days  4 baselineDays  2 intervals 462 w/1% 209606 base null dev null
claude-fable-5-1          verdict thin  days  3 baselineDays  0 intervals  16 w/1%  62230 base null dev null
claude-fable-5            verdict thin  days  1 baselineDays  2 intervals   5 w/1%   null base null dev null
claude-haiku-4-5-20251001 verdict thin  days  1 baselineDays  1 intervals   1 w/1%   null base null dev null
claude-sonnet-5           verdict thin  days  0 baselineDays  1 intervals   0 w/1%   null base null dev null
```

`baselineDays: 2`, not the `1` this item predicted: a day passed between grooming and
execution, so `[now−17d, now−3d)` has slid to cover 08-31 *and* 09-01. Still under 7, so
`thin` holds — which is why the Fix said to confirm against `baselineDays` rather than the
badge. **`claude-opus-5` no longer reports `drift`, and publishes no baseline rate at all.**

**In the browser** (playwright, `http://localhost:5174` → Usage → *Token value*), every
row badges `COLLECTING`; no `DRIFT` badge anywhere. `claude-opus-5` reads
`baseline forming · 2 days · 462 windows · 4 days · 495.0 pts`, and `claude-fable-5-1` —
which has nothing in the baseline window — reads `no baseline yet`, so the two states are
distinguishable on screen for the first time.

### Not verified, needs a human

- **That a real verdict fires correctly once 7 dates exist.** The floors are proved to
  refuse; nothing here proves they *stop* refusing on live data, because the ledger does
  not yet hold 7 baseline dates. With daily use the first legitimate `claude-opus-5`
  verdict lands around **2026-09-10** (one day later than this item estimated, the
  baseline having slid). The item's own ⚠️ in `usage-limits.md` still stands.
- **Both residuals, unchanged and now recorded in the docs.** At 7 / 2 the measured 1σ is
  19.2% against a 20% band; and the current window is 3 days wide by construction, making
  it the dominant noise term whatever the baseline does. `DRIFT_PCT` was left alone.
- **Legibility of the meta line.** `baseline forming · 2 days · 462 windows · 4 days` says
  "days" twice with no visual cue for which side each belongs to. It is the copy this item
  specified, so it shipped as written, but it reads ambiguously cold and may want a
  follow-on.
- **The 4173 production server** was left running the pre-fix build; it is the user's
  process and `pnpm start` does not watch. It needs a restart to pick this up.
