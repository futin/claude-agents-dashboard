# Plan review 1 — batched releases

Plan: `docs/superpowers/plans/2026-10-29-batched-releases.md` (commit `d1170ee`). Spec: `docs/superpowers/specs/2026-10-29-batched-releases-design.md`.
Code read at: release-kit `main` (`926e12d`, newest tag `v1.3.0`), ui-kit `main` (`2b2de23`, newest tag `v0.3.1`), dashboard worktree branch
`docs/batched-releases-spec` on top of `d80e3b4`.

## Verdict: APPROVE WITH FIXES

No Critical finding. Six Important findings, each a local edit to the plan; none changes the design.

## Coverage (checklist 1)

| Spec section / test case | Task |
|---|---|
| §1 template guide, no area prefix, good/bad example | C1 |
| §1 template states the `None` opt-out | C2 (deferred on purpose, plan:224) |
| §1 `None` never reaches a tag; one exported function shared by check and writer | A1 (`isNoneOptOut`, `releaseNotes`) |
| §1 CLAUDE.md §PR rules bullet | C1 |
| §1 CI check: releasing titles only, same extraction, `None` passes, opt-in input, inside `pr-title` | A2 |
| §1 re-runs on `edited` | dashboard `ci.yml:7` already has it; A2 README says callers must |
| §2 schedule: `DEFAULT_BRANCH` fallback, `onNewer` skip | A6 |
| §2 range unchanged, `no PR` skip | A4 |
| §2 nothing releasable → no tag, green | A4 (Review Focus 1) |
| §2 one tag on target, one Release | A4 |
| §2 bump = largest; breaking > feat > fix/perf | A3 (`Release-Type` ranking), A4 (`v0.6.0`, `v2.0.0`) |
| §2 items carry type, scope, breaking, pr, title, notes; title only when no notes | A3 (`:t` flag) |
| §2 grouping by title scope, unscoped last | A3 |
| §2 tag message constraints: trailer paragraph shape, no repeated key, never `Release-PR`/`Release-Scope` | A3 + Global constraint plan:21 |
| §2 old reader must not misread a rollup | A3 Review Focus 4 (`parseV130`) |
| §2 idempotence, repair, `a newer release exists` | A4 Review Focus 2; `onNewer` unchanged |
| §2 transition from per-PR tags | A5 fixture (baseline + 2 per-PR + 1 rollup) |
| §3 three-case `items` table | A3 (parse), A5 (reader) |
| §3 release-level `title`/`notes` unchanged for a rollup | A3 round-trip test |
| §3 `shared/types.ts` first | C2 |
| §3 release-kit minor `v1.x` | plan:27 `v1.4.0` |
| §4 ui-kit `Release.items`, type contract with fixtures | B1 |
| §4 one-item renders as today; multi-item grouped; tokens; class discipline | B2 |
| §4 mockups before UI code | B0 |
| §5 `release.yml` schedule `0 4 * * *`, drop push, keep dispatch + concurrency, rollup mode | C2 |
| §5 `ci.yml` `require-notes`, `kit-ref` pin | C2 |
| §5 bump pins | C2 (see I3: the bump PRs arrive on their own) |
| §5 docs `ci.md`, `releases.md` | C2 |
| §Order: `v1` moved by the user, exact pins during rollout | plan:28, plan:177, C2 |
| §Success: "every item merged after phase 1 carries notes or `None`" | enforced only from C2 (see M6) |
| Known limits: first scheduled run checked by its log | **no task** (see M5) |

Every spec test case named in the plan's Review Focus has a task. The one spec item with no task is the post-merge log check of the first scheduled run.

## Important

**I1 — plan:104 — A3 consumes `ReleaseItem` before A5 produces it.** `ParsedItem = Omit<ReleaseItem, 'url'>` names a type that plan:152 first exports in
A5 (`src/read-releases.ts`); release-kit `src/index.ts:1-10` exports no `ReleaseItem` today and `src/conventional.ts` imports nothing from
`read-releases.ts`. Building A3 as written fails `pnpm typecheck` at its step 4, or forces the implementer to invent the type. → Define `ParsedItem` in
`src/conventional.ts` in A3 as a standalone type (`{ pr; type; scope?; breaking; title?; notes }`) and have A5 derive `ReleaseItem = ParsedItem & { url?: string }`.

