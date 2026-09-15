# Breakpoint Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace six ad-hoc widths in `client/src/styles.css` with a named seven-tier
mobile-first ladder on Tailwind's numbers, with every tier defined for both content-width
settings.

**Architecture:** Base (unprefixed) styles become the phone layout; seven `min-width`
queries layer upward. The lock is re-derived at 1536 by dropping the measure to 1248.
Board stops changing column count and changes *shape* instead — buckets stack below `xl`
and wrap their cards intrinsically, removing a media query rather than adding one.

**Tech Stack:** Plain CSS in a single stylesheet (`client/src/styles.css`, ~2000 lines),
no preprocessor, no PostCSS plugins, no new dependencies. Tests are node-assert modules
under `test/`, run by `test/run-all.ts` via tsx.

**Spec:** `docs/superpowers/specs/2026-09-15-breakpoint-ladder-design.md` — read it first.
Every number in this plan comes from there; where they disagree, the spec wins.

## Global Constraints

- **No literal CSS is given in this plan, deliberately.** Per `.claude/CLAUDE.md`:
  handed code gets transcribed verbatim, so a bug in the plan becomes a bug in the
  branch with nobody positioned to catch it. Selectors, property values and tier
  numbers are exact; the writing is yours, and you are expected to disagree with this
  plan where it is wrong.
- **Keep CSS class names stable.** `styles.css` is a verbatim port of the original
  inline `renderPage()`. No renames, no new classes except where a task says so.
- **Never hardcode a color or shadow below the theme-token block.** The five themes are
  pure `[data-theme]` token overrides; one literal breaks the light one. This work
  touches layout only — if you find yourself typing a color, stop.
- **No new dependencies**, client or server.
- **The seven tiers, exact:** base (0), `sm` 640, `md` 768, `lg` 1024, `xl` 1280,
  `2xl` 1536, `3xl` 1537, `4xl` 1921.
- **The shell arithmetic:** rail 240 + `--body-pad` 24×2 + measure **1248** = **1536**.
  The rail and padding do not change. The measure changes from 1280 to 1248.
- **The 640/768 principle:** 640 is the *shell* boundary (rail returns, board stops
  being full-bleed). 768 is the *density* boundary (column counts, hidden table
  columns, padding). A rule that sat at 700 for shape reasons goes to `sm`; a rule
  that sat at 700 for density reasons goes to `md`.
- **Both content-width settings are defined at every tier.** Capped freezes at 1248
  above the lock and stays left-aligned (`margin:0` is not touched). Full uncaps and
  gains structure at `3xl`/`4xl`.
- **A task owns every selector in the phone block it names, not only the ones its element
table lists.** The `max-width:700px` blocks are being deleted as blocks, so any selector
left unclaimed is silently dropped. Before finishing, list every selector in the block you
are deleting and confirm each one landed on a tier. Shape rules go to `sm`; density and
control-fitting rules go to `md`.
- `pnpm typecheck` and `pnpm test` must pass at every commit.

## Verification method

CSS layout is not unit-testable and this plan does not pretend otherwise. Only Tasks 1
and 10 carry automated tests. Every other task is verified in the Browser pane:

