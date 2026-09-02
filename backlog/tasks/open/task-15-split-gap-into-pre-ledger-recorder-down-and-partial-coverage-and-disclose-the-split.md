---
id: task-15
title: Split gap into pre-ledger, recorder-down and partial coverage, and disclose the split
created: 2026-09-02
from: idea-18
---

## Goal

`gap` currently means three different things at once, and the largest of them is benign.
Split it into three named kinds, count what each one costs in utilization points, and say
so on the token-value card — **without moving a single fitted rate**.

Measured on the live logs at 2026-09-02T18:41Z (17-day horizon, 1359 intervals, 1048.0
moved points), the three sub-cases are:

| bucket | intervals | points | % of moved |
|---|---|---|---|
| provably before the ledger existed | 752 | 438.0 | 41.8% |
| recorder down, **zero** ledger coverage in the span | 8 | 2.0 | 0.2% |
| recorder ran but covered < `LEDGER_COVERAGE_MIN` of the span | 22 | 32.0 | 3.1% |

That is the whole point of the task: the card's scariest number — 45% of everything the
5-hour counter moved is unpriced — is 41.8% startup artifact that ages out of the 3-day
`CURRENT_MS` window on its own, and 3.3% real. Nothing downstream can tell those apart
today.

Separately, the ledger has **24 non-abutting breaks totalling 12.35 h** inside its own
span. That is a different measurement from the point buckets (most breaks overlap no
history interval at all, because the server that writes the ledger also writes the history
log), and both are worth publishing because they answer different questions: the hours say
how much of the time the recorder was not running, the points say how much of the *spend*
that actually cost.

### The four open questions, answered

Answered by probing the live logs rather than by discussion — the evidence is decisive
and `AskUserQuestion` was unavailable in the grooming session. Recording the answers here
because the implementer must not re-litigate them.

1. **Is the earliest ledger line enough, or is an explicit start marker needed?** The
   earliest line is enough, *guarded*. Use the first line's `prevT` (not its `t`) — the
   ledger's first line covers `(prevT, t]`, so `prevT` is the instant before which nothing
   was ever recorded. The rotation hazard the idea named is real but detectable:
   `rotateLedgerIfNeeded` trims to `floor(MAX_LEDGER_BYTES / 2)` bytes and the file then
   grows back toward `MAX_LEDGER_BYTES`, so a file **smaller than half the maximum has
   provably never been rotated** and its first line really is the start of recording. When
   the file is at or above that half, the start is unprovable and every zero-coverage
   interval stays plain `gap` — conservative in the right direction.

   Reject the explicit marker: it costs a new line kind that every existing reader would
   drop as unparseable, and it would say nothing about data already on disk, which is the
   data that prompted the idea. Live check: 192 100 bytes over 2370 lines = 81 B/line, so
   ~287 days of continuous recording before the first rotation. The guard is not decoration
   though — a heavy multi-model line is several hundred bytes, and at ~20x today's size
   rotation lands inside the 17-day baseline.

2. **Where does the split surface?** The rates payload, as the idea suspected. That is
   where the reader already is, `UsageRatesResponse` already carries a top-level disclosure
   field (`externalSharePct`) for exactly this kind of statement, and the card already has
   a footer built for it. Not `/api/usage/profile` — that view is about duty cycle, and it
   would separate the number from the rates it explains.

3. **Does a recorder hole deserve anything more assertive than a counter?** No. The data
   is the argument: the hole costs 3.3% of moved points, not 45%. A badge or an `up-off`
   style block for 3.3% is noise that trains dismissal, and the same block for the 41.8%
   would be actively wrong — nothing is broken there. Counter, in the footer, same register
   as the external pill.

