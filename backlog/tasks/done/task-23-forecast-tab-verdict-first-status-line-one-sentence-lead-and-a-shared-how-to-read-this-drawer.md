---
id: task-23
title: Forecast tab: verdict-first status line, one-sentence lead and a shared How to read this drawer
created: 2026-09-07
from: idea-22
updated: 2026-09-08T11:48:32Z
started: 2026-09-08T11:12:43Z
execute-elapsed: 2149
execute-tokens: 210907
---

## Goal

Make **Usage → Forecast** read the way **Usage → Token value** now reads. `task-22` shipped
three moves on the token-value tab — a one-sentence lead, a status line that answers the
tab's question before any figure, and a closed-by-default `How to read this` drawer holding
every definition, with ⓘ panels quoting the drawer's own strings. The Forecast tab beside it
still opens on a three-sentence `.up-sub` paragraph
(`client/src/components/usage/UsageProfile.tsx:303`), scatters its definitions across the
legend (`:381`), the `RecordingStatus` counters (`:104`), the walk's meta line (`:187`) and
the walk's note paragraph (`:269`), and answers its own question — *is this forecast worth
trusting yet, and when does the week hit 100%* — in two places, neither of them first: the
confidence verdict is the last `<small>` of the legend, and the crossing time sits in the
chart's meta row.

**Presentation only.** Every statement the tab makes today survives, in a new place. No
server change, no contract change, no number changes: any diff under `server/` or in
`shared/types.ts` has escaped its scope, and so has any change to `walkChart.ts`'s geometry,
to `cellTitle`/`stepTitle`, to the grid, the table view or the chart.

### The direction, and why there are no new mockups

`task-22` mocked three variants because the direction was unknown. It is not unknown here —
this task applies the shipped variant A to the tab beside it, and the design record is the
running code plus
`docs/superpowers/specs/2026-09-06-token-value-layout-mockups.html`. The judgement calls
that remain are *which* of the Forecast tab's sentences is the headline and *where* each
definition lands; those are settled below, in prose, and are cheaper to argue with in the PR
than to mock.

What the tab becomes, top to bottom:

1. **One-sentence lead** — *"The 168 hour-of-week weights the weekly forecast walks over."*
   The rest of today's paragraph (Monday 09:00 ≠ Tuesday 09:00; nothing averaged across
   days; what accumulates across weeks is the evidence) becomes the drawer's `cell` term,
   reachable from an ⓘ on the `LEARNED HOURS` heading.
2. **Status line, first** — the trust verdict as the headline, the 100% answer beside it:
   *"The forecast is learning your week"* · *"the week hits 100% Thu 14:00"*. The headline
   carries an ⓘ opening the `confidence` term. Under it, today's `RecordingStatus` counters
   unchanged (`47 of 168 hours observed`, `31h 20m recorded`, `12 carrying a weight`), and
   under those, unchanged, the pending-gate sentence when no hour carries a weight yet.
3. **The grid, the table toggle and the legend swatches** — untouched, except that the
   legend loses its `confidence: thin — …` line (now the headline) and gains two ⓘ:
   `weight` on the ramp, `evidence` on the hatched swatch. The
   `no evidence yet — falls back to the N% weekly mean` label keeps its live number.
4. **The walk** — the chart, its overlays and the `walkAbsent` sentence untouched. Its meta
   line loses the `hits 100% …` / `coasts to the reset` span (the status line owns that
   sentence now; the crossing is still labelled on the chart itself by `.up-crosslab`) and
   its left label gains an ⓘ for the `walk` term. Its note paragraph shrinks to
   *"Cumulative window use from now to the weekly reset."* plus the solid/dashed key row
   with an ⓘ for `ink` and one for `ceiling`; the `globalMean` fallback clause and the
   `Y_MAX` ceiling clause move into those two drawer terms.
5. **`How to read this` drawer** — closed by default, same markup and same styling as the
   token-value tab's, holding seven definitions: hour of the week, weight, evidence, confidence,
   solid vs dashed, the 100% ceiling, the walk.

### The two open questions from `idea-22`, answered

- **Does the Forecast tab need a status line at all?** Yes, and `RecordingStatus` does not
  become it — it sits *inside* it. The counters answer "is recording working" (a progress
  question); the tab's actual question is "should I trust this forecast, and when does the
  week hit 100%", whose answer is `confidence` + `exhaustAt`. Those two are today the
  furthest-apart items on the page. The headline states them; the counters stay as the
  evidence under it, which is the same relationship `.rates-status`'s headline has to its
  verdict counts.