1. `preview_start` with the dev server (`pnpm dev`, http://localhost:5174).
2. `resize_window` to each width the task names.
3. `read_page` to confirm structure, or a screenshot for visual checks.
4. Toggle Settings › Display › Content width between capped and full, and re-check
   every width at or above 1536.

**The eight canonical widths:** 375, 640, 768, 1024, 1280, 1536, 1920, 2560.

---

## File Structure

- `client/src/styles.css` — every layout change. Single file by design; do not split it.
- `test/breakpoints.test.ts` — **new.** Guard test for the ladder. Modelled on
  `test/docs-links.test.ts` (repo-root walk, local `test()` helper,
  `export function run(): number`).
- `test/run-all.ts` — register the new module.
- `.claude/DESIGN.md` — lines 244, 291, 300 hardcode 1100px and 700px.
- `docs/subsystems/` — a new `breakpoints.md` plus its one-line entry in
  `docs/overview.md` §Map.

---

### Task 1: Ladder token block and its guard test

Establishes the seven numbers as the single documented source, and a test that fails if
a future edit invents an eighth.

**Files:**
- Modify: `client/src/styles.css` (comment block near the top, above `:root`)
- Create: `test/breakpoints.test.ts`
- Modify: `test/run-all.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function run(): number` from `test/breakpoints.test.ts`, imported in
  `run-all.ts` as `runBreakpoints` and called as `failed += runBreakpoints();` —
  synchronous, matching `runDocsLinks` and `runTailnet`.
- Produces: the token comment block's exact format, which Task 10's assertions parse.

**The token block.** CSS cannot read `var()` inside `@media`, so the seven numbers are
literals in the queries and the block is documentation plus the test's parse target.
Format it as one line per tier reading `name` then `min-width` then a short role, in
ascending order, inside a single `/* ... */` comment. Include a sentence saying why it
is a comment and not a custom property, so the next reader does not "fix" it.

- [ ] **Step 1: Write the failing test**

Four cases in `test/breakpoints.test.ts`. Find the repo root by walking up for
`package.json` — copy that helper's *approach* from `docs-links.test.ts`, never a fixed
`../..` hop count (`.claude/CLAUDE.md` records this biting twice).

| Case | Asserts |
|---|---|
| `documents all seven tiers` | The token block names exactly `sm md lg xl 2xl 3xl 4xl` and no other tier name |
| `tier values are exact` | The block maps them to exactly `640 768 1024 1280 1536 1537 1921` |
| `tiers are ascending` | The seven parsed values are strictly increasing |
| `the lock is derived` | The block states the 240 + 48 + 1248 = 1536 arithmetic, and 240, 1248 and 1536 each appear in it |

Do **not** assert anything about `@media` queries in this task — the stylesheet is still
desktop-first and those assertions belong to Task 10.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — `breakpoints.test.ts` reports 4 failed, because the token block does
not exist yet. `run-all.ts` exits nonzero and prints `FAILED (4)`.

- [ ] **Step 3: Add the token block**

Write it into `styles.css` above `:root`. Nothing else in the stylesheet changes in this
task — no query is touched yet.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS — `ALL PASS`, and the printed case count is 4 higher than before.

- [ ] **Step 5: Commit**

```bash
git add client/src/styles.css test/breakpoints.test.ts test/run-all.ts
git commit -m "test(css): document the breakpoint ladder and guard its values"
```

---

### Task 2: Shell — measure, lock, and the phone inversion

The riskiest structural task. It inverts the block that `.claude/CLAUDE.md` and the spec
both flag: the phone rules become the base declarations.

**Files:**
- Modify: `client/src/styles.css:137` (`.wrap` measure), `:143` (`.wrap.wide/.broad`),
  `:157-158` (`.shell`, `.rail`), `:232` (`.main`), `:243-300` (the whole
  `max-width:700px` shell block), `:763-777` (the 1568 derivation comment)

**Interfaces:**
- Consumes: Task 1's token block (for the numbers).
- Produces: base styles that are the phone layout, and a `min-width:640px` block that
  restores the desktop shell. Every later task layers on top of this inversion.

**Changes:**

1. **Measure 1280 → 1248** on `.wrap.wide, .wrap.broad`. `.wrap`'s own 820px default is
   unchanged. `[data-width="full"]`'s three `max-width:none` lines are unchanged.
2. **Invert the phone block.** Everything currently inside `@media (max-width:700px)`
   starting at line 243 becomes unprefixed base style; its former desktop counterparts
   move into `@media (min-width:640px)`. The inverted rules must produce byte-identical
   *rendering* — this is a cascade rewrite, not a behaviour change.
3. **Rewrite the 1568 comment** at line 763 to derive 1536 instead. Keep both existing
   caveats (compact density's 20px-early crossover, and `zoom`/`--font-scale` landing
   tiers late), and keep the `[data-width="full"]` note.

**Watch for:** `body`'s background is set inside the phone block deliberately — the
canvas takes its color from the body, and the comment at line 243 explains why it is on
`<body>` and not `.shell`. Preserve that reasoning through the inversion.

- [ ] **Step 1: Capture the before state**

Screenshot all eight canonical widths on Sessions before changing anything. These are
the reference for "mobile behaves exactly as it does now" — Risk 1 in the spec makes
this a property you verify, not one the diff guarantees.

- [ ] **Step 2: Invert the shell block and drop the measure**

- [ ] **Step 3: Verify the phone is unchanged**

At 375 and 639, compare against Step 1: rail is a top bar, burger present, board
full-bleed, `body` ground correct on all five themes. Any pixel difference is a bug in
the inversion, not an improvement.

- [ ] **Step 4: Verify the lock**

At exactly 1536 with content width capped, `.wrap.wide` must measure 1248px and the
shell must exactly fill the viewport with no horizontal scrollbar. At 1535 it must be
1247 or less. Confirm via `javascript_tool` reading `getBoundingClientRect().width`.

- [ ] **Step 5: Verify above the lock**

At 1920 and 2560 capped: measure stays 1248, board stays hard-left, slack falls right.
`pnpm typecheck` and `pnpm test` green.

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "refactor(css): invert the shell to mobile-first and re-derive the lock at 1536"
```

---

### Task 3: Board — stacked buckets and intrinsic card wrap

The one task that removes more than it adds. Board goes from two media queries to one.

**Files:**
- Modify: `client/src/styles.css:617` (`.board`), `:618` (`.bcol`), `:619` (`.col-h`),
  `:630` (`.bempty`), and the Board rules inside the old 1100px and 700px blocks

**Interfaces:**
- Consumes: Task 2's inverted base.
- Produces: `.bcol` as an intrinsic grid. Task 9 relies on it needing no new rule at
  `3xl`/`4xl`.

**Changes:**

1. **`.bcol` becomes a grid**, not a flex column: `auto-fill` tracks of
   `minmax(280px, 1fr)`, gap 10px (its current gap), `align-content:start`.
2. **`.col-h` and `.bempty` span every column** (`1 / -1`). The header must stay one
   full-width line above its cards, and the empty-lane ghost must hold the full bucket
   width rather than one card slot.
3. **`.board` gets exactly one query.** Base through `lg`: one column, so the three
   buckets stack vertically, each full width. From `xl`: three equal columns.
4. **Delete** the old `.board` rules in the 1100px and 700px blocks.

**No DOM change.** `BoardView.tsx` already renders `.board > .bcol > .col-h + cards`.

**Expected cards per line** — `floor((width + 10) / 290)`:

| Width | 375 | 640 | 768 | 1024 | 1280 | 1536 | 1920 full | 2560 full |
|---|---|---|---|---|---|---|---|---|
| Shape | stacked | stacked | stacked | stacked | 3 buckets | 3 buckets | 3 buckets | 3 buckets |
| Cards/line | 1 | 1 | 1 | 2 | 1 | 1 | 1 | 2 |
| Bucket px | full | 352 | 480 | 736 | 320 | 293 | 401 | 614 |

The 2 cards/line at 2560 is emergent from `auto-fill` once a bucket passes 570px. It is
intended — buckets fill rather than stretch, with no extra rule.

**Known discontinuity, accepted:** buckets are 320px at `xl` and 293px at `2xl`, because
the aside returns and takes 336px. Cards per line never changes (293 > the 280 floor).
Do not "fix" this; the spec records it as a review decision.

- [ ] **Step 1: Rewrite `.bcol` as the intrinsic grid**

- [ ] **Step 2: Verify the header and ghost span**

At 1024, a bucket shows 2 cards per line with its heading on its own full-width line
above them, and an empty bucket's `.bempty` ghost spans the full bucket width, not
280px.

- [ ] **Step 3: Collapse `.board` to one query**

- [ ] **Step 4: Verify every width**

Walk all eight canonical widths against the table above. Confirm all three buckets are
present and labelled at every width — a bucket must never be dropped or wrapped onto a
second row.

- [ ] **Step 5: Verify the selected ring survives**

`.bcard.selected`'s 2px ink ring costs no layout; confirm it still sits flush at 2
cards/line and does not clip against the grid gap.

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): stack Board buckets below xl and wrap cards intrinsically"
```

---

### Task 4: Sessions — tiles, split, aside, ledger

**Files:**
- Modify: `client/src/styles.css:302` (`.sessions`), `:307` (`.s-aside`), `:676`
  (`.split`), `:713` (`.tiles`), `:715` (`.tile.selected`), `:648` (`.ledger` column
  widths), and their rules in the old 1568px and 700px blocks

**Interfaces:**
- Consumes: Task 2's inverted base.
- Produces: the `.sessions` two-column shape at `2xl` that Task 9 widens.

**Target ladder.** A blank cell carries the value to its left forward:

| Element | base | `sm` 640 | `md` 768 | `xl` 1280 | `2xl` 1536 |
|---|---|---|---|---|---|
| `.tiles` columns | 1 | 1 | 2 | 3 | 3 |
| `.split` | `1fr` | | `280px + 1fr` | | `320px + 1fr` |
| `.sessions` | 1 col | | | | `1fr + 320px` aside |
| `.s-aside` | 1-up | | 2-up | | beside, `order:1` |
| `.ledger` model column | hidden | hidden | shown | | |
| `.ledger .c-ctx` | 120px | 120px | 200px | | |

- `.s-aside` keeps `order:-1` (above the list) at every tier below `2xl`.
- `.tile.selected{grid-column:span 2}` applies from `md` only. At base and `sm` the grid
  is single-column and the span must be cancelled.
- Expected tile widths: `md` 232, `xl` 320, `2xl` 293, and Task 9 adds `3xl` 396,
  `4xl` 442.

- [ ] **Step 1: Move each element onto its tier**

- [ ] **Step 2: Verify the ledger at the density boundary**

At 767 the model column is hidden and `c-ctx` is 120px; at 768 both return. The table is
`table-layout:fixed`, so a mismatch between the `col` width and the hidden `th`/`td`
shows as misaligned columns rather than as an error.

- [ ] **Step 3: Verify the aside crossover**

At 1535 the aside sits above the list, two cards side by side. At 1536 it moves to a
320px right column with `order:1`. Confirm the list column is 912px at 1536.

- [ ] **Step 4: Verify the selected tile**

At 639 a selected tile spans one column (not two, which would overflow). At 768 it spans
two.

- [ ] **Step 5: Walk all eight widths in both content-width settings**

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): move Sessions tiles, split, aside and ledger onto the ladder"
```

---

### Task 5: Management

**Files:**
- Modify: `client/src/styles.css:843-844` (`.mgmt`, `.mgmt.pair`), the old 1330px block
  at `:848`, and the old 700px block at `:852`

**Interfaces:**
- Consumes: Task 2's inverted base.
- Produces: nothing later tasks depend on.

**Target ladder:**

| | base | `md` 768 | `xl` 1280 |
|---|---|---|---|
| `.mgmt`, `.mgmt.pair` | 1 column | `190px + 1fr`, `.mdetail` full-width row | `190px + 420px + 1fr` |

The detail pane is **350px** from `xl` to `2xl`, then 606px at the lock — narrower than
the 400px the layout flips at today.

Management keeps its exclusion from the pinned-pane shell (`.wide-mgmt`): its columns
size to content and the page body stays the single scroller. Do not fold it in.

The phone block's scroll-to-third-column offset must survive: it deliberately stops short
of the sticky nav bar, or the card's heading lands under it.

- [ ] **Step 1: Move `.mgmt` onto the ladder**

- [ ] **Step 2: Verify the detail pane at its narrowest**

At 1280, the detail pane is 350px. Open a management item with a long file path and a
long `.mitem-desc` (capped at `max-width:76ch`) and confirm neither overflows nor
forces a horizontal scrollbar. **This is the band most likely to need a fix** — if it
breaks, report it rather than widening the fixed 190/420 columns unilaterally.

- [ ] **Step 3: Verify the phone scroll offset**

At 375, selecting an item scrolls it clear of the sticky nav bar.

- [ ] **Step 4: Walk all eight widths in both content-width settings**

- [ ] **Step 5: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): move Management columns onto the ladder"
```