4. **Is `LEDGER_COVERAGE_MIN` at 0.8 earning its keep?** Yes, and this is a correction to
   the idea's figure. The idea measured 9 partial-coverage intervals; over the 17-day
   horizon there are **22, carrying 32.0 points — 16x the zero-coverage `gap` bucket's 2.0
   points.** The threshold is refusing genuinely under-covered spans, not noise. Leave it
   at 0.8, leave the constant alone, and note that once these counters exist the question is
   answerable from the card instead of from a probe.

**Not in scope:** changing any threshold, any fitted rate, or which intervals reach a fit.
This task is pure disclosure. If the new `partial` counter later argues for moving
`LEDGER_COVERAGE_MIN`, that is a fresh item citing this one.

## Plan

Bounded, by `superpowers:brainstorming`'s own classification — one server module, one
shared type, one endpoint field, one card footer, one doc section — so no
`superpowers:writing-plans` invocation and no separate plan document. This section is the
plan.

Behaviour and expected values only, deliberately: **do not transcribe code from this file.**
Where a name is given it is a contract to match; where a number is given it is a value to
assert.

### 1. `server/lib/usage-ledger.ts` — the provable recording start

Add one exported function that answers "when did recording provably begin", reading the
ledger file directly. Name it `ledgerStartMs`, taking the same optional `dir` every other
reader in this module takes, and returning `number | null`.

- Returns the **first** line's `prevT` when the file has provably never been rotated.
- Returns `null` when the file is absent, empty, has no parseable first line, or is at or
  above `MAX_LEDGER_BYTES / 2` bytes — the size at or above which a rotation may have
  happened, so the first surviving line is a floor rather than a start.
- Reads a bounded head chunk, not the whole file — the first line is all it needs. Reuse
  `parseLedgerLine`, so a junk first line is skipped exactly as it is everywhere else.
  Skipping past junk is fine; running off the end of the head chunk returns `null`.
- Never throws. Same posture as `readLedgerSince`: a missing ledger is not an error.
- Export a named constant for the never-rotated ceiling rather than inlining
  `MAX_LEDGER_BYTES / 2`, so the test can assert the two are tied together and a future
  change to either is caught.

Leave `readLedgerSince`'s signature alone. Eight call sites depend on it and none of them
needs this.

### 2. `server/lib/usage-rate.ts` — three kinds where there was one

**`IntervalKind` loses `'gap'` and gains `'pre-ledger' | 'gap' | 'partial'`**, keeping
`'idle'`, `'external'`, `'mixed'` and `{model}` exactly as they are. `'gap'` keeps its
current meaning narrowed to what it always claimed — "the server was down" — and sheds the
two cases that were never that.

Define the three as a named sub-union (e.g. `UnpricedKind`) and a predicate over it, and
route **every** consumer through that predicate rather than repeating a literal comparison.
This is the load-bearing part of the change: two existing sites currently name `'gap'`
directly and both would silently change behaviour if the new kinds were merely added
beside it.

- `usage-rate.ts:325` (`externalShare`) skips `'idle' || 'gap'`. All three unpriced kinds
  must stay out of that denominator, for the reason already in its docstring: counting our
  own downtime as another device's spend turns a server restart into a claim about the
  account.
- `usage-rate.ts:479` (`usableForSplit`) returns `kind !== 'gap' && kind !== 'external'`.
  This one **admits** anything not named, so leaving it alone would let `pre-ledger` and
  `partial` intervals into the two-term fit — intervals whose tokens are missing by
  construction. All three must be out.
- `scripts/probe-usage-split.ts:183` repeats the same `!== 'gap' && !== 'external'` filter
  and needs the same treatment; export the predicate so the probe uses the real one instead
  of a third copy.

`joinIntervals` takes a new **third parameter**, optional, `ledgerStartMs: number | null`,
defaulting to `null`. Optional so the probe and every existing test keep compiling; the
API passes the real value. Classification, in this order:

1. coverage ratio ≥ `LEDGER_COVERAGE_MIN` → classify exactly as today (`idle`, `external`,
   `{model}`, `mixed`). Untouched path.
