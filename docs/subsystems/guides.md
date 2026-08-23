# Guides (the fifth rail section)

A **Guides** tab listing every learning artifact under `docs/published-guides/` — tutor decks
and study guides — and opening the file itself inside the dashboard, in an iframe served from
our own origin. Read-only and unpolled; the only tab whose content is authored by a skill
(`/tutor`, `/study`) rather than by the app.

## Why serve them here at all — GitHub Pages already does

`docs/published-guides/` is the one directory GitHub Pages publishes, and that stays: public,
indexable, zero infra. What it can never host is the live companion. A public HTTPS page
cannot reliably reach a private dashboard — mixed content blocks `http://…:4173`, Private
Network Access blocks the LAN hop, and the only way around both is baking a tailnet hostname
into world-readable HTML. Serving the same bytes from the dashboard flips every one of those
constraints at once: same origin, private by default, reachable on the phone wherever the
dashboard already is.

**Dual home, one artifact.** This adds a second *serving route* over the same files on disk,
not a second copy. Nothing here generates, mirrors, or writes anything.

## The two routes

| Route | Contract |
|---|---|
| `GET /api/guides` | `GuidesIndex` JSON, **always 200** — `{ generatedAt, decks[], guides[], error? }`. `Cache-Control: no-store`, via `sendJson` like every other JSON endpoint. Scanned per request; no cache |
| `GET /guides/<relPath>` | The file's bytes, `Content-Type` from `GUIDE_MIME`, `Cache-Control: no-store`. Anything `resolveGuidePath` refuses — traversal, a directory, a symlink escape, simply nothing there — is a flat **404 `{ error: 'not found' }`**, never a distinguishable one. A `relPath` that fails `decodeURIComponent` is **400 `{ error: 'bad path encoding' }`** (`decodePath` in `index.ts`, shared with the id-scoped routes) |

`/guides/<rest>` sits **immediately before the `serveStatic` fallback** — last in the chain, so
a prefix match there shadows nothing.

`GUIDE_MIME` has ten entries: the eight from `index.ts`'s private `MIME` map, copied rather
than imported (that map is module-private there), plus `.mjs` and `.md`. No case-folding,
matching the map it mirrors — `.HTML` misses and falls back to `application/octet-stream`.

⚠️ **The scan is an index of entry points, not an allowlist of servable files.** Anything under
`guidesDir` that survives `resolveGuidePath` can be fetched, listed or not. That is deliberate
and load-bearing: a study guide's `index.html` pulls in its own CSS, images and relative links,
none of which appear in `GuidesIndex`.

## ⚠️ The traversal guard is stricter than `serveStatic`'s, on purpose

`serveStatic` (server/index.ts:78) tests `filePath.startsWith(clientDist)` — a bare string
prefix, **no separator**. With a root of `/x/guides`, a sibling `/x/guides-secret` passes that
check. It survives there because `clientDist` is a build output nobody plants siblings beside.

`resolveGuidePath` gets no such luxury: `docs/published-guides/` lives in the repo, one `../`
from `.env` and its ntfy topic and answer token. So it

1. rejects the raw string first — empty, an exact `..` **segment** (a filename that merely
   *contains* `..`, like `a..b.html`, is a legal name and is left alone), a leading `/`, a
   backslash, a NUL byte; then
2. `realpathSync`es **both** sides and requires `target.startsWith(root + path.sep)`.

Realpathing both sides is not symmetry for its own sake: on macOS `os.tmpdir()` sits behind a
symlink (`/var` → `/private/var`), so comparing a realpath'd target against a raw root string
would fail every request, traversal or not. The trailing `path.sep` is what closes the
`guides-secret` hole above — and incidentally rejects `.`, since the root never prefixes itself
with a separator. **Do not harmonize this back to `serveStatic`'s shape.** The asymmetry is the
point.

