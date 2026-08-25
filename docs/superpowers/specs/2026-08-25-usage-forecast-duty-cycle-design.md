# Usage forecast: duty-cycle-aware projection

**Date:** 2026-08-25
**Status:** design, awaiting review
**Touches:** `server/lib/usage-pace.ts`, new `server/lib/usage-forecast.ts`, new
`server/lib/usage-history.ts`, `client/src/lib/pace.ts`,
`client/src/components/Header.tsx`, `shared/types.ts`
**Related backlog:** `backlog/ideas/open/idea-5-long-term-5h-weekly-usage-history.md`

## Problem

`computePace` (`server/lib/usage-pace.ts:66`) is a single linear slope: measure
`Δutilization / Δt`, then `msLeft = (100 − utilization) / rate`. The unit is
**wall-clock hours**. It has no notion of whether those hours are hours you work.

For the 5h window that is correct — the window is short and you are active inside it.
For the **weekly** window it is wrong in two compounding ways:

1. **The rate is only ever sampled while hot.** The weekly lookback is 6h and the
   ring caps at 720 samples ≈ 12h (`usage-pace.ts:41,50`). The measured slope is
   therefore "burn during the current work session", extrapolated across the
   remaining ~168 wall-hours of the window.
2. **The pessimistic verdict fires exactly when the sample is least
   representative.** `rate <= 0` yields no projection (`usage-pace.ts:73`), so while
   idle the bar reads green `lasts`. The rate is positive only while you work — so
   the red `wall` tick appears at peak burn and disappears overnight.

Magnitude: 10h/day × 5 days = 50 active hours of 168. A peak-hour rate extrapolated
over wall time overshoots by ~3.4×.

## Core idea: separate two quantities that are currently fused

The single `ratePerHour` conflates:

- **active rate** — how fast you burn *while working* (%/active-hour), and
- **duty cycle** — what fraction of the clock you actually work.

Split them:

```
projection = walk forward hour by hour, adding activeRate × weight(hourOfWeek)
```

`weight(h) ∈ [0,1]` is the expected fraction of calendar hour `h` spent active.
168 weights = one week's shape.

This is strictly better than simply lengthening the weekly lookback (the obvious
fix), because the duty cycle that matters is **forward-looking, not trailing**. At
Friday 18:00 with a weekend ahead, the remaining window is nearly all idle hours →
`lasts`. At Monday 09:00 the same trailing average projects a wall. A flat trailing
average cannot tell those apart; integrating a profile over the *remaining* hours
can.

It also keeps the live `%/h` readout honest: `activeRate` stays on a short (30 min)
lookback, so the header still says "burning 6%/h" while you work, instead of a
smeared 24h number that reads as 1.5%/h and matches nothing you can feel.

## Architecture — one seam, two ways to fill it

```
usage.ts (fetch, ~1/min)
   │
   ├─→ usage-pace.ts        activeRate  (%/active-hour, short lookback)   [exists]
   │
   ├─→ usage-history.ts     persist samples → learn 168-bucket profile    [phase 2]
   │
   └─→ usage-forecast.ts    walkForward(utilNow, activeRate, profile, resetsAt)
                            → { projectedExhaustAt, pessimisticExhaustAt, confidence }
```

`usage-forecast.ts` is **pure**. It takes a profile and does not care where the
profile came from. That is the whole point of the seam:

- **Phase 1** supplies a *flat* profile — every weight equal to a duty cycle
  measured from the (lengthened) RAM ring, or `1.0` when history is too thin. Weight
  `1.0` reproduces today's behaviour exactly, so phase 1 cannot regress the current
  output or lose availability after a restart.
- **Phase 2** supplies the *learned* profile from disk. No change to
  `usage-forecast.ts`, no rework of phase 1.

### walkForward

