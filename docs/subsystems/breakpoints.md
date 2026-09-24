# Breakpoints — the seven-tier ladder

`client/src/styles.css` is written mobile-first against a named, seven-tier ladder on
Tailwind's numbers. The base (unprefixed) rules are the phone; every tier layers upward
with `min-width`. Two TypeScript breakpoints (`hooks/useNarrow.ts`'s `NARROW_PX` and the
column-count comment in `components/management/ManagementView.tsx`) sit on the same
ladder rather than carrying their own numbers. Design and migration history:
[2026-09-15-breakpoint-ladder-design.md](../superpowers/specs/2026-09-15-breakpoint-ladder-design.md).

## The tiers

| Tier | min-width | Role |
|---|---|---|
| (base) | 0 | Phone: rail is a top bar, board full-bleed, grids single-column |
| `sm` | 640 | Desktop shell returns (rail, board radius, `.main` padding) |
| `md` | 768 | Density: column counts, table columns, control fitting |
| `lg` | 1024 | Analytics metrics reach 5-across |
| `xl` | 1280 | Board/Tiles 3-col, Management 3-col, pinned panes |
| `2xl` | 1536 | **The lock.** Measure reaches 1248; Sessions aside moves beside |
| `3xl` | 1537 | Full content-width mode only: structural gains |
| `4xl` | 1921 | Full content-width mode only: structural gains |

`styles.css` carries the same table as a prose comment directly above `:root` — read that
block before touching a query. Both copies must agree; this doc is the narrative, the CSS
comment is the enforced reference (`test/breakpoints.test.ts` reads the CSS one).

## The lock, derived

`2xl` and `3xl` are not picked; they fall out of the shell's own arithmetic:

    240 (rail) + 24×2 (--body-pad) + 1248 (.wrap.broad measure) = 1536

1536 is the last width at which the 240px rail and the 1248px reading measure both fit at
their natural size, so it is `2xl`. 1537 — one pixel up — is the first width with room to
grow, so it is where `3xl` (wide-desktop-only structure) opens. The measure itself was
dropped from 1280 to 1248 specifically so this arithmetic would land on a real Tailwind
tier instead of sitting between two of them, the way the pre-migration 1568px lock
(240 + 48 + the old 1280px measure) never did.

## The 640 / 768 principle

The single rule that decided most of the per-rule tier choices:

> **640 is the shell boundary. 768 is the density boundary.**

Below `sm` (640) the rail is a top bar and the board is full-bleed — that is *shape*.
Between 640 and 767 the desktop shell is already back, rail and all, so a rule that used
to sit at 700px for **density** reasons (column counts, hidden table columns, which shape
a `<select>` offers, a modal's full-screen threshold) belongs at `md` (768), not `sm` —
640–767 has the 240px rail eating a third of the window, and content sized for that band
needs the density tier's answer, not the shell tier's. A rule that sat at 700px for
**shape** reasons (the rail itself, the top bar, the burger) stays at `sm`.

## Content width: capped vs full

Both settings are defined at every tier; neither is ever ignored.

| | base–`2xl` | `3xl` / `4xl` |
|---|---|---|
| **Capped** (default) | measure ramps to 1248 | **frozen at 1248, left-aligned** — `margin:0` untouched, board stays hard-left |
| **Full** | `max-width:none`, edge to edge | structural tiers: more columns, wider panes |

Capped's answer above the lock is to *hold* — a defined behaviour, not an exemption from
the ladder. Full keeps growing because nothing caps its measure; capped stops because 1248
is the number the lock was built from.

## Why a comment, not custom properties

The seven numbers live in a documented `:root`-adjacent comment block in `styles.css`,
not as CSS custom properties. `@media` cannot read `var()` in its condition — a
`--tier-2xl: 1536px` token would be unreachable from every query that needs it, and the
value would drift the moment someone edited the token but not the query (or the reverse).
The comment block is the single source of truth; every `min-width` in the file is a literal
copy of one of its numbers, and `test/breakpoints.test.ts` guards that no other literal
width sneaks in beside them.

## Tier blocks are section-local

Each section's tier rules are written directly after that section's own base rules, not
pooled into one shared block per tier value. Concretely: there is a `min-width:768px`
block right after the Sessions board rules, and a *separate* `min-width:768px` block after
the Usage rules, and so on — the numbers repeat across the file rather than the sections.

This is deliberate. Appending a new section's tier rules to an earlier, unrelated tier
block works only as long as the new section's own base rules already exist above that
block in the file; the moment a section's base rule is added or reordered below where its
tier override already lives, the override silently stops applying — no error, just a rule
that never fires. This cost two bugs during the migration. Keeping each tier block next to
the base rules it overrides makes the dependency visible at the point someone would break
it.

One consequence: counting `@media` blocks or queries in the file is not a meaningful
number — it grows every time a section is added, independent of the ladder itself. Only
the tier *values* above are the invariant worth stating.

## Standing caveats

Three pre-existing interactions the ladder does not fix, carried forward from before this
migration:

- **Compact density shifts crossovers 20px early.** `[data-density="compact"]` trims
  `--body-pad` from 24px to 14px. A `min-width` query cannot read a custom property, so
  every tier boundary that depends on `--body-pad` (the rail/measure lock chief among them)
  still fires at its literal pixel value — but compact's *true* available content width at
  that point is 20px more than an uncompacted layout would have, so its layout changes land
  20px earlier than the token's own math implies.
- **`zoom` makes tiers land late above 100% text scale.** `.shell{zoom:var(--font-scale)}`
  scales the whole app, including its `px`-based type. `@media` queries resolve against the
  unzoomed viewport, not the zoomed one, so at a text scale above 100% each tier's visual
  crossover point lands later than its literal pixel value would suggest.
- **`2xl` and `3xl` are one pixel apart.** 1536 and 1537 are adjacent by construction (the
  lock, and the tier that opens the instant there is room to grow past it). A fractional
  viewport width — browser zoom, a fractional device-pixel ratio — can in principle land
  between them, in the gap neither query claims. 1537 is the shipped, documented intent;
  no gap has been observed, but a fix (`min-width:1536.02px` for `3xl`) would go here if one
  ever is.

## See also

- [2026-09-15-breakpoint-ladder-design.md](../superpowers/specs/2026-09-15-breakpoint-ladder-design.md) — the full design, per-surface tables, and the risks accepted for this migration.
- `client/src/styles.css` — the enforced token comment, directly above `:root`.
- `test/breakpoints.test.ts` — the guard test: the seven literals appear in `styles.css`
  only inside `@media` queries and the token comment, and `useNarrow.ts`'s `NARROW_PX`
  mirrors `md` exactly.

<!-- docs-sync:
  sources:
    - client/src/styles.css
    - client/src/hooks/useNarrow.ts
    - client/src/components/management/ManagementView.tsx
    - test/breakpoints.test.ts
  kind: subsystem
  verified: f06c54a88e5655ce39e1f5b23b97d42151e257b2
-->
