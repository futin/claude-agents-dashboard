# Visual regression tests — design

Give the client a screenshot suite that proves a pure-CSS refactor changed **zero pixels**, so the incremental CSS Modules migration (`styles.css`: 2596
lines, 586 classes, measured 2026-10-01) can move classes with evidence instead of eyeballing five themes at seven breakpoints. Today nothing renders the UI
in any test: `pnpm test` is node-assert over domain logic, and the two tests that touch `styles.css` (`breakpoints.test.ts`, `chat-pinned-pad.test.ts`) read
it as text.

Brainstormed in-session 2026-10-01. Decisions taken there:

| Question                         | Decision                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Agent "looks good" critique?     | **Not now.** It has no baseline and no stable verdict. A later layer may judge *diffs* this suite produces. |
| How is the suite used?           | **On-demand tool**, like `pnpm test:skills`. Not a gate, not part of `pnpm test`, not wired into orchestrate. |
| Where does the data come from?   | **Mocked API in the browser** (§2). The server never runs.                                                  |
| Contrast check — which themes?   | **Daylight only.** The four dark themes are due a redesign of their own (§8); checking them now is noise.  |
| Breakpoint shots — which theme?  | **Daylight**, so that redesign re-baselines only the per-theme shots, not the breakpoint ones.             |

## 1. Goals and non-goals

**Goals**

- A refactor that changes no rendered pixel runs fully green; one that moves anything by one pixel fails with an expected / actual / diff image.
- Two back-to-back runs on an unchanged tree are both green. This is the acceptance test for the suite itself (§9).
- No change to `server/`, its zero-runtime-dep rule, or `test/outbound.test.ts`.
- New horizontal page overflow and new below-AA text contrast in daylight are caught even in UI that has no baseline yet.

**Non-goals**

- LLM critique of screenshots, CI, Linux or Windows baselines, cross-browser (Chromium only).
- Data states beyond one populated fixture per view, plus the one Sessions detail shot in §4. Adding a state is a fixture variant and one case line.
- The CSS Modules migration itself, and the dark-theme redesign.
- Exercising the server's scan pipeline. The ~35 tmpdir-fixture unit tests under `test/` own that.

## 2. Why the API is mocked rather than the server run

A real server with `HOME` pointed at a fixture directory looks cheaper than it is:

- `readToken()` (`server/lib/usage.ts:78`) reads the **macOS keychain before anything under `$HOME`**. A fake home still picks up the real OAuth token,
  makes the real usage call, and can raise a keychain access prompt.
- `server/lib/scan.ts` derives session status from the current time against file mtimes. Freezing the browser clock does not freeze that, so payloads would
  drift between runs. `scanSessions` already accepts `options.now` (`server/lib/scan.ts:510`), but the HTTP handler does not pass it.
- Making either deterministic needs a stub for the keychain read and a way to inject `now` through the HTTP layer — test-only plumbing inside `server/`.

So the built client is served statically and every `/api` request is answered **inside the browser** by Playwright route interception, from typed fixtures.
The UI is the subject under test; the API contract is held by `shared/types.ts`, which the fixtures are typed against, so `pnpm typecheck` fails when the
contract moves and a fixture did not.

## 3. Parts

```
playwright.config.ts           chromium only, 1 worker, webServer = `vite preview` of client/dist on port 4373 (not 4173 / 5174, which a running
                               prod or dev server owns), snapshotPathTemplate pointing at __screenshots__/
test/visual/fonts/             vendored Hanken Grotesk woff2 + the Google Fonts CSS that references it (§5)
test/visual/
  fixtures/                    one module per endpoint, plain objects typed against shared/types.ts
  mock-api.ts                  installs the /api route handler
  stage.ts                     puts a page into a known, frozen state for one shot
  views.spec.ts                the screenshot matrix (§4)
  layout.spec.ts               the non-image checks (§6)
  contrast-known.json          accepted daylight contrast violations (§6)
  __screenshots__/             committed baselines, darwin only
```

Each part knows one thing:

- **`mock-api`** knows endpoints, nothing about the UI. A GET with a fixture answers 200 with it. A GET with **no** fixture fails the test naming the URL, so
  a new endpoint can never silently bake a loading or error state into a baseline. Any POST / PUT / PATCH / DELETE fails the test naming the URL.
  Requests to `fonts.googleapis.com` / `fonts.gstatic.com` are fulfilled from `test/visual/fonts/`; any other off-origin request fails the test naming it.
