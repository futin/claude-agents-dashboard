# Usage forecast: duty-cycle-aware projection

**Date:** 2026-08-25
**Status:** approved 2026-08-25 — all open questions resolved; next step is the
implementation plan
**Touches:** `server/lib/usage-pace.ts`, new `server/lib/usage-forecast.ts`, new
`server/lib/usage-history.ts`, `client/src/lib/pace.ts`, `server/lib/settings.ts`,
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

## Architecture — one seam, two ways to fill it (fallback and learned)

```
usage.ts (fetch, ~1/min)
   │
   ├─→ usage-pace.ts        activeRate  (%/active-hour, short lookback)   [exists]
   │
   ├─→ usage-history.ts     persist samples → learn 168-bucket profile
   │
   └─→ usage-forecast.ts    walkForward(utilNow, activeRate, profile, resetsAt)
                            → { projectedExhaustAt, pessimisticExhaustAt, confidence }
```

`usage-forecast.ts` is **pure**. It takes a profile and does not care where the
profile came from. That is the whole point of the seam:

- The **fallback** profile is flat: every weight equal to a duty cycle measured from
  the RAM ring, or `1.0` when there is not enough history to measure one. Weight `1.0`
  reproduces today's behaviour exactly, which is the regression floor — recording
  disabled, or enabled with an empty profile, cannot be worse than today.
- The **learned** profile comes from disk. `usage-forecast.ts` does not change between
  the two cases; it is handed a profile and walks it.

Keeping that boundary is what makes the walk testable: synthetic profiles exercise
every calendar edge case with no filesystem and no clock.

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

## Gaps: what a sleeping laptop actually tells us

The naive rule — "no data means unknown, never idle" — is wrong here, and wrong in a
way that defeats the whole feature. The machine sleeps at night. Night is exactly the
block of hours the profile most needs to learn is quiet. Treat those gaps as unknown
and the night buckets collect almost no evidence, stay below the trust floor forever,
fall back to the global mean — and the global mean is dominated by working hours. The
projection over-predicts night burn again, which is the bug we set out to fix.

The utilization number itself resolves this. It is cumulative within a window and
does not age out token-by-token (verified 2026-08-24: `resets_at` held constant while
utilization climbed 32 → 35 → 51). So the two samples bracketing a gap say what
happened inside it:

| Gap, bracketed by two successful samples | Interpretation |
|---|---|
| `resetsAt` unchanged **and** utilization unchanged | **Observed idle.** Nothing was spent, whatever the reason. Counts into `observedMin` with `activeMin += 0`. |
| `resetsAt` unchanged, utilization **rose** by Δ | **Unknown.** We know the total but not its distribution across the gap's hours. Counts into neither. |
| `resetsAt` changed (window reset inside the gap) | **Unknown.** The comparison is meaningless — 40% → 40% across a reset is consistent with working the whole time. |

This inverts which case is the exception. Sleep, a shut lid, dinner — all land in row
one, so a sleeping laptop becomes the profile's single best teacher rather than a hole
in it. Only the genuinely ambiguous case (spend happened, timing unknown) is
discarded, and that case is rarer.

### Sensor choice: learn from the 5h window, predict the weekly one

Row one's inference depends on utilization being monotonic within its window. That is
**verified** for the 5h window and **unproven** for the weekly one — the docs flag
that Anthropic doesn't document the weekly reset and community reports conflict (some
observed 72-hour intervals). A sliding weekly window could *fall* as old spend ages
out, and "unchanged" would stop proving anything.

So: derive the 168-bucket profile from **5h-window samples**, and apply it to the
**weekly** projection. Beyond dodging the monotonicity question, the 5h window is
simply the better sensor — it sweeps 0 → ~50% within five hours, where the weekly
number crawls in ~1% integer steps. The thing being predicted and the thing being
measured are deliberately different windows.

### Bucket accounting

Each bucket keeps the current week's `observedMin`/`activeMin` accumulators plus a
`weekStamp`, and separately a **lifetime** `observedMin` used only as an evidence
floor. When a sample arrives whose ISO week differs from the bucket's `weekStamp`,
that week's ratio folds into the EWMA weight and the accumulators reset:

```
weight ← (1−α)·weight + α·(activeMin / observedMin)     α ≈ 0.3
```

α = 0.3 per week gives a ~2-week half-life (`ln 0.5 / ln 0.7 ≈ 1.94`), so recent
habits dominate.

**A frozen weight is not a decayed one.** A bucket's weight only moves when that
bucket folds. If an hour goes quiet the bucket simply stops folding, so its weight
freezes at the old value and its lifetime evidence keeps it trusted forever. Stop
working Saturday afternoons in March and that cell still claims 40% in September,
with the forecast budgeting for a habit you dropped.

Marking such a cell untrusted is the wrong repair: untrusted falls back to the global
mean, which is dominated by working hours, so an hour you have genuinely abandoned
would be *over*-estimated. It has to decay instead.

