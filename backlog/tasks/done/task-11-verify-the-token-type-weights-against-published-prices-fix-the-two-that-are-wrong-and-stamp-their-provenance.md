---
id: task-11
title: Verify the token-type weights against published prices, fix the two that are wrong, and stamp their provenance
created: 2026-09-02
from: idea-17
updated: 2026-09-03T19:11:39Z
started: 2026-09-03T18:51:21Z
execute-elapsed: 1218
---

## Goal

`TYPE_WEIGHTS` (`server/lib/usage-ledger.ts:73`) is `{ in: 1, out: 5, cc: 1.25, cr: 0.1 }`,
described in `docs/subsystems/usage-limits.md` as ratios that are "uniform across current
models". Two of those four claims are wrong against published prices, and both were checked
during grooming — the numbers below are measured, not recalled, and the executor does not
need to re-derive them.

Ship: `cc` corrected, a per-model `cr` override, a one-command re-check so the constants stay
falsifiable, and a doc that says what the numbers are a proxy *for* instead of implying a
price list.

### What grooming already established

Priced live on **2026-09-02** against `https://platform.claude.com/docs/en/about-claude/pricing`
(the URL in the `claude-api` skill's `live-sources.md` — `.../docs/en/pricing.md` — 404s; the
working one is above, and `.../about-claude/models/overview.md` corroborates base rates):

| | base input | output | 5m cache write | 1h cache write | cache read |
|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $50 | $12.50 | $20 | **$0.25** |
| Claude Fable 5 | $10 | $50 | $12.50 | $20 | $1.00 |
| Claude Opus 5 | $5 | $25 | $6.25 | $10 | $0.50 |
| Claude Sonnet 5 | $2 | $10 | $2.50 | $4 | $0.20 |
| Claude Haiku 4.5 | $1 | $5 | $1.25 | $2 | $0.10 |

As multipliers of base input: output **5x** (uniform, every current model), 5m cache write
**1.25x**, 1h cache write **2x**, cache read **0.1x** — *except* Fable 5.1 and Mythos 5.1 at
**0.025x**, which the page states explicitly.

So:

- **`in: 1` and `out: 5` are confirmed.** Every current model prices output at exactly 5x input.
- **`cr: 0.1` is confirmed for opus-5, fable-5, sonnet-5 and haiku-4.5** — so `bug-13`'s
  sensitivity sweep of `cr` up to 1.0 was exploring a value the price list does not support.
  It is **wrong by 4x for `claude-fable-5-1`**, which is already live on this machine.
- **`cc: 1.25` is the 5-minute-TTL price, and this machine writes 1-hour caches.** Measured over
  7 days of `~/.claude/projects/*/*.jsonl` (36,136 assistant messages carrying usage,
  178.96M cache-write tokens): **99.96% carry `cache_creation.ephemeral_1h_input_tokens`**, 0.04%
  are 5m, and the 1h share is 100.00% for every model except opus-5 (99.95%). The correct
  weight for what this ledger actually records is **2.0**.
- **The 5-hour limit's own per-model weighting is not published anywhere in the API docs.**
  Neither the pricing page nor the models overview mentions subscription usage limits at all.
  The limit is a different mechanism from API billing, so a fitted opus:fable ratio is not
  required to equal the list-price ratio — it is the only available measurement of it.
- **The API list-price ratio is exactly 2.00x**, not "~2x": fable-5 over opus-5 is 2.00x on
  input, output, both cache-write tiers *and* cache reads. Against fable-5.**1**, cache reads
  invert to 0.5x. The repo's "~2x" hedge can become a checked number.
- **Correcting `cc` does not explain the 4.2x gap.** Recomputed on the same 7 days, weighted
  totals rise 10.7% (opus-5) to 14.9% (fable-5), and the opus:fable ratio of weighted-token
  totals moves only **10.184 → 9.816**, a 3.6% shift. `task-10` already refuted the
  per-request hypothesis; this refutes the weighting hypothesis with a number. Whatever the
  4.2x is, it is neither of them.
