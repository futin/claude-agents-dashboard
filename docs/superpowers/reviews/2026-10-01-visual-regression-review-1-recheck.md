# Plan re-check: visual regression suite (review 1 follow-up)

Plan: `docs/superpowers/plans/2026-10-01-visual-regression.md` · Spec: `docs/superpowers/specs/2026-10-01-visual-regression-design.md`
Scope: only the hunks in the supplied diff, plus plan text those hunks now contradict. Reviewed 2026-10-01 against the working tree at `4e234fe`.

## Verdict: APPROVE WITH FIXES

No Critical findings. Four Important ones, all local edits to the plan text.

## Important

**I1 — plan:142 contradicts plan:136.** Task 1 Step 5 says `pnpm test` is green "with 3 more cases"; Step 7 (unchanged by the diff) still says "the `pnpm test` case
count is unchanged". One of them is wrong once the guard unit tests are registered in `test/run-all.ts`. Fix: Step 7 → "case count is up by 3 over main".

**I2 — plan:197 states a false fact about the spec.** "Spec §3's list omits the last two" (`defaultLayout`, `chatFullText`). Spec:84-86 names both: "landing section,
Sessions layout (`defaultLayout`), `chatFullText`, and the Usage / Settings sub-tabs". Fix: delete the sentence; the two fields are already spec-mandated.

**I3 — plan:81 and plan:132: the fail-on-failure mechanism has no test, and its shape is ambiguous.** The spec's refusal contract is "fails the test naming the URL"
(spec:69-70) and §9.3 (spec:187-188) calls `mock-api.spec.ts` "the only proof the refusals work". The plan's version asserts `mockApiFailures(page)` content
with the harness opted out, so nothing anywhere proves that a non-empty failure list actually fails a case; `harness.ts` could be a no-op and every spec
would stay green (the repo's own rule: a guard test that stays green with the guard deleted proves nothing). Separately, "Playwright's `test` extended with an
automatic `afterEach`" admits two implementations: a module-level `test.afterEach` inside the imported module, or `test.extend` with an `auto` fixture whose
teardown asserts. The first is registered once per worker (module cache), so with one worker it covers only the first spec file loaded. Fix: name the
`test.extend` + `auto` fixture shape explicitly, and add one case in a spec that imports the harness `test` (e.g. `stage.spec.ts`), annotated `test.fail()`,
that stages a page and `fetch`es `/api/nope`: it passes only when the teardown throws. (`@playwright/test` is not installed yet, so the caching behaviour is
stated from Playwright's documented fixture guidance, not from `node_modules`; verify once installed.)

**I4 — plan:137-141: RF2's load-time refusal lost its proof.** The diff removed the `VISUAL_PLATFORM_OVERRIDE` hand run and replaced it with three unit tests
(plan:114-117) that pin only the string. RF2's expectation (plan:51-52) is "refused with the platform line **before any file is written**", which is the config
wiring (`platformRefusal(process.platform)` → print → nonzero exit) that the unit tests never execute. Fix, needing no seam: a Step 6 bullet that runs
`playwright test --update-snapshots` under a `node --import` preload doing `Object.defineProperty(process, 'platform', { value: 'linux' })`, and records the
exact line, the nonzero exit, and an unchanged `git status`.

## Minor (file only)

- plan:157 — the regex is in `readSessionParam` (`client/src/lib/deepLink.ts:15-19`); `deepLinkSession` is its consumer. Also the regex accepts uppercase hex, so
  "lowercase UUID" is a fixture convention, not a `deepLink` requirement; say so or drop "lowercase".
- plan:113 — "~80 node-assert `test/*.test.ts` files": `ls test/*.test.ts | wc -l` = 94 on 2026-10-01.
- plan:112 vs plan:134 — Step 2 scaffolds `platform-guard.ts`, Step 4 implements it. Say the Step 2 one is a stub returning `null` for every input, so the config
  still loads on darwin and the `linux` / `win32` cases go red as Step 3 expects.
- plan:191-197 — the Settings shot renders `refreshMs`, `lookbackHours`, `activeWindowMin`, `spawnDefaultModel`, `spawnDefaultEffort`
  (`client/src/lib/settings.ts:126-143`), none seeded. This matches the spec's own list (spec:84-86) so it is not a defect, but the plan's rationale "every field a
  shot depends on" applies to them equally. Taste; a spec question, not a plan one.
- plan:141 — `vite preview --host localhost` may bind `127.0.0.1` or `[::1]`; both are loopback. Write "shows only `127.0.0.1` or `[::1]`" so the implementer does
  not read `::1` as a failure.
- plan:67 — `vite.config.ts` `server:` opens at line 72 and `open` is `!inContainer` (line 76), not a literal `true`. Cosmetic.

## Verified against code (no finding)

| Plan claim | Evidence |
| --- | --- |
| `DEFAULT_VIEW` is the browser-side filter; `maxSessions`/`activeWindowMin` are query params | `client/src/lib/filterSort.ts:134-140`, `settings.ts:273-275`; only `AsideBoard.tsx:87` reads `maxSessions` client-side, for display |
| `deepLink` regex `/^[0-9a-fA-F-]{8,64}$/` | `client/src/lib/deepLink.ts:19` |
| `ThemeId` at `settings.ts:35`; `Section`/`SECTIONS` in `sections.ts:11,14` | confirmed |
| `usePersistedState` JSON-parses | `client/src/hooks/usePersistedState.ts:15` |
| `defaultLayout: 'last'` defers to `dashboard.layout` | `SessionsView.tsx:50-51`; `'board'` is a valid `Layout` and `DEFAULT_LAYOUT` (`filterSort.ts:74,86`) |
| Status union | `shared/types.ts:63` |
| `vite preview` inherits `open`, `host`, `proxy` from `server` | `node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:66207-66218` |
| `BROWSER=none` suppresses the opener | same file `:54194-54201` |
| Side rail marks the active item (`rail-link on`, `aria-current="page"`, label text) | `client/src/components/SideRail.tsx:259-264` |
| docs-sync `verified:` = commit the doc was last verified against | `~/.claude/skills/docs-sync/SKILL.md:18` |
| `dashboard.section` read + landing precedence | `client/src/App.tsx:35,45-49` |
| All Create paths absent; `.gitignore` lacks the two entries; `tsconfig.json` `include` lacks `playwright.config.ts`; `run-all.ts` shape | confirmed |
| Fixture endpoint list matches `grep -n "fetch(" client/src/hooks` | confirmed (16 GET paths) |

## Coverage

Every spec section maps to a task (§2/§3 → T1-T2, §4 → T3, §5 → T2, §6 → T4, §7 → T3/T4 titles, §9 → T1 S6, T3 S3-4, T4 S4-5, T5 S2). §9.3's "from a staged
page" is deliberately replaced by a blank page, with the reason stated at plan:131; the remaining gap is I3. `harness.ts` and `platform-guard.ts` are not in
spec §3's Parts tree; they are plan-level additions and the docs stamp sources at plan:328 cover them.