---

### Task 6: Analytics

**Files:**
- Modify: `client/src/styles.css:1009` (the `min-width:1201px` pinned-pane block),
  `:1084` (`.an-metrics`), `:1092` (`.an-cols`), and the old 900px and 700px blocks at
  `:1118-1119`

**Interfaces:**
- Consumes: Task 2's inverted base, Task 4's `.split` (Analytics reuses it verbatim).
- Produces: nothing later tasks depend on.

**Target ladder:**

| | base | `md` 768 | `lg` 1024 | `xl` 1280 |
|---|---|---|---|---|
| `.an-metrics` | 3-across | 3-across | **5-across** (147px each) | |
| `.an-cols` | 1 column | 2 columns | | |
| Pinned panes | off | off | off | **on** |

- 5-across arrives at `lg`, later than today's 900 — the 900–1023 band drops from 5
  figures to 3. This is intended: at 900 each figure gets only 122px.
- The `:nth-child` seam rules currently in the 900px block (`nth-child(4)` losing its
  left border, `nth-child(n+4)` gaining a top border, `nth-child(5)` spanning two) belong
  to the **3-across** shape. Under inversion they become base rules and must be undone
  at `lg`, not the other way around.
- The pinned-pane query moves from `min-width:1201px` to `xl`. Keep its `100vh /
  var(--font-scale)` correction and its `- 2 * var(--body-pad)` subtraction exactly —
  the comment explains that getting it wrong scrolls the page, which is what the pane
  scrollers exist to prevent. Keep `:not(.wide-mgmt)`.