- **Nothing needs re-baselining on disk.** `computeRates` derives both the current and the
  baseline rate from the same raw ledger over trailing windows (`baselineRange`,
  `usage-rate.ts:217`); no weighted value is persisted. A uniform re-weighting moves both
  sides and leaves `weightedDeviationPct` nearly unchanged. Only in-test literals move.

## Plan

Order matters only in that step 1 is what steps 2-5 describe.

1. **Correct the weights** in `server/lib/usage-ledger.ts`.
   - `TYPE_WEIGHTS.cc` becomes `2` — the 1h cache-write multiplier.
   - Add a per-model override table beside it (suggested `MODEL_TYPE_WEIGHT_OVERRIDES`) mapping
     a model-id **prefix** to a partial `TokenCounts` of weights. One entry today, holding
     `cr: 0.025` for `claude-fable-5-1` and for `claude-mythos-5-1`.
   - Match by **longest prefix**, not exact id, and say why in a comment: dated snapshots exist
     (`claude-haiku-4-5-20251001` is live on this machine), and a bare `claude-fable-5` entry
     would otherwise swallow `claude-fable-5-1`. Both current entries are already the
     longer prefix, so the rule is a guard for the next entry rather than something live today.
   - `weightedTokens` takes an **optional** second `model` argument and applies the override
     when one matches. Absent model keeps the uniform set — document that as the
     unknown-model fallback, not as a default anyone should rely on.
   - Do **not** split `cc` into per-TTL keys in `TokenCounts` or the line codec. The ledger
     records the flat `cache_creation_input_tokens`; a fifth token type would change the
     on-disk shape and need a migration for every existing line, to distinguish 0.04% of the
     tokens. Step 3 keeps the 99.96% assumption honest instead, which is the cheaper guard.

2. **Pass the model at every call site.** All five already have it in scope, so this is
   mechanical, not a refactor:
   - `usage-rate.ts:58` (`totalWeighted`) and `:242` (`pool`) loop `Object.values(tok)` —
     switch to `Object.entries` and pass the key.
   - `usage-rate.ts:73` (`dominantModel`), `:623` (`explainSplits`) and
     `scripts/probe-usage-split.ts:209` already hold the model id.
   - `rawTokens` is unweighted by definition and does not change.

