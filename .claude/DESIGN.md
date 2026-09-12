# Design analysis

## 1. Typography

### Typeface
A single geometric-grotesque sans is used for everything — UI, labels and numerals. Characteristics visible in the screenshots: tall x-height, closed apertures, straight-cut terminals, circular `o`/`e`, single-story `a`, flat-sided `$`, tabular-feeling lining numerals, slightly condensed caps in the wordmark.

A geometric grotesque in the vein of the Aeonik / Neue Montreal class. Suggested substitutes, in preference order:

```
font-family: "General Sans", "Hanken Grotesk", "Plus Jakarta Sans", Helvetica, sans-serif;
```

No secondary/display face, no serif, no monospace. Numerals are set in the same face as text (not a separate mono) — set `font-variant-numeric: tabular-nums` on all figures and table columns.

### Weights in use
| Weight | Where |
|---|---|
| 400 Regular | body copy, secondary labels, table cells, axis labels |
| 500 Medium | nav items, buttons, card titles, legend labels, tab/chip labels |
| 600–700 Semibold/Bold | big money figures, wordmark, percentages in lists |

Only three weights; nothing lighter than 400, nothing heavier than 700.

### Type scale
| Role | Size | Weight | Line height | Tracking |
|---|---|---|---|---|
| Hero metric (`$12,450`) | 44 px | 700 | 1.05 | −0.02em |
| Large metric (`$15,000`, `$8,450`, `$15,780`) | 30 px | 700 | 1.1 | −0.02em |
| Gauge value (`75%`) | 28 px | 700 | 1.1 | −0.02em |
| Card title (`Monthly spending limit`, `Cost analysis`, `My card`) | 19–20 px | 500 | 1.3 | −0.01em |
| Wordmark | 20 px | 700 | 1 | +0.01em |
| Nav item | 16 px | 500 | 1.4 | 0 |
| Promo heading (`Upgrade to Pro!`) | 20 px | 700 | 1.25 | −0.01em |
| Body / list row (`Housing`, transaction name) | 14–15 px | 400 | 1.45 | 0 |
| Card subtitle (`Balance overview`, `Spending overview`) | 13 px | 400 | 1.4 | 0 |
| Legend, chip label (`7d`, `January`), button label | 13 px | 500 | 1.3 | 0 |
| Meta / axis / tooltip body / date under transaction | 12 px | 400 | 1.35 | 0 |
| Status micro-label (`Completed`, `Declined`), sub-caption (`Left to save 4 months`) | 11 px | 400 | 1.3 | 0 |
| Badge count (`19`) | 11 px | 500 | 1 | 0 |

Pattern: every card uses a **title + one-line subtitle** pair (19/500 over 13/400 grey), then the metric, then the visual. Deltas (`5.1% from last month`) mix two colors in one 12 px line: the number colored, the trailing words grey.

---

## 2. Color

### Neutrals / backgrounds
| Token | Value | Use |
|---|---|---|
| `--bg-page` | `#D9D9D9` | outer canvas behind the app shell (screenshot backdrop) |
| `--bg-app` | `#F4F4F3` | main content area behind the cards (very slightly warm grey) |
| `--bg-surface` | `#FFFFFF` | cards, sidebar, header controls, tooltip |
| `--bg-subtle` | `#F2F2F1` | sidebar active row, icon-button fill, chart track / empty bar |
| `--bg-track` | `#EDEDEC` | progress-bar and gauge remainders, placeholder bars |
| `--border` | `#EAEAE8` | card borders (1 px), divider rules, input outline |
| `--border-strong` | `#DCDCDA` | button outlines (`7d`, `January`, quick-action tiles) |
| `--ink-inverse` | `#111111` | Upgrade-now button fill, avatar/logo dot |

