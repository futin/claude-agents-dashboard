---
id: task-24
title: Detect an active off-peak usage-limit boost
created: 2026-09-09
from: idea-23
---

## Goal

When Anthropic is running a time-of-day capacity promotion — limits raised outside
weekday peak hours, as they were 2026-03-13 → 2026-03-27 — the **Token value** board
says so, in one line, naming the observed size, the model it was measured on and the ET
hours that actually carry it. When no promotion is running it says **nothing at all** on
the board itself; the negative is available in the `How to read this` drawer.

Weekends carry **their own verdict on a weaker control** and say so in their own words —
this account works weekends heavily, so an all-weekend promotion is not a case the board
may stay silent about.

Detection and display only. No "best hour to start" advice, no scheduling, no forecast
integration — all three were cut in the idea and stay cut.

## Plan

### The idea's five open questions, settled — plus the weekend verdict in 2b

Grooming had no interactive channel (`AskUserQuestion` was absent), so these are the
groom's calls, written down so the executor and the reviewer can disagree with a *stated*
decision rather than reverse-engineer one. Everything below is the groom's own call
**except** the weekend verdict in 2b, which the user asked for explicitly after reading
the first draft of this plan: they work weekends, and an observation with no verdict was
not enough.

**1. Does the 5h `utilization` counter reflect a boost at all? — unanswerable now, and
the design survives either answer.** No promotion is live, so this cannot be probed. If
Anthropic rescales utilization so a boost is invisible in the percentage, the detector
reads flat and shows nothing — the honest null. If a boost lands as half the percentage
per token, the detector sees the step. So the copy claims only what was measured — "more
tokens per 1% than in your own peak hours" — never "your limit doubled", and the
subsystem doc carries this as a ⚠️ Unproven, in the house style
`docs/subsystems/usage-limits.md` already uses for drift detection.

**2. Minimum span before the card may claim anything? — pair within a day, and require a
3-day trailing run.** The weakness the idea names (2 distinct weekend days) is really a
*cross-day comparison* problem: comparing weekend against weekday at a measured per-day
dispersion of cv ≈ 24% needs far more days than exist. Pairing **within one ET calendar
day** — that day's off-peak cells against that same day's peak cells — removes it: each
day is its own control, so day-to-day variation, model drift and workload drift cancel.
The verdict then rides on how many consecutive recent days agree, which is a floor this
data can meet (see the constants below).

**2b. And the weekend gets its own verdict, on a pooled weekday-peak control.** A weekend
day has no unboosted hours to pair against — under the observed promo the whole day was
boosted — so the within-day control of 2 does not exist there. The alternative is a
cross-day control, which 2 rejected for the *weekend-versus-weekday* comparison as
originally framed: one weekend day against one weekday is two noisy quantities.
**Pooling the control fixes the half that was fixable.** Compare each weekend day
against the weekday **peak** rate pooled over every weekday date in the horizon: at
cv ≈ 24% per day and 10 pooled weekday dates the control's own noise falls to ≈ 7.6%, so
the ratio carries ≈ 25.2% — 1.5× is ≈ 2.0σ, a true 2× is ≈ 4.0σ, and requiring **two**
consecutive weekend days puts chance firing near 0.05% under independence (call it under
1% in practice, since one unusual weekend correlates its own two days). At the floor of 5
pooled weekday dates the same figures are 10.7% / 26.3% / 1.9σ / 3.8σ — the weakest
configuration the floors permit, and still usable.

This is a **weaker instrument than the weekday one and must be labelled as such
everywhere it surfaces** — its own verdict field, its own sentence naming the control, and
never merged into the weekday verdict or its counts. What licenses it at all is a
measurement rather than an assumption: on this machine's own baseline the weekend rate is
222.0k tokens per 1% against the weekday-peak 218.7k — **1.015×** — so weekend work is
empirically indistinguishable from weekday-peak work here, and the confound the pooled
control cannot remove is measured small rather than hoped small. That is a fact about
this account over that period, not a general result, and it is exactly what the reviewer
should re-check when the horizon has more weekends in it.