```
walkForward(nowMs, utilNow, activeRatePerHour, profile, resetsAtMs)
  → { exhaustAtMs: number | null }

for each successive hour boundary from nowMs until resetsAtMs:
    util += activeRatePerHour × profile.weight(hourOfWeek(t))
    if util >= 100: return interpolated crossing time within that hour
return null                                     // coasts to reset → "lasts"
```

Hour-of-week is computed in the **host's local timezone** — "night" is a local-clock
concept, and the server and the user are the same machine.

Deliberately excluded (YAGNI): sub-hour resolution, holiday calendars, timezone
config, per-project profiles.

## Storage: no database

The question was raised explicitly. Measured, not estimated:

| Option | Size |
|---|---|
| Raw JSONL, one line/min, compact keys (110 B) | 155 KB/day → **55 MB/year** |
| Raw JSONL, write-on-change + 15-min heartbeat | ≲48 KB/day → **≲17 MB/year** |
| The 168-bucket profile itself | **6.6 KB**, total |

Three query patterns, and the repo already has a primitive for each:

1. **Projection** needs only the 6.6 KB profile — an aggregate, updated online. No
   scan, no query engine.
2. **"Last N days" charts** (idea-5) want the raw tail. `lib/transcript.ts` already
   tail-reads the last 256 KB of a file; at write-on-change density 256 KB is ~5
   days. Same trick, and `lib/agents-cache.ts` already has the byte-offset
   incremental-cache pattern if a forward scan is ever needed.
3. **"Weeks across months"** wants a rollup — another small derived JSON.

`node:sqlite` **is** available here (Node v22.23.1, `DatabaseSync` present) and would
not violate the zero-npm-dep rule since it is a built-in. It is still the wrong
call now:

- It emits `ExperimentalWarning: SQLite is an experimental feature and might change
  at any time` on every server start.
- It landed in Node 22.5.0; `package.json` declares `engines: node >=18`, so using it
  raises the floor by four majors for a 6.6 KB aggregate.
- It buys nothing against the three patterns above.

**What would flip this decision:** arbitrary time-range `GROUP BY` over a year, or
joining usage against per-project token stats (idea-4). If either lands, revisit —
the JSONL is a replayable source of truth, so migrating into SQLite later is a
one-off import, not a rewrite.

Files (both gitignored, both resolved from the repo root — not cwd — per the
`adhoc-scripts-clobber-state-files` lesson):

- `.usage-history.jsonl` — append-only raw samples, rotated at 90 days / 32 MB,
  whichever first.
- `.usage-profile.json` — the 168 buckets. Derived state, EWMA-updated, survives
  rotation (it never needs the raw file again).

## The correctness trap: gaps are unknown, not idle

A bucket must not learn "you never work at 15:00" because the server was off, or
because `usageStatus` was `token-expired` — which per idea-5 is the normal
away-from-terminal state, i.e. it correlates with exactly the hours we most want to
measure. Recording a gap as zero activity would bias the profile toward the machine's
uptime, not the user's habits.

Each bucket therefore carries two counters:

```
{ observedMin: number,   // sample-minutes we actually had data for
  activeMin:  number }   // of those, minutes where utilization rose
weight = activeMin / observedMin
```

Missing minutes are simply never counted in either denominator or numerator.

Each bucket keeps three numbers: the current week's `observedMin`/`activeMin`
accumulators plus a `weekStamp`, and separately a **lifetime** `observedMin` used only
as an evidence floor. When a sample arrives whose ISO week differs from the bucket's
`weekStamp`, that week's ratio is folded into the EWMA weight and the accumulators
reset:

```
weight ← (1−α)·weight + α·(activeMin / observedMin)     α ≈ 0.3
```

α = 0.3 per week gives a ~2-week half-life (`ln 0.5 / ln 0.7 ≈ 1.94`), so recent
habits dominate. A bucket holds at most 60 observed minutes per week, so the floor is
**lifetime**: under 60 accumulated observed minutes the bucket reports no weight and
the walk falls back to the profile's global mean. A week whose bucket saw only a few
minutes still folds in — the EWMA weights it the same as a full week, which is why the
lifetime floor, not a per-week one, is what gates trust.