A literal `..` never reaches the function through this route anyway: `new URL()` normalizes
`/guides/../.env` to pathname `/.env` before routing, and that falls through to `serveStatic`.
The shape that arrives intact is the percent-encoded one — `/guides/..%2f.env` keeps its
pathname verbatim, `decodePath` un-escapes it to `../.env`, and step 1 rejects it. Both are
refused; only the second is this route's own job.

## What the scanner lists, and what it skips

`scanGuides(guidesDir)` walks the tree once per request and returns two sorted lists.

- A **deck** is any `*.html` whose first **1024 characters** contain `<!-- tutor-deck -->` (the
  literal the tutor skill writes right after `<!DOCTYPE html>`). Title is the first `<title>`
  with ` — a tutor lesson` stripped, falling back to the filename; `generated`, `commit` and
  `sections` come from the `id="provenance"` JSON stamp. Every stamp field is independently
  nullable — a legacy deck with a marker and no stamp still lists, with a title and nothing else.
- A **guide** is a directory other than the root whose immediate children include `index.html`.
  `name` is the basename, `title` its `<title>` or null.
- ⚠️ **The root `index.html` is skipped.** It is the GitHub Pages hub — a link page for the
  public site, not an artifact.
- ⚠️ **A guide directory is never descended into.** It yields exactly one `GuideRef` and its
  **whole subtree** is then skipped — subdirectories *and* immediate files. A guide's `guide/`
  notes, its `tools/` scripts, and even a marker'd deck sitting inside it are deliberately not
  listed. One directory, one card; the alternative shows a guide's own internals as if they
  were its siblings.

Targeted regexes rather than an HTML parser, deliberately: every file here is machine-generated
by our own skills, so there is no adversarial-HTML surface for a parser to defend.

## Ordering

Decks: `generated` **descending**, nulls last, ties broken by `relPath` **ascending**. Guides:
`name` ascending.

The tie-break is live, not theoretical — both decks currently on disk carry
`generated: 2026-08-23`, so `relPath` is what actually orders the tab today. A comparator that
left ties to `Array.prototype.sort` would make the order arbitrary right now, not eventually.

## The pieces

| Piece | What it does |
|---|---|
| `server/lib/guides.ts` | The whole domain, pure and unit-tested: `isTutorDeck`, `extractTitle`, `parseDeckMeta`, `scanGuides`, `resolveGuidePath`, `GUIDE_MIME`. No HTTP, no config. 28 cases in `test/guides.test.ts` |
| `serveGuidesIndex` / `serveGuideFile` (`server/api.ts`) | The two handlers. `serveGuideFile` never echoes the resolved path into a response — it is an absolute, canonical filesystem path, and disclosing the layout is exactly what the guard exists to prevent |
| `server/index.ts` | `/api/guides` exact match, and `/guides/<rest>` last before `serveStatic` |
| `config.guidesDir` | `GUIDES_DIR` or `<cwd>/docs/published-guides`, trimmed, resolved inside `loadConfig()` |
| `useGuides` + `GuidesView` | Fetch-once hook and the lazy-chunk view: a two-group card list (Decks, Study guides), and the iframe viewer a card swaps to |
| `vite.config.ts` | `/guides` next to `/api` in the dev proxy. The route lives in the Node server, so without this entry the iframe 404s — under `pnpm dev` only, which is the worst kind of gap to find later |

## `GUIDES_DIR`: unset means the default directory, not off

Unlike `NTFY_TOPIC`, `WHISPER_MODEL` and `CLAUDE_BIN` — where empty disables the feature —
leaving `GUIDES_DIR` unset selects `<cwd>/docs/published-guides`. **The tab exists whenever the
directory does**; there is no on/off flag, and an absent directory just renders an empty tab. It
resolves from `process.cwd()`, so it follows where the server was started from rather than
walking up for a repo root.

## Fail-open, in two shapes that are deliberately different

