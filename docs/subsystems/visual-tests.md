# Visual tests — the screenshot regression suite

`pnpm test:visual` renders every rail section of the built client in headless Chromium against fixed fixture data and compares each render, pixel for pixel,
with a committed PNG under `test/visual/__screenshots__/`. It also checks that no view overflows horizontally at any tier and that daylight text contrast has
not regressed. It exists so a CSS refactor (the CSS Modules migration first) can prove it changed nothing visible. It is on demand, macOS only, and not part
of `pnpm test`. Design and plan: [2026-10-01-visual-regression-design.md](../superpowers/specs/2026-10-01-visual-regression-design.md),
[2026-10-01-visual-regression.md](../superpowers/plans/2026-10-01-visual-regression.md).

## What it covers

| Spec | Cases | What |
|---|---|---|
| `views.spec.ts` | 73 shots + 1 count check | each of the 6 `SECTIONS` views at 12 states, plus Sessions with the chat drawer open (`?session=`) |
| `layout.spec.ts` | 48 overflow + 6 contrast | overflow: 6 views × 8 daylight tiers; contrast: 6 views, daylight, 1280, axe `color-contrast` |
| `stage.spec.ts` | 16 | the staging itself: seeded theme beats the default, clock, UTC, DPR 1, font loaded, deep link, every section reachable |
| `mock-api.spec.ts` | 5 | the mock: 404 for no fixture, 405 for writes, query ignored, exact path beats `:param`, off-origin refused |

The 12 states per view are daylight at the six `fixed` tiers (375, 640, 768, 1024, 1280, 1536 — each tier's `min-width` from [breakpoints](breakpoints.md),
375 for the phone base) and the two `full` tiers (1537, 1921), plus midnight, amber, graphite and nightshift at 1280. 12 × 6 + 1 = 73;
`views.spec.ts` asserts that number, so a new `SECTIONS` entry fails until the matrix and its baselines are reconsidered. Comparison is zero-tolerance:
`maxDiffPixels: 0`, `threshold: 0`, animations disabled, caret hidden, full page.

## How it runs

`playwright.config.ts` builds the client and serves it with `vite preview` on 4373 (`--strictPort`, `reuseExistingServer: false` — a held port is an error,
never a stale server silently reused). **The Node server never runs.** Every `/api/*` request is answered in the browser by `mock-api.ts` from the typed
fixtures in `test/visual/fixtures/` (one module per endpoint, typed against `shared/types.ts`, invented data only), so a shot cannot depend on this
machine's transcripts. The mock matches on pathname only — the query string is ignored — and an exact path beats a `:param` pattern. A GET with no fixture
answers 404, any non-GET 405, and any off-origin request is aborted; all three are recorded, and `harness.ts`'s auto fixture fails the case afterwards, so a
case cannot pass on an error or empty state. Google Fonts are served from `test/visual/fonts/` (Hanken Grotesk, OFL — see its README).

A fixture body may be a function of the request URL. One uses it: the chat transcript returns no messages when `?after=` is present, because the drawer's
tail poll would otherwise append the whole transcript again on every tick.

`stage.ts` puts a page into a known state: fixed clock at `EPOCH` (2026-09-30T14:00:00Z, `fixtures/epoch.ts`), UTC, `en-US`, DPR 1, sRGB, the viewport at
the case's width × 900, and the full `Settings` object seeded into `localStorage` (theme, landing section, content width; everything else at its default).
It then waits until the page is ready: `document.fonts.ready`, a Hanken Grotesk face with `status === 'loaded'`, no `/api` request in flight, and no text node
starting with "loading". Specs poll that predicate rather than reading it once, because a poll can be in flight right after staging.

## Re-baselining

```
pnpm test:visual --update-snapshots
```

No `--` before the flag: pnpm forwards a literal `--`, and Playwright ignores every argument after it — the run goes ahead as a plain comparison.

A re-baseline is always deliberate: run it only when a visible change is intended, then look at every changed PNG in the diff before committing. A refactor
that is meant to change nothing never re-baselines — a failing shot is the finding. `pnpm test:visual:report` opens the last run's HTML report with
expected / actual / diff images.

## macOS only

Chromium rasterises text differently per OS, so baselines from one platform fail everywhere else. `platform-guard.ts` refuses at config load, before anything
starts, on any platform but `darwin`:

```
visual baselines exist for macOS only (platform: linux); run pnpm test:visual on a Mac
```

That also covers `--update-snapshots`, which would otherwise overwrite every darwin baseline silently.

## Extending it

- **A view:** it appears in `SECTIONS` (`client/src/lib/sections.ts`), so the matrix picks it up — bump `EXPECTED_SHOTS`, add fixtures for whatever
  it fetches (the run names each missing one as `GET /api/...: no fixture`), and re-baseline.
- **A data state:** either a fixture variant (a function body, or a new case that installs a different `FixtureMap`) or a seeded settings key through
  `StageOpts` / `seededSettings` in `stage.ts`. Name the shot after the state.
- **An endpoint:** add a module under `fixtures/`, typed against the `shared/types.ts` response type, and register its path in `fixtures/index.ts`.

## Overflow

Each overflow case asserts `documentElement.scrollWidth <= innerWidth` (overflow in the shell or rail), and `.main`'s `scrollWidth <= clientWidth`: `.main`
has `overflow-x:clip`, so content wider than the content area is cut off without ever reaching the document's scroll width. Three views already clip at 768
(usage's `table.dt`, analytics' `.an-line-meta`, settings' `.set-control`); `KNOWN_CLIPPED` in `layout.spec.ts` records each with its measured width
(2026-10-06). An entry fails if its clip grows, and fails again once it is gone, so the fix that removes one has to delete the entry too.

## Contrast

Axe's `color-contrast` rule runs per view at daylight / 1280. Every violation becomes an entry in `test/visual/contrast-known.json`, keyed by
`view|text|fg|bg` and never by selector (`contrast-known.ts`) — the CSS Modules migration renames classes, and a selector key would report every known
violation as new on each step. A case fails on any violation not in the file, listing text, selector, colours and ratio; a known one that no longer occurs
prints `contrast fixed: <key>`, and its entry should then be deleted. The file only shrinks by hand and only grows by deleting it: the next run re-records
every view and passes, so **a run right after deleting the file proves nothing about contrast**. Axe's per-view `incomplete` count (nodes it could not judge,
e.g. over images or gradients) is printed, not asserted.

Dark-theme contrast is off: those themes are due for a redesign, and recording their current violations would only freeze them.

<!-- docs-sync:
  sources:
    - playwright.config.ts
    - test/visual/views.spec.ts
    - test/visual/layout.spec.ts
    - test/visual/stage.ts
    - test/visual/mock-api.ts
    - test/visual/harness.ts
    - test/visual/platform-guard.ts
    - test/visual/contrast-known.ts
    - test/visual/tiers.ts
    - test/visual/fixtures/index.ts
  kind: subsystem
  verified: 7a0857fcaa4cec51b5cf97f52daaa2be71c97fec
-->