- [ ] **Step 1: Move `.an-metrics` and `.an-cols` onto the ladder**

- [ ] **Step 2: Verify the metric seams at both shapes**

At 1023 (3-across) and 1024 (5-across), every seam is correct: no figure has a stray
column seam, none is missing a row seam, and none is offset from the one above it. This
is the same class of bug the statstrip comment documents.

- [ ] **Step 3: Move the pinned-pane query to `xl`**

- [ ] **Step 4: Verify pane scrolling**

At 1280, the Analytics tab scrolls inside itself and the page body does not scroll. At
1279 the page body scrolls instead. At 1280 with text scale at 110%, the pane must still
not overhang the viewport.

- [ ] **Step 5: Walk all eight widths in both content-width settings**

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): move Analytics metrics and pane pinning onto the ladder"
```

---

### Task 7: Usage statstrip — the specificity inversion

**Highest-risk task in this plan.** Give it its own review. The spec's Risk 2 is entirely
about this file region.

**Files:**
- Modify: `client/src/styles.css:1666-1671` (`.statstrip` and its seams), the old 1568px
  block at `:1912`, the old 700px block at `:1920`, and `.sheet` at `:1681`

**Interfaces:**
- Consumes: Task 2's inverted base.
- Produces: nothing later tasks depend on. Statstrip takes no `3xl`/`4xl` rule.

**Target ladder:**

| | base | `md` 768 | `2xl` 1536 |
|---|---|---|---|
| `.statstrip` columns | 2 | 3 | 5 |
| `.sheet` padding | 20px | `22px 24px` | |

**Why this is dangerous.** The comment at `styles.css:1925` records that the phone
block's rules are written as `:nth-child` forms *specifically to win* against the wide
rules — `>div{border-left:0}` loses to `>div+div` (same class, one fewer type selector),
and `>div{border-top:2px}` loses to `:nth-child(-n+3){border-top:0}`. Written plainly,
tile 3 came out with a stray column seam and no row seam: a card offset from the one
above it.

Inverting the cascade **reverses every one of those contests**. The 2-column rules become
base and the 3- and 5-column rules become overrides, so the selectors that were written
to be *stronger* may now need to be *weaker*, or the reverse. Do not mechanically invert
this block. Work out the seams from scratch for each of the three column counts, and
verify each visually.

Statstrip renders a variable-length tile list (`Sheet.tsx:49`) and its seams are pinned
to column counts, so it cannot become `auto-fill`. Keep explicit counts.

- [ ] **Step 1: Screenshot all three shapes before touching anything**

At 375 (2-col), 1024 (3-col) and 1536 (5-col), on at least two callers with different
tile counts. These are the reference.

- [ ] **Step 2: Rewrite the seams for the 2-column base**

Every `>div` after the first gets a left seam except the first in each row; every row
after the first gets a top seam. Derive it; do not port it.

- [ ] **Step 3: Verify the 2-column shape**

At 375: no stray column seam on any tile, no missing row seam, no tile offset from the
one above. An odd last tile spans both columns so the block closes rather than drawing a
seam into blank paper.

- [ ] **Step 4: Add the 3-column and 5-column overrides**

- [ ] **Step 5: Verify all three shapes against Step 1**

At 375, 1024 and 1536, on both callers. Every seam correct at every tile count.

- [ ] **Step 6: Verify the density boundary**

At 767 the strip is 2-across at 176px per cell; at 768 it is 3-across at 160px. Labels,
figures with units, and sub-lines all fit without truncation.

- [ ] **Step 7: Walk all eight widths in both content-width settings**

- [ ] **Step 8: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): move the Usage statstrip onto the ladder"
```

