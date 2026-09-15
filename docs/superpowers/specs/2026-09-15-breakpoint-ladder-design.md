# Breakpoint ladder — design

Replace the six ad-hoc widths in `client/src/styles.css` with a named seven-tier
ladder on Tailwind's numbers, rewritten mobile-first, with every tier defined for
both content-width settings.

## Problem

Today's widths are 700, 900, 1100, 1201, 1330 and 1568, spread across 13
`@media` blocks, all `max-width` (desktop-first) except one. Two of them are
derived from real arithmetic and two are not:

- **1568** = 240 rail + 2×24 `.main` padding + 1280 `.wrap` measure. The width at
  which the fixed shell stops fitting.
- **1330** = 190 + 420 + 400 detail + 32 gaps + 288 chrome. Management's third
  column.
- 1100, 900, 700, 1201 are one-off values with no shared system.

Nothing names the tiers, so a new rule has to pick a number by eye, and
`data-width="full"` is three lines (`max-width:none`) that stretch the same
column counts edge-to-edge on any monitor. On a 2560px display that is a
1248px-wide design with 1300px of slack, or an uncontrolled stretch.

## The ladder

Mobile-first. Base (unprefixed) styles are the phone; every tier layers upward
with `min-width`.

| Tier | min-width | Role |
|---|---|---|
| — | base | Phone shell: rail is a top bar, board full-bleed, all grids 1 col |
| `sm` | 640 | Desktop shell returns (rail, board radius, `.main` padding) |
| `md` | 768 | Density tier: column counts, table columns, card padding |
| `lg` | 1024 | Analytics metrics reach 5-across |
| `xl` | 1280 | Board/Tiles 3-col, Management 3-col, pinned panes |
| `2xl` | 1536 | **The lock.** Measure reaches 1248; Sessions aside moves beside |
| `3xl` | 1537 | Structural gains in full mode; capped holds at 1248 |
| `4xl` | 1921 | Structural gains in full mode; capped holds at 1248 |

Seven tiers, replacing six ad-hoc widths across 13 desktop-first blocks.

**CORRECTION (post-implementation):** an earlier draft of this line said "seven width
queries, down from 13 blocks". The tier COUNT is seven, but the resulting file holds
fourteen `min-width` blocks, not seven — tier blocks are section-local, placed after each
section's own base rules rather than pooled one-per-tier. That convention was adopted
mid-implementation after appending to a shared earlier block silently broke the ladder
twice: a section whose base rule sits later in the file wins over an earlier tier block at
every width. More blocks is the correct trade. Never state a block or query count as a
property of this design — it changes whenever a section is added, which is why the guard
test asserts on the set of tier VALUES and never on a count.

### The lock is re-derived

The measure drops **1280 → 1248** so the arithmetic lands on Tailwind's `2xl`
exactly:

    240 rail + 48 padding + 1248 measure = 1536

The rail stays 240 and `--body-pad` stays 24. The lock remains a derived
consequence of the shell, not a chosen number — that property is the reason
1568 was defensible and it is preserved.

**Subpixel note.** `2xl` at 1536 and `3xl` at 1537 are adjacent. Fractional
viewport widths (browser zoom, fractional DPI) can land between them. `3xl`
should be authored as `min-width:1536.02px` if a gap is observed in testing;
1537px is the documented intent.

**Zoom note, pre-existing.** `.shell{zoom:var(--font-scale)}` makes every query
resolve against the unzoomed viewport, so above 100% text scale each tier lands
slightly late. Unchanged by this work.

**Compact density, pre-existing.** `[data-density="compact"]` trims
`--body-pad` to 14px, so its true chrome is 268 not 288 and its crossovers sit
20px early. A media query cannot read a custom property. Unchanged by this work.

## The 640 / 768 principle

The single rule that resolves the ~12 small calls consistently:

> **640 is the shell boundary. 768 is the density boundary.**

Below 640 the rail becomes a top bar and the board goes full-bleed. But between
640 and 767 the desktop shell is back *with its 240px rail*, which eats a third
of the window. So rules that existed at 700 for **shape** reasons move to `sm`;
rules that existed at 700 for **density** reasons (column counts, hidden table
columns, padding) move to `md`.

