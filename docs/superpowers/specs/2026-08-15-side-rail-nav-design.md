# Side-rail section nav — design

**Date:** 2026-08-15
**Scope:** app shell only — the four-button section switch moves from a row above the
content to a vertical rail on the left. No section renames, no routing, no behavior
changes inside any section.
**Reference:** `../finance-manager/client/src/App.tsx` (`Rail`). That app is Tailwind; the
pattern is ported here as plain CSS over the existing theme tokens.

## Concept

`SectionTabs` currently renders a `.tabs` row of four buttons directly above whatever
section is open, inside `.wrap`. It costs a full row of vertical space on every view, and
on a 4-item nav a horizontal row scales worse than a column — the rail has room for a
wordmark and for future items, the row does not.

finance-manager solved the same problem with a `Rail`: a sticky, full-height, 208px
column on desktop that degrades to a horizontal scrollable strip below the `md`
breakpoint. Brand block on top, active item marked by a tinted background plus a 2px
accent bar inset on its **left** edge.

This design ports that literally. What carries over from the reference: the shell shape,
the sticky full-height rail, the brand block, the left inset accent bar, the mobile
horizontal-strip fallback. What does not: Tailwind classes, `react-router` `NavLink`
(this app has no router — section state is `useState` + `usePersistedState`), and the
208px width (200px here, matching the `.mgmt` sidebar already in this stylesheet).

The ATC flight-strip visual language set in `2026-08-14-atc-strip-reskin-design.md` is
unchanged: same Barlow Condensed uppercase labels, same tokens, no new colors.

## 1. Shell structure

```html
<div class="shell">
  <nav class="rail" aria-label="Sections">
    <p class="rail-brand"><span class="rail-kicker">Claude</span><br />Dashboard</p>
    <button class="rail-link on" aria-current="page">Sessions</button>
    <button class="rail-link">Management</button>
    <button class="rail-link">Analytics</button>
    <button class="rail-link">Settings</button>
  </nav>
  <main class="main">
    <div class="wrap wide?">…the open section…</div>
  </main>
</div>
```

| Element | Role |
|---|---|
| `.shell` | `display:flex` — the only new top-level box |
| `.rail` | `flex:0 0 200px`, sticky, `border-right:1px solid var(--hairline)`, on `var(--strip)` |
| `.main` | `flex:1;min-width:0` — owns the page padding the `body` used to own |
| `.wrap` | unchanged: `max-width:820px`, `.wide` 1280px, `margin:0` (left-aligned) |

**Padding moves off `body`.** Today `body{padding:var(--body-pad)}`. A rail that reaches
the viewport edge cannot live inside that padding, so `body` drops to `padding:0` and
`--body-pad` is consumed by `.main` instead (and the rail applies its own). `--body-pad`
keeps its density-compact override, so compact mode still tightens the page.

**Flex, not grid or fixed.** Flex mirrors the reference and the mobile fallback is a
single property flip (`flex-direction:column`). CSS grid works identically but duplicates
the column track in the media query. A `position:fixed` rail with `margin-left` on the
content is rejected: `styles.css:92` sets `body{zoom:var(--font-scale,1)}`, and fixed
positioning under a zoomed ancestor is unreliable across engines.

### The `100vh` / zoom interaction

The rail wants full viewport height so its right border runs the length of the page. Under
`zoom:1.1` (text scale 110%), `100vh` resolves against the *unzoomed* viewport and the rail
overflows by the scale factor. Mitigation:

```css
.rail{position:sticky;top:0;z-index:5;align-self:flex-start;
      height:calc(100vh / var(--font-scale,1))}
```

`align-self:flex-start` is load-bearing: a stretched flex item fills its line and has
nowhere to stick. See §4 for why the `zoom` sits on `.shell` rather than `body`.

`--font-scale` is already set on `<html>` by `hooks/useSettings.tsx:60`. This must be
verified visually at 90 / 100 / 110%, not assumed.

### Inner breakpoints shift by the rail's width

`.main` is now 200px narrower than the viewport on desktop — the rail's `flex:0 0 200px`
comes out of the space content used to have to itself, not out of `.wrap`'s. Every existing
`min-width`/`max-width` breakpoint that governs content living inside `.main` was written
and tuned against the viewport, back when the tab row sat inside the page instead of beside
it, so each one now engages 200px later than the content width it was actually measured
against. The Management view's three-column grid (`styles.css:275`, `:320`) is the case that
surfaced it: its `1000px`/`1001px` pair assumed `.mgmt` could see the full viewport, so at a
1001px viewport post-rail the grid actually had only ~801px of content width to lay out in,
and its third track fell from ~425px to ~225px — nothing overflowed, but the detail pane
became too narrow to read comfortably. Both thresholds move to `1200px`/`1201px` so `.mgmt`
sees the same ~1001px of content width the original pair targeted. Any future breakpoint
added for `.main`-nested content must be expressed against the content width the rule
actually needs, then have the rail's 200px added to arrive at the viewport number to write
in the media query — not picked by testing against the full viewport directly.

## 2. Rail styling

Inherits `.tab`'s type treatment verbatim — `var(--display)` (Barlow Condensed), 11.5px,
600 weight, uppercase, `.08em` tracking — so the rail reads as the same board.

| State | Treatment |
|---|---|
| default | `color:var(--ink3)`, transparent background |
| `:hover` | `color:var(--ink2)`, `background:var(--strip-hi)` |
| `.on` | `color:var(--ink)`, `background:var(--strip-hi)`, `box-shadow:inset 2px 0 0 var(--cyan),inset 0 1px 0 var(--edge)` |