- **One shared `How to read this` component, or a second copy?** Shared — extracted at the
  second consumer, exactly as `useFloatingTip` was. Not for the ~24 lines of JSX, but because
  the ⓘ button carries behaviour that is invisible in a copy: `aria-expanded` is rendered
  once as `false` and thereafter mutated on the DOM node by the hook by hand, and `pinHandlers`
  depends on that. A hand-copied button that renders the attribute wrong (or omits it) breaks
  pinning silently, in the tab nobody was looking at.
- **Decided without the user**, and worth flagging in the PR: this session had no
  `AskUserQuestion` channel, so both answers above are the groom's call, reasoned from the
  shipped tab rather than confirmed. Disagreeing with either costs a small diff — the pure
  functions and the tests do not change shape if the headline copy or an ⓘ placement moves.

### Out of scope, deliberately

- **Renaming the `rates-*` CSS classes** to something tab-neutral now that both tabs use
  them. `.claude/CLAUDE.md` says to keep class names stable, and a rename touches both tabs
  plus `styles.css` for zero user-visible gain. A comment at the CSS block saying the prefix
  is now shared vocabulary is the whole change.
- **Persisting the drawer's open/closed state.** YAGNI here for the same reason as on the
  token-value tab.
- **Anything computed.** `usage-forecast.ts`, `usage-history.ts`, `api.ts`, the walk, the
  weights, the confidence gates — untouched.
- **The two `daylight`-theme contrast readings** `task-22` measured and left alone. If the
  new markup puts `--amber` or the ramp's low steps in a new place, say so in the PR; do not
  retune a theme token here.

## Plan

**Plan-format override, deliberate, per `.claude/CLAUDE.md`:** behaviour, signatures and
exact test *cases* only — **no literal code blocks**. Handed code gets transcribed verbatim
and a bug here becomes a bug in the branch with nobody positioned to catch it. Disagree with
anything below in the PR body rather than transcribing around it. Every size figure below is
a soft target.

Work on a worktree branch (`feat/forecast-reading-aids`), not the shared checkout — the
user's dashboard runs from it on 5174. A fresh worktree needs `pnpm install` **and**
`pnpm build` before the API serves anything.

### 1. Pure formatting — `client/src/lib/usageProfile.ts` (extend)

This module is already "pure helpers for the duty-cycle inspector's status line", is already
a `docs-sync` source of `usage-limits.md`, and already has a wired-up test file. Extend it
rather than adding a sibling. Keep every existing export untouched — `profileProgress`,
`earliestWeightMs`, `nextOccurrenceMs`, `nextWeekStartMs`, `fmtObserved`, `cellTitle`,
`DAYS`, `TRUST_FLOOR_MIN`. Add:

- `forecastHeadline(confidence: ForecastConfidence): string` — the trust verdict, ≤ 6 words,
  no trailing period: `none` → `Still the flat-rate forecast`; `thin` → `The forecast is
  learning your week`; `ok` → `The forecast is running on your week`. Exhaustive `switch` over
  the union (no `default`), so a fourth confidence value fails typecheck rather than falling
  through to a wrong verdict.
- `forecastTiming(walk: ForecastStep[], exhaustAt: string | null): string | null` — the
  100% answer as one lowercase clause: `the week hits 100% Thu 14:00` when `exhaustAt` is a
  parseable ISO string (format the time with `fmtWalkHour` from `walkChart.ts`), `the week
  coasts to the reset` when the walk is non-empty and `exhaustAt` is null, and `null` when
  the walk is empty — with no walk there is no projection to time, and `absentText(walkAbsent)`
  in the walk panel already says why. `null` also when `exhaustAt` is non-null but the walk is
  empty: that combination should not reach the client, and inventing a crossing time for a
  walk that does not exist is the one wrong answer here.