**3. Hardcode the March boundaries or learn them? — hardcode the partition, report the
hours as observed.** The 08:00/14:00 ET split is the only instance ever seen, and
learning a change point needs coverage this record does not have. So the partition is a
named constant carrying the promo's dates in its comment, used as *the hypothesis under
test*. Separately, and **only when the verdict fires**, the response reports the per-ET-hour
figures so the reader sees which hours actually carry it rather than which hours were
announced. Detection is hardcoded; display is observed.

**4. False positives — require weighted *and* raw to move together, and measure one
model.** A genuine limit boost halves the percentage charged for every token, so both the
weighted and the raw tokens-per-point double. A cache-heavy stretch moves raw far more
than weighted (that is what the weights are for); a weighting artifact moves weighted and
not raw. Requiring **both** ratios over the floor rejects both, and a step in only one is
reported as `inconclusive` / `mix-shift`. `driftRow`'s verdict itself is **not** reused —
it compares two time *windows*, not two times of *day* — but this is the same
weighted-vs-raw discriminator, and the task should say so where it is implemented.
Model mix is handled by measuring **one model**: the model holding the most owned
utilization over the horizon (this machine: `claude-opus-5`, ~1103 of ~1200 intervals).
A boost is an account property, so one well-evidenced model is the right sensor and
pooling across models would reintroduce the mix confound for no gain.

**5. Anything in the null case? — nothing on the board.** No row, no "no boost active"
card. One glossary entry in the existing closed-by-default `How to read this` drawer says
the detector exists, what it watches and that silence means it saw nothing.

### Accepted limitations, to be stated in the doc

- A boost applying to only *one* model would be invisible (we measure one model). Limits
  do not work that way, but it is a real blind spot and belongs in writing.
- The weekend verdict rests on a **cross-day** control and is the weaker of the two. A
  weekend-long change in what the work *is* — a different project, a long compacted
  session, a run of cache-heavy replays — moves it in a way the weekday verdict is immune
  to. Three things hold it down and none of them removes the confound: both ratios must
  move together, two consecutive weekend days must agree, and the control is pooled over
  every weekday date in the horizon. Say all of this in the card's own sentence, not only
  in the doc.
- A weekend promotion is therefore detectable **one weekend late at worst**: two weekend
  days must clear the floor, so a promo starting on a Saturday is claimed on the Sunday
  at the earliest, and one starting on a Sunday waits for the next weekend.
- A promotion that starts mid-horizon is handled by the trailing-run rule, not by
  dilution: older unboosted days simply end the run. A promotion that starts *today* reads
  as no boost until three paired days agree.
- The measured null baseline (idea-23: 1.01× off-peak/peak at n=1166 priced intervals)
  is the evidence that time-of-day work patterns do not by themselves move this ratio —
  on this machine, over that period. It is not a general result.

### Server — `server/lib/usage-boost.ts` (new, pure, zero deps)

Pure over `Interval[]`, no clock and no disk, exactly like the fitter beside it. It adds a
grouping over intervals the existing code already produces; it measures nothing new.

- **ET calendar mapping.** One helper turning an epoch ms into `{ date: 'YYYY-MM-DD',
  hour: 0–23, weekend: boolean }` in `America/New_York`, via a module-scope
  `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` and **`hourCycle: 'h23'`**
  (`hour12: false` alone can yield `'24'` on some ICU builds). `Intl` is a Node built-in,
  so `server/`'s zero-dep rule holds. DST is handled by the formatter, not by arithmetic.
- **Which intervals.** Only intervals owned by the chosen model, over
  `[now − BOOST_MS, now]`. Do not re-derive ownership: build the day/hour subsets as
  `Interval[]` slices and hand each to the existing `poolRate(subset, model, -Infinity,
  Infinity)`, which already applies the dominance rule and returns
  `weightedPerPct` / `rawPerPct` / `intervals` / `utilSum` / `days`. All the arithmetic
  stays in one place.
- **Bucket assignment by interval midpoint**, and any interval longer than
  `BOOST_MAX_INTERVAL_MS` is dropped from every cell — it spans buckets and cannot be
  attributed to one. Dropped, never split: a split invents a token distribution inside the
  interval that was never measured.
