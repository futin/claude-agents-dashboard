# Per-model token rates and drift detection — design

Date: 2026-08-28 · Status: approved (brainstormed in-session, groomed from idea-10)

## Problem

The dashboard shows utilization percent for the 5-hour window, but nobody knows what a
percent *is* in tokens — and whether that exchange rate is stable. The user's planning
question: "if 1% of Opus is ~900k tokens for two weeks and suddenly becomes ~1.5M in
week 3, I want to see that, so I can pick models deliberately." Anthropic does not
expose the window budget, but both halves of the measurement already exist on this
machine: per-minute utilization samples (`.usage-history.jsonl`) and per-message token
counts in the transcripts the dashboard already reads.

## Decisions (settled with the user)

- **Per-model exchange rates, no dollars.** USD appears nowhere in the UI. API pricing
  survives only as *ratios between token types* (output ≈ 5× input, cache read ≈ 0.1×,
  cache write ≈ 1.25×), used to normalize mixed token types into "weighted tokens".
  These ratios are uniform across current Anthropic models, so one ratio set suffices;
  per-model base-price differences are exactly what the fitted per-model rates absorb.
- **Drift detection runs on the weighted rate only.** Weighted tokens-per-percent is
  mix-invariant and effort-invariant (thinking tokens are output tokens; a switch from
  `high` to `xhigh` raises consumption and utilization proportionally, leaving the rate
  flat). The raw "1% ≈ N tokens" figure is a courtesy translation at the model's recent
  mix; when raw moves but weighted did not, the card says "mix shift", never "drift".
- **Cross-device usage is discarded and disclosed.** Intervals where utilization rose
  with ~zero local weighted tokens are excluded from every fit and surfaced as an
  "external burn" share.
- **Single-model attribution by dominance, not regression.** An interval counts toward
  model M when ≥ 90% of its weighted tokens are M's. Mixed intervals are dropped from
  per-model fits. Least-squares decomposition of mixed intervals is a follow-up if too
  much data gets discarded.
- **5-hour window only.** The history log records only the 5h series; weekly recording
  is a separate follow-up idea.
- **Alerting: card badge only.** No ntfy push in this iteration.
- **Baseline** = pooled weighted rate (Σ weighted tokens / Σ Δutil) over a model's
  clean intervals in `[now−17d, now−3d)`; **current** = same ratio over the trailing
  3 days. Confidence floors on interval count and cumulative Δutil keep the pooled
  ratio robust. Deviation beyond ±20% with sufficient sample mass → drift badge.

## Architecture

Three new pieces, one extended, all following the existing usage-subsystem pattern
(`usage-history.ts` records, pure modules compute, `api.ts` shapes, a hook fetches once
per mount).

### 1. Ledger recorder — `server/lib/usage-ledger.ts` (new)

Records what the machine consumed, per minute, per model, per token type.

- Invoked from the same code path that calls `recordTick` on a successful usage fetch
  (in `usage.ts`), so every ledger line aligns with a history sample time. Gated by the
  same `recordUsageHistory` setting; no new toggle.
- Each tick sums `message.usage` blocks from transcript lines with timestamp in the
  half-open interval `(prevT, t]`, across files under `projectsRoot()` (reusing
  `listTranscripts`) whose mtime is recent enough to contain new lines. A RAM map of
  per-file byte offsets avoids re-reading whole files; the first tick after a server
  start only initializes offsets and records nothing (one lost minute by design —
  mirrors how the pace ring reseeds).
- Appends one compact JSON line per tick to `.usage-ledger.jsonl` at the repo root
  (sibling of `.usage-history.jsonl`, same best-effort write policy, gitignored):
  `{t, prevT, tok: {"<model>": {in, out, cc, cr}}}`. `prevT` makes recording gaps
  explicit so the fitter never bridges a gap silently.

### 2. Rate fitter — `server/lib/usage-rate.ts` (new, pure)

Pure functions over (history samples × ledger lines); unit-testable with fixtures.

- **Join**: pair consecutive history samples inside one window (same `resetsAt` under
  the same 120s slack `usage-history.ts` uses; utilization drops and window changes
  break the chain) with the ledger lines covering the same span.
- **Classify** each interval: `idle` (Δutil ≈ 0), `external` (Δutil above threshold,
  ~zero local weighted tokens), `model:M` (M holds ≥ 90% of weighted tokens), else
  `mixed`.
- **Rate** per model over a time range: Σ weighted tokens / Σ Δutil, plus the raw
  variant and the type mix. Confidence requires both a minimum interval count and a
  minimum cumulative Δutil (percentage points) — a rate fitted on 0.4% of movement is
  noise.
- **Drift report** per model: baseline (14d) vs current (3d) weighted rates →
  `drift` / `stable` / `mix-shift` / `thin` verdict with a deviation percentage.

### 3. API — `GET /api/usage/rates`

`shared/types.ts` first, then a `serveUsageRates` handler in `api.ts` registered in
`createRequestListener` next to `/api/usage/profile`. Read-only; fails open to an
empty, honest payload (`recording: false`, no rows) like `serveUsageProfile`. Fetched
once per Usage-tab mount (no 3s polling — it reads two files and does arithmetic).

### 4. Client — model rates card in the Usage tab

The Usage section splits into sub-tabs — `Forecast | Token value` — via a segmented
switch in its header row (the Settings page's `.set-seg` pattern), because
`UsageProfile` is tall and stacking would force scrolling. Only the active sub-view
mounts; the selected tab persists per device in the localStorage settings lib. The new
`UsageRates` component is the second tab, fed by a new `useUsageRates` hook (same
one-fetch-per-mount shape as `useUsageProfile`). Per the
approved mockup: one row per model (name, "N tok / 1%", baseline + window count,
deviation line, verdict badge), external-burn footer. All colors via theme tokens;
class names added to `styles.css` below the token block with zero literals.

## Data honesty rules

- A rate is shown only with its evidence (window count, cumulative Δutil behind it).
- `thin` is a first-class verdict — collecting, not concluding.
- External burn is disclosed whenever nonzero, because it is the one systematic bias.
- Recording off → the card says so, exactly like the profile view's `recording-off`.

## Testing

Pure modules get node-assert tests with tmpdir JSONL fixtures (house style, see
`test/`): ledger interval boundary behaviour, classifier thresholds and window-break
handling, exact rate arithmetic on synthetic data, drift/mix-shift/thin verdicts at
their boundaries, and handler-level tests through `test/api-harness.ts`. The
implementation plan lists the exact cases.

**Plan override (deliberate, per project rules): the implementation plan specifies
behaviour, signatures, and exact test cases — never literal code blocks.**

## Out of scope (filed separately)

- Weekly-window recording and rates (needs persisting the 7-day series first).
- Least-squares decomposition of mixed intervals.
- ntfy push on drift.
