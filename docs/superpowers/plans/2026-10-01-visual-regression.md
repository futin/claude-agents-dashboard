# Visual Regression Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, exact values and exact test *cases*. It never gives literal implementation or test
> code. Write the code yourself from the requirements. If a requirement here looks wrong against the code in front of you, say so instead of transcribing it.
> The line-count budget is soft.

**Goal:** `pnpm test:visual` — a Playwright suite that screenshots every client view against committed macOS baselines with zero tolerance, plus overflow and
daylight-contrast checks, all fed by a browser-mocked API so the server never runs.

**Architecture:**
- `vite preview` serves a fresh `client/dist` on 4373. Every `/api` GET is answered inside the browser by `page.route` from fixtures typed against
  `shared/types.ts`. Google Fonts requests are answered from a vendored copy. Every other request fails the test.
- `stage()` seeds `localStorage['dashboard.settings']` / `dashboard.section`, pins the clock with `setFixedTime`, and waits on an explicit readiness predicate.
- Three specs: `mock-api.spec.ts` (the handler's refusals), `views.spec.ts` (61 shots), `layout.spec.ts` (40 overflow + 5 contrast cases). The pure
  known-contrast diffing lives in a plain module, unit-tested by the existing node-assert runner.

**Tech Stack:** `@playwright/test` (Chromium only), `@axe-core/playwright`, both root devDependencies. Vite preview. The repo's node-assert runner
(`test/run-all.ts`) for the one pure module.

**Spec:** `docs/superpowers/specs/2026-10-01-visual-regression-design.md`. Read it whole before starting any task; every task's requirements include it.
Section references (§n) point into it.

## Global Constraints

- `server/` is untouched: `git diff main -- server/` is empty at the end. `test/outbound.test.ts` is untouched and green.
- The two new packages go in root `devDependencies` only. No new runtime dependency anywhere. Ask the user before the Chromium download (roughly 150MB).
- No client source change. No test hook, `data-testid` or env flag is added under `client/src/`. A state not reachable through fixtures, localStorage and
  the URL is reported to the user, not worked around.
- Port **4373**, `--strictPort`. Never 4173 or 5174.
- Fixed instant **`EPOCH = 2026-09-30T14:00:00Z`** (a Wednesday afternoon, so hour-of-week charts have filled columns). `timezoneId: 'UTC'`,
  `locale: 'en-US'`. Every fixture timestamp is `EPOCH` minus an offset.
- Screenshot options everywhere: `fullPage: true`, `animations: 'disabled'`, `caret: 'hide'`, `maxDiffPixels: 0`, `threshold: 0`. Viewport height 900,
  `deviceScaleFactor: 1`, Chromium arg `--force-color-profile=srgb`.
- Baselines are macOS only. On any other `process.platform` the suite stops before running **or updating**, with exactly one line:
  `visual baselines exist for macOS only (platform: <platform>); run pnpm test:visual on a Mac`.
- Fixtures carry no real project names, paths, branch names, emails or account data. Invented values only.
- `pnpm test:visual` is not added to `pnpm test` and is not referenced from any orchestrate or execute skill.
- New prose (docs, comments) wraps at 160 columns. A figure measured off this machine carries its date inline.
- **Interaction with the Git Stats plan** (`docs/superpowers/plans/2026-10-01-git-stats.md`, not yet executed as of 2026-10-01): it renames Management to
  Claude Configs and adds a Management tab with new GET endpoints. The view list here is derived from `SECTIONS` (`client/src/lib/sections.ts:14`), so
  whichever plan lands second only regenerates the affected baselines and adds fixtures for the new endpoints. The suite's "no fixture" failure is what
  points to the latter. Neither plan blocks the other.

## Review Focus

1. **Stale `client/dist`.** Someone runs `npx playwright test` directly after editing CSS, skipping the build. Expected: the screenshots are of the edited
   CSS anyway, because the build is part of the `webServer` command, not a separate script step. Pinned in Task 1.
2. **`--update-snapshots` on Linux.** Expected: refused with the platform line before any file is written, so a Linux render can never overwrite a darwin
   baseline. Pinned in Task 1.
3. **Client-side filters hide fixture sessions.** `maxSessions` / `activeWindowMin` are server query params the pathname-matching mock ignores; what
   can hide a row in the browser is `dashboard.view` (`DEFAULT_VIEW`, `client/src/lib/filterSort.ts:134`). Expected: every fixture session renders as a
   card. Pinned in Task 2.
4. **Retina display, or a Mac in another time zone or region.** Expected: `devicePixelRatio` is 1 and the page's resolved time zone is `UTC` regardless of the
   host, so the same baseline matches on any Mac. Pinned in Task 2.
5. **Port 4373 already held** (a preview left over from an aborted run). Expected: the run fails fast with an error naming the port, and never screenshots
   whatever is listening there. Pinned in Task 1.

---

### Task 1: Playwright scaffold, mock API, refusals

**Files:**
- Modify: `package.json` (devDependencies, scripts), `.gitignore`, `tsconfig.json` (`include` gains `playwright.config.ts`), `test/run-all.ts`
- Create: `playwright.config.ts`, `test/visual/platform-guard.ts` (pure), `test/visual-platform-guard.test.ts` (node-assert), `test/visual/mock-api.ts`,
  `test/visual/harness.ts` (the shared Playwright fixture), `test/visual/fixtures/index.ts` (empty registry for now), `test/visual/mock-api.spec.ts`

**Why `vite.config.ts` is not modified:** `vite preview` inherits `server.open: true`, `host: true` and the `/api` proxy from it (`vite.config.ts:75-91`).
The `webServer` overrides the first two: `--host localhost` on the command line, and `env: { BROWSER: 'none' }`, which Vite's browser opener honours. The `/api` proxy is never reached, because every
`/api` request is answered in the browser before it leaves. Step 6 verifies that no browser window opens and that the preview listens on localhost only.

**Interfaces:**
- Produces:
  - `installMockApi(page: Page, fixtures: FixtureMap): Promise<void>` from `test/visual/mock-api.ts`.
  - `FixtureMap` = a map from **pathname pattern** to a response body. Patterns are exact pathnames (`/api/sessions`) or carry one `:param` segment
    (`/api/sessions/:id/chat`). Exact patterns win over param patterns.
  - `mockApiFailures(page: Page): string[]`, the refusals recorded so far, each formatted `GET /api/nope: no fixture` or `POST /api/pins: writes are refused`
    or `GET https://example.com/x: off-origin request refused`.
  - `test` and `expect` from `test/visual/harness.ts`: Playwright's `test` extended with an automatic `afterEach` that fails the case when
    `mockApiFailures(page)` is non-empty, listing every entry. Every spec except `mock-api.spec.ts` imports `test` from here.
  - `platformRefusal(platform: string): string | null` from `test/visual/platform-guard.ts`: `null` for `'darwin'`, otherwise the exact Global
    Constraints line with `<platform>` filled in. The config calls it with `process.platform`; no env override exists.
  - Scripts: `test:visual` = `playwright test`, `test:visual:report` = `playwright show-report`. `--update-snapshots` passes through as
    `pnpm test:visual -- --update-snapshots`.

**Requirements:**
- `playwright.config.ts`:
  - `testDir: test/visual`, `testMatch: *.spec.ts`, one worker, Chromium project only, `use` carrying the Global Constraints values (viewport, scale,
    tz, locale, launch arg) and `baseURL: 'http://localhost:4373'`, so relative navigation works.
  - `snapshotPathTemplate` resolving to `test/visual/__screenshots__/{arg}{ext}`. No `{platform}` segment: the platform guard is what keeps it
    darwin-only.
  - `expect.toHaveScreenshot` defaults set to the Global Constraints values.
  - `webServer.command` runs `vite build` then `vite preview --port 4373 --strictPort --host localhost` with `env: { BROWSER: 'none' }`. `reuseExistingServer: false`,
    `url` on 4373.
- The config calls `platformRefusal(process.platform)` at load, before Playwright starts anything (so before any `--update-snapshots` write). On a
  non-null result it prints the line and exits nonzero.
- `mock-api` behaviour:
  - Route `**/*`. Match by `new URL(req.url).pathname`, ignoring the query.
  - **GET `/api/*` with a fixture:** 200 with the fixture as JSON.
  - **GET `/api/*` with no fixture:** answer 404, record the failure.
  - **Any non-GET to `/api/*`:** answer 405, record the failure.
  - **`fonts.googleapis.com` / `fonts.gstatic.com`:** left unhandled in this task (Task 2 adds them). Until then they count as off-origin.
  - **Same-origin non-`/api` requests** (the built assets): continue to the network, i.e. the preview server.
  - **Any other origin:** abort the request, record the failure.
- `.gitignore` gains `test-results/` and `playwright-report/`.

- [ ] **Step 1: Ask the user** for the Chromium download, naming the package and the roughly 150MB size. Then install the two dev dependencies and the
  browser.
- [ ] **Step 2: Scaffold, then write the failing tests.**
  - **Scaffold first:** `playwright.config.ts`, `platform-guard.ts` and the scripts. Without a config, Playwright's default `testMatch` would collect the
    repo's ~80 node-assert `test/*.test.ts` files and the plugin's `node:test` suites.
  - **Unit tests** in `test/visual-platform-guard.test.ts` (RF2), registered in `test/run-all.ts`:
    - `platformRefusal('darwin')` is `null`
    - `platformRefusal('linux')` is exactly `visual baselines exist for macOS only (platform: linux); run pnpm test:visual on a Mac`
    - `platformRefusal('win32')` is the same line with `win32`
  - **`mock-api.spec.ts`:**
    - Setup: each case calls `installMockApi` with only the fixtures the case names. Then, in the spec itself (not in `mock-api`), it registers its own
      route answering `/__blank` with an empty HTML document. Playwright tries the last-registered route first, so this one wins. Then it navigates to
      `/__blank`.
    - Why: the app never loads, so its own requests add no noise, and the failure list holds only what the case caused. Assertions read
      `mockApiFailures(page)`, not console text.
    - This deliberately differs from spec §9.3's "from a staged page". A staged page would mix the app's own requests into the list being asserted.
  - Cases:
  - in-page `fetch('/api/nope')` → status 404 and failures deep-equal `['GET /api/nope: no fixture']`
  - in-page `fetch('/api/pins', { method: 'POST', body: '{}' })` → status 405 and failures contain `POST /api/pins: writes are refused`
  - in-page `fetch('/api/sessions?maxSessions=5')` with a fixture registered for `/api/sessions` → 200 and the body deep-equals the fixture (the query is
    ignored)
  - with fixtures for both `/api/sessions/:id/chat` and `/api/sessions/abc/chat`, a fetch of `/api/sessions/abc/chat` gets the exact one's body
  - in-page `fetch('https://example.com/x')` rejects, and failures contain `GET https://example.com/x: off-origin request refused`
  - This spec opts out of the shared fail-on-failures `afterEach`, since recording failures is what it tests.
- [ ] **Step 3: Run `pnpm test` and `pnpm test:visual`.** Expect: the guard cases fail until the guard returns the line, and the spec fails because
  `installMockApi` is not importable.
- [ ] **Step 4: Implement** the guard, `mock-api.ts` and `harness.ts`.
- [ ] **Step 5: Run both.** `pnpm test` is green with 3 more cases, and `pnpm test:visual` passes all 5 cases.
- [ ] **Step 6: Prove the remaining Review Focus items by hand** and paste the output into the task report:
  - **RF1:** add a visible `outline:5px solid red` to `body` in `styles.css` and run without building first. A throwaway screenshot shows the outline.
    Revert.
  - **RF5:** hold 4373 with `python3 -m http.server 4373` (record its pid, kill **that pid** after). The run fails naming 4373.
  - **Preview flags:** during a run, no browser window opens, and `lsof -nP -iTCP:4373 -sTCP:LISTEN` shows only a loopback address.
- [ ] **Step 7: Run `pnpm test && pnpm typecheck`.** Both green and the `pnpm test` case count is unchanged.
- [ ] **Step 8: Commit** `test(visual): Playwright scaffold and mock API`.

### Task 2: Fixtures, fonts, stage

**Files:**
- Create: `test/visual/fixtures/epoch.ts`, one fixture module per GET endpoint below, `test/visual/fonts/` (vendored files + a short `README.md`
  naming the source URL, the licence (OFL) and the fetch date), `test/visual/stage.ts`, `test/visual/stage.spec.ts`
- Modify: `test/visual/fixtures/index.ts`, `test/visual/mock-api.ts` (font routes)

**Interfaces:**
- Consumes: `installMockApi`, `FixtureMap`, `mockApiFailures` (Task 1).
- Produces:
  - `EPOCH: number` (ms) and `ago(ms: number): number` from `fixtures/epoch.ts`.
  - `fixtures: FixtureMap` from `fixtures/index.ts`.
  - `FIXTURE_SESSION_ID: string`, the id the chat-drawer shot deep-links to. It is a **lowercase UUID**: `deepLinkSession` accepts only
    `/^[0-9a-fA-F-]{8,64}$/` (`client/src/lib/deepLink.ts:19`) and silently drops anything else. Every fixture session id is a UUID for the same reason.
  - `stage(page: Page, opts: StageOpts): Promise<void>`, where `StageOpts` = `{ section: Section; theme: ThemeId; width: number; contentWidth: 'fixed' | 'full';
    query?: string }`. `Section` comes from `client/src/lib/sections.ts`, `ThemeId` from `client/src/lib/settings.ts:35`, both as `import type`.
  - `isReady(page): Promise<boolean>`, exported so `stage.spec.ts` can assert it.

**Fixture endpoints:** every GET in `client/src/hooks/*.ts`, re-derived from source at the start of the task (`grep -n "fetch(" client/src/hooks`).
As of 2026-10-01 the list is:
- `/api/sessions` and `/api/sessions/:id`;
- `/api/sessions/:id/chat`, `/api/sessions/:id/plan`, `/api/sessions/:id/message`, `/api/sessions/:id/question`;
- `/api/account`, `/api/management`, `/api/management/project`, `/api/management/file`;
- `/api/usage/profile`, `/api/usage/rates`, `/api/settings`, `/api/analytics`, `/api/health`, `/api/pins`.

Each body is typed with its `shared/types.ts` response type (`SessionsResponse`, `AccountResponse`, `UsageProfileResponse`, `UsageRatesResponse`,
`AnalyticsResponse`, `HealthResponse`, `PinsResponse`, and the management, chat and pending types the hooks name). The pending-plan, message and question
fixtures are the "nothing pending" shape. `/api/settings` carries only what `useServerSettings` reads.

**Fixture content:** 4 sessions, all with activity inside the default active window at `EPOCH`.
- Statuses: one each of `working`, `idle`, `question` and `incomplete` (`shared/types.ts:63`), across 2 invented projects.
- Their models and context usage are spread so the context bars show distinct fills.
- Usage and analytics carry enough history across the week before `EPOCH` that charts are not empty.

**Requirements:**
- **Fonts:** fetch the Google Fonts CSS for the exact URL in `client/index.html:19` once, with a Chrome user agent so it serves woff2, plus every woff2 it
  references. Store them under `fonts/` and point the stored CSS's `url()`s at stable paths that `mock-api` serves. `mock-api` answers
  `fonts.googleapis.com/css2*` with the stored CSS and `fonts.gstatic.com/*` with the matching file. A font path with no stored file is an off-origin failure.
- **`stage`**, in this order:
  1. installs the mock API;
  2. calls `page.clock.setFixedTime(EPOCH)`;
  3. adds an init script that writes `dashboard.settings` and `dashboard.section` before any page script runs. Both are **JSON-encoded**, because
     `usePersistedState` JSON-parses (`client/src/hooks/usePersistedState.ts:15`), so the section is stored as `"usage"` with the quotes;
  4. sets the viewport to `{ width, height: 900 }`;
  5. navigates to `/` plus `query`;
  6. waits until `isReady`.
- **The seeded settings object** sets every field the spec names (§3), explicitly:
  - `theme` and `contentWidth` from opts;
  - `fontScale: 100`, `density: 'comfortable'`, `maxSessions: 5`, `notifyBrowser: false`;
  - `landing` equal to `section`, `usageTab: 'forecast'`, `settingsTab: 'local'`;
  - `defaultLayout: 'board'`, because the default `'last'` defers to `dashboard.layout` (`client/src/components/SessionsView.tsx:50-51`), and
    `chatFullText: false`.
  - Field names come from `client/src/lib/settings.ts`. If a name differs, the code wins and you report the difference. Spec §3's list omits the last two;
    "every field a shot depends on" is the rule they fall under.
- **`isReady` is all of:**
  - `document.fonts.ready` resolved;
  - some entry of `document.fonts` has `family` `Hanken Grotesk` (quotes stripped) and `status === 'loaded'`. `document.fonts.check(...)` is not used: it
    returns `true` when no `@font-face` matches at all, so it would pass with the font missing;
  - every `/api` request issued so far has been answered;
  - no element whose own text node, trimmed, matches `/^loading/i`.
- Poll it with Playwright's `expect.poll` (5s timeout). Never a fixed sleep.

- [ ] **Step 1: Write the failing tests** in `stage.spec.ts`, staging Sessions / daylight / 1280 / `fixed` unless a case says otherwise:
  - `document.documentElement.dataset.theme === 'daylight'`
  - the computed `--font-scale` on `.shell` resolves to `1`
  - `Date.now() === EPOCH` and `new Date().toISOString() === '2026-09-30T14:00:00.000Z'`
  - `Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC'` and `window.devicePixelRatio === 1` (RF4)
  - a `document.fonts` entry for `Hanken Grotesk` has `status === 'loaded'`. This case must fail before the fonts are vendored: run it once with the
    font routes removed to see it fail.
  - the number of session cards rendered equals the fixture's session count, 4 (RF3); find cards by the class the board uses, read from the component
  - `mockApiFailures(page)` is empty
  - staged with `theme: 'midnight'`, `dataset.theme === 'midnight'`, proving the seed and not the default decides
  - staged with `query: '?session=' + FIXTURE_SESSION_ID`, the chat drawer is open and shows the fixture's first message text
  - for each `SECTIONS` entry, staging that section yields `isReady` true, no failures, and the side rail's active item is that section's label. One case
    per section, so a missing fixture names its view and a mis-encoded `dashboard.section` cannot pass by landing on the default.
- [ ] **Step 2: Run `pnpm test:visual`.** Expect: the new cases fail.
- [ ] **Step 3: Implement** the fixtures, font vendoring and routes, and `stage`. If a view needs an endpoint the list above lacks, add the fixture; the
  per-section case tells you which.
- [ ] **Step 4: Run `pnpm test:visual` twice.** All cases green both times.
- [ ] **Step 5: Run `pnpm typecheck`.** Green. This proves every fixture matches its `shared/types.ts` type.
- [ ] **Step 6: Commit** `test(visual): typed fixtures, vendored font, stage`.

### Task 3: Screenshot matrix and baselines

**Files:**
- Create: `test/visual/views.spec.ts`, `test/visual/__screenshots__/*.png` (generated)

**Interfaces:**
- Consumes: `stage`, `StageOpts`, `FIXTURE_SESSION_ID` (Task 2), `SECTIONS` (`client/src/lib/sections.ts`).

**Requirements:**
- The cases come from one table built from `SECTIONS` × §4's rows:
  - 6 widths `375, 640, 768, 1024, 1280, 1536` in daylight, `fixed`;
  - 2 widths `1537, 1921` in daylight, `full`;
  - 4 themes `midnight, amber, graphite, nightshift` at 1280, `fixed`;
  - plus one `sessions · daylight · 1280 · detail` case staged with `?session=<FIXTURE_SESSION_ID>`.
- Total 12 × 5 + 1 = **61**. The spec asserts that count, so a changed `SECTIONS` fails loudly until the table is reconsidered.
- The test title and snapshot name are `<section> · <theme> · <width> · shot`, or `· detail` for the drawer case, matching §7. The file name is the same
  string with ` · ` → `-`.
- Every case ends with `mockApiFailures(page)` empty, via the shared `afterEach`.

- [ ] **Step 1: Write the spec.** Run `pnpm test:visual`. Expect: 61 failures for "missing snapshot", which Playwright writes on first run.
- [ ] **Step 2: Run `pnpm test:visual` again.** All 61 pass against the snapshots just written.
- [ ] **Step 3: Determinism (§1, §9.1).** Run `pnpm test:visual` twice more back to back, no change between. Both fully green. If any shot flakes, find the
  unfrozen state and fix it in `stage` or a fixture. Never add a tolerance.
- [ ] **Step 4: Mutation proof (§9.2), each reverted after, paste the failing case names:**
  - Change one daylight token by one unit in one RGB channel. Expect: daylight shots of every view using that token fail, and no dark-theme shot does.
  - Add `margin-left:1px` to one class used in several views. Expect: shots of exactly those views fail.
- [ ] **Step 5: Hand the first baseline set to the user.** Open `pnpm test:visual:report` on a forced run (or list the PNGs), and ask the user to skim them
  once before committing. The spec's "not verifiable by the implementing session" line. Commit only after they answer.
- [ ] **Step 6: Commit** `test(visual): 61-shot matrix with darwin baselines`. Report the total PNG size (`du -sh test/visual/__screenshots__`) with its
  date.

### Task 4: Overflow and daylight contrast

**Files:**
- Create: `test/visual/contrast-known.ts` (pure), `test/visual-contrast-known.test.ts` (node-assert), `test/visual/layout.spec.ts`,
  `test/visual/contrast-known.json` (generated)
- Modify: `test/run-all.ts` (register the new unit test the way the others are registered)

**Interfaces:**
- Consumes: `stage` (Task 2), `SECTIONS`.
- Produces, from `contrast-known.ts`:
  - `ContrastEntry` = `{ view: string; text: string; fg: string; bg: string; ratio: number; required: number; selector: string }`.
  - `contrastKey(e): string` = `` `${view}|${text}|${fg}|${bg}` ``, where:
    - `text` is trimmed with internal whitespace runs collapsed to one space;
    - `fg` and `bg` are lowercased exactly as axe reports them, keeping an alpha suffix (`#rrggbbaa`) when present, never stripped.
    - `selector`, `ratio` and `required` are **not** part of the key.
  - `diffContrast(known: ContrastEntry[], found: ContrastEntry[]): { added: ContrastEntry[]; fixed: ContrastEntry[] }`. `added` = found whose key is not in
    known; `fixed` = known whose key is not in found. Duplicate keys within `found` collapse to the first occurrence.

**Requirements:**
- **Overflow:** for each section × each of the 8 widths, in the width's §4 mode, assert `document.documentElement.scrollWidth <= window.innerWidth`.
  - The failure message names the section, the width and both numbers.
  - Title format `<section> · daylight · <width> · overflow`.
  - 40 cases, no allowlist.
- **Contrast:** for each section, daylight / 1280 / `fixed`, run axe with only `color-contrast`.
  - Map each violation node to a `ContrastEntry`. Take `fg`, `bg`, `ratio` and `required` from the node's check data (`fgColor`, `bgColor`,
    `contrastRatio`, `expectedContrastRatio`), `text` from the element's text, `selector` from the node's target.
  - Read `contrast-known.json` (an array of `ContrastEntry`).
  - **File absent:** write it with every section's entries, sorted by key, 2-space JSON, then pass.
  - **File present:** fail on any `added`, listing view, text, selector, fg, bg, ratio and required. Print `fixed` entries as
    `contrast fixed: <key>` and pass.
  - Print the per-section count of axe `incomplete` results. They never fail the run.
  - Title format `<section> · daylight · 1280 · contrast`.

