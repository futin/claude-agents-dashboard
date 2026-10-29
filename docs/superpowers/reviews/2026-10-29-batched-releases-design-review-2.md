# Review 2 — Batched releases with readable notes

Document: `docs/superpowers/specs/2026-10-29-batched-releases-design.md` (174 lines, at `98afcf6`, reviewed 2026-10-29). Round 1 is
`2026-10-29-batched-releases-design-review-1.md`; its four Important findings are all addressed in this revision (lines 79–83, 76–77, 125–127, 105–108) and
are not repeated. Code read: release-kit at `926e12d` (`v1.3.0`): `src/conventional.ts`, `src/release.ts`, `src/release-cli.ts`, `src/read-releases.ts`,
`src/releases-reader.ts`, `src/git.ts:9-61`, `.github/workflows/{release,ci-node,bump-consumers}.yml`, `scripts/pr-title.mjs`, `README.md:199-237`; ui-kit at
`2b2de23` (`v0.3.1`): `src/types.ts`, `src/releases/{ReleasesPanel.tsx,logic.ts}`, `test/type-contract.test.ts`, `package.json`; dashboard:
`.github/workflows/{ci,release}.yml`, `.github/pull_request_template.md`, `docs/workflows/ci.md:23-89`, `docs/subsystems/releases.md:14-56`,
`shared/types.ts:789-821`, `server/lib/releases.ts`, `client/src/components/ReleasesDrawer.tsx:1`, `test/api-releases.test.ts`, `test/server-deps.test.ts`,
`package.json:39-43`, the `v0.1.0` tag; sibling consumers' `package.json` and release tests (backlog-manager, guide-manager, lookout).

## Verdict: APPROVE WITH FIXES

Nothing contradicts the code or a CLAUDE.md rule. Three places leave the implementer guessing a field's value, and one of those guesses (an empty
release-level `notes` on a rollup) would ship an empty GitHub Release body against line 93. All three are text fixes.

## Facts verified true (new or changed since round 1)

| Doc line | Claim | Evidence |
|---|---|---|
| 57 | `## What's new` heading is outside the comment, the hint inside; untouched template yields empty notes | `.github/pull_request_template.md:18-20`; `src/conventional.ts:63-68` strips comments first |
| 62 | per-PR output unchanged for PRs without the marker | `src/conventional.ts:75-81` writes `notes` verbatim; only a `None` section changes |
| 66 | same title regex as `pr-title` | `scripts/pr-title.mjs:7` → `checkTitle`, `src/conventional.ts:4` `RELEASING` |
| 66 | extraction = comments stripped, up to next `## ` (plus the `🤖 Generated with` stop, see Minor) | `src/conventional.ts:61-69` |
| 69 | `ci.yml` triggers on `edited` | `.github/workflows/ci.yml:7` |
| 70–72 | `pr-title` is a PR-only job in `ci-node.yml`; the ruleset requires `ci / pr-title` by name, so a new step changes no required context | `ci-node.yml:1,79-97`; `docs/workflows/ci.md:23,47` |
| 79–80 | `DEFAULT_BRANCH` from `github.event.repository.default_branch`; CLI exits on empty | `release.yml:54`; `release-cli.ts:104-105` |
| 83 | `onNewer` is `skip` unless `workflow_dispatch` | `release-cli.ts:107` |
| 85 | range = first-parent since newest reachable `vX.Y.Z`; `no PR for <sha>` skip | `release.ts:142-153`, `:99` |
| 89 | bump table breaking > feat > fix/perf (below 1.0.0 breaking = minor, same as feat) | `conventional.ts:49-55` |
| 93 | tag subject and notes are the GitHub Release title and body | `release.ts:81-85` (`parseTagMessage` → `createRelease(tag, subject, notes)`) |
| 97 | `--cleanup=verbatim` | `release.ts:74` |
| 99–100 | reader lists every local `v*` tag; dashboard fetches pinned repos itself | `git.ts:61` (`for-each-ref refs/tags/v*`), `server/lib/git-fetch.ts` (round 1) |
| 101–102 | `baseline` unless final paragraph is all distinct trailers with a valid `Release-Type` | `conventional.ts:99-101` |
| 103–104 | old reader on such a rollup: subject as title (no `(#N)` to strip), pre-trailer body as notes, no `pr` | `conventional.ts:88-89,109,113` |
| 105–106 | `Release-PR` → `url` → `PR #N` link for the whole entry | `read-releases.ts:64-67`; `ReleasesPanel.tsx:44-48` |
| 109–110 | already-released / release-repaired / `a newer release exists: <tag>` on dispatch | `release.ts:89-94,135-140` |
| 115 | `createReleasesReader` is what the dashboard calls | `server/lib/releases.ts:3,20` |
| 117 | `shared/types.ts` `ReleasesResponse`; add-an-API-field rule | `shared/types.ts:817`; `.claude/CLAUDE.md` §Code rules |
| 121 | README reserves `v2` for a breaking change to inputs or job names | `release-kit/README.md:227` |
| 125–127 | ui-kit owns a type copy with no runtime dep; dashboard client renders ui-kit's type; contract test proves assignability | `ui-kit/src/types.ts:1-2`; `client/src/components/ReleasesDrawer.tsx:1`; `ui-kit/test/type-contract.test.ts:13-14` |
| 136–137 | dashboard `release.yml`: `push` + `workflow_dispatch` with `sha`; `concurrency: release`, `cancel-in-progress: false` | `.github/workflows/release.yml:7-15,21-24` |
| 139 | `ci.yml` passes no `kit-ref` (default `v1`) | `.github/workflows/ci.yml:21-28`; `ci-node.yml:30-33` |
| 140 | pins: release-kit `v1.3.0`, ui-kit `v0.3.1`; `server-deps` accepts any exact `vX.Y.Z` | `package.json:42-43`; `test/server-deps.test.ts:29-31` |
| 141 | the sentence to replace | `docs/workflows/ci.md:79` |
| 151 | `kit-ref` must equal the `uses:` ref | `release.yml:16-19`, `ci-node.yml:30-33`, dashboard `release.yml:4` |

