# Review 1 — Release pipeline Phase C part 2 plan

Plan: `docs/superpowers/plans/2026-10-16-release-pipeline-phase-c-part-2.md` (229 lines)
Spec: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §App, §Testing (Dashboard), §Rollout 5
External: `futin/release-kit` at `v1.1.0` = `18af40f5d32264726963604574f41c3e8f373fb3` (verified with `git rev-parse v1.1.0^{commit}`)
Reviewer: Fable 5.1, fresh session, 2026-10-16. Verified every path, export and value named below against the worktree and the release-kit tag.

## Verdict: APPROVE WITH FIXES

No Critical findings. Four Important findings, all in test coverage and one geometry ambiguity; none changes the design. The plan covers every spec section
and every spec test case, every Consumes name is Produced earlier with the same spelling, every Create target is absent and every Modify target exists,
and the release-kit contract (`readReleases(repoRoot: string): Promise<ReleasesResponse>`, `Release.type: ReleaseType | 'baseline'`) matches what the
plan consumes.

## Coverage map (checklist 1)

| Spec | Plan task |
|---|---|
| §API types (`Release`, `ReleasesResponse`, field docs) spec:175–179 | Task 1 (plan:55–59) |
| §API `GET /api/releases` via `readReleases(repoRoot())`, never `process.cwd()` spec:181–182 | Task 2 (plan:83, 24) |
| §API annotated-only `vX.Y.Z` filter, lightweight / `v1` ignored spec:184–185 | release-kit `src/git.ts:5,9,46`; Task 2 case 11 |
| §API `current` from `describe`, `ahead` spec:186 | release-kit `read-releases.ts:35–42`; Task 2 cases 3, 5 |
| §API empty shape, never an error status spec:187 | plan:25; Task 2 cases 1, 2 |
| §API memo on HEAD + `packed-refs` / `refs/tags` mtimes under `--git-common-dir` spec:188–189 | Task 2 (plan:90–94), cases 5–10 |
| §API no fetch added spec:191 | Task 5 step 3 doc (plan:216) |
| §Dependency second package, pinned, `server-deps` pins both, CLAUDE.md names it, `outbound` unchanged spec:195–197 | Task 1 steps 1, 3, 5; plan:23 |
| §UI chip text, hidden on `null` spec:201 | plan:26; Task 3 `chipLabel`; Task 4 `version` prop |
| §UI unseen dot, first-visit seed, invalid value = missing, opening sets `lastSeen` spec:202–203 | Task 3 `unseen` / `markSeen`; Task 4 AppShell (plan:184–185) |
| §UI panel: newest first, version, date, badges, title, Markdown notes, PR link, Breaking as extra badge, baseline divider spec:204–206 | Task 4 drawer (plan:179–183); Task 3 `badges` |
| §UI theme tokens, stable class names, mockups first spec:207 | plan:30; mockups done (plan:17, artifact read) |
| §Testing: `/api/releases` null + populated + `ahead` 0→1 spec:252–253 | Task 2 cases 1, 4, 5 |
| §Testing: unseen decision, first-visit seed, `0.10.0 > 0.9.0` spec:254 | Task 3 step 1 |
| §Testing: `server-deps` second package spec:255 | Task 1 step 1 |
| §Testing: visual baseline for chip and panel spec:256 | Task 5 |
| §Rollout 5: the `feat` PR whose merge becomes `v0.2.0` spec:266–267 | Task 6 |

Nothing in the spec's App, Dependency, Testing-dashboard or Rollout-5 sections is without a task.

## Important

### I1 — plan:115, plan:38–39: case 8 cannot tell whether `packed-refs` is in the memo key

Case 8 reads once, then runs `git pack-refs --all` **and** `git tag -d` before the second read. `pack-refs` unlinks the loose files under `refs/tags`,
so the `refs/tags` directory mtime alone invalidates the memo; a key built from HEAD + `refs/tags` mtime only (dropping `packed-refs`) passes the case
as written. Review Focus 2 (plan:38–39) claims case 8 is the `pack-refs` proof, which is the "tests that prove nothing" shape the user's memory bans.

Fix: insert a read between `pack-refs` and `tag -d` (read → pack → read → delete → read) so the deletion acts on a packed-only ref, and reword Review
Focus 2 to what the case then pins: "a tag deleted after packing disappears from the list". Note for the implementer: git's files backend still takes a
`refs/tags/<name>.lock` on that delete, so even the reordered case does not isolate `packed-refs`; the `packed-refs` mtime is belt-and-braces and the
plan should say so rather than claim a test for it.

