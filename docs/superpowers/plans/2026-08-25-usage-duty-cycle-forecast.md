# Duty-Cycle-Aware Usage Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the weekly usage-limit projection account for the hours you actually work, instead of extrapolating a working-hours burn rate across nights and weekends.

**Architecture:** Split the single `ratePerHour` into an *active rate* (%/active-hour, short lookback, unchanged) and a *duty cycle* (what fraction of each calendar hour you typically work). Projection becomes a forward walk that adds `activeRate × weight(hourOfWeek)` hour by hour until the weekly reset. The 168 weights are learned from persisted 5-hour-window samples and applied to the weekly projection. A pure seam separates the walk (`usage-forecast.ts`, profile-agnostic) from the profile's source (`usage-history.ts`), so every calendar edge case is tested against synthetic profiles with no filesystem and no clock.

**Tech Stack:** TypeScript, ESM, Node built-ins only on the server (zero runtime deps), `tsx` (no compile step), React on the client, `node:assert` tests via `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-08-25-usage-forecast-duty-cycle-design.md`

## Context for a fresh session

This plan and its spec were argued out over one long conversation. Everything
load-bearing from that conversation is written down here, so no later session needs
it. Read the spec for *why*; this plan is *how*.

**Design reference:** `docs/guides/mockups/usage-profile-heatmap-mockups.html`, visible
in the dashboard's Guides tab. Variant **C** was chosen — see Task 7.

### Decisions, settled

| # | Decision | Because |
|---|---|---|
| 1 | One branch, not two phases | A flat weight-`1.0` fallback *is* today's arithmetic, and its duty-cycle measurement wants 24h of a RAM-only ring that request-driven sampling rarely fills. Persistence is a prerequisite, not a follow-up. |
| 2 | The projection renders as a band | A single tick claims precision the data lacks while buckets are thin. |
| 3 | Learn from the **5h** window, predict the **weekly** one | Only the 5h window is verified monotonic; the weekly reset mechanism is documented as unproven (community reports of 72-hour intervals). The 5h window also sweeps 0→~50% in five hours where the weekly crawls in ~1% steps — far better resolution. The 5h window's own projection is left alone; duty cycle inside five hours is ~1 by construction. |
| 4 | Write-on-change + a 15-min heartbeat | The gap rule already reads sparse records correctly, so per-minute density buys the profile nothing. The heartbeat doubles as the liveness marker separating downtime from quiet. ~17 MB/year instead of ~55. |
| 5 | Recording is opt-in, default off | It makes the server call Anthropic once a minute for the life of the process with nobody watching. That should be a choice, not a surprise. |
| 6 | Ambiguous gaps are discarded | Spreading a rise across its hours by existing weights trains the profile on its own output, entrenching whatever shape it started with. |
| 7 | No SQLite | `node:sqlite` works here (Node v22.23.1) and is a built-in, so it wouldn't break the zero-dep rule — but it emits `ExperimentalWarning` on every start, landed in 22.5.0 against an `engines: >=18` floor, and buys nothing against a 6.6 KB aggregate plus a tail read. **What would flip it:** arbitrary year-range `GROUP BY`, or joining usage against per-project token stats (idea-4). The JSONL is replayable, so that migration would be an import, not a rewrite. |
| 8 | Heatmap ramp derived via `color-mix`, not hand-picked | Five themes × five steps is 25 hex values nobody can validate. `color-mix(in oklab, var(--cyan) N%, var(--strip))` is monotonic by construction — verified across midnight/graphite/amber/paper at steps 0.098–0.133 — and cannot violate the no-hardcoded-color rule. |

### Traps — every one of these was gotten wrong once

Each of these looks obviously right in the wrong direction. They are listed because a
fresh reader will independently reach for the wrong version.

1. **A flat interval is a *measurement* of idleness, not missing data.** The intuitive
   rule — "no data means unknown" — defeats the entire feature: the laptop sleeps at
   night, night is what the profile most needs to learn, so the night buckets would
   collect no evidence, stay untrusted, and fall back to a working-hours-dominated
   mean. Utilization is cumulative within a window, so two samples bracketing a gap
   with unchanged `resetsAt` and unchanged utilization *prove* nothing was spent. A
   sleeping laptop is the profile's best teacher.
2. **Ambiguity is a function of duration, not direction.** Two samples a minute apart
   with utilization rising are precisely attributable, and are the only way
   `activeMin` ever grows. Only a *long* rising interval is ambiguous. Get this
   backwards and every hour learns as idle.
3. **A quiet bucket freezes; it does not decay.** A weight only moves when its bucket
   folds, so an abandoned hour keeps its old weight forever while lifetime evidence
   keeps it trusted. And marking it untrusted is wrong-directioned — untrusted falls
   back to the global mean, which is *higher*. It must decay, over observed weeks only.
4. **Fold, then decay — not the reverse.** The pending accumulators belong to the
   bucket's stamped week and the skipped weeks came after it.
5. **Sampling is request-driven today.** `getCachedUsageState()` has exactly one
   caller, the `/api/sessions` handler at `server/api.ts:152`. No timer. Nothing is
   recorded unless a browser is polling, so the log would describe when the dashboard
   was watched rather than when work happened.
6. **Learning is live; the log is not a replayable substitute.** The profile learns at
   one-minute resolution against the in-memory previous sample. The log is sparser, so
   rebuilding a profile from it alone is lossy — a flat stretch ending in a rise
   appears as one long rising interval and is discarded as ambiguous. The profile file
   is the profile's source of truth.
7. **`DutyProfile` does not belong in `shared/types.ts`.** The 168 weights never cross
   the FE/BE boundary; only the derived `dutyCycle` number and confidence string do.
8. **History files resolve from the repo root, not `process.cwd()`.** `settings.ts`
   uses cwd; do not copy it. A settings file that resets when you start the server
   elsewhere is a nuisance, but a history file that does is weeks of learning silently
   replaced by an empty file, with no error.
9. **A cell is one hour *of the week*, and evidence accumulates across *weeks*.**
   Monday 09:00 and Tuesday 09:00 are different cells; nothing is averaged across
   days. A cell gathers at most 60 minutes per week, so any UI copy must say weeks —
   "300 min observed" on a one-hour cell reads as a contradiction.

### What cannot be verified in this branch

The plumbing is provable and every pure function is tested, but the forecast's
*accuracy* is not. The profile needs roughly two to three weeks of real samples before
`confidence` leaves `thin`, and no test substitutes for that. Do not claim the
prediction is correct; claim the mechanism works. This belongs in the PR body verbatim.

### Repo conventions that have bitten before

- **Check the working tree before staging.** This repo runs parallel sessions that
  commit mid-flight; a targeted `git add` can still sweep in someone else's work.
- **Plan and spec docs go straight to `main`.** Code and subsystem docs branch.
- **If you dispatch review subagents, paste the reviewer contract** from
  `.claude/CLAUDE.md` into every dispatch. The plugin template says the opposite and
  whichever text is in front of you wins.
- **A guard test that stays green with the guard deleted proves nothing.** Task 3 has
  an explicit step that removes each guard and requires the test to fail.

---

## Global Constraints

- **Server is zero-runtime-dependency.** Node built-ins only. Do not add anything to `server/`'s imports that isn't `node:*` or a local file.
- **No `node:sqlite`.** Decision 4 in the spec. Storage is JSONL + a small JSON file. `package.json` declares `engines: node >=18`; `node:sqlite` landed in 22.5.0 and must not raise that floor.
- **ESM everywhere.** Server imports use a `.js` suffix even for `.ts` files. Cross-boundary imports use `import type`.
- **`shared/types.ts` is edited first** for any field that crosses the FE/BE boundary, and *only* for fields that actually cross it.
- **All new `RateLimit` fields are optional.** Every consumer must survive their absence — the existing invariant.
- **Fail open, always.** No new code path may throw into `scanSessions` or the `/api/sessions` handler. Unreadable/absent/malformed files fall back to defaults.
- **Never hardcode a color or shadow** in `client/src/styles.css` below the theme-token block. The five themes are pure `[data-theme]` token overrides.
- **Recording is opt-in and defaults to off.** Spec decision 5.
- **Regression floor:** with recording off, or on with an empty profile, output must equal today's behaviour exactly. This gets its own test (Task 2, Step 1).
- **Tests are deterministic.** No `Date.now()`, no ambient timezone. Timezone enters only as an injected `offsetMinutes` parameter; tests pass `0`.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/types.ts` | *Modify.* Three optional `RateLimit` fields + `ForecastConfidence`. Nothing else — the 168-weight profile never crosses the boundary. |
| `server/lib/usage-forecast.ts` | *Create.* Pure. `hourOfWeek`, `flatProfile`, `weightAt`, `walkForward`, `confidenceOf`. Knows nothing about disk. |
| `server/lib/usage-history.ts` | *Create.* Pure core (interval classification, bucket accounting, EWMA fold, profile derivation) plus a thin I/O shell (append, tail-read, rotate, atomic profile write). |
| `server/lib/usage-pace.ts` | *Modify.* Hands its active rate to the forecast for the weekly window; gains ring rehydration. |
| `server/lib/settings.ts` | *Modify.* One new persisted boolean, `recordUsageHistory`. |
| `server/index.ts` | *Modify.* The opt-in sampling interval, and the `/api/usage/profile` route. |
| `client/src/lib/pace.ts` | *Modify.* Pessimistic tick + confidence; duty-cycle-corrected `%/day` text. |
| `client/src/components/Header.tsx` | *Modify.* Renders the band between the two ticks. |
| `client/src/components/settings/SettingsView.tsx` | *Modify.* The recording toggle. |
| `server/api.ts` | *Modify.* The `GET /api/usage/profile` handler (Task 7). |
| `client/src/components/analytics/UsageProfile.tsx` | *Create.* The 24×7 heatmap plus the forward-walk strip. Inherits the Analytics tab's lazy chunk. |
| `client/src/hooks/useUsageProfile.ts` | *Create.* Fetches once per mount, unpolled. |
| `client/src/components/analytics/AnalyticsView.tsx` | *Modify.* Mounts the inspector as a section. |
| `test/usage-forecast.test.ts` | *Create.* |
| `test/usage-history.test.ts` | *Create.* |
| `test/usage-profile-api.test.ts` | *Create.* |
| `test/run-all.ts` | *Modify.* Register all three new suites. |

**One deliberate divergence from the spec's build order.** The spec says the `DutyProfile` shape goes in `shared/types.ts`. It should not: the profile never crosses the FE/BE boundary — only the derived `dutyCycle` number and `forecastConfidence` string do. Per the project convention that `shared/types.ts` is the API contract and nothing else, `DutyProfile` lives in `server/lib/usage-forecast.ts`.

---

## Task 1: Contract and the opt-in setting

**Files:**
- Modify: `shared/types.ts` (the `RateLimit` interface, ~line 105; `ServerSettings`, ~line 303)
- Modify: `server/lib/settings.ts` (the `Stored` interface, `DEFAULT_*` block, `readStored`, `setSettings`)
- Test: `test/settings.test.ts` (extend the existing suite)

**Interfaces:**
- Consumes: nothing.
- Produces: `ForecastConfidence` type; `RateLimit.pessimisticExhaustAt`, `RateLimit.dutyCycle`, `RateLimit.forecastConfidence`; `ServerSettings.recordUsageHistory`; `settings.ts` exports `DEFAULT_RECORD_USAGE_HISTORY = false`.

- [ ] **Step 1: Add the contract fields**

In `shared/types.ts`, directly above `export interface RateLimit`:

```ts
/**
 * How much the duty-cycle profile can be trusted. `none` = no learned buckets
 * yet (the projection is the flat-rate one, i.e. today's behaviour); `thin` =
 * some buckets but not a representative week; `ok` = enough to lead with.
 */
