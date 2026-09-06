---
id: task-22
title: Token value tab: verdict-first layout with labelled figures, glossary drawer and coverage bar
created: 2026-09-06
tags: ui, usage, token-value
updated: 2026-09-06T20:24:24Z
started: 2026-09-06T18:54:46Z
execute-elapsed: 5378
execute-tokens: 657417
---

## Goal

Make the **Usage → Token value** tab readable by someone who does not already know how
the rates are fitted. Today the card opens on a 150-word paragraph of caveats, then rows
whose figures carry no labels and whose evidence line reads
`baseline forming · 4 days · 585 windows · 4 days · 663.0 pts` — two "4 days" meaning
different things, "pts" undefined — followed by the same hint sentence printed once per
row, three rows that show only `—`, and two footer pills ("59% priced", "12% external")
that never say priced *what*.

The redesign keeps every statement the card makes today and changes only **where and how**
it is said. **No server change, no contract change, no number changes.** Any diff under
`server/` or in `shared/types.ts` has escaped its scope.

### The direction, chosen from mockups

Three variants were mocked against the live 6 Sep data:
`docs/superpowers/specs/2026-09-06-token-value-layout-mockups.html` (also published at
https://claude.ai/code/artifact/95c83410-3b0e-4486-9792-1aabcfa7bf4d). The user picked
**variant A — a status board with a glossary drawer — plus variant B's ⓘ glyph on the
three figure labels**, and chose the *verdict* as what the page answers first. Variant C
(one table) was shown to be rejected: this dashboard is mostly read from a phone, and at
375px a 720px table scrolls the verdict column off screen first.

What the page becomes, top to bottom:

1. **One-sentence lead** instead of the paragraph: *"How many tokens each model gets out of
   1% of your 5-hour limit, and whether that price has moved. Measured on this machine
   only."*
2. **Status strip** — the question and its answer: `No model is drifting` (or
   `1 model is drifting`), with per-verdict counts beside it (`0 drift · 0 stable ·
   5 collecting`; zero counts omitted).
3. **The collecting hint, once.** *"Verdicts need about two weeks. A model is judged once
   it has 7 separate days behind its baseline and 2 behind the current window."* Shown
   when at least one model is `thin`, never per row. Drift and mix-shift hints stay in
   their own row — those are facts about one model.
4. **Model rows** — header (model id + verdict badge, unchanged), then up to three
   **labelled figure tiles**: `WEIGHTED RATE` (the judged figure, visually leading),
   `RAW TOKENS`, `FITTED, MIXED WINDOWS`. Each label carries a **ⓘ** that opens the term's
   definition in a floating panel. Under the tiles, an **evidence line split in two**:
   `Current 585 windows · 4 days · 663.0 pts` and `Baseline forming · 4 of 7 days`.
5. **A fold line for models with nothing to show** — `Not enough evidence yet:
   claude-sonnet-5 · 2 windows, claude-fable-5 · 0 windows, …` — instead of three rows of
   dashes.
6. **`How to read this` drawer** — a closed-by-default `<details>` with six definitions:
   Weighted rate, Raw tokens, Fitted, Baseline, Window · pts, Across models. The ⓘ panels
   quote the first three verbatim, so there is one copy of each definition.
7. **Coverage as a bar** — heading *How much of your spend was measured*, a big `59%`
   with `of 1,997 pts moved` beside it, a two-segment bar (measured in `--cyan`, remainder
   in `--hairline2`), and a value/label list of the refusals, largest first. "Priced"
   becomes "measured" in the reader's words; the pill vocabulary goes.

### Why the coverage bar is two segments, not six

The dataviz palette validator was run on the dashboard's own status hues
(`#55d0dd,#ffb03a,#cf6f9e,#66738c,#e0533f` against the midnight strip): it **fails** the
lightness band, the chroma floor and adjacent-pair CVD separation. `styles.css` forbids
new colour literals below the token block, so a six-hue categorical bar cannot be built
honestly in this design system. The question the bar answers is binary anyway — how much
was measured — and the refusal *reasons* are text, where identity does not depend on hue.

### The 12% external figure was not a bug

While mocking, the footer's `12% external` did not match `coverage.externalPct /
movedPct` (183 / 1997 = 9.2%). It is a different denominator, not a defect:
`externalShare` divides by the *attributable* movement (priced + mixed + external:
183 / 1506 = 12.15%), the coverage buckets divide by everything that moved. The redesign
lists the external row from the **bucket**, so it sums with the bar. `externalSharePct`
stays in the response (removing an API field is a separate decision) and the card stops
reading it.

### Out of scope, deliberately

- **The Forecast tab.** It has the same style of dense intro paragraph; the user chose to
  ship Token value alone and apply the pattern afterwards. Filed as its own idea.
- **Removing `externalSharePct` from the API.** See above.
- **Persisting the drawer's open/closed state.** YAGNI until someone asks.
- **Any change to what is computed.** `usage-rate.ts`, `api.ts`, the verdicts, the
  thresholds — untouched.

## Plan

**Plan-format override, deliberate, per `.claude/CLAUDE.md`:** behaviour, signatures and
exact test *cases* only — **no literal code blocks**. Handed code gets transcribed verbatim
and a bug here becomes a bug in the branch with nobody positioned to catch it. Disagree
with anything below in the PR body rather than transcribing around it. Any size figure
below is a soft target.

Work on a worktree branch (`feat/token-value-layout`), not in the shared checkout — the
user's dashboard runs from it on 5174.

### 1. Pure formatting — `client/src/lib/usageRatesFormat.ts`

Everything the card *says* stays a pure function so it is testable without a browser.
Keep `formatTok`, `formatDeviation`, `evidenceText`, `baselineText`'s three-state logic,
`formatShareOf`, `verdictText`. Add:

- `statusLine(models: ModelRateRow[]): { headline: string; counts: { label: string; n: number }[] } | null`
  — `null` for an empty list (the existing "Nothing measurable yet" note stands alone).
  Headline: `N model(s) is/are drifting` when any row is `drift`, else `No model is
  drifting`. Mix shift is **not** drift and never changes the headline. Counts: one entry
  per verdict with a non-zero count, in the fixed order drift, mix shift, stable,
  collecting, using `verdictText(v).label`.
- `hasFigures(row: ModelRateRow): boolean` — true when any of `weightedPerPct`,
  `rawPerPct`, `fittedWeightedPerPct` is a finite number. The rows this returns false for
  go to the fold line.
- `evidenceParts(row: ModelRateRow): { current: string; baseline: string }` — `current` is
  `evidenceText(intervals, days, utilSum)` unchanged. `baseline`: `none yet` when
  `baselineDays <= 0`; `forming · N of 7 days` when the baseline rate is null and
  `baselineDays < 7`; `forming · N days` when it is null at 7 or more (forming for another
  reason — do not claim a floor it has passed); `163k · 9 days` when the rate is present.
  The `7` is the floor `verdictText('thin')` already states; if the server exports it,
  import the number rather than writing a second literal, otherwise one named constant
  in this file feeds both strings.
- `waitingText(row: ModelRateRow): string` — `claude-sonnet-5 · 2 windows`, with the
  singular at 1 and `0 windows` at zero.
- `measuredShare(coverage: UsageCoverage): string | null` — `formatShareOf(pricedPct,
  movedPct)`; `null` when `movedPct <= 0` (a share of nothing is not 0%).
- `movedLabel(coverage: UsageCoverage): string` — `of 1,997 pts moved`, thousands
  separator, integer points, `en-US` locale explicitly so the test is deterministic.
- `coverageRows(coverage: UsageCoverage): { value: string; label: string }[]` — replaces
  `coverageClauses`. One row per bucket that cost something, **largest first** by points:
  pre-ledger → `predates recording · ages out on its own` (only when `startProvable`);
  external (from `coverage.externalPct`, never `externalSharePct`) → `spent on another
  device · excluded from the fit`; mixed → `no single model held 90% of the tokens`;
  partial → `windows the recorder only part-covered`; recorder down → `recorder down
  19.5 h`, present when **either** `missingPct > 0` or `recorderBreakHours > 0`, its value
  the share of `missingPct` (so `0%` beside real hours, which is the correct statement:
  time lost, nothing spent in it). Values via `formatShareOf`, so the tiny bucket keeps
  its decimal. Empty when nothing moved.
- `coverageCaveat(coverage: UsageCoverage): string | null` — the rotated-ledger sentence
  from today's `coverageClauses` when `startProvable` is false, else `null`. Rendered
  above the list because it qualifies every row.
- `RATES_GLOSSARY: readonly { key: 'weighted' | 'raw' | 'fitted' | 'baseline' | 'window' | 'across'; term: string; text: string }[]`
  — six entries, copy taken from the mockup's drawer. `figureTip(key)` returns the `text`
  of the matching entry; the ⓘ panels and the drawer read the same strings.

Delete `rawAsideText`, `fittedAsideText`, `pricedPillText`, `coverageClauses`,
`formatSharePct` and their tests — nothing else imports them (verify with grep before
deleting). Rewrite the module header: the card's statements are still all here, the shape
changed.

### 2. A shared floating tip — `client/src/hooks/useFloatingTip.ts` (new)

`UsageProfile.tsx` lines ~302–396 hold the tooltip mechanics: `placeTip` with the
`--font-scale` divide, `showTip`, `hideTip`, the scroll-follow effect with the
keyboard-anchor rule, and `tipHandlers`. Move them into a hook that returns
`{ tipRef, tipHandlers, pinHandlers, hide }` and renders nothing — the component mounts the
`<div className="up-tip" ref={tipRef} role="tooltip" aria-hidden="true" />` itself, as
today. **Move the comments with the code**; the coordinate-trap paragraph is the reason the
divide exists and must not be separated from it. `UsageProfile.tsx` loses the block and
gains one hook call; its behaviour is unchanged.

`pinHandlers(text)` is the new part, for the ⓘ buttons:

- Hover behaves exactly like `tipHandlers` (enter shows beside the pointer, move follows,
  leave hides) **unless the tip is pinned**.
- A **click** pins: shows the tip if hidden, keeps it if hover already showed it, anchors it
  to the button (so the existing scroll-follow rule moves it with the button rather than
  hiding it), and sets `aria-expanded="true"`. A second click on the same button unpins and
  hides. `Escape`, a `pointerdown` anywhere outside the button and the panel, and blur all
  unpin and hide. Clicking a *different* ⓘ moves the pin to it.
- On touch the sequence is pointerenter → click; the rule above makes that a single
  tap-to-open, which is the point — `pointerenter` alone shows on touch-down and hides on
  lift, too fast to read.
- The panel is written with `textContent`, never `innerHTML`, as today.

### 3. The component — `client/src/components/usage/UsageRates.tsx`

Keep `useUsageRates`, the loading/error notes, the `.up-off` recording-off block and the
"Nothing measurable yet" note exactly as they are. Replace `Row` and the body of the
card with the seven blocks from *The direction* above:

- Lead: `<p className="up-sub">` with the one sentence. The `HINTS.rates` line in
  `UsageView.tsx` stays.
- Status strip: from `statusLine(rates.models)`; not rendered when it returns `null`.
- Collecting notice: `verdictText('thin').hint` in one `.rates-notice`, only when some row
  is `thin`. Rows with `drift` or `mix-shift` keep `verdictText(v).hint` in-row
  (`.rates-hint`, as today); `stable` and `thin` rows carry no in-row hint.
- Rows: `rates.models.filter(hasFigures)`. Header unchanged (`.rates-model` +
  `.rates-badge`). Tiles in `.rates-figs`: the weighted tile always (it prints `—` for a
  fitted-only model — that is the honest statement the existing component doc defends),
  the raw tile only when `rawPerPct` is finite, the fitted tile only when
  `fittedWeightedPerPct` is finite. Each tile: `.rates-lab` (uppercase label + ⓘ
  `<button type="button" className="rates-i" aria-label="What is the … rate?">`), the value
  (`formatTok` in `.rates-value` with `.rates-unit` reading `tok / 1%` on the lead tile and
  `/ 1%` on the others), and a `.rates-sub` that exists only when there is a deviation to
  state: `+12.3% vs baseline` under weighted (red via `.rates-dev.drift` on a drift row),
  `+50.9% vs weighted` under fitted. Definitions live in the ⓘ, not in the tile.
- Evidence line `.rates-ev`: two spans, `Current …` and `Baseline …`, from
  `evidenceParts`. The word `forming` gets `.rates-forming` (amber) — it is the one thing
  on the line the reader is waiting on.
- Fold line `.rates-wait`: rendered when at least one row fails `hasFigures`, label
  `NOT ENOUGH EVIDENCE YET`, then `waitingText(row)` per model.
- Drawer: `<details className="rates-how">` closed by default, `<summary>` reading
  `How to read this` with a `6 terms` aside, `<dl className="rates-gloss">` over
  `RATES_GLOSSARY`.
- Coverage `.rates-cov`: heading, `measuredShare` big with `movedLabel` small, the bar as
  two `<i>` spans whose widths come from the priced share and the remainder (a 2px
  surface gap between them), `coverageCaveat` when non-null, then `coverageRows` as a
  two-column list. The whole block is omitted when `measuredShare` is `null`.

Rewrite the module doc comment: the two paragraphs about *why weighted leads* and *why the
fitted line does not lead* still hold and stay; replace the footer paragraph with why
coverage is a bar, and add a line on why the thin hint is hoisted.

### 4. Styles — `client/src/styles.css`, the rates block (~lines 855–895)

Tokens only, no literal colour or shadow; check all five themes, the light one is where a
`color-mix` over the wrong base shows. Keep `.rates-list`, `.rates-row`, `.rates-model`,
`.rates-value`, `.rates-unit`, `.rates-dev`, `.rates-hint`, `.rates-badge*` and the 560px
media block. Remove `.rates-raw`, `.rates-meta`, `.rates-foot`, `.rates-pill`,
`.rates-line`. Add `.rates-status`, `.rates-q`, `.rates-counts`, `.rates-notice`,
`.rates-figs` (3-column grid, `minmax(0,1fr)`, hairline top rule per tile),
`.rates-fig.lead`, `.rates-lab`, `.rates-sub`, `.rates-ev`, `.rates-forming`,
`.rates-wait`, `.rates-how` (+ `summary` with a rotating marker and no default
disclosure triangle), `.rates-gloss` (two-column `dl`, `max-content 1fr`), `.rates-cov`,
`.rates-bar`, `.rates-covlist`, `.rates-i`. The mockup file carries a working version of
each in midnight literals — translate them to tokens, do not paste them. Phone (`≤560px`):
tiles go two-up with the lead tile spanning both, the glossary `dl` goes single-column,
the badge drops to its own line as today.

Ensure `@media (prefers-reduced-motion)` disables the summary marker's rotation.

### 5. Docs

- `docs/subsystems/usage-limits.md`, the client paragraphs of *Token value per model*
  (~lines 977–1000): rewrite for the new layout — the status strip, the hoisted thin hint,
  the labelled tiles with ⓘ panels (a real element, never `title` — the same reason the
  profile tooltip exists), the split evidence line, the fold line, the drawer, and the
  coverage bar with its two-segment reason. Note that the external row now reads the bucket
  and why the two figures differed.
- `docs/overview.md` line ~186: add `useFloatingTip` to the hooks list.
- Re-stamp `usage-limits.md`'s `docs-sync` block (`client/src/components/usage/` and
  `usageRatesFormat.ts` are already among its sources) after the code commit.
- The mockup HTML is the design record; keep it where it is.

## Test cases

All in `test/usage-rates-format.test.ts` (node-assert, pure). The hook and the component
have no DOM test harness here — their verification is manual, listed under *Done when*.

Using the live 6 Sep row for opus as `OPUS` (`weightedPerPct 220077`, `rawPerPct 1332086`,
`fittedWeightedPerPct 332070`, `fitDeviationPct 50.888`, `intervals 585`, `days 4`,
`utilSum 663`, `baselineWeightedPerPct null`, `baselineDays 4`, `verdict 'thin'`) and the
live coverage as `COV` (`movedPct 1997, pricedPct 1171, mixedPct 152, externalPct 183,
preLedgerPct 438, missingPct 5, partialPct 48, recorderBreakHours 19.4519, startProvable
true`):

1. `statusLine([])` → `null`.
2. `statusLine` over five `thin` rows → headline `No model is drifting`, counts exactly
   `[{ label: 'collecting', n: 5 }]`.
3. `statusLine` over one `drift`, one `stable`, one `thin` → headline `1 model is drifting`,
   counts in the order drift 1, stable 1, collecting 1.
4. `statusLine` over two `drift` rows → `2 models are drifting`.
5. `statusLine` over one `mix-shift` and two `stable` → headline `No model is drifting`,
   counts `mix shift 1` then `stable 2`.
6. `hasFigures`: all three rates null → `false`; only `fittedWeightedPerPct` → `true`; only
   `rawPerPct` → `true`; `weightedPerPct = NaN` alone → `false`.
7. `evidenceParts(OPUS)` → current `585 windows · 4 days · 663.0 pts`, baseline
   `forming · 4 of 7 days`.
8. `evidenceParts` with `baselineDays 0` → baseline `none yet`.
9. `evidenceParts` with `baselineWeightedPerPct 163000, baselineDays 9` → `163k · 9 days`.
10. `evidenceParts` with the rate null and `baselineDays 9` → `forming · 9 days` (no
    `of 7` once past the floor).
11. `evidenceParts` singulars: `intervals 1, days 1, utilSum 2, baselineDays 1` → current
    `1 window · 1 day · 2.0 pts`, baseline `forming · 1 of 7 days`.
12. `waitingText`: `intervals 2` → `claude-sonnet-5 · 2 windows`; `1` → `… · 1 window`;
    `0` → `… · 0 windows`.
13. `measuredShare(COV)` → `59%`; with `movedPct 0` → `null`.
14. `movedLabel(COV)` → `of 1,997 pts moved`; `movedPct 850.4` → `of 850 pts moved`.
15. `coverageRows(COV)` → exactly five rows in this order: `22%` / `predates recording ·
    ages out on its own`; `9%` / `spent on another device · excluded from the fit`; `8%` /
    `no single model held 90% of the tokens`; `2%` / `windows the recorder only
    part-covered`; `0.3%` / `recorder down 19.5 h`.
16. `coverageRows` with only `pricedPct` non-zero → `[]`; with `movedPct 0` → `[]`.
17. `coverageRows` with `missingPct 0` and `recorderBreakHours 2` → one row `0%` /
    `recorder down 2.0 h`.
18. `coverageRows` with `startProvable false` and `preLedgerPct 400` → no `predates` row;
    `coverageCaveat` returns the rotated-ledger sentence; with `startProvable true` →
    `null`.
19. `RATES_GLOSSARY` has six entries with the keys `weighted, raw, fitted, baseline,
    window, across` in that order; `figureTip('fitted')` is the same string as the
    `fitted` entry's `text`.
20. The tests for `rawAsideText`, `fittedAsideText`, `pricedPillText`, `coverageClauses`,
    `formatSharePct` are deleted with the functions; `pnpm test` prints a case count that
    is the old count minus those plus the cases above.

## Done when

- `pnpm test` and `pnpm typecheck` pass, output pasted in the PR.
- No file under `server/` or `shared/` is in the diff.
- On a worktree dev server (alternate ports, started by pid — see the memory on
  worktree previews; `pnpm build` first): screenshots at 640px and 375px match the
  mockup's variant A in structure; the ⓘ panel opens on tap and on hover, follows its
  button on scroll when pinned, and lands **on** the pointer at 125% text scale, not
  25% down-right of it; the Forecast tab's grid tooltip still behaves as before
  (hover, press-and-hold, Tab to a cell).
- The five themes each render the coverage bar and the `forming` word legibly (the light
  theme is the one to look at).
- Drift, stable and mix-shift rows cannot be verified against live data this fortnight —
  say so in the PR under *not verified*; the format tests are what covers them.
- `usage-limits.md` and `overview.md` updated and re-stamped; the Forecast follow-up
  exists as an open idea.

## Outcome

**2026-09-06 — done.** The Token value tab is the variant-A status board: one-sentence
lead, status strip, the collecting hint hoisted out of the rows, labelled figure tiles with
ⓘ panels, the evidence line split in two, a fold line for models with nothing to show, a
closed-by-default glossary drawer, and coverage as a two-segment bar. No file under
`server/` or `shared/` is in the diff (`git diff --stat -- server shared` is empty), and no
number the card prints was changed — only where and how it is said.

### Files

| file | change |
|---|---|
| `client/src/lib/usageRatesFormat.ts` | added `statusLine`, `hasFigures`, `evidenceParts`, `waitingText`, `measuredShare`, `movedLabel`, `coverageRows`, `coverageCaveat`, `RATES_GLOSSARY`, `figureTip`; deleted `rawAsideText`, `fittedAsideText`, `pricedPillText`, `coverageClauses`, `formatSharePct` |
| `client/src/hooks/useFloatingTip.ts` | **new** — the tooltip mechanics moved out of `UsageProfile.tsx` verbatim, plus `pinHandlers` (click-to-pin) |
| `client/src/components/usage/UsageRates.tsx` | rewritten as the seven blocks |
| `client/src/components/usage/UsageProfile.tsx` | lost the tooltip block, gained one hook call |
| `client/src/styles.css` | rates block rewritten; `.rates-raw/-meta/-foot/-pill/-line` gone |
| `test/usage-rates-format.test.ts` | 21 cases → 30 |
| `docs/subsystems/usage-limits.md`, `docs/overview.md` | rewritten for the new layout |

### Verification

`pnpm typecheck` — exit 0, no output.

`pnpm test` — exit 0:

```
=== usageRatesFormat.ts ===
  ✓ statusLine: no models is no claim at all, not "none drifting"
  ✓ statusLine: five collecting models are not drifting
  ✓ statusLine counts every verdict in a fixed order, zeroes omitted
  ✓ statusLine agrees with itself in the plural
  ✓ statusLine: a mix shift is not drift and never enters the headline
  ✓ hasFigures: any one rate keeps a row, all three missing folds it
  ✓ evidenceParts splits the line the two "4 days" collided on
  ✓ evidenceParts: no baseline days at all is "none yet"
  ✓ evidenceParts states a baseline that exists
  ✓ evidenceParts stops naming the floor once the baseline is past it
  ✓ evidenceParts: the singulars
  ✓ waitingText names the model and how far it has got
  ✓ measuredShare is the bar headline, and null when nothing moved
  ✓ movedLabel names the denominator in whole points, thousands separated
  ✓ the live coverage lists every refusal, largest first
  ✓ a bucket that cost nothing produces no row at all
  ✓ recorder downtime is listed on hours alone, and says 0% honestly
  ✓ an unprovable start drops the pre-ledger row and leads with the caveat
  ✓ the glossary is the single copy of every definition the card shows

  30 passed, 0 failed

  31/31 passed
ALL PASS
```

1395 assertions across the suite.

**In a real browser.** A worktree dev server on 4273/5273 (started and killed by recorded
pid; the user's 5174 was untouched and still listening afterwards), fed a copy of this
machine's live ledger so the card had the five-model / `recording: true` shape it was
designed against. Deleted afterwards.

- **640px and 375px** match variant A in structure. At 375px the lead tile spans both
  columns, raw and fitted sit two-up, the glossary drops to one column and nothing scrolls
  sideways.
- **The ⓘ panel**: hover shows it beside the pointer (measured `dx +14 / dy −14`); click
  pins it (`aria-expanded="true"`, cyan border); a pinned panel **follows its button on
  scroll** (button and panel both moved exactly −120px); hovering a *different* ⓘ while
  pinned leaves it alone (verified with a real mouse, not a synthetic event); a second
  click, `Escape`, and a press outside all unpin; clicking another ⓘ moves the pin.
- **At 125% text scale** the panel lands **on** the pointer — `dx 17 / dy −18` visual px,
  i.e. the intended 14px offset × 1.25, not 25% down-right of it. The `--font-scale` divide
  survived the move into the hook.
- **The Forecast tab's tooltip still behaves as before.** Compared against the pre-change
  build running on 5174: at the same starting scroll position both produce identical
  numbers (focus → `opacity 1`, `top 339.594px` at `cellTop 354`; scroll → follows exactly
  −60px). An earlier reading suggesting a regression was an artifact of my own probe — the
  two builds had the cell in different scroll positions — and did not reproduce under
  controlled conditions.
- **All five themes** render both bar segments and the `forming` word.

### Deviations from the plan, and why

1. **`weeklyAsideText` was kept.** The plan was written before task-21 merged, so it lists
   neither keeping nor deleting the weekly-limit line. Since the redesign's own rule is
   that it "keeps every statement the card makes today", the weekly figure stays — as one
   line under the tiles rather than a fourth tile, because it prices a ~8–14× larger window
   and a tile row reads as one comparable set. The `!anyWeekly` note block was kept for the
   same reason. The glossary stays at six entries, as specified.
2. **The 7-day floor is a local constant, not imported from the server.** The plan
   preferred importing `BASELINE_FLOORS` "if the server exports it" — it does. But
   `.claude/CLAUDE.md` says the only thing crossing the FE/BE boundary is the typed JSON in
   `shared/types.ts`, and a client module importing server code would be a runtime coupling
   for one integer. `BASELINE_DAY_FLOOR` in `usageRatesFormat.ts` feeds both the `thin` hint
   and `evidenceParts`, with the reason written at the constant.
3. **The collecting notice does not re-cut the hint string.** The plan's example copy
   ("A model is judged once it has…") would need a regex over `verdictText('thin').hint`.
   The lead is phrased around the hint instead — *"Collecting is the normal first fortnight
   — a verdict needs 7 separate days behind the baseline and 2 behind the current window."*
   — so the copy has one owner and cannot be mangled the day the floors change.

### Not verified — needs a human

- **Drift, stable and mix-shift rows.** Every model on this machine is `thin`; those
  verdicts cannot be produced from live data this fortnight. The format tests cover the
  copy (`statusLine`, the `.rates-dev.drift` red deviation, the in-row hint) but no drift
  row has been seen rendered.
- **Coverage states other than the live one.** `startProvable: false` (the rotated-ledger
  caveat) and `movedPct <= 0` (the whole block omitted) are unit-tested, never rendered.
- **Touch.** The tap-to-open sequence is reasoned from the pointer event order and verified
  with mouse gestures; no real phone was used.
- **Two contrast readings in the `daylight` theme**, measured but deliberately not changed:
  the `forming` word sits at **4.03:1** against the row (AA wants 4.5), and the bar's two
  segments separate at **2.31:1** (with a 2px gap between them). Both come from the shared
  `--amber` / `--accent` / `--border2` tokens behaving as they do everywhere else —
  `color:var(--amber)` is small text at a dozen other sites in `styles.css`, some at 10px.
  Retuning a theme token is a wider decision than this relayout.
- **`docs/subsystems/usage-limits.md` is NOT re-stamped.** The plan says to re-stamp after
  the code commit, and this session never commits — the orchestrator does. The stamp still
  reads `84519e7f…`, which correctly reports the doc as needing review rather than falsely
  claiming it was verified against a commit that did not exist when it was written.
  **Re-stamp it to the merge commit.**
- The Forecast follow-up idea was filed at groom time (`idea-22`); this session did not
  re-check it.