- [ ] **Step 1: Write the failing unit tests** in `test/visual-contrast-known.test.ts`:
  - `contrastKey` of `{ view: 'usage', text: '  3 m\n ago ', fg: '#9A9A9A', bg: '#F4F4F4', … }` is `usage|3 m ago|#9a9a9a|#f4f4f4`
  - two entries that differ only in `selector` give the same key
  - `diffContrast([], [a])` → `{ added: [a], fixed: [] }`
  - `diffContrast([a], [])` → `{ added: [], fixed: [a] }`
  - `diffContrast([a], [a'])`, where `a'` is `a` with a different selector and ratio → `{ added: [], fixed: [] }` (the migration renames classes; this case
    is the point of the keying)
  - `diffContrast([], [a, a])` → `added` has length 1
  - `diffContrast([a, b], [b, c])` → `added: [c]`, `fixed: [a]`
- [ ] **Step 2: Run `pnpm test`.** Expect: the new cases fail, since the module does not exist yet.
- [ ] **Step 3: Implement** `contrast-known.ts`. Run `pnpm test`: green, and the case count rises by 7.
- [ ] **Step 4: Write `layout.spec.ts`.** Delete any `contrast-known.json`, run `pnpm test:visual`, and expect it to be written and the run to pass. Run
  again: pass, with nothing printed as fixed.
