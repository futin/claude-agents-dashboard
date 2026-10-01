# Review 2 — `2026-10-01-visual-regression-design.md`

Reviewer: Fable 5.1, 2026-10-01. Read-only. Checked against the repo at `8d6248e` (the tree that carries the review-1 fixes). Playwright claims checked
against the `playwright-core` type declarations cached under `~/.npm/_npx/53b5ca06f5b71ebd/node_modules/` (the repo still has no Playwright installed).

## Verdict: APPROVE WITH FIXES

The review-1 Criticals are fixed correctly: theme / width / landing now come from `localStorage['dashboard.settings']` seeded by `stage` (L80-83), the font
is served from a vendored copy via route interception (L67, L125-127), the clock rule is `setFixedTime` with timers running (L119-121), `threshold: 0`
sits beside `maxDiffPixels: 0` (L128), the ready predicate is defined (L122-123), the detail shot is reached by `?session=` (L105-106), and the contrast
allowlist is keyed on text + colour pair (L145-146). No Critical remains. Three Important findings are stated facts or values that are wrong as written
and one is a verification criterion the suite's own cases cannot reach; each is a one-line fix.

## Verified true (no finding)

- `styles.css`: 2596 lines, 586 distinct `.class` tokens, 19 `@keyframes` / `animation:` lines (L3, L124) — recounted.
- `readToken()` at `server/lib/usage.ts:78`; keychain prompt documented at L74-76 (L38).
- `scanSessions` reads `options.now` at `server/lib/scan.ts:510`; the HTTP handler at `server/api.ts:143-154` passes seven injections and no `now` (L41).
- GET list (L72-74) matches a fresh grep of `fetch(` in `client/src`; every POST (`notify/test`, `spawn`, `transcribe`, `stop`, `remote-answer`,
  `settings`, `pins`, `*-answer`, `message`, `question`, `plan`) is behind a click.
- `GET /api/settings` → `idleSecs` check at `client/src/hooks/useServerSettings.ts:56` (L78).
- `localStorage['dashboard.settings']` at `client/src/lib/settings.ts:4`; `useSettings.tsx:66` stamps `root.dataset.theme`; `index.html:27-34` reads the
  same key pre-paint; `dashboard.section` at `client/src/App.tsx:35`, `landing === 'last'` defers to it at `App.tsx:46` (L80-83).
- `?session=` seeds `chatId` at `client/src/components/SessionsView.tsx:70`; `expanded` / `splitId` are plain `useState` at L67-68 (L105-106);
  `deepLinkSession()` (`client/src/lib/deepLink.ts:35-47`) is consumed once and strips the param, and `App.tsx:45` forces the Sessions section.
- `useSessions.ts:41` is `setInterval(poll, refreshMs)` (L120); default `refreshMs` 3000 (`settings.ts:130`).
- `--font` at `client/src/styles.css:35`; Google Fonts link with `display=swap` at `client/index.html:19` (L125-126).
- `setFixedTime` "keeps all the timers running" — `playwright-core/types/types.d.ts:20698`; `toHaveScreenshot` `threshold` defaults to `0.2` —
  `playwright/types/test.d.ts:235` (L119, L128).
- Tier `min-width`s and the full-only `3xl`/`4xl` rule — `docs/subsystems/breakpoints.md:16-25,58-62` (L107-108).
- Arithmetic: 6+2+4 = 12 × 5 = 60 + 1 = 61 (L105); 4 × 5 = 20 (L164); 5 × 8 = 40 (L142).
- Git Stats spec renames Management → Claude Configs (`2026-10-01-git-stats-design.md:3-4`) (L112).
- `tsconfig.json:17` includes `test`, so fixtures under `test/visual/` are typechecked; every GET response type the client consumes is exported from
  `shared/types.ts` (L45-46). `pnpm test` is an explicit import list (`test/run-all.ts`) so nothing under `test/visual/` leaks in (L13).
- 35 of 94 `test/*.test.ts` files use `mkdtemp` (L32).
- `vite.config.ts` has `root: 'client'`, `build.outDir: 'dist'` → `client/dist`; no `preview` block, so `--port 4373` on the CLI is the only way to pick
  the port (L51).
- `docs/overview.md:299` is `## Map` (L180-181). `.gitignore` already carries `client/dist/`; `test-results/` and `playwright-report/` are new (L93).
- CLAUDE.md hard rules: no `server/` change, devDependencies only, no new outbound call, `shared/types.ts` imported as types only — all respected.

## Important

### I1 — "font scale 1" seeds the wrong value (L110)

L110: "font scale 1 (seeded in `dashboard.settings`)". The stored field is a percent: `DEFAULT_SETTINGS.fontScale: 100` (`client/src/lib/settings.ts:129`),
and both readers divide by 100 — `index.html:33` `String(s.fontScale / 100)` and `useSettings.tsx:66`. The result lands in `.shell{zoom:var(--font-scale,1)}`
(`styles.css:114`). Seeding `fontScale: 1` renders every shot at zoom 0.01; the §9 human skim would catch it, but the spec's value is wrong as written and
L80 lists "font scale" among the seeded fields without the unit.

