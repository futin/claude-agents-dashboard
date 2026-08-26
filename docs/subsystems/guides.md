# Guides (the fifth rail section)

A **Guides** tab listing every learning artifact under `docs/guides/` — tutor decks
and study guides — and opening the file itself inside the dashboard, in an iframe served from
our own origin. Read-only and unpolled; the only tab whose content is authored by a skill
(`/tutor`, `/study`) rather than by the app.

## Why serve them here at all

`docs/guides/` is plain repo content, not a published site — there is no public host for
these files, so the dashboard is the only place they're readable as HTML rather than raw
source. Same origin, private by default, reachable on the phone wherever the dashboard
already is: no mixed-content or Private Network Access hop to worry about, the two failure
modes a public HTTPS page would hit trying to reach a private one.

Nothing here generates, mirrors, or writes anything — this is a serving route over files
already on disk.

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

`resolveGuidePath` gets no such luxury: `docs/guides/` lives in the repo, one `../`
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
- ⚠️ **The root `index.html` is skipped**, if one exists there — a root index page is never a
  guide artifact, unlike a subdirectory's.
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
| `config.guidesDir` | `GUIDES_DIR` or `<cwd>/docs/guides`, trimmed, resolved inside `loadConfig()` |
| `useGuides` + `GuidesView` | Fetch-once hook and the lazy-chunk view: a two-group card list (Decks, Study guides), and the iframe viewer a card swaps to |
| `vite.config.ts` | `/guides` next to `/api` in the dev proxy. The route lives in the Node server, so without this entry the iframe 404s — under `pnpm dev` only, which is the worst kind of gap to find later |

## `GUIDES_DIR`: unset means the default directory, not off

Unlike `NTFY_TOPIC`, `WHISPER_MODEL` and `CLAUDE_BIN` — where empty disables the feature —
leaving `GUIDES_DIR` unset selects `<cwd>/docs/guides`. **The tab exists whenever the
directory does**; there is no on/off flag, and an absent directory just renders an empty tab. It
resolves from `process.cwd()`, so it follows where the server was started from rather than
walking up for a repo root.

## Fail-open, in two shapes that are deliberately different

- **A missing or unreadable directory, or any unreadable entry inside it, is not an error.**
  `scanGuides` skips it and returns empty arrays with **no `error` flag**; the tab reads
  *"nothing published yet"*. An empty tab, not a broken one — deleting `docs/guides/`
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

## Where the viewer's height comes from — three different answers

An iframe is a replaced element with no content-derived height, so whatever the pane is
given is the whole of what the learner reads through. The shell hands it one in three
different ways, and the phone one is not a smaller version of the desktop one.

| Width | Shape | Why |
|---|---|---|
| ≥1201px | `.wrap.wide` is an app shell (`height:calc(100vh…)`); the viewer is a flex child | the page never scrolls, each pane does |
| 701–1200px | in flow; `.guide-viewer-body` gets a `100dvh`-derived `min-height` floor | the rail is a left column here and the page reads fine as a scroller |
| ≤700px | out of flow entirely: `position:fixed;inset:0`, its own head the only chrome | below |

⚠️ **Below 1201px there is no height to inherit.** `.wrap.wide`'s `height` lives inside
`@media (min-width:1201px)`; everywhere else the viewer is an auto-height block, so
`.guide-viewer-body{flex:1;min-height:200px}` lands on its own floor and nothing else.
Measured on a 375×812 viewport before this was fixed: iframe **200px**, deck content
**1235px** — and, the part that actually broke the tab, the deck's own Back/Next pager
laid out at y=340–418, **140px past the bottom of the porthole**. A deck is *paged*, not
scrolled, so an unreachable pager means card one forever: the per-section Q&A cards (card
6 of 32 in the spawn deck, behind a gating quiz) read as missing when they were merely
unreachable. Height is not cosmetic here the way it would be for a scrolling document.

