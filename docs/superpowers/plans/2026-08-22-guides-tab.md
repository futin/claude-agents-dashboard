# Guides Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth side-rail section, **Guides**, that lists every tutor deck and study
guide under `docs/published-guides/` and opens them in a same-origin iframe viewer.

**Architecture:** New pure scanner/parser domain module `server/lib/guides.ts`; two new
routes in the existing hand-rolled router (`GET /api/guides` JSON index, `GET /guides/*`
guarded static serving); a lazy `GuidesView` chunk with list→viewer states, following the
Management/Analytics patterns exactly.

**Tech Stack:** Node built-ins only on the server (house rule), React + Vite client,
node-assert tests via `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-08-22-guides-tab-design.md` — read it first; this
plan argues from it.

## Global Constraints

- Backend stays zero-runtime-dep: `node:fs`, `node:path` only. No new outbound calls.
- Plans specify behaviour and exact test cases; the implementer writes the code
  (project CLAUDE.md rule — do not transcribe test scaffolding from anywhere).
- Every API shape change starts in `shared/types.ts`; cross-boundary imports are
  `import type`.
- No literal colors/shadows in `styles.css` below the theme-token block.
- User-facing label is **Guides** everywhere. Never "Lessons".
- TDD per task: failing test → run → implement → green → commit. `pnpm test` and
  `pnpm typecheck` must be green at every commit.
- Work on a fresh branch off `main` (e.g. `feat/guides-tab`), not on
  `feat/chat-drawer-context`.

---

### Task 1: Types + pure deck-metadata parser

**Files:**
- Modify: `shared/types.ts` (append near `ManagementIndex`, around line 779)
- Create: `server/lib/guides.ts`
- Test: `test/guides.test.ts` (new; register in `test/run-all.ts` like every sibling)

**Interfaces:**
- Produces (in `shared/types.ts`):
  - `interface DeckSection { id: string; title: string }`
  - `interface DeckRef { relPath: string; title: string; generated: string | null; commit: string | null; sections: DeckSection[] | null }`
  - `interface GuideRef { relPath: string; name: string; title: string | null }`
  - `interface GuidesIndex { generatedAt: string; decks: DeckRef[]; guides: GuideRef[]; error?: boolean }`
- Produces (in `server/lib/guides.ts`, all exported, all pure):
  - `isTutorDeck(html: string): boolean` — true iff the literal `<!-- tutor-deck -->`
    appears in the first 1024 chars (the contract puts it right after `<!DOCTYPE html>`).
  - `parseDeckMeta(html: string): { title: string | null; generated: string | null; commit: string | null; sections: DeckSection[] | null }`
  - `extractTitle(html: string): string | null` — first `<title>` element's text, with a
    trailing ` — a tutor lesson` (em dash, exact) stripped when present.

`parseDeckMeta` behaviour: title via `extractTitle`; stamp via the first
`<script type="application/json" id="provenance">…</script>` block (attribute order as
the tutor skill writes it; match both `type` and `id` present). Parse its JSON;
`generated`/`commit` only when they are strings; `sections` only when it is an array
whose entries have string `id` and `title` (entries failing that are dropped; an empty
result array is still returned as `[]`, not null). Any parse failure → that field null,
never a throw. A missing stamp → all three null while `title` still works.

- [ ] **Step 1: Write the failing tests** in `test/guides.test.ts`, house style
  (`function test(name, fn)` + exported `run(): number`, see `test/decode-path.test.ts:1-16`).
  Build one fixture HTML string constant containing: `<!DOCTYPE html>`,
  `<!-- tutor-deck -->` on line 2, `<title>The write paths — a tutor lesson</title>`, and
  a provenance script with `{"commit":"abc123def","generated":"2026-08-20","sources":["server/lib/pending.ts"],"sections":[{"id":"s1","title":"One","sources":["server/lib/pending.ts"]},{"id":"s2","title":"Two","sources":[]}]}`.
  Exact cases:
  1. `isTutorDeck(fixture)` → `true`; `isTutorDeck('<!DOCTYPE html><html></html>')` →
     `false`; marker present only *after* char 1024 → `false`.
  2. `parseDeckMeta(fixture)` deep-equals `{ title: 'The write paths', generated: '2026-08-20', commit: 'abc123def', sections: [{id:'s1',title:'One'},{id:'s2',title:'Two'}] }`
     (note: per-section `sources` dropped from the API shape).
  3. Fixture without the stamp block → `{ title: 'The write paths', generated: null, commit: null, sections: null }`.
  4. Stamp whose body is `{not json` → same all-null-but-title result.
  5. `extractTitle('<title>Plain page</title>')` → `'Plain page'` (no suffix to strip);
     no `<title>` at all → `null`.
  6. Stamp with `sections: [{id:'s1'},{id:'s2',title:'Two'}]` → `sections` equals
     `[{id:'s2',title:'Two'}]` (malformed entry dropped, valid one kept).