export type ForecastConfidence = 'none' | 'thin' | 'ok';
```

Then add to `RateLimit`, after `projectedExhaustAt`:

```ts
  /**
   * The same projection computed with a flat duty cycle of 1.0 — i.e. assuming
   * you work every remaining hour. The pessimistic edge of the band the strip
   * draws; `projectedExhaustAt` is the best estimate. Null under the same
   * conditions as `projectedExhaustAt`.
   */
  pessimisticExhaustAt?: string | null;
  /**
   * 0–1: the share of the hours between now and `resetsAt` that the learned
   * profile expects to be active. Null when there is no profile. Note this is
   * forward-looking over the *remaining* window, not a trailing average — the
   * whole point is that Friday evening and Monday morning differ.
   */
  dutyCycle?: number | null;
  /** How far to trust `dutyCycle` and `projectedExhaustAt`. See {@link ForecastConfidence}. */
  forecastConfidence?: ForecastConfidence;
```

- [ ] **Step 2: Add the setting to the contract**

In `shared/types.ts`, add to `ServerSettings` after `answerSecs`:

```ts
  /**
   * Record account-usage samples to disk so the duty-cycle profile can be
   * learned. Off by default: switching it on makes the server call Anthropic
   * about once a minute for as long as the process lives, with nobody
   * necessarily watching. See docs/subsystems/usage-limits.md.
   */
  recordUsageHistory: boolean;
```

- [ ] **Step 3: Write the failing settings test**

Append inside `run()` in `test/settings.test.ts`, following the existing `test(...)` style in that file:

```ts
  if (test('recordUsageHistory: defaults off', () => {
    resetSettings();
    assert.strictEqual(getSettings().recordUsageHistory, false);
  })) p++; else f++;

  if (test('recordUsageHistory: accepts a boolean patch', () => {
    resetSettings();
    const s = setSettings({ recordUsageHistory: true });
    assert.strictEqual(s?.recordUsageHistory, true);
  })) p++; else f++;

  if (test('recordUsageHistory: a non-boolean rejects the whole patch', () => {
    resetSettings();
    assert.strictEqual(setSettings({ recordUsageHistory: 'yes' }), null);
  })) p++; else f++;

  if (test('recordUsageHistory: rejecting leaves the stored value untouched', () => {
    resetSettings();
    setSettings({ recordUsageHistory: true });
    setSettings({ recordUsageHistory: 3 });
    assert.strictEqual(getSettings().recordUsageHistory, true);
  })) p++; else f++;
```

The last case is the one that matters: `setSettings` rejects a whole patch when any present key is unusable, and that promise must hold for the new key too.

Note this test writes `.dashboard-settings.json` into the process cwd. Run it from the repo root, and be aware the file is gitignored.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — the four new cases fail because `recordUsageHistory` is not a known key (the first reports `undefined !== false`).

- [ ] **Step 5: Implement the setting**

In `server/lib/settings.ts`:

```ts
/** Off by default — recording makes the server poll Anthropic unattended. */
export const DEFAULT_RECORD_USAGE_HISTORY = false;
```

Add `recordUsageHistory: boolean;` to `interface Stored`. In `readStored`, add to `fallback`:

```ts
    recordUsageHistory: DEFAULT_RECORD_USAGE_HISTORY,
```

and to the returned object:

```ts
      recordUsageHistory:
        typeof raw.recordUsageHistory === 'boolean'
          ? raw.recordUsageHistory
          : fallback.recordUsageHistory,
```

In `setSettings`, widen the body type with `recordUsageHistory?: unknown` and add, alongside the other keys:

```ts
  if (body.recordUsageHistory !== undefined) {
    if (typeof body.recordUsageHistory !== 'boolean') return null;
    next.recordUsageHistory = body.recordUsageHistory;
  }
```

`getSettings` already spreads `cached`, so the field flows out with no further change.

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: the four new cases PASS, every existing case still passes, `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts server/lib/settings.ts test/settings.test.ts
git commit -m "feat(usage): add forecast contract fields and the recording opt-in"
```

---

## Task 2: The pure forecast walk

**Files:**
- Create: `server/lib/usage-forecast.ts`
- Create: `test/usage-forecast.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: `ForecastConfidence` from `shared/types.ts` (Task 1).
- Produces:
  - `interface DutyProfile { weights: (number | null)[]; globalMean: number; trustedCount: number }`
  - `interface ForecastResult { exhaustAtMs: number | null; dutyCycle: number }`
  - `interface WalkOpts { nowMs: number; utilization: number; activeRatePerHour: number; profile: DutyProfile; resetsAtMs: number; offsetMinutes: number }`
  - `function hourOfWeek(ms: number, offsetMinutes: number): number`
  - `function flatProfile(weight: number): DutyProfile`
  - `function weightAt(profile: DutyProfile, hw: number): number`
  - `function walkForward(opts: WalkOpts): ForecastResult`
  - `function confidenceOf(profile: DutyProfile): ForecastConfidence`
  - `function localOffsetMinutes(ms: number): number`
  - `const HOURS_PER_WEEK = 168`

**Design notes the implementer needs:**

- `hourOfWeek` indexes `0 = Sunday 00:00` local, matching `Date.prototype.getUTCDay()`'s numbering. Monday 09:00 is index 33.
- Timezone enters **only** as `offsetMinutes` (minutes east of UTC, so CEST is `+120`). Production supplies `localOffsetMinutes(ms)`, which is `-new Date(ms).getTimezoneOffset()`. Tests pass `0`. This keeps the module pure and the tests independent of the machine's `TZ`.
- **Accepted limitation:** the offset is taken once at `nowMs` and held for the whole walk, so a DST transition inside the window shifts the projection by an hour twice a year. On a projection already uncertain by hours, per-slice recomputation is not worth the complexity. Say so in the module docstring.
- The walk proceeds in slices bounded by local hour boundaries. The first slice is usually partial.
- A zero-weight slice can never produce a crossing — guard the division.

- [ ] **Step 1: Write the failing tests**

Create `test/usage-forecast.test.ts`:

```ts
import assert from 'node:assert';

import {
  hourOfWeek,
  flatProfile,
  weightAt,
  walkForward,
  confidenceOf,
  HOURS_PER_WEEK
} from '../server/lib/usage-forecast.js';
import type { DutyProfile } from '../server/lib/usage-forecast.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;

// Fixed calendar anchors, all UTC so the tests pass offsetMinutes 0.
const FRI_18 = 1_787_940_000_000; // 2026-08-28T18:00:00Z, a Friday
const MON_16 = 1_788_192_000_000; // 2026-08-31T16:00:00Z
const WED_00 = 1_788_307_200_000; // 2026-09-02T00:00:00Z

/** Weight 1 for Mon–Fri 09:00–19:00, 0 everywhere else. */
function officeHours(): DutyProfile {
  const weights: (number | null)[] = new Array(HOURS_PER_WEEK).fill(0);
  for (let day = 1; day <= 5; day++) {
    for (let hour = 9; hour < 19; hour++) weights[day * 24 + hour] = 1;
  }
  return { weights, globalMean: 0.3, trustedCount: HOURS_PER_WEEK };
}

export function run(): number {
  console.log('\n=== usage-forecast.ts ===\n');
  let p = 0, f = 0;

  if (test('hourOfWeek: Sunday 00:00 UTC is 0, Monday 09:00 is 33, Friday 18:00 is 138', () => {
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-30T00:00:00Z'), 0), 0);
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-31T09:00:00Z'), 0), 33);
    assert.strictEqual(hourOfWeek(FRI_18, 0), 138);
  })) p++; else f++;

  if (test('hourOfWeek: a positive offset shifts the index, and it wraps at 168', () => {
    // 23:30 UTC Saturday + 120min = 01:30 Sunday local → index 1.
    assert.strictEqual(hourOfWeek(Date.parse('2026-08-29T23:30:00Z'), 120), 1);
  })) p++; else f++;

  if (test('REGRESSION FLOOR: a flat 1.0 profile reproduces the old closed form', () => {
    // (100 − 60) / 5 = 8h. This is exactly what computePace does today.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 8 * H);
    assert.strictEqual(r.dutyCycle, 1);
  })) p++; else f++;

  if (test('office-hours profile: Friday evening projects into Monday, not Saturday', () => {
    // Fri 18:00→19:00 is 1 active hour → 60 + 5 = 65. Weekend contributes 0.
    // Needs 35 more at 5%/active-hour = 7 active hours into Monday's 09:00 → 16:00.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: officeHours(), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, MON_16);
  })) p++; else f++;

  if (test('office-hours profile: coasting through the reset yields null', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0.5,
      profile: officeHours(), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('crossing lands mid-hour, not snapped to the boundary', () => {
    // Flat 1.0, 90% used, 20%/h → 0.5h.
    const r = walkForward({
      nowMs: FRI_18, utilization: 90, activeRatePerHour: 20,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 0.5 * H);
  })) p++; else f++;

  if (test('crossing exactly on an hour boundary', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 90, activeRatePerHour: 10,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18 + 1 * H);
  })) p++; else f++;

  if (test('already at 100% exhausts now', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 100, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, FRI_18);
  })) p++; else f++;

  if (test('a zero rate never exhausts, and never divides by zero', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0,
      profile: flatProfile(1), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('an all-zero profile never exhausts even at a high rate', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 50,
      profile: flatProfile(0), resetsAtMs: WED_00, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
    assert.strictEqual(r.dutyCycle, 0);
  })) p++; else f++;

  if (test('a reset already in the past yields null, not a backwards walk', () => {
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 5,
      profile: flatProfile(1), resetsAtMs: FRI_18 - H, offsetMinutes: 0
    });
    assert.strictEqual(r.exhaustAtMs, null);
  })) p++; else f++;

  if (test('dutyCycle is the time-weighted mean over the remaining window', () => {
    // Fri 18:00 → Sat 00:00 is 6h: one active hour (18–19), five idle.
    const r = walkForward({
      nowMs: FRI_18, utilization: 60, activeRatePerHour: 0,
      profile: officeHours(), resetsAtMs: FRI_18 + 6 * H, offsetMinutes: 0
    });
    assert.ok(Math.abs(r.dutyCycle - 1 / 6) < 1e-9, 'expected 1/6, got ' + r.dutyCycle);
  })) p++; else f++;

  if (test('weightAt falls back to globalMean for an untrusted bucket', () => {
    const weights: (number | null)[] = new Array(HOURS_PER_WEEK).fill(null);
    weights[33] = 0.9;
    const profile: DutyProfile = { weights, globalMean: 0.4, trustedCount: 1 };
    assert.strictEqual(weightAt(profile, 33), 0.9);
    assert.strictEqual(weightAt(profile, 34), 0.4);
  })) p++; else f++;

  if (test('confidenceOf: none / thin / ok by trusted-bucket count', () => {
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 0 }), 'none');
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 40 }), 'thin');
    assert.strictEqual(confidenceOf({ weights: [], globalMean: 1, trustedCount: 130 }), 'ok');
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
```