**I2 — plan:39-41 — the `Release-Items` grammar is ambiguous for a scope named `t`.** `release-kit/src/conventional.ts:4` allows any `[a-z0-9-]+` scope,
so `320:fix:t` reads both as "scope `t`, has notes" and "unscoped, title-only". Spec §2 requires that "the reader recovers every item field … without
ambiguity". → Use a flag character outside `[a-z0-9-]` (e.g. `~` or `?`), or fixed positions with an empty scope slot (`341:perf::t`); add the test case.

**I3 — plan:43-44 — an item whose own notes end a line with ` (#N)` for its own N ends the item early.** The parse rule stops at "the first line ending
` (#N)` where N is the next PR"; a note such as `- Finishes what (#336) started` inside PR 336's section shifts every later item's text. Review Focus 3
(plan:116) covers only a foreign PR number. Same spec constraint as I2. → Pick a rule and test it: simplest is for `formatRollupMessage` to put the marker
on the item's last line only after stripping a trailing ` (#<own pr>)` from the notes, or to require the parser to take the *last* such line before the
next item's marker. Either way add the self-reference case to A3 step 1.

**I4 — plan:177, plan:215 — "tag `v1.4.0`" / "tag `v0.4.0`" are not manual steps, and their side effects are missing.** release-kit's
`.github/workflows/self.yml:29-36` runs `release.yml` on every push to `main`, and ui-kit's `.github/workflows/release.yml:17-21` does the same through
`release-kit@v1`: the tag is cut from the squash PR's title, and a hand-made tag would collide. Both plan versions therefore hold only if each PR is titled
`feat:` and no other `feat` PR merges first. Then `self.yml:40-54` / ui-kit `release.yml:24-37` run `bump-consumers`, which opens auto-merge
`chore(deps): bump release-kit to v1.4.0` PRs in all four consumers (`scripts/bump-consumer.mjs:123,146`) and `bump ui-kit to v0.4.0` in three. → Replace
"tag vX" with "merge with a `feat:` title; `self.yml` / `release.yml` cut the tag", state the title requirement, and say what to do with the auto-opened bump
PRs in the dashboard (they go red, see I5, and C2 supersedes them) and in ui-kit (the release-kit one auto-merges; B1's held bump becomes a merge of `main`).

**I5 — plan:238 — `test/api-releases.test.ts` fails under release-kit `v1.4.0` and C2 does not say to update it.** The dashboard's route passes
release-kit's response through unchanged (`docs/subsystems/releases.md:15-17`), and the test pins whole release objects with `deepStrictEqual`
(`test/api-releases.test.ts:87`, `:113-121`): `items: []` on the baseline and a one-element `items` on `v0.2.0` make both fail. The plan lists the file as a
suite to run, not a file to modify. This is also why the auto-opened bump PR (I4) cannot auto-merge. → Add `test/api-releases.test.ts` to C2's Files with the
two expected `items` values, and note that the `chore(deps)` bump PR for release-kit stays red until C2 lands (close it, or let C2 carry the pin).

**I6 — plan:217-230 — C1 "ships now" but shares a branch and a `feat(releases)` PR with the held C2.** Part C names one worktree and one branch
(`feat/batched-releases`); C1 is a `docs:` commit meant to ship immediately, C2 is blocked on two external tags. `main` is PR-only (`.claude/CLAUDE.md:128`),
so C1 can ship now only as its own PR. → State that C1 is its own `docs:` PR from `main` (its own worktree or branch), and that C2 starts from `main` after
it merges.

## Minor

**M1 — plan:167** "`RELEASE_MODE=rollup` passes `mode: 'rollup'` to `runRelease`" cannot be asserted as written: `test/release-cli.test.ts:49` spawns the CLI
as a subprocess. → Assert by effect (two releasable commits → one tag) or export a parse helper and test that.

**M2 — plan:170** "the header comment no longer says 'on push' only": `release-kit/.github/workflows/release.yml:1` does not say "on push"; the README
caller example (`README.md:69-76`) is what shows a push trigger. → Point the wording at the README example (A6 step 3 already rewrites it).

**M3 — plan:91** "(the existing test keeps passing)": `test/workflows.test.mjs:54-60` checks only `github.event.pull_request.title` in `run:` lines. → Add a
body assertion so `PR_BODY` cannot regress into a `run:` line.

**M4 — plan:42** A message with `Release-Type` but neither `Release-PR` nor `Release-Items` (a hand-made tag; today's `parseTagMessage` returns its type
with `pr` undefined, `src/conventional.ts:103-114`) has no stated `items`. → Say `items: []`, type kept, and add it to A3's cases.

**M5 — plan:235** Spec §2 says the first scheduled run "is checked by its log" and the Known limits flag the 60-day public-repo schedule disablement; C2 has
no after-merge / not-verified line. → Add "first scheduled run's log checked by a human" to C2's not-verified list.

**M6 — plan:226** C1's CLAUDE.md bullet says notes are "required on `feat`/`fix`/`perf`" while the `None` escape only arrives in C2 and nothing enforces the
rule yet. → Either phrase it as "will be required" or add the `None` wording to the rule only (the template, which the writer prints, stays silent).

**M7 — plan:15** The spec and plan live on branch `docs/batched-releases-spec`; a Part C worktree cut from `main` will not contain them until that `docs:`
PR merges. → Note the prerequisite or reference the files by absolute path.

**M8 — plan:37, plan:44** A rollup item's `title` is the description only (prefix stripped by the formatter), while a per-PR item's `title` is
`ParsedTag.title`, which keeps the `type(scope)!: ` prefix (`src/conventional.ts:89`). ui-kit's `displayTitle` (`src/releases/logic.ts:28-33`) re-strips a
rollup title whose description itself begins `word: `. → State the asymmetry; optionally have B2 render item titles without `displayTitle`.

## Verified true (no finding)

- `ci-node.yml` has six inputs today (`release-kit/.github/workflows/ci-node.yml:10-33`) → seven after A2; `release.yml` has three (`:11-22`) → four after A6.
- `pr-title.mjs` imports from `dist/esm/conventional.js` (`scripts/pr-title.mjs:7`), so `checkNotes` in `conventional.ts` plus `pnpm build` is enough.
- `fake()` and `makeRepo` exist (`test/release.test.ts:22`, `test/fixtures/repo.ts:23`); `makeRepo().tag` writes with `--cleanup=verbatim` and `-F -`
  (`repo.ts:41`), so `###` lines in A5's fixture survive.
- `dist/` drift is tested (`test/dist-drift.test.ts:17`); plan:25 is right.
- `createRelease` builds the GitHub Release from `parseTagMessage().subject/.notes` (`src/release.ts:82-84`), so a rollup's Release body is the grouped list.
- Old-reader claim: `TRAILER` (`conventional.ts:83`) matches `Release-Items: …`; with `Release-Type` present and no repeated key the v1.3.0 parser returns
  the type, `pr`/`scope` undefined and the body as `notes` — Review Focus 4 as stated.
- ui-kit: `isReleasesResponse` validates no per-release field today (`src/releases/logic.ts:78-85`), so B1's item checks are additive; `type-contract.test.ts:13`
  is the assignability proof; `.uk-releases-pr`, `renderNotesHtml` and `sanitize` exist (`ReleasesPanel.tsx:5,13,44`).
- Dashboard: `ci.yml:7` triggers on `edited` and passes no `kit-ref` (`:21-28`); `release.yml:7-9` has the push trigger to drop; `ci.md:79` carries the
  "Delete the section" sentence; `shared/types.ts:796-821` has `Release`/`ReleasesResponse`; `test/server-deps.test.ts:31` accepts any `vX.Y.Z` release-kit pin.
- Fixtures discriminate: A3's four items span two scopes, two types plus a breaking flag, one title-only; A4's range mixes `fix`/`docs`/`feat` with the target
  on a `docs` commit in a second case; B1's `rollup` fixture has two scopes, one title-only, one breaking.
- The plan's own convention (behaviour and test cases, no literal code) holds throughout.
