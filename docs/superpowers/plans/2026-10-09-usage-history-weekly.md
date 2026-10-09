# Usage History — weekly fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Usage → History's two-panel step chart with the mock's "weekly fill": one bar per weekly window, filled day by day up to the weekly limit.

**Architecture:** Client-only. A pure `weekRows()` in `client/src/lib/usageHistory.ts` turns the unchanged `UsageHistoryResponse` into rows of day segments; `UsageHistory.tsx` draws them as hand-built SVG at the measured width with the shared `useFloatingTip` tooltip. Server, endpoint and `shared/types.ts` do not change.

**Tech Stack:** React + TypeScript (Vite), node-assert tests run by `pnpm test` (`test/run-all.ts` via tsx).

**Spec:** `docs/guides/mockups/redesign-mock.html` — the `#p-history` page and the `USAGE HISTORY` block in its `<script>` (`chart()`, `heldAt`, `lastReadT`). Open it with `python3 -m http.server 4180 --directory docs/guides/mockups` → `http://localhost:4180/redesign-mock.html#history`. Background for the data: `docs/subsystems/usage-limits.md` §The history view.

## Global Constraints

- `client/src/styles.css`: never a literal color or shadow below the theme-token block; tokens only (5 themes are `[data-theme]` overrides).
- No server change, no new dependency, `shared/types.ts` untouched.
- **No assumed window length.** Never compute a weekly window's start as `resetsAt − 7 days` (weekly resets have not always been 7 days apart — usage-limits.md §Series). A row's start is the previous weekly window's `resetsAt` when one is in the response, else unknown.
- Range pill: `7d | 30d | 90d` only (24h removed), default 7d, component state, not persisted.
- Figure strip: the `%` is part of the value (`'91%'`), never the small `unit` span.
- Thresholds: a day whose gain is under `0.3` points is not drawn; a day's unrecorded time counts only at `≥ 3_600_000` ms; the first reading "opens with the range" when `firstT − sinceT ≤ 2 × bucketMs`.
- Copy, exact:
  - sheet title `Utilization over time`; sub `One bar per weekly window, filled day by day · the right edge is the weekly limit, so a full bar is a week you ran out`
  - axis labels `0%` `25%` `50%` `75%` `limit`
  - row left: `This week` (current row) else the start date (`31 Aug`), or `Unscoped` when `resetsAt` is null; under it `resets <Mon 7>` (weekday short + day), or `no reset stamp`
  - row right: `<peak>%`, plus ` so far` on the current row; under it `<n> × 5h limit hit` or `no 5h limit hit`
  - pre segment: inner label `earlier` when ≥ 44 px wide; tooltip `before this range\n<X>% of the week was already spent when the <7d> range opens` (`preCause: 'range'`) or `before this range\n<X>% of the week was already spent when recording picked this week up` (`'recording'`)
  - day tooltip: `<Wed 2 Sep>[ from <11:40>]\n+<gain>% of the week · <toPct>% by the end of the day`, plus `\nincludes <2h> not recorded — use from those hours lands here` when `offMs > 0`; ` from HH:MM` only on a row's first day when the row has a pre segment
  - legend: `one day's share of the week` · `spent before the range starts` · `the weekly limit` · `holds hours nothing was recording`
  - no weekly window in range: `No weekly reading was recorded in this range.`

## Review Focus

- Range opening mid-week (the oldest row, almost always): the spend before the range is the grey pre segment, never credited to the first visible day — Task 1 `pre segment` test.
- Recording switched off mid-week: days after the last reading add nothing and draw nothing; no hatch on a zero-gain day — Task 1 `zero gain` test.
- `resetsAt: null` (unscoped window): renders as `Unscoped`, no throw — Task 1 `unscoped` test.
- Phone width (390 px): the track must stay usable — Task 2 narrow constants.
- Day labels inside green segments must read in all five themes — Task 2 colors are `color-mix` of `--green` toward `--surface` with `--ink` text; Task 2 browser check in `daylight` and `midnight`.

---

### Task 1: `weekRows()` — the weekly-fill rows

**Files:**
- Modify: `client/src/lib/usageHistory.ts`
- Test: `test/usage-history-view.test.ts`

**Interfaces:**
- Consumes: `UsageHistoryResponse`, `UsageHistoryWindow` from `shared/types.ts` (unchanged).
- Produces (exported from `client/src/lib/usageHistory.ts`):