2. otherwise, `ledgerStartMs !== null` **and** `toT <= ledgerStartMs` → `'pre-ledger'`.
3. otherwise, zero covered milliseconds → `'gap'`.
4. otherwise → `'partial'`.

Two consequences to accept and pin with tests rather than engineer around:

- **`toT <= ledgerStartMs`, not `fromT`.** An interval that straddles the start of
  recording — begins before it, ends after — is not provably unrecorded, so it classifies
  `gap` or `partial` on its actual coverage. That overstates the recorder-down bucket by at
  most **one interval per install**, and the alternative (testing `fromT`) would swallow a
  genuine hole that happens to abut the boundary.
- **`ledgerStartMs === null` collapses `pre-ledger` into `gap`.** After a rotation, or with
  no ledger at all, the card reports the conservative reading. That is the honest failure
  direction, and step 4 makes it visible rather than silent.

Then two new **pure** functions, both exported:

- `coverageBreakdown(intervals, sinceMs, untilMs)` → per-bucket utilization points over
  the horizon: the points owned by a model (`{model}`), `mixed`, `external`, `pre-ledger`,
  `gap`, `partial`, and `movedPct`, the sum of every non-`idle` bucket. `idle` is excluded
  from `movedPct` for the same reason `externalShare` excludes it — it is a measurement of
  nothing moving, and putting it in the denominator would shrink every percentage by
  however long the machine sat quiet. Window test on `toT`, matching `ownedBy`.
- `ledgerBreakMs(ledger, sinceMs, untilMs)` → total milliseconds between consecutive
  ledger lines that do **not** abut, i.e. summed `next.prevT − cur.t` where that is
  positive, restricted to lines inside the window. This is a property of the ledger, not of
  the join, which is why it takes the ledger rather than the intervals — and why it can see
  the breaks during which no history sample was written either.

Do not add `coveredMs` to `Interval`. Nothing above needs it, and the shape is already
read by four modules.

### 3. `shared/types.ts` — the contract, first

Add a `UsageCoverage` interface and hang it off `UsageRatesResponse` as a new
**non-optional** `coverage` field. `emptyRates` in `server/api.ts` must produce a zeroed,
honest instance of it so the field is never absent — the response type is the source of
truth and an optional field here would push a null check into the card for a state that
cannot happen.

Fields, all in utilization points except where named otherwise:

- `movedPct` — the denominator: every non-`idle` point in the horizon.
- `pricedPct` — points in `{model}`-owned intervals, the ones that reach a rate.
- `mixedPct`, `externalPct` — already-explained refusals, included so the buckets sum to
  `movedPct` and a reader can check that themselves.
- `preLedgerPct`, `missingPct`, `partialPct` — the three-way split, in the same order as
  the classification above. Name the payload field `missingPct` rather than `gapPct`: the
  wire name should say what the bucket means now that `gap` no longer means all three.
- `recorderBreakHours` — hours, not ms, because it is read by a person; the one field on
  the object that is not a utilization figure, so document that in its own docstring.
- `startProvable` — `false` when `ledgerStartMs` came back `null`. The card must say so:
  with it false, `preLedgerPct` is 0 and `missingPct` has absorbed it.

Document the nulls-are-load-bearing rule the way the neighbouring interfaces already do,
with one difference to state explicitly: these are **counters, not fits**, so zero means a
measured zero here and there are no nulls.

### 4. `server/api.ts` — wire it

`shapeUsageRates` takes `ledgerStartMs: number | null` in its opts, passes it to
`joinIntervals`, and fills `coverage` from `coverageBreakdown` + `ledgerBreakMs`. Keep it
pure — no clock, no disk — which is why the start instant arrives as a parameter.

Compute the breakdown over the **same horizon `externalSharePct` already uses**:
`[nowMs − BASELINE_MS, ∞)`. Its docstring already gives the reason — it describes how much
of everything behind these numbers had to be thrown away — and two disclosure figures on
one card that quietly span different windows is the defect this repo has already paid for
once.

