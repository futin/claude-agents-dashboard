---
id: task-8
title: Per-model token rates and drift detection
created: 2026-08-28
from: idea-10
---

## Goal

Measure, per model, how many tokens one percent of the 5-hour usage window costs
("1% of Opus ≈ 900k tokens"), and detect when that exchange rate drifts over time —
so model choice can be planned against reality instead of anecdote. Spec:
`docs/superpowers/specs/2026-08-28-model-token-rates-design.md`.

## Plan

> **Override (deliberate, per project rules):** this plan specifies behaviour,
> signatures, and exact test cases — **never literal code blocks**. The implementer
> writes the code and is free to disagree with structure below if behaviour is kept.
> Executor: work on a feature branch (`feat/usage-model-rates`); code changes go
> through a PR per the repo's PR rules. Register every new test file in
> `test/run-all.ts`. Read `docs/subsystems/usage-limits.md` and `docs/overview.md`
> §Map before starting. Each task ends green: `pnpm test` and `pnpm typecheck`.

### Global constants (one source of truth, exported)

Type-weight ratios (unitless, from API pricing ratios, model-independent):
`in: 1`, `out: 5`, `cc: 1.25` (cache write), `cr: 0.1` (cache read).
Classifier: `DOMINANCE = 0.9`, `IDLE_EPS = 0.01` (pct, matches `shouldWrite`),
`EXTERNAL_WEIGHTED_MAX = 5_000`, `LEDGER_COVERAGE_MIN = 0.8`.
Drift: baseline window `[now−17d, now−3d)`, current `[now−3d, now]`,
`DRIFT_PCT = 20`, `RAW_SHIFT_PCT = 25`, floors `MIN_INTERVALS_BASELINE = 30`,
`MIN_UTIL_BASELINE = 15` (cumulative pct points), `MIN_INTERVALS_CURRENT = 10`,
`MIN_UTIL_CURRENT = 5`.

### Task 1 — ledger data model + weighting (pure core)

Files: create `server/lib/usage-ledger.ts`; test `test/usage-ledger.test.ts`.

Produces (later tasks consume): `TokenCounts {in, out, cc, cr}` (numbers);
`LedgerLine {t: number, prevT: number, tok: Record<string, TokenCounts>}`;
`weightedTokens(tok: TokenCounts): number`; `rawTokens(tok: TokenCounts): number`;
`sumWindow(events: UsageEvent[], prevT: number, t: number): Record<string, TokenCounts>`
where `UsageEvent {ts: number, model: string, tok: TokenCounts}`;
`parseLedgerLine(line: string): LedgerLine | null`; `serializeLedgerLine(l): string`.

TDD steps: write failing tests for the cases below, see them fail, implement
minimally, see them pass, commit (`feat(usage): ledger data model and type weights`).

Test cases (exact expected values):
1. `weightedTokens({in:1000, out:100, cc:200, cr:10000})` = **2750**
   (1000·1 + 100·5 + 200·1.25 + 10000·0.1).
2. `weightedTokens({in:0,out:0,cc:0,cr:0})` = 0; `rawTokens` of case 1 = **11300**.
3. `sumWindow` half-open boundary `(prevT, t]` with prevT=1000, t=61000: event at
   ts=1000 excluded, ts=1001 included, ts=61000 included, ts=61001 excluded.
4. `sumWindow` groups by model: two events model "opus-5", one "fable-5" → two keys,
   per-type sums exact; event with empty/missing model string skipped.
5. `parseLedgerLine(serializeLedgerLine(x))` round-trips x exactly.
6. `parseLedgerLine` returns null for: non-JSON, missing `t`, missing `tok`,
   `tok` not an object.

### Task 2 — ledger recorder I/O + wiring

Files: modify `server/lib/usage-ledger.ts` (I/O half), `server/lib/usage.ts`
(one call site), `.gitignore` (+`.usage-ledger.jsonl`); test `test/usage-ledger-io.test.ts`.