```ts
export const MIN_GAIN_PCT = 0.3;
export const OFF_MIN_MS = 3_600_000;

export interface WeekDay {
  fromT: number;   // segment start: the row's firstT, or a local midnight
  toT: number;     // next local midnight, or the row's end
  fromPct: number; // reading held at fromT
  toPct: number;   // reading held at toT
  offMs: number;   // unrecorded ms between the last reading at/before fromT and toT; 0 when < OFF_MIN_MS
}

export interface WeekRow {
  key: string;                    // resetsAt ?? `unscoped-${firstT}`
  resetsAtMs: number | null;      // Date.parse(resetsAt), null when unscoped
  startT: number | null;          // the previous weekly window's resetsAtMs; null for the oldest or unscoped
  firstT: number;
  current: boolean;               // resetsAtMs !== null && resetsAtMs > nowT
  prePct: number;                 // the first reading's pct; 0 when under MIN_GAIN_PCT
  preCause: 'range' | 'recording';// 'range' when firstT − sinceT ≤ 2 × bucketMs
  days: WeekDay[];                // chronological; days with toPct − fromPct < MIN_GAIN_PCT dropped
  peakPct: number;                // the window's peakPct
  limitHits: number;              // 5-hour windows with peakPct ≥ 100 whose firstT is in [startT ?? firstT, resetsAtMs ?? lastT)
}

/** Newest first. `offsetMinutes` is minutes east of UTC, held for the whole range — the dayTicks convention. */
export function weekRows(resp: UsageHistoryResponse, offsetMinutes: number): WeekRow[];
```