## Confidence and the UI

False precision is the failure mode here — a single red tick claims a certainty the
data does not have. So the forecast reports a **band**:

- `projectedExhaustAt` — best estimate. Profile walk when confident, flat-rate
  otherwise. Existing consumers keep working and silently get better.
- `pessimisticExhaustAt` — the flat-rate (weight `1.0`) edge. New, optional.
- `confidence: 'none' | 'thin' | 'ok'` — drives whether the strip draws one tick or
  a shaded band between two.

`client/src/lib/pace.ts` currently returns a single `wallPct`
(`client/src/lib/pace.ts:24`) rendered as one `.u-tick.wall`
(`Header.tsx:104`). It gains `wallPctPessimistic` and the strip renders a band
between the two ticks when both exist. Per the styles rule, the band reuses existing
theme tokens — no new literal colors.

## Contract changes (`shared/types.ts` first, per convention)

`RateLimit` gains, all optional, all surviving absence:

```ts
pessimisticExhaustAt?: string | null;   // flat-rate band edge
dutyCycle?: number | null;              // 0–1, forward-looking over the remaining window
forecastConfidence?: 'none' | 'thin' | 'ok';
```

`ratePerHour` keeps its name but its meaning sharpens to **%/active-hour**. Its
docstring must say so — this is the one silent semantic change in the design, and
the weekly `fmtRate` (`client/src/lib/pace.ts:33`, which multiplies by 24 to show
`%/day`) must switch to `activeRate × dutyCycle × 24` or it will print a number
3.4× too large.

## Phasing

**Phase 1 — the seam (no disk).**
`usage-forecast.ts` + `walkForward` + flat profile; per-window ring sizes and
lookbacks (weekly ring extended to ~7 days at 5-min resolution ≈ 2,016 samples);
duty cycle measured from the ring when it holds ≥24h, else weight `1.0`; band UI.
Independently valuable, and by construction cannot regress current behaviour.

**Phase 2 — learned profile (architectural).**
`usage-history.ts`: append, rotate, tail-read, bucket learning with the
observed/active counters, atomic profile write. Feeds the same seam. Also delivers
idea-5's persistence half as a byproduct — the history charts then need only a
reader and a view.

Phase 2's projection is not trustworthy until ~2–3 weeks of buckets exist. Until
then `confidence` stays `thin` and the band stays wide. That is the honest behaviour,
not a defect.

## Testing

Pure functions, fixed clocks, no network — matching `test/usage.test.ts` and
`test/pace-view.test.ts`.

- `walkForward` with a synthetic 09:00–19:00 Mon–Fri profile: from Friday 18:00 at
  60% and 5%/active-hour, assert the crossing lands Monday, not Saturday.
- Same inputs with a flat weight-1.0 profile: assert the result equals today's
  closed-form `(100−util)/rate`, proving phase 1 is a no-op at the fallback.
- Crossing exactly at an hour boundary, and inside an hour (interpolation).
- `util` already ≥100 → immediate; `activeRate` 0 → null.
- Bucket learning: a gap must leave `observedMin` **unchanged** — and per the
  `mutation-prove-security-tests` lesson, that test must fail if the gap-skip is
  deleted.
- Thin bucket (lifetime `observedMin < 60`) falls back to the global mean, not to 0.
- Week rollover: a fold happens exactly once per bucket per ISO week, and the
  accumulators reset; two samples in the same week must not fold twice.
- Rotation: profile survives raw-file truncation.

## Open questions for review

1. Phase 1 alone first, or both phases in one branch?
2. Band UI in phase 1, or keep one tick and add the band with phase 2's confidence?
3. Should the learned profile also improve the **5h** window, or weekly only? (5h is
   short enough that duty cycle inside it is ~1 — leaning weekly-only.)
4. Sampling density on disk: write-on-change + heartbeat (≲17 MB/year) vs every
   minute (55 MB/year, simpler code, better charts).
