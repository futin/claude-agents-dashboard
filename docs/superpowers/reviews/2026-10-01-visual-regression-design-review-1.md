# Review 1 — `2026-10-01-visual-regression-design.md`

Reviewer: Fable 5.1, 2026-10-01. Read-only. Checked against the repo at `aee3cbc`. Playwright claims were checked against the `playwright-core` /
`playwright` 1.63.0 type declarations cached under `~/.npm/_npx/e41f203b7505f1fb/node_modules/` (the repo has no Playwright installed yet).

## Verdict: REVISE

Two Critical: the spec puts theme / content width / font scale / landing into the `/api/settings` fixture, but all four live in
`localStorage['dashboard.settings']` and the server settings endpoint carries none of them, so every shot would render the default `midnight` theme; and
the "no network font fetch" premise is false — the UI face is Hanken Grotesk loaded from Google Fonts, the `@fontsource` packages the spec names are
imported but unused by `styles.css`. Five Important findings are determinism rules an implementer would get wrong following the text as written (clock
install vs pause, Playwright's default `threshold`, the undefined "loading indicator", the unreachable detail shot, the contrast allowlist keyed on
selectors that the consuming migration renames).

## Verified true (no finding)

- `styles.css` is 2596 lines / 586 distinct class selectors / 19 `@keyframes` + `animation:` rules (L3, L116) — recounted 2026-10-01.
- Only `test/breakpoints.test.ts` and `test/chat-pinned-pad.test.ts` read `styles.css` as text (L5); `test/split-plan.test.ts` merely has the string in a
  literal. 35 of 94 test files use a tmpdir (L32).
- `readToken()` is `server/lib/usage.ts:78`; order is env var → macOS keychain (L89-101) → `~/.claude/.credentials.json` (L104). The keychain prompt is
  documented at L74. §2 bullet 1 holds.
- `scanSessions` compares `now` against `mtimeMs` (`server/lib/scan.ts:510,531`). See M1 for the seam that already exists.
- The GET list at L70-71 matches a fresh grep of `client/src`: `sessions`, `sessions/:id`, `/chat`, `/question`, `/message`, `/plan`, `health`,
  `management`, `management/project`, `management/file`, `account`, `settings`, `pins`, `usage/rates`, `usage/profile`, `analytics`. `remote-answer`,
  `spawn`, `transcribe`, `notify/test`, `stop`, `*-answer` are POST only, and none fires on mount.
- `useSettings.tsx:66` is `root.dataset.theme = settings.theme` (L77); `index.html:26-33` stamps the same attributes pre-paint from
  `localStorage['dashboard.settings']`.
- `dashboard.section` is read at `client/src/App.tsx:35`; `landing === 'last'` defers to it (`App.tsx:46`).
- Five themes: `daylight`, `midnight`, `amber`, `graphite`, `nightshift` (`styles.css`, `lib/settings.ts:29-32`). Default theme is `midnight`
  (`lib/settings.ts:127`). `refreshMs` default 3000 (`lib/settings.ts:130`); `useSessions.ts:41` is a plain `setInterval(poll, refreshMs)` after an
  immediate `poll()`.
- Tier `min-width`s 640/768/1024/1280/1536/1537/1921 and the full-only `3xl`/`4xl` rule: `docs/subsystems/breakpoints.md` tier table and §Content width.
- Arithmetic: 6+2+4 = 12 per view, ×5 = 60, +1 = 61 (L100); 4 themes × 5 views = 20 (L147); 5 views × 8 widths = 40 (L129).
- Git Stats spec exists and renames Management → Claude Configs (`2026-10-01-git-stats-design.md:4,12`) (L105).
- `tsconfig.json` includes `test`, so fixtures under `test/visual/` are typechecked by `pnpm typecheck` (L45-46). `pnpm test` runs an explicit import list
  (`test/run-all.ts`), so new files under `test/visual/` cannot leak into it (L13).
- `test/outbound.test.ts` scans `server/` only; root devDependencies do not trip it (L24, L87).
- `Notification.permission` is read in `hooks/useWebNotify.ts:31,41` only (L121).
- `docs/overview.md` has a `## Map` section (L299) (L163).

## Critical

### C1 — Theme, content width, font scale and landing are not in the `/api/settings` fixture (L76-78, L103, L66)

Spec L76-78: "The settings fixture is parameterised by theme and content-width mode, because `useSettings` applies `settings.theme` to
`root.dataset.theme`"; L103: "font scale 1 (from the settings fixture)"; L77-78: "the settings fixture's landing value". The `useSettings` cited is the
**client** settings hook, whose store is `localStorage['dashboard.settings']` (`client/src/lib/settings.ts:4`, `client/src/hooks/useSettings.tsx:53-57`;
`index.html:27` reads the same key before paint). `GET /api/settings` is a different object — `useServerSettings` checks it for `idleSecs`
(`client/src/hooks/useServerSettings.ts:56`) and it carries no theme, width, scale or landing. Built as written, no fixture variant changes the theme, every
one of the 61 shots renders `midnight` (the default at `lib/settings.ts:127`), the 2 wide shots stay in `fixed` width, and the §9.2 daylight-token
mutation never fails anything.