- `profileGlossary(globalMean: number): readonly { key: ProfileTerm; term: string; text: string }[]`
  — a **builder**, not a constant like `RATES_GLOSSARY`: two of the seven definitions quote a
  live number (`globalMean` in `ink`, and the same mean in `weight`'s closing clause), while
  `TRUST_FLOOR_MIN` and `walkChart`'s `Y_MAX` are module constants and are read directly.
  `ProfileTerm` is an exported union of the seven keys, in this order:
  `'cell' | 'weight' | 'evidence' | 'confidence' | 'ink' | 'ceiling' | 'walk'`.
  Percentages formatted the way the component formats them today —
  `Math.round(globalMean * 100)` — so the drawer and the legend cannot print two different
  means.
- `profileTip(key: ProfileTerm, globalMean: number): string` — the matching entry's `text`,
  the same string the drawer prints. Mirrors `figureTip`.

The seven definitions, each one a statement the tab makes today, moved:

| key | term | what it must say, and where it comes from |
|---|---|---|
| `cell` | Hour of the week | A cell is one hour *of the week* — Monday 09:00 is a different cell from Tuesday 09:00, and nothing is averaged across days; what accumulates across weeks is the evidence. Today's `.up-sub` paragraph, sentences 2–4. |
| `weight` | Weight | The share of that hour you are typically active, 0–1; the forecast multiplies the hour's burn rate by it. An empty cell is a *measured* idle hour, which is a different statement from a low weight. Today's `styles.css` ramp comment and `stepOf`'s doc. |
| `evidence` | Evidence, and the two gates | An hour needs `TRUST_FLOOR_MIN` minutes of observed time **and** one week roll-over to fold before its weight is used; until both fall the cell is hatched and the forecast uses the `globalMean` fallback. Read the floor from the constant, never a second literal. Today's module header of this file. |
| `confidence` | Confidence | `none` = no learned hours yet, the projection is the flat-rate one; `thin` = expected for the first couple of weeks, the shape is still moving; `ok` = enough evidence to lead with, at 120 of 168 hours carrying a weight. Today's `CONFIDENCE_TEXT` map — reuse its three strings verbatim rather than rewriting them, so the headline and the drawer cannot drift. The 120 is `TRUSTED_OK` in `server/lib/usage-forecast.ts:43`, which is **not** exported to the client and must not be imported across the boundary: give it a named local constant in this module carrying the same "mirrors the server constant, duplicated because it is a constant of the model rather than a runtime value, so the two must move together" comment `TRUST_FLOOR_MIN` already has. |
| `ink` | Solid vs dashed | Solid hours are walked with a measured weight; dashed hours have no evidence for that hour of the week yet and fall back to the *N*% weekly mean — the same height, a weaker claim. Today's walk note, sentences 2–3. |
| `ceiling` | The 100% ceiling | The scale stops at `Y_MAX`%: past the ceiling everything is equally over, so the curve is not auto-scaled to its endpoint. The red rule is 100% of the weekly window and the vertical line is where the walk crosses it. Today's walk note, last sentence, plus `walkChart.ts`'s `Y_MAX` doc. |
| `walk` | The walk | The same forward walk that produced the weekly projection in the header, hour by hour from now to the weekly reset — re-run by the endpoint rather than re-derived, so the inspector cannot disagree with the number it explains. Today's `.up-walkmeta` label plus `usage-limits.md` §The inspector. |

Rewrite the module header to say it now owns the status line *and* the tab's glossary.

### 2. The shared reading aids — `client/src/components/usage/ReadingAids.tsx` (new)

Two presentational exports, no state of their own, no data fetching, ~50 lines:

- `InfoDot({ label, text, pin })` — the ⓘ button: `type="button"`, `className="rates-i"`,
  `aria-label` reading `What is the <label>?` (the caller passes the term's own words, not a
  sentence), `aria-expanded="false"` rendered once and never touched by React again, and the
  `pin(text)` handler bundle spread onto it. `pin` is typed `(text: string) => PinHandlers`
  — the caller's own `pinHandlers` from `useFloatingTip`, so both tabs keep one panel per
  tab and this component owns no hook.
- `HowToRead({ terms })` — the `<details className="rates-how">` drawer, closed by default:
  `<summary>` reading `How to read this` with `<span className="rates-n">{terms.length} terms</span>`,
  then the `<dl className="rates-gloss">` over `{ key, term, text }` entries. Typed against a
  structural `readonly { key: string; term: string; text: string }[]`, so both
  `RATES_GLOSSARY` and `profileGlossary(…)`'s return satisfy it without either module
  importing the other.

Then rewrite the two call sites to use them — this is the part that proves the extraction:

- `UsageRates.tsx` — `Fig`'s inline button becomes `InfoDot`, and the inline `<details>`
  becomes `HowToRead`. **The rendered DOM must not change**: same tag, same classes, same
  attribute names and values, same text. If it changes, the extraction has quietly
  redesigned the shipped tab.
- `UsageProfile.tsx` — the new call sites in §3.

### 3. The component — `client/src/components/usage/UsageProfile.tsx`

Keep `useUsageProfile`, the loading and error notes, the `.up-off` recording-off block, the
`showTable` toggle, the table, the grid, `stepOf`, the ramp, the per-cell tooltip and the
whole `<svg>` exactly as they are. One `useFloatingTip()` call already exists; take
`pinHandlers` off it as well as `tipHandlers` — the hover-only bundle stays on the 168 grid
cells and the 118 hit columns, and the pin bundle drives the ⓘ buttons.

- **Lead**: `.up-sub` becomes the single sentence. The `HINTS.forecast` line in
  `UsageView.tsx` stays as it is.
- **Heading ⓘ**: `InfoDot` for `cell` beside the `LEARNED HOURS` `<h3>`, inside `.up-head`'s
  first `<div>` so the `show table` button keeps its `margin-left:auto` position.
- **`RecordingStatus` becomes `ForecastStatus`**, taking the cells, `recording`, `confidence`,
  `walk`, `exhaustAt` and `pinHandlers`. It keeps today's early return — `null` when
  `!recording && touched === 0`, since `.up-off` says it all — and renders three things in
  order:
  1. `.rates-status`: `<span className="rates-q">` with `forecastHeadline(confidence)` and an
     `InfoDot` for `confidence` immediately after the text, then `forecastTiming(walk, exhaustAt)`
     in the counts-styled span when non-null.
  2. today's `.up-status` counters, copy unchanged, including `fmtObserved`.
  3. today's `.up-status-wait` sentence, copy and date arithmetic unchanged
     (`earliestWeightMs` / `nextWeekStartMs` / `toLocaleDateString`), in the same two branches.
- **Legend**: keep the swatches, `never`, `always`, the hatched swatch and its
  `no evidence yet — falls back to the N% weekly mean` label. Add `InfoDot` for `weight` after
  `always` and `InfoDot` for `evidence` after the hatched label. Delete the
  `.up-conf` `<small>` — its content is now the headline and the `confidence` term. Leave
  `.up-legend .up-conf` in `styles.css` only if something still renders it; otherwise remove
  the rule with the markup.
- **`WalkStrip`**: drop the `exhaustAt`-bearing `<span>` from `.up-walkmeta` (the prop can go
  too if nothing else in the component reads it — check `up-crosslab`, which reads it, before
  removing it from the signature). Add `InfoDot` for `walk` after the meta label. The note
  paragraph keeps its first sentence and the solid/dashed key spans, and drops the
  `globalMean` clause and the `Y_MAX` clause; put `InfoDot` for `ink` at the end of the key
  row and `InfoDot` for `ceiling` after it. `WalkStrip` needs `pinHandlers` passed in
  alongside `tipHandlers`, and `globalMean` is still read (by the legend, and by
  `profileGlossary`) — so it stays a prop.
- **Drawer**: `HowToRead` with `profileGlossary(globalMean)`, mounted after the walk panel —
  last on the page, as on the token-value tab. Rendered unconditionally: unlike the rates
  drawer it does not depend on there being any data, and a reader with an empty grid is
  exactly the reader who needs the definitions.

Update the module doc comment: the existing design notes all still hold and stay; add a
paragraph on the reading aids — why the headline is the confidence verdict rather than the
crossing time (the crossing is a *number*; whether to believe it is the question), why the
crossing sentence has exactly one home now, and that the `rates-*` class names are shared
vocabulary rather than the token-value tab's private prefix.

### 4. Styles — `client/src/styles.css`

Aim for **no new selectors**. The forecast status line reuses `.rates-status`, `.rates-q`,
`.rates-counts`, `.rates-i`, `.rates-how`, `.rates-n`, `.rates-gloss`; the counters keep
`.up-status`. Two things to check and fix only if the check fails:

- `.rates-status`'s `margin-top:14px` and `.up-status`'s `margin-top:10px` now stack inside
  one block. If the gap reads wrong, adjust with a scoped override rather than editing the
  shipped `.rates-status` rule, which the token-value tab depends on.
- `.rates-q` is 15px `--display`; the Forecast headline is longer than `No model is drifting`.
  At 375px it must wrap without pushing the timing clause off screen — `.rates-status` is
  already `flex-wrap:wrap`, so verify rather than assume.

Move the `rates-*` block's opening comment (or add one line to it) to say the prefix is the
shared reading-aids vocabulary used by both Usage tabs. Tokens only, no literal colour or
shadow, and check the light theme — that is where a `color-mix` over the wrong base shows.
Delete `.up-legend .up-conf` if nothing renders it any more.

### 5. Docs

- `docs/subsystems/usage-limits.md` §The inspector (~`:329`–`:426`): rewrite the client
  paragraphs for the new reading order — the one-sentence lead, the status line leading with
  the confidence verdict and the crossing time, the counters and the pending-gate sentence as
  its evidence, the ⓘ panels and the shared drawer, and the fact that the crossing sentence
  now has one home. The `RecordingStatus` bullet becomes `ForecastStatus`. Keep every
  mechanism paragraph (the tooltip's coordinate trap, `splitRuns`, the `viewBox` reasoning,
  `walkAbsent`) as it stands — none of it changes.
- `docs/overview.md` `components/` list (`:183`, the `usage/` entry at `:189`) — name
  `usage/ReadingAids` there; the
  `useFloatingTip` line at `:193` already says "shared by both Usage tabs" and stays.
- Re-stamp `usage-limits.md`'s `docs-sync` block after the code commit;
  `client/src/lib/usageProfile.ts` and `client/src/components/usage/` are already among its
  sources, so no new source line is needed.

## Test cases

All in `test/usage-profile-view.test.ts` — already wired into `test/run-all.ts`, currently 25
cases. The component, the hook and `ReadingAids` have no DOM harness in this repo; their
verification is the browser pass under *Done when*.

Fixtures: reuse the file's existing `cell()` and `grid()` helpers. Add a `step()` helper
building a `ForecastStep` (`t`, `gain`, `cum`, `weight`, `learned`) and a `walkOf(n)` building
`n` steps, since `forecastTiming` only reads `walk.length`.

1. `forecastHeadline` returns a distinct non-empty verdict for each of `none`, `thin`, `ok`,
   none of them ending in a period, and `none`'s naming the flat-rate forecast (assert on the
   substring `flat-rate`, not the whole sentence).