- **`stage`** knows how to reach a state, nothing about endpoints: clock, viewport, the localStorage it seeds before the page loads, an optional URL query,
  and when the page counts as ready (§5).
- **The specs** only enumerate cases.

**Fixtures.** The client's GETs, from a scan of `client/src` on 2026-10-01: `sessions`, `sessions/:id/…`, `health`, `management` (+ `management/project`,
`management/file`), `account`, `settings`, `pins`, `usage/rates`, `usage/profile`, `analytics`. The plan re-derives the list from source rather than trusting
this one. Rules:

- Every timestamp is an offset from one exported fixed epoch, so relative text ("3m ago") never changes.
- No real project names, paths, branches or account details. Invented, plausible values only.
- One populated variant per endpoint. `GET /api/settings` carries only server-side settings (`idleSecs`, `client/src/hooks/useServerSettings.ts:56`); it is
  a plain fixture and **not** where theme or width come from.
- **Device settings live in `localStorage['dashboard.settings']`** (`client/src/lib/settings.ts:4`): theme, content width (`'fixed' | 'full'`), font scale,
  landing section. `stage` seeds that key before navigation (init script), so both the inline pre-paint script in `client/index.html` and
  `useSettings` (`client/src/hooks/useSettings.tsx:66`) read the same values. The open section is seeded through `dashboard.section`, with the seeded
  landing value agreeing so the landing override cannot fight it.
- No test hooks are added to the client. If a state is unreachable through fixtures, localStorage and the URL, that is a finding to raise, not a seam to add.

**Commands** (root `package.json`):

- `pnpm test:visual` — builds the client, then runs both specs.
- `pnpm test:visual -- --update-snapshots` — re-baselines.
- `pnpm test:visual:report` — opens the last HTML report.

**Dependencies:** `@playwright/test` and `@axe-core/playwright`, root devDependencies only, plus the Chromium download (roughly 150MB), which the implementing
session asks before fetching. `test-results/` and `playwright-report/` are gitignored.

## 4. The screenshot matrix

Views: Sessions, Usage, Management, Analytics, Settings. Per view:

| Shots                  | Theme            | Width (px)                              | Content width |
| ---------------------- | ---------------- | --------------------------------------- | ------------- |
| Breakpoint tiers (6)   | daylight         | 375, 640, 768, 1024, 1280, 1536         | `fixed`       |
| Wide tiers (2)         | daylight         | 1537, 1921                              | `full`        |
| Other themes (4)       | midnight, amber, graphite, nightshift | 1280                | `fixed`       |

That is **12 per view, 60 total**, plus **one** Sessions shot at 1280 / daylight with the chat drawer open, reached by loading
`?session=<fixture session id>` (`client/src/components/SessionsView.tsx:70`; card expansion and split view are unpersisted `useState` and unreachable
without clicks): **61**. Widths are each tier's `min-width` from `docs/subsystems/breakpoints.md`, with 375 standing in for the phone base; `3xl` / `4xl`
exist only in full content-width mode, hence the second row.

Every shot is full-page, viewport height 900, `deviceScaleFactor` 1, font scale 1 (seeded in `dashboard.settings`).

**The view list is expected to move.** The Git Stats spec (`2026-10-01-git-stats-design.md`) renames today's Management to Claude Configs and adds a new
Management tab. Views are one list in `views.spec.ts`; when that lands, the list changes and the affected baselines are regenerated.

## 5. Determinism

`stage` enforces, for every shot:

- **Clock:** `page.clock.setFixedTime(EPOCH)` before navigation. `Date.now()` and `new Date()` return the epoch for the whole run while timers keep running,
  so `requestAnimationFrame` / `setTimeout` users are not starved. The 3s poll (`client/src/hooks/useSessions.ts:41`) keeps firing, but every poll returns
  the same fixture at the same "now", so a repaint mid-capture is pixel-identical. Freezing timers (`install` + `pauseAt`) is deliberately not used.
- **Ready means all of:** `document.fonts.ready` resolved **and** `document.fonts.check('16px "Hanken Grotesk"')` true; every route the view requested has
  been answered at least once; no element whose own text matches `/^loading/i`. A fixed sleep is never a readiness signal.
- **Motion:** screenshot options `animations: 'disabled'` and `caret: 'hide'` (19 `@keyframes` / `animation:` rules in `styles.css`, 2026-10-01).
- **Rendering:** Chromium launched with `--force-color-profile=srgb`. The UI face, Hanken Grotesk (`--font`, `client/src/styles.css:35`), is loaded from
  Google Fonts with `display=swap` (`client/index.html:19`); `mock-api` serves it from `test/visual/fonts/`, so no run depends on the network or can capture
  the fallback face.