**The phone gets an overlay, not a taller pane.** `position:fixed;inset:0` is the move
`.chat-back` already makes in this stylesheet, for the same reason: on a phone the rail
strip, the page padding and the tab chrome are worth more as reading area than as
wayfinding. The head stays put, so `‹ Guides` remains the way back out.

**The overlay also locks the page under it.** A deck scrolls *inside the iframe*, and a
scroller in another document cannot be handed an `overscroll-behavior` from out here the
way `.chat-body` hands itself one. So the chain is refused at the far end instead:
`GuidesView` puts `.guide-locked` on `<html>` for exactly as long as a guide is open, and
the phone breakpoint gives that class `overflow:hidden;overscroll-behavior:none`. Without
it, reaching the bottom of a deck chains the gesture out to the document and rubber-bands
the whole app past the edges of the overlay — and since the outer document has nothing to
scroll (812 of 812 on a phone), that bounce is the *entire* visible effect, which is why
`overflow:hidden` alone would not have been enough. The class goes on unconditionally and
is gated in CSS, so desktop keeps its own behaviour; the effect's cleanup runs on unmount
as well as on close, because leaving the tab with a guide open must not strand the app
with an unscrollable page.

⚠️ **Both viewport-derived heights divide by `--font-scale`.** `.shell{zoom}` scales a
fixed child's viewport units too, so an uncorrected `100dvh` overhangs by the scale at
110% text — the same correction the rail makes, for the same reason. And both use
`100dvh`, never `100vh`: iOS Safari's collapsing URL bar would otherwise leave the deck
permanently short by the height of the bar.

## The reserved companion slot

`.guide-viewer-head` is kept as its own element with a stable class name because it is where the
**Ask Claude** panel mounts: ask a question about the deck on screen, and the server answers it
by running a one-shot headless `claude -p` in this repo — grounded in the code as it is today,
not as the deck's snapshot remembers it.

That spec, `docs/superpowers/specs/2026-08-22-guide-ask-design.md`, is **on hold since
2026-08-22** — deliberately not approved alongside this tab. The panel is specified to live in
the dashboard chrome *around* the iframe, never inside the deck HTML, so the deck contract stays
network-free regardless. Nothing here implements any of it; the element and its class name are
the entire commitment.

## Known limits / not verified

- **The phone pass was done, on the phone.** 2026-08-23: the overlay and the scroll lock were
  both driven by hand on the author's phone against the branch build and reported correct —
  which is the only test that counts here, since touch chaining and the URL-bar rubber band
  are the failure modes and neither can be produced with a mouse. The device and browser were
  not recorded, so read this as "a real phone", not "iOS Safari 18". Everything else about
  those two behaviours (the 375×812 measurements, text scales 1.0/1.1/1.25, the media gate,
  cleanup on unmount) was a desktop browser at a phone-sized viewport.
- **The chain is refused at one end only.** `.guide-locked` stops the gesture at the root; the
  deck documents themselves still carry `overscroll-behavior: auto`. That held on the phone it
  was tested on. An engine where a root-level refusal does not stop a chain out of an iframe
  would need the property on the guide documents instead — a tutor deck-contract change, and
  the two study guides separately.
- **Android untested,** and only the tutor decks were opened on a phone — the two study guides
  (`learning/hooks`, `learning/dictation`) are long scrolling documents rather than paged decks,
  which is the shape that leans hardest on the lock.
- **Narrow-viewport wrapping of the decks' Q&A cards** — checked once at 375px, in a desktop
  browser: three `<summary>` lines carrying inline `<code>` wrap onto two lines each without
  overflowing. The phone pass above covered reaching and reading them, not this measurement.
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
    - shared/types.ts
    - client/src/hooks/useGuides.ts
    - client/src/components/guides/GuidesView.tsx
    - client/src/styles.css
    - vite.config.ts
  kind: subsystem
  verified: 1809dcd9a7eb2be002de750150f12d33bc62df6b
-->
