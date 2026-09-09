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

Detection and display only. No "best hour to start" advice, no scheduling, no forecast
integration — all three were cut in the idea and stay cut.

## Plan

### The five open questions, settled

Grooming had no interactive channel (`AskUserQuestion` was absent), so these are the
groom's calls, written down so the executor and the reviewer can disagree with a *stated*
decision rather than reverse-engineer one. Nothing below is user-confirmed.

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
- The weekend case gets **no verdict**, only an observation. An all-weekend boost has no
  within-day control, so it cannot be told apart from "I do different work at weekends"
  at this dispersion. The response carries a weekend ratio and its day count; the card
  does not render a claim from it in this task.
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
  `offPeak` cell (Mon–Fri, all other hours). Weekend dates go to a separate weekend pool
  and are never paired. A cell counts only if it clears `BOOST_CELL_FLOORS`.
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
- **Observed hours, only when the verdict is `boost`.** For each ET hour 0–23, pool that
  hour's cells across the run days and report the hours clearing `BOOST_HOUR_MIN_UTIL`
  whose weighted rate is ≥ `BOOST_MIN_RATIO` × the pooled peak-hours rate. Hours under the
  floor are omitted, not reported as zero — a rate with no evidence is not a measurement.
- **Constants**, each exported and each with its reason in a comment:
  `BOOST_MS = 14 * DAY_MS` (the observed promo ran 14 days);
  `PEAK_START_HOUR_ET = 8`, `PEAK_END_HOUR_ET = 14` (half-open, from the 2026-03 promo);
  `BOOST_MIN_RATIO = 1.5`; `BOOST_MIN_RUN_DAYS = 3`;
  `BOOST_CELL_FLOORS = { minIntervals: 5, minUtil: 3 }`;
  `BOOST_MAX_INTERVAL_MS = 3_600_000`; `BOOST_HOUR_MIN_UTIL = 3`.
  Justify 1.5 in the comment against the numbers already in the doc: per-day rate
  cv ≈ 24%, so a ratio of two daily cells sits near cv ≈ 34% and 1.5 is ≈ +1.5σ; three
  consecutive days agreeing puts chance firing near 3 × 10⁻⁴, while a true 2× sits ≈ 3σ
  clear. The cell floors are cleared many times over on a working day (peak ≈ 59 pts/day,
  off-peak ≈ 74 pts/day on the idea's baseline) and correctly exclude days off.

### Wire — `shared/types.ts` first, then the producer, then the consumer

Add `boost: UsageBoost` to `UsageRatesResponse`, **always present** — the same rule
`weekly` follows: a thin reading is a `none` verdict with zeroed counters, never an absent
key. `UsageBoost` carries `verdict: 'boost' | 'none' | 'inconclusive'`,
`reason: 'thin-evidence' | 'flat' | 'mix-shift' | null`, `model: string | null`,
`ratio` / `rawRatio` (`number | null`), `days: number`, `since: string | null` (ET date),
`peakStartHourEt` / `peakEndHourEt` (so the card owns no threshold and no window
literal), `hours: BoostHour[]` (`{ hour, weightedPerPct, utilSum }`, empty unless the
verdict is `boost`) and `weekend: { ratio: number | null; rawRatio: number | null;
days: number }`.

`shapeUsageRates` in `server/api.ts` computes it from the `intervals` it already built —
no second join, no second file read — and `emptyRates` gains a zeroed instance so the
not-recording and fail-open bodies carry the field too.

### Client

- `client/src/lib/usageRatesFormat.ts`: `boostLine(boost)` returns `null` for every
  verdict but `boost` — the null case renders nothing — and otherwise one sentence naming
  the ratio, the peak window in ET, the model, the run length and the since date.
  `boostHoursText(hours)` collapses contiguous hours into `HH:00–HH:00` ranges. Both pure
  and unit-tested, like every other string on this board.
- `client/src/components/usage/UsageRates.tsx`: render `boostLine` in a `.rates-notice`
  directly under the status strip when it is non-null — reusing that existing class, so
  no new colour or shadow literal enters `styles.css` below the token block. It is a
  different question from drift and must not enter the drift headline or its counts.
- One new entry in `RATES_GLOSSARY` (the ⓘ panels and the drawer read the same strings
  through `figureTip`, so they cannot drift apart) explaining what the detector watches
  and that silence means it saw nothing.

### Docs

Add a section to `docs/subsystems/usage-limits.md` covering the mechanism, the five
decisions above in short form, the ⚠️ Unproven on whether utilization reflects a boost at
all, and the accepted limitations. Add `server/lib/usage-boost.ts` to that file's
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
14. **Weekend observation only.** Weekday cells flat, weekend days present →
    `verdict: 'none'`, `weekend.ratio` a number, `weekend.days` = the count of distinct
    ET weekend dates.
15. **Weekend-only record.** No weekday pairs at all → `verdict: 'none'`,
    `reason: 'thin-evidence'`, and `weekend.ratio` still reported.
16. **Model selection.** Two models, where the low-volume one shows a 2× step and the
    dominant one is flat → `model` names the dominant model and `verdict: 'none'`.

**`test/api-usage-rates.test.ts` (extend)**:

17. `boost` is present with `verdict: 'none'` and `hours: []` in the `recording: false`
    body **and** in the fail-open error body.
18. A recording fixture whose intervals carry a 3-day 2× step produces
    `boost.verdict: 'boost'` on the response, with `peakStartHourEt: 8` /
    `peakEndHourEt: 14` echoed.

**`test/usage-rates-format.test.ts` (extend)**:

19. `boostLine` returns `null` for `none` and for `inconclusive`.
20. `boostLine` for a `boost` verdict returns a sentence containing the ratio to two
    decimals, `08:00–14:00 ET`, the model id, the day count and the since date.
21. `boostHoursText` for hours `[0..7, 14..23]` returns exactly
    `00:00–08:00, 14:00–00:00 ET` — the end label is `(lastHour + 1) mod 24`, two digits.
22. `boostHoursText([])` returns `null` and the sentence from 20 then carries no hours
    clause.

**Mutation proof** (a guard test that stays green with the guard deleted proves nothing):
delete each of `BOOST_MIN_RATIO`'s comparison, the raw-ratio comparison, the
`BOOST_MIN_RUN_DAYS` check, the cell floor and the `BOOST_MAX_INTERVAL_MS` drop in turn,
confirm the matching case above goes red each time, restore. Record the five results in
the item's `## Outcome`.

**In the browser (playwright MCP tools):** open `http://localhost:5174`, go to
**Usage → Token value**, confirm **no** boost line renders under the status strip (no
promotion is live, so the null case is the live case), then open **How to read this** and
confirm the new boost entry is listed with its definition.

## Done when

- `pnpm test` passes and its printed case count has grown by at least the 22 cases above.
- `pnpm typecheck` passes.
- The five mutation-proof results are recorded in `## Outcome`.
- The browser check above has been run and its result recorded — including that the live
  board shows nothing, which is the expected null.
- `docs/subsystems/usage-limits.md` carries the new section and the new
  `docs-sync: sources:` entry.
- No new dependency in `server/`, no colour or shadow literal added to `styles.css` below
  the theme-token block, and `shared/types.ts` was changed before its producer and consumer.