→ Move the parameterisation to `stage`'s localStorage step: seed `dashboard.settings` with `{ theme, contentWidth: 'fixed' | 'full', fontScale: 100,
landing: 'last', refreshMs: 3000 }` before navigation (via `addInitScript` or `storageState`), alongside `dashboard.section`. Drop "settings fixture
variant" from the `stage` responsibilities at L66 and L76; the `/api/settings` fixture needs exactly one variant.

### C2 — The UI font is fetched from Google Fonts; the `@fontsource` packages are unused (L117)

Spec L117: "Fonts are already self-hosted through `@fontsource`, so no network font fetch exists." `client/index.html:17-19` preconnects to and loads
`https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap`, and `styles.css:35` sets `--font:'Hanken Grotesk','Plus
Jakarta Sans',-apple-system,…`. The `@fontsource/barlow`, `barlow-condensed`, `ibm-plex-mono` imports in `client/src/main.tsx:5-10` are not referenced
anywhere in `styles.css` (0 matches for `Barlow` / `Plex`). So every shot depends on the network: offline (or a blocked host, or a slow response that lands
after `document.fonts.ready` resolves — `display=swap` guarantees the first paint does not wait) renders the platform fallback and shifts every glyph. §1's
"two back-to-back runs green" can hold on one machine state and fail on the next, and the fallback also perturbs the contrast measurements in §6.

→ Either (a) the mock layer intercepts `fonts.googleapis.com` / `fonts.gstatic.com` and fulfils them from a vendored copy committed under
`test/visual/fixtures/fonts/` (deterministic, no client change), or (b) self-host Hanken Grotesk through `@fontsource/hanken-grotesk` and remove the
`<link>`s — a product change, not a test seam, but it would also honour the "offline tailnet load" comment in `index.html:13-15`. State which, and fix the
L117 sentence. Readiness (L114) must then wait for the specific face: `document.fonts.check("400 16px 'Hanken Grotesk'")` true for each weight used, not
just `fonts.ready`.

## Important

### I1 — `page.clock.install()` does not freeze time; the poll keeps firing (L112-113)

Spec L112: "installed at the fixture epoch before navigation. With time frozen, the 3s poll does not fire again." In Playwright `install()` only swaps in
fake implementations and the fake clock keeps ticking with real time; "no timers are fired" is the contract of `pauseAt()` (`playwright-core/types/
types.d.ts:20494-20498`, and the recommended sequence at L20511-20520: install → goto → pauseAt). Following the spec literally, `setInterval(poll,
3000)` (`useSessions.ts:41`) keeps firing and a shot taken after 3s re-fetches and repaints mid-capture. Pausing *before* load is the other failure
mode the docs warn about: `requestAnimationFrame` and `setTimeout` are faked too, and `useStuckStrip.ts:47` (rAF) and `backClose.ts:87` (`setTimeout 0`)
would never run.

→ Specify: `clock.install({ time: EPOCH })` before `goto`, then once the §5 ready predicate holds, `clock.pauseAt(EPOCH)` (same instant, so relative text
reads the same), then one `clock.runFor(0)`-style flush so pending rAF callbacks settle, then screenshot. Add a note that axe-core (§6) runs *after* the
pause and must be checked for not depending on faked timers; if it stalls, run axe before pausing.

### I2 — `maxDiffPixels: 0` alone is not zero-pixel strictness (L118, L158)

Spec L118: "`maxDiffPixels: 0`. The suite exists to prove zero diff." Playwright's comparator also has a per-pixel `threshold`, "ranging from `0` (strict)
and `1` (lax)", default `0.2` in YIQ space (`playwright/types/test.d.ts:199-201`). With the default, a pixel whose colour moved less than that distance
does not count as different, so a small daylight token change (the §9.2 first mutation, e.g. `#f4f4f3` → `#f6f6f5`) passes with `maxDiffPixels: 0`.

→ State `threshold: 0` alongside `maxDiffPixels: 0` in the `toHaveScreenshot` config, and make the §9.2 token mutation an explicitly small one so the proof
covers this.

### I3 — "No loading indicator in the DOM" is undefined (L114)