### I2 — plan:136–137, plan:40, plan:146: the real `localSeenStore()` adapter is never exercised

Review Focus 3 ("localStorage throws … → Task 3 cases") points at tests that inject an in-memory or throwing `SeenStore`. Those prove `unseen` /
`markSeen` tolerate a throwing port; they never run `localSeenStore()`, which is the only code that wraps `localStorage` in try/catch (spec:202 "try/catch").
A `localSeenStore` whose `get` lets the exception through passes every listed case.

Fix: two cases in `test/releases-client.test.ts`: (a) `globalThis.localStorage` stubbed with `getItem`/`setItem` that throw → `localSeenStore().get()`
is `null` and `.set('0.3.0')` does not throw; (b) `globalThis.localStorage` undefined (plain Node) → `get()` is `null`, `set` does not throw. Restore the
global in `finally`.

### I3 — plan:189–190: drawer geometry names two different breakpoints for the same range

"400px wide right panel on `≥ sm`" and "full screen below `md` like `.chat`" overlap between 640 and 767px (sm = 640, md = 768 per
`docs/subsystems/breakpoints.md:19–20`). `.chat` goes full screen below 768 (`client/src/styles.css:2019` is in the phone base rules; the 768 override is
at `styles.css:2104`), and the ✕ at 40px is likewise below 768 (`styles.css:2023`, `:2109`). An implementer has to guess which rule wins at 700px.

Fix: state one threshold — "full screen below `md` (768), 400px right panel from `md`" — which is what "like `.chat`" already implies.

### I4 — plan:41: Review Focus 4 names a "Task 4 render case" that Task 4 does not contain

Task 4's steps are implement, typecheck/build, browser check, commit (plan:193–199); there is no test. The empty-notes entry is actually pinned only by
Task 5's visual fixture (`0.2.1` fix with empty notes, plan:209), which is macOS-only and on demand (`.claude/CLAUDE.md` `pnpm test:visual`).

Fix: point Review Focus 4 at the Task 5 visual case explicitly (and the Task 4 step 3 manual check), or add a node-assert case for a pure
"entry view-model" function if the implementer extracts one. Do not leave it naming a test that does not exist.

## Minor

- plan:80: "§Repo layout if it lists `server/lib/*`" — it does (`docs/overview.md:177–200` lists `lib/usage-history.ts`, `lib/git-fetch.ts`,
  `lib/hub-widgets.ts`); make the `lib/releases.ts` row unconditional.
- plan:78: `server/index.ts` carries a route list in its header comment (`server/index.ts:8–20`); add `GET /api/releases` there too.
- plan:56: the shared `ReleaseType` (four members, includes `'baseline'`) shares its name with release-kit's exported `ReleaseType` (three members,
  `dist/esm/index.d.ts`, `src/conventional.ts:30`). Assignability holds because `Release.type` is `ReleaseType | 'baseline'` on the release-kit side
  (`src/read-releases.ts:11`), so this is naming only; a one-line comment in `shared/types.ts` would stop a future server import from mixing them.
- plan:183: the divider copy "Versioning starts here · v0.1.0" adds the version to the spec's "Versioning starts here" (spec:206); it matches the chosen
  mockup (artifact Variant A), so it is a deliberate extension — say so, since checklist readers will compare against the spec string.
- plan:187: "scratchpad copy of the artifact" is another session's scratchpad; the implementer has only the artifact link. The mockup's drawer is 360px
  (`.rel-drawer{width:360px}`) and its Fix badge uses `--amber`, while the plan says 400px and `--amber-ink`; the plan wins on both, just note the
  deltas so nobody "fixes" them back.
- plan:184: `unseen()` seeds the store as a side effect; computing it during render runs twice under React StrictMode. Harmless (the seed is idempotent)
  but say "in an effect or `useMemo`, not inline in JSX".
- plan:156: "assert whatever the implementation documents" pins implementation, not behaviour; pick `''` and assert it.
- plan:64, plan:119: the standalone-suite command skips `test/tmp-root.ts`, so fixtures land in the system tmp without the run-level cleanup
  (`test/tmp-root.ts:3–8`). `api-harness` removes its home and `GitFixture.cleanup()` exists, so only a failure path leaks; fine for a red/green check.
