---
id: bug-13
title: Token-value card leads with an unweighted raw rate that misreads as a per-model price
created: 2026-09-01
tags: usage, client, analytics
updated: 2026-09-02T15:32:21Z
groom-elapsed: 175
started: 2026-09-02T15:21:30Z
execute-elapsed: 651
---

## Symptom

The Usage tab's **TOKEN VALUE PER MODEL** card prints, per model, "N / 1%" as its headline
figure. Read as intended — "what one percent of the 5-hour window is worth" — it invites a
cross-model price comparison the number cannot support. On live logs (2026-09-01, two days
of history, both rows `collecting`):

| model | windows | pts | rawPerPct (shown) | weightedPerPct |
|---|---|---|---|---|
| claude-opus-5 | 139 | 148.0 | **1.737M** | 0.257M |
| claude-fable-5 | 16 | 17.0 | **358k** | 0.065M |

That reads as fable being 4.85x more limit-expensive per token than opus, where the list
price ratio is ~2x. The user's reaction — "how can calculation be this wrong" — is the bug:
the card is arithmetically right and rhetorically wrong.

Two separate defects, both in what is *shown* rather than how it is computed:

1. The headline is the **unweighted** sum `in + out + cc + cr`, so it is dominated by
   cache-read volume — 97.2% of opus's raw tokens and 95.0% of fable's on this data. It
   therefore measures how much context a model's sessions replay per 1% of limit (a habit),
   not what a token costs. The code already knows this: `rawTokens` is commented "for the
   plain count, for the courtesy `1% ≈ N tokens` translation only", and every verdict is
   fitted on `weightedPerPct` instead.
2. Nothing on the card says the figure is not comparable across models. The heading
   ("TOKEN VALUE PER MODEL") and the subtitle ("Tokens per 1% of the 5-hour limit") both
   read as a price list.

## Repro

1. Usage tab with `Record usage history` on and at least `CURRENT_FLOORS` worth of
   intervals for two models (10 intervals, 5 utilisation points each).
2. Compare the two headline figures against the models' published price ratio.

Reproduced directly off `.usage-history.jsonl` + `.usage-ledger.jsonl` by re-implementing
the `joinIntervals` + `pool` math standalone: 1.737M and 358k, 139/148.0 and 16/17.0 —
matching the card exactly, so this is not a formatting or transport defect.

## Affects

- `server/lib/usage-rate.ts:211` — `raw += counts.in + counts.out + counts.cc + counts.cr`
- `server/lib/usage-rate.ts:217` — `rawPerPct: raw / utilSum`
- `server/lib/usage-ledger.ts:65` — `rawTokens`, the "courtesy translation" comment
- `client/src/components/usage/UsageRates.tsx:38` — renders `row.rawPerPct` as the headline
- `client/src/components/usage/UsageRates.tsx` — `up-sub` copy, heading text
- `docs/subsystems/usage-limits.md` — the classification table this card documents

## Cause

Design, not arithmetic — and the code already carries the right number, so the defect is a
one-field display choice.

**The operative line.** `client/src/components/usage/UsageRates.tsx:38` renders
`row.rawPerPct` as the headline. `weightedPerPct` and `baselineWeightedPerPct` are already
on `ModelRateRow` (`shared/types.ts:186-202`) and already computed beside raw
(`server/lib/usage-rate.ts:215-217`), so nothing here needs a server change, a contract
change or a re-fit — only which of two fields the card leads with, and what it says about
it.

**It is a documented intent, not an oversight.** The component's own JSDoc states "The raw
number leads because it is what a person plans against" (`UsageRates.tsx:11-12`), and the
subsystem doc calls raw "a courtesy translation" while judging every verdict on weighted
(`docs/subsystems/usage-limits.md:420-428`). A fix that swaps the field without rewriting
both sentences gets reverted by the next reader.

**It is loudest in the state nothing contextualises.** `driftRow` returns `verdict: 'thin'`
whenever `baseline === null` (`server/lib/usage-rate.ts:269`) — every model's first ~17
days, the baseline window being `[now−17d, now−3d)` — while `rawPerPct` stays non-null as
soon as the *current* window clears `CURRENT_FLOORS`. So the first fortnight shows a large
headline with a `collecting` badge, no deviation chip and "no baseline yet": nothing on
screen argues against the price reading exactly when the number is least qualified. Both
live rows above are in that state, at 139 and 16 windows.

Three things were verified *not* to be the cause, so a fix that targets them is wasted work:

- **Not token-type weighting.** Sweeping the cache-read weight in `TYPE_WEIGHTS`
  (`server/lib/usage-ledger.ts:54`) across 0.1 / 0.25 / 0.5 / 1.0 gives opus:fable ratios
  of 4.20 / 4.77 / 4.97 / 5.04. No weighting reaches 2x.
- **Not the small sample.** Bootstrap (2000 resamples) of fable's pooled `rawPerPct` at
  n=17: point 338k, 90% CI [245k, 437k]. Even the ceiling sits ~4x under opus.
- **Not the `DOMINANCE` selection filter.** Fable is rarely used alone — 50 of the 58
  `mixed` intervals contain it (mean weighted share 0.35, against opus's 0.63) — so the
  16 fable-owned intervals are a thin slice. But a 2-variable OLS of `dUtil` on per-model
  weighted tokens over 219 covered intervals, which *uses* the discarded mixed intervals,
  returns opus 0.40M weighted/pt and fable 0.10M weighted/pt: ratio **4.20**, same answer
  from an estimator with none of the selection bias.

The residual gap between the measured ~4.2-4.85x and the ~2x price ratio is a missing
per-request term in the model, filed separately as `task-10`. This bug is only about the
card presenting a habit-weighted, non-comparable figure as a price.

## Fix

Take both candidates: lead with the weighted rate, keep raw as an explicitly labelled
translation, and say on the card that these rates are not a price list. Client-only — no
server, no `shared/types.ts`, no re-fit. **Not blocked on `task-10`**: the bug is the card
claiming a comparison it cannot support, and the honest fix is to stop claiming it.
`task-10` is only needed if the card should later become *genuinely* cross-comparable.

1. **`client/src/components/usage/UsageRates.tsx`** — headline becomes
   `formatTok(row.weightedPerPct)` with the unit ` weighted / 1%`. Raw drops to a secondary
   line built from a new pure helper (`≈ 1.7M raw at this model's recent mix`), omitted
   entirely when `rawPerPct` is null — a translation of nothing is not `—`. The deviation
   chip's suffix changes from ` weighted` (now redundant) to ` vs baseline`. The meta line
   switches `baselineRawPerPct` → `baselineWeightedPerPct`, so the headline and its baseline
   are the same quantity; keep the `no baseline yet` fallback. Rewrite the JSDoc sentence
   "The raw number leads because…" — weighted leads because it is the only mix-invariant
   quantity on the row.
2. **`client/src/lib/usageRatesFormat.ts`** — the raw-aside string is built here, not inline
   in JSX, so the statement the card makes is testable the way every other statement on this
   card already is.
3. **Copy (`up-sub`)** — one added sentence naming the limit: the rates are fitted from this
   machine's own usage, and a model that fires more requests per token carries per-request
   window cost into its token rate, so a cross-model ratio is not a price ratio (see
   `task-10`). Keep the `TOKEN VALUE PER MODEL` heading — it is the feature name used in
   `docs/subsystems/usage-limits.md`, and the reason belongs in the subtitle, which has room
   for it.
4. **`client/src/styles.css`** — one new class for the raw aside, beside `.rates-value`
   (~lines 823-828). Theme tokens only (`var(--text3)`, mono, ~11px); no literal colour.
5. **`docs/subsystems/usage-limits.md` §"No dollars, only ratios"** (~lines 420-428) — the
   paragraph calling raw the courtesy translation must now also say the card *leads* with
   weighted, and that per-model rates are not comparable across models.

Test cases:

- The new raw-aside helper: `1_737_000` → the `≈ 1.7M raw …` string at `formatTok`'s
  magnitude; `null` → `null` (no line rendered), never `'—'`.
- `formatTok`, `formatDeviation`, `evidenceText`, `verdictText` and `formatSharePct` keep
  every existing case in `test/usage-rates-format.test.ts` — the fix must not touch them.
- `test/api-usage-rates.test.ts` and the fitter tests stay green **unchanged**. A diff that
  had to edit either means the change leaked out of the client.

This repo has no component-render test, so "the headline is now the weighted rate" is proved
by the browser check below, not by a unit test — state that in the PR as unverified by tests.

In the browser (playwright MCP tools): open http://localhost:5174, click **Usage** in the
left rail, and read the TOKEN VALUE PER MODEL card. Each row's large figure must be the
weighted rate (on the current logs opus reads ~257k, not 1.7M); a smaller line beneath it
must read `≈ 1.7M raw at this model's recent mix`; the meta line must show `no baseline yet`
or a weighted baseline; and the subtitle must state that the rates are not comparable across
models.

## Outcome

2026-09-02 — fixed as planned, client-only. The card now leads with
`weightedPerPct` under the unit ` weighted / 1%`, keeps raw as an explicitly
labelled aside built by a new pure helper, pairs the headline with a *weighted*
baseline, and states in the subtitle that these are per-model rates and not a
price list. No server file, no `shared/types.ts` field, no re-fit — the two
fields the card now reads were already on `ModelRateRow`.

What changed:

- `client/src/lib/usageRatesFormat.ts` — new `rawAsideText(rawPerPct)`:
  `≈ <formatTok> raw at this model's recent mix`, and `null` (not `'—'`) when
  there is no raw rate, so the card omits the line rather than translating
  nothing.
- `client/src/components/usage/UsageRates.tsx` — headline
  `formatTok(row.weightedPerPct)` + ` weighted / 1%`; raw aside rendered only
  when the helper returns a string; deviation-chip suffix ` weighted` →
  ` vs baseline`; meta baseline `baselineRawPerPct` → `baselineWeightedPerPct`
  with the `no baseline yet` fallback kept; `up-sub` gained the
  not-comparable-across-models sentence; JSDoc's "The raw number leads because…"
  rewritten to say why weighted leads. The `TOKEN VALUE PER MODEL` heading is
  unchanged, as the plan required.
- `client/src/styles.css` — one new `.rates-raw` rule beside `.rates-dev`,
  theme tokens only (`var(--mono)`, `var(--text3)`, 11px), no literal colour.
- `docs/subsystems/usage-limits.md` §"No dollars, only ratios" — the courtesy-
  translation paragraph now says the card *leads* with weighted, and a new
  paragraph states no rate here is comparable across models, with the ~4.2x vs
  ~2x figures and the `task-10` pointer.
- `test/usage-rates-format.test.ts` — two cases for the new helper. Every
  pre-existing case in the file is untouched, and `test/api-usage-rates.test.ts`
  and the fitter tests were not edited at all.

One deliberate deviation: the plan's subtitle sentence ended "(see `task-10`)".
A backlog id on a user-facing card is noise, so the citation lives in the
subsystem doc instead; the substance of the sentence — per-request cost riding
inside the token rate, so a cross-model ratio is not a price ratio — is on the
card verbatim.

Verification. The new helper's null branch was mutation-proved: with
`if (rawPerPct === null || !Number.isFinite(rawPerPct)) return null;` deleted,

```
  ✓ rawAsideText labels the raw figure as a mix-dependent translation
  ✗ rawAsideText: a translation of nothing is no line, never a dash
    Expected values to be strictly equal:
+ actual - expected
```

Restored, `pnpm test`:

```
=== usageRatesFormat.ts ===
  ✓ formatTok: the five documented magnitudes
  ✓ formatTok: an unfitted rate is a dash, never a zero
  ✓ formatDeviation always carries its sign
  ✓ evidenceText states windows and cumulative movement
  ✓ every verdict has copy, and thin reads as collecting
  ✓ rawAsideText labels the raw figure as a mix-dependent translation
  ✓ rawAsideText: a translation of nothing is no line, never a dash
  ✓ formatSharePct rounds, and null stays null

  8 passed, 0 failed
```

Whole suite, `pnpm typecheck` and `pnpm build`:

```
  18/18 passed
ALL PASS

> tsc --noEmit
(no output)

dist/assets/UsageView-BuHlq_Nu.js    17.11 kB │ gzip: 6.25 kB
✓ built in 1.14s
```

The card itself has no render test in this repo, so the display claim was proved
in the browser (dev server on 5700, Usage → TOKEN VALUE, live logs, no console
errors):

```
TOKEN VALUE PER MODEL
Type-weighted tokens per 1% of the 5-hour limit … so these are per-model rates,
not a price list to compare across models. Baseline = the trailing 14 days …

claude-opus-5     COLLECTING   225k weighted / 1%
                               ≈ 1.5M raw at this model's recent mix
                               no baseline yet · 331 windows · 353.0 pts
claude-fable-5    COLLECTING   65k weighted / 1%
                               ≈ 358k raw at this model's recent mix
                               no baseline yet · 16 windows · 17.0 pts
claude-fable-5-1  COLLECTING   — weighted / 1%
                               no baseline yet · 3 windows · 7.0 pts
```

The headline is the weighted rate (opus 225k, not 1.5M — the raw figure it used
to print), the raw aside carries its mix label, and the three thin models with a
null raw rate render no aside line at all, which exercises the helper's null
branch on live data.

Not verified: the light theme was not opened, so `.rates-raw` is argued safe by
inspection (`var(--text3)`, no literal colour) rather than by looking at it. No
component-render test was added — the headline-field claim rests on the browser
read above.