- [ ] **Step 2: Register the suite**

In `test/run-all.ts`, add the import alongside the others and call it where the other suites are called:

```ts
import { run as runUsageForecast } from './usage-forecast.test.js';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/lib/usage-forecast.js'`.

- [ ] **Step 4: Implement `usage-forecast.ts`**

Create `server/lib/usage-forecast.ts`. Write it yourself from the interface block and the tests above — the shape is specified, the code is your call. Requirements the tests pin down:

- `HOURS_PER_WEEK = 168`.
- `hourOfWeek(ms, offsetMinutes)` returns `0..167`, `0` = Sunday 00:00 local, computed from the shifted timestamp's UTC day and hour. Must wrap correctly, including for negative offsets.
- `flatProfile(w)` returns all 168 weights set to `w`, `globalMean: w`, `trustedCount: HOURS_PER_WEEK`.
- `weightAt(profile, hw)` returns the bucket weight, or `profile.globalMean` when the bucket is `null` or out of range.
- `walkForward` walks local-hour slices from `nowMs` to `resetsAtMs`, accumulating `activeRatePerHour × weightAt(...) × sliceHours`, returning the interpolated crossing time (rounded to the nearest whole millisecond) or `null`. It also returns `dutyCycle`, the time-weighted mean weight across the whole remaining window — computed over the full window even when the walk exits early, because the client uses it to render a rate, not a projection.
- Edge cases, all asserted above: `resetsAtMs <= nowMs` → `{ exhaustAtMs: null, dutyCycle: 0 }`; `utilization >= 100` → `exhaustAtMs: nowMs`; `activeRatePerHour <= 0` → `null`; a zero-weight slice contributes nothing and cannot produce a crossing.
- `confidenceOf`: `trustedCount === 0` → `'none'`; `< TRUSTED_OK` → `'thin'`; else `'ok'`. Define `const TRUSTED_OK = 120` with a comment: ~120 of 168 buckets is roughly two to three weeks of ordinary use, the point at which the profile's shape stops moving much.
- `localOffsetMinutes(ms)` returns `-new Date(ms).getTimezoneOffset()`. This is the only impure function in the module; keep it a one-liner so the rest stays trivially testable.

Include a module docstring in the house style: what it does, why the timezone is injected rather than read, and the DST limitation.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: all 14 new cases PASS, existing suites unchanged, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/lib/usage-forecast.ts test/usage-forecast.test.ts test/run-all.ts
git commit -m "feat(usage): add the pure duty-cycle forecast walk"
```

---

## Task 3: The pure history core — classification and bucket learning

**Files:**
- Create: `server/lib/usage-history.ts` (pure core only; the I/O shell is Task 4)
- Create: `test/usage-history.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: `DutyProfile`, `HOURS_PER_WEEK`, `hourOfWeek` from `server/lib/usage-forecast.js` (Task 2).
- Produces:
  - `interface UsageSample { t: number; utilization: number; resetsAt: string | null }`
  - `interface Bucket { weight: number | null; weekStamp: string | null; observedMin: number; activeMin: number; lifetimeObservedMin: number }`
  - `interface ProfileState { buckets: Bucket[]; observedWeeks: string[] }`
  - `type IntervalKind = 'active' | 'idle' | 'ambiguous' | 'reset'`
  - `function emptyState(): ProfileState`
  - `function classifyInterval(a: UsageSample, b: UsageSample, maxAttributableMs?: number): IntervalKind`
  - `function isoWeekKey(ms: number, offsetMinutes: number): string`
  - `function accumulate(state: ProfileState, a: UsageSample, b: UsageSample, offsetMinutes: number): ProfileState`
  - `function deriveProfile(state: ProfileState): DutyProfile`
  - `const EWMA_ALPHA = 0.3`, `const TRUST_FLOOR_MIN = 60`, `const MAX_ATTRIBUTABLE_MS = 300_000`

**A refinement the spec's table needs, discovered while planning.** The spec classifies an interval by whether utilization moved. That is incomplete: two samples one minute apart with utilization *rising* are not ambiguous at all — the activity is pinned to that minute, and it is the only way `activeMin` ever grows. Ambiguity is a function of *duration*, not direction. So classification needs a duration threshold:

| Condition | Kind | Accounting |
|---|---|---|
| `resetsAt` differs, or utilization fell by > 0.5 | `reset` | discarded |
| utilization rose by > 0.5, interval ≤ `MAX_ATTRIBUTABLE_MS` | `active` | `observedMin += mins`, `activeMin += mins` |
| utilization rose by > 0.5, interval > `MAX_ATTRIBUTABLE_MS` | `ambiguous` | discarded |
| otherwise (flat, any duration) | `idle` | `observedMin += mins`, `activeMin += 0` |

`MAX_ATTRIBUTABLE_MS = 300_000` (5 minutes) — comfortably above the one-minute sampling cadence, well below any real gap. The flat case has no duration limit, and that is deliberate: an overnight flat interval is exactly the sleep measurement the feature depends on.

The `0.5` epsilon matches the existing utilization-drop check in `recordAndPace` (`usage-pace.ts`).

**Quiet weeks must decay a bucket, not freeze it.** A bucket's weight only moves when
it folds, so an hour that goes quiet stops folding and keeps its old weight forever
while its lifetime evidence keeps it trusted. `ProfileState.observedWeeks` fixes this:
it holds the ISO week keys in which *any* bucket was observed, pruned to the last 26.
On fold, let `k` be the number of entries strictly between the bucket's `weekStamp`
and the current week. Apply the decay first, then the normal fold:

```
// 1. Fold the week whose accumulators are pending (seed if this is the first).
w = weight === null ? ratio : (1 - EWMA_ALPHA) * weight + EWMA_ALPHA * ratio
// 2. Then age it by the observed weeks this bucket sat out, which came after it.
weight = w * (1 - EWMA_ALPHA) ** k
```

**The order is load-bearing and easy to get backwards.** The pending accumulators
belong to the bucket's `weekStamp` week, and the `k` skipped weeks came *after* it — so
they age that week's contribution. Decaying first would age a weight the skipped weeks
predate, and a first-ever fold (`weight === null`) would skip the decay entirely,
leaving a stale seed at full strength. Fold, then decay.

`k` counts only weeks we were recording, so a month of server downtime contributes
`k = 0` and changes nothing, while a month of ordinary use with that hour idle decays
it at the normal half-life. Same principle as the interval table: absence of data is
not evidence of absence, but observed quiet is.

**Interval-spanning.** An interval can cross hour boundaries, so `accumulate` splits it at local hour boundaries and credits each hour-of-week bucket its own share of the minutes. An overnight idle interval therefore teaches eight buckets at once.

- [ ] **Step 1: Write the failing tests**

Create `test/usage-history.test.ts`:

```ts
import assert from 'node:assert';

import {
  emptyState,
  classifyInterval,
  isoWeekKey,
  accumulate,
  deriveProfile,
  MAX_ATTRIBUTABLE_MS,
  TRUST_FLOOR_MIN,
  EWMA_ALPHA
} from '../server/lib/usage-history.js';
import type { UsageSample } from '../server/lib/usage-history.js';
import { HOURS_PER_WEEK } from '../server/lib/usage-forecast.js';

function test(name: string, fn: () => void): boolean {
  try { fn(); console.log('  ✓ ' + name); return true; }
  catch (e) { console.log('  ✗ ' + name); console.log('    ' + (e as Error).message); return false; }
}

const H = 3_600_000;
const MIN = 60_000;
const R1 = '2026-08-28T23:00:00.000Z';
const R2 = '2026-08-29T04:00:00.000Z';
const MON_09 = Date.parse('2026-08-31T09:00:00Z'); // hourOfWeek 33
const FRI_22 = Date.parse('2026-08-28T22:00:00Z'); // hourOfWeek 142

const s = (t: number, utilization: number, resetsAt: string | null = R1): UsageSample =>
  ({ t, utilization, resetsAt });

export function run(): number {
  console.log('\n=== usage-history.ts ===\n');
  let p = 0, f = 0;

  // ── classifyInterval: one test per row of the table ──

  if (test('classify: flat over a minute → idle', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 40)), 'idle');
  })) p++; else f++;

  if (test('classify: flat over eight hours → still idle (the sleep case)', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(8 * H, 40)), 'idle');
  })) p++; else f++;

  if (test('classify: rose within the attributable window → active', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 42)), 'active');
  })) p++; else f++;

  if (test('classify: rose across a long gap → ambiguous', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(4 * H, 55)), 'ambiguous');
  })) p++; else f++;

  if (test('classify: rose exactly at the threshold is still attributable', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MAX_ATTRIBUTABLE_MS, 42)), 'active');
  })) p++; else f++;

  if (test('classify: a changed resetsAt is reset, even with identical utilization', () => {
    assert.strictEqual(classifyInterval(s(0, 40, R1), s(8 * H, 40, R2)), 'reset');
  })) p++; else f++;

  if (test('classify: a fallen utilization is reset', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 10)), 'reset');
  })) p++; else f++;

  if (test('classify: sub-epsilon movement is not a rise', () => {
    assert.strictEqual(classifyInterval(s(0, 40), s(MIN, 40.3)), 'idle');
  })) p++; else f++;

  // ── accumulate ──

  if (test('accumulate: an idle hour credits observed minutes and zero active', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + H, 40), 0);
    assert.strictEqual(st.buckets[33].observedMin, 60);
    assert.strictEqual(st.buckets[33].activeMin, 0);
    assert.strictEqual(st.buckets[33].lifetimeObservedMin, 60);
  })) p++; else f++;

  if (test('accumulate: an active minute credits both counters', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + MIN, 41), 0);
    assert.strictEqual(st.buckets[33].observedMin, 1);
    assert.strictEqual(st.buckets[33].activeMin, 1);
  })) p++; else f++;

  if (test('accumulate: an overnight idle interval teaches every hour it spans', () => {
    // Fri 22:00 → Sat 06:00. Friday is day 5, so 22:00→142 and 23:00→143;
    // Saturday is day 6, so 00:00→144 through 05:00→149. Eight buckets.
    const st = accumulate(emptyState(), s(FRI_22, 40), s(FRI_22 + 8 * H, 40), 0);
    for (const hw of [142, 143, 144, 145, 146, 147, 148, 149]) {
      assert.strictEqual(st.buckets[hw].observedMin, 60, 'bucket ' + hw);
      assert.strictEqual(st.buckets[hw].activeMin, 0, 'bucket ' + hw);
    }
  })) p++; else f++;

  if (test('MUTATION GUARD: an ambiguous interval leaves every counter untouched', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 4 * H, 55), 0);
    const touched = st.buckets.filter((b) => b.observedMin !== 0 || b.activeMin !== 0);
    assert.strictEqual(touched.length, 0);
  })) p++; else f++;

  if (test('MUTATION GUARD: a reset interval leaves every counter untouched', () => {
    // Identical utilization, so only the resetsAt comparison can reject this.
    // Delete that comparison and this test must fail.
    const st = accumulate(emptyState(), s(MON_09, 40, R1), s(MON_09 + 4 * H, 40, R2), 0);
    const touched = st.buckets.filter((b) => b.observedMin !== 0 || b.activeMin !== 0);
    assert.strictEqual(touched.length, 0);
  })) p++; else f++;

  // ── week rollover ──

  if (test('isoWeekKey: same week for two days in it, different across the boundary', () => {
    const mon = Date.parse('2026-08-31T12:00:00Z');
    const tue = Date.parse('2026-09-01T12:00:00Z');
    const prevWeek = Date.parse('2026-08-26T12:00:00Z');
    assert.strictEqual(isoWeekKey(mon, 0), isoWeekKey(tue, 0));
    assert.notStrictEqual(isoWeekKey(mon, 0), isoWeekKey(prevWeek, 0));
  })) p++; else f++;

  if (test('week rollover: the first fold seeds the weight with the raw ratio', () => {
    // Week 1: 30 active of 60 observed in bucket 33 → ratio 0.5.
    let st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 45), 0);
    st = accumulate(st, s(MON_09 + 30 * MIN, 45), s(MON_09 + 60 * MIN, 45), 0);
    assert.strictEqual(st.buckets[33].weight, null, 'not folded until the week turns');
    // A sample in the next week triggers the fold.
    const next = MON_09 + 7 * 24 * H;
    st = accumulate(st, s(next, 40), s(next + MIN, 40), 0);
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - 0.5) < 1e-9,
      'expected 0.5, got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('week rollover: a second fold applies the EWMA rather than replacing', () => {
    // Week 1 ratio 0.5, week 2 ratio 1.0 → 0.7·0.5 + 0.3·1.0 = 0.65.
    let st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 45), 0);
    st = accumulate(st, s(MON_09 + 30 * MIN, 45), s(MON_09 + 60 * MIN, 45), 0);
    const w2 = MON_09 + 7 * 24 * H;
    st = accumulate(st, s(w2, 40), s(w2 + 60 * MIN, 70), 0); // all active
    const w3 = MON_09 + 14 * 24 * H;
    st = accumulate(st, s(w3, 40), s(w3 + MIN, 40), 0);
    const expected = (1 - EWMA_ALPHA) * 0.5 + EWMA_ALPHA * 1;
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - expected) < 1e-9,
      'expected ' + expected + ', got ' + st.buckets[33].weight);
  })) p++; else f++;

  // A rising interval only counts as `active` when it is within
  // MAX_ATTRIBUTABLE_MS, so an active stretch must be fed one minute at a time.
  // Ten active minutes and no idle ones gives that week a ratio of exactly 1.0.
  function activeMinutes(st: ReturnType<typeof emptyState>, startMs: number, mins: number) {
    let cur = st;
    for (let i = 0; i < mins; i++) {
      cur = accumulate(cur, s(startMs + i * MIN, 40 + i), s(startMs + (i + 1) * MIN, 41 + i), 0);
    }
    return cur;
  }

  if (test('quiet weeks decay a bucket rather than freezing it', () => {
    // Week 1: bucket 33 active for ten minutes → that week's ratio is 1.0.
    let st = activeMinutes(emptyState(), MON_09, 10);
    // Weeks 2 and 3: we were recording — a different hour saw traffic — but
    // bucket 33 was idle. Monday 12:00 is hourOfWeek 36.
    const MON_12 = MON_09 + 3 * H;
    for (const wk of [1, 2]) {
      const t = MON_12 + wk * 7 * 24 * H;
      st = accumulate(st, s(t, 40), s(t + MIN, 41), 0);
    }
    // Week 4 touches bucket 33 again, folding week 1 and then ageing it by the
    // two observed weeks it sat out. Thirty idle minutes accumulate for week 4.
    const w4 = MON_09 + 3 * 7 * 24 * H;
    st = accumulate(st, s(w4, 40), s(w4 + 30 * MIN, 40), 0);
    // Week 5 folds week 4's ratio of 0.
    const w5 = MON_09 + 4 * 7 * 24 * H;
    st = accumulate(st, s(w5, 40), s(w5 + MIN, 40), 0);
    const afterW4Fold = 1 * Math.pow(1 - EWMA_ALPHA, 2);          // 0.49
    const expected = (1 - EWMA_ALPHA) * afterW4Fold + EWMA_ALPHA * 0; // 0.343
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - expected) < 1e-9,
      'expected ' + expected + ', got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('MUTATION GUARD: unobserved weeks do not decay (downtime is not idleness)', () => {
    // Week 1 active, nothing recorded anywhere for three weeks, then active again.
    // k must be 0 both times, so two ratio-1.0 folds leave the weight at 1.0.
    // Delete the "only observed weeks count" rule and this drops to 0.49.
    let st = activeMinutes(emptyState(), MON_09, 10);
    const w4 = MON_09 + 3 * 7 * 24 * H;
    st = activeMinutes(st, w4, 10);
    const w5 = MON_09 + 4 * 7 * 24 * H;
    st = accumulate(st, s(w5, 40), s(w5 + MIN, 40), 0);
    assert.ok(Math.abs((st.buckets[33].weight ?? -1) - 1) < 1e-9,
      'downtime must not decay; expected 1, got ' + st.buckets[33].weight);
  })) p++; else f++;

  if (test('observedWeeks is pruned and never grows without bound', () => {
    let st = emptyState();
    for (let wk = 0; wk < 40; wk++) {
      const t = MON_09 + wk * 7 * 24 * H;
      st = accumulate(st, s(t, 40), s(t + MIN, 41), 0);
    }
    assert.ok(st.observedWeeks.length <= 26,
      'expected <= 26 retained weeks, got ' + st.observedWeeks.length);
  })) p++; else f++;

  if (test('week rollover: two samples in the same week do not fold twice', () => {
    let st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 45), 0);
    st = accumulate(st, s(MON_09 + 30 * MIN, 45), s(MON_09 + 60 * MIN, 45), 0);
    assert.strictEqual(st.buckets[33].weight, null);
    assert.strictEqual(st.buckets[33].observedMin, 60, 'accumulators must not reset mid-week');
  })) p++; else f++;

  // ── deriveProfile ──

  if (test('deriveProfile: a bucket under the trust floor reports no weight', () => {
    const st = accumulate(emptyState(), s(MON_09, 40), s(MON_09 + 30 * MIN, 40), 0);
    const next = MON_09 + 7 * 24 * H;
    const folded = accumulate(st, s(next, 40), s(next + MIN, 40), 0);
    // 30 lifetime observed minutes < TRUST_FLOOR_MIN, so untrusted despite a fold.
    assert.ok(TRUST_FLOOR_MIN > 30);
    assert.strictEqual(deriveProfile(folded).weights[33], null);
  })) p++; else f++;

  if (test('deriveProfile: globalMean is 1 when nothing is trusted yet', () => {
    const dp = deriveProfile(emptyState());
    assert.strictEqual(dp.trustedCount, 0);
    assert.strictEqual(dp.globalMean, 1);
  })) p++; else f++;

  if (test('deriveProfile: globalMean averages only the trusted buckets', () => {
    const st = emptyState();
    st.buckets[33] = { weight: 0.8, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 600 };
    st.buckets[34] = { weight: 0.2, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 600 };
    st.buckets[35] = { weight: 0.9, weekStamp: 'x', observedMin: 0, activeMin: 0, lifetimeObservedMin: 10 };
    const dp = deriveProfile(st);
    assert.strictEqual(dp.trustedCount, 2);
    assert.ok(Math.abs(dp.globalMean - 0.5) < 1e-9, 'expected 0.5, got ' + dp.globalMean);
    assert.strictEqual(dp.weights[35], null, 'the thin bucket must not be trusted');
  })) p++; else f++;

  if (test('deriveProfile: always returns 168 weights', () => {
    assert.strictEqual(deriveProfile(emptyState()).weights.length, HOURS_PER_WEEK);
  })) p++; else f++;

  console.log('\n  ' + p + ' passed, ' + f + ' failed');
  return f;
}
```

- [ ] **Step 2: Register the suite**

In `test/run-all.ts`:

```ts
import { run as runUsageHistory } from './usage-history.test.js';
```

Call it alongside the others.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `Cannot find module '../server/lib/usage-history.js'`.

- [ ] **Step 4: Implement the pure core**

Create `server/lib/usage-history.ts` with the pure functions only — no `node:fs` import yet, that arrives in Task 4. Requirements beyond the interface block and the tests:

- `emptyState()` returns 168 fresh buckets, each `{ weight: null, weekStamp: null, observedMin: 0, activeMin: 0, lifetimeObservedMin: 0 }`. Return a fresh array every call; never a shared module-level constant, or one test will pollute the next.
- `accumulate` must not mutate its `state` argument — return a new object. The tests reuse states across cases.
- `isoWeekKey(ms, offsetMinutes)` returns something like `'2026-W35'`. Implement real ISO-8601 week numbering (Thursday-anchored), not `Math.floor(dayOfYear / 7)`, so the fold boundary is stable across year ends. Only equality is ever compared, but a wrong boundary would fold twice in one week or skip one entirely.
- Fold order inside `accumulate`: for each bucket the interval touches, if `bucket.weekStamp !== null && bucket.weekStamp !== currentWeekKey`, fold `activeMin / observedMin` into `weight` via the EWMA (seeding directly with the ratio when `weight === null`), then zero `observedMin`/`activeMin`. Then set `weekStamp = currentWeekKey` and add this interval's minutes. Guard `observedMin === 0` — do not fold a zero-denominator week; leave `weight` as it was.
- `lifetimeObservedMin` accumulates forever and is never reset by a fold. It is the trust floor's input.
- `emptyState()` also returns `observedWeeks: []`. Every `accumulate` that credits any bucket adds the current ISO week key if absent, keeps the list sorted, and prunes to the newest 26 entries.
- Fold **then** decay, in that order (see the block above): fold the pending ratio into `weight` — seeding directly with the ratio when `weight === null` — and only then multiply by `(1 - EWMA_ALPHA) ** k`, where `k` is the count of `observedWeeks` entries strictly between the bucket's `weekStamp` and the current key. The decay applies even to a freshly seeded weight; a bucket with no pending accumulators (`observedMin === 0`) folds nothing and decays nothing.
- `deriveProfile(state)`: `weights[i] = bucket.lifetimeObservedMin >= TRUST_FLOOR_MIN ? bucket.weight : null`; `globalMean` = mean of the non-null weights, or `1` when there are none (weight 1 is the safe pessimistic default — it reproduces today's behaviour); `trustedCount` = the non-null count.

Write the module docstring in the house style: why duration decides ambiguity rather than direction, why a flat overnight interval is the most valuable input the module gets, and why the trust floor is lifetime rather than per-week.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: all 21 new cases PASS.

- [ ] **Step 6: Prove the mutation guards actually guard**

This step produces no commit — it is a verification you must actually run, per the `mutation-prove-security-tests` lesson. A guard test that stays green with the guard removed proves nothing.

1. In `classifyInterval`, temporarily delete the `resetsAt` comparison so a changed reset no longer returns `'reset'`.
2. Run `pnpm test`. The case `MUTATION GUARD: a reset interval leaves every counter untouched` **must fail**. If it passes, the test is worthless — fix the test, not the code.
3. Restore the comparison. Re-run and confirm green.
4. Repeat for the ambiguous branch: make the long-gap-rising case return `'active'` and confirm `MUTATION GUARD: an ambiguous interval...` fails.

Record both outcomes in the commit message.

- [ ] **Step 7: Commit**

```bash
git add server/lib/usage-history.ts test/usage-history.test.ts test/run-all.ts
git commit -m "feat(usage): classify sample intervals and learn hour-of-week buckets"
```

---

## Task 4: The I/O shell — append, tail-read, rotate, atomic profile write

**Files:**
- Modify: `server/lib/usage-history.ts` (add the I/O shell below the pure core)
- Modify: `test/usage-history.test.ts` (add a tmpdir-backed section)

**Interfaces:**
- Consumes: the pure core from Task 3.
- Produces:
  - `const HISTORY_FILE = '.usage-history.jsonl'`, `const PROFILE_FILE = '.usage-profile.json'`
  - `function repoRoot(startDir?: string): string`
  - `function shouldWrite(prev: UsageSample | null, next: UsageSample, heartbeatMs?: number): boolean`
  - `function appendSample(sample: UsageSample, dir?: string): void`
  - `function readRecentSamples(dir?: string, maxBytes?: number): UsageSample[]`
  - `function rotateIfNeeded(dir?: string): void`
  - `function loadProfileState(dir?: string): ProfileState`
  - `function saveProfileState(state: ProfileState, dir?: string): boolean`
  - `const HEARTBEAT_MS = 900_000`, `const MAX_HISTORY_BYTES = 33_554_432`, `const TAIL_BYTES = 262_144`

**Path resolution — a deliberate divergence from `settings.ts`.** `settings.ts` resolves its state file with `path.join(process.cwd(), SETTINGS_FILE)`. Do **not** copy that here. A settings file that resets when you start the server from a different directory is a nuisance; a *history* file that does is a silently corrupted dataset — weeks of learning replaced by an empty file, with no error. `repoRoot()` walks up from `import.meta.dirname` looking for `package.json` and returns that directory, matching the rule the project already applies to guide tooling ("must find the repo root by walking up for `package.json`, never by a fixed `../..` hop count"). Every I/O function takes an optional `dir` override so the tests can point at a tmpdir.

**Both files are gitignored** — add them in Step 1.

- [ ] **Step 1: Gitignore the new state files**

Append to `.gitignore`:

```
.usage-history.jsonl
.usage-profile.json
```

- [ ] **Step 2: Write the failing tests**

Add to `test/usage-history.test.ts`. Add these imports at the top:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  shouldWrite,
  appendSample,
  readRecentSamples,
  rotateIfNeeded,
  loadProfileState,
  saveProfileState,
  HISTORY_FILE,
  PROFILE_FILE,
  HEARTBEAT_MS,
  MAX_HISTORY_BYTES
} from '../server/lib/usage-history.js';
```

Add these cases inside `run()`, before the final `console.log`:

```ts
  // ── I/O shell (tmpdir-backed) ──

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-'));

  if (test('shouldWrite: the first sample always writes', () => {
    assert.strictEqual(shouldWrite(null, s(0, 40)), true);
  })) p++; else f++;

  if (test('shouldWrite: a changed utilization writes', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(MIN, 41)), true);
  })) p++; else f++;

  if (test('shouldWrite: a changed resetsAt writes even at the same utilization', () => {
    assert.strictEqual(shouldWrite(s(0, 40, R1), s(MIN, 40, R2)), true);
  })) p++; else f++;

  if (test('shouldWrite: an unchanged sample inside the heartbeat does not write', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(MIN, 40)), false);
  })) p++; else f++;

  if (test('shouldWrite: an unchanged sample past the heartbeat writes', () => {
    assert.strictEqual(shouldWrite(s(0, 40), s(HEARTBEAT_MS + MIN, 40)), true);
  })) p++; else f++;

  if (test('append then read round-trips samples in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rt-'));
    appendSample(s(1000, 10), dir);
    appendSample(s(2000, 20), dir);
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[0].t, 1000);
    assert.strictEqual(back[1].utilization, 20);
  })) p++; else f++;

  if (test('readRecentSamples on an absent file returns empty, does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-absent-'));
    assert.deepStrictEqual(readRecentSamples(dir), []);
  })) p++; else f++;

  if (test('readRecentSamples skips a truncated leading line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trunc-'));
    // A partial first line is what a tail read produces mid-file.
    fs.writeFileSync(path.join(dir, HISTORY_FILE),
      '{"t":1,"utiliz\n' + JSON.stringify({ t: 2000, utilization: 20, resetsAt: R1 }) + '\n');
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].t, 2000);
  })) p++; else f++;

  if (test('readRecentSamples drops a malformed line without losing the good ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bad-'));
    fs.writeFileSync(path.join(dir, HISTORY_FILE),
      JSON.stringify({ t: 1000, utilization: 10, resetsAt: R1 }) + '\n' +
      'not json at all\n' +
      JSON.stringify({ t: 3000, utilization: 30, resetsAt: R1 }) + '\n');
    const back = readRecentSamples(dir);
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[1].t, 3000);
  })) p++; else f++;

  if (test('profile state round-trips through disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-prof-'));
    const st = emptyState();
    st.buckets[33] = { weight: 0.75, weekStamp: '2026-W35', observedMin: 5, activeMin: 2, lifetimeObservedMin: 600 };
    assert.strictEqual(saveProfileState(st, dir), true);
    const back = loadProfileState(dir);
    assert.strictEqual(back.buckets[33].weight, 0.75);
    assert.strictEqual(back.buckets[33].lifetimeObservedMin, 600);
    assert.strictEqual(back.buckets.length, HOURS_PER_WEEK);
  })) p++; else f++;

  if (test('loadProfileState on an absent file returns an empty state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-noprof-'));
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
    assert.strictEqual(loadProfileState(dir).buckets[0].weight, null);
  })) p++; else f++;

  if (test('loadProfileState on a malformed file falls back rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-badprof-'));
    fs.writeFileSync(path.join(dir, PROFILE_FILE), '{ this is not json');
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
  })) p++; else f++;

  if (test('loadProfileState on a wrong-length bucket array falls back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-shortprof-'));
    fs.writeFileSync(path.join(dir, PROFILE_FILE), JSON.stringify({ buckets: [{ weight: 1 }] }));
    assert.strictEqual(loadProfileState(dir).buckets.length, HOURS_PER_WEEK);
    assert.strictEqual(loadProfileState(dir).buckets[0].weight, null);
  })) p++; else f++;

  if (test('saveProfileState leaves no .tmp file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-atomic-'));
    saveProfileState(emptyState(), dir);
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  })) p++; else f++;

  if (test('rotation trims an oversized log but keeps the newest lines readable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rot-'));
    const file = path.join(dir, HISTORY_FILE);
    const line = JSON.stringify({ t: 1, utilization: 1, resetsAt: R1 }) + '\n';
    // Exceed the cap, ending with a uniquely identifiable newest line.
    fs.writeFileSync(file, line.repeat(Math.ceil(MAX_HISTORY_BYTES / line.length) + 10));
    fs.appendFileSync(file, JSON.stringify({ t: 999_999, utilization: 77, resetsAt: R1 }) + '\n');
    rotateIfNeeded(dir);
    assert.ok(fs.statSync(file).size < MAX_HISTORY_BYTES, 'still oversized after rotation');
    const back = readRecentSamples(dir);
    assert.strictEqual(back[back.length - 1].t, 999_999, 'newest line lost in rotation');
  })) p++; else f++;

  if (test('rotation does not touch a log under the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-norot-'));
    appendSample(s(1000, 10), dir);
    const before = fs.statSync(path.join(dir, HISTORY_FILE)).size;
    rotateIfNeeded(dir);
    assert.strictEqual(fs.statSync(path.join(dir, HISTORY_FILE)).size, before);
  })) p++; else f++;

  if (test('the profile survives rotation of the raw log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rotprof-'));
    const st = emptyState();
    st.buckets[33] = { weight: 0.6, weekStamp: '2026-W35', observedMin: 0, activeMin: 0, lifetimeObservedMin: 900 };
    saveProfileState(st, dir);
    const file = path.join(dir, HISTORY_FILE);
    const line = JSON.stringify({ t: 1, utilization: 1, resetsAt: R1 }) + '\n';
    fs.writeFileSync(file, line.repeat(Math.ceil(MAX_HISTORY_BYTES / line.length) + 10));
    rotateIfNeeded(dir);
    // The learned profile is derived state in its own file; truncating the raw
    // log must not touch it. This is why the EWMA never needs the raw history.
    assert.strictEqual(loadProfileState(dir).buckets[33].weight, 0.6);
    assert.strictEqual(loadProfileState(dir).buckets[33].lifetimeObservedMin, 900);
  })) p++; else f++;

  fs.rmSync(tmp, { recursive: true, force: true });