2. `forecastTiming(walkOf(3), '<ISO for a local Thursday 14:00>')` → `the week hits 100% Thu 14:00`
   — build the ISO from a `Date` constructed with local components so the test does not depend
   on the runner's timezone, the way the existing `fmtWalkHour` tests do.
3. `forecastTiming(walkOf(3), null)` → `the week coasts to the reset`.
4. `forecastTiming([], null)` → `null`.
5. `forecastTiming([], '<any ISO>')` → `null` — a crossing time with no walk is not a
   sentence this tab may print.
6. `profileGlossary(0.42)` has exactly seven entries whose `key`s are
   `cell, weight, evidence, confidence, ink, ceiling, walk` in that order, and every entry has
   a non-empty `term` and a `text` of at least 40 characters.
7. `profileGlossary(0.42)`'s `ink` text contains `42%`, and `profileGlossary(0.07)`'s contains
   `7%` — the mean is live, which is why the glossary is a builder.
8. `profileGlossary(…)`'s `evidence` text contains `String(TRUST_FLOOR_MIN)` — imported, not
   a second literal — and its `ceiling` text contains `String(Y_MAX)` imported from
   `walkChart.js`.
9. `profileGlossary(…)`'s `confidence` text contains all three of the confidence words
   (`none`, `thin`, `ok`) so no state is undocumented, and contains the `ok` gate's
   `120`.