`serveUsageRates` calls `ledgerStartMs(dir)` beside its two existing reads. `dir` stays
injectable so a test can point all three readers at one fixture.

Do not touch `externalShare` or `externalSharePct`. It is a published number and this task
must not move it.

### 5. `client/` — the footer says it

`client/src/lib/usageRatesFormat.ts` gets the formatting, as pure functions beside
`formatSharePct`, so the statements the card makes are testable without a browser. The
component reads them; it does not build strings.

What the footer must say, as a second `.rates-foot` row under the external pill:

- A pill leading with the priced share — the honest headline, e.g. `40% priced`.
- Then the refusals that are non-zero, each with its share and named for its cause, in
  descending size. `pre-ledger` must be phrased as self-healing, because it is: something
  to the effect of *"42% predates recording — ages out on its own"*.
- The recorder-down hours as their own clause, with the points it actually cost beside them,
  so 12.4 h does not read as 12.4 h of lost spend.
- **Omit a bucket entirely when its points are zero.** A row of zeroes reads as a fault.
- When `startProvable` is false, replace the pre-ledger clause with a statement that the
  ledger has rotated so the start of recording is unknown, and that `missingPct` therefore
  includes whatever predates it.

Styling: reuse `.rates-foot` and `.rates-pill`, which already exist at
`client/src/styles.css:846-850`. If a new class is genuinely needed, it goes beside them
and uses **only** existing theme tokens — `var(--text2)`, `var(--text3)`,
`var(--surface2)`, `var(--border)`. No literal color or shadow: the five themes are pure
`[data-theme]` token overrides and one literal breaks the light one.

No `title` attributes. This board is read from a phone, where `title` never fires — the
same rule the card's existing `.rates-hint` follows.

### 6. `scripts/probe-usage-split.ts` — live evidence, not just green tests

The probe already counts intervals by kind, which now reports the three kinds for free.
Add a coverage section printing `coverageBreakdown`'s buckets (intervals, points, % of
moved), `ledgerBreakMs` in hours, and the resolved `ledgerStartMs` with whether it was
provable.

This step is not optional. This exact join has already shipped a version that classified
**759 of 759** live intervals as `gap` with every unit test passing — the reason
`docs/subsystems/usage-limits.md` documents the overlap-weighted rule at length. The unit
tests below cannot catch a rule that is wrong about real data.

### 7. `docs/subsystems/usage-limits.md`

- The classification table under *The fitter* (~line 489) replaces its single `gap` row
  with three, each with its own "Used for" cell — all three are "nothing", and the table
  should say why the reasons differ.
- A short subsection on the coverage breakdown: the two measures and why they are two, the
  `prevT`-plus-size-guard rule for the recording start and the rotation case it refuses to
  guess at, and the straddling-interval overstatement.
- Update *The endpoint and the card* (~line 676) for the new `coverage` field and the
  footer row.
- Carry the live figures from this task's Goal table into the doc — they are the evidence
  that `gap` was 92% startup artifact, and the next reader will ask.
- Leave the `docs-sync:` stamp at the file's end alone. `/docs-sync` re-baselines it.

`docs/overview.md:137-140` describes these modules in one line each and stays accurate as
written. Check it rather than assuming, and touch it only if it drifted.

## Test cases

Node-assert, in the existing files, following their conventions (`test/run-all.ts`
registers each module's `run()`; `usage-rate-classify.test.ts` has the `s` / `l` / `counts`
fixture helpers to reuse).

**`test/usage-rate-classify.test.ts` — classification**

1. Zero ledger coverage, interval `toT` strictly before `ledgerStartMs` → `'pre-ledger'`.
2. Zero ledger coverage, interval `toT` **exactly equal** to `ledgerStartMs` → still
   `'pre-ledger'`. The boundary is inclusive; pin it.