```

That rotation test writes a 32 MB file to the tmpdir. It is the only slow case in the suite; if it pushes `pnpm test` past a few seconds, shrink it by giving `rotateIfNeeded` an optional `maxBytes` parameter and passing a small value, rather than by deleting the case.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — the new symbols are not exported.

- [ ] **Step 4: Implement the I/O shell**

Add to `server/lib/usage-history.ts`. Requirements:

- `repoRoot(startDir = import.meta.dirname)` walks up until it finds a directory containing `package.json`; returns that directory. If it reaches the filesystem root without finding one, fall back to `process.cwd()` — never throw.
- `shouldWrite(prev, next, heartbeatMs = HEARTBEAT_MS)`: true when `prev === null`, when `next.utilization` differs from `prev.utilization` by more than 0.01, when `resetsAt` differs, or when `next.t - prev.t >= heartbeatMs`.
- `appendSample` serialises one compact JSON object per line with a trailing newline, `fs.appendFileSync`. Wrap in try/catch and swallow — a read-only filesystem must not break the poll.
- `readRecentSamples(dir, maxBytes = TAIL_BYTES)` reads at most the last `maxBytes` using a file handle and `fs.readSync` with a position (the same approach `lib/transcript.ts` uses), splits on newlines, discards the first element when the read started mid-file, `JSON.parse`es each line inside a try/catch, and keeps only objects with a numeric `t` and numeric `utilization`. Returns oldest-first.
- `rotateIfNeeded(dir, maxBytes = MAX_HISTORY_BYTES)`: when the file exceeds `maxBytes`, read the last `maxBytes / 2` bytes, drop the partial first line, and rewrite the file with that content. Must preserve the newest lines — the test asserts it.
- `loadProfileState`: parse, then validate that `buckets` is an array of exactly `HOURS_PER_WEEK` entries and coerce each field to the right type; anything else returns `emptyState()`. Absent, malformed, or wrong-shaped all fall back silently.
- `saveProfileState`: write to `<PROFILE_FILE>.tmp` then `fs.renameSync` over the real path. Returns `true` on success, `false` on failure — mirroring the `persisted` flag pattern in `settings.ts`. Clean up the tmp file if the rename fails.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: all new cases PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/usage-history.ts test/usage-history.test.ts .gitignore
git commit -m "feat(usage): persist usage samples and the learned profile"
```

---

## Task 5: Wiring — the recording timer, rehydration, and the forecast handoff

**Files:**
- Modify: `server/lib/usage-pace.ts`
- Modify: `server/lib/usage.ts` (the `refreshNow` success path, ~line 221-250)
- Modify: `server/index.ts`
- Test: `test/usage-pace.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `usage-pace.ts` exports `function setForecastProfile(p: DutyProfile | null): void` and keeps `recordAndPace(win, rl, now?)` with its existing signature.
  - `usage-pace.ts` exports `function seedSamples(win: PaceWindow, samples: PaceSample[]): void` for rehydration.
  - `usage-history.ts` gains `function recordTick(sample: UsageSample): void` — the single entry point the timer and the refresh path both call.
  - `server/index.ts` exports nothing new; it starts the interval.

**How the pieces meet.** `recordAndPace` keeps computing the active rate exactly as it does today. For the `sevenDay` window only, it additionally calls `walkForward` twice — once with the current profile and once with `flatProfile(1)` — and attaches `projectedExhaustAt` (profile walk), `pessimisticExhaustAt` (flat walk), `dutyCycle`, and `forecastConfidence`. For `fiveHour` it attaches nothing new: duty cycle inside a five-hour window is ~1 by construction (spec decision 3), and its existing `projectedExhaustAt` stays the closed-form one.

**When confidence is `none`, `projectedExhaustAt` must equal the flat walk.** That is the regression floor, and Step 1 tests it.

- [ ] **Step 1: Write the failing tests**

Add to `test/usage-pace.test.ts`, following the existing style in that file:

```ts
  if (test('REGRESSION FLOOR: with no profile, the weekly projection is the flat one', () => {
    resetPaceStore();
    setForecastProfile(null);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 60 * 60_000);
    const rl = recordAndPace('sevenDay', { utilization: 45, resetsAt }, NOW);
    assert.strictEqual(rl.forecastConfidence, 'none');
    assert.strictEqual(rl.projectedExhaustAt, rl.pessimisticExhaustAt);
  })) p++; else f++;

  if (test('a night-heavy profile pushes the weekly projection out past the flat one', () => {
    resetPaceStore();
    // Half the hours idle → the profile walk must reach 100% strictly later.
    setForecastProfile(flatProfile(0.5));
    const resetsAt = new Date(NOW + 120 * H).toISOString();
    recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW - 60 * 60_000);
    const rl = recordAndPace('sevenDay', { utilization: 45, resetsAt }, NOW);
    assert.ok(rl.projectedExhaustAt, 'expected a projection');
    assert.ok(rl.pessimisticExhaustAt, 'expected a pessimistic edge');
    assert.ok(Date.parse(rl.projectedExhaustAt!) > Date.parse(rl.pessimisticExhaustAt!),
      'the duty-cycle projection must be the later of the two');
  })) p++; else f++;

  if (test('the 5h window gains no forecast fields', () => {
    resetPaceStore();
    setForecastProfile(flatProfile(0.5));
    const resetsAt = new Date(NOW + 3 * H).toISOString();
    recordAndPace('fiveHour', { utilization: 20, resetsAt }, NOW - 10 * 60_000);
    const rl = recordAndPace('fiveHour', { utilization: 30, resetsAt }, NOW);
    assert.strictEqual(rl.dutyCycle, undefined);
    assert.strictEqual(rl.pessimisticExhaustAt, undefined);
  })) p++; else f++;

  if (test('seedSamples restores enough history to produce a pace immediately', () => {
    resetPaceStore();
    setForecastProfile(null);
    const resetsAt = new Date(NOW + 48 * H).toISOString();
    seedSamples('sevenDay', [
      { t: NOW - 6 * H, utilization: 30 },
      { t: NOW - 3 * H, utilization: 35 }
    ]);
    // A single fresh sample would normally be too thin for a slope.
    const rl = recordAndPace('sevenDay', { utilization: 40, resetsAt }, NOW);
    assert.ok(rl.ratePerHour != null && rl.ratePerHour > 0, 'expected a rate from seeded history');
  })) p++; else f++;
```

Add the needed imports to that test file: `setForecastProfile`, `seedSamples` from `usage-pace.js`, and `flatProfile` from `usage-forecast.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `setForecastProfile` and `seedSamples` are not exported.

- [ ] **Step 3: Wire `usage-pace.ts`**

- Add a module-level `let forecastProfile: DutyProfile | null = null` and `setForecastProfile`.
- Add `seedSamples(win, samples)`: replaces the ring for that window with the given samples, sorted by `t` and capped at that window's `MAX_SAMPLES`. Used only at boot.
- Make `MAX_SAMPLES` per-window in the `WINDOWS` config: `fiveHour: 720`, `sevenDay: 2016` (7 days at 5-minute resolution). Replace the module-level constant.
- In `recordAndPace`, after computing `pace`, for `win === 'sevenDay'` and when `pace` is non-null and `rl.resetsAt` parses, compute both walks and attach the four new fields. Supply `offsetMinutes: localOffsetMinutes(now)` — this is the one place production reads the machine's timezone, which is exactly why `walkForward` takes it as a parameter rather than reading it itself. `projectedExhaustAt` becomes the profile walk's result when `forecastProfile` is non-null, else the flat walk's. `forecastConfidence` is `confidenceOf(forecastProfile)` or `'none'`.
- Update the `ratePerHour` docstring in `shared/types.ts` to say **percent per active hour**, and note that the weekly window's rate must be multiplied by `dutyCycle` to get a per-wall-hour figure. This is the one silent semantic change in the design — the spec flags it, and Task 6 depends on it being written down.

- [ ] **Step 4: Wire `usage.ts`**

In the success path of `refreshNow()`, after the usage is mapped and before/alongside the existing `recordAndPace` calls, when `getSettings().recordUsageHistory` is true:

- Build a `UsageSample` from the **five-hour** window (`{ t: now, utilization, resetsAt }`) — the 5h window is the sensor, per spec decision 3.
- Note the resolution asymmetry, and do not try to "fix" it. Learning happens **live**, on every one-minute tick, against the in-memory previous sample — so the profile always learns at full sampling resolution. The *log* is sparser (write-on-change plus a heartbeat), which is fine for charts and for rehydrating the pace ring, but means rebuilding a profile from the log alone would be lossy: a flat stretch that ends in a rise gets written as one long rising interval, which classifies as `ambiguous` and is discarded. The profile file is the profile's source of truth; the log is not a replayable substitute for it.
- Call `recordTick(sample)`, which is the one function that owns the write path: it keeps the last-written sample in memory, consults `shouldWrite`, appends when true, calls `accumulate` against the in-memory `ProfileState` using the previous sample, calls `saveProfileState` at most every `HEARTBEAT_MS`, and calls `rotateIfNeeded` on save. Implement `recordTick` in `usage-history.ts`, not here — `usage.ts` should gain about three lines.
- Push the freshly derived profile into `usage-pace.ts` via `setForecastProfile(deriveProfile(state))`.

Wrap the whole block in try/catch. Recording must never break the usage fetch — the fail-open invariant.

- [ ] **Step 5: Boot-time rehydration and the timer**

In `server/index.ts`, after the server starts listening:

```ts
// Usage-history recording (opt-in). Rehydrate the pace ring from disk so the
// weekly slope survives a restart, then sample on our own interval — the
// /api/sessions poll only fires while a browser is open, which would make the
// recorded history describe when the dashboard was watched rather than when
// work happened. See docs/subsystems/usage-limits.md.
if (config.showUsage) startUsageRecording();
```

`startUsageRecording` belongs in `usage-history.ts`. It must:

- On call, if `getSettings().recordUsageHistory`, load the profile state and seed both pace rings from `readRecentSamples`, converting each `UsageSample` to a `PaceSample`.
- Start `setInterval(..., 60_000)` and call `.unref()` on the handle so the interval never holds the process open.
- **Re-read the setting on every tick**, so toggling it in Settings takes effect without a restart. When off, the tick returns immediately without touching the network.
- Each active tick calls the same non-blocking refresh the poll uses, so there is exactly one code path that fetches from Anthropic.
- Export `stopUsageRecording()` that clears the interval. The interval is already `unref()`'d so it cannot hold the process open; this exists for a graceful shutdown path and so a future test can stop sampling deterministically.

- [ ] **Step 6: Run the tests, typecheck, and check it end to end**

Run: `pnpm test && pnpm typecheck`
Expected: all cases PASS, typecheck clean.

Then, manually: `pnpm dev`, open the dashboard, confirm the header bars still render. Turn the recording toggle on (Task 6 adds the UI; until then flip it with
`curl -X POST localhost:4173/api/settings -H 'content-type: application/json' -d '{"recordUsageHistory":true}'`,
adjusting the port to whatever you are running). Confirm `.usage-history.jsonl` appears at the repo root and grows, and that `.usage-profile.json` appears within 15 minutes.

**Report honestly what you could not verify.** The profile is worthless until roughly two weeks of buckets exist, so no manual check can confirm the projection is *correct* — only that the plumbing runs. Say so.

- [ ] **Step 7: Commit**

