---
id: task-25
title: Consolidate the rate-audit probes into scripts/rates-audit.ts with a check:ledger gate
created: 2026-09-09
tags: usage, rates, scripts
updated: 2026-09-23T10:07:47Z
started: 2026-09-23T09:53:01Z
execute-elapsed: 886
execute-tokens: 153760
---

## Goal

One script, `scripts/rates-audit.ts`, run via `tsx`, that re-derives the Token-value
card's inputs **from the transcripts directly** — a data path independent of
`.usage-ledger.jsonl` — so the recorder and the card can be audited the way
`pnpm check:weights` audits `TYPE_WEIGHTS`. Four subcommands:

| subcommand | question it answers | pass/fail? |
|---|---|---|
| `ledger` | does the ledger hold what the account spent? (bug-22's regression check) | yes — `pnpm check:ledger` |
| `surfaces` | is a `drift` badge a repricing or a desktop↔headless mix shift? (bug-23's control) | report only |
| `modifiers` | did anything about the *requests* change — speed, tier, effort, >200k context? | report only |
| `offbook` | is there spend with no usage record — API errors, usage-less lines, compactions? (idea-25) | report only |

Replaces the 2026-09-09 scratchpad probes (`disk-sum.mjs`, `surface.mts`,
`modifiers.mjs` + `ctx-premium.mjs`, `offbook.mjs`) which found bug-22/bug-23/idea-25 and
were ~60% copy-pasted pipeline. They are session-ephemeral; this task is the durable form.
Prior art for shape and exit convention: `scripts/check-token-weights.ts`,
`scripts/probe-usage-split.ts`.

## Plan

Behaviour and exact cases below, not code — implementer decides the code. Target size
soft, ~400 lines including the pipeline; if the four subcommands pull it well past that,
split the shared pipeline into `scripts/lib/transcript-audit.ts` rather than trimming
what each report prints.

**1. Shared pipeline (one function each, so bug-22's fix swaps one line).**

- *Walk:* `projectsRoot()` recursively for `*.jsonl` with mtime ≥ `since` (default
  `now − BASELINE_MS`), tagging each file `nested` when its path is deeper than
  `<projectDir>/<file>`. Must **not** use `listTranscripts` from `scan.ts` — it is one
  level deep and is bug-22's cause; once bug-22 ships a ledger-side enumerator that
  includes `subagents/`, the walk delegates to it.
- *Records:* assistant lines with `message.usage`, a string `message.model`, a parseable
  `timestamp`; deduped **globally** on `message.id` (lines without an id are kept as-is).
  Carry `ts, model, tok{in,out,cc,cr}, entrypoint, effort, nested, usage.speed,
  usage.service_tier, isApiErrorMessage, stop_reason`.
- *Weights:* always `weightedTokens(tok, model)` from `usage-ledger.ts`. Never an inline
  `{1, 5, 2, 0.1}` — the scratchpad `disk-sum.mjs` did that and mis-weighted Fable's
  0.025 cache-read.
- *Rebuild:* a synthetic `LedgerLine[]` on the **real** ledger's tick boundaries
  (`readLedgerSince(since)`, sorted), each record assigned to the tick with
  `prevT < ts ≤ t`, records outside every tick counted and reported, never silently
  dropped. Then `joinIntervals(samples, synthetic, ledgerStartMs())` with
  `readRecentSamples(undefined, <the rates byte budget>)`. `RATES_HISTORY_BYTES` lives in
  `server/api.ts`, which drags the whole server graph in on import — either move the
  constant next to `TAIL_BYTES` in `usage-history.ts` and import it from both places, or
  take a literal with a comment naming the constant it mirrors. Groom picks; the tests
  below assume the former.
- *Bins:* priced (`!isUnpriced`), non-`external` intervals sorted by `toT`, merged while
  contiguous (`fromT === previous.toT`) and the merged span ≤ 30 min. A bin is
  model-dominant when the model's weighted share ≥ `DOMINANCE`; surface-dominant when one
  `entrypoint` holds ≥ 80% of the model's weighted tokens, else `mixed-surface`.

**2. `ledger`** — per UTC day × model, last N complete days (`--days`, default 7): disk
weighted (top / nested / total), recorded weighted (sum of `LedgerLine.tok` by the line's
`t`), ratio. Gate: every (day, model) with disk weighted ≥ 5M must have
`0.95 ≤ ratio ≤ 1.05`; a low ratio is the blind spot, a high one is double counting.
Exit 1 naming each failing row; exit 0 otherwise; rows under the floor print but do not
gate. Until bug-22 lands this **fails on live data by design** — the PR says so and does
not lower the threshold.

**3. `surfaces`** — `--model` (default `claude-opus-5`), `--tz` (default the process's
resolved zone). Per window (`baselineRange` / `currentRange`) × dominant surface: bins,
Σutil, weighted/1%, weighted/request, cache-write / cache-read / output shares of
weighted, cache-write and cache-read per request. Then the pooled row and the real
`driftRow` for the same model beside it. Then the cross-tab surface ×
{weekday 08–20 local, weekday night, weekend} over the full range. Rows with Σutil < 3
are suppressed with a count of how many were.

**4. `modifiers`** — per UTC day for `--model`: weighted share by `usage.speed`,
`usage.service_tier`, record `effort`; share of weighted tokens in requests whose
`in + cc + cr > 200 000`; mean context per request; mean output per request. Never
stringify `usage.iterations` — the scratchpad version printed 3.9 MB doing that.

**5. `offbook`** — per `entrypoint`: distinct sessions, assistant lines, lines without
`usage`, `isApiErrorMessage` count with the five commonest error prefixes, `stop_reason`
distribution, record `type` distribution, and compaction markers — the scratchpad probe
looked for `isCompactSummary` / `compactMetadata` and found **zero** on 30 days of
transcripts, so first find what a compaction actually writes on the current CLI (grep a
transcript known to have compacted) and count that.

**6. Wiring.** `package.json`: `check:ledger` → `tsx scripts/rates-audit.ts ledger`;
`audit:rates` → `tsx scripts/rates-audit.ts` (subcommand after `--`). `docs/overview.md`:
one row beside the `check-token-weights.ts` row (~line 238). `docs/subsystems/usage-limits.md`,
Token-value section: one sentence naming `pnpm check:ledger` as the recorder's audit and
`audit:rates surfaces` as the first thing to run when the badge says `drift`.
`probe-usage-split.ts --reconstruct` has its own transcript replay; note the overlap in
its header, do not refactor it here.

## Test cases

`test/rates-audit.test.ts`, node assert, tmpdir fixtures, the pipeline functions imported
directly (no subprocess except the gate's exit code):

- **walk:** root with `<proj>/s1.jsonl`, `<proj>/s1/subagents/agent-1.jsonl`,
  `<proj>/notes.json` → exactly the two `.jsonl` returned, the agent file `nested: true`;
  a file with mtime older than `since` excluded.
- **dedupe:** two lines sharing `message.id` → one record; two lines with no id → two.
- **rebuild:** ticks `(0, 60 s]`, `(60 s, 120 s]`; a record at exactly 60 s lands in the
  first, at 60.001 s in the second, at −1 s in neither and `outsideTick === 1`.
- **weights:** a `claude-fable-5-1` record with 1 000 000 cache-read tokens contributes
  25 000 weighted, not 100 000 (mutation: an inline `0.1` fails this).
- **gate:** one day/model with disk 100M and ledger 90M → exit 1 and the row named;
  ledger 96M → exit 0; disk 2M / ledger 0 → printed, not gated; ledger 110M → exit 1.
- **bins:** three contiguous 10-min intervals → one bin; a fourth contiguous one taking
  the span to 40 min → starts a second bin; a non-contiguous third → two bins.
- **surface label:** 85 % `claude-desktop` by weighted share → `claude-desktop`; 70/30 →
  `mixed-surface`.
- **modifiers:** a day with two records, `speed: "fast"` carrying 3M weighted and
  `"standard"` carrying 1M → `fast=75.0%`.
- **Live smoke (Verification section, not a unit test):** `audit:rates surfaces` on real
  logs reproduces bug-23's figures while its windows are still inside the 17-day horizon
  (desktop ≈ 460k, `sdk-cli` ≈ 250k weighted/1%; after ~2026-09-26 the check is only that
  it runs); `check:ledger` on real logs exits 1 with sonnet-5 named on 2026-09-08 if that
  day is still in range.

## Done when

- `pnpm check:ledger` and `pnpm audit:rates -- <sub>` each run against live data in under
  ~3 minutes on ~2 000 transcripts; the gate's current live verdict (expected: fail until
  bug-22) is recorded in the PR with output.
- `pnpm test` and `pnpm typecheck` green — command output in the PR, not a claim.
- `docs/overview.md` row and the `usage-limits.md` pointer in place; nothing under `docs/`
  copies the scratchpad scripts.
- The four scratchpad probes are not referenced anywhere in the repo.

## Outcome

2026-09-23 — `scripts/rates-audit.ts` (CLI, four subcommands) and `scripts/lib/transcript-audit.ts` (walk / records / rebuild / bins / report pipeline, pure
except the file reads) are in. Wiring: `pnpm check:ledger` and `pnpm audit:rates -- <sub>`. `RATES_HISTORY_BYTES` moved from `server/api.ts` to sit beside
`TAIL_BYTES` in `server/lib/usage-history.ts`; api.ts imports it from there. Row in `docs/overview.md`, pointer paragraph in `usage-limits.md`'s Token-value
section, overlap note in `probe-usage-split.ts`'s header. 9 cases in `test/rates-audit.test.ts`.

Deviations from the plan, on purpose:

- **The walk delegates to `listUsageTranscripts`** (bug-22 already shipped it), so it is not a separate recursive walk. `nested` is `parentId !== null`.
- **`ledger` prints an extra `in-ticks` column**: the disk weight that fell inside some real ledger tick. It does not change the gate. It separates recorder
  downtime (low against disk, fine against in-ticks) from a real blind spot (low against both).
- **Compaction markers**: the current CLI writes `type: "system", subtype: "compact_boundary"` lines carrying `compactMetadata.trigger` (`auto` / `manual`),
  followed by a user line with `isCompactSummary: true`. Both show up on 30 days of logs (35 boundaries, 35 summaries). `offbook` counts both, boundaries split
  by trigger. The scratchpad's "zero" was wrong.
- `effort` is read from the record's top-level `effort` field. That is where the current CLI writes it.

Live verdicts (ledger in the main checkout, so `--dir` points there; the worktree has none):

```
$ npx tsx scripts/rates-audit.ts ledger --dir <main>        # 5.3 s wall, 329 transcripts
  2026-09-16  claude-opus-5     38.23M  2.83M  41.06M  in-ticks 41.06M  recorded 38.56M  0.939
  2026-09-17  claude-opus-5     24.29M  0.34M  24.63M  in-ticks 22.35M  recorded 20.90M  0.849
  2026-09-18  claude-opus-5     47.60M 12.02M  59.62M  in-ticks 59.62M  recorded 56.15M  0.942
  2026-09-18  claude-sonnet-5    0.17M 51.28M  51.44M  in-ticks 51.44M  recorded 51.34M  0.998
  2026-09-22  claude-opus-5-5   11.11M  0.00M  11.11M  in-ticks 11.11M  recorded 10.43M  0.938
  ...
FAIL (6) — the ledger does not hold what the transcripts spent        (exit 1)
```

The gate fails on live data, as the plan predicted, but not for the predicted reason. 2026-09-08 has aged out of the 7-day range, so the sonnet-5 row the plan
expected is not there. Post-bug-22, sonnet-5 reconciles (0.997–0.998). claude-opus-5 and opus-5-5 still record 0.85–0.96 of disk, and fable-5-1 records
0.62–0.84 (under the floor). **In-ticks ≈ disk on those rows, so the shortfall is a blind spot, not downtime.** This is a new finding and was not diagnosed
here. One hypothesis, unverified: a record's `timestamp` precedes the moment its bytes reach disk, and when that lag crosses a tick, `sumWindow` drops the
event as `ts ≤ prevT` on the next read. The threshold was not lowered.

```
$ npx tsx scripts/rates-audit.ts surfaces --dir <main>      # 10.7 s wall, 1291 transcripts, 65284 records
  baseline  sdk-cli  98 bins Σutil 630  295k/1%  ·  claude-desktop  82 bins Σutil 167  458k/1%  ·  pooled 327k/1%
  real       baseline 235k/1%  current 285k/1%  pooled +21.1%  mix-adjusted -  verdict drift
  rebuilt    baseline 293k/1%  current 298k/1%  pooled +1.6%  mix-adjusted -13.9%  verdict stable
```

The bug-23 split reproduces: desktop 458k against ≈460k. sdk-cli comes out at 295k against ≈250k. The baseline window has moved since bug-23 was measured, and
a rebuild from disk includes the nested tokens the old ledger never saw, which would push headless higher. That reasoning is unverified. The real ledger
reads `drift`. The same fit on the rebuilt ledger reads `stable`, which is consistent with the ledger shortfall above. `modifiers` ran in 5.6 s and `offbook
--days 30` in 16.4 s (2229 transcripts). All four are under the ~3 min budget.

Verification:

```
$ pnpm typecheck
> tsc --noEmit                                   (exit 0)
$ pnpm test
=== rates-audit.ts (transcript audit) ===
  ✓ walk … ✓ dedupe … ✓ rebuild … ✓ weights … ✓ gate … ✓ gate (CLI) … ✓ bins … ✓ surface label … ✓ modifiers
  9 passed, 0 failed
...
ALL PASS                                         (exit 0, 1656 ✓)
```

`pnpm test` needs `client/dist`. On the first run in this worktree, `api-usage-rates` "a near-miss path is not the rates endpoint" failed with "it falls
through to the static handler", because a fresh worktree has no build. After `pnpm build`, everything passed. The failure is environmental; nothing in this
diff caused it.

Contract sweep: 1 sites updated (server/api.ts — `RATES_HISTORY_BYTES` now imported from `lib/usage-history.ts`; no doc, test or comment named its old home).
The scratchpad probe names (`disk-sum.mjs`, `surface.mts`, `modifiers.mjs`, `ctx-premium.mjs`, `offbook.mjs`) survive only in backlog records: this item and
the done bug-22 / bug-23 files. They are left as history on purpose. Nothing under `docs/`, `scripts/` or `server/` names them.
Red proof: 13 tests went red with the change reverted (13 production mutations, each run against `test/rates-audit.test.ts` alone and each failing at least
one case: walk nested flag, global dedupe, tick edge `<`→`<=`, outside-tick count, inline `0.1` weights, gate min 0.95→0.85, gate max 1.05→1.15, gate floor
removed, bin span cap removed, bin contiguity removed, surface dominance 0.8→0.6, modifier share by count instead of weight, CLI `return 1`→`0`). The
contiguity mutant initially survived because the gap fixture also broke the 30-min span. The fixture was tightened to `iv(21, 25)` and the mutant then failed.
