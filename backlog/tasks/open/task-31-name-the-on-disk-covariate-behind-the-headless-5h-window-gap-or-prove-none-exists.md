---
id: task-31
title: Name the on-disk covariate behind the headless 5h-window gap, or prove none exists
created: 2026-09-23
from: idea-25
---

## Goal

idea-25 measured on the Mac (2026-09-09, 17 days) that an opus request on the `sdk-cli` surface (headless `claude -p`, orchestrator runs) spends ~1.8x more of
the 5-hour window per weighted token than one on `claude-desktop`. Token composition, speed, tier and cache TTL were identical on both sides. Until the gap is
named, every per-model rate on the Token-value card blends two prices.

This task runs the investigation that costs **no** window: everything the transcripts, `.usage-history.jsonl` and `.usage-ledger.jsonl` already hold. It ends
in exactly one of three recorded outcomes:

1. **Artefact.** Re-measured on post-bug-22 data (nested subagent transcripts included), the gap is under 1.3x. idea-25's premise was an undercount.
2. **Named.** One on-disk covariate explains at least half of the gap (the explained-share test below). The covariate and its table go into the doc.
3. **Not on disk.** No covariate reaches 0.5. The doc says so with the evidence table. A follow-up item is filed for the controlled burn / request-counting
   proxy, which spends real window and needs a human's go-ahead (idea-25 hypotheses 1 and 2).

Either way, `docs/subsystems/usage-limits.md` stops pointing at "its own item (idea-25)" and states what is now known.

## Plan

Behaviour and exact cases below, not code. The implementer writes the code and may disagree with any shape here, provided the recorded outcome and the test
cases still hold. Size is a soft target, not a budget.

### Facts measured while grooming (2026-09-23, on the WSL box)

These change how the task must run. They are not assumptions to design around. Re-check them first.

- **This machine has no `claude-desktop` transcripts.** Its entrypoints are `sdk-cli` (~11.4k lines) and `cli` (~2.6k lines). The interactive surface here
  is the terminal `cli`. So on this box the comparison is `cli` vs `sdk-cli`, not desktop vs headless. `sessionSurface` in `scan.ts` already classes both
  `cli` and `claude-desktop` as interactive. Keep the table keyed by raw entrypoint anyway, so a desktop row and a cli row never merge silently.
- **This machine's opus-5 headless rate is ~55k weighted per 1% (current window), against ~255k on the Mac.** `npx tsx scripts/rates-audit.ts surfaces` gave
  66k baseline and 55k current, over 12 and 25 bins. The 5-hour window is account-wide. Spend from the other machine and from claude.ai chat raises
  utilization with no local transcript. So a single machine's rate is a lower bound polluted by foreign spend. **Foreign spend is hypothesis 0 and it is
  tested first**, before anything in idea-25's list.
- **`permissionMode` is on `user` lines only** (the prompt lines), never on assistant records. On this box `sdk-cli` sessions ran `auto` 70, `default` 17,
  `acceptEdits` 5 (user-line counts, 14 days). The orchestrator dispatches `claude -p ... --permission-mode auto`. Auto mode makes a classifier request per
  tool call, and that request is written to no transcript. That makes it the strongest off-transcript candidate. The on-disk half of the test is the
  permission-mode stratum below. The request-counting half is the follow-up.
- Opus model ids now include `claude-opus-5-5` (~500 sdk-cli records) beside `claude-opus-5`. `--model` defaults to `claude-opus-5`. Run both.

### Step 1: a `gap` subcommand in `scripts/rates-audit.ts`

Add a fifth subcommand, `gap`, beside `ledger | surfaces | modifiers | offbook`. It is report-only (exit 0). It takes the same `--root`, `--dir`, `--model` and
`--tz` flags. `--root` becomes repeatable: several transcript roots are walked as one corpus. This lets a copied Mac `~/.claude/projects` join this box's.
Transcript ids are UUIDs, so a record seen under two roots counts once (dedupe on the assistant message id the rebuild already keys on).

Pipeline: reuse the `surfaces` rebuild unchanged (`walkTranscripts`, `readRecords`, `rebuildLedger`, `joinIntervals`, `mergeBins`, `modelDominates`). Only
opus-dominant bins count, over the full `BASELINE_MS` range. Then label each bin with covariates, stratify, and print.

Put the pure pieces in `scripts/lib/transcript-audit.ts`, next to `surfaceLabel`, so they are unit-testable:

- **`AuditRecord` gains `session`** (the top-level session id: a nested subagent file resolves to its parent session) **and `permissionMode`**. The mode is
  the mode of the latest `user` line carrying `permissionMode` at or before the record's `ts`, in the same session. A nested record uses its own file's user
  lines first, then its parent session's. No preceding mode gives `''`.
- **`binCovariates(records)`** takes the bin's records for the model and returns, or `null` for no records:
  - `surface`: `surfaceLabel` over entrypoint weights (existing).
  - `mode`: the permission mode holding `SURFACE_DOMINANCE` (0.8) of the bin's weight, else `'mixed'`. `''` shows as `'(none)'`.
  - `concurrency`: distinct `session` values, banded `'1' | '2' | '3+'`.
  - `nestedShare`: nested weight over total weight, banded `'<25%' | '25-50%' | '>=50%'`.
  - `utilBand`: utilization of the sample the bin starts from. `Bin` gains `fromUtil`, taken from the first merged interval. Banded `'<80' | '80-94' | '>=95'`.
    This is idea-25 hypothesis 3.
  - `offbook`: whether any `isApiError` record or usage-less assistant line of the bin's sessions falls inside the bin. `'clean' | 'errors'`. This is the
    on-disk half of hypothesis 1: retries and 529s.
- **`stratify(bins, covariate)`** gives `(surface, level) -> Acc`, using the existing `Acc` / `addBin` / Σutil-suppression convention.
- **`explainedShare(interactive, headless, covariate)`** reads the per-level tables for the two surfaces. `rI(l)` is the interactive weighted-per-1% in
  level `l`. `wH(l)` is the headless weight in `l`. The covariate-predicted headless rate is `R* = Σ wH(l) / Σ (wH(l) / rI(l))`, over levels where both
  sides have data: headless tokens priced at interactive per-level rates. The share is `(rI_pooled − R*) / (rI_pooled − rH_pooled)`. It returns `null` when
  the levels that have both sides hold under `SURFACE_COVERAGE_MIN` (0.8) of headless weight. It also returns `null` when the pooled gap is under 1.3x (a
  zero or tiny denominator).

Print, per `--model`:

1. **The gap itself, re-measured.** Interactive and headless pooled w/1%, their ratio, and bins per side. Interactive means every entrypoint `sessionSurface`
   classes interactive. Say in one line which raw entrypoints went into each side.
2. **Hypothesis 0, foreign spend.** Σ dUtil of `external` intervals (utilization rose, local weight < `EXTERNAL_WEIGHTED_MAX`) as a share of all Σ dUtil,
   per surface-period (reuse `period()`). Also, per surface, the share of that surface's bins that have an `external` interval within 30 min on either
   side. Headless bins sitting near foreign spend far more often than interactive ones is the signature of foreign spend hidden inside priced bins. That
   cannot be split out on one machine. The line after the table says so, and names `--root` as the way to join the other machine.
3. **One stratified table per covariate** (mode, concurrency, nestedShare, utilBand, offbook): rows `surface × level` with the existing columns, then that
   covariate's `explainedShare` on its own line.
4. **Verdict line**: `artefact` (gap < 1.3x) | `named: <covariate> (<share>)` (the highest share ≥ 0.5) | `not on disk (best: <covariate> <share>)`.

Wire `pnpm audit:rates -- gap`. There is no new package script. Add the subcommand to the file's header comment.

### Step 2: run it and record the outcome