### Text
| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#131313` | headings, metrics, nav items, list labels |
| `--text-secondary` | `#6E6E6E` | subtitles, axis labels, "from last month", table headers |
| `--text-tertiary` | `#A0A0A0` | placeholder ("Quick search"), limit ceiling `$10,000`, `Other` |
| `--text-on-dark` | `#FFFFFF` | Upgrade button, card-face text |

### Accent / data colors
The palette is a three-step warm-to-green ramp; green = positive, orange = spend, yellow = savings.

| Token | Value | Meaning |
|---|---|---|
| `--green-600` | `#5FA92C` | positive delta text, darkest ramp step |
| `--green-500` | `#7DC242` | primary accent green — debit card, filled progress, income bars |
| `--green-400` | `#9BD25C` | gauge mid, ramp step |
| `--green-200` | `#CDE8A8` | light ramp / decorative tiles |
| `--yellow-400` | `#F2E635` | Savings series, Food category |
| `--orange-400` | `#F5A15C` | Expenses series, Housing / Debt / Car / Travel bars |
| `--orange-300` | `#F9C79A` | decorative tiles, negative delta arrow |

Filled bars, the debit card and the gauge all carry a **fine 45° diagonal hatch** (≈2 px stripe, ~8% white over the fill) — the signature texture of the design. Empty/placeholder bars are flat `--bg-track` with no hatch.

Third-party logos in the transaction list keep their own colors on small rounded tiles; everything else stays inside the palette above.

---

## 3. Spacing

Base unit **4 px**; the layout runs on an 8 px rhythm.

| Token | Value | Use |
|---|---|---|
| `space-1` | 4 px | icon-to-label in dense rows, legend dot gap |
| `space-2` | 8 px | label-to-value, list row gap, chip padding-y |
| `space-3` | 12 px | title-to-subtitle block, inner row padding |
| `space-4` | 16 px | gap between cards in a row/column, nav item padding-x |
| `space-5` | 20 px | card inner padding (small cards) |
| `space-6` | 24 px | card inner padding (standard), app-area padding |
| `space-8` | 32 px | sidebar padding, header-to-first-card |

Measured specifics
- App shell inset from canvas: **≈40 px** all round; shell corner radius 24 px.
- Sidebar width **≈300 px**; content gutter left of cards **24 px**.
- Card grid gutter: **16 px** horizontal and vertical, consistently.
- Card padding: **24 px** on the large ones (balance chart, card widget, transaction history), **20 px** on the short tip/limit cards.
- Header row height **≈56 px**; search field height 48 px; icon buttons 48 × 48 px.
- Nav row height **≈44 px**, 8 px between rows, icon-label gap 12 px. Sub-nav (`History`, `Integration`, `Reports`) indented 36 px with a 1 px L-shaped tree rule.
- Section divider above `Learning center`: 1 px rule with 24 px space above and below.
- Title → subtitle: 4 px. Subtitle → metric: 12–16 px. Metric → chart: 20–24 px.
- List rows (categories, transactions): 26–28 px tall, ~10 px between.
- Quick-action tiles: 48 × 48 px, 12 px gap, label 8 px below.
- Quick-payment avatars: 44 × 44 px, 8 px gap.
- Progress bars: 10 px tall; segmented cost bar 10 px tall with 4 px gaps between segments.

---

## 4. Radii

| Token | Value | Applied to |
|---|---|---|
| `radius-xs` | 4 px | bar-chart column caps, cost-analysis segments, legend swatches |
| `radius-sm` | 8 px | progress bars (pill-ish at 10 px height), small logo tiles |
| `radius-md` | 12 px | chips (`7d`, `January`), quick-action tiles, avatars, tooltip, badges on avatars |
| `radius-lg` | 16 px | cards, sidebar promo card, debit/credit card faces, search field, header icon buttons, Upgrade button, nav active row |
| `radius-xl` | 24 px | outer app shell |
| `radius-full` | 999 px | notification badge `19`, legend dots, avatar in header |

Nothing is fully square; the smallest radius anywhere is 4 px. Rounding scales with element size — a consistent ratio of roughly 1:8 (radius : shortest side) at the card level.