So the profile also tracks which ISO weeks were observed **at all** — a bounded list
on `ProfileState`, pruned to the last 26. When a bucket folds, count the observed
weeks strictly between its `weekStamp` and the current one; call that `k`. Then:

```
w      ← weight === null ? ratio : (1−α)·weight + α·ratio   // fold the pending week
weight ← w × (1−α)^k                                        // then age it by k quiet weeks
```

Order matters: the pending accumulators belong to the bucket's stamped week, and the
`k` skipped weeks came *after* it, so they age that week's contribution. Decaying
first would age a weight the skipped weeks predate, and a first-ever fold would escape
the decay entirely and leave a stale seed at full strength.

`k` counts only weeks we were actually recording, so a month with the server off
contributes `k = 0` and changes nothing, while a month of ordinary use with that hour
idle decays it at the same ~2-week half-life as everything else. This is the
gap-versus-idle rule from above applied one level up: absence of data is not evidence
of absence, but observed quiet is. A bucket holds at most 60 observed minutes per week, so the floor is
**lifetime**: under 60 accumulated observed minutes the bucket reports no weight and
the walk falls back to the profile's global mean. A week whose bucket saw only a few
minutes still folds in — the EWMA weights it the same as a full week, which is why the
lifetime floor, not a per-week one, is what gates trust.

## Sampling is request-driven today, and that has to change

`getCachedUsageState()` has exactly one caller: the `/api/sessions` handler
(`server/api.ts:152`). There is no timer. Samples are therefore recorded **only while
a browser has the dashboard open and polling**.

For the live header bars that is correct — no viewer, no reason to fetch. For history
recording it is fatal: the log would describe when a dashboard tab was open, not when
work happened. A machine awake all day with the tab closed records nothing, and the
profile learns browsing habits.

Recording therefore needs its own sampling interval, independent of browser polling
and gated on the opt-in history-recording setting. Consequences to accept explicitly:

- The server calls Anthropic ~once/minute for the life of the process with nobody
  watching. Same single outbound call kind the project already makes (`lib/notify.ts`
  is the other), now on a schedule rather than on demand.
- After a long sleep the access token is usually expired, so the first post-wake
  samples fail. The row-one inference still works — it only needs the two *successful*
  samples bracketing the gap, however far apart they are.
- macOS suspends timers during sleep; the interval fires on wake. Gap detection must
  come from comparing sample timestamps, never from counting missed ticks.

## Restart behaviour

Today a restart wipes the RAM ring: the 5h pace returns after 5 minutes of fresh
samples, the weekly after 30 (`usage-pace.ts:44-45`).

With recording **off** that stays true, by design: the flat fallback profile means the
weekly projection reverts to today's behaviour rather than blanking while it waits to
measure a duty cycle.

With recording **on** the cost largely disappears. The profile is on disk, so the
learned pattern survives untouched. And the raw log lets the server **rehydrate the
ring** from the last few hours on boot, so the active rate is available immediately
instead of 30 minutes later.

Nothing here reads transcripts. Utilization comes only from the OAuth usage endpoint;
transcript token counts do not map onto Anthropic's opaque percentage, which is why
idea-4 is a complement rather than a substitute. The new files hold copies of numbers
already fetched.

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

## Scope — one branch, dependency-ordered

Persistence is a prerequisite for the forecast being better than today's, so it all
lands together. The order below is the build order; each step is independently
testable against the one before it.

1. **Contract** — `shared/types.ts` first, per convention: the new optional
   `RateLimit` fields, and the `HourWeight`/`DutyProfile` shapes.
2. **`usage-forecast.ts`** (pure) — `walkForward` plus the flat-profile constructor.
   Fully testable with synthetic profiles before any disk code exists, and the
   weight-`1.0` case is asserted equal to today's closed-form result.
3. **`usage-history.ts`** (pure core + thin I/O shell) — gap classification, bucket
   accounting, EWMA fold, profile derivation. The classification and accounting are
   pure functions over sample arrays; only append/read/rotate/atomic-write touch the
   filesystem.
4. **Wiring** — the opt-in setting, the sampling interval, ring rehydration on boot,
   and `usage-pace.ts` handing its active rate to the forecast.
5. **Client** — `pace.ts` gains the pessimistic tick and confidence; `Header.tsx`
   renders the band; the weekly `%/day` text is corrected for duty cycle.
6. **Profile inspector** — `GET /api/usage/profile` plus a 24×7 hour-of-week heatmap in
   the Analytics tab, with the forward walk that produced the current projection
   underneath it. Chosen as variant C of
   `docs/guides/mockups/usage-profile-heatmap-mockups.html`.

   This is disclosure, not decoration. The forecast quietly changes a number the user
   acts on, using a model learned in the background; with no way to inspect it, a wrong
   projection is undebuggable and the only recourse is reading `.usage-profile.json` by
   hand. The 168 weights *are* the explanation, and the walk is what ties them to the
   number on the header bar. Evidence is rendered as texture rather than a second hue —
   an untrusted cell has no value, not a low one — and the ramp is derived with
   `color-mix(in oklab, var(--cyan) N%, var(--strip))` so all five themes hold from one
   rule.