- [ ] **Step 2: Run to verify failure**: `pnpm test` — new module fails to import
  (`server/lib/guides.ts` missing). Register the module in `test/run-all.ts` now.
- [ ] **Step 3: Implement** `shared/types.ts` additions and `server/lib/guides.ts`
  (regex-based extraction is fine — decks are machine-generated, not adversarial HTML;
  say so in a doc comment).
- [ ] **Step 4: Run**: `pnpm test` (all green, case count grew) and `pnpm typecheck`.
- [ ] **Step 5: Commit**: `feat(guides): deck metadata parser + API types`

### Task 2: Directory scanner

**Files:**
- Modify: `server/lib/guides.ts`
- Test: `test/guides.test.ts`

**Interfaces:**
- Produces: `scanGuides(guidesDir: string): Promise<GuidesIndex>` — never rejects.

Behaviour:
- Walk `guidesDir` recursively with `fs.promises.readdir(..., { withFileTypes: true })`.
- A directory (other than the root) whose immediate children include `index.html`
  becomes one `GuideRef { relPath, name: basename, title: extractTitle(indexHtml) }` and
  is **not** descended into further.
- Any `*.html` file elsewhere whose content passes `isTutorDeck` becomes a `DeckRef`
  (`title` falls back to the filename without `.html` when `extractTitle` is null).
- The root's own `index.html` (the GitHub Pages hub) is skipped. Non-marker `.html`
  files and all other extensions are ignored.
- Ordering: decks by `generated` descending, nulls last, ties by `relPath` ascending;
  guides by `name` ascending. `relPath` uses `/` separators.
- Fail-open: an unreadable entry is skipped; a missing/unreadable `guidesDir` returns
  `{ generatedAt, decks: [], guides: [] }` with no `error` flag (an empty tab, not a
  broken one).

- [ ] **Step 1: Write the failing tests.** tmpdir fixture (house pattern:
  `fs.mkdtempSync(path.join(os.tmpdir(), 'guides-'))`, cleaned in a `finally`):
  - `index.html` at root (hub, no marker)
  - `tutor/a-deck.html` — marker + stamp (`generated: '2026-08-20'`, one section)
  - `tutor/b-deck.html` — marker, no stamp
  - `tutor/notes.md`
  - `stray.html` — no marker
  - `learning/dictation/index.html` (`<title>Dictation</title>`) +
    `learning/dictation/guide/x.md` + `learning/dictation/index2.html` (marker'd deck
    inside a guide dir — must NOT be listed, proves non-descent)
  Exact expectations: `decks` = `['tutor/a-deck.html', 'tutor/b-deck.html']` in that
  order (dated before undated), `b-deck` with all-null metadata; `guides` =
  `[{ relPath: 'learning/dictation', name: 'dictation', title: 'Dictation' }]`; nothing
  else. Second case: `scanGuides('<tmpdir>/does-not-exist')` → empty arrays, no throw.