10. `profileTip('ink', 0.42)` is the same string as `profileGlossary(0.42)`'s `ink` entry's
    `text`, and `profileTip('cell', 0.42)` the same as its first entry's — one copy of every
    definition, the invariant `figureTip` has its own test for.
11. Every existing case in the file still passes untouched; `pnpm test` prints 35 in this
    module and its total case count rises by exactly 10.

## Done when

- `pnpm test` and `pnpm typecheck` both pass, with the output pasted in the PR.
- `git diff --stat -- server shared` is empty, and the diff contains no change to
  `client/src/lib/walkChart.ts` beyond nothing at all (`Y_MAX` is read, not moved).
- The token-value tab's rendered DOM is unchanged by the `ReadingAids` extraction — compare
  the `.rates-fig` label markup and the `<details className="rates-how">` subtree before and
  after (`browser_evaluate` on `outerHTML`, or a saved snapshot), and say in the PR which
  method was used.
- In the browser (playwright MCP tools): open `http://localhost:<worktree vite port>/`, select
  **Usage** in the side rail and the **Forecast** tab, and confirm the status line is the
  first thing under the lead, carrying a confidence verdict and — when the walk is non-empty —
  the `hits 100% …` or `coasts to the reset` clause, with the counters beneath it.
- In the browser (playwright MCP tools): on the Forecast tab, click the ⓘ beside the status
  headline and confirm a floating panel opens with the `confidence` definition and the button
  reports `aria-expanded="true"`; click it again and confirm the panel hides and the attribute
  returns to `false`.
- In the browser (playwright MCP tools): on the Forecast tab, expand `How to read this` and
  confirm it lists seven terms, closed by default on load, and that the percentage in the
  solid-vs-dashed definition equals the one in the legend's `falls back to the N% weekly mean`
  label.
- In the browser (playwright MCP tools): on the Forecast tab, hover a heatmap cell and a walk
  hit column and confirm the per-cell and per-hour tooltips still open — the hover-only bundle
  must survive the tab gaining pinned panels — then resize to 375×812 and confirm the status
  headline wraps without the timing clause leaving the viewport and nothing scrolls sideways.
- Screenshots at 640px and 375px in the PR, plus one of the drawer open.
- The five themes each render the status headline, the ⓘ glyphs and the drawer legibly; the
  `daylight` theme is the one to look at. Report any new contrast reading you take, and do not
  retune a theme token to fix one.
- `usage-limits.md` and `overview.md` updated; the `docs-sync` stamp re-baselined to the merge
  commit (an execute session does not commit — say in the PR that the stamp still needs it, as
  `task-22` did).
- State in the PR what was not verified. Known candidates: `confidence: 'ok'` cannot be
  produced from live data on this machine yet (the headline for it is unit-tested only), and
  the `walkAbsent` states need a doctored profile to render.