Applying `sm` uniformly would put three statstrip cells in 352px (117px each) and
two tiles in 352px — narrower than any width these components render at today.

## Content-width settings

Both settings have defined behaviour at every tier. Neither is ever ignored.

| | Capped (default) | Full |
|---|---|---|
| base–`2xl` | measure ramps to 1248 | `max-width:none`, edge to edge |
| `3xl` / `4xl` | **frozen at 1248, left-aligned** | **structural tiers** |

Capped keeps `margin:0` — the board stays hard-left and the slack falls to the
right, exactly as today. Capped's answer above the lock is "hold"; that is a
defined behaviour, not an exemption.

Wrap width by tier — capped is `min(tier − 288, 1248)`, full is `tier − 288`:

| | `sm` | `md` | `lg` | `xl` | `2xl` | `3xl` @1920 | `4xl` @2560 |
|---|---|---|---|---|---|---|---|
| Capped | 352 | 480 | 736 | 992 | 1248 | 1248 | 1248 |
| Full | 352 | 480 | 736 | 992 | 1248 | 1632 | 2272 |

## Per-surface

### Sessions — Board

Board changes shape rather than column count. **Below `xl` the three buckets
stack**, each full width, with its cards wrapping inside it. At `xl` and above
the three buckets sit side by side.

This preserves the named-bucket read (Needs you / Working / Quiet) at every
width — a bucket is never squeezed to illegibility and never wraps onto a second
row, which would break the read entirely.

No DOM change. `.bcol` turns from flex into an intrinsic grid:

    .bcol { display:grid;
            grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
            gap:10px; align-content:start }
    .col-h, .bempty { grid-column:1/-1 }

The card floor is **280px**, close to the 260px the board flips at today. Cards
per line then follow from width with **no media query** — `.board` needs exactly
one query (stacked vs 3 buckets), down from two.

Cards per line when stacked, `floor((W + 10) / 290)`:

| | base | `sm` 352 | `md` 480 | `lg` 736 |
|---|---|---|---|---|
| cards/line | 1 | 1 | 1 | 2 |

Bucket width when side by side, `(view − 32) / 3`:

| | `xl` | `2xl` | `3xl` full | `4xl` full |
|---|---|---|---|---|
| bucket px | 320 | 293 | 401 | 614 |

**Emergent, and desirable:** the same `auto-fill` rule that stacks narrow also
gives 2 cards per line *inside* a bucket once a bucket passes 570px — so `4xl`
buckets fill rather than stretch, with no extra rule.

**Known discontinuity — decide at review.** At `xl` the view holds the full
992px (aside is above), giving 320px buckets. At `2xl` the aside returns and
takes 336px, leaving 912px and 293px buckets. Widening the window makes cards
27px narrower. It is cosmetic — 293 is above the 280 floor, so cards per line
never changes — but it is non-monotonic. Mitigation if unwanted: set the aside
to 280px at `2xl` (306px buckets), or hold the aside above the view until `3xl`.

### Sessions — everything else

A blank cell means the value to its left carries forward unchanged.

| Element | base | `sm` | `md` | `xl` | `2xl` | `3xl` | `4xl` |
|---|---|---|---|---|---|---|---|
| `.tiles` cols | 1 | 1 | 2 | 3 | 3 | 4 (full) | 5 (full) |
| `.split` | `1fr` | `1fr` | `280 + 1fr` | | `320 + 1fr` | | |
| `.sessions` | 1 col | | | | `1fr + 320` aside | | |
| `.s-aside` | 1-up | | 2-up | | beside, `order:1` | | |
| aside width | — | — | — | — | 320 | 380 (full) | 380 (full) |
| `.ledger` model col | hidden | hidden | shown | | | | |
| `.ledger .c-ctx` | 120 | 120 | 200 | | | | |

`.tile.selected{grid-column:span 2}` applies from `md` (cancelled at base and
`sm`, where the grid is single-column).

Tile widths: `md` 232, `xl` 320, `2xl` 293, `3xl` 396, `4xl` 442.

### Management

| | base | `md` | `xl` |
|---|---|---|---|
| `.mgmt` | 1 col | `190 + 1fr`, detail full-width row | `190 + 420 + 1fr` |

