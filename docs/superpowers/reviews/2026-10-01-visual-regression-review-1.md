# Review 1 — plan `2026-10-01-visual-regression.md` against spec `2026-10-01-visual-regression-design.md`

Reviewer: Fable 5.1, read-only, 2026-10-01. Every code claim below was checked against the working tree at `aaa7825`.

## Verdict: APPROVE WITH FIXES

No Critical findings. Nine Important findings, all local edits to the plan; none changes the design. The plan follows its own convention
(behaviour and test cases, no literal code) throughout, honours the repo's hard rules (`server/` untouched, zero-dep server, no client test hooks,
port 4373, `--strictPort`), and every spec section and §9 verification item maps to a task.

## 1. Coverage

| Spec section / item                                  | Task                       | Note                                                             |
| ---------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| §1 goals (zero-diff, determinism, no server change)  | T3 S3, Global Constraints  |                                                                  |
| §2 mocked API                                        | T1                         |                                                                  |
| §3 parts list                                        | T1–T4                      | Plan adds `stage.spec.ts`, `contrast-known.ts` + unit test — additive |
| §3 fixture rules (epoch, invented values, settings)  | T2                         | see I-5 (seeded field list incomplete)                           |
| §3 commands, deps, gitignore                         | T1                         |                                                                  |
| §4 matrix, 61 shots, detail via `?session=`          | T3                         | see I-3 (id must be UUID-shaped)                                 |
| §5 clock / tz / ready / motion / rendering / tolerance / platform / permissions | T1 config, T2 stage | see I-7 (fonts.check is vacuous)                 |
| §6 overflow (40), contrast (5), known file           | T4                         |                                                                  |
| §7 failure naming `view · theme · width · kind`      | T3, T4                     |                                                                  |
| §8 relation to other work                            | Global Constraints         |                                                                  |
| §9.1 green twice                                     | T3 S3, T5 S2               |                                                                  |
| §9.2 four mutation proofs                            | T3 S4 (2), T4 S5 (2 + 1)   |                                                                  |
| §9.3 `mock-api.spec.ts` refusals                     | T1 S2                      | plan uses `/__blank`, spec says "from a staged page" — M-4       |
| §9.4 `pnpm test`, `typecheck`, `server/` diff empty  | T1 S7, T2 S5, T5 S2        |                                                                  |
| §9.5 docs, overview line, CLAUDE.md line             | T5                         | plan adds `.docs-sync.yml` entry — correct, siblings have one    |

Nothing in the spec lacks a task.

## 2. Important findings

**I-1 — plan:137 — `Theme` is not a type the client exports.** `client/src/lib/settings.ts:35` exports `ThemeId` (and `THEMES`); there is no `Theme`.
→ Write `StageOpts.theme: ThemeId` and import `ThemeId`.

**I-2 — plan:85 — `vite preview` on the root config auto-opens the user's browser on every run.** Vite resolves `preview.open ?? server.open`
(`node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66214`, then `if (options.open) openBrowser(...)` at `:66339`), and `vite.config.ts:85`
sets `server.open: !inContainer`, i.e. `true` on a Mac. The same inheritance gives the preview `host: true` (all interfaces) and the `/api` proxy to
the live API port (`vite.config.ts:94-98`). → Add a `preview: { open: false, host: 'localhost', proxy: {} }` block to `vite.config.ts` (list it under
Task 1 Files; it is neither `server/` nor `client/src/`), or pass `--no-open` on the command and verify it is honoured. The empty proxy matters: with
the proxy inherited, any `/api` request that escapes `page.route` reaches a running prod server on 4173 and real data can be baked into a baseline.

**I-3 — plan:136, 189, 211 — `FIXTURE_SESSION_ID` must be UUID-shaped or the deep link is silently dropped.** `client/src/lib/deepLink.ts:19`
accepts only `/^[0-9a-fA-F-]{8,64}$/`; anything else returns `null` and the Sessions view opens with no drawer. The stage.spec drawer case would
catch it, but the plan should state the constraint rather than let it be rediscovered. → "FIXTURE_SESSION_ID is a UUID (deepLink.ts validates the
shape)".