The one deliberate change from `.tab`: the selected marker rotates from a **bottom** inset
bar (`inset 0 -2px 0 var(--cyan)`) to a **left** one. A bottom bar marks position in a
horizontal row; in a vertical list it reads as a divider, not a selection. The left bar is
also what the reference uses.

`.rail-brand` sits above the links: the word "Claude" in `--ink3` caption type over
"Dashboard" in `--ink` display type, separated from the links by margin.

**Zero new colors or shadows.** Every value above is an existing token, so all five themes
(`midnight`, `graphite`, `amber`, `nightshift`, `daylight`) follow with no per-theme work —
the constraint stated at the top of `styles.css`.

**Accessibility gained:** `<nav aria-label="Sections">` and `aria-current="page"` on the
active button. The current `.tabs` div has neither.

## 3. Title relocation

`Header.tsx` drops its `<h1>Claude Sessions</h1>`. `.head` keeps the `.meta` timestamp
span; `.sub` (active count / top-N / claude procs) and the usage bars are untouched. The
wordmark it gave up now lives in `.rail-brand`, so the title appears once.

`.head` is `display:flex` with `.meta{margin-left:auto}`, so removing the `h1` leaves the
timestamp right-aligned on its own line — correct as-is, no CSS change needed.

## 4. Phone (≤700px)

The breakpoint is 700px, matching every other responsive rule in this stylesheet (the
reference's 768px `md` is not adopted — internal consistency wins).

```css
@media (max-width:700px){
  .shell{flex-direction:column}
  .rail{flex:none;width:auto;height:auto;align-self:stretch;
        flex-direction:row;overflow-x:auto;overflow-y:hidden;
        border-right:none;border-bottom:1px solid var(--hairline)}
  .rail-brand{display:none}
}
```

**Revised 2026-08-16.** The original spec dropped sticky on mobile (`position:static`, the
same call the reference makes with `md:sticky`). That was wrong for this app: the sessions
list is the long-scrolling screen and the phone is a first-class client, so the strip
scrolled permanently out of reach. The base `position:sticky;top:0` is now inherited into
the media query instead of overridden — laid down, the rail pins to the top edge rather
than the left one. It carries `z-index:5` so it paints over the rows it now overlaps, still
below `.tb-pop` (20) and the chat drawer (50).

The chat drawer is `position:fixed;inset:0` at `z-index:50` so it still covers the strip and
needs no change; `QuestionPanel` / `PlanPanel` / `PermissionBanner` pin inside that drawer
and are likewise unaffected.

`zoom` for the text-scale setting rides `.shell`, not `body` (`styles.css`, the density
block): `zoom` is a legacy property whose interaction with `position:sticky` descendants is
engine-dependent, so the rail is a direct child of the zoomed element rather than a
grandchild of the scroll root. Reach is unchanged — the whole app renders inside `.shell`.
The `calc(100vh / var(--font-scale,1))` correction is unaffected by the move, and the same
correction now applies to `.wrap.wide`'s app-shell height, which previously overflowed the
viewport at any text scale above 100%.

## 5. Files

| File | Change |
|---|---|
| `client/src/components/SectionTabs.tsx` | renamed `SideRail.tsx`; component `SectionTabs` → `SideRail`; adds brand block, `aria-label`, `aria-current`. `Section` type export and `TABS` order unchanged |
| `client/src/App.tsx` | `.shell` / `.main` markup; `.wrap` nests inside `.main`; import follows the rename |
| `client/src/lib/settings.ts:21` | `import type { Section }` path follows the rename — `Landing = Section \| 'last'` is otherwise untouched |
| `client/src/components/Header.tsx` | remove `<h1>` |
| `client/src/styles.css` | `body{padding:0}`; new `.shell/.rail/.rail-brand/.rail-link`; delete `.tabs/.tab/.tab:hover/.tab.on`; new mobile block |
| `docs/overview.md` | file-map line naming `SectionTabs` |
| `.claude/CLAUDE.md` | two architecture-map lines naming `SectionTabs` / "section tabs" |

No `shared/types.ts` change — this is client-only, nothing crosses the API boundary.
No new dependency.

## 6. Testing

`test/` covers backend domain logic and pure client libs; neither is touched, so there are
**no test changes** and `pnpm test` must still report 322 passing.

Verification is build plus visual proof:

1. `pnpm typecheck` — catches the rename's import fallout in `lib/settings.ts`.
2. `pnpm test` — 322 green, proving nothing backend moved.
3. `pnpm build` — the lazy chunks still split.
4. Dev server, screenshot at 1280×800 and 375×812, on **daylight** and **midnight**.
   Daylight is the tell: it is the only light theme, so a hardcoded color survives every
   dark theme and fails only there.
5. One pass at text scale 110% on desktop, confirming the `calc(100vh / var(--font-scale))`
   rail height neither overflows nor falls short.
6. Click each of the four sections; confirm the lazy sections still mount, `.wide` still
   applies on Management/Analytics, and the persisted `dashboard.section` key still
   restores on reload.

## 7. Explicitly out of scope

- **Collapse toggle** — the reference has none; it would add a persisted state key and a
  second layout mode to keep working across five themes.
- **Per-section attention badges** in the rail (a count on Sessions when a session needs a
  human). The data exists — `hooks/useSessionAlerts` already computes it for the tab title
  — but it is a feature, not a move.
- **Icons** on the rail items. Nothing in this codebase uses icons today.
- **Routing.** Section state stays `useState` + `usePersistedState`; no URL, no router
  dependency.