3. Zero ledger coverage, `toT` one millisecond after `ledgerStartMs` → `'gap'`.
4. Coverage above zero but under `LEDGER_COVERAGE_MIN`, after the start → `'partial'`.
   Build it at a coverage of exactly 0.5 so the assertion does not sit on the threshold.
5. Coverage exactly at `LEDGER_COVERAGE_MIN` → classifies on its tokens as today
   (`{model}` for a dominant model), **not** an unpriced kind. The comparison is `>=`.
6. `ledgerStartMs` passed as `null` with zero coverage → `'gap'`, never `'pre-ledger'`.
7. `joinIntervals` called with **two** arguments still compiles and behaves as case 6 —
   the default is what keeps the probe and the older tests honest.
8. An interval straddling the start (`fromT` before, `toT` after) with zero coverage →
   `'gap'`. The documented, bounded overstatement.
9. Every existing assertion in this file that expects `'gap'`
   (`usage-rate-classify.test.ts:92` and `:120`) still passes unchanged, since both are
   zero-coverage cases with no start supplied.

**`test/usage-rate-drift.test.ts` — the invariant that no rate moves**

10. `externalShare` returns the same value for a fixture where one interval is `'gap'` as
    for the identical fixture with that interval `'pre-ledger'`, and again with
    `'partial'`. All three are out of the denominator. `usage-rate-drift.test.ts:479`
    already loops over `['gap', 'external']` for a related property — extend that loop to
    all three unpriced kinds rather than writing a fourth copy.
11. **Mutation-proof case 10.** Assert that a `pre-ledger` interval carrying a large
    `dUtil` does not change `externalShare`'s result at all — a test that passes with the
    predicate deleted proves nothing, and the deleted-predicate behaviour here is that
    `pre-ledger` lands in `moved` and *shrinks* the external share. Verify by hand that
    the assertion fails when the predicate admits all three.
12. `usableForSplit` (via `fitSplits`, which is what is exported) excludes `pre-ledger` and
    `partial`: a fixture whose only otherwise-usable intervals are `partial` fits nothing.
    This is the site that fails open, so it needs the test the other one does not.
13. `driftRow` returns byte-identical rows for a fixture before and after the same
    zero-coverage intervals are relabelled `pre-ledger`. The task's headline claim is "not
    one fitted rate moves"; this is the assertion that proves it.

**`coverageBreakdown` and `ledgerBreakMs` — new cases in the same file**

14. A fixture with one interval of each kind: buckets carry the right points and
    `movedPct` equals their sum. Use distinct `dUtil` values per kind (e.g. 1/2/4/8/16/32)
    so a mis-bucketed interval cannot coincidentally balance.
15. An `idle` interval with `dUtil` 0 is in no bucket and does not move `movedPct`.
16. An `idle` interval is excluded from `movedPct` even when its `dUtil` is above zero but
    within `IDLE_EPS` — the complement of case 15, and the one a single test would miss.
17. Intervals outside `[sinceMs, untilMs)` are excluded, tested on `toT` at both edges:
    `toT === sinceMs` is in, `toT === untilMs` is out.
18. `ledgerBreakMs` over three lines that all abut → 0.
19. `ledgerBreakMs` over lines with one 5-minute break → exactly 300 000.
20. `ledgerBreakMs` ignores a break wholly outside the window, and does not count
    overlapping or out-of-order lines as negative time.

**`test/usage-ledger-io.test.ts` — `ledgerStartMs`, tmpdir fixtures**

21. A three-line ledger → the **first line's `prevT`**, not its `t`. Write the fixture with
    `prevT` and `t` a minute apart so the two are distinguishable.
22. Absent file → `null`. Empty file → `null`. A file whose first line is junk followed by
    a valid line → that valid line's `prevT`.
23. A file padded past `MAX_LEDGER_BYTES / 2` bytes → `null`, even though its first line
    parses fine. This is the rotation guard; without this test the guard is untested code.