- [ ] **Step 2: Run to verify the new cases fail** (`pnpm test`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5: Commit**: `feat(guides): published-guides scanner`

### Task 3: Traversal guard + MIME

**Files:**
- Modify: `server/lib/guides.ts`
- Test: `test/guides.test.ts`

**Interfaces:**
- Produces: `resolveGuidePath(guidesDir: string, relPath: string): string | null` and
  `GUIDE_MIME: Record<string, string>`.

Behaviour of `resolveGuidePath`: returns the absolute on-disk path only when ALL hold —
`relPath` non-empty, contains no `..` segment, no leading `/`, no `\\`, no NUL; the
`fs.realpathSync`-resolved target sits under the realpath of `guidesDir`
(`startsWith(root + path.sep)`) — this is deliberately stricter than `serveStatic`'s
prefix check at server/index.ts:78, which lacks the separator; and the target is a
regular file. Anything else → `null` (including ENOENT). `GUIDE_MIME`: the eight
entries of `MIME` (server/index.ts:62-71) plus `'.mjs': 'text/javascript; charset=utf-8'`
and `'.md': 'text/markdown; charset=utf-8'`; unknown extensions fall back to
`application/octet-stream` at the call site.

- [ ] **Step 1: Write the failing tests** (same tmpdir fixture as Task 2, plus a
  symlink `tutor/escape.html` → a real file outside the tmpdir):
  1. `resolveGuidePath(dir, 'tutor/a-deck.html')` → the absolute fixture path.
  2. Each of `'../x'`, `'a/../../x'`, `'/etc/passwd'`, `''`, `'tutor'` (a directory),
     `'tutor/missing.html'`, `'tutor/escape.html'` (the symlink) → `null`.
  3. `GUIDE_MIME['.mjs']` → `'text/javascript; charset=utf-8'`; `GUIDE_MIME['.md']` →
     `'text/markdown; charset=utf-8'`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**: `pnpm test`, `pnpm typecheck` — green.
- [ ] **Step 5: Commit**: `feat(guides): guarded path resolution for guide serving`

### Task 4: Config knob + endpoints + routes + dev proxy

**Files:**
- Modify: `server/lib/config.ts` (Config interface, `DEFAULTS`, `loadConfig` at :197-219)
- Modify: `server/api.ts` (new handlers next to the management block at :943)
- Modify: `server/index.ts` (routes in the `createServer` dispatch at :123-269)
- Modify: `vite.config.ts` (proxy block at the `'/api'` entry)
- Test: `test/guides.test.ts`

**Interfaces:**
- Consumes: `scanGuides`, `resolveGuidePath`, `GUIDE_MIME` (Tasks 2–3); `sendJson`
  pattern (server/api.ts:945); `decodePath` (server/index.ts:109).
- Produces:
  - `Config.guidesDir: string` — env `GUIDES_DIR`, default
    `path.join(process.cwd(), 'docs', 'published-guides')` (same cwd convention as
    `clientDist` at server/index.ts:36). String-trim shape like `claudeBin` at :217.
  - `serveGuidesIndex(config: Config, res: ServerResponse): Promise<void>` — 200 with a
    `GuidesIndex`; a thrown scan error logs `[dashboard] guides index failed:` and sends
    `{ error: true, generatedAt, decks: [], guides: [] }` with 200 (the
    `serveManagementIndex` fallback shape at api.ts:958-971).
  - `serveGuideFile(config: Config, relPath: string, res: ServerResponse): Promise<void>`
    — resolves via `resolveGuidePath`; null → 404 JSON `{ error: 'not found' }`;
    otherwise 200 with the file bytes, `Content-Type` from `GUIDE_MIME` (fallback
    `application/octet-stream`), `Cache-Control: no-store`.
- Routes in `server/index.ts`: `if (u.pathname === '/api/guides')` next to the
  management exact-matches (anywhere above the `/api/sessions` prefix check at :263);
  and, immediately before the final `serveStatic` fallback at :269:
  `/guides/<rest>` — take `u.pathname.slice('/guides/'.length)`, run it through
  `decodePath` (null → the existing `badRequest`), pass to `serveGuideFile`. GET-only is
  implicit (no method guard, matching the other read routes).
- `vite.config.ts`: add `'/guides': { target: `http://localhost:${port}`, xfwd: true }`
  beside the `'/api'` proxy entry so the iframe works in dev.

- [ ] **Step 1: Write the failing tests** (handler-level, mock
  `ServerResponse` capturing `writeHead`/`end` — the `test/spawn-endpoint.test.ts`
  approach; build a config via `loadConfig({ envPath: '<tmpdir>/nonexistent.env' })`
  with `process.env.GUIDES_DIR` pointed at the Task-2 fixture, restored in `finally`):
  1. `loadConfig` with `GUIDES_DIR` unset → `config.guidesDir` ends with
     `docs/published-guides`; set to `'/tmp/x '` → trimmed `'/tmp/x'`.
  2. `serveGuidesIndex` against the fixture → status 200, body parses, `decks.length === 2`,
     `guides.length === 1`, `Cache-Control: no-store` header present.
  3. `serveGuideFile(config, 'tutor/a-deck.html', res)` → 200,
     `Content-Type: text/html; charset=utf-8`, body contains `tutor-deck`.
  4. `serveGuideFile(config, '../.env', res)` → 404 and the body contains no file
     content.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** config field, handlers, routes, proxy entry.
- [ ] **Step 4: Run**: `pnpm test`, `pnpm typecheck`. Then a live smoke:
  `pnpm dev` in background, `curl -s localhost:5174/api/guides | head -c 300` shows the
  two real decks, `curl -sI localhost:5174/guides/tutor/write-paths-deck.html` → 200
  text/html, `curl -s -o /dev/null -w '%{http_code}' 'localhost:5174/guides/..%2f.env'`
  → 400 or 404 (never 200). Kill the dev server.
- [ ] **Step 5: Commit**: `feat(guides): /api/guides index + guarded /guides static route`

### Task 5: Client — hook, list view, rail entry

**Files:**
- Create: `client/src/hooks/useGuides.ts`
- Create: `client/src/components/guides/GuidesView.tsx`
- Modify: `client/src/components/SideRail.tsx:1-8` (Section union + TABS)
- Modify: `client/src/App.tsx` (lazy import, render branch, `wide` list)
- Modify: `client/src/styles.css` (new classes, theme tokens only)

**Interfaces:**
- Consumes: `GuidesIndex` via `import type` from `shared/types.ts`.
- Produces: `useGuides(): { index: GuidesIndex | null; loading: boolean; error: boolean }`
  — fetch `/api/guides` once per mount, no polling (`useManagementIndex` at
  client/src/hooks/useManagement.ts:18-36 is the template, minus the refresh key);
  `GuidesView` default-less named export rendered from App.tsx.

Behaviour:
- `Section` becomes `'sessions' | 'management' | 'analytics' | 'guides' | 'settings'`;
  TABS order: Sessions, Management, Analytics, Guides, Settings. `wide` includes
  `'guides'`.
- List state: two groups. *Decks*: one tappable card per `DeckRef` — title,
  `sections.length` as "N sections" (omit when null), `generated` date, short commit
  (first 7 chars, omit when null). *Guides*: card per `GuideRef` — title or name.
  Loading → `guides-empty` div "loading…"; error → "guides unavailable"; both lists
  empty → "nothing published yet".
- Tapping a card sets viewer state `{ relPath, title }` (guides use
  `relPath + '/index.html'`); plain component state, not persisted, no deep link (spec
  non-goals).
- Viewer state is completed in Task 6; for this commit tapping may render the stub
  header + empty frame area.
- Settings: none — the tab needs no toggle (it is read-only and empty when the dir is).

- [ ] **Step 1: Type-first**: wire Section/TABS/App branches; `pnpm typecheck` must
  fail only where GuidesView doesn't exist yet, then create the files.
- [ ] **Step 2: Implement** hook + list rendering + CSS (reuse card/list token patterns
  already in styles.css; check `[data-theme]` block stays untouched).
- [ ] **Step 3: Verify**: `pnpm typecheck` green; `pnpm test` green (client tests that
  exist don't cover this — fine); `pnpm dev` smoke: Guides tab shows 2 deck cards +
  1+ guide cards (whatever `learning/` holds), light + dark theme spot-check.
- [ ] **Step 4: Commit**: `feat(guides): Guides rail section with deck/guide cards`

### Task 6: Client — iframe viewer

**Files:**
- Modify: `client/src/components/guides/GuidesView.tsx`
- Modify: `client/src/styles.css`

**Interfaces:**
- Consumes: viewer state from Task 5.
- Produces: the slot the ask-companion spec (`2026-08-22-guide-ask-design.md`, on hold)
  will mount into — keep the viewer header its own element (`guide-viewer-head`).

Behaviour:
- Viewer: slim header — back button (`‹ Guides`, returns to list state) + the item's
  title — above `<iframe src={'/guides/' + encodeURI(relPath)} title={title}>` that
  fills the remaining pane height (flex column, `flex: 1 1 auto`, `border: 0`,
  `width: 100%`). Same-origin, no `sandbox` attribute (the deck needs its own inline
  JS; it is our own generated file).
- The iframe keeps its own scroll; the surrounding pane must not double-scroll
  (`overflow: hidden` on the viewer container).
- Back returns to the list with state intact (index already fetched — no refetch).

- [ ] **Step 1: Implement** viewer + CSS.
- [ ] **Step 2: Verify**: `pnpm typecheck`, `pnpm test`; `pnpm dev` smoke — open both
  real decks, quiz taps work inside the iframe, Back works, keyboard arrows still
  drive the deck when the iframe has focus. Note in the PR that **iOS Safari
  iframe scrolling is unverified and needs a human phone pass** (known risk from the
  spec).
- [ ] **Step 3: Commit**: `feat(guides): same-origin deck viewer with back control`

### Task 7: Docs + final verification

**Files:**
- Create: `docs/subsystems/guides.md`
- Modify: `docs/overview.md` (add the subsystem row)
- Modify: `.claude/CLAUDE.md` (architecture tree: `lib/guides.ts`, `components/guides/`,
  `hooks/useGuides`, the `/guides/*` route line; one line each, house telegraphic style)

**Interfaces:** none — documentation of Tasks 1–6 exactly as built.

- [ ] **Step 1: Write** `docs/subsystems/guides.md`: what it serves, the two routes,
  the traversal guard being stricter than `serveStatic`'s and why, the
  scanner's skip rules (hub, guide-dir non-descent), `GUIDES_DIR`, the GitHub Pages
  dual-home relationship, and the reserved companion slot pointing at the on-hold spec.
  Follow the shape of an existing short subsystem doc (e.g. `permission-notify.md`).
- [ ] **Step 2: Full verification**: `pnpm test` (record the case count), `pnpm
  typecheck`, `pnpm build` (client compiles with the new chunk).
- [ ] **Step 3: Commit**: `docs(guides): subsystem doc + architecture map entries`
- [ ] **Step 4:** Use superpowers:requesting-code-review, then
  superpowers:finishing-a-development-branch. PR per
  `.github/pull_request_template.md` — include the explicit "not verified: iOS Safari
  iframe behavior; needs a human phone pass" line and real command output for the
  green claims.