---

### Task 8: Settings and modals

**Files:**
- Modify: `client/src/styles.css:1531` (`.set-cols`), `:1533` (`.set-group`), the old
  700px blocks at `:1452` (chat modal) and `:1599` (settings)

**Interfaces:**
- Consumes: Task 2's inverted base.
- Produces: nothing later tasks depend on.

**Target ladder:**

| | base | `md` 768 |
|---|---|---|
| `.set-cols` | 1 column | 2 columns |
| `.set-group` padding | 20px | 24px |
| `.set-row` | stacked, `align-items:flex-start` | row |
| `.set-control` | `width:100%`, wraps | auto |
| Chat modal | full-screen, `.chat-back` padding 0 | windowed with scrim |

**Modals leave the ladder entirely above `md`.** `.chat` holds at 1080px and `.spawn` at
620px at every tier including `3xl` and `4xl`. Both keep `max-width:100%` and
`max-height:min(820px,100%)`. Do not add a `3xl` or `4xl` rule for either — a modal is a
focused reading surface and 1080px is already at the top of a comfortable measure for
transcript text.

The chat modal's full-screen presentation below `md` is load-bearing: there is no scrim
there, so `✕` and the browser's back button are the only exits
(`docs/subsystems/chat.md`). Preserve that.

- [ ] **Step 1: Move Settings onto the ladder**

