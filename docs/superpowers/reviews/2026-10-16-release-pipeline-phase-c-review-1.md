# Review 1 — Release Pipeline Phase C, part 1 plan

Plan: `docs/superpowers/plans/2026-10-16-release-pipeline-phase-c.md` · Spec: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md`
Reviewer: Fable 5.1, 2026-10-16. Read-only; every code claim below was checked against the three repos or a scratch git repo.

## Verdict: REVISE

One Critical (the copied tsconfig cannot typecheck the code the plan adds), six Important. Coverage of the spec is otherwise complete for the declared
scope; values match; the git mechanics the plan relies on (`--exclude` glob, `%00` separators, `--verify-tag`) were probed and hold.

## Critical

**C1. Plan:27, :70 — `lookout-widgets`' tsconfig cannot typecheck `node:` imports; the dev-dep list forbids the fix.**
`lookout-widgets/tsconfig.json:9` sets `"types": []`, and `lookout-widgets/src` has zero `node:` imports (grep, 0 files); there is no `@types/node` in
its `node_modules/@types` or `package-lock.json`. release-kit's `git.ts` (`execFile`), `read-releases.ts`, `releases-json.ts` (fs) and
`release-cli.ts` all import Node built-ins, so `tsc -p tsconfig.json` fails with "Cannot find module 'node:child_process'" from Task 3 Step 4 on —
and Global Constraints :27 ("Dev only: `typescript`, `tsx`") rules out the only fix. → Add a pinned `@types/node` as a third dev dep, set
`"types": ["node"]` in `tsconfig.json`, and amend :27.

## Important

**I1. Plan:75 — "`workflows.test.mjs` still passes" is false.** `release-kit/test/workflows.test.mjs:94` asserts `self.yml`'s `check-commands` matches
`/node --test 'test\/\*\*\/\*\.test\.mjs'/`; Step 5 replaces it with `npm run typecheck` / `npm test`, so Task 1 ends red. → Add
`test/workflows.test.mjs` to Task 1's Modify list and state the new assertion (both commands present, in that order).

**I2. Plan:176–177 — the range command excludes the base the sentence calls inclusive.** `git rev-list <base>..<target>` omits `<base>`; probed:
`v0.1.0..v0.1.0` → 0 commits. Spec:108–109 needs the base commit in the range so a missing Release is repaired. The test at :165 would catch it, but the
plan states the wrong command. → "prepend `git rev-parse <base>^{commit}` to the rev-list output" (or `--boundary`), never `<base>..`.

**I3. Plan:161, :172 — the "newer release exists" guard has no detection rule.** Spec:110–111 says "a `v*` tag on a descendant commit"; the plan only
names the rejection text. `for-each-ref --no-merged=<target>` (the obvious guess) also rejects tags on unrelated branches. → Specify: every annotated
`VERSION_TAG` tag whose commit is a strict descendant of target (`git merge-base --is-ancestor <target> <tagcommit>` and not equal), checked once before
any per-commit step.

**I4. Plan:132–133 vs :141, :154, :199 — `makeRepo()` produces no remote, three tasks consume one.** Task 3's `url` test needs `origin` set to a URL;
Tasks 4 and 5 push tags to a bare origin. The fixture interface has `dir/commit/tag/cleanup` only. → Add `setOrigin(url)` and a bare-origin option to
the Task 3 fixture interface so Tasks 4–5 consume what Task 3 produces.

**I5. Plan:212–216 — spec:216 (`self.yml` "calling the two above") and spec:258 ("verified by real runs on release-kit itself") have no task.** The plan
never wires `release.yml` into `self.yml` and tags `v1.1.0` by hand; no release-kit run is recorded as proof. → Either add a `release` job to `self.yml`
(`on: push: main`, `uses: ./.github/workflows/release.yml`), let the PR's `feat:` title cut `v1.1.0` and have the Held step only move `v1` — or state
the deviation in Global Constraints and in the release-kit PR.

**I6. Plan:28 — ESM-only contradicts spec:222 ("esm + cjs").** Declared as a deviation "reviewer may push back", but it is a change to the published
`exports` contract and spec:268 has other apps adopting the reader. → Resolve before Task 1: amend spec:222 with the user's decision, or keep the cjs
half (one `tsconfig.cjs.json` + two lines in `build.mjs`, as `lookout-widgets/scripts/build.mjs:12–14`).

## Minor

- M1. Plan:58–59 — Task 1's Create list omits `src/index.ts`, which :68 requires.
- M2. Plan:96–98 — bump rows miss `perf` at major ≥ 1 and breaking `perf`; spec:239 says "every row, at major 0 and major ≥ 1".
- M3. Plan:108–109 — trailer order Type/Scope/PR/Breaking (spec:148–151) is exact-string pinned only for a scope-less, non-breaking `fix`.
- M4. Plan:166 — spec:242 wants three unreleased commits → three tags; the plan's three commits yield two tags. Order is still pinned; note only.
- M5. Plan:203 — `BaseLoader` keeps scalars as strings (`workflows.test.mjs:13`); assert `fetch-depth === '0'`, not `0`.
- M6. Plan:131 — `releases-json.ts` is both re-exported from `index.ts` and a CLI; it needs an `isMain` guard like `scripts/pr-title.mjs:35–41` or
  importing the package runs the CLI. Unstated.
- M7. Plan:191 — how a 404 from `gh api …/pulls/<n>` is told apart from other failures (stderr `HTTP 404`) is unstated; any non-zero `gh release view`
  reads as "missing", after which `gh release create` fails loudly — acceptable, say so.
- M8. Plan:216 — `refs/tags/v1` is lightweight (points at a commit); `refs/tags/v1.1.0` points at a tag object. Compare against
  `git rev-parse v1.1.0^{commit}`.
- M9. Plan:226 — hint text differs in wording from spec:160–161; it is an HTML comment, not a contract.
- M10. Plan:144 `refs/tags/v*` vs spec:184 `refs/tags/v[0-9]*`; both are followed by the `VERSION_TAG` filter. Harmless.
- M11. Plan:89–90 — whether `pr` comes from the `Release-PR` trailer or the subject `(#N)` is unstated; the round-trip only pins equality.
- M12. Spec:121–122 ("`BREAKING CHANGE:` in the body of a non-releasing type is ignored") has no test; give Task 4's `docs: b (#2)` a body with that
  line and expect `not-releasing`.
- M13. Plan:106/:226 — the template fixture lives in release-kit and the template in the dashboard; the sync is by hand across two repos. Stated; fine.

## Checklist results

1. **Coverage.** Spec §Phase C → Tasks 2–6; §Tag message → Task 2; §Baseline → Held (dashboard) 3–4; §release-kit repo → Tasks 1–5 except `self.yml`
   calling `release.yml` (I5) and cjs (I6); §Testing release-kit rows → Tasks 2–5 (gaps M2, M4, M12); §Rollout 4–5 → Held steps; §App/§Dependency/§UI
   and Rollout 6 → explicitly "Not in this plan" (:241–244), matching spec §App "own plan". Phase A/B sections belong to earlier plans.
2. **Values.** Bump table, `formatTagMessage` exact string, warning texts (`no PR for <sha>`, `no baseline tag`, `a newer release exists: <tag>`), baseline
   subject, tagger identity, workflow inputs/permissions/concurrency all match the spec.
3. **Reality.** Verified present: `release-kit/scripts/pr-title.mjs` with `checkTitle`, `RULE`, `described()` (:7–33); `test/pr-title.test.mjs`,
   `test/workflows.test.mjs`, `.github/workflows/self.yml`, `README.md` §Moving `v1`; `lookout-widgets` `tsconfig.json`, `tsconfig.esm.json`,
   `scripts/build.mjs`, `test/dist-drift.test.ts`, devDeps `typescript 7.0.2` / `tsx 4.23.15`; dashboard `.github/pull_request_template.md` (`## Why this
   shape` at :18, footer at :117), `docs/workflows/ci.md:50–51` stale sentence, `.claude/CLAUDE.md:115` "cut a release once Phase C lands", the
   uncommitted CI-gate line in `git diff`. Verified absent: `release-kit/src`, `dist`, `tsconfig*`, `package-lock.json`, `test/fixtures/repo.ts`,
   `test/fixtures/fake-gh-release.sh`, `test/fixtures/pull_request_template.md`; dashboard `.github/workflows/release.yml`. futin/backlog-manager#279
   is MERGED (2026-10-15, `gh pr view`). release-kit tags: `v1` lightweight, `v1.0.0`/`v1.0.1` annotated → `v1.1.0` is the right next tag.
   `ci-node.yml:58–59` installs via `npm ci` from `package-lock.json`; `:84–97` runs `pr-title.mjs` from the kit checkout with no install, so the
   committed `dist/` is load-bearing and `.gitignore` does not exclude it.
4. **Interfaces.** Task 2 → 3 → 4 → 5 names and types line up (`ReleaseType`, `TitleCheck`, `DESCRIBE_FILTER`, `VERSION_TAG`, `git`, `versionTagsAt`,
   `runRelease`, `GitHubPort`, `Log`). Gap: the fixture remote (I4).
5. **Order.** Tasks are sequential; Task 6 depends on the release-kit Held step (`@v1` must point at a kit with `release.yml`), which the plan enforces
   by placing it between Tasks 5 and 6.
6. **Tests.** Review Focus 1–5 each have a pinning test (:44, :107, :137/:173, :168, :108). All Step 1 tests precede implementation and assert behaviour.
   The Task 4 inclusive-range test (:165) would catch I2; nothing catches I3's unrelated-branch case.
7. **Conventions.** "Behaviour, never literal code" is held throughout; 160-column wrap is held; no size budget stated.

## Probed in a scratch repo (git 2.x, this machine)

- `git describe --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude 'v*[!0-9.]*'` with annotated `v1.2.3-rc1` on a later commit → `v0.1.0`; without
  `--exclude` → `v1.2.3-rc1`. The refinement at :34 is necessary and the `[!…]` glob is accepted.
- `git for-each-ref --format='…%00…' 'refs/tags/v*'` emits NUL separators; `objecttype` is `tag` for annotated, `commit` for lightweight.
- `git rev-list --first-parent --reverse v0.1.0..v0.1.0` → 0 commits (I2).
- `gh release create --verify-tag` exists in the installed `gh`.