Behaviour with recording off, or on but with an empty profile, is today's behaviour
exactly. That is the regression floor and it should have a test of its own.

The profile is not trustworthy until roughly two to three weeks of buckets exist.
Until then `confidence` stays `thin` and the band stays wide. That is honest
behaviour, not a defect, and it means the feature's real value arrives well after the
branch merges — worth saying out loud so the first week's output is not read as a bug.

## Testing

Pure functions, fixed clocks, no network — matching `test/usage.test.ts` and
`test/pace-view.test.ts`.

- `walkForward` with a synthetic 09:00–19:00 Mon–Fri profile: from Friday 18:00 at
  60% and 5%/active-hour, assert the crossing lands Monday, not Saturday.
- Same inputs with a flat weight-1.0 profile: assert the result equals today's
  closed-form `(100−util)/rate`, proving the fallback profile is a no-op.
- Crossing exactly at an hour boundary, and inside an hour (interpolation).
- `util` already ≥100 → immediate; `activeRate` 0 → null.
- Gap classification, one case each: unchanged `resetsAt` + unchanged utilization
  counts a full night as observed idle; unchanged `resetsAt` + risen utilization
  counts nothing; changed `resetsAt` counts nothing even when utilization is
  identical across the gap. Per the `test-the-untested-complement` lesson, all three
  rows get a test, not just the happy one — and per `mutation-prove-security-tests`,
  the reset-guard test must fail if the `resetsAt` comparison is deleted.
- Thin bucket (lifetime `observedMin < 60`) falls back to the global mean, not to 0.
- Week rollover: a fold happens exactly once per bucket per ISO week, and the
  accumulators reset; two samples in the same week must not fold twice.
- Rotation: profile survives raw-file truncation.

## Resolved decisions

Every question raised in review is settled. Recorded with the reasoning, because the
reasoning is what a future change needs to argue against.

1. **One phase, not two.** The original split gave phase 1 a flat weight-`1.0`
   fallback, which is today's arithmetic — and its duty-cycle measurement wanted 24h
   of a RAM-only ring that request-driven sampling rarely fills. Phase 1 alone was
   scaffolding, not a shipped improvement. Persistence is a prerequisite for the
   feature working at all, so both halves land together. The internal seam between
   `usage-forecast.ts` (pure, profile-agnostic) and `usage-history.ts` (the profile's
   source) stays exactly as designed — it is still what makes the walk testable
   against synthetic profiles. Only the delivery boundary moved.
2. **Band UI is in.** With one phase there is no reason to defer it, and a single
   tick would claim precision the data does not have while buckets are still thin.
3. **Learn from the 5h window, apply to the weekly one.** Settled above under
   *Sensor choice* — the 5h window is the verified-monotonic, high-resolution sensor;
   the weekly window is the thing being predicted. The 5h projection itself is left
   alone: duty cycle inside a five-hour window is ~1 by construction.
4. **Write-on-change plus a 15-minute heartbeat**, not one line per minute. The
   gap-classification rule already reads sparse records correctly — two consecutive
   lines with unchanged `resetsAt` and unchanged utilization *mean* every minute
   between them was idle — so per-minute density buys the profile nothing. It also
   gives the heartbeat a second job: any hole wider than the heartbeat interval plus
   slack is a period we were not recording, which is how the charts tell genuine
   downtime from quiet. Cost drops from ~55 MB/year to ≲17 MB/year, easing rotation
   pressure.
5. **The sampling timer is opt-in**, gated on history recording, which is itself an
   opt-in Settings toggle (`server/lib/settings.ts`, alongside the existing idle
   threshold and notify policy). Default off. The timer makes the server call
   Anthropic once a minute for the life of the process with nobody watching; that is
   a real behaviour change and should be a choice, not a surprise. With recording
   off, everything reverts to today's request-driven sampling and the flat fallback
   profile.
6. **Ambiguous gaps are discarded.** When utilization rose across a gap we know the
   total but not its distribution. Spreading it across the gap's hours in proportion
   to the existing profile weights would recover signal, but the profile would then
   be training on its own output — a feedback loop that entrenches whatever shape it
   started with, including a wrong one. Discarding loses information and keeps the
   profile honest. Both of these decisions share that principle: never invent data.

## Not doing

Explicitly out of scope, so a later reader does not mistake absence for oversight:
per-cell variance or stability (a cell reports one smoothed weight, so
"consistently 50%" and "100% for four weeks then 0%" look identical — the raw log
keeps the history if this ever matters), sub-hour profile resolution, holiday or
vacation calendars, configurable timezone
(host-local is correct — the server and the user are the same machine), per-project
profiles, and any change to the 5h window's own projection. The history *charts* from
idea-5 remain out of scope — utilization over days and weeks, read from the raw JSONL,
answering different questions. This design delivers the persistence they need and the
view stays separate work. The **profile inspector** is a different thing and is in
scope (step 6 above): it reads the 6.6 KB aggregate, not the log, and explains the
calculation rather than charting history.