- **Cells.** For each ET date: a `peak` cell (Mon–Fri, hours 8–13 inclusive) and an
  `offPeak` cell (Mon–Fri, all other hours). A weekend date gets a single whole-day cell —
  the promo boosted all of Saturday and Sunday, so there is nothing to split it on. A cell
  counts only if it clears `BOOST_CELL_FLOORS`.
- **Paired-day ratios.** For every ET date where both cells clear their floor,
  `weightedRatio = offPeak.weightedPerPct / peak.weightedPerPct`, and the same for raw.
- **Verdict.** Walk the paired days newest-first and count the leading run in which
  *both* ratios are ≥ `BOOST_MIN_RATIO`. Run length ≥ `BOOST_MIN_RUN_DAYS` → `boost`,
  with `ratio` / `rawRatio` computed by pooling the run's cells (not by averaging the
  daily ratios — same reason `poolRate` pools rather than means) and `since` = the ET
  date of the oldest day in the run. Otherwise: a day whose weighted ratio clears the
  floor while its raw ratio does not, or the reverse, in the newest paired day →
  `inconclusive` with reason `mix-shift`; fewer than `BOOST_MIN_RUN_DAYS` paired days at
  all → `none` with reason `thin-evidence`; everything else → `none` with reason `flat`.
- **The weekend verdict** — the same shape as the weekday one, on a different control, and
  computed independently of it so either may fire alone. The control is
  `peakControl` = every weekday `peak` cell in the horizon pooled through one `poolRate`
  call, and it must clear `WEEKEND_CONTROL_FLOORS` or the verdict is `none` /
  `thin-evidence` whatever the weekend days say. Then for each weekend ET date clearing
  `BOOST_CELL_FLOORS`, `weightedRatio = weekendDay.weightedPerPct /
  peakControl.weightedPerPct` and the same for raw. Walk those dates newest-first, count
  the leading run where **both** ratios are ≥ `BOOST_MIN_RATIO`, and require
  `WEEKEND_MIN_RUN_DAYS`. Same refusal vocabulary as the weekday verdict, same
  weighted-vs-raw disagreement rule producing `mix-shift`, `ratio` pooled over the run's
  cells rather than averaged, `since` = the ET date of the oldest day in the run.
  **The control is deliberately the weekday peak and not the weekday off-peak**: during a
  live promotion the off-peak hours are the boosted ones, so an off-peak control would
  divide a boost by a boost and read flat. That is the single mistake most likely to be
  made here, and the test for it is case 23.
- **Observed hours, only when the verdict is `boost`.** For each ET hour 0–23, pool that
  hour's cells across the run days and report the hours clearing `BOOST_HOUR_MIN_UTIL`
  whose weighted rate is ≥ `BOOST_MIN_RATIO` × the pooled peak-hours rate. Hours under the
  floor are omitted, not reported as zero — a rate with no evidence is not a measurement.
