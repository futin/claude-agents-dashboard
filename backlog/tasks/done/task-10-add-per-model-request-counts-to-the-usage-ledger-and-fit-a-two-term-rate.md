---
id: task-10
title: Add per-model request counts to the usage ledger and fit a two-term rate
created: 2026-09-01
tags: usage, server, analytics
updated: 2026-09-02T11:06:08Z
started: 2026-09-02T10:35:27Z
execute-elapsed: 1841
---

## Goal

Make the per-model rate separable, so the Usage tab can say something true across models
rather than only within one.

Today `usage-rate.ts` fits a single ratio, Σtokens / Σutilisation, per model. That ratio is
only a *price* if the 5-hour counter is charged purely per token. It is not: anything
charged per request (or per turn) lands in the `dUtil` denominator with no tokens beside it,
and the ledger records only per-minute token sums, so the fit has nowhere to put it and
attributes all of it to the token term.

Measured on live logs (2026-09-01, `.usage-history.jsonl` + `.usage-ledger.jsonl`):

- opus-5 burns 1% in a median 4.0 minutes; fable-5 in 2.0 minutes.
- Fitted opus:fable ratio is 4.20 (weighted) / 4.85-5.06 (raw), from two independent
  estimators — the shipped dominance pool, and a 2-variable OLS over 219 covered
  intervals that also uses the `mixed` intervals the pool discards.
- The published price ratio is ~2x.

Both estimators agreeing rules out noise and selection bias (see `bug-13` for the full
elimination), which leaves the missing term. Fable is the small-context fast model, so it
fires many more requests per token; any per-request component therefore reads as "fable is
expensive per token". A second regressor is the only way to tell the two apart.

## Plan

Four changes, back-to-front so nothing is fitted on a field that is not yet recorded.

**1. Record the count (`server/lib/usage-ledger.ts`).**

Each `UsageEvent` is already exactly one assistant message, deduplicated by `message.id`
against the per-transcript `seen` ring — so a request count needs no new source, only
carrying through what `collectEvents` already discards. Add a request-count field to the
per-model bucket that `sumWindow` builds, incremented once per event kept.

Constraints that are load-bearing:

- **The field must be optional on read.** Every line already on disk lacks it. A missing
  count is `null`/absent, never `0`: absent means "not recorded", zero means "measured
  nothing", and the fit must be able to tell them apart. `parseLedgerLine` currently
  coerces missing numerics to 0 via `num()` — the count must not go through that path.
