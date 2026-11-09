# UI verify — usage-rate model separation

**Plan:** `docs/superpowers/plans/2026-11-09-usage-rate-model-separation.md` · **Branch:** `docs/usage-rate-model-separation` at `af58658` · **Run:** 2026-11-09

**Verdict: PASS** — no defects.

## Inventory

No mocks: neither the spec nor the plan cites one (the change re-derives figures and adds reason copy inside an existing card; no new layout). Reference is the
spec's copy text plus geometry only.

| View | Mock | How opened | Data | States checked |
|---|---|---|---|---|
| Usage → Token value (summary tiles, per-model table, By-day strip, glossary) | none | branch Vite on 5273 → branch API on 4273, localStorage `dashboard.section=usage`, sub-nav "Token value" (hamburger first at 375) | `/api/usage/rates` routed to a fixture built by the branch's `shapeUsageRates` over a 2026-11-09 snapshot of this machine's live usage ledger/history/profile | one rated model (`stable`), four `collecting` (one with no windows), a `thin` day with the new "another model's rate moved" reason, rated days within/below baseline |

Why a fixture: the worktree's settings have `recordUsageHistory` off, so the branch API returns empty rates; enabling it would start a second recorder and
token refresh beside the main checkout's. The fixture is the branch's own shaping code over real data, not a hand-built JSON.

## Geometry (step 4)

| Viewport | Overflow check output |
|---|---|
| 1440×1000 | `[]` |
| 375×812 | `[]` |

26 day cells in the strip at both widths; tooltips captured for every rated or thin cell.

## Regions

- Summary tiles (Priced 1 · Drifting 0 · Collecting 4 · Coverage 56% · Ledger 280): match spec counts; tiles wrap to 2 columns at 375, no clipping.
- Per-model table, 1440: columns Model · Verdict · Weighted · Raw · Fitted · Δ baseline · Windows · Share in order; Opus row `stable 601k`, Δ `+12.1%`, no
  pooled-looking figure on any other row. Match.
- Per-model table, 375: rows fold to label/value cards (existing behaviour); same values. Match.
- `collecting` rows: evidence ledger reads "another model's rate moved in the current window — this one is not judged until it settles". Matches spec copy.
- By-day strip: Nov 8 is `thin`, tip "… another model's rate moved — can't be separated, not coloured"; Nov 9 rated 557k. Matches spec copy and colouring rule.
- Glossary entries for the separated rate render below the table. Match.

## Screenshots

Scratchpad, not committed: `uiv/live-1440x1000.jpg`, `uiv/live-375x812.jpg`, `uiv/live-375-top.jpg`; text dumps `uiv/card-*.txt`, tips `uiv/tips-*.json`.
Harness: `uiv/harness.mjs` (cached Playwright, `page.route` fixture).

## Not verified

- Dark themes (spec draws no new colour; the strip reuses existing classes).
- A live recorder on the branch producing the same payload — the fixture was produced offline by branch code.