3. **Add the re-check command** — `scripts/check-token-weights.ts`, wired as
   `pnpm check:weights`. This is the deliverable idea-17 actually asked for: the constants
   become falsifiable in one command instead of re-derived by the next reader.
   - Reads transcripts under `projectsRoot()` by default, with a `--root <dir>` override so it
     is testable against a fixture, and `--days N` (default 7).
   - Dedups assistant messages by `message.id` — the same rule `sumWindow` and the recorder
     use — and accumulates per model: request count, flat `cache_creation_input_tokens`, nested
     `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, and `cache_read`.
   - Prints per model the 1h share of cache writes, the **blended** cache-write multiplier
     `(1.25·5m + 2.0·1h) / (5m + 1h)`, and the `cc` weight the code actually uses.
   - **Exits 1** when any model with **≥ 1,000,000** cache-write tokens in the window has
     `|blended − configured cc| > 0.05`, naming the model and both numbers. The floor exists
     so a model seen for one turn cannot fail the gate on noise.
   - Also prints a **warning line** (exit 0) for any model id whose family is absent from the
     override table — a new model whose cache-read multiplier nobody has checked yet. A warning,
     not a failure: a new model must not break the command that exists to audit it.
   - No new dependency; Node built-ins plus `listTranscripts` / `projectsRoot` from
     `server/lib/scan.js`, matching `probe-usage-split.ts`.

4. **Stamp the provenance** in a comment above `TYPE_WEIGHTS`: the date checked (2026-09-02),
   the source URL, that `cc` is the **1h** tier and why (the measured 99.96%), that `cr`'s
   override exists because Fable/Mythos 5.1 price cache reads at 0.025x, and
   `pnpm check:weights` as the way to re-check. Keep it to the *why* — the per-model table
   belongs in the doc, not duplicated in the comment.

5. **Rewrite the doc** — `docs/subsystems/usage-limits.md`. Five edits and the stamp:
   - §*No dollars, only ratios* (~414-421): the ratio list becomes
     `in 1 · out 5 · cache-write 2.0 (1h tier) · cache-read 0.1`; delete the "uniform across
     current models" claim, which Fable 5.1 falsifies, and replace it with the one exception
     plus the measured 1h share, the verification date, the source URL, and `pnpm check:weights`.
   - §*No rate here is comparable across models* (~437) and §*The two-term fit* (~562-570):
     drop the "~4.2x against a ~2x list-price ratio" framing on both. Say instead that the API
     list-price ratio is exactly 2.00x as of 2026-09-02, that the 5-hour limit's per-model
     weighting is **not published**, and that the weights are therefore an API-price **proxy**
     for an unknown weighting rather than a measurement of it. Add the 10.184 → 9.816 figure as
     the reason the weighting hypothesis is now closed too.
   - Add a short subsection recording idea-17's four open questions with the answers reached
     here, including: the limit's weighting is unpublished (so fitting is this repo's only
     source); `cr: 0.1` is the published value for every model in play except Fable/Mythos 5.1;
     and **`TYPE_WEIGHTS` should not become a setting** — it is a published fact with a source,
     not a preference, and a knob would let an unchecked value silently override a checked one.
     `pnpm check:weights` is the right mechanism: re-verify the fact, don't make it editable.
   - Fix the stale sentence at ~704: it says `UsageRates.tsx` "leads each row with the **raw**
     figure", which commit `9e9b77d` reversed — the card leads with the weighted rate, as §423
     of the same document already says. Two paragraphs of one file currently contradict each
     other; this is not new scope, it is the file you are already editing.
   - Add `scripts/check-token-weights.ts` to the trailing `docs-sync` `sources:` list and
     re-baseline `verified:` to the commit this task lands on.
   - Same "~2x list price" correction in the two code comments that carry it:
     `server/lib/usage-rate.ts:587` and `scripts/probe-usage-split.ts:11`.

6. **Update the two test literals the weight change invalidates** and add the new cases —
   see *Test cases*. `test/usage-rate-drift.test.ts`'s `tokFor` builds every fixture with
   `cc: 0` and `test/api-usage-rates.test.ts` is cache-read-only, so neither moves.

## Test cases

Existing, in `test/usage-ledger.test.ts` — both currently assert the old weight:

1. Line 43: `TYPE_WEIGHTS` deep-equals `{ in: 1, out: 5, cc: 2, cr: 0.1 }`.
2. Line 31: `weightedTokens(tc(1000, 100, 200, 10_000))` is **2900**, not 2750
   (`1000·1 + 100·5 + 200·2 + 10_000·0.1`).

New, per-model overrides — case 3 is the mutation check: delete the override table and it
fails, because 25_000 ≠ 100_000.

3. 1,000,000 cache-read tokens and nothing else weigh **25_000** for `claude-fable-5-1`,
   **100_000** for `claude-fable-5`, and **100_000** with no model argument.
4. `claude-mythos-5-1` also weighs those tokens at 25_000.
5. Longest-prefix matching: a dated id `claude-fable-5-1-20260701` gets 0.025, while
   `claude-fable-5` stays at 0.1 — the prefix rule must not let the shorter entry win.
6. An override touching only `cr` leaves that model's `in`/`out`/`cc` on the uniform values:
   `{ in: 1000, out: 100, cc: 200, cr: 0 }` weighs 1900 under both `claude-fable-5-1` and
   `claude-opus-5`.

New, the weights reaching the fit (`test/usage-rate-drift.test.ts` or a sibling):

7. `totalWeighted` and `dominantModel` apply per-model weights. An interval holding
   `claude-fable-5-1: { cr: 1_000_000 }` and `claude-opus-5: { in: 5_000 }` totals **30_000**
   weighted, and `dominantModel` returns **null** — fable holds 83.3%, under `DOMINANCE`.
   Under uniform weights the same interval totals 105_000 and fable holds 95.2%, so this case
   flips the verdict rather than merely moving a number.
8. The cache-write weight reaches the pooled rate: one owned interval with
   `cc: 1_000_000` for a single model and `dUtil: 1` yields `weightedPerPct` of
   **2_000_000** (was 1_250_000).

New, the gate in step 3 — tmpdir JSONL fixtures, `--root`, same pattern as the existing
ledger tests:

9. A fixture where one model's 2,000,000 cache-write tokens are 100% `ephemeral_5m`:
   `check-token-weights` exits **1** and its output names that model, its blended 1.25 and
   the configured 2.0.
10. The same fixture with 100% `ephemeral_1h`: exits **0**.
11. Evidence floor: a model with 500,000 cache-write tokens, 100% `ephemeral_5m`, does **not**
    trip the gate — exit **0**, since it is under the 1M floor.
12. An unrecognised model id (say `claude-nonesuch-9`) produces the warning line and exit **0**.
13. A transcript line whose `usage` has no nested `cache_creation` object at all (older
    format) is counted in the flat total and contributes nothing to either TTL bucket —
    it must not be read as 5m and trip the gate.

Browser:

14. In the browser (playwright MCP tools): open `http://localhost:5174`, go to **Usage** →
    **Token value**. At least one model row renders with a weighted headline rate, or the
    honest `collecting` state — not an error and not an empty body. The rates shift ~10% with
    this change; the check is that the tab still renders real rows off the re-weighted ledger.

