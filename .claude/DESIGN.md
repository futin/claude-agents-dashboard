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

Below 700 px the rail lies down into a horizontal strip, which cannot draw a tree: the
sub-nav is hidden there and the Usage section bar shows a pill switch instead. Exactly
one of the two is visible at any width, and both write the same setting.

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
chrome: white `--strip` cards, 16 px radius, one `--hairline`, **no shadow**, 24 px
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