- **Tolerance:** `maxDiffPixels: 0` **and** `threshold: 0`. Playwright's per-pixel colour threshold defaults to 0.2, which would let a small token change
  pass. The suite exists to prove zero diff; any tolerance hides exactly the shifts it is there to catch.
- **Platform:** baselines are generated and compared on macOS only. Run on any other platform, the suite stops before comparing, with one line saying so,
  rather than reporting 61 pixel failures.
- **Permissions:** Playwright auto-denies permission prompts (notifications). Any view whose render depends on a permission state gets that state from a
  fixture or a granted permission in config, never from a prompt. Under auto-deny `Notification.permission` is `'denied'`, so the Settings baseline shows
  the "blocked" copy (`client/src/hooks/useWebNotify.ts:31`) — expected, not a bug.

## 6. Non-image checks (`layout.spec.ts`)

Same fixtures, same staging, no images.

- **No horizontal page overflow:** every view at every one of the 8 widths in §4, in the same content-width mode §4 pairs with that width, satisfies
  `document.documentElement.scrollWidth ≤ window.innerWidth`. 40 cases, no allowlist — overflow is always a bug.
- **Text contrast, daylight only:** every view, at 1280, run through axe-core with **only** the `color-contrast` rule enabled (WCAG AA: 4.5:1 normal text,
  3:1 large). Other axe rules are not visual and are out of scope.
  - Entries are keyed by **view + the element's trimmed text + foreground/background colour pair**, never by selector: the CSS Modules migration this suite
    serves renames classes, and a selector key would report every known violation as new on each step.
  - **File absent** (first run, or deleted on purpose): the run writes `contrast-known.json` from what it found and passes.
  - **File present:** the run fails only on a violation whose key is not in the file, reporting view, text, selector, both colours, ratio, required ratio.
    A known entry that no longer occurs is reported as fixed so the file can shrink; it does not fail the run.
  - axe's `incomplete` results (contrast it cannot compute, e.g. text over a gradient or image) never fail the run; their count per view is printed.
- **Dropped:** generic overlap and clipping checks. Popovers, badges, tooltips and ellipsized text overlap or clip by design, so a generic rule is noisy
  enough to be ignored. Real overlap shows in the screenshots.

## 7. Failure output

- Playwright's HTML report: expected / actual / diff per failing shot; `pnpm test:visual:report` opens it.
- The console names each failing case as `view · theme · width · kind`, where kind is `shot`, `detail`, `overflow` or `contrast`, so the run log alone says
  what broke.
- Re-baselining is always an explicit `--update-snapshots`; nothing re-baselines on its own.

## 8. Relation to other work

- **CSS Modules migration:** the consumer. Each migration step is green only if the suite shows zero diff.
- **Dark-theme redesign:** midnight, amber, graphite and nightshift are to be redesigned. Until then their 20 shots record today's look; the redesign
  re-baselines exactly those 20 and turns the contrast check on for each theme it finishes. Neither is part of this spec.
- **LLM diff critique:** a possible later layer that reads this suite's expected / actual / diff triples and the change's intent and answers "intended or
  regression?". Out of scope here; nothing in this design blocks it.
- **Repo weight:** 61 full-page PNGs, estimated 5–15MB, plus churn per re-baseline. Accepted; Git LFS is not worth its setup at this size.

## 9. Verification

The implementing branch is done when:

1. `pnpm test:visual` passes on a clean tree, then passes again immediately with no change (determinism, §1).
2. Mutation proof, each reverted after: change one daylight token by the smallest step (one unit in one RGB channel) → named daylight shots fail; add `margin-left:1px` to one shared
   class → shots of every view using it fail; give one element `width:120vw` → the overflow check fails at the narrow widths; lower one daylight text
   token's lightness until it drops below 4.5:1 → the contrast check fails with that selector.
3. A GET with no fixture, and any POST, each fail the run naming the URL.
4. `pnpm test`, `pnpm typecheck` stay green; `git diff main -- server/` is empty.
5. `docs/subsystems/visual-tests.md` exists (coverage, re-baselining, the macOS-only rule, adding a fixture or a view), `docs/overview.md` §Map carries
   one line for it, and `CLAUDE.md` §Commands carries one line for `pnpm test:visual`.

Not verifiable by the implementing session: whether the baselines *look right*. The first committed set records today's UI as truth; a human skims the
report once before committing it.