Detail pane is **350px** between `xl` and `2xl`, then 606px at the lock. That is
narrower than the 400px the layout flips at today; `.mdetail` content
(file paths, `.mitem-desc` at `max-width:76ch`) needs checking for wrapping in
that band.

Management keeps its exclusion from the pinned-pane shell (`.wide-mgmt`): its
columns size to content and the page body stays the single scroller.

### Analytics

| | base | `md` | `lg` | `xl` |
|---|---|---|---|---|
| `.an-metrics` | 3-across | 3-across | **5-across** (147px each) | |
| `.an-cols` | 1 col | 2 col | | |
| pinned panes | — | — | — | **on** |

5-across at `lg` is more generous than today's flip at 900 (122px each). The
900–1023 band drops from 5 figures to 3.

Pinned panes move from `min-width:1201` to `xl` (1280) — the 1201–1279 band
loses pane scrolling and scrolls the page instead. This removes the last
off-convention literal.

### Usage

| | base | `md` | `2xl` |
|---|---|---|---|
| `.statstrip` cols | 2 | 3 | 5 |
| `.sheet` padding | 20 | 22px 24px | |

Statstrip caps at 5 — it takes a variable tile list and its seams are pinned to
column counts, so it cannot become `auto-fill`. No `3xl`/`4xl` rule.

### Settings and modals

`.set-cols` 1 col at base, 2 col from `md`. `.set-group` padding 20 → 24 at `md`.
`.set-row` stacks at base.

**Modals leave the ladder entirely.** Chat holds at 1080px and Spawn at 620px at
every tier. A modal is a focused reading surface; 1080px is already at the top of
a comfortable measure for transcript text. Both keep `max-width:100%` and their
full-screen presentation below `md`.

## Risks

**1. Mobile-first inversion rewrites the phone block.** The requirement is that
mobile behaves exactly as it does now. Under a `max-width` renumber that would be
guaranteed by the diff. Under inversion the phone rules become the base
declarations and the desktop rules become overrides — every phone rule is
rewritten, so "unchanged" becomes a property to verify rather than one the diff
enforces. Every rule in the current `max-width:700px` blocks needs explicit
before/after confirmation.

**2. Statstrip's seams are documented specificity fights.** The comment at
`styles.css:1925` records `:nth-child` forms chosen specifically to beat the
wide-strip rules — `>div{border-left:0}` losing to `>div+div`, and
`>div{border-top:2px}` losing to `:nth-child(-n+3){border-top:0}`. Inverting the
cascade flips every one of those contests. This block needs its own pass and its
own visual check at all three column counts, not a mechanical inversion.

**3. The 640–767 band is newly exposed.** The phone shell now ends at 640 rather
than 700, so 640–767 gets the desktop shell with a 240px rail for the first time.
The `md` density boundary is the mitigation, but this band has never been
rendered before and needs a look on every surface.

## Out of scope

- `prefers-reduced-motion` and `pointer:coarse` queries — unchanged.
- The `zoom`/`--font-scale` interaction and compact-density crossover offset —
  both pre-existing, both documented above, neither fixed here.
- Container queries. Board's `auto-fill` gets the same result for the one case
  that needed it; converting components wholesale is separate work.
- PostCSS `@custom-media`. The seven numbers live in a documented constant block
  and a guard test, with no new dependency.

## Verification

- `pnpm typecheck` and `pnpm test` green, with output.
- New guard test, modelled on `test/tailnet.test.ts`: assert the seven
  breakpoint literals appear in `styles.css` only inside `@media` queries and the
  documented token block — no stray width literals elsewhere.
- Manual pass on every surface at each of the seven tiers × both content-width
  settings, plus the 640–767 band called out in Risk 3.
- Phone block before/after confirmation per Risk 1.
- Statstrip visually checked at 2, 3 and 5 columns per Risk 2.

## Docs to update

- `.claude/DESIGN.md` lines 244, 291, 300 hardcode 1100px and 700px.
- `client/src/styles.css:763` — the comment deriving 1568; rewrite for 1536.
- `docs/overview.md` §Map if a new subsystem doc is added for the ladder.
