---
id: task-25
title: Consolidate the rate-audit probes into scripts/rates-audit.ts with a check:ledger gate
created: 2026-09-09
tags: usage, rates, scripts
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