- **Constants**, each exported and each with its reason in a comment:
  `BOOST_MS = 14 * DAY_MS` (the observed promo ran 14 days);
  `PEAK_START_HOUR_ET = 8`, `PEAK_END_HOUR_ET = 14` (half-open, from the 2026-03 promo);
  `BOOST_MIN_RATIO = 1.5`; `BOOST_MIN_RUN_DAYS = 3`;
  `BOOST_CELL_FLOORS = { minIntervals: 5, minUtil: 3 }`;
  `BOOST_MAX_INTERVAL_MS = 3_600_000`; `BOOST_HOUR_MIN_UTIL = 3`;
  `WEEKEND_MIN_RUN_DAYS = 2` (one weekend — two is the most a single weekend can offer,
  and waiting for two weekends would report a 14-day promo half-over);
  `WEEKEND_CONTROL_FLOORS = { minIntervals: 30, minUtil: 15, minDays: 5 }` — the `minDays`
  is the load-bearing one, because the whole case for a cross-day control is that pooling
  shrinks its noise, and 5 dates is where that claim still holds (≈ 10.7%).
  Justify 1.5 in the comment against the numbers already in the doc: per-day rate
  cv ≈ 24%, so a ratio of two daily cells sits near cv ≈ 34% and 1.5 is ≈ +1.5σ; three
  consecutive days agreeing puts chance firing near 3 × 10⁻⁴, while a true 2× sits ≈ 3σ
  clear. For the weekend comparison the control is pooled, so the same 1.5 is ≈ 1.9–2.0σ
  and a true 2× is ≈ 3.8–4.0σ — the arithmetic is in 2b and belongs in the comment too.
  The cell floors are cleared many times over on a working day (peak ≈ 59 pts/day,
  off-peak ≈ 74 pts/day on the idea's baseline) and correctly exclude days off.

### Wire — `shared/types.ts` first, then the producer, then the consumer

Add `boost: UsageBoost` to `UsageRatesResponse`, **always present** — the same rule
`weekly` follows: a thin reading is a `none` verdict with zeroed counters, never an absent
key. `UsageBoost` carries `verdict: 'boost' | 'none' | 'inconclusive'`,
`reason: 'thin-evidence' | 'flat' | 'mix-shift' | null`, `model: string | null`,
`ratio` / `rawRatio` (`number | null`), `days: number`, `since: string | null` (ET date),
`peakStartHourEt` / `peakEndHourEt` (so the card owns no threshold and no window
literal), `hours: BoostHour[]` (`{ hour, weightedPerPct, utilSum }`, empty unless the
verdict is `boost`) and `weekend: BoostWeekend`.

`BoostWeekend` is the weekday verdict's shape minus the parts that do not apply:
`verdict` and `reason` drawn from the same two unions — reuse the aliases, do not declare
a second pair, or the card will end up with two switch statements that can disagree —
plus `ratio` / `rawRatio` (`number | null`), `days: number`, `since: string | null`, and
`controlDays: number` (how many weekday dates the pooled control was built from). That
last field is not decoration: it is the number that says how strong the control was, the
card prints it, and without it a reader cannot tell a 5-date control from a 10-date one.

`shapeUsageRates` in `server/api.ts` computes it from the `intervals` it already built —
no second join, no second file read — and `emptyRates` gains a zeroed instance so the
not-recording and fail-open bodies carry the field too.

### Client

- `client/src/lib/usageRatesFormat.ts`: `boostLine(boost)` returns `null` for every
  verdict but `boost` — the null case renders nothing — and otherwise one sentence naming
  the ratio, the peak window in ET, the model, the run length and the since date.
  `boostHoursText(hours)` collapses contiguous hours into `HH:00–HH:00` ranges.
  `weekendBoostLine(boost)` is the weekend's own sentence, `null` for every verdict but
  `boost`, and it must **name its control in the sentence itself** — the weekday
  08:00–14:00 ET rate pooled over `controlDays` days — because that clause is the difference
  between the two claims and a reader who sees only one of the lines has to be able to
  tell which one they are looking at. All pure and unit-tested, like every other string on
  this board.
- `client/src/components/usage/UsageRates.tsx`: render `boostLine` and then
  `weekendBoostLine` as **two separate** `.rates-notice` lines directly under the status
  strip, each when non-null — reusing that existing class, so no new colour or shadow
  literal enters `styles.css` below the token block. Two lines rather than one sentence
  with a clause: they rest on different controls and may fire independently, and merging
  them would let the stronger claim lend its credibility to the weaker one. Neither is a
  question the drift headline asks, so neither enters it or its counts.
- Two new entries in `RATES_GLOSSARY` (the ⓘ panels and the drawer read the same strings
  through `figureTip`, so they cannot drift apart): one for the weekday detector — what it
  watches, and that silence means it saw nothing — and one for the weekend verdict saying
  plainly that it is measured against a pooled weekday baseline rather than against the
  same day, and is the weaker of the two.

### Docs

Add a section to `docs/subsystems/usage-limits.md` covering the mechanism, the decisions
above in short form, the ⚠️ Unproven on whether utilization reflects a boost at all, and
the accepted limitations. It must state the **two controls** side by side and why they
differ in strength — that is the one thing about this feature a later reader cannot
re-derive from the code without redoing the noise arithmetic, so put the arithmetic in. Add `server/lib/usage-boost.ts` to that file's
`docs-sync: sources:` list. Do not hand-edit the `verified:` stamp — that is `/docs-sync`'s.

## Test cases

Node-assert, in the style of the neighbouring usage tests. Build fixtures with the same
`tokFor(weighted, raw)` idiom `test/usage-rate-drift.test.ts` uses — cases 8 and 9 need
weighted and raw set independently, and that helper asserts its own arithmetic.

**`test/usage-boost.test.ts` (new)** — ET mapping, verified against Node 26 ICU:

1. `2026-03-14T04:30:00Z` → date `2026-03-14`, hour `0`, weekend `true` (Sat).
2. `2026-01-15T04:30:00Z` → date `2026-01-14`, hour `23`, weekend `false` (Wed, EST).
3. `2026-03-08T07:00:00Z` (spring forward) → hour `3`, does not throw.
4. `2026-11-01T05:30:00Z` and `2026-11-01T06:30:00Z` (fall back, the repeated hour) →
   **both** hour `1`, date `2026-11-01`; neither yields `24`.
5. `2026-09-09T12:00:00Z` → hour `8`: the peak window's first hour is inclusive.

Verdicts:

6. **Null.** 5 weekday days, identical weighted and raw rates in both cells →
   `verdict: 'none'`, `reason: 'flat'`, `ratio` within 0.02 of 1.0.
7. **2× boost.** 4 weekday days, off-peak cells at twice the weighted *and* twice the raw
   rate → `verdict: 'boost'`, `ratio` within 0.02 of 2.0, `days: 4`, `since` = the ET date
   of the oldest of the four, `hours` includes an off-peak hour and excludes hour 9.
8. **Weighted-only step.** Off-peak weighted ratio 2.0, raw ratio 1.05 →
   `verdict: 'inconclusive'`, `reason: 'mix-shift'`.
9. **The mirror case** (the complement 8 would otherwise hide): raw ratio 2.0, weighted
   ratio 1.05 → also `verdict: 'inconclusive'`, `reason: 'mix-shift'`.
10. **Onset.** 5 weekday days, the oldest 2 flat and the newest 3 at 2× → `verdict:
    'boost'`, `days: 3`, `since` = the ET date of the third-newest day. The two flat days
    contribute to neither `ratio` nor `days`.
11. **Run too short.** Only the newest 2 days at 2× → `verdict: 'none'`,
    `reason: 'thin-evidence'`.
12. **Cell floor.** 4 days at 2× where the newest day's peak cell holds 1 interval /
    0.5 util → that day is unpaired, `days: 3`, `since` = the oldest of the remaining
    three.
13. **Long interval dropped.** The fixture of case 6 plus one 8-hour interval carrying
    large token counts → every figure identical to case 6's.
14. **Model selection.** Two models, where the low-volume one shows a 2× step and the
    dominant one is flat → `model` names the dominant model and `verdict: 'none'`.

Weekend verdict — every one of these also asserts the **weekday** `verdict` is unchanged
by it, because the two are computed independently and a shared-state bug between them is
exactly the kind that ships:

15. **Weekend 2×.** 10 flat weekday dates as the control, the 2 most recent weekend days
    at twice the control's weighted *and* raw rate → `weekend.verdict: 'boost'`,
    `weekend.ratio` within 0.02 of 2.0, `weekend.days: 2`, `weekend.since` = the ET date
    of the older of the two, `weekend.controlDays: 10`, and top-level `verdict: 'none'`.
16. **Weekend flat.** Weekend days at the control's own rate → `weekend.verdict: 'none'`,
    `weekend.reason: 'flat'`, `weekend.ratio` within 0.02 of 1.0.
17. **Weekend run too short.** Only the newest weekend day at 2× →
    `weekend.verdict: 'none'`, `weekend.reason: 'thin-evidence'`.
18. **Weekend weighted-only step.** Weighted ratio 2.0, raw ratio 1.05 →
    `weekend.verdict: 'inconclusive'`, `weekend.reason: 'mix-shift'`.
19. **The mirror** (the complement 18 would otherwise hide): raw 2.0, weighted 1.05 →
    also `weekend.verdict: 'inconclusive'`, `weekend.reason: 'mix-shift'`.
20. **Control too thin.** Weekend days at 2× but only 4 distinct weekday dates in the
    control → `weekend.verdict: 'none'`, `weekend.reason: 'thin-evidence'`. This is the
    case that proves `WEEKEND_CONTROL_FLOORS.minDays`; it must fail if that floor is
    dropped to 4.
21. **Weekend-only record.** No weekday cells at all → both verdicts `none` /
    `thin-evidence`, `weekend.ratio` null and `weekend.controlDays: 0`. A ratio with no
    control is not a measurement and must not be published as one.
22. **Both fire.** Weekday off-peak at 2× on the 3 most recent weekday dates *and* weekend
    at 2× on the 2 most recent weekend days → `verdict: 'boost'` **and**
    `weekend.verdict: 'boost'`, each with its own `since` and day count.
23. **The control is the peak, not the off-peak.** Every weekday date carries a 2×
    off-peak step (a live promotion) and the weekend days sit at 2× the weekday *peak*
    rate → `weekend.verdict: 'boost'` with `weekend.ratio` within 0.02 of 2.0. Built to
    fail at ≈ 1.0 / `none` if the control is ever switched to the off-peak cells, which
    during a promotion would be dividing a boost by a boost.

**`test/api-usage-rates.test.ts` (extend)**:

24. `boost` is present with `verdict: 'none'`, `hours: []` and a `weekend` object whose
    verdict is `none` and whose `controlDays` is 0, in the `recording: false` body **and**
    in the fail-open error body.
25. A recording fixture whose intervals carry a 3-day 2× weekday step produces
    `boost.verdict: 'boost'` on the response, with `peakStartHourEt: 8` /
    `peakEndHourEt: 14` echoed.

**`test/usage-rates-format.test.ts` (extend)**:

26. `boostLine` returns `null` for `none` and for `inconclusive`.
27. `boostLine` for a `boost` verdict returns a sentence containing the ratio to two
    decimals, `08:00–14:00 ET`, the model id, the day count and the since date.
28. `boostHoursText` for hours `[0..7, 14..23]` returns exactly
    `00:00–08:00, 14:00–00:00 ET` — the end label is `(lastHour + 1) mod 24`, two digits.
29. `boostHoursText([])` returns `null` and the sentence from 27 then carries no hours
    clause.
30. `weekendBoostLine` returns `null` for `none` and for `inconclusive`, and returns
    `null` when the *weekday* verdict is `boost` but the weekend one is not — the two
    lines are independent and neither implies the other.
31. `weekendBoostLine` for a weekend `boost` returns a sentence containing the ratio to
    two decimals, the word `weekend`, the day count, the since date, and a clause naming
    the control as the weekday `08:00–14:00 ET` rate over `controlDays` days.
32. Both verdicts `boost` → `boostLine` and `weekendBoostLine` each return their own
    sentence, and neither string contains the other's ratio.

**Mutation proof** (a guard test that stays green with the guard deleted proves nothing):
delete each of `BOOST_MIN_RATIO`'s comparison, the raw-ratio comparison, the
`BOOST_MIN_RUN_DAYS` check, the cell floor, the `BOOST_MAX_INTERVAL_MS` drop, the
`WEEKEND_MIN_RUN_DAYS` check and the `WEEKEND_CONTROL_FLOORS.minDays` floor in turn,
confirm the matching case above goes red each time, restore. Then one substitution rather
than a deletion: point the weekend control at the weekday off-peak cells and confirm case
23 goes red. Record all eight results in the item's `## Outcome`.

**In the browser (playwright MCP tools):** open `http://localhost:5174`, go to
**Usage → Token value**, confirm **neither** the weekday nor the weekend boost line
renders under the status strip (no promotion is live, so the null case is the live case),
then open **How to read this** and confirm both new glossary entries are listed with
their definitions.

## Done when

- `pnpm test` passes and its printed case count has grown by at least the 32 cases above.
- `pnpm typecheck` passes.
- The eight mutation-proof results are recorded in `## Outcome`.
- The browser check above has been run and its result recorded — including that the live
  board shows nothing, which is the expected null.
- The weekend verdict is labelled as the weaker instrument in all three places it can be
  read: its own field on the wire, its own sentence on the card, and the glossary entry.
- `docs/subsystems/usage-limits.md` carries the new section and the new
  `docs-sync: sources:` entry.
- No new dependency in `server/`, no colour or shadow literal added to `styles.css` below
  the theme-token block, and `shared/types.ts` was changed before its producer and consumer.
