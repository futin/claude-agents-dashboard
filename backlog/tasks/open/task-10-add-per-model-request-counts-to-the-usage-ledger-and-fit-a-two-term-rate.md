---
id: task-10
title: Add per-model request counts to the usage ledger and fit a two-term rate
created: 2026-09-01
tags: usage, server, analytics
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