---

## 5. Elevation & strokes

- Cards sit on `--bg-app` with a **1 px `--border` stroke and no shadow** (or an imperceptible `0 1px 2px rgba(0,0,0,.03)`).
- Only two things float: the chart **tooltip** (`0 8px 24px rgba(0,0,0,.10)`, white, 12 px radius) and the **app shell** against the grey canvas (`0 24px 64px rgba(0,0,0,.10)`).
- Chart gridlines: 1 px `#EFEFEE`, horizontal only, no vertical lines, no axis line.
- Active nav is marked by a 3 px black bar flush to the left edge of the row plus the `--bg-subtle` fill — not by a color change in the text.
- Drop targets for widgets use a 1 px dashed `--border-strong` outline with 16 px radius.

---

## 6. Iconography

Outline icons, ~1.5 px stroke, 20 px box in nav and 20–22 px in tiles, rounded joins, `--text-primary` color. Chevrons and the `>` in `Read more` are 12–14 px. Icons never take accent color.

---

## 7. Reusable patterns

- **Metric card**: title (19/500) → subtitle (13/400 grey) → figure (30/700) → delta line (12 px, colored number + grey words) → visual.
- **Filter chip**: 13/500 label + chevron, 12 px radius, 1 px `--border-strong`, white fill, sits top-right of the card it filters.
- **Progress row**: name + `current / target` (target in grey), 10 px hatched bar over `--bg-track`, 11 px grey caption under.
- **Two-tone amount**: spent value in `--text-primary`, ceiling in `--text-tertiary`, same size — used for limits and goals alike.
- **Ramp encoding**: category order follows the orange → yellow → green ramp, so the segmented bar and the legend read as one object.

---

## 8. Applying this to the dashboard

The rail in the Claude Agents Dashboard takes §1's and §3's figures **at face value**
— the same numbers the mock draws (`docs/guides/mockups/redesign-mock.html`, `.side`
/ `.nav-item` / `.subnav`). Two deliberate departures, recorded here so the next
reader does not "correct" them back:

| | Spec / mock | Dashboard | Why |
|---|---|---|---|
| Sidebar width | 300 px | **280 px** | the only figure the content column notices, and this board is read in windows far narrower than the mock's 1500 px canvas |
| Nav row height | 44 px | **40 px** on the rail, 44 px on the phone strip | 44 px is the touch floor, which the strip is bound by and a pointer is not |
| Sub-nav indent | 36 px (the icon's right edge) | **26 px** (the icon's centreline: 16 px row padding + half a 20 px icon) | the rule then drops out of the glyph above it instead of floating in the gutter, and each sub-label starts at 48 px — exactly where the section labels start |

Everything else is the spec's: 32 px sidebar padding, rows at 16/500, 20 px
icons 12 px from the label, 16 px row padding-x and radius, a 3 px active bar
22 px tall, a 20/700 wordmark over an 11 px kicker, 14 px sub-nav labels, and a
divider with 24 px either side.

Hover is the one state that is not the mock's: it darkens the label and leaves the
background alone. The `--bg-subtle` fill is what marks the **active** row, and a
pointer that paints a second filled row turns one mark into a question.

The two rules that are ratios rather than sizes hold unchanged at any scale: the
active row is marked by an ink bar **plus** a `--bg-subtle` fill and never by a colour
change in the label (§5), and icons hold `--text-primary` at every row weight (§6).

Below 700 px the rail becomes a menu behind a top bar — wordmark left, ☰ right — and
drops out of it full width. It is the same `.rail` element, repositioned, so the trees
come with it: every section's tree stands open there, which puts any sub-view one tap
away. That is why the sub-view switches the page bands used to carry on a phone (Usage's
pill, Settings' Local/Shared, Management's scope select) are gone — the nav is the one
control at every width. The bar slides out of the way on a downward scroll and returns
on the first upward one; while the menu is open it is pinned, because the menu hangs
off it.