- [ ] **Step 5: Mutation proof (§9.2), each reverted after, paste the output:**
  - Give one element on the Usage view `width:120vw`. Expect: the overflow cases for Usage fail at every width, naming the numbers.
  - Lower one daylight text token until it drops below 4.5:1. Expect: contrast cases fail listing that text and selector.
  - Rename one class that carries a known violation, in both the CSS and the component. Expect: the contrast cases still pass. This proves the keying
    survives the migration.
- [ ] **Step 6: Commit** `test(visual): overflow and daylight contrast checks`.

### Task 5: Docs and final verification

**Files:**
- Create: `docs/subsystems/visual-tests.md`
- Modify: `docs/overview.md` (§Map line), `.claude/CLAUDE.md` (§Commands line), `docs/.docs-sync.yml` (one `path:` entry, `kind: subsystem`, same shape
  as its siblings)

**Requirements:**
- `visual-tests.md` covers:
  - what the suite covers (the §4 table and the count);
  - how data is mocked and why the server never runs (§2, short);
  - the readiness predicate;
  - how to re-baseline, and that a re-baseline is always deliberate;
  - the macOS-only rule and its exact message;
  - how to add a view, a data state (fixture variant or seeded settings key) or an endpoint fixture;
  - how `contrast-known.json` grows and shrinks, and that a run right after deleting it proves nothing about contrast (it only re-records);
  - that dark-theme contrast is off until those themes are redesigned.