- [ ] **Step 2: Move the chat modal's full-screen boundary from 700 to `md`**

- [ ] **Step 3: Verify the modal exits below `md`**

At 375 and 767 the chat modal is full-screen with no scrim, and both `✕` and browser-back
close it. At 768 the scrim returns.

- [ ] **Step 4: Verify modals do not grow**

At 1920 and 2560, in **both** content-width settings, `.chat` measures 1080px and
`.spawn` measures 620px. Confirm via `getBoundingClientRect().width`.

- [ ] **Step 5: Walk all eight widths in both content-width settings**

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): move Settings and the modal boundary onto the ladder"
```

---

### Task 9: The 3xl and 4xl tiers

The only tiers that did not exist before. Both are scoped under
`:root[data-width="full"]` — in capped mode they carry no rules, because capped's
defined behaviour above the lock is to hold at 1248, left-aligned.

**Files:**
- Modify: `client/src/styles.css` — two new blocks, placed after the `2xl` block

**Interfaces:**
- Consumes: Task 3's `.bcol` intrinsic grid, Task 4's `.sessions` two-column shape.
- Produces: nothing.

**Target:**

| | `3xl` 1537 | `4xl` 1921 |
|---|---|---|
| `.tiles` columns | 4 | 5 |
| `.s-aside` width | 380px | 380px |
| `.board` | no new rule | no new rule |
| `.statstrip` | no new rule | no new rule |
| Modals | no new rule | no new rule |

- **Board deliberately gets nothing.** Its three buckets widen with the grid, and
  `auto-fill` gives 2 cards per line inside a bucket once a bucket passes 570px — which
  happens at `4xl` on its own. If you find yourself adding a Board rule here, the
  `.bcol` grid from Task 3 is wrong.
- `.sessions` becomes `1fr + 380px` at `3xl`; the aside does not grow again at `4xl`.
- Expected at 1920 full: wrap 1632, list 1236, buckets 401. Sessions tiles sit INSIDE the
  1236px list column, not the full wrap, so 4 cols = (1236-48)/4 = 297.
- Expected at 2560 full: wrap 2272, list 1876, buckets 614. Sessions tiles: 5 cols =
  (1876-64)/5 = 362.
- CORRECTION (controller, post-Task-9): this plan originally said tiles 396 and 442. Those
  are the ANALYTICS Tiles widths — that view has no aside beside it, so its tiles span the
  full wrap. The Sessions Tiles view sits beside the 380px aside. The tier behaviour
  (4 cols at 3xl, 5 at 4xl) was correct either way; only the documented widths were wrong.

- [ ] **Step 1: Add the `3xl` block, scoped to `[data-width="full"]`**

- [ ] **Step 2: Add the `4xl` block, scoped to `[data-width="full"]`**

- [ ] **Step 3: Verify capped mode is untouched**

At 1920 and 2560 with content width **capped**: measure is exactly 1248, board is
hard-left, tiles are 3-across, aside is 320px. Nothing from these two blocks applies.

- [ ] **Step 4: Verify full mode at both tiers**

At 1920 and 2560 with content width **full**, check every expected number above via
`getBoundingClientRect().width`.

- [ ] **Step 5: Verify the tier boundary**

At 1536 full vs 1537 full, tiles go 3 → 4 and the aside goes 320 → 380. If a fractional
viewport width lands between the two with neither applying, author `3xl` as
`min-width:1536.02px` — the spec records 1537px as the intent and this as the fallback.
If you take the fallback, update the Task 1 token block and its `tier values are exact`
case in the same commit, or that test will fail.

- [ ] **Step 6: Commit**

```bash
git add client/src/styles.css
git commit -m "feat(css): add the 3xl and 4xl tiers for full-width displays"
```

---

### Task 10: Close the guard test and sweep stray literals

**Files:**
- Modify: `test/breakpoints.test.ts`
- Modify: `client/src/styles.css` (only if the sweep finds something)

**Interfaces:**
- Consumes: Task 1's token block format and every preceding task's queries.
- Produces: nothing.

Now that no desktop-first width query remains, the assertions Task 1 could not make
become satisfiable.

- [ ] **Step 1: Write the failing test**

Add five cases to `test/breakpoints.test.ts`. Parse `styles.css` and collect every
`@media` query. Ignore `prefers-reduced-motion` and `pointer:coarse` — they are not
width queries and stay as they are.

| Case | Asserts |
|---|---|
| `every width query is min-width` | No `@media` query in the file contains `max-width` |
| `every width query uses a ladder value` | Each `min-width` value is one of 640, 768, 1024, 1280, 1536, 1537, 1921 — or 1536.02 in place of 1537 if Task 9 Step 5 took the subpixel fallback |
| `no orphan tier` | Every tier named in the token block appears in at least one query, and no query uses a value absent from the block |
| `the retired widths are gone` | None of 700, 900, 1100, 1201, 1330 or 1568 appears anywhere outside comments |
| `the measure dropped` | `.wrap.wide, .wrap.broad` resolve to `max-width:1248px`, and no `1280px` max-width remains on `.wrap` (1280 survives only as the `xl` query value) |

For the last case, strip comment lines before searching — the token block and the
derivation comment legitimately mention old numbers when explaining the change. Follow
`tailnet.test.ts`, which strips `//`, `*` and `/*` lines for exactly this reason.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL if any query or literal was missed. **If it passes on the first run,
that is the desired outcome** — Tasks 2–9 were complete. Record that it passed without
a fix rather than inventing one.