- plan:88: `sendJson(res, 200, await releasesPayload())` and plan:123's table row are the only literal code/copy in the plan; both are one-liners that
  pin a contract, within the plan's own "never literal code" convention as the user applies it.
- plan:14: "two pinned git-tag packages" — correct once Task 1 lands; today `package.json:38` has one.

## Verified facts (checklist 3–5)

- Create targets absent: `server/lib/releases.ts`, `test/api-releases.test.ts`, `client/src/lib/releases.ts`, `test/releases-client.test.ts`,
  `client/src/hooks/useReleases.ts`, `client/src/components/ReleasesDrawer.tsx`, `test/visual/fixtures/releases.ts`, `docs/subsystems/releases.md`.
- Modify targets present, with the named anchors: `test/server-deps.test.ts:17–18` (`ALLOWED`, `PINNED_SPEC`), `:68,70,73` (the three named cases);
  `.claude/CLAUDE.md:77` ("One npm package is allowed"); `server/index.ts:271` (`/api/account` route); `server/api.ts:942` (`serveAccount`), `:1591`
  (`sendJson`, module-private, so `serveReleases` must live in `api.ts` as the plan says); `server/lib/usage-history.ts:426` (`repoRoot`, walks up for
  `package.json`); `test/git-fixture.ts:16,31,66` (`GitFixture`, `git(cwd, args)`, `init`); `test/api-harness.ts:119` (`withServer`, in-process
  `createRequestListener`, so the `overrideReleasesRoot` seam reaches the handler); `client/src/components/SideRail.tsx:228` (`pick`), `:314–321`
  (`.foot`, gated on `live`); `client/src/App.tsx:34,83,96` (`AppShell`, `useAccount`, `SideRail`); `client/src/hooks/useBackClose.ts:13`
  (`useBackClose(onClose: () => void): void`); `client/src/components/Markdown.tsx:85` (`Markdown({ text })`); `client/src/styles.css:357`
  (`.nav.hid{transform:translateY(-100%)}` — the reason for rendering the drawer outside `.nav` holds), `:20,23,24,52,56` (`--green`, `--cyan`,
  `--red`, `--green-tint`, `--amber-tint`/`--amber-ink`), `:1584` (`.chat-x`); `test/visual/fixtures/index.ts:28` (`fixtures` map, GET-only,
  unmapped → 404 and the harness fails the case, `test/visual/mock-api.ts:5`, `harness.ts:13–15`); `docs/overview.md:64` (§HTTP surface, two-column
  table), `:332` (§Map); `docs/workflows/ci.md:53` (§Releases).
- Interfaces: Task 4 consumes only Task 3 names (`unseen`, `newestVersion`, `localSeenStore`, `markSeen`, `chipLabel`, `badges`, `displayTitle`,
  `formatReleaseDate`) plus existing `Markdown` and `useBackClose`; Task 2 consumes Task 1's `ReleasesResponse`; spellings match.
- Order: Task 1 step 2 runs the red `server-deps` before `pnpm add`; Tasks 1+2 commit together (plan:71–72, 124), so no red commit; Task 5's fixture
  follows Task 4's hook; nothing consumes a later task.
- Values: `chipLabel` strings, badge labels (Feature / Fix / Performance / Breaking), `dashboard.releases.lastSeen`, `v1.1.0 → 18af40f`, the PR title
  (`feat(releases): …` passes `^(feat|fix|perf)(\([a-z0-9-]+\))?!?: .+`), the case-4 tag message (parses to `type feat`, `scope releases`, `pr 216`,
  `url https://github.com/futin/claude-agents-dashboard/pull/216` under `src/read-releases.ts:22,50–55`, `src/conventional.ts:86–114`), the case-11
  filter (`src/git.ts:9`), and `'16 Oct 2026'` for `en-GB` short-month all check out.
- `test/outbound.test.ts:21,66` scans only `http/https/http2/net/tls/dgram` imports and `fetch(`; a `node:child_process` spawn in
  `server/lib/releases.ts` is not a network surface, so "outbound unchanged and green" (plan:23) is true. Its CLAUDE.md check (`:115–119`) only needs
  `lib/git-fetch.ts` to stay in the deps bullet, which Task 1 step 5's wording keeps.
- `GitFixture` clock: `commit()` advances 60s after each commit (`test/git-fixture.ts:63`), so baseline tag and the next version tag get distinct
  `creatordate`s in cases 4, 6 and 8 and release-kit's newest-first sort (`src/git.ts:48`) is deterministic.