```bash
git add server/lib/usage-pace.ts server/lib/usage.ts server/lib/usage-history.ts server/index.ts shared/types.ts test/usage-pace.test.ts
git commit -m "feat(usage): forecast the weekly window from the learned profile"
```

---

## Task 6: Client — the band, the corrected rate text, and the toggle

**Files:**
- Modify: `client/src/lib/pace.ts`
- Modify: `client/src/components/Header.tsx` (`TimeStrip`, ~line 97-118)
- Modify: `client/src/styles.css` (after line 200, the `.u-tick` block)
- Modify: `client/src/components/settings/SettingsView.tsx`
- Test: `test/pace-view.test.ts` (extend)

**Interfaces:**
- Consumes: `RateLimit.pessimisticExhaustAt`, `.dutyCycle`, `.forecastConfidence` (Task 1); the server behaviour from Task 5.
- Produces: `PaceView` gains `wallPctPessimistic: number | null` and `confidence: ForecastConfidence`.

**The bug this task must not reproduce.** `fmtRate` (`client/src/lib/pace.ts:33`) multiplies `ratePerHour` by 24 for the weekly window to print `%/day`. After Task 5, `ratePerHour` is percent per *active* hour, so that multiplication now overstates the daily figure by `1/dutyCycle` — roughly 3.4× at a typical duty cycle. It must become `ratePerHour × dutyCycle × 24`, falling back to the old formula when `dutyCycle` is absent.

- [ ] **Step 1: Write the failing tests**

Add to `test/pace-view.test.ts`:

```ts
  if (test('weekly rate text is corrected by the duty cycle', () => {
    const weekReset = new Date(NOW + 48 * H).toISOString();
    const v = paceView(
      { utilization: 40, resetsAt: weekReset, ratePerHour: 5, dutyCycle: 0.25, projectedExhaustAt: null },
      SEVEN_DAY_MS,
      NOW
    )!;
    // 5 %/active-hour × 0.25 × 24h = 30 %/day, not 120.
    assert.strictEqual(v.rateText, '30%/day');
  })) p++; else f++;

  if (test('weekly rate text falls back to the flat formula without a duty cycle', () => {
    const weekReset = new Date(NOW + 48 * H).toISOString();
    const v = paceView(
      { utilization: 40, resetsAt: weekReset, ratePerHour: 5, projectedExhaustAt: null },
      SEVEN_DAY_MS,
      NOW
    )!;
    assert.strictEqual(v.rateText, '120%/day');
  })) p++; else f++;

  if (test('the pessimistic tick is placed on the time axis', () => {
    const resetsAt = new Date(NOW + 3 * H).toISOString();
    const v = paceView(
      {
        utilization: 35, resetsAt, ratePerHour: 22,
        projectedExhaustAt: new Date(NOW + 2.5 * H).toISOString(),
        pessimisticExhaustAt: new Date(NOW + 1 * H).toISOString(),
        forecastConfidence: 'ok'
      },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.wallPct, 90);   // (5h − 0.5h)/5h
    assert.strictEqual(v.wallPctPessimistic, 60); // (2h + 1h)/5h
    assert.strictEqual(v.confidence, 'ok');
  })) p++; else f++;

  if (test('a pessimistic edge after the reset is dropped, like the optimistic one', () => {
    const resetsAt = new Date(NOW + 3 * H).toISOString();
    const v = paceView(
      {
        utilization: 35, resetsAt, ratePerHour: 1,
        projectedExhaustAt: new Date(NOW + 30 * H).toISOString(),
        pessimisticExhaustAt: new Date(NOW + 20 * H).toISOString(),
        forecastConfidence: 'thin'
      },
      FIVE_HOUR_MS,
      NOW
    )!;
    assert.strictEqual(v.verdict, 'lasts');
    assert.strictEqual(v.wallPct, null);
    assert.strictEqual(v.wallPctPessimistic, null);
  })) p++; else f++;

  if (test('confidence defaults to none when the server sends nothing', () => {
    const resetsAt = new Date(NOW + 3 * H).toISOString();
    const v = paceView({ utilization: 35, resetsAt }, FIVE_HOUR_MS, NOW)!;
    assert.strictEqual(v.confidence, 'none');
    assert.strictEqual(v.wallPctPessimistic, null);
  })) p++; else f++;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `rateText` is `'120%/day'` where `'30%/day'` is expected, and `wallPctPessimistic` / `confidence` are undefined.

- [ ] **Step 3: Update `pace.ts`**

- Add `wallPctPessimistic: number | null` and `confidence: ForecastConfidence` to `PaceView`, documented in the house style.
- Change `fmtRate` to take the duty cycle: `fmtRate(perHour, windowMs, dutyCycle)`. For the per-day branch, multiply by `dutyCycle ?? 1` before the `× 24`. Leave the per-hour branch alone — the 5h window's rate is already per wall hour in practice.
- Compute `wallPctPessimistic` with the same clamp-and-drop logic already applied to `wallPct`: parse `pessimisticExhaustAt`, and return `null` when it is absent, unparseable, or lands at or after the reset.
- Default `confidence` to `rl.forecastConfidence ?? 'none'` in every return path, including the early one where `ratePerHour` is null.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: the five new cases PASS, the existing `pace-view` cases still pass. Note the existing case `elapsedPct: 2h into a 5h window → 40` and its neighbours must be untouched — if any existing case changed, the duty-cycle fallback is wrong.

- [ ] **Step 5: Render the band**

In `Header.tsx`'s `TimeStrip`, add a band element *before* the tick elements so the ticks paint over it, and a pessimistic tick:

```tsx
          {view.wallPct != null && view.wallPctPessimistic != null && view.confidence !== 'ok' && (
            <div
              className="u-band"
              style={{
                left: `${Math.min(view.wallPct, view.wallPctPessimistic)}%`,
                width: `${Math.abs(view.wallPct - view.wallPctPessimistic)}%`
              }}
            />
          )}
```

and, after the existing wall tick:

```tsx
          {view.wallPctPessimistic != null && (
            <div className="u-tick wall-pessimistic" style={{ left: `${view.wallPctPessimistic}%` }} />
          )}
```

The band is drawn only while confidence is *not* `'ok'` — once the profile is trustworthy the two ticks converge in meaning and a band would imply doubt that is no longer there. Both ticks always render, so the user can always see both edges.

Also extend the `title` string in `UsageBar` so the mechanics stay stated in words, as they are today. Append, when `rl.dutyCycle != null`:

```
 · working ~NN% of the hours left
```

where `NN` is `Math.round(rl.dutyCycle * 100)`.

- [ ] **Step 6: Style the band and the second tick**

In `client/src/styles.css`, immediately after the `.usage .u-tick.wall` rule (line 200):

```css
.usage .u-tick.wall-pessimistic{width:1px;background:var(--red);opacity:.45}
.usage .u-band{position:absolute;top:-2px;height:7px;background:var(--red);opacity:.14}
```

Both use `var(--red)` and opacity only — no literal color, so all five themes keep working. Verify by switching themes in Settings; the band must remain visible in the light theme.

- [ ] **Step 7: Add the recording toggle to Settings**

In `SettingsView.tsx`, add a row in the same style as the existing notify toggles (`value={... ? 'on' : 'off'}`), posting `{ recordUsageHistory: <bool> }` to `/api/settings` through whatever mutation helper the neighbouring rows use. Copy requirements — write these exactly, because the honesty of the opt-in is the point:

- Label: `Record usage history`
- Help text: `Samples your account usage to disk so the weekly forecast can learn which hours you actually work. While on, the server contacts Anthropic about once a minute even with no browser open. Needs ~2 weeks of data before the forecast improves.`

- [ ] **Step 8: Verify in the browser**

Run: `pnpm dev`, open the dashboard.
Check: bars render; the weekly `%/day` figure is plausible rather than 3× too high; both ticks appear once the server has a projection; the band shows while confidence is below `ok`; the Settings toggle flips and persists across a reload; switch to the light theme and confirm the band is still visible.

**State plainly what remains unverified:** with an empty profile the band's two edges coincide, so the band's *appearance* can be confirmed but its *accuracy* cannot — that needs weeks of real data. Do not claim the forecast is correct.

- [ ] **Step 9: Commit**

```bash
git add client/src/lib/pace.ts client/src/components/Header.tsx client/src/styles.css client/src/components/settings/SettingsView.tsx test/pace-view.test.ts
git commit -m "feat(usage): draw the forecast band and correct the weekly rate text"
```

---

## Task 7: The profile inspector (mockup variant C)

**Files:**
- Modify: `shared/types.ts`
- Modify: `server/api.ts` (a new handler), `server/index.ts` (the route)
- Modify: `server/lib/usage-history.ts` (one read-only accessor)
- Create: `client/src/components/analytics/UsageProfile.tsx`
- Create: `client/src/hooks/useUsageProfile.ts`
- Modify: `client/src/components/analytics/AnalyticsView.tsx`, `client/src/styles.css`
- Create: `test/usage-profile-api.test.ts`; Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: `deriveProfile`, `loadProfileState` (Task 3/4); `walkForward`, `confidenceOf`, `localOffsetMinutes` (Task 2); `getCachedUsageState` (existing).
- Produces:
  - `interface UsageProfileCell { hourOfWeek: number; weight: number | null; observedMin: number; staleWeeks: number }`
  - `interface ForecastStep { t: string; gain: number }`
  - `interface UsageProfileResponse { cells: UsageProfileCell[]; globalMean: number; confidence: ForecastConfidence; recording: boolean; walk: ForecastStep[]; exhaustAt: string | null }`
  - `usage-history.ts` exports `function profileSnapshot(): ProfileState`

**Why this exists.** The forecast silently changes a number the user acts on, using a
model built in the background. Without an inspector, a wrong projection is
undebuggable — the only recourse is reading `.usage-profile.json` by hand. The 168
weights *are* the explanation. This is disclosure, not decoration.

**Scope boundary.** This shows the *learned profile* and the walk that produced the
current projection. It is **not** idea-5's usage-history charts (utilization over days
and weeks, read from the raw JSONL) — those stay in
`backlog/ideas/open/idea-5-long-term-5h-weekly-usage-history.md`.

**Read the `dataviz` skill before writing any chart code.** A 7×24 heatmap is squarely
in its scope. The constraints it imposes, already resolved for you:

- **Form:** heatmap for grid magnitude → **sequential, one hue**. Never a multi-hue ramp.
- **Ramp:** `color-mix(in oklab, var(--cyan) N%, var(--strip))` at N = 20/40/60/80/100.
  Monotonic by construction in every theme (verified: steps 0.098–0.133 across
  midnight, graphite, amber, paper). Do **not** hand-pick hex values — that would break
  the no-hardcoded-color rule and can't be validated for five themes.
- **Evidence is not a second hue.** An untrusted cell has *no value*, not a low one, so
  it gets texture (`repeating-linear-gradient` in `var(--hairline)`) and a dashed
  border. Hue-coding confidence reads as a rainbow ramp and treats confidence as a
  magnitude on the same scale as weight, which it isn't.
- **A scale legend is mandatory** with a sequential ramp, and must include the
  no-evidence swatch.
- **Per-cell hover tooltip** and **a table view** are both required, not optional: the
  two lowest ramp steps fall below 3:1 contrast against the card surface, and that WARN
  obligates relief.
- **2px gap between cells**, 1px `var(--hairline)` border so the grid reads even at
  weight 0.

- [ ] **Step 1: Add the response contract**

In `shared/types.ts`, after the `ForecastConfidence` type from Task 1:

```ts
/** One hour-of-week bucket, as shown in the profile inspector. */
export interface UsageProfileCell {
  /** 0–167, where 0 is Sunday 00:00 in the host's local timezone. */
  hourOfWeek: number;
  /**
   * 0–1 expected active share of that hour, or null when the bucket has under
   * an hour of accumulated evidence and the forecast falls back to the mean.
   */
  weight: number | null;
  /** Accumulated observed minutes across all weeks. Caps at 60 per week. */
  observedMin: number;
  /** Observed weeks since this bucket last folded. 0 when current. */
  staleWeeks: number;
}