- [ ] **Step 3: Fix whatever the sweep found**

- [ ] **Step 4: Run the full suite**

Run: `pnpm test` then `pnpm typecheck`
Expected: both green. Paste the actual output — `.claude/CLAUDE.md` forbids claiming
green without it.

- [ ] **Step 5: Commit**

```bash
git add test/breakpoints.test.ts client/src/styles.css
git commit -m "test(css): assert the ladder is the only source of width queries"
```

---

### Task 11: Documentation

**Files:**
- Modify: `.claude/DESIGN.md` lines 244, 291, 300
- Create: `docs/subsystems/breakpoints.md`
- Modify: `docs/overview.md` §Map

- [ ] **Step 1: Fix the hardcoded widths in DESIGN.md**

Line 244 says a column drops "under 1100 px, before the 700 px phone breakpoint". Line
291 says the strip "wraps to 3 columns under 1100px and 2 under 700px" — **verify this
against the shipped CSS before rewriting it**, because the statstrip's 3-column rule was
at 1568, not 1100, so this line may already have been wrong. Line 300 says tables scroll
"under 700px". Replace the literals with tier names.

- [ ] **Step 2: Write `docs/subsystems/breakpoints.md`**

Cover: the seven tiers and their values; the lock's 240 + 48 + 1248 = 1536 derivation;
the 640/768 shell-vs-density principle; the capped/full matrix; why the numbers are a
comment and not custom properties; and the three pre-existing caveats (compact density's
20px-early crossover, `zoom`/`--font-scale` landing tiers late, and the `2xl`/`3xl`
subpixel adjacency). Link to the spec.

- [ ] **Step 3: Add the one-line entry to `docs/overview.md` §Map**

- [ ] **Step 4: Run the docs link test**

Run: `pnpm test`
Expected: PASS — `docs-links.test.ts` resolves every relative markdown link, so a wrong
path in the new doc fails here.

- [ ] **Step 5: Commit**

```bash
git add .claude/DESIGN.md docs/subsystems/breakpoints.md docs/overview.md
git commit -m "docs: record the breakpoint ladder"
```

---

## Not verified by this plan

State these in the PR body, per `.claude/CLAUDE.md`'s rule that every merged PR carries
an explicit unproven line:

- **No automated test covers layout.** Tasks 1 and 10 assert the ladder's *values* and
  that no stray width query survives. Nothing asserts that any element is the right size
  at any width — that is the eight-width manual walk, and it is only as good as the
  person doing it.
- **The 640–767 band has never been rendered before.** The phone shell used to reach 700;
  it now ends at 640, so this band gets the desktop shell with its 240px rail for the
  first time. The `md` density boundary is the mitigation, not a proof.
- **"Mobile is unchanged" is verified by comparison, not guaranteed by the diff.** The
  inversion rewrites every phone rule. Task 2 Steps 1 and 3 are the whole defence.
- **Five themes × two densities × seven tiers is not fully walked.** The manual passes
  above cover the default theme at comfortable density unless a step says otherwise.

---

## Plan amendments (pre-flight scan, 2026-09-15)

The pre-flight scan found the task element-tables under-enumerate the phone blocks. These
amendments are binding and are carried into the affected briefs.

**Task 3 owns the `.board,.tiles` selector list** in block 793 and must split it, leaving a
`.tiles` rule behind for Task 4. Task 4 should expect the split to have happened already.

**Task 4 additionally owns**, from block 793: `.s-card` padding, `.toolbar`,
`.toolbar .seg.view>button`, `.toolbar .sortlab`, `.toolbar .seg .vsep`, `.ctlwrap`, `.pop`,
`.need`, `.acts`. All are control-fitting rules — they go to `md`. The toolbar rules are
load-bearing: the phone switcher shows three words rather than five glyphs, and dropping
`.sortlab` is what buys the filter/sort track a place beside the switcher instead of a
second row. Preserve that reasoning.

**Task 5 additionally owns**, from block 852: `.mgmt-title`, `.mgmt-title .set-scope`,
`.mgmt-bandrow`.

**Task 6 additionally owns**, from the 1119 region: `.analytics .metric`,
`.analytics .tile .tile-sub`, `.analytics .tiles`, `.an-tile-lesson`,
`.analytics .tile .an-metrics`, `.analytics .tile .an-metric`,
`.analytics .tile .an-metric-v`, `.analytics .tile .an-metric.lead .an-metric-v`.

**Task 7 ships as two commits, dispatched separately:**
- **7a — statstrip and `.sheet`.** The specificity inversion described above. Highest risk in
  the plan; gets a full review seat.
- **7b — the rest of Usage's phone block:** `.hmx.wide`, `.hmx.tall`, `.row-head`,
  `.walkwrap`, `.qrow>*:not(.nm):not(.sdot):not(.cbtn):not(.spill)`, `.qrow .nm`,
  `.qrow .cbtn`, `.walkdays .now`, `.uplegend` and its six descendants, `.sheet .dt`,
  and the entire `.dt.stack` table-stacking system (thead, tbody, tr, td, `td::before`,
  `td:not([data-l])::before`, `td.name`, `td:empty`, `td.barcell`, `tr.tot`, `tr.tot td`).
  `.dt.stack` is how every table on the phone becomes a stack of labelled rows — it is
  `DESIGN.md`'s "every table scrolls inside its own sheet" rule. Pure cascade inversion, no
  tier decisions: all of it sits below `md`.

**Task 8 ships as two commits, dispatched separately:**
- **8a — Settings and the modal boundary.** `.set-cols`, `.set-group`, `.set-row`,
  `.set-control` and its three input variants, `.set-seg`, `.set-themes`, plus `.chat-back`
  and `.chat` — the full-screen-below-`md` boundary and the 1080/620 hold.
- **8b — the remaining chat and spawn phone rules:** `.chat-head`, `.chat-title`, `.chat-x`,
  `.chat-split`, `.chat-side` and its six `.kv` descendants, `.chat-facts`, `.chat-facts .f`,
  `.chat-facts .f.wide`, `.chat-body`, `.qpanel,.qpanel.min,.pbanner`, `.chat-foot`,
  `.chat-foot .seg`, `.chat-foot .seg>button`, `.qp-send,.qp-term`, `.qp-mic`, `.spawn-back`,
  `.spawn`, `.spawn-head`, `.spawn-body`, `.spawn-foot`, `.sp-row`, `.sp-select select`,
  `.sp-toggle`, `.sp-toggle .set-seg button`. Pure cascade inversion; all below `md`.

**`@media (prefers-reduced-motion:reduce)` (x2) and `@media (pointer:coarse)` are not width
queries and are not touched by any task.** Task 10's assertions must ignore them.