## Important

**[I] spec:115–116, 129 — the baseline tag's item list is unspecified, and this repo has one.** `v0.1.0` is `Baseline — versioning starts here` with no
trailers (type `baseline`, no PR). The spec says "A per-PR tag reads as a release with exactly one item, so consumers handle one shape" and "A one-item
release renders exactly as today", but a baseline is neither a per-PR tag nor a rollup: it has no PR, no type, no notes. ui-kit renders it as a divider on
`type === 'baseline'` (`ui-kit/src/releases/ReleasesPanel.tsx:19-27`; `docs/subsystems/releases.md:56`), and `test/api-releases.test.ts:87` pins its
exact shape. An implementer must guess 0 items or 1 item-without-PR, and whether "highest type across items" (line 116) applies to an empty list.
→ State: a baseline reads with `items: []` and `type: 'baseline'` (the release-level fields unchanged), the drawer's baseline branch is untouched, and the
"one shape" sentence names all three cases: baseline (0 items), per-PR (1), rollup (N ≥ 1).

**[I] spec:93, 115–116 — what the new reader puts in a rollup's release-level `title` and `notes` is unstated, and the GitHub Release body depends on it.**
Line 116 says only `type`/`breaking` "stay meaningful". `release.ts:83-84` builds every GitHub Release from `parseTagMessage(...)`: `subject` becomes the
title and `notes` the body. If the builder moves the grouped list into `items` and leaves release-level `notes` empty (a natural reading of "items
alongside the existing release-level fields"), every rollup Release on GitHub ships with an empty body, contradicting line 93 ("it is also the GitHub
Release body"). The drawer spec (129–130) also never says whether release-level `notes` is rendered for a multi-item release, so a drawer could show the
list twice. → State: for a rollup, `title` is the tag subject and `notes` is the pre-trailer body exactly as `parseTagMessage` returns them today (so old
and new readers agree on release-level fields and `createRelease` needs no change); `items` is parsed in addition; the drawer renders `items`, never
release-level `notes`, when `items.length > 1`.

**[I] spec:90, 94, 96 — per-item `title` must be recoverable from the tag message, but the message described carries notes *or* title.** Line 90 lists
`title` among the item fields, line 96 requires "every item field listed above" recoverable without ambiguity, yet line 94 describes each item as "its
notes followed by its PR number" and lines 91 and 130 say an item shows "its notes (or title)". A builder satisfying 96 must write the PR title into every
item even when it has notes — doubling each line against the ten-second-scan goal (line 20) — or satisfy 94 and leave `title` unrecoverable for items
with notes. → Pick one: either item `title` is required only when the item has no notes (it is then the displayed line), or the message carries the title
for every item and line 94 says so.

## Minor

- spec:27 vs 157 — "One version per day at most" / "at most one version a day" is not what §5 builds: a manual dispatch plus the schedule can cut two
  (line 166 recommends the dispatch for urgent entries). Say "at most one scheduled version a day".
- spec:95 — the example subject `Kaizen, Routines — 5 changes` capitalises scopes, but a title scope is `[a-z0-9-]+` (`conventional.ts:4`) and ui-kit shows
  scopes nowhere today (`logic.ts:30-36` strips them). Say whether the subject (and the drawer's group heading, line 130) capitalises.
- spec:95 — a rollup of exactly one item: `Kaizen — 1 change`? The subject rule should name the singular, or allow the PR title as subject for one item.
- spec:94 — item notes may hold blank lines (multi-paragraph notes are written verbatim today, `conventional.ts:80`), so the builder's item delimiter cannot
  be "a blank line". Worth naming as a constraint beside line 96.
- spec:63 — `scripts/pr-title.mjs:7` imports from the committed `dist/esm/conventional.js` (`git ls-files dist` lists it), so the shared `None` function
  reaches CI only when `dist/` is rebuilt and committed in the same release-kit PR. One clause saves a green-locally, red-in-CI round.
- spec:140 — bumping the release-kit pin fails `test/api-releases.test.ts:87,113` (`deepStrictEqual` on the whole release object) until the fixtures gain
  `items`, so the automatic `chore(deps): bump release-kit` PR will be red until the adoption PR lands. The other callers assert only versions and
  `current` (`guide-manager/test/releases.e2e.test.ts:117-137`; backlog-manager no whole-object assert), which supports anti-goal line 50.
- spec:169 — `+N` is `git describe --long` (`read-releases.ts:42-44`), so it counts every first-parent commit since the tag, `docs:` merges included; "the
  hours between a merge and the next run" reads as releasable merges only. True today as well.
- spec:66–67 (round 1, still open) — the parenthetical omits the second stop, a line starting `🤖 Generated with` (`conventional.ts:67`).
- spec:8, 12 (round 1, still open) — 50 tags / 13 days ≈ 115 a month; "last 48" is an unexplained window.

## Edge cases checked and found covered

Empty range and docs-only days (87); re-run on a tagged target and missing Release (109); dispatch behind a newer tag, schedule as `skip` (83, 110); `no-pr`
commits mid-range (85); old reader on a rollup tag with no `Release-PR`/`Release-Scope` (99–108); new reader discriminator (107); `None` in per-PR mode
(61–62); PR with no body (`extractWhatsNew(null)` → `''`, fails a releasing title, intended by 66); `None — <reason>` (68); retitled bump PRs
(`fix(deps):`, README:199–200 already asks for a `What's new` section, so the check agrees with release-kit's own guidance); `chore(deps)` bump PRs never
checked; `edited` re-run (69); schedule disabled after 60 idle days (167–168); overlapping schedule and dispatch (137); `DEFAULT_BRANCH` fallback and
first-run log check (79–83); reusable-workflow input rejection and the exact-tag rollout pin on both callers (139, 151); release-kit minor not major
(120–121, README:227); failure of `gh` mid-range leaves no tag and the next day's run retries (today's throw path, `release.ts:97-99`, `release-cli.ts:114-117`).
Not covered: baseline items (Important 1); release-level `notes` on a rollup (Important 2); per-item `title` (Important 3).

## Scope and hard rules

Out-of-scope items are named (35–42) and nothing in scope depends on them. CLAUDE.md rules touched: add-an-API-field order (117, respected);
`server/` dep pinned to an exact `vX.Y.Z` tag (140, `test/server-deps.test.ts:31` accepts it); `styles.css` never restyles `.uk-*` (drawer change lives in
ui-kit, 123–132, respected); `main` PR-only (every step is a PR, respected); mockups-before-UI memory rule (131–132, respected); "a figure measured off
this machine carries its date" (8, 12, 167, respected). No `.claude/rules/` directory exists in the worktree.