### 8.1 The board's type, after the §1 scale landed

The rest of the board (sessions, usage, analytics, management, settings, the chat
drawer) now reads off §1's scale rather than the old strip-board sizes. The old
board had three habits this pass removed outright:

- **A second face.** `--mono` and `--display` are deleted, not aliased — §1 allows
  exactly one. `code,kbd,samp,pre{font-family:inherit}` kills the UA's monospace
  default as well, so a code span is marked by its fill and ink alone. Figures line
  up on the `tabular-nums` already set on `<body>`.
- **Uppercase micro-labels.** `text-transform:uppercase` plus wide tracking is gone
  from every rule but `.rail-kicker` (the wordmark's kicker, which the mock does
  draw in caps). Two shouty strings in the markup came with it: `LEARNED HOURS` and
  `TOKEN VALUE PER MODEL`.
- **9–11 px body text.** 11 px is the floor now, per §1's smallest row.

| Role | Size / weight | Where |
|---|---|---|
| Page + card title | 19/500, −.01em, 1.3 | `.an-title`, `.mgmt-title`, `.up-head h3`, `.rates-q` |
| Large metric | 30/700, −.02em, 1.1 | `.rates-value` |
| Metric | 24/700, −.02em, 1.1 | `.an-metric-v`, `.rates-big` |
| Row name | 15/500 | `.proj`, `.session-name`, `.mitem-name`, `.an-proj`, `.set-name`, `.chat-title` |
| Subtitle / hint | 13/400 | `.an-hint`, `.up-sub`, `.set-hint` |
| Body, chip + button label | 13 (500 on buttons) | `.cmsg-text`, `.tb-new`, `.qp-send`, `.set-seg button` |
| Meta / axis / caption | 12/400 | `.an-when`, `.tl-axis`, `.mitem-desc` |
| Pill, badge, status | 11/500 | `.proj-pill`, `.branch`, `.ag-pill`, `.an-status`, `.r2 .status` |
| Percentage | 14/600 | `.pct`, `.usage .u-pct` |

Colors did not move: `--ink` / `--ink2` / `--ink3` already resolve to the design's
`#131313` / `#6E6E6E` / `#A0A0A0` in Daylight, and every rule was already naming a
token rather than a literal.

### 8.2 Settings — the first reference-design cards on the board

Settings is the first section drawn in §5's card language rather than the strip
chrome: white `--strip` cards, 16 px radius, **no stroke and no shadow** — contrast against the ground does the separating — 24 px
padding, each carrying §7's title + one-line subtitle pair. Rows inside are boxless —
16 px of vertical padding and a hairline rule between, never a bordered strip — and
every control is one 36 px family (select / number / text / button: 12 px radius,
`--hairline2` stroke). The segmented picker became the pill switch the mock draws
for Usage: a recessed `--steel` track and a raised `--strip` option, so the same
`.set-seg` serves the on/off rows and the phone's sub-view switch.

Two things a later section should copy rather than re-derive:

- **The page header is a band, not a card** — title 19/500, a scope pill, a 13 px
  line — sitting on the `--board` ground. The pill's fill is `--strip`, not
  `--strip-hi`: on the ground those two are two points apart and the pill vanished
  (the mock's first cut). The Shared pill is a `color-mix` tint of `--green` at 22 %.
- **Two hand-balanced columns, not a masonry.** Cards are placed by column so the
  tall one (Push notifications, Display) anchors one side; the grid folds to one
  column under 1100 px, before the 700 px phone breakpoint.

Mock: `docs/guides/mockups/redesign-mock.html` `#set-local` / `#set-shared`.

### 8.3 Sessions — the board, five ways

The Sessions page is two columns on the broad wrap: the list, and a 320px aside carrying
the Account gauges and the Board facts as two §8.2 cards. The list has **five shapes** —
board, list, split, tiles, triage — picked by a labelled segmented switcher; the same
filtered, sorted array feeds all five, so switching changes nothing but the drawing.

Three rules from drawing it, recorded so the next section can copy rather than re-derive:

- **Nothing on the ground uses `--strip-hi` as its only separator.** The segmented track
  sits on `--board`, and `--strip-hi` is two points off it on Daylight — the track vanished
  and the raised option read as a flush button (the scope-pill lesson from §8.2, met
  twice). On the ground the track is `--hairline2`; inside a popover, on paper, the
  recessed `--steel` is right.
- **A raised control means a state, not a button.** The filter button is paper-on-track
  only while a filter is set, and then carries a count badge; idle it sits flat in the
  track beside the sort label. Both open the design's one floating surface (§5): white,
  12px radius, the `0 8px 24px` lift.
- **State rides on the element, not the row.** A working dot, a waiting pill, an amber
  chat button carry their own class (`.sdot.working`, `.spill.question`, `.cbtn.answer`)
  because the same session sits in a card, a table cell, a list row and a tile.

Motion is the live board's: a working dot breathes a ring, a launching dot the same in
ink, a needs-you button and a running timeline bar fade in place — all off under
`prefers-reduced-motion`.

Mock: `docs/guides/mockups/redesign-mock.html` `#sessions`. Plan:
`docs/superpowers/plans/2026-09-11-sessions-redesign.md`.

### 8.4 Usage — the analyst's read, on §8.2's sheets

Both Usage tabs are drawn in the Settings pass's card language rather than the old strip
chrome: a **band** on the `--board` ground (§8.2's "the page header is a band, not a card"),
then borderless `--strip` sheets at 16px radius with 24px of padding, each carrying §7's
title + one-line subtitle pair. The reading order is the same on both — figures, then the
thing they summarise, then the evidence under it, then the definitions.

Three shapes this section adds, which a later one should copy rather than re-derive:

- **The figure strip is one card the ground divides, not five cards with gaps.** Five
  figures that answer one question ("where does this stand, and should I believe the rest of
  the page") read as five unrelated facts the moment they get five surfaces. The divider is
  2px of `--board`, for the same reason the sheets are borderless: contrast against the
  ground does the separating. It wraps to 3 columns under 1100px and 2 under 700px, and the
  seam then has to be drawn in *both* directions — a wrapped grid whose only rule is
  `border-left` grows a full-width gap where the rows meet.
- **A filter chip's slot is a slot, not a filter.** The mock draws a chip at the right of
  each sheet's heading row; here it holds whatever that sheet's one control is — a static
  count on the walk, a grid ↔ numbers toggle on the week. A `button.chip` takes
  `aria-pressed` and a raised `--strip-hi` fill; a label chip stays flat and
  `cursor: default`. The chip's own border is `--hairline2`, never `--strip-hi`: on the
  ground those two are two points apart (the §8.2 scope-pill lesson, met a third time).
- **Every table scrolls inside its own sheet.** Under 700px `.dt` becomes an `overflow-x`
  box rather than letting the page body scroll sideways. That is what makes a wide ledger
  admissible on a board that is mostly read from a phone — the objection that rejected a
  one-table layout in 2026-09 is answered by the box, not overruled.

Two colour rules are meaning, not palette. On the forecast page the **ramp is the weight's
scale**, so a reading aid never borrows a data colour — the ⓘ is `--ink2` on `--hairline2`
and goes to ink when pinned, never to the accent (§5: the accent does not mark state). And
the walk's four inks are a 2×2, not four choices: **green above the rule, red below it**
says which side of empty you are on, **solid vs dashed** says whether the hour was measured
— the same hatch an unevidenced heatmap cell wears. A guessed overrun is amber because this
board has no fifth data colour to give it, and amber is what it already calls a guess.

Mock: `docs/guides/mockups/redesign-mock.html` `#forecast` / `#rates`.
Reference: `docs/subsystems/usage-limits.md`.

### 8.5 Management — the scope is a destination, the rest is columns

**The scope is a rail destination, not a pane.** Global (`~/.claude`) and each
recently-active project sit in the sidebar as Management's sub-nav — the same tree Usage
and Settings draw — instead of taking a column inside the page. The live view's three
panes made the config's first level compete for width with the items under it, and the
first level is the one that changes least: you pick a scope once and then work inside it.
The page names it in the band as `Management · <scope>` (the `section · destination`
convention the Usage pages set) with the `.scope` pill after it, because the rail carries
the label but only the band can spell out the path. The pill stays neutral: the green
`.scope` fill means "every device" on Settings and would lie here.

What is left is three levels, so the page is **three columns** — type, item, file. Five
shapes were compared (two panes, type tabs, a catalogue of type cards, a ledger table,
these columns) and the columns won: once the rail owns the scope, the remaining tree *is*
three levels, and saying so out loud beats nesting two of them inside one scrolling list.

- **Column 1, type.** One row per kind with its count as a pill.
- **Column 2, item — a Settings card (§8.2).** The type is the category title, the
  subtitle counts what the filter left of it, and each item is one `.srw`-shaped row:
  name over its hint, its source badge on the right, a hairline between. Same furniture as
  a preferences card, so "a skill" and "a setting" read as the same kind of thing —
  something named, described and sourced. The source sub-groups survive as collapsible
  kickers between rows; flattening them away would lose the one split that tells a user's
  skill from a plugin's.
- **Column 3, file — drawn only when something is selected.** An empty inspector holding
  a "select an item" line is a third of the page spent saying nothing, and the two columns
  left are legible alone. (The `select an item to inspect it` empty state goes with it.)
- **Columns 1 and 2 are fixed widths.** A second column that is wide until you pick
  something and narrow after is a column that jumps out from under the row you just
  clicked; the third has to arrive *beside* the other two.
- **One "you are here" mark, used twice.** The picked row in both list columns takes a
  `--bg-subtle` fill bled to the card's edge with a full-height ink bar against it. Drawn
  as a pseudo-element, never an inset shadow — a row with a 12px radius clips an inset
  shadow into a crescent.

Mock: `docs/guides/mockups/redesign-mock.html` `#mgmt`.
Reference: `docs/subsystems/management.md`.

### 8.6 The chat modal — the sidecar, and how a wait panel arrives

The drawer stops being a full-height panel pinned to the right edge and becomes a
**modal with air around it**: the scrim is now a real exit everywhere rather than
desktop-only, and ✕, Escape and the browser's back are unchanged. Five shapes were drawn
— a centred sheet, this sidecar, a narrow reading column, a duo with the panel in its
own column, a window with inset paper — and the **sidecar won**: the session's facts
(context gauge, project, branch, model, surface, message count, current tool) move into a
290 px left column, which leaves the transcript a clean top edge and one job.

The **All / Text / You** filter does not go with them. A column about the session is the
wrong place to answer a question about the messages, so the filter sits in the **foot**,
right of the `n of m shown` count it changes: the control and its consequence on one line,
and no chrome row spent on either. Five placements were compared — head, a rail over the
transcript, this foot, a popover button, a floating pill — and the foot is the only one
that costs the transcript nothing. It stays the `.seg` switch, at foot scale (11 px labels,
4/10 padding); below 700 px the foot wraps and the switch takes the second row full width.

Two rules the losers are not around to argue with:

- **The question panel is the terminal's AskUserQuestion dialog.** Question as the
  heading, one full-width row per option — 15/500 label over a 13 px grey description,
  the keyboard number as an `--bg-surface` chip in the right margin — the picked row
  taking the ink ring and a white fill, `Other` carrying its field inside the same
  `--bg-subtle` block, and the two actions right-aligned under them with the send as the
  only ink button. Rows, not the chip wrap the drawer used: the reader already answers
  this shape at the keyboard, and a full-width row is the phone target for free.
- **A wait panel floats over the transcript, it does not push it.** The body keeps its
  full height and the panel lies on its bottom edge, so a question arriving mid-read
  never reflows the sentence being read. It is as tall as its own content — no fixed
  fraction — stops at the height of the modal, and scrolls inside itself from there. The
  panel's own 1 px `--border` hairline is the whole separation — **no shadow under it**:
  §5 floats exactly two things on this board, the chart tooltip and the app shell, and a
  panel inside the modal is neither. The transcript carries 40 px of bottom padding so
  its tail can clear the panel by scrolling.
- **What the panel is about is never behind a blind toggle.** The drawer put a proposed
  plan behind a `show plan` button shaped like an option row — a control that looked like
  an answer and, once the panel floats, hid the only copy of the plan the reader could
  reach. It is now a titled block: an 11 px `plan` kicker, the plan's **own first
  heading** as the title (never a second label to drift from it), and a `read all ▾` fold
  on the right, over a `--bg-subtle` box showing the opening lines clipped at 104 px
  under a gradient fade. The whole clipped box is the control. Expanded it takes **no
  `max-height` of its own** — the panel grows with it under the float rule, up to the top
  of the transcript area, and the panel (not the plan) is what scrolls from there.

- **A message box is white paper with a hairline, not a tint.** Inside the modal the
  transcript is already `--strip`, so §8.2's "contrast against the ground does the
  separating" has no ground to work with: a user turn and a tool-body block take the same
  white plus a 1 px `--hairline`. The `--strip-hi` tint they used to carry is two points
  off the paper on Daylight and read as nothing. Role labels are uppercase 11/600 with
  `.07em` tracking; message text is `--ink`, not `--ink2`; inline code is `--ink` on
  `--steel` at a 4 px corner — the accent is for links, not for every backtick.

Mock: `docs/guides/mockups/redesign-mock.html` `#chat`.
Reference: `docs/subsystems/chat.md`.

### 8.7 The launch modal — the sheet

The launch form leaves the wait-panel family. It was a `.qpanel` pinned into the Sessions
column, cyan where the others are amber; but that family is for **holds** — things a
session is waiting on you for — and a launch is the opposite, a compose surface you opened
on purpose. It floats now, on §8.6's shell: the scrim, air on every side, the shell's lift,
and full-screen below 700 px. At **620 px** rather than 1080: there is no second column to
seat, so the sheet is only as wide as one column of fields reads well.

Five shapes were drawn — a sidecar with the project list in its own column, a composer that
made the prompt the whole modal and every flag a chip, a Settings-row ledger with a hint
under every name, a launchpad of pickable tiles, and this sheet — and the **sheet won** on
one argument the others could not answer: it is the only one that needs no second layout
for a phone. Read top to bottom it is **project → prompt → name → model / effort /
permission → remote control**. The name owns a line because it is prose and the three flags
are not; the flags share the next one as three equal columns, so a long permission label
never squeezes the two beside it.

Three rules carried out of that comparison:

- **Cyan, and only here.** The badge is a tinted cyan pill and the launch button takes a
  cyan fill — the same cyan the `starting…` phantom row uses, so a launch reads as one
  thread from the button to the row it produces. Amber stays reserved for "a session is
  waiting on you"; nothing else in the modal is tinted.
- **The controls are §8.2's, not new ones.** The 36 px family (select · text · button, 12 px
  radius, `--hairline2` stroke, the chevron drawn by the wrapper rather than the UA), and
  for the boolean the reference design's pill switch Settings already draws. A modal is
  not a licence for a second on/off shape.
- **A host limit is printed, not hovered.** When `SPAWN_MAX_PERMISSION` cuts the ladder the
  triplet carries `host ceiling · <mode> or below` under it. The old panel put that in a
  `title`, which on a phone is nowhere.

Mock: `docs/guides/mockups/redesign-mock.html` `#spawn`.
Reference: `docs/subsystems/spawn.md`.