Produces: `LEDGER_FILE = '.usage-ledger.jsonl'` (repo root, sibling of
`.usage-history.jsonl`); `recordLedgerTick(opts?: {dir?: string, root?: string,
nowMs?: number}): void` (dir = ledger location, root = transcripts root, both
test-injectable, defaulting to `repoRoot()` / `projectsRoot()` from scan.ts);
`readLedgerSince(sinceMs: number, dir?: string): LedgerLine[]`.

Behaviour: keeps a RAM map of per-file byte offsets over `listTranscripts(root)`
files; each tick reads only bytes past the stored offset of files whose size grew,
parses assistant-message lines (`message.usage`, `message.model`, `timestamp` —
mirror the conventions of `server/lib/analyze.ts:146`), sums them with `sumWindow`
over `(prevTickMs, nowMs]`, appends one serialized line **every tick** (empty `tok`
= measured zero — that is data, distinguishing "no local tokens" from "not
recording"). First tick after process start only initializes offsets and appends
nothing. Truncated/rotated file (size < offset) → reset that offset to 0. All
writes best-effort (swallow errors) like `appendSample`. Internally no-ops when
`getSettings().recordUsageHistory` is false. Call site: invoke `recordLedgerTick()`
immediately beside the existing `recordTick` call in `usage.ts` (the fetch-success
path), so ledger lines align with history sample times.

TDD steps: failing tests on a tmpdir fake projects root (helper writes JSONL
transcripts) → implement → pass → commit
(`feat(usage): per-minute token ledger recorder`).

Test cases:
1. First tick: no ledger file created (or unchanged), offsets initialized.
2. Append two assistant lines (models "opus-5", "fable-5") to the transcript, tick:
   ledger gains exactly one line; per-model per-type sums equal the fixture values;
   `prevT`/`t` equal the injected tick times.
3. Tick with no new transcript bytes: appends a line with `tok: {}`.
4. Truncate the transcript below the stored offset, add one line, tick: no throw,
   the new line's tokens are counted once.
5. Junk lines (bad JSON, user messages, missing usage) interleaved: skipped, valid
   sums unaffected.
6. `recordUsageHistory` off (via `setSettings`): tick appends nothing.
7. `readLedgerSince(t0)`: returns only lines with `t >= t0`, oldest first; junk
   lines in the file are skipped.

### Task 3 — interval join + classification (pure)

Files: create `server/lib/usage-rate.ts`; modify `server/lib/usage-history.ts`
(export `sameWindow`); test `test/usage-rate-classify.test.ts`.

Produces: `Interval {fromT, toT, dUtil, tok: Record<string, TokenCounts>,
kind: 'idle' | 'external' | 'mixed' | 'gap' | {model: string}}`;
`joinIntervals(samples: UsageSample[], ledger: LedgerLine[]): Interval[]`.

Behaviour: consecutive sample pairs form an interval only when `sameWindow(resetsAt)`
holds and `dUtil >= 0`; window change or drop breaks the chain (interval discarded).
History samples are write-on-change compressed, so one interval may span several
ledger lines: sum every ledger line with `prevT >= from.t && t <= to.t`; if summed
ledger line spans cover < `LEDGER_COVERAGE_MIN` of the interval's duration → kind
`gap` (server was down; never bridge silently). Classification of covered intervals:
`dUtil <= IDLE_EPS` → `idle`; else total weighted tokens < `EXTERNAL_WEIGHTED_MAX`
→ `external`; else the model holding ≥ `DOMINANCE` share of weighted tokens →
`{model}`; else `mixed`.

TDD: failing tests → implement → pass → commit
(`feat(usage): interval join and classification`).

Test cases:
1. Samples (t=0,u=10,R1), (t=60000,u=12,R1), (t=120000,u=5,R2) with full ledger
   coverage: first interval dUtil=2; second discarded (window change R1→R2).
2. Drop within one window (u 12→11, same R): interval discarded.
3. `resetsAt` strings 90s apart: same window (slack honored); 3 min apart: break.
4. Two samples 5 min apart with five 1-min ledger lines: `tok` sums all five;
   with only two of five lines present: kind `gap`.
5. Δu=0.005 → `idle`. Δu=0.5 with weighted total 4_999 → `external`; 5_000 → not
   external (proceeds to dominance).
6. Model A weighted 9100 of 10000 total (share 0.91) → `{model:'A'}`;
   A 8900 of 10000 (0.89) → `mixed`.

### Task 4 — rates, baseline, drift verdicts (pure)

Files: modify `server/lib/usage-rate.ts`; test `test/usage-rate-drift.test.ts`.

Produces: `ModelRate {weightedPerPct, rawPerPct, intervals, utilSum} | null`
(null under floors); `rateFor(intervals: Interval[], model: string, sinceMs,
untilMs, floors): ModelRate | null` — pooled ratio Σweighted/ΣdUtil and Σraw/ΣdUtil
over that model's clean intervals in `[sinceMs, untilMs)`;
`driftRow(intervals, model, nowMs): {model, rawPerPct, weightedPerPct,
baselineWeightedPerPct, baselineRawPerPct, deviationPct, verdict, intervals,
utilSum}` with verdict `'thin' | 'stable' | 'drift' | 'mix-shift'`;
`externalShare(intervals, sinceMs, untilMs): number | null` = Σ dUtil(external) /
Σ dUtil(external+clean+mixed), null when denominator is 0.

Verdict logic: current under current-floors → `thin` (baseline fields still
reported when baseline meets its floors). Baseline under baseline-floors →
`thin`. |weighted deviation| > `DRIFT_PCT` → `drift`. Else |raw deviation| >
`RAW_SHIFT_PCT` → `mix-shift`. Else `stable`. Deviation = (current − baseline) /
baseline · 100, sign preserved.

Note: pooled Σ/Σ (not median of per-window rates) is the deliberate estimator —
floors make it robust and the arithmetic is exactly testable; the spec has been
aligned to this.

TDD: failing tests → implement → pass → commit
(`feat(usage): per-model rates and drift verdicts`).

Test cases:
1. Two clean intervals for model A (dUtil=2, weighted 1_000_000, raw 10_000_000)
   and (dUtil=3, weighted 2_000_000, raw 20_000_000): weightedPerPct = **600_000**,
   rawPerPct = **6_000_000**, utilSum = 5.
2. Floors: 29 intervals × dUtil 1 (utilSum 29 ≥ 15 but count 29 < 30) → null;
   30 × 0.4 (count ok, utilSum 12 < 15) → null; 30 × 0.5 (both met) → non-null.
3. Baseline weighted 900_000, current 1_500_000 → deviationPct ≈ **+66.7**,
   verdict `drift`. Current 1_050_000 → +16.7 → not drift.
4. Weighted deviation +5% with raw deviation +30% → `mix-shift`; raw +20% → `stable`.
5. Interval timestamps: one at exactly `now−3d` lands in current, not baseline;
   one at `now−17d` in baseline; one at `now−18d` in neither.
6. `externalShare`: external dUtil 2, clean 6, mixed 2 → **0.2**; no non-idle
   intervals → null.
7. Intervals of other models never leak into A's rate.

### Task 5 — shared types + `GET /api/usage/rates`

Files: modify `shared/types.ts` (types first, per repo rule), `server/api.ts`
(`serveUsageRates`), `server/index.ts` (route beside `/api/usage/profile`);
test `test/api-usage-rates.test.ts` via `test/api-harness.ts`.

Produces (the API contract): `ModelRateVerdict = 'drift' | 'stable' | 'mix-shift'
| 'thin'`; `ModelRateRow {model: string, rawPerPct: number | null, weightedPerPct:
number | null, baselineRawPerPct: number | null, baselineWeightedPerPct: number |
null, deviationPct: number | null, verdict: ModelRateVerdict, intervals: number,
utilSum: number}`; `UsageRatesResponse {generatedAt: string, recording: boolean,
models: ModelRateRow[], externalSharePct: number | null, error?: boolean}`.

Behaviour: handler reads history samples (trailing-bytes reader from
`usage-history.ts`, cap sized for ~17 days of write-on-change samples) and
`readLedgerSince(now − 17d)`, runs join → classify → one `driftRow` per model seen
in clean intervals, sorted by `utilSum` descending. `externalSharePct` = the
fitter's fractional `externalShare` × 100. Read-only, unpolled, fails open
to `{recording: false, models: [], externalSharePct: null}` on any error — same
honesty pattern as `serveUsageProfile`. Injectable dir for tests.

TDD: failing harness tests → implement → pass → commit
(`feat(api): usage rates endpoint`).

Test cases:
1. Recording off: 200 with `recording: false`, empty `models`, null share.
2. Missing ledger/history files: same empty-honest 200, `error` unset.
3. Fixture dir with synthetic history + ledger covering one model above floors:
   one row, exact `weightedPerPct` from the fixture arithmetic, verdict `thin`
   (no baseline mass), `generatedAt` parseable ISO.
4. Route: GET `/api/usage/rates` returns JSON content-type; unknown subpath
   `/api/usage/ratesx` falls through to static (404 behaviour of harness).

### Task 6 — client card + formatting + docs

Files: create `client/src/hooks/useUsageRates.ts`, `client/src/components/usage/
UsageRates.tsx`, `client/src/lib/usageRatesFormat.ts`; modify
`client/src/components/usage/UsageView.tsx` (render card above `UsageProfile`),
`client/src/styles.css` (new `.rates-*` classes below the theme-token block, theme
tokens only — no literal colors), `docs/subsystems/usage-limits.md` (new section),
`docs/overview.md` (§Map lines for the two new server libs);
test `test/usage-rates-format.test.ts`.

Behaviour: hook = one fetch per mount, no polling, fail-open keeping prior data
(mirror `useUsageProfile`). Card per approved mockup: title "Token value per
model", subtitle "tokens per 1% of limit · baseline = trailing 14 days"; one row
per model — name, `formatTok(rawPerPct)` + "/ 1%", baseline + interval count,
deviation line, badge (`drift` red / `stable` green / `thin` muted "collecting" /
`mix-shift` amber "mix shift, not repricing"); footer external-share pill
"N% external · burned outside this machine · excluded from fit"; `recording:
false` → the same honest empty state pattern the profile view uses. Touch
targets/tooltips phone-first (no `title` attribute).

`formatTok(n: number | null): string` — exact cases: `formatTok(210_000)` =
`'210k'`; `formatTok(1_500_000)` = `'1.5M'`; `formatTok(2_000_000)` = `'2.0M'`;
`formatTok(950)` = `'950'`; `formatTok(null)` = `'—'`.

TDD for the pure formatter; component verified in the running dev server (see
Done when). Commit (`feat(usage): token value per model card`), then docs commit
(`docs(usage): document model token rates`).

### Follow-ups (file as new backlog ideas at execution end, do not build)

- Weekly-window recording + rates (needs persisting the 7-day series).
- Least-squares decomposition of mixed intervals if discard share proves high.
- ntfy push on first drift crossing.

## Test cases

The exact per-task cases live inline above (Tasks 1–6). Summary of the load-bearing
ones: weighted arithmetic (2750 case), `(prevT, t]` boundary, empty-`tok` tick line,
window-change and utilization-drop discards, ledger-coverage `gap`, dominance 0.91
vs 0.89, pooled 600k/1% arithmetic, both floor kinds, +66.7% drift, mix-shift vs
stable at the raw threshold, `now−3d` boundary, external share 0.2, recording-off
and missing-file endpoint honesty, and the five `formatTok` values.

## Done when

- `pnpm test` green including every new test file registered in `test/run-all.ts`;
  `pnpm typecheck` green. Command output captured for the PR (never claim green
  without it).
- With recording on in dev (`pnpm dev`), `.usage-ledger.jsonl` grows one line per
  minute and `GET /api/usage/rates` returns rows once floors are met; with
  recording off both report the honest empty state.
- Usage tab renders the card in all 5 themes with no literal colors added.
- Docs updated (`usage-limits.md`, `overview.md`); PR follows the template with an
  explicit "not verified" line for long-horizon drift behaviour (needs weeks of
  real data by nature).
