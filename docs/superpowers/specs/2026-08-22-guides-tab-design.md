# Guides tab — design

A fifth side-rail section, **Guides**, that lists every learning artifact under
`docs/published-guides/` (tutor decks and study guides) and opens them inside the
dashboard. Because the dashboard serves the deck itself, the page is same-origin with the
API — which is what makes the Ask-Claude companion (see
`2026-08-22-guide-ask-design.md`) possible with zero CORS/mixed-content fights, and what
makes decks readable on the phone over the tailnet without GitHub Pages.

Status: **approved 2026-08-22** (via dashboard remote answer; recommendations stand —
iframe viewer, no deep link in v1).

## Why this instead of GitHub Pages

GitHub Pages stays (public, indexable, zero-infra), but it can never host the live
companion: a public HTTPS page cannot reliably reach a private dashboard (mixed content,
Private Network Access, tailnet hostnames leaking into world-readable HTML). Serving the
same files from the dashboard flips every constraint: same origin, private by default,
works on the phone wherever the dashboard already works. The deck file on disk remains
the single source of truth; this feature adds a second *serving* route, not a second
artifact.

## Existing machinery this leans on

| Fact | Where |
|---|---|
| Static file serving with a MIME map already exists for `client/dist` | `MIME` at server/index.ts:62, `serveStatic` at server/index.ts:74 |
| Path-guarded file serving precedent (allowlist + traversal guard) | servable-path security set, server/lib/management.ts (see docs/subsystems/management.md) |
| Side-rail section switch + lazy chunks | `Section` at client/src/components/SideRail.tsx:1, App.tsx lazy imports |
| Deck identity + metadata are machine-readable | `<!-- tutor-deck -->` marker and the `id="provenance"` JSON stamp (title, commit, generated, sections) — tutor skill deck contract §1/§6 |
| Frontend fetch-once-per-mount hook pattern | client/src/hooks/useManagement.ts |

## Design

### Server

- **Config**: `guidesDir`, default `<repo>/docs/published-guides` (repo root = the
  directory `server/` runs from, same resolution `loadConfig()` already uses for `.env`).
  Follows the "unset means default, not off" shape — the tab exists whenever the
  directory does.
- **`GET /api/guides`** → `GuidesIndex` (new in `shared/types.ts`):
  - `decks: DeckRef[]` — every `*.html` under `guidesDir` whose first bytes contain the
    `<!-- tutor-deck -->` marker. Each ref: `relPath`, `title` (from `<title>`, suffix
    " — a tutor lesson" stripped), and `generated` + `commit` + `sections`
    (`{id, title}[]`, which also gives the count) parsed from the provenance stamp (all
    nullable; a legacy deck without a stamp still lists). The section list is what the
    Ask-Claude panel's section picker consumes (`2026-08-22-guide-ask-design.md`).
  - `guides: GuideRef[]` — every directory under `guidesDir` containing an
    `index.html` (the study guides, e.g. `learning/dictation/`). Each ref: `relPath`,
    `name` (directory basename), `title` from its `index.html` `<title>` when present.
  - The hub `index.html` at the root is neither — it exists for GitHub Pages and is
    skipped.
  - Scan is on-demand per request (no cache; the directory is small and changes rarely).
    Fail-open: an unreadable file is skipped, never a 500.
- **`GET /guides/<relPath>`** — static-serves files under `guidesDir` only:
  - Resolve, then require the resolved path to start with the resolved `guidesDir`
    (same traversal guard shape management.ts uses). Symlinks resolved before the check.
  - Reuse the `MIME` map; `Cache-Control: no-store` (decks are regenerated in place;
    stale cache after a refresh is worse than the few KB).
  - Served in dev **and** prod: the route lives in the Node server, so
    `vite.config.ts` adds `/guides` to the dev proxy next to `/api`.

### Client

- `Section` union gains `'guides'`; `TABS` gains `{ id: 'guides', label: 'Guides' }`.
- `GuidesView` — own lazy chunk, like Management/Analytics/Settings:
  - **List state**: cards in two groups, *Decks* and *Guides*. A deck card shows title,
    section count, generated date, short commit; a guide card shows title. Fetch once
    per mount (`useGuides` hook, `useManagement.ts` pattern — no polling).
  - **Viewer state**: tapping a deck swaps the pane to a full-height same-origin
    `<iframe src="/guides/<relPath>">` with a back control in a slim header. The deck's
    own mobile-first layout does the rest. A study guide opens the same way
    (`/guides/<dir>/index.html`); its internal relative links keep working because the
    whole tree is served.
  - The viewer header is where the Ask-Claude companion panel mounts later — this spec
    only reserves the slot.
- Styling: theme tokens only (no literal colors); `wide` layout like management.

### Naming

User-facing label is **Guides** everywhere (rail, headers). "Lessons" is not used.

## Non-goals

- **No cross-project guide scan in v1.** Only this repo's `guidesDir`. Decks generated
  into other projects' `learning-docs/` are a follow-up (the scanner + `<!-- tutor-deck -->`
  marker generalize; the serving guard is what needs care).
- **No deck editing, refreshing, or regeneration from the UI.** Read-only, like
  management file viewing.
- **No progress tracking.** The deck's own score state is per-load by design.
- **No removal of GitHub Pages.** Dual home, one artifact.

## Testing

Backend (node-assert, tmpdir fixtures, house style):

- Scanner: tmpdir with a stamped deck, a legacy deck (marker, no stamp), a study-guide
  dir with `index.html`, a root `index.html` hub, a stray `.md` → exact `GuidesIndex`
  (hub skipped, legacy deck listed with null metadata, `.md` ignored).
- Stamp parse: malformed JSON stamp → deck still listed, nulls; title extraction strips
  the " — a tutor lesson" suffix; missing `<title>` → filename fallback.
- Traversal guard: `/guides/../.env`, `/guides/%2e%2e%2f.env`, absolute-path smuggling,
  and a symlink escaping `guidesDir` → 404/400, never file content. `/guides/tutor/write-paths-deck.html`
  → 200 `text/html`.
- Route order: `/api/guides` not swallowed by the `/api/sessions` prefix or `serveStatic`.

Client: `useGuides` state transitions; list→viewer→back state; not verified in a real
browser — needs a human pass on the phone (iframe height/scroll on iOS Safari is the
known risk).

## Open decisions (flagged at approval)

1. Deck opens in an in-tab iframe (recommended, keeps companion slot) vs a plain new
   tab (simpler, loses the companion context).
2. Whether guide cards deep-link (`?guide=<relPath>` like `?session=`) in v1 — proposed
   **no**.