## Done when

- `pnpm test` passes, with the case count pasted into the outcome. `pnpm typecheck` is clean.
- `pnpm check:weights` exits 0 on this machine, and its output is pasted into the outcome —
  that output is the evidence `cc: 2` is right *here*, and the record of the 1h share on the
  day it landed.
- Case 3 has been mutation-proved: with the override table deleted it fails. Confirm by
  actually deleting it, running that test, and restoring.
- `TYPE_WEIGHTS` carries the dated provenance comment with the source URL.
- `docs/subsystems/usage-limits.md` no longer claims the ratios are uniform across models, no
  longer frames 4.2x as failing to hit ~2x, answers idea-17's four open questions, has the
  ~704 raw/weighted contradiction fixed, and has its `docs-sync` block updated and re-baselined.
- **Not claimed, and must be stated as not claimed:** that the 5-hour window charges cache
  writes at 2x, cache reads at 0.1x, or output at 5x *at all*. Those are API list prices used
  as a proxy. Anthropic publishes no per-model or per-token-type weighting for the limit, so
  this task makes the proxy correct and traceable — it does not make it verified. The fitted
  per-model rates remain the only measurement of the limit's actual weighting, and
  `task-10`'s caveat that the probe has never seen a live-recorded request count still stands
  untouched by this work.

## Outcome

**2026-09-03 — done.** `TYPE_WEIGHTS.cc` is `2` (the 1h cache-write tier), Fable/Mythos 5.1
carry a `cr: 0.025` override matched by longest model-id prefix, every call site passes its
model, `pnpm check:weights` makes the tier assumption falsifiable in one command, and
`docs/subsystems/usage-limits.md` now says what the numbers are a proxy *for*.

Two departures from the plan as written, both deliberate:

- **Step 3's warning is keyed off a new `CHECKED_MODEL_PREFIXES` list, not the override
  table.** Warning on "absent from the override table" would have warned for `claude-opus-5`,
  `claude-sonnet-5` and `claude-haiku-4-5` — models that *were* priced on 2026-09-02 and
  measured to match the uniform set. The checked list is a superset of the override table;
  case 12 (`claude-nonesuch-9` warns, exit 0) passes either way. The warning is further
  suppressed for ids with no cache-write and no cache-read tokens, so Claude Code's
  `<synthetic>` placeholder — not a model anyone can price — does not warn.