## Outcome

**2026-09-08 — done.** The Forecast tab now reads the way the Token value tab does: a
one-sentence lead, a status line whose headline is the confidence verdict with the 100%
answer beside it, the recording counters demoted to evidence under it, and a
closed-by-default `How to read this` drawer holding all seven definitions, each also
reachable from an ⓘ. `InfoDot` and `HowToRead` were extracted into
`client/src/components/usage/ReadingAids.tsx` and both tabs now render them.

Built as planned, with three deviations, all stated below rather than worked around.

### Verification

```
$ pnpm typecheck
> tsc --noEmit
(no output — clean)

$ pnpm test
  38 passed, 0 failed      ← usageProfile.ts (inspector status line), was 28
  ...
  31/31 passed
ALL PASS
```

Total case count 1398 → 1408, exactly +10 as the plan required.

Scope held: `git diff HEAD --stat -- server shared client/src/lib/walkChart.ts` is empty.

### Browser pass

Ran against this worktree's Vite (5273) proxied to a stub (4273) that forwards to the live
API but injects a synthetic 118-hour walk — the live account is idle, so its real response
is `walkAbsent: no-rate` with an empty walk, and the crossing clause, the chart and the hit
columns cannot be exercised against it. Both processes were killed by recorded pid
afterwards; the user's dashboard on 5174/4173 was untouched (confirmed still listening).

- **Reading order** — `.up` children in DOM order: `up-tip, up-head, rates-status,
  up-status, up-grid, up-legend, up-walk, rates-how`. Lead is the single sentence. Headline
  `The forecast is running on your week` (live `confidence: ok` — see Unproven, this turned
  out to be provable after all), timing `the week hits 100% Fri 16:00`, counters beneath.
- **Crossing has one home** — `.rates-counts` reads `the week hits 100% Fri 16:00` and the
  chart's `.up-crosslab` reads `Fri 16:00`; `.up-walkmeta` carries the label and its ⓘ only.