**I-4 — plan:164 and 190 — the init script's encoding is unstated, and the per-section case does not check the section rendered.**
`usePersistedState` does `JSON.parse` on read (`client/src/hooks/usePersistedState.ts:15`), so `dashboard.section` must be written as `"sessions"`
(quoted JSON string); a raw `sessions` throws inside the try and falls back to the default, silently. The only check at plan:190 is `isReady` + no
failures, which passes with the wrong section showing. → State "both keys are written JSON-encoded" and add to the per-section case: the rail's
active item (or the section's root element) is the staged section.

**I-5 — plan:168-171 — the seeded settings omit two fields shots depend on.** Spec §3 (spec:86) requires "every field a shot depends on is seeded
explicitly". `defaultLayout` decides the Sessions shape (`client/src/components/SessionsView.tsx:50-51` via `resolveLayout`;
`DEFAULT_LAYOUT = 'board'` at `client/src/lib/filterSort.ts:86`) and `chatFullText` changes the detail shot. Both are in `Settings`
(`settings.ts:69-121`, defaults at `:126-143`). → Seed `defaultLayout: 'board'` and `chatFullText: false`. (The spec's own list at spec:84-86 has the
same omission; note it for the spec author.)

**I-6 — plan:112 — Task 1 Step 3's red run happens before the config exists (Step 4).** With no `playwright.config.ts`, Playwright's default
`testDir` is the repo root and the default `testMatch` (`**/*.@(spec|test).?(c|m)[jt]s`) collects the 80 node-assert files in `test/*.test.ts` and
the 17 `plugin/skills/*/test/*.test.mjs` `node:test` suites (git-sync's is ~4 min per `.claude/CLAUDE.md:31`). → Write `playwright.config.ts`,
the guard and the scripts in Step 2 as scaffolding; the red step is then exactly "`installMockApi` cannot be imported".

**I-7 — plan:185 — `document.fonts.check('16px "Hanken Grotesk"') === true` passes with no font loaded.** `FontFaceSet.check()` returns `true`
when no `@font-face` matches the spec (nothing would need loading). Before Task 2 vendors the CSS, the `fonts.googleapis.com` request is aborted
(plan:94), no face is registered, and the case is green — it does not fail before its implementation. The same holds for the `isReady` clause at
plan:175 (spec §5, spec:131), where it is only rescued by the off-origin failure being asserted later. → Assert instead that
`[...document.fonts].some(f => f.family === 'Hanken Grotesk' && f.status === 'loaded')`, in both the case and `isReady`.

**I-8 — plan:300 — `verified:` "is the commit that lands this task" cannot be known before that commit exists.** docs-sync defines the stamp as
"the commit the doc was last verified against" (`~/.claude/skills/docs-sync/SKILL.md:18`); siblings carry the HEAD they were written at
(`docs/subsystems/breakpoints.md` stamp). → "`verified:` is `git rev-parse HEAD` at the time the doc is written".

**I-9 — plan:51-52, 118-119 — RF2 (Linux `--update-snapshots`) has only a manual proof.** Checklist rule: each Review Focus item has a test. RF1
and RF5 are environment-level and a by-hand proof is reasonable, but RF2 is the one that can destroy baselines and its logic is a pure function
(platform string → message or nothing). → Extract the guard's decision into a small pure module and pin it in the node-assert runner: `darwin` →
no message; `linux` → the exact line from Global Constraints with `(platform: linux)`; the override env var wins over `process.platform`.

## 3. Minor findings

- **M-1 — plan:80-81, 101, 165** — relative navigation (`/__blank`, `/` + query) needs `use.baseURL: 'http://localhost:4373'`; not listed among
  the `use` values. Playwright errors clearly, but state it.
- **M-2 — plan:53-54 (RF3 rationale)** — `maxSessions` and `activeWindowMin` are server query params (`settings.ts:9-11`), ignored by a
  pathname-matching mock; they decide nothing here. What can hide a row client-side is `dashboard.view` (`DEFAULT_VIEW` at `filterSort.ts:134-137`:
  no projects, no statuses, `window: 'all'`). The expected outcome (4 cards) and the test are right; the sentence is not. Same for plan:152 "below
  the seeded `maxSessions`".
- **M-3 — plan:153** — statuses are `'working' | 'idle' | 'question' | 'incomplete'` (`shared/types.ts:63`); "active" is not one and the "if
  `SessionsResponse` models that" hedge is resolved — it does. Name the three values.
- **M-4 — plan:100-103 vs spec:187** — spec says the refusals are proven "from a staged page"; the plan uses a `/__blank` page with its own route.
  The reason given is sound (no app noise), but record the deviation in the plan so a spec-compliance reviewer does not flag it later.
- **M-5 — plan:74, 111, 215** — the "shared `afterEach`" that fails on `mockApiFailures` is referenced from three tasks but never given a home.
  Name the file (a Playwright fixture module under `test/visual/` is the natural one).
- **M-6 — plan:242, 253** — axe's `fgColor`/`bgColor` can be 9-character `#rrggbbaa` when the computed colour has alpha; "lowercased 7-character"
  should say whether alpha is stripped or the entry rejected.
- **M-7 — plan:118** — `VISUAL_PLATFORM_OVERRIDE` is fine as a seam (it lives in the config, not `client/src/`), but it should also be the lever
  I-9's unit test uses, so document it once in the guard module rather than only in a config comment.
- **M-8 — plan:17** — "40 overflow + 5 contrast cases" is 45 titled cases, but the contrast file-absent path (plan:256) passes without a comparison;
  the doc in Task 5 should say a first run after deleting the file proves nothing about contrast.

## 4. Checks that passed

- **Reality:** `playwright.config.ts`, `test/visual/`, `@playwright/test`, `@axe-core/playwright`, `test:visual` scripts, `test-results/` and
  `playwright-report/` in `.gitignore`, `docs/subsystems/visual-tests.md` — all absent (Create is correct). `tsconfig.json:17` lists `vite.config.ts`
  by name, so adding `playwright.config.ts` to `include` is the right edit. `SECTIONS` is at `client/src/lib/sections.ts:14` with the five ids the
  plan uses; `THEMES` ids match the plan's five; `usageTab: 'forecast'`, `settingsTab: 'local'`, `density: 'comfortable'`, `fontScale: 100`,
  `maxSessions: 5`, `notifyBrowser: false`, `landing` all exist with those values valid (`settings.ts:36-49, 126-143`). `SessionsView.tsx:70`,
  `useServerSettings.ts:54-56`, `SettingsView.tsx:658`, `index.html:19` and `:28-33`, `useSessions.ts:41`, `.shell{zoom:var(--font-scale,1)}` at
  `styles.css:114` — all as cited. `docs/.docs-sync.yml` and `docs/superpowers/plans/2026-10-01-git-stats.md` exist; `sections.ts` has no
  `claude-configs`, so "not yet executed" holds.
- **Endpoint list (plan:141-146):** re-derived from `grep -n "fetch(" client/src/hooks` — the 16 GET pathnames match exactly. The one fetch outside
  hooks (`SettingsView.tsx:162`, `POST /api/notify/test`) is click-driven and never fires in a shot.
- **Types (plan:148-149):** `SessionsResponse`, `AccountResponse`, `UsageProfileResponse`, `UsageRatesResponse`, `AnalyticsResponse`,
  `HealthResponse`, `PinsResponse`, `ServerSettings`, `SessionDetail`, `SessionChat`, `SessionQuestion`, `SessionPlan`, `SessionMessage`,
  `ManagementIndex`, `FileContent` all exported from `shared/types.ts`.
- **Interfaces:** every Consumes is Produced earlier with the same spelling (`installMockApi`, `FixtureMap`, `mockApiFailures` T1→T2;
  `stage`, `StageOpts`, `FIXTURE_SESSION_ID`, `isReady` T2→T3/T4; `contrastKey`, `diffContrast`, `ContrastEntry` T4 internal) — except `Theme`, I-1.
- **Order:** no forward dependency between tasks; the Git Stats interaction is stated as non-blocking in both directions.
- **Values:** EPOCH `2026-09-30T14:00:00Z` is a Wednesday (day 273 of a year starting Thursday). Widths, themes, counts (12 × 5 + 1 = 61; 5 × 8 = 40;
  5 contrast) match spec §4/§6. The platform line, screenshot options and tolerance match spec §5 and Global Constraints. `contrastKey` and
  `diffContrast` examples compute as stated. Playwright's `setFixedTime` keeps timers running (spec §5 line 125) — plan uses it, not `install`.
- **Playwright facts:** routes are tried last-registered-first (plan:101) — correct. `reuseExistingServer: false` with a held port fails naming the
  URL (RF5) — correct. `expect.poll` default timeout is the 5 s expect timeout — correct.
- **Conventions:** no literal code anywhere in the plan; budget stated soft; 160-column wrap honoured; dated figures carry their date.