Run `npx tsx scripts/rates-audit.ts gap --model claude-opus-5` and again with `--model claude-opus-5-5`, on this box's data. Paste both outputs into
`## Outcome`. If the dispatching prompt names a second transcript root (a copy of the Mac's `~/.claude/projects`), run once more with both `--root`s.
Otherwise skip that run. Record in the Outcome whether it happened. Do **not** copy or fetch data from another machine yourself.

Interpret by the rules above, not by eye. Then:

- **`docs/subsystems/usage-limits.md`**: replace the sentence "Why a headless token costs more window is its own item (idea-25)." with a short `####` subsection
  under the drift section, titled for what was found. It states the re-measured gap and which machine and data it came from. It states the foreign-spend
  caveat: a per-machine rate is a lower bound whenever another machine or claude.ai shares the account. It gives the verdict and the best covariate's share.
  Add `gap` to the `pnpm audit:rates` sentence near "`surfaces` splits each window's rate". Wrap new prose at 160 columns and do not reflow existing lines.
- **If the verdict is `not on disk`**, file one idea with `/backlog-capture`: "Count the requests a headless run makes that no transcript records". It is
  idea-25's hypotheses 1 and 2: a logging proxy via `ANTHROPIC_BASE_URL` (the usage read in `lib/usage.ts` must keep hitting api.anthropic.com), and an
  auto-vs-acceptEdits `claude -p` A/B on one fixed prompt. It spends real window, so it stays an idea for a human to schedule. Name it in the Outcome.
- **If the verdict is `named`**, file nothing new. The Outcome says whether the covariate points at the recorder or at the orchestrator (idea-25's third
  open question), and the Outcome is the place to argue it.

### Out of scope

Any change to `server/`, the card, or `mixAdjustedDeviation`. idea-25's last open question, whether the card should refuse a pooled rate, waits on this
task's verdict. Spending window on a controlled burn is also out of scope.

## Test cases

In `test/rates-audit.test.ts`, with tmpdir JSONL fixtures in that file's existing style. Weights below are weighted tokens. Build fixtures so
`recordWeighted` yields them, or test the pure functions on pre-weighted inputs. The implementer picks one and says which.

- **Mode inheritance.** In one session, a user line with mode `auto` at t=0, an assistant record at t=10, a user line with mode `default` at t=20, and an
  assistant record at t=30. The records get `auto` and `default`. An assistant record at t=-5, before any mode line, gets `''`.
- **Nested falls back to the parent.** A subagent file under `<session>/subagents/` with no user line carrying a mode inherits the parent session's mode at
  its record's `ts`. Its `session` is the parent's id. A subagent file that has its own mode line uses its own.
- **Mode dominance.** A bin with records of weight 900 (`auto`) and 100 (`default`) gives mode `auto`. With 700 / 300 it gives `mixed`. With 850 (`''`) and
  150 (`auto`) it gives `(none)`.
- **Concurrency counts sessions, not files.** A top-level record and a nested record of session A, plus one record of session B, give `concurrency` `'2'`.
  Three sessions give `'3+'`.
- **utilBand from the first interval.** A bin merged from intervals starting at util 96 then 97 gives `'>=95'`. A bin starting at util 94 gives `'80-94'`.
  One starting at 79 gives `'<80'`.
- **`explainedShare`, a fully explaining covariate: exactly `1`.** Interactive: level a has weight 400k over 1 util, level b has 100k over 1 (pooled 250k).
  Headless: level a has 200k over 0.5, level b has 400k over 4 (pooled 133.3k). `R*` = 600k / (200k/400k + 400k/100k) = 133.3k, so the share is 1.
- **`explainedShare`, a covariate with no effect: exactly `0`.** Interactive: a has 400k / 1, b has 400k / 1 (400k). Headless: a has 200k / 1, b has
  600k / 3 (200k). `R*` = 400k, so the share is 0.
- **`explainedShare` coverage guard: `null`.** Same as the no-effect case, plus headless level c with 350k / 1 and no interactive level c. Covered
  headless weight is 800k / 1150k = 0.70 < 0.8.
- **`explainedShare` gap guard: `null`.** Interactive pooled 260k, headless pooled 220k, ratio 1.18 < 1.3.
- **Repeatable `--root` dedupes.** The same transcript placed under two roots counts its record once. The `gap` header's record count equals the
  single-root count.
- **Verdict mapping.** Gap 1.2x gives `artefact`. Shares {mode 0.62, concurrency 0.3} give `named: mode (0.62)`. Shares {mode 0.41, utilBand null} give
  `not on disk (best: mode 0.41)`. All shares null gives `not on disk (best: none)`.
- **Existing subcommands unchanged.** The current `rates-audit.test.ts` cases still pass unedited. `surfaces` output on the fixture is byte-identical
  before and after. Capture it before touching the file.

## Done when

- `pnpm test` and `pnpm typecheck` pass. Paste the case count and the tail of each output.
- `npx tsx scripts/rates-audit.ts gap --model claude-opus-5` and `... --model claude-opus-5-5` both run to exit 0 on this machine's real data. Both outputs
  are pasted in `## Outcome` with the verdict line quoted.
- `docs/subsystems/usage-limits.md` no longer says "its own item (idea-25)". It carries the finding subsection and the `gap` mention.
- On `not on disk`, the follow-up idea exists and its id is in the Outcome.
- The Outcome has a **Not verified** line. At minimum: the Mac/desktop comparison, unless a joined `--root` run happened; and every off-transcript
  hypothesis (auto-mode classifier requests, SDK retries, claude.ai chat spend), which on-disk data cannot confirm or refute.