- **Token-value DOM unchanged by the extraction** — compared `outerHTML` of
  `.rates-fig .rates-lab` and the whole `details.rates-how` subtree via `browser_evaluate`
  on the *unmodified* main checkout serving 5174 versus this branch on 5273. **Byte-identical
  in both cases.** (Confirmed 5174's checkout is on `main` and its `UsageRates.tsx` matches
  this branch's `HEAD` version, i.e. it is a genuine "before".)
- **Pin behaviour** — clicking the headline ⓘ sets `aria-expanded="true"`, panel opacity 1,
  panel text is the `confidence` definition; clicking again returns `false` / opacity 0.
- **Drawer** — closed on load (`open` absent), `7 terms`, the seven `<dt>` in plan order.
  Its `Solid vs dashed` definition prints `7%`, the same mean as the legend's `falls back to
  the 7% weekly mean`.
- **Hover-only bundle survives** — real Playwright hover on a heatmap cell opened
  `Tue 03:00 · every week`; on a walk hit column, `Thu 10:00 / +1.4% this hour / …`. (A
  first hit-column hover read opacity 0: `.hover()` scrolled the chart into view and the
  hook's documented hide-on-scroll for pointer-shown tips fired. Hovering the neighbouring
  column with no scroll shows opacity 1. Pre-existing behaviour, not a regression.)
- **375×812** — `document.documentElement.scrollWidth === 375 === innerWidth`, no sideways
  scroll; the timing clause wraps onto its own line and stays inside the viewport; the
  status→counters gap measures 10px, so no CSS override was needed.
- **Five themes** — contrast of the headline / drawer summary / ⓘ glyph against the card
  surface: midnight 12.61 / 7.00 / 3.32, graphite 12.80 / 6.85 / 3.28, amber 12.50 / 7.04 /
  3.63, nightshift 12.98 / 7.33 / 3.58, daylight 15.44 / 7.17 / 3.62. `daylight` is the best
  of the five here, not the worst. No theme token was retuned and no colour literal added.
- Screenshots (640 full page, 375 full page, drawer open) are at
  `/tmp/task23-scratch/shots/` — kept out of the repo deliberately, since a `.playwright-mcp/`
  directory does not belong in a commit.

Contract sweep: 2 sites updated (docs/subsystems/usage-limits.md, docs/overview.md)

One site left standing on purpose: `docs/guides/tutor/usage/usage-3-inspector.html:988`
still says `RecordingStatus`. It is a generated tutor deck, `docs/guides/` is guide-manager
territory, and the deck cites `UsageProfile.tsx` in its own stamp — so it will flag as stale
and be regenerated by `/tutor`. Hand-patching one `<p>` would leave the rest of that lesson
(quoted code blocks, `UsageProfile.tsx:16-20` line citations) inconsistent with the file it
claims to quote, which is worse than leaving it whole and stale.

Red proof: 10 tests went red with the change reverted

Nine surgical mutations, each applied to a file copy of `client/src/lib/usageProfile.ts`
and reverted from that copy (never `git stash` — the stack is shared with other worktrees).
Baseline 38/0 unmutated; every one of the 10 new cases is pinned by at least one:

| mutation | result |
|---|---|
| headline: all three verdicts identical | 1 failed |
| timing: drop the empty-walk guard | 2 failed |
| timing: coasts branch prints the crossing text | 1 failed |
| timing: crossing clause reworded | 1 failed |
| glossary: mean hardcoded instead of live | 1 failed |
| glossary: floor + ceiling re-typed as literals | 1 failed |
| glossary: ok gate clause dropped | 1 failed |
| glossary: first two terms swapped in order | 2 failed |
| profileTip: returns the term, not the text | 1 failed |

### Deviations from the plan, for the PR body

1. **`ForecastStatus` takes a `globalMean` prop** the plan did not list. Its `confidence` ⓘ
   quotes `profileTip('confidence', globalMean)`, and `profileTip` is a builder that needs
   the live mean. The alternative — having the parent pre-compute that one string — would
   have made this the only ⓘ on the tab wired differently from the other six.
2. **The walk's meta label and its ⓘ are one `<span>`, not two flex children.**
   `.up-walkmeta` is `justify-content:space-between`, so a bare trailing ⓘ would have been
   flung to the far end of the row. Wrapping keeps it beside the label with no CSS change.
3. **The plan said this module had 25 cases; it had 28.** The +10 delta it specified is
   what was checked and met (1398 → 1408 overall).

Two smaller calls worth a reviewer's eye: the `confidence` glossary entry composes the
three `CONFIDENCE_TEXT` strings verbatim but prefixes `none —` and `ok —` (the `thin`
string already names itself, so prefixing it would have stuttered); and the glossary strings
carry no markdown emphasis, since `<dd>` and the tip panel both render them as plain text.

### Still needed, not done here

- **The `docs-sync` stamp on `docs/subsystems/usage-limits.md` needs re-baselining** to the
  merge commit. An execute session does not commit, so `verified:` still reads
  `f436519f31ef4120521792db7658e2bc5431f0e9`. Same handoff `task-22` made. Its `sources:`
  list already covers `client/src/lib/usageProfile.ts` and `client/src/components/usage/`,
  so no new source line is needed.
- **`docs/guides/tutor/usage/usage-3-inspector.html` wants a `/tutor` refresh** (see above).

### Unproven

- The `walkAbsent` states (`recording-off`, `no-rate`, `no-window`) were not re-rendered;
  the walk panel's absent path is untouched by this diff but was only seen indirectly (the
  live API returns `no-rate`, which is why the stub exists).
- `confidence: 'none'` and `'thin'` headlines are unit-tested only — the live profile is at
  `ok`, and only `ok` was seen rendered. (The plan predicted the opposite: it expected `ok`
  to be the unreachable one. It is now reachable on this machine.)
- The ⓘ pin was exercised through a synthetic `click`, not a real touch sequence; touch
  behaviour rests on `useFloatingTip`, which this diff does not change.
- No screenshot comparison of the token-value tab was taken — the DOM comparison above is
  stronger for the question asked (has the markup changed), but it says nothing about
  rendered pixels.

## Fix loop — review round 1

**2026-09-08 — one Important finding, fixed.** Review verdict `fix`; report at
`~/.backlog-manager/orchestrator/…/reviews/task-23-1.md`. The finding is real and its
diagnosis is exact.

### What was wrong

`client/src/hooks/useFloatingTip.ts` — `tipHandlers` had none of the
`if (pinnedRef.current) return;` guards `pinHandlers` carries. This branch is the first to
spread **both** bundles onto one panel (hover on 168 grid cells and 118 hit columns, pin on
seven ⓘ sitting among them), so a pointer on its way anywhere overwrote a pinned definition
and then hid it, while `pinnedRef` and `aria-expanded="true"` survived — leaving the ⓘ
accent-highlighted with no panel, a screen reader told a collapsed control was expanded,
and the next click on that ⓘ taking the toggle-*off* branch and appearing to do nothing.

My original browser pass verified only that hover still works once the tab gained pins. The
reverse — a pin surviving a hover — is the direction that was broken, and I did not test it.

### What changed

`client/src/hooks/useFloatingTip.ts` (+26/−4) — the four pointer handlers in `tipHandlers`
(`onPointerEnter`, `onPointerMove`, `onPointerLeave`, `onPointerCancel`) now return early
while a pin is held, mirroring `pinHandlers`. Plus a JSDoc paragraph on why a pin outranks a
hover, and why `onFocus` is deliberately **not** guarded: reaching a mark by keyboard means
the pin's own `onBlur` already fired `hide()`, so no pin remains to outrank.

`docs/subsystems/usage-limits.md` — the paragraph at §The token-value board already claimed
a pinned panel "ignores hover". That was only true *within* `pinHandlers` before this fix;
it now says **"from either bundle"** and states why that scope is load-bearing here.

Nothing else touched. The plan's §3 assumed the hook untouched; the defect exists only
because this branch made the two bundles co-tenants, which is where the guard belongs — the
reviewer reached the same conclusion.

### Verification

```
$ pnpm typecheck
> tsc --noEmit
(no output — clean)

$ pnpm test
  38 passed, 0 failed      ← usageProfile.ts (inspector status line)
  31/31 passed
ALL PASS
```

Total still 1408 cases. `git diff HEAD --stat -- server shared client/src/lib/walkChart.ts`
still empty.

**Not unit-testable at this repo's level, and this is not a dodge.** `test/` is node-assert
over pure functions; there is no jsdom, no `@testing-library`, no renderer in
`devDependencies`. The one DOM-adjacent test (`test/web-notify-client.test.ts`) works only
because `useWebNotify.ts` exports plain non-hook functions beside the hook and the test stubs
globals. `useFloatingTip` exports **only** the hook, whose guard lives inside a `useCallback`
over a `useRef` — unreachable without a renderer. Extracting it to make it testable would be
a redesign well outside "fix that finding and nothing else". So it was verified in the
browser, both directions, plus a browser-level red proof.

### Browser proof, worktree ports, killed by pid

Same rig as the first pass (Vite 5273 → stub 4273 → live API 4173, synthetic 118-hour walk).

**Fix in place — the report's four steps, with real mouse input:**

| step | result |
|---|---|
| 1. click the headline ⓘ | `aria-expanded=true`, opacity 1, confidence definition shown |
| 2. hover a heatmap cell | definition **survives**, opacity 1, still expanded |
| 3. hover a walk hit column, then leave | definition **survives**, opacity 1, still expanded |
| 4. click the same ⓘ | closes properly — `aria-expanded=false`, opacity 0 |

**Not-broken check, nothing pinned:** heatmap cell hover opens `Tue 03:00 · every week`
(opacity 1); walk hit column opens `Thu 12:00` (opacity 1); leaving still hides. The
hover-only bundle is unaffected when no pin is held.

**Red proof (browser-level).** Reverted only `tipHandlers`' four guards — scoped with a
script to that function, after a first attempt with `perl -pi` wrongly stripped
`pinHandlers`' guards too and would have proved a doubly-broken state; caught by counting the
guards in each bundle before trusting the run. With the reverted build, all three reported
consequences reproduce:

- step 2: `definitionSurvived: false` — the panel now reads `Tue 03:00 · every week`
- step 3: opacity `0` **and** `aria-expanded` still `"true"`, button computed colour and
  border both `rgb(85, 208, 221)` (the accent) rather than `--text3` — the highlighted ⓘ with
  no panel
- step 4: `panelOpened: false` — the click is a no-op, exactly as reported

Restoring the fix returns every step to the table above.

**Token-value tab unchanged, verified not assumed.** `UsageRates` spreads `pinHandlers`
only; counted `0` non-ⓘ `[tabindex]` marks on that tab, so `tipHandlers` is never
constructed there and the guard is unreachable by construction. Pin/unpin still
`true`/opacity 1 → `false`/opacity 0 with the correct definition text; drawer still
`6 terms`, closed by default.

### Minor findings from the report — not actioned, by instruction

The dispatch said fix the Important finding and nothing else, so the eight Minor findings
stand. Three are worth the merger's attention because they are small and real:

- `client/src/styles.css:1000` — `.up-hit{color:var(--red)}` is now dead code; its only
  renderer was the walkmeta crossing span this branch deleted.
- The crossing clause lost its red emphasis in the move (`.up-hit` → `.rates-counts`). The
  chart's red rule and cross line still carry the alarm, so it reads deliberate — but it was
  a real change I did not declare as a deviation. Declaring it now.
- `test/usage-profile-view.test.ts:314-318` asserts `includes(String(TRUST_FLOOR_MIN))` /
  `includes(String(Y_MAX))`, which cannot distinguish a constant read from a same-valued
  literal. My mutation row *"floor + ceiling re-typed as literals → 1 failed"* only holds
  because that mutation also changed the numbers (60→45, 130→999). The reviewer is right
  that the claim is stronger than the assertion supports; the plan specified the assertion
  this way.

The other five (the unpinned malformed-ISO branch, `weight`'s unpinned live mean, the
double em-dash in the composed `confidence` string, the new "60 minutes per week" clause in
`cell`, and the live confidence token no longer appearing on the tab) are accurately
described in the report and need no correction from me.