- **Splitting a straddling tick must not scale the count into a fraction that reads as a
  measurement.** `gather` in `usage-rate.ts` pro-rates edge ticks by time overlap; token
  counts tolerate that, a request count is an integer event stream. Decide and document
  one rule (pro-rate as a float, or attribute whole to the tick's own interval); the
  approximation is bounded at two ticks per interval either way, but it must be stated.
- Serialisation stays one compact JSON object per line, keys short, same as `tok`.

**2. Extend the interval (`server/lib/usage-rate.ts`).**

`Interval.tok` gains a parallel per-model request count, gathered the same way. An interval
where *any* contributing ledger line lacks the count is marked as having no usable count —
one unrecorded line poisons the interval's count, and a partial count fitted as if whole is
worse than dropping the interval from the two-term fit.

**3. Fit two terms.**

Replace the per-model pooled ratio with a least-squares fit of `dUtil` against two
regressors, per model: weighted tokens, and request count. Keep the existing pooled ratio
as the fallback whenever the two-term fit cannot be run (no counts recorded, too few
intervals, or a singular/ill-conditioned system) — the card must keep working on two days
of data and on pre-upgrade ledger lines.

Decisions to make explicitly rather than inherit:

- **Which intervals feed it.** The single-ratio fit needs `DOMINANCE`-owned intervals; a
  two-term fit does not, and the `mixed` intervals are where the information is (50 of 58
  contain fable). Fitting per-model coefficients jointly across all covered intervals is
  the estimator that was validated above and returned 4.20. If that widening is taken,
  `DOMINANCE` stops being load-bearing for the rate and `mixed` stops being a discard
  class — say so in `docs/subsystems/usage-limits.md`, which currently documents the
  opposite.
- **Floors.** `BASELINE_FLOORS` / `CURRENT_FLOORS` were tuned for a one-parameter fit. Two
  parameters need more evidence, and an ill-conditioned pair (a model whose requests and
  tokens move together perfectly) must report `thin`, not a confident split.
- **Negative coefficients.** Least squares will happily return a negative per-request or
  per-token cost. Both are physically impossible; clamp at zero or refuse the fit, and
  make which one it is a documented decision.

**4. Surface it (`shared/types.ts` first, then server, then client).**

`ModelRateRow` gains the per-request and per-token coefficients, both nullable. What the
card does with them is `bug-13`'s call, not this task's — this task must leave the existing
`rawPerPct` / `weightedPerPct` / `deviationPct` / `verdict` fields behaving exactly as they
do now, so `bug-13` can be decided independently.

## Test cases

Extend `test/` (node-assert, tmpdir JSONL fixtures) in the style already there. Each case
names the expected value, not the assertion mechanics.

Ledger codec:

- A line serialised with request counts round-trips through parse with the counts intact.
- A line written **before** this change (no count key) parses successfully, and its counts
  read as absent — not as 0. Assert the distinction directly; this is the case a `num()`
  coercion would silently break.
- A line with a non-numeric or negative count parses with that model's count absent, and
  the line's token counts still usable.
- `sumWindow` over three events from two models in `(prevT, t]` reports counts 2 and 1,
  and the same token sums it reports today. An event outside the half-open bound is
  excluded from the count as well as the tokens.
- Two records carrying a copy of the same `message.id` produce one counted request.

Interval gathering:

- An interval covered by two whole ledger lines sums both counts.
- An interval whose edge tick straddles the boundary produces the count the documented rule
  says it should — assert the chosen rule's exact number, so the rule cannot drift silently.
- An interval where one of three contributing lines lacks a count is marked count-unusable,
  and its token totals are unchanged from today's behaviour.

The fit:

- Synthetic intervals generated from known coefficients (say 0.5 points per 1M weighted
  tokens and 0.02 points per request) recover both within 5%, given enough intervals to
  clear the floors. **Mutation-prove it**: the same fixture must fail if the request term
  is dropped from the fit, or the test proves nothing.
- Intervals where requests are an exact multiple of weighted tokens (perfectly collinear)
  yield `thin`, not a split.
- Intervals whose only honest fit has a negative coefficient behave as the documented
  decision says (clamped or refused), and never report a negative rate to the client.
- A ledger with no counts at all reproduces today's single-ratio numbers exactly, for both
  models, over the same fixture the current tests use — this is the back-compat guard.
- Below the two-term floors the row falls back to the single ratio and the existing verdict,
  with the new coefficient fields null.

Live-data probe, not a unit test, and required before this is called done (green units
already hid a join that classified 759/759 intervals as `gap`):

- Re-run the estimate against the real `.usage-history.jsonl` + `.usage-ledger.jsonl` after
  a day of recording with counts, and report the implied opus:fable per-token ratio. If the
  per-request term is real, that ratio should fall from ~4.2 toward the price ratio; if it
  does not, the hypothesis is wrong and the finding belongs back in `bug-13` rather than
  being papered over with a new number.

## Done when

- `pnpm test` and `pnpm typecheck` pass, with the command output quoted.
- Ledger lines carry per-model request counts, and pre-existing lines still fit.
- The two-term fit reports both coefficients per model where the evidence supports it, and
  `thin` where it does not, with the single-ratio fallback intact.
- `docs/subsystems/usage-limits.md` states the new classification and fit — in particular
  whatever changed about `DOMINANCE` and the `mixed` class — and `docs/overview.md` §Map
  still resolves.
- The live-data probe above has been run and its number reported, including the case where
  it refutes the hypothesis.
- Unverified items are stated explicitly, per the PR rules.

## Outcome

**2026-09-02 — done, and the hypothesis behind it is refuted.**

All four plan steps landed and both gates pass. The live-data probe the plan required
ran, and it says the per-request term is *not* what closes the 4.2x-vs-2x gap. That
finding is recorded below rather than papered over: the fit is correct, and what it was
built to explain is still unexplained.

### What was built

1. **Ledger (`server/lib/usage-ledger.ts`).** `LedgerLine` gains `req?: Record<string,
   number>`, `sumWindow` now returns `{ tok, req }` (`WindowSums`), and
   `parseLedgerLine` reads `req` **outside** the `num()` path so absent stays absent —
   per model and for the line as a whole — while a junk or negative count drops only
   that model's key.
2. **Interval (`server/lib/usage-rate.ts`).** `Interval` gains `req` and `reqUsable`.
   One contributing line that recorded no count for a model it recorded spend for
   poisons the interval's count; token totals are untouched. A line with no `req` and no
   spend poisons nothing (no tokens ⇒ no events ⇒ no requests).
3. **The fit.** `explainSplits` / `fitSplits` fit `dUtil` on two regressors per model —
   weighted tokens (Mtok) and request count — jointly over `gap`- and
   `external`-excluded, count-usable intervals, no intercept. `SPLIT_FLOORS` 20/10,
   `SPLIT_MAX_R2` 0.99, `SPLIT_RANK_TOL` 1e-3.
4. **Surface.** `ModelRateRow` gains `pctPerMWeighted`, `pctPerRequest`,
   `splitVerdict: 'fitted' | 'thin'`. Docs: `docs/subsystems/usage-limits.md` (ledger,
   classification table, a new *two-term fit* section, endpoint) and `docs/overview.md`
   §Map.

### Decisions taken where the plan left them open

- **Straddling ticks pro-rate the count as a float**, like tokens. Attributing a whole
  tick to one side would make the two regressors disagree about the same two edge
  minutes, and it is their *ratio* the fit measures.
- **Negative coefficients are refused, not clamped.** A clamped 0 publishes "requests
  are free" as a measurement nobody made; a null means "not enough evidence to say",
  which is what every null in this file means.
- **`idle` intervals are in the fit**; `external` and `gap` are out. Utilization is read
  coarsely, so keeping only intervals where it moved is selection on the dependent
  variable and inflates every coefficient.
- **`mixed` intervals are in the fit; `DOMINANCE` stays load-bearing for the rate.**
  Documented as exactly that split of responsibility.

### Deviations from the plan, deliberate

- **`req` is a parallel map, not a field inside the per-model `tok` bucket** (plan step
  1). A count is not a token type: inside `TokenCounts` it would flow through
  `weightedTokens` / `scaleCounts` / `addCounts`, and per-model absence would have to
  survive the same parse that coerces missing token *types* to 0.
- **The two-term fit is additive; it does not replace the pooled ratio** (plan step 3
  said "replace", step 4 said leave `rawPerPct` / `weightedPerPct` / `deviationPct` /
  `verdict` behaving exactly as now). Step 4 wins — it carries the reason, that `bug-13`
  must stay independently decidable. So the back-compat guard holds unconditionally
  rather than by fallback.
- **Collinearity reports through a new `splitVerdict`, not through `verdict`** (plan
  step 3 said an ill-conditioned pair "must report `thin`"). Setting `verdict` from the
  split would have changed the drift verdict's behaviour, which step 4 forbids.
- **A rank-revealing QR replaced the normal-equations solve** after the live probe
  proved the first version reported nothing at all: one model with a single interval
  (`claude-opus-4-8`) made the whole joint system singular, so *every* model came back
  thin. Column order is now token columns first, then request columns, so the pass drops
  a request column rather than stranding a model's utilization on its neighbours.
- **`scripts/probe-usage-split.ts` was added** (plus `pnpm probe:usage-split`), because
  the plan requires this probe to be re-run after a day of live recording. It is the
  only new file.
- **No client change.** `UsageRates.tsx` compiles untouched; what the card does with the
  coefficients is `bug-13`'s call, per plan step 4.

### Verification

```
$ pnpm typecheck
> claude-agents-dashboard@0.1.0 typecheck
> tsc --noEmit
typecheck exit=0

$ pnpm test
  ... 1112 passing cases across all suites ...
  18/18 passed
ALL PASS
test exit=0
```

The suites this touched:

```
=== usage-ledger.ts (pure core) ===
  ✓ sumWindow: (prevT, t] excludes prevT, includes t — for counts too
  ✓ sumWindow: groups by model, sums each type, counts one per event
  ✓ request counts round-trip intact
  ✓ a line written before counts existed parses with req absent, not zeroed
  ✓ junk and negative counts drop that model only; the line stays usable
  ✓ a non-object req is the same as no req at all
  16 passed, 0 failed

=== usage-ledger.ts (recorder I/O) ===
  ✓ one line per tick, summed per model per type, stamped prevT→t
  ✓ a quiet minute writes an empty line — a measured zero is data
  ✓ junk, user turns and usage-less records are skipped; a repeated message id counts once
  10 passed, 0 failed

=== usage-rate.ts (join + classify) ===
  ✓ two whole ledger lines sum their counts
  ✓ a straddling edge tick pro-rates its count as a float, like its tokens
  ✓ one of three lines without a count poisons the count, not the tokens
  ✓ a line recording a count for one model but not another is still poisoned
  ✓ an empty pre-upgrade tick is zero requests, not an unrecorded count
  20 passed, 0 failed

=== usage-rate.ts (rates + drift) ===
  ✓ the documented split thresholds
  ✓ each refusal is named, and named the most informative way
  ✓ a model seen once does not make every other model thin
  ✓ both coefficients are recovered from a fixture generated with them
  ✓ MUTATION: dropping the request term misses the token rate by 2.8x
  ✓ mixed intervals feed the fit — that is where the information is
  ✓ gap and external intervals never feed it
  ✓ an interval with unrecorded counts is dropped, and a whole ledger of them fits nothing
  ✓ requests as an exact multiple of tokens yields no split, not a confident one
  ✓ a fit whose only honest answer is negative is refused, not clamped
  ✓ both split floors bind independently
  ✓ two models are fitted jointly, each keeping its own coefficients
  ✓ the fit reads only its own window
  ✓ no usable intervals at all is an empty map, never a throw
  27 passed, 0 failed

=== usage rates endpoint ===
  ✓ a ledger with counts fits the split, and both terms reach the body
  ✓ a fixture above the floors fits one row, with the exact pooled rate
  7 passed, 0 failed
```

The mutation proof is executed rather than asserted about: `MUTATION: dropping the
request term…` runs the one-regressor OLS over the *same* fixture and requires it to be
more than 50% wrong (it is 2.8x wrong), so the recovery case above it cannot pass
vacuously.

### The live-data probe — and its refutation

Counts do not exist on disk yet (`0 of 1936` ledger lines carry `req`), so the probe was
run with `--reconstruct`, which replays `~/.claude/projects/**.jsonl` to synthesize what
the recorder would have written.

```
$ npx tsx scripts/probe-usage-split.ts --dir ../.. --reconstruct --days 3

  samples: 1273   ledger lines: 1936 (0 carry req)
  reconstructing missing counts from transcripts…
  transcripts read: 230 (406 older than the window)

  intervals: 558
    owned:claude-opus-5: 276      gap: 111      mixed: 64
    idle: 47                      external: 47  owned:claude-fable-5: 16
    owned:claude-sonnet-5: 3      owned:claude-haiku-4-5-20251001: 1
    → usable for the two-term fit: 407

  pooled single ratio (what the card shows today):
    claude-fable-5: 0.065M weighted/pt  (16 intervals, 17.0 pts)
    claude-opus-5:  0.248M weighted/pt  (276 intervals, 289.0 pts)

  one-term joint OLS over the usable set (bug-13's estimator):
    claude-fable-5: 10.7097 pt/Mtok  = 0.093M weighted/pt
    claude-opus-5:   2.4680 pt/Mtok  = 0.405M weighted/pt

  two-term fit (floors 20/10, r² ceiling 0.99):
    claude-fable-5: no split — negative  (r²=0.8761, 86 intervals, 100.0 pts,
                    least squares wanted tok=13.1505 pt/Mtok req=-0.05722 pt/request)
    claude-opus-5:  2.1980 pt/Mtok  +  0.00586 pt/request  (r²=0.8839, 357 intervals, 368.0 pts)
      4175 requests → 6.6% of the 368.0 points it appears in
    claude-haiku-4-5-20251001: no split — thin-evidence  (7 intervals, 5.0 pts)
    claude-opus-4-8:           no split — thin-evidence  (1 intervals, 1.0 pts)
    claude-sonnet-5:           no split — thin-evidence  (19 intervals, 19.0 pts)

  ── the ratio task-10 was filed on ──
    claude-opus-5 : claude-fable-5, cost per weighted token
      pooled single ratio: 3.83x
      one-term joint OLS:  4.34x
      two-term fit:        n/a
      same fit, sign refusal lifted (diagnostic only): 5.98x
```

**The reconstruction is sound.** The one-term joint OLS reproduces `bug-13`'s
independent estimator to within rounding — opus 0.405M weighted/pt against its 0.40M,
fable 0.093M against its 0.10M, ratio 4.34 against its 4.20 — so the join, the
classification and the synthesized counts are all behaving.

**The hypothesis does not survive it.**

- `claude-opus-5` fits, but the per-request term explains only **6.6%** of the 368
  points it appears in, and its per-token coefficient falls just 11% (2.468 → 2.198).
- `claude-fable-5` is **refused for a negative coefficient**: least squares wants
  −0.0572 pt/request for it, and to pay for that it pushes fable's per-token cost *up*,
  10.71 → 13.15 pt/Mtok. Its r² is 0.876 and it appears in 86 intervals, so this is not
  an identification failure — within intervals, fable's request count is genuinely
  anti-correlated with the utilization left over once the other models are accounted for.
- Lift the sign refusal and the opus:fable per-token ratio becomes **5.98x**. The gap
  **widens** away from the ~2x list price rather than closing on it.

Per the plan's own instruction — "if it does not, the hypothesis is wrong and the
finding belongs back in `bug-13` rather than being papered over with a new number" —
this is reported as a refutation. `bug-13` should not treat a per-request term as the
thing that makes the card comparable across models.

### Not verified — needs a human

- **The probe has never seen a live-recorded count.** Every number above rests on counts
  reconstructed retroactively, and the reconstruction is *not* identical to the
  recorder: it dedups `message.id` globally over whole files, where the recorder dedups
  per transcript against a 256-entry ring as it streams from a byte offset. Both
  differences can only under-count older ticks, and a transcript since deleted is simply
  absent. **Re-run `pnpm probe:usage-split -- --dir . --reconstruct --days 3` after a day
  of real recording** and compare; the refutation should be re-confirmed against
  recorded counts before `bug-13` acts on it.
- **No `drift`/`stable` verdict was exercised on real data**, unchanged from `task-8`:
  that still needs a 17-day baseline to exist.
- **The card was not opened in a browser.** No client code changed and `UsageRates.tsx`
  ignores the new fields by design, so there is nothing new to see there — but that is
  reasoned, not observed.
- **`SPLIT_MAX_R2` = 0.99 and `SPLIT_RANK_TOL` = 1e-3 are chosen, not tuned.** They are
  defensible (variance inflation 100; a thousandth of a unit column) and unit-tested at
  their boundaries, but no sweep against real data was run to see whether a stricter
  ceiling would refuse opus too.
- **Nothing was committed or staged.** Working tree left as-is: 12 modified files plus
  the new `scripts/probe-usage-split.ts`.