The client has no single indicator. The forms today: `<div class="mgmt-empty">loading…</div>` / `<div class="an-empty">loading…</div>` Suspense
fallbacks (`App.tsx:99-111`), `loading config…` (`ManagementView.tsx:81`), `Loading agents…` (`SessionDetail.tsx:46`), `Loading chat…`
(`ChatDrawer.tsx:267`), `Loading…` (`PinnedProjectsGroup.tsx:21`), and `EmptyState loading={shown === null}` (`SessionsView.tsx:123`). `.mgmt-empty` /
`.an-empty` are also the *empty-state* classes, so "class absent" is wrong, and the text casing is inconsistent, so an exact-text match misses half.

→ Define the predicate: no element whose own text matches `/^loading/i` (covers all six), plus the request-tracking rule already at L114. Say that a new
indicator form not matching this is a finding against the client copy, consistent with the L79 rule.

### I4 — The Sessions detail shot is unreachable through fixtures and localStorage (L100, L66, L79)

Spec L100 adds "one Sessions shot … with a session's detail open", while L66 limits `stage` to clock, viewport, localStorage, fixture variant and
readiness, and L79 says an unreachable state "is a finding to raise, not a seam to add". Detail state is deliberately not persisted: `expanded` (board /
list / tiles rows drawn open) and `splitId` (split layout's inspected session) are plain `useState` (`SessionsView.tsx:67-68`, comment at L62-66). The only
seeded selection is `?session=` → the chat drawer (`SessionsView.tsx:70`, `App.tsx:44`), which is a different surface. "Detail" is also ambiguous between
the expanded row (`SessionDetail`, fetches `/api/sessions/:id`), the split pane, and the chat drawer.

→ Name the surface (recommend: default board layout, first session's row expanded, which renders `SessionDetail` and exercises the `sessions/:id`
fixture), and allow `stage` one scripted click on a named control to reach it, with readiness re-evaluated after the click. If the chat drawer is meant, say
`?session=<fixture id>` and add the `/chat` fixture to the shot's required routes.

### I5 — `contrast-known.json` keyed by selector breaks on the refactor it serves (L132-134, L146)

Spec L132: known violations are "keyed by view and selector". axe's `target` selectors are class-based (`.card > .kicker` …). §8 L146 says the CSS Modules
migration is the consumer, and that migration renames classes — so each step re-keys every known violation, every known entry reports "fixed" and every
still-present one fails as "new". The check goes red on exactly the green refactors it exists to accept.

→ Key entries on something the migration does not move: the view plus the element's trimmed text content plus the measured fg/bg pair (or the ratio
rounded to 2 dp). Also state the two unaddressed outcomes: axe returns `color-contrast` results as `incomplete` (gradient / image backgrounds, overlapped
text) as well as `violations` — say whether `incomplete` is ignored or recorded; and say what a run does when the file is absent (write it and pass is
implied by "the first run writes" — make it explicit, since §9.2's fourth mutation depends on the file existing).

## Minor

- M1 (L40-42): `scanSessions` already takes `options.now` (`server/lib/scan.ts:510`); the HTTP handler just does not pass it (`server/api.ts:143-150`). The
  decision stands on the keychain argument; soften "needs test-only seams inside `server/`" to "needs a way to inject `now` through the HTTP layer".
- M2 (L94-98): the content-width values are `'fixed' | 'full'` (`lib/settings.ts:67`); the table says "default". Name `fixed` so the fixture author does not
  invent `capped` or `default`.
- M3 (L128): the overflow check at 1537 / 1921 — which content-width mode? §4 shoots those two in `full`; say the layout spec uses the same pairing, or
  both modes (then it is 50 cases, not 40).
- M4 (L51): `vite preview`'s default port is 4173, which is also `pnpm start`'s default API `PORT` (`vite.config.ts:12`, `package.json:14`). "A port of
  its own" is right; name one (and keep it out of 5174 / 4173) so a running dev or prod server cannot answer the suite's requests.
- M5 (L141): `view · theme · width` does not name the §4 detail shot or the §6 layout cases; add a fourth segment (`detail`, `overflow`, `contrast`).
- M6 (L121-122): under Playwright's auto-deny, `Notification.permission` is `'denied'` on every run, so the Settings baseline records the "blocked" copy from
  `useWebNotify.ts:31`. Deterministic, but worth one sentence so a human skimming the first report (L166) does not read it as a bug.
- M7 (L5-10 of `main.tsx`, outside the spec): the three `@fontsource` packages are dead weight in the bundle given C2. Out of this spec's scope; a backlog
  item, not a spec change.
- M8 (L87): "~150MB" Chromium download is undated and uncounted; fine as an estimate, but the repo rule dates measured figures — either date it or say
  "roughly".
- M9 (L59): Playwright's default snapshot path is `<spec>-snapshots/<name>-darwin.png`; getting `__screenshots__/` needs `snapshotPathTemplate`. One clause
  in §3 saves the implementer a guess.