- **Step 5's `verified:` re-baseline is stamped to `84519e7`, the branch HEAD before this
  work, not to the commit this task lands on** — this skill never commits, so that sha does
  not exist yet. The stamp is therefore one commit *behind* the sources it describes, which
  makes `/docs-sync` over-report drift on this doc rather than under-report it. **Needs
  re-stamping to the landing commit by whoever commits.**

Also fixed in passing, as the plan directed: the ~704 sentence claiming `UsageRates.tsx`
"leads each row with the **raw** figure", which commit `9e9b77d` had reversed.

### Verification

`pnpm typecheck` — clean, exit 0.

`pnpm test` — exit 0, 1141 cases:

```
  18/18 passed
ALL PASS
```

`pnpm check:weights` — exit 0. This output *is* the evidence `cc: 2` is right on this
machine, and the record of the 1h share on the day it landed:

```
token-weight check — last 7 day(s) under /Users/andrejajevtic/.claude/projects
  transcripts read: 333

  model                              requests    cache-write     1h share   blended cc   configured
  <synthetic>                             16              0          n/a          n/a       2.0000
  claude-fable-5                         357      1,633,641      100.00%       2.0000       2.0000
  claude-fable-5-1                        87        835,455      100.00%       2.0000       2.0000
  claude-haiku-4-5-20251001               24        215,985      100.00%       2.0000       2.0000
  claude-opus-4-8                          2         59,763      100.00%       2.0000       2.0000
  claude-opus-5                         9427     32,051,613       99.94%       1.9995       2.0000
  claude-sonnet-5                        190      1,711,296      100.00%       2.0000       2.0000

  ! claude-opus-4-8: not in CHECKED_MODEL_PREFIXES — its price ratios have never been checked, so it is being weighted with the uniform set. Price it and add the prefix.

OK — the configured weights still follow from the transcripts.
```

**Mutation proof (case 3).** With `MODEL_TYPE_WEIGHT_OVERRIDES` emptied to `{}`, the override
cases fail — five of them, across two files — and pass again once restored:

```
--- with the override table deleted ---
  ✗ weightedTokens: Fable 5.1 prices cache reads at 0.025, not 0.1
  ✗ weightedTokens: Mythos 5.1 carries the same cache-read override
  ✗ weightedTokens: longest prefix wins, so a dated 5.1 id is not read as 5
  ✗ weightsFor: the override merges into the uniform set, never replaces it
  18 passed, 4 failed
--- drift tests too ---
  ✗ totalWeighted and dominantModel apply the per-model cache-read weight
  32 passed, 1 failed
--- restored ---
  22 passed, 0 failed
```

**Browser (case 14).** Dev server on 4273/5273 in this worktree, against a copy of the live
`.usage-ledger.jsonl` / `.usage-history.jsonl` (both gitignored; the main checkout was not
touched). **Usage → Token value** renders real rows off the re-weighted ledger:
`claude-opus-5` at **247k weighted / 1%**, `+37.1% vs baseline`, `drift`, with the raw figure
as the labelled aside beneath (`≈ 1.5M raw at this model's recent mix`) — the order this task
corrected the doc to describe. The other four models render the honest `collecting` state.
No error, no empty body. The temporary dev server was stopped by PID; ports 4273/5273 clear.

### Not verified

- **That the 5-hour window charges cache writes at 2x, cache reads at 0.1x, or output at 5x
  at all.** These are API list prices standing in for a weighting Anthropic does not publish.
  This work makes the proxy correct, dated and traceable; it does not make it verified, and
  `docs/subsystems/usage-limits.md` §*What the weights are, and are not* says so in the doc.
- **The 4.2x residual remains unexplained.** `task-10` closed the per-request hypothesis;
  the 10.184 → 9.816 recompute closes the weighting one. Neither was it.
- **`task-10`'s caveat stands untouched**: the probe has never seen a live-recorded request
  count.
- **The published prices themselves were not re-fetched today.** The table in *What grooming
  already established* was priced on 2026-09-02 and is taken as given here; `pnpm check:weights`
  re-measures the *tier mix*, not the list price.