24. The exported never-rotated ceiling equals `MAX_LEDGER_BYTES / 2`, so the two cannot
    drift apart. Same shape as the existing "the documented thresholds" test.

**`test/api-usage-rates.test.ts` — the payload**

25. `emptyRates` (recording off, and the error path) carries a `coverage` object with every
    counter at 0 and `startProvable: false`. The field is never absent.
26. `shapeUsageRates` with a mixed fixture returns `coverage` buckets that sum to
    `movedPct`, and a `pricedPct` matching the points behind the rows it returned.
27. `coverage` is computed over `[nowMs − BASELINE_MS, ∞)` — the same horizon as
    `externalSharePct`. Assert with an interval older than the current window but inside
    the baseline: it must appear in `coverage`.
28. Passing `ledgerStartMs: null` yields `preLedgerPct` 0 with those points in
    `missingPct`, and `startProvable: false`.

**`test/usage-rates-format.test.ts` — the card's sentences**

29. A zero bucket produces no clause at all (assert the substring is absent, not that some
    string is empty).
30. `startProvable: false` produces the rotation sentence and **no** pre-ledger clause.
31. The recorder-down clause names both the hours and the points, so the hours cannot be
    read as lost spend.
32. The live shape from the Goal table (`movedPct` 1048, priced 418, pre-ledger 438,
    missing 2, partial 32, 12.35 h) formats to a footer that reads as a sentence. Assert
    the priced share rounds to `40%` and the pre-ledger share to `42%`.

**Browser check**

33. `In the browser (playwright MCP tools):` start the dev server (`pnpm dev`), open
    `http://localhost:5174`, go to **Usage** → **Token value**, and confirm the footer
    shows the priced pill and the pre-ledger clause beside the existing `% external` pill,
    with no bucket rendering as `0%` and no `NaN`. Take a snapshot at the default width and
    again at 560px wide (`browser_resize`), where `.rates-foot` wraps — the footer must
    still read as prose, not as a broken grid. This repo has no `.mcp.json`; the Playwright
    MCP server arrives with the `backlog-manager` plugin, which is loaded for any session in
    this repo, headless ones included.

**Live probe — the one that has caught this module before**

34. `npx tsx scripts/probe-usage-split.ts --days 17` against the real logs, and report the
    numbers in the PR. Expected, within drift since 2026-09-02T18:41Z: `pre-ledger`
    dominates the unpriced points, `gap` (zero coverage) is a couple of points at most,
    `partial` is roughly ten times `gap`, and `ledgerStartMs` resolves provable to
    `2026-08-31T07:41:07.602Z`. **A run where `pre-ledger` is 0 or where every unpriced
    interval is still `gap` means the join never saw the start instant** — that is the
    failure mode this whole feature exists to catch, and it passes unit tests happily.

## Done when

- `pnpm typecheck` and `pnpm test` both pass, with the output pasted. The case count in
  `pnpm test`'s summary has gone up by the cases above.
- Cases 10–13 hold: no fitted rate, no baseline, no deviation, no verdict and no
  `externalSharePct` changes for any fixture. This is the task's headline claim.
- Case 11 was mutation-checked by hand — the assertion was confirmed to fail with the
  unpriced predicate widened — and the PR says so.
- The live probe (case 34) ran, and its output is in the PR with the resolved recording
  start and the three buckets.
- The browser check (case 33) ran, at both widths.
- `docs/subsystems/usage-limits.md` names the three kinds in its classification table and
  carries the live figures; its `docs-sync:` stamp is untouched.
- Nothing new is in `server/`'s dependency list — every part of this reads disk or does
  arithmetic.
- The PR body follows `.github/pull_request_template.md`, and states plainly what was **not**
  verified: the `startProvable: false` path is exercised only by unit fixtures, since no real
  ledger here has ever rotated (287 days of recording away at the current line size).