- The doc ends with a docs-sync stamp block like `docs/subsystems/breakpoints.md`'s. Its sources are the files under `test/visual/` that the doc describes
  plus `playwright.config.ts`, and `verified:` is `git rev-parse HEAD` at writing time (the commit the doc was checked against, per docs-sync).
- The overview line follows its neighbours' one-line form. The CLAUDE.md line sits next to `pnpm test:skills` and says the suite is on demand, macOS only,
  and not part of `pnpm test`.

- [ ] **Step 1: Write the docs.** Run `pnpm test`; the docs-links test stays green.
- [ ] **Step 2: Final verification (§9), pasting each output:**
  - `pnpm test:visual` green twice in a row;
  - `pnpm test` green with its case count;
  - `pnpm typecheck` green;
  - `git diff main -- server/ test/outbound.test.ts client/src/` prints nothing.
- [ ] **Step 3: Commit** `docs(visual): visual-tests subsystem doc`.

## Final whole-branch review and PR

- One whole-branch review against the spec and this plan, using the reviewer contract from `.claude/CLAUDE.md` §Subagent rules, pasted verbatim into the
  dispatch.
- PR per `.github/pull_request_template.md`:
  - title `test(visual): screenshot regression suite`;
  - group *What changed* by Test / Docs / Config;
  - *Verification* carries the outputs from Tasks 3–5;
  - the "not verified, needs a human" line names the baseline skim from Task 3 Step 5 and that no other Mac has run the suite.