Algorithm (the mock's `chart()` and `heldAt`/`lastReadT`, minus its assumed 7-day start):
- Sort `resp.weekly` by `firstT` ascending before pairing each window with its predecessor for `startT`; return reversed.
- A window's points are its segments flattened. `held(t)` = pct of the last point with `p.t ≤ t`, else the first point's pct. `lastRead(t)` = `t` of that point, else `firstT`.
- Row end = `min(resetsAtMs ?? lastT, nowT)`. Day bounds = `[firstT, ...local midnights strictly inside (firstT, end), end]`.
- `offMs` = Σ over `resp.gaps` of `max(0, min(g.toT, toT) − max(g.fromT, lastRead(fromT)))`, zeroed under `OFF_MIN_MS`.

- [ ] **Step 1: Write the failing tests** in `test/usage-history-view.test.ts` (same `test()` / `resp()` helpers; `offsetMinutes` 0; `H = 3_600_000`, `DAY`; times built from `Date.UTC(2026, 8, 7)` = Mon 7 Sep 2026 00:00Z, call it `MON`):
  - `weekRows splits a window at local midnights, holding each reading`: one weekly window `resetsAt` = ISO of `MON + 7*DAY + 9*H`, points `{MON+10H,0},{MON+15H,10},{MON+DAY+11H,25}`, `nowT = MON+DAY+20H`, `sinceT = MON` → one row, `days` = `[{fromT: MON+10H, toT: MON+DAY, fromPct: 0, toPct: 10, offMs: 0}, {fromT: MON+DAY, toT: MON+DAY+20H, fromPct: 10, toPct: 25, offMs: 0}]`, `current` true, `prePct` 0.
  - `weekRows: the pre segment carries what the week spent before the range`: `sinceT = MON+2*DAY`, `bucketMs` 60_000, first point `{MON+2*DAY+60_000, 28.8}`, later `{MON+2*DAY+5H, 35}` → `prePct` 28.8, `preCause` `'range'`, first day `fromPct` 28.8 (not 0).
  - `weekRows: a late first reading is 'recording', not 'range'`: same but first point at `sinceT + 3H` → `preCause` `'recording'`.
  - `weekRows drops a zero-gain day and keeps a 0.3-point one`: day 1 gains 0.2, day 2 gains 0.3 → `days.length` 1, its `toPct − fromPct` 0.3 (compare with 1e-9 tolerance).
  - `weekRows: offMs counts unrecorded time since the day's last reading, from one hour up`: a gap of 2 H inside a gaining day → that day's `offMs` 7_200_000; a 30-minute gap → 0.
  - `weekRows: startT is the previous window's reset, newest row first, hits counted per row`: two weekly windows (resets R1 < R2), 5-hour windows at peak 100 with `firstT` one before R1 and two after R1 → rows `[R2 row, R1 row]`, R2 row `startT` = R1 ms and `limitHits` 2, R1 row `startT` null and `limitHits` 1; a 99.9 peak is not counted.
  - `weekRows: an unscoped window renders without a reset`: `resetsAt: null` → `resetsAtMs` null, `current` false, `startT` null, key starts with `unscoped-`, `days` end at its `lastT`.

- [ ] **Step 2: Run to verify they fail** — `pnpm test 2>&1 | grep -A2 weekRows` → failures (`weekRows` is not exported).

- [ ] **Step 3: Implement `weekRows`, `WeekRow`, `WeekDay`, `MIN_GAIN_PCT`, `OFF_MIN_MS`** in `client/src/lib/usageHistory.ts`, per the Interfaces block. Midnights with the fixed offset the way `dayTicks` computes them (keep `dayTicks` for now — Task 2 removes it).

- [ ] **Step 4: Run** `pnpm test` → all pass; `pnpm typecheck` → clean.

- [ ] **Step 5: Commit** — `feat(usage): weekRows, the weekly-fill rows for History`

---

### Task 2: The weekly-fill chart in Usage → History

**Files:**
- Modify: `client/src/components/usage/UsageHistory.tsx`
- Modify: `client/src/styles.css` (replace the `.usg-hist-*` rules, ~line 2205–2230, keeping `.usg-hist-range`)
- Modify: `client/src/lib/usageHistory.ts` + `test/usage-history-view.test.ts` (delete `stepPath` and `dayTicks` and their tests — nothing else imports them once the old chart is gone; `UsageProfile`'s `dayTicks` is `lib/walkChart.ts`'s, a different function)
- Modify: `docs/subsystems/usage-limits.md` §The history view

**Interfaces:**
- Consumes: `weekRows(resp, offsetMinutes)`, `WeekRow`, `WeekDay` (Task 1); `useFloatingTip()` from `client/src/hooks/useFloatingTip.ts` — `tipHandlers(text)` spread on each mark, `<div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />` once, exactly as `UsageRates.tsx` does.

- [ ] **Step 1: Range and figures.** `RANGES` = `7d`, `30d`, `90d`. In `historyTiles`, the Recorded and Weekly-peak values become `` `${…}%` `` with no `unit`.

- [ ] **Step 2: Replace `Chart` with `WeekFill({ history, tip })`**, drawn at the `useWidth` measured width, offset `-new Date().getTimezoneOffset()`. Geometry from the mock: `rowH` 26, row gap 24, top 30, left column 128 / right column 132 — **76 / 84 when width < 560**. Track `x(p) = L + clamp(p,0,100)/100 × (w−L−R)`. Per row, in order: track rect; pre segment `[0, prePct]` (class `pre`); each day `[fromPct, toPct]` alternating classes `a`/`b` by index, inset 1 px each side except at 0, `rx` 3, weekday-short label centred when ≥ 30 px; a hatch overlay rect (same box, `fill="url(#<useId>)"`) on days with `offMs > 0`; the left and right text per Global Constraints. Grid: dashed verticals at 0/25/50/75 and the limit rule at 100 spanning all rows, labels above the first row. Every segment carries `tipHandlers(<copy from Global Constraints>)`. Empty `weekly` → the `note` paragraph. The sheet title, sub and legend per Global Constraints. The "Weekly windows" table below stays as is.

- [ ] **Step 3: CSS.** Replace the `.usg-hist-*` block (keep `.usg-hist-range`) with:

```css
.usg-wf{position:relative;width:100%;margin-top:12px}
.usg-wf svg{display:block}
.usg-wf-axis{font-size:10px;fill:var(--ink3);text-anchor:middle}
.usg-wf-axis.lim{fill:var(--red)}
.usg-wf-grid{stroke:var(--hairline);stroke-width:1;stroke-dasharray:3 3}
.usg-wf-limit{stroke:var(--red);stroke-width:1;stroke-dasharray:4 3;opacity:.7}
.usg-wf-track{fill:var(--surface2)}
.usg-wf-seg.a{fill:color-mix(in oklab,var(--green) 70%,var(--surface))}
.usg-wf-seg.b{fill:color-mix(in oklab,var(--green) 45%,var(--surface))}
.usg-wf-seg.pre{fill:var(--steel)}
.usg-wf-hatch{stroke:var(--surface);stroke-width:1.5;opacity:.55}
.usg-wf-day{font-size:10px;font-weight:600;fill:var(--ink);text-anchor:middle;pointer-events:none}
.usg-wf-lab{font-size:11px;font-weight:500;fill:var(--ink);text-anchor:end}
.usg-wf-sub{font-size:10px;fill:var(--ink3);text-anchor:end}
.usg-wf-sub.start{text-anchor:start}
.usg-wf-peak{font-size:13px;font-weight:600;fill:var(--ink)}
```

plus legend swatches (`.usg-hist-legend` kept; `.usg-hist-sw` variants `a`, `b`, `pre`, `lim`, `off`) built from the same tokens — `off` is the `a` fill under a `repeating-linear-gradient(45deg, color-mix(in oklab,var(--surface) 55%,transparent) 0 1.5px, transparent 1.5px 4px)`.

- [ ] **Step 4: Remove `stepPath`, `dayTicks`** and their tests; `pnpm typecheck` proves nothing else imported them.

- [ ] **Step 5: Docs.** In usage-limits.md §The history view: the range is `7d / 30d / 90d`; the page paragraph describes the weekly fill (rows newest first, day segments, pre segment, hatch for unrecorded hours, start from the previous window's reset — never an assumed 7 days) and that tooltips now exist via `useFloatingTip`; drop "There is no hover tooltip yet". Replace the **Step-after rendering** bullet with one on held readings (`weekRows` holds the last reading at each day boundary, for the same write-on-change reason). Grep `docs/overview.md` for `stepPath`/`two-panel` and fix any hit.

- [ ] **Step 6: Verify** — `pnpm test` (prints the case count, all pass), `pnpm typecheck` clean, `pnpm build` succeeds.

- [ ] **Step 7: Commit** — `feat(usage): History draws each weekly window filled day by day`
