# Review 1 re-check — Release Pipeline Phase C, part 1 plan

Plan: `docs/superpowers/plans/2026-10-16-release-pipeline-phase-c.md` · Spec: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` ·
Round 1: `docs/superpowers/reviews/2026-10-16-release-pipeline-phase-c-review-1.md`
Reviewer: Fable 5.1, 2026-10-16. Read-only. Scope: only the text that answers C1, I1–I6 and M1, M2, M5, M6, M11, M12. Untouched sections were not re-read.
Line numbers below are the plan's current ones (the file is untracked, so no diff exists; the changed text was located from the round-1 findings).

## Verdict: REVISE

Every round-1 finding in scope is addressed in the text, and the values are right. Two of the fixes interact with the copied `lookout-widgets` build and
break `npm run build` as written — both reproduced with `lookout-widgets`' own `tsc` 7.0.2 in a scratch project (see Probes). Nothing else new.

## Critical

**C1'. Plan:71–72 — the copied `tsconfig.esm.json` / `tsconfig.cjs.json` each re-declare `"types": []`, so the base-config fix never reaches the build.**
Step 1 says the three tsconfigs are copied "except `tsconfig.json` sets `"types": ["node"]`". `lookout-widgets/tsconfig.esm.json:8` and
`lookout-widgets/tsconfig.cjs.json:9` both set `"types": []` in their own `compilerOptions`, which overrides the inherited value. `scripts/build.mjs:11–12`
compiles with `-p tsconfig.esm.json` / `-p tsconfig.cjs.json`, never `tsconfig.json`, so `npm run typecheck` passes (probe A) while `npm run build` fails on
the first `node:` import with TS2591 "Cannot find name 'node:fs' … add 'node' to the types field" (probe B, exit 2); with `types: ["node"]` in the esm config
it passes (probe C). The drift test (:73) and Task 1 Step 4 (:75) then cannot go green. → Step 1: set `"types": ["node"]` in **all three** tsconfigs (or
delete the `types` line from the two build configs so they inherit it).

**C2'. Plan:134 + :29–30 — the `isMain` guard "as in `scripts/pr-title.mjs`" uses `import.meta.url`, which the cjs half of the build rejects.**
`release-kit/scripts/pr-title.mjs:36` is `realpathSync(fileURLToPath(import.meta.url))`. `lookout-widgets/tsconfig.cjs.json:4` sets `module: commonjs`,
and `tsc` 7.0.2 refuses `import.meta` under it: TS1343 "The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020' … 'nodenext'"
(probe D, exit 2); the same file compiles once excluded from the cjs project (probe E). The fix for I6 (cjs restored, :29–30, :60) and the fix for M6
(`import.meta` guard in `releases-json.ts`, :134) therefore cannot both be built; `release-cli.ts` (:192) will reach for the same idiom and fail the same
way. `lookout-widgets/src` has no `import.meta` (grep, 0 hits), which is why its build never met this. → Keep CLI entries out of the cjs project:
`tsconfig.cjs.json` `exclude`s `src/releases-json.ts` and `src/release-cli.ts`; `writeReleasesJson` moves into a library module (`read-releases.ts`) that
`index.ts` re-exports, and `releases-json.ts` becomes the thin CLI entry that `index.ts` does **not** import (otherwise `tsc` compiles it through the
import regardless of `exclude`). State in :134 that the guard is esm-only. (Alternative: a guard without `import.meta`; harder, since `__filename` does
not exist in the esm output.)

## Important

None.

## Minor

- M1'. Plan:77 — the new `workflows.test.mjs` assertion says "contains both"; round 1 asked for "in that order" (`typecheck` before `test`). Harmless; the
  loader at `ci-node.yml:+39.29–31` runs lines in file order either way.
- M2'. Plan:167–168, :179 — the guard rule is now exact, but the only test is the descendant case; the case the rule was written to exclude (an annotated
  `v*` tag on an unrelated branch → run proceeds) has no row. One test pins the `tagcommit != target` half; nothing pins the `--is-ancestor` half.
- M3'. Plan:217 "`concurrency` stays per-ref" — `self.yml:14–16` is `group: ci-…${{ github.ref }}`, `cancel-in-progress: true`, so a second push to `main`
  cancels a running `release` job. Safe by spec step 1 (a pushed tag without its Release is repaired by the next run), but the dashboard caller is required
  to use `cancel-in-progress: false` (spec:104–105); say in :217 that the kit accepts the cancellation deliberately.
- M4'. Plan:226 — correct as stated: `gh api repos/futin/release-kit/releases` returns 0 releases and `git log --first-parent v1.0.1..origin/main` is empty,
  so the first run's range is exactly `v1.0.1`'s commit plus the merge. Note that `v1.0.0`'s Release is never repaired (the range starts at the newest
  reachable tag) — worth one clause so the Held step does not read as "all Releases exist afterwards".
- M5'. Plan:167 — the guard needs every annotated `VERSION_TAG` tag with its peeled commit; `git.ts` (:128–130) exports only `versionTagsAt(cwd, sha)`.
  Task 3 Step 3's `for-each-ref` call (:149–150) is the same read; naming a shared helper would stop it being written twice. Implementer's call.

## Per-finding status

| Round 1 | Plan lines | Resolved | New problem |
|---|---|---|---|
| C1 `@types/node` | :27–28, :72 | yes — third dev dep, exact pin, `types: ["node"]` in `tsconfig.json` | **C1'** (build configs override it) |
| I1 `workflows.test.mjs` | :61, :76–77 | yes — in Modify list; :94's regex replaced by a both-commands assertion | M1' |
| I2 inclusive range | :183–184 | yes — `rev-parse <base>^{commit}` then `<base>..<target>`; base == target yields the base alone | — |
| I3 guard rule | :166–168 | yes — annotated `VERSION_TAG`, `merge-base --is-ancestor <target> <tagcommit>`, `tagcommit != target`, run first | M2', M5' |
| I4 fixture remote | :136–138 | yes — `makeRepo({ bareOrigin })` → `origin?`, `setOrigin(url)`; :146 and :159/:206 consume it | — |
| I5 `self.yml` release job | :215–217, :226–229 | yes — job `release`, `if: push`, job-level permissions, `uses: ./…/release.yml`, `kit-ref: ${{ github.ref_name }}`; first run recorded | M3', M4' |
| I6 esm + cjs | :29–30, :59–60, :67 | yes — spec:222 kept; `tsconfig.cjs.json` created; `exports` has `require` | **C2'** (with M6) |
| M1 `src/index.ts` | :59, :69 | yes | — |
| M2 bump rows | :100–101 | yes — `perf` non-breaking at major ≥ 1 → `1.4.3`; breaking `perf` → `2.0.0` / `0.5.0`; matches spec:126–130 | — |
| M5 `fetch-depth` | :210 | yes — `'0'`, `workflows.test.mjs:12–13` confirms BaseLoader keeps strings | — |
| M6 `isMain` guard | :134 | yes | **C2'** |
| M11 `pr` source | :92 | yes — `Release-PR` trailer | — |
| M12 body `BREAKING CHANGE:` on `docs:` | :173 | yes — `docs: b (#2)` with the line → `not-releasing` | — |

## Checklist over the changed text

1. **Coverage.** Spec:222 (cjs), :216 (`self.yml` calls both), :258 (runs recorded: :227, :249, :251), :239 (every bump row), :122 (ignored body line),
   :108–111 (inclusive range, descendant guard): all now have plan text.
2. **Values.** Bump rows match spec:126–130; guard text `a newer release exists: <tag>`; `kit-ref` default `v1`; `fetch-depth` `'0'`.
3. **Reality.** `lookout-widgets/tsconfig.cjs.json` exists (round 1's reality list omitted it; "copy" at :71 is true). `self.yml:4–9` has `push: main`
   so `if: github.event_name == 'push'` fires on the merge. `workflows.test.mjs:91–95` is the assertion :76–77 replaces; `:42–46` already forbids
   `name:` on every `self.yml` job, so the new job is covered without a new test. `pr-title.mjs:35–41` is the guard :134 cites. release-kit tags:
   `v1` lightweight at `eab23ed`, `v1.0.0`/`v1.0.1` annotated, no commits past `v1.0.1`, zero GitHub Releases (`gh api …/releases` → 0).
   `.gitignore` ignores `node_modules/` only, so `dist/` and `package-lock.json` commit. `@types/node` is absent from both sibling repos' lockfiles, as
   round 1 said; the dashboard's is `20.19.43`, so "newest `22.x`" at :28 is a fresh install, not a copy.
4. **Interfaces.** `makeRepo` → Tasks 4–5; `git`/`VERSION_TAG`/`DESCRIBE_FILTER`/`versionTagsAt` → Task 4; `runRelease` → Task 5. All spelled consistently.
5. **Order.** Unchanged; Step 4b sits after `release.yml` exists and before the Held step that needs it.
6. **Tests.** :173 (M12) and :179 (I3) would fail before implementation. :77 pins the new commands. Gap: M2'.
7. **Conventions.** No literal code added; 160-column wrap held.

## Probes (scratch project, `lookout-widgets/node_modules/typescript` 7.0.2, `@types/node` symlinked from the dashboard, `package.json` `"type": "module"`)

- A `tsc -p tsconfig.json` with `types: ["node"]`, a `node:` import and an `import.meta.url` guard → exit 0.
- B `tsc -p tsconfig.esm.json` copied verbatim (`types: []`) → exit 2, TS2591 on every `node:` import and `process`.
- C same with `types: ["node"]` in the esm config → exit 0.
- D `tsc -p tsconfig.cjs.json` with `types: ["node"]` → exit 2, TS1343 on `import.meta`.
- E same with the `import.meta` file `exclude`d → exit 0, `git.js` emitted.