→ Write "font scale 100 (`fontScale: 100`, the stored percent; `--font-scale` resolves to 1)" at L110, and name the unit at L80.

### I2 — The Settings baseline does not show the "blocked" copy (L134-135)

L134-135: "Under auto-deny `Notification.permission` is `'denied'`, so the Settings baseline shows the 'blocked' copy (`client/src/hooks/useWebNotify.ts:31`)
— expected, not a bug." `useWebNotify.ts:31` is only the `Notification.permission` read. The copy lives at `client/src/components/settings/SettingsView.tsx:658-666`
and is gated on `settings.notifyBrowser && webPermission === 'denied'`; `notifyBrowser` defaults to `false` (`settings.ts:138`) and §3 seeds no value for it, so
the shot shows the switch at Off and no warning. Left as written, an implementer either hunts for a missing warning or seeds `notifyBrowser: true` to make the
spec true, which also changes what the shot proves.

→ Either (a) state that with the default `notifyBrowser: false` the Settings shot shows the browser-notification switch Off and no warning, and cite
`SettingsView.tsx:658`; or (b) seed `notifyBrowser: true` on purpose and keep the sentence, noting the gate. Pick one.

### I3 — Time zone and locale are not pinned, so a baseline from one Mac fails on another (§5, L117-129)

§5 fixes the instant (`setFixedTime(EPOCH)`) but not how that instant is rendered. The client formats wall-clock time with the browser's zone and locale:
`client/src/components/AsideBoard.tsx:48-49` (`boardClock`, in every Sessions shot), `client/src/components/ChatDrawer.tsx:35` (detail shot),
`client/src/lib/format.ts:44-47` (`formatResetTime`, Usage), `client/src/components/usage/UsageProfile.tsx:455`, `client/src/lib/usageProfile.ts:97-99,364`,
`client/src/lib/walkChart.ts:322-328` (`getDay() * 24 + getHours()` — the hour-of-week columns themselves shift with the zone). `toLocaleTimeString([])`
also flips 12h/24h with the OS region setting. Two macOS machines in different zones or regions — the user has two sharing one remote — therefore disagree
on pixels for an unchanged tree, which contradicts goal L23 as soon as the baselines are pulled rather than generated. Nothing in §5 or §9 covers it.

→ Add to §5: Playwright `use: { timezoneId: '<one zone>', locale: 'en-US' }` (pick the zone the epoch was chosen in, or `UTC`), and note that the `EPOCH`
constant and `timezoneId` are a pair — changing either re-baselines everything.

### I4 — §9.3 cannot be reached by the suite as designed (L178)

L178: "A GET with no fixture, and any POST, each fail the run naming the URL." §3 L84 forbids test hooks and §4 reaches every state without clicks, so no
case in `views.spec.ts` / `layout.spec.ts` ever issues a POST or an unknown GET; the criterion as written has no way to be exercised, and "fail the run"
cannot be asserted from inside the run that it fails.

→ State how it is proved: a small `mock-api.spec.ts` (or unit test) that issues `page.evaluate(() => fetch('/api/nope'))` and
`fetch('/api/pins', { method: 'POST' })` and asserts the handler's rejection message contains the URL — or demote §9.3 to a mutation step in §9.2.

## Minor

- M1 (L53-61): `test/visual/fonts/` is drawn above the `test/visual/` tree instead of inside it.
- M2 (L65-66): say fixtures match on **pathname**, query ignored — `/api/sessions?maxSessions=…` and `/api/sessions/:id/chat?…` carry queries
  (`useSessions.ts`, `useSessionChat.ts`); without that line the first implementation either 404s them or hard-codes the query.
- M3 (L80): the seeded object should list every field it sets; `density` (`'comfortable' | 'compact'`, `settings.ts:38`) changes layout and is left to the
  default by omission — say so, so a later default change is a visible re-baseline rather than a mystery.
- M4 (L143): the contrast run at 1280 should name its content-width mode (`fixed`, per the §4 pairing) and theme (`daylight`, implied by the heading).
- M5 (L51): `vite preview --port 4373` silently moves to 4374 when 4373 is taken; `--strictPort` makes Playwright's `webServer` fail loudly instead of
  timing out on the URL wait.
- M6 (L143-144): axe reports AA by rule, so the "4.5:1 normal, 3:1 large" parenthetical is correct but `color-contrast` also skips disabled controls and
  `aria-hidden` text; worth a clause so a "missing" violation is not chased.
- M7 (L180): `docs/subsystems/*.md` in this repo carry a docs-sync provenance stamp (see any sibling's header); the new `visual-tests.md` should too, or
  `/docs-sync` will report it untracked.
- M8 (L30, L87): the Usage view has two tabs (`usageTab: 'forecast' | 'rates'`, `settings.ts`) and Settings has `settingsTab`; both are localStorage seeds,
  not fixtures, so "adding a state is a fixture variant and one case line" is not the whole rule — "or a seeded settings key" closes it.