/** One hour of the forward walk behind the current weekly projection. */
export interface ForecastStep {
  /** ISO 8601 start of the hour. */
  t: string;
  /** Percentage points this hour is expected to add. */
  gain: number;
}

/** `GET /api/usage/profile` — read-only. Never includes raw samples. */
export interface UsageProfileResponse {
  cells: UsageProfileCell[];
  /** Fallback weight for untrusted buckets. */
  globalMean: number;
  confidence: ForecastConfidence;
  /** False when the recording setting is off — the view says so rather than showing an empty grid. */
  recording: boolean;
  /** The walk from now to the weekly reset. Empty when there is no projection. */
  walk: ForecastStep[];
  /** ISO 8601 crossing time, or null when the window coasts to its reset. */
  exhaustAt: string | null;
}
```

- [ ] **Step 2: Write the failing endpoint test**

Create `test/usage-profile-api.test.ts`. Test the handler's pure shaping function, not
the HTTP layer — follow whatever `test/api-body.test.ts` already does for this.
Required cases:

```
- recording off        → { recording: false, cells: 168 entries, confidence: 'none', walk: [] }
- empty profile        → 168 cells, every weight null, globalMean 1, confidence 'none'
- a seeded profile     → the trusted bucket's weight round-trips; a thin bucket reports
                         weight null but its real observedMin
- staleWeeks           → a bucket whose last fold was 3 observed weeks ago reports 3
- walk length          → one step per hour from now to resetsAt, never more than 168
- no weekly resetsAt   → walk is [] and exhaustAt is null, and the handler does not throw
```

Assert exact values, and assert `cells.length === 168` in every case — a short array
would silently render a torn grid.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — the handler does not exist.

- [ ] **Step 4: Implement the endpoint**

- `usage-history.ts` gains `profileSnapshot()` returning the in-memory `ProfileState`
  (loading from disk if not yet loaded). Read-only; no mutation.
- `server/api.ts` gains the handler. It derives the profile, maps buckets to cells,
  reads the current weekly `RateLimit` from `getCachedUsageState()`, and recomputes the
  walk with `walkForward` to emit per-hour gains. Fail open: any error returns
  `recording: false` with 168 null cells rather than a 500.
- `server/index.ts` routes `GET /api/usage/profile`. Place it with the other `/api/*`
  routes, before the static fallback.
- **The response must never include raw samples or file paths** — the same posture as
  `NTFY_TOPIC` never leaving the server. Cells and the walk only.

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Build the view**

`client/src/hooks/useUsageProfile.ts` fetches once per mount — unpolled, like
`hooks/useGuides`. This data changes on a weekly cadence; a 3s poll would be absurd.

`client/src/components/analytics/UsageProfile.tsx` renders, using the mockup as the
reference implementation (`docs/guides/mockups/usage-profile-heatmap-mockups.html`,
variant C — the grid plus the forward-walk strip beneath it):

- 24 rows × 7 columns — **hours as rows**. This is variant B's orientation, chosen so
  the axis needing 24 slots runs the direction a phone actually has.
- Beneath it, the walk strip: one bar per hour, height proportional to `gain`, flat
  `var(--hairline)` stubs for idle hours, and the crossing labelled from `exhaustAt`.
  The visible weekend gap is the feature explaining itself — do not compress it away.
- `recording: false` renders a short explanation and a pointer to the Settings toggle,
  never an empty grid.
- `confidence` shown in words next to the legend, with the honest caveat that a `thin`
  profile is expected for the first couple of weeks.

Copy the mockup's tooltip wording, including the weeks-not-minutes phrasing and the
"falls back to the weekly mean" line for untrusted cells. That wording exists because
the earlier version was actively misleading.

- [ ] **Step 7: Add it to the Analytics tab**

Mount the component as a section in `AnalyticsView.tsx`. It inherits that tab's
existing lazy chunk, so no new route or rail entry. A whole side-rail tab for one grid
is not warranted when the rail already has five entries.

- [ ] **Step 8: Styles**

Add to `client/src/styles.css`, below the theme-token block, using only tokens and
`color-mix`:

```css
.up-grid{display:grid;gap:2px}
.up-cell{border:1px solid var(--hairline);border-radius:2px;aspect-ratio:1}
.up-cell.q1{background:color-mix(in oklab,var(--cyan) 20%,var(--strip))}
.up-cell.q2{background:color-mix(in oklab,var(--cyan) 40%,var(--strip))}
.up-cell.q3{background:color-mix(in oklab,var(--cyan) 60%,var(--strip))}
.up-cell.q4{background:color-mix(in oklab,var(--cyan) 80%,var(--strip))}
.up-cell.q5{background:var(--cyan)}
.up-cell.unknown{background:repeating-linear-gradient(135deg,var(--hairline) 0 2px,transparent 2px 5px);border-style:dashed}
```

Not a single literal color, so all five themes hold.

- [ ] **Step 9: Verify in the browser**

Run: `pnpm dev`, open Analytics.
Check: 168 cells render in a 24×7 grid with no torn row; the legend includes the
no-evidence swatch; tooltips report weeks; the table view toggles; the walk strip shows
visible idle stubs; **cycle all five themes** and confirm the ramp stays legible in
each — the light theme is the one that breaks.

State what you did not verify: with an empty profile every cell is hatched, so the
ramp's *appearance* can only be checked by seeding a fake profile file. Do that
deliberately and say you did.

- [ ] **Step 10: Commit**

```bash
git add shared/types.ts server/api.ts server/index.ts server/lib/usage-history.ts \
  client/src/components/analytics/UsageProfile.tsx client/src/hooks/useUsageProfile.ts \
  client/src/components/analytics/AnalyticsView.tsx client/src/styles.css \
  test/usage-profile-api.test.ts test/run-all.ts
git commit -m "feat(usage): add the duty-cycle profile inspector"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/subsystems/usage-limits.md`
- Modify: `docs/subsystems/settings.md`
- Modify: `.claude/CLAUDE.md` (the `server/` and `client/` file maps)
- Modify: `backlog/ideas/open/idea-5-long-term-5h-weekly-usage-history.md`

**Interfaces:** consumes the finished implementation. Produces no code.

- [ ] **Step 1: Update `docs/subsystems/usage-limits.md`**

Add a section after *Pace + the time strip* covering: the profile inspector and its endpoint (`GET /api/usage/profile`, read-only, never returns raw samples); the active-rate / duty-cycle split; that the 5h window is the sensor and the weekly window the prediction, and why (the weekly reset mechanism is documented in that same file as unproven); the interval classification table from Task 3; that a flat overnight interval is the most valuable input; the two state files and that path resolution walks up for `package.json` rather than using cwd; the opt-in timer and its unattended-polling consequence; and the DST limitation.

Update the ⚠️ **Unproven** block: the weekly window's length is still assumed to be 7 days, and now a second thing depends on it — the walk's horizon. Say so.

Then re-baseline the `docs-sync` provenance stamp at the bottom: add `server/lib/usage-forecast.ts` and `server/lib/usage-history.ts` to `sources`, and set `verified` to the branch's HEAD commit.

- [ ] **Step 2: Update `docs/subsystems/settings.md`**

Document `recordUsageHistory`: what it turns on, that it defaults off, and why it is a server-side setting rather than a per-device one (a per-device toggle cannot start a server-side timer). Re-baseline its stamp.

- [ ] **Step 3: Update the file maps in `.claude/CLAUDE.md`**

Add one line each, in the established terse style:

```
  lib/usage-forecast.ts  pure forward walk: activeRate × hour-of-week weight → projected
                  100%, plus the flat-profile pessimistic edge (see docs/subsystems/usage-limits.md)
  lib/usage-history.ts  persisted usage samples → learned 168-bucket duty-cycle profile;
                  a flat overnight interval is an idle *measurement*, not missing data
```

and on the client side:

```
  components/analytics/UsageProfile.tsx  the duty-cycle inspector: a 24×7 hour-of-week
                  heatmap over the learned weights plus the forward walk behind the
                  current weekly projection (hooks/useUsageProfile, fetched once per
                  mount; ramp derived with color-mix so all five themes hold)
```

- [ ] **Step 4: Update backlog idea-5**

The idea's first half (persist utilization samples) is now built. Do **not** move or close the file by hand — that is `backlog-groom`'s job. Add a short note under *Rough shape* recording that persistence landed via this work, naming the spec and the two state files, so whoever grooms it next knows only the history-view half remains.

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/usage-limits.md docs/subsystems/settings.md .claude/CLAUDE.md backlog/ideas/open/idea-5-long-term-5h-weekly-usage-history.md
git commit -m "docs(usage): document duty-cycle forecasting and the recording opt-in"
```

---

## Final verification before the PR

- [ ] `pnpm test` — paste the case count into the PR body. Never claim green without the output.
- [ ] `pnpm typecheck` — must be clean.
- [ ] `pnpm build` — the client must still bundle.
- [ ] Confirm `.usage-history.jsonl` and `.usage-profile.json` are gitignored and absent from `git status`.
- [ ] Confirm recording defaults to **off** on a fresh `.dashboard-settings.json` (delete it and restart).
- [ ] Re-run the Task 3 Step 6 mutation checks once more on the final code, and state both outcomes in the PR.
- [ ] Cycle all five themes with the inspector open. The light theme is the one a colour mistake shows up in.

**PR body** follows `.github/pull_request_template.md`: Conventional Commits title, a lead in user terms, *Why this shape* / *What changed* grouped by boundary (Server / Client / Docs) / *Verification*. Two rules are load-bearing here:

- **State what you did not verify.** The honest line: the plumbing is proven and every pure function is tested, but the forecast's *accuracy* is unproven — it needs roughly two weeks of real samples, and no test can substitute for that. Say it plainly.
- **Never claim green without the command output.**