- **A missing or unreadable directory, or any unreadable entry inside it, is not an error.**
  `scanGuides` skips it and returns empty arrays with **no `error` flag**; the tab reads
  *"nothing published yet"*. An empty tab, not a broken one — deleting `docs/published-guides/`
  must not look like a bug.
- **A thrown scan is.** `serveGuidesIndex` catches, logs, and answers **200** with
  `error: true`; the tab reads *"guides unavailable"*. Still 200, because the client keys off
  the flag, not the status.

`scanGuides` is written never to reject, so that second branch is a defensive net rather than a
path anything currently takes. It stays because the two outcomes must remain distinguishable in
the UI: "nothing here" and "something broke" collapsing into one message is the failure mode
this pair exists to avoid.

## ⚠️ The iframe has no `sandbox` attribute

Deliberate. A deck is script-driven top to bottom: every `.card` starts `display:none` and only
`.card.active` renders, so Back/Next, the arrow-key shortcuts and the quiz's click-to-reveal all
come from the deck's own inline `<script>`. Sandbox it and the deck freezes on card one,
permanently. (The "Questions you might ask" `<details>` cards are native disclosure and would
survive; the pager and the quiz would not.)

The trade is acceptable only because of what sits on the other side: our own origin, our own
server, our own generated HTML, from a directory already in the repo. There is no untrusted
content here to isolate. If that stops being true — a guides directory fed from elsewhere, or
the cross-project scan named as a v1 non-goal — the sandbox question reopens *before* the
scanner does.

## `Cache-Control: no-store` on both routes

Decks are **regenerated in place**: `/tutor` rewrites the same path when the code it teaches
moves. A stale cached deck after a refresh is a worse failure than re-sending a few KB — you
would be studying yesterday's file while its own card reads today's date. The files are small
and the tab is opened by hand; there is nothing here worth caching for.

## The reserved companion slot

`.guide-viewer-head` is kept as its own element with a stable class name because it is where the
**Ask Claude** panel mounts: ask a question about the deck on screen, and the server answers it
by running a one-shot headless `claude -p` in this repo — grounded in the code as it is today,
not as the deck's snapshot remembers it.

That spec, `docs/superpowers/specs/2026-08-22-guide-ask-design.md`, is **on hold since
2026-08-22** — deliberately not approved alongside this tab. The panel is specified to live in
the dashboard chrome *around* the iframe, never inside the deck HTML, so the deck contract stays
network-free and the GitHub Pages copy degrades to "no panel" for free. Nothing here implements
any of it; the element and its class name are the entire commitment.

## Known limits / not verified

- **iOS Safari iframe scrolling is unverified** — no device was available. Height and
  scroll-inside-iframe on iOS is the risk flagged at design time and it needs a human pass on a
  real phone. `.guide-viewer-body` carries `overflow:hidden` so a cramped viewport clips instead
  of double-scrolling, but that is reasoning, not a measurement.
- **Narrow-viewport wrapping of the decks' Q&A cards is unverified** — long `<summary>` lines
  carrying inline `<code>` were never checked at phone widths.
- **No deep link.** `?guide=<relPath>` was proposed and rejected for v1; the tab always opens on
  the list (contrast `?session=`, see [push-notify](push-notify.md)).
- **No cross-project scan.** Only this repo's `guidesDir`. The scanner and the marker generalize;
  the serving guard is the part that would need care.
- **No refresh control, and no poll.** `useGuides` fetches once per mount and switching sections
  unmounts the view, so leaving the tab and coming back *is* the refresh.

<!-- docs-sync:
  sources:
    - server/lib/guides.ts
    - server/api.ts
    - server/index.ts
    - server/lib/config.ts
    - client/src/hooks/useGuides.ts
    - client/src/components/guides/GuidesView.tsx
    - vite.config.ts
  kind: subsystem
  verified: 8b899976811d80eb4e64e295238bed9bee79c8d8
-->
