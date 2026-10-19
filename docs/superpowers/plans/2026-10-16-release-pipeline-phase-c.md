# Release Pipeline — Phase C, part 1 (release parts + dashboard release workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim and a bug in the plan becomes a bug in the branch. Where a step says "implement", the implementer writes the code and may
> disagree with the plan; say so in the task report rather than bending the code to the text.
>
> **Dictation rule (spec §Rollout) holds:** the two workflow files (release-kit `release.yml`, dashboard `release.yml`) are dictated for the user to type,
> unless the run is under `/autopilot`, which then says so in its report and walks the user through each file. Everything else is done directly.

**Goal:** Every merged `feat`/`fix`/`perf` PR into a release-kit app's `main` becomes an annotated `vX.Y.Z` tag plus a GitHub Release, and release-kit
exports the reader the dashboard's `/api/releases` will call — ending with this repo tagged `v0.1.0` and its release workflow live.

**Architecture:** release-kit (`/Users/andrejajevtic/Documents/custom-projects/release-kit`) grows a TypeScript `src/` compiled into a committed
`dist/` (esm + cjs), copying `lookout-widgets`' build: `conventional.ts` (pure: title, bump, notes extraction, tag-message contract), `git.ts` (the shared
`vX.Y.Z` filter and describe call), `read-releases.ts`, `releases-json.ts`, `release.ts` (the per-commit engine over an injected GitHub port) and
`release-cli.ts` (the `gh` adapter the workflow runs). A reusable `release.yml` checks out the app and the kit and runs the CLI. The dashboard gets a caller
`release.yml`, a `## What's new` section in its PR template, and docs; its API and UI are **part 2** (own plan, after mockups — spec §App).

**Tech Stack:** TypeScript 7 + `tsx` (dev only), Node 22 ESM, `node:test`, git CLI, `gh` CLI, GitHub Actions `workflow_call`.

**Spec:** `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` (§Phase C, §release-kit repo, §Testing release-kit half, §Rollout steps 4–5)

## Global Constraints

- release-kit stays **zero runtime dependencies**. Dev only: `typescript` `7.0.2`, `tsx` `4.23.15` (the versions `lookout-widgets` pins, 2026-10-16), and
  `@types/node` at the newest `22.x`, pinned exact — `lookout-widgets` needs none (its `src/` imports no `node:` module), release-kit's does.
- `dist/` is committed and must equal a fresh build of `src/` (drift test). Built as **esm + cjs + `.d.ts`**, exactly as `lookout-widgets` ships it
  (spec §release-kit repo); other apps consume the same `exports`.
- **`v1` contract unchanged:** `ci-node.yml` inputs, jobs and job ids untouched; `scripts/pr-title.mjs` keeps its path, its `checkTitle` export and its
  CLI behaviour (the existing `test/pr-title.test.mjs` passes unmodified).
- Releasing types `feat|fix|perf`; title regex is `checkTitle`'s, never re-declared.
- Version tags: annotated, name matches `^v\d+\.\d+\.\d+$`. Every describe uses `--match 'v[0-9]*.[0-9]*.[0-9]*' --exclude 'v*[!0-9.]*'` and never
  `--tags` (the `--exclude` is a refinement of the spec: it keeps an annotated `v1.2.3-rc1` from becoming a base version). One constant in `git.ts`.
- Tag message contract, verbatim from spec §Tag message; `git tag -a … --cleanup=verbatim` always.
- PR titles and bodies reach processes only as `execFile` argv elements or files, never through a shell or `${{ }}` inside `run:`.
- Tagger identity in the workflow: `github-actions[bot]` / `41898282+github-actions[bot]@users.noreply.github.com`.
- Authored prose wraps at 160 columns; commit bodies at 72; Conventional Commits subjects. Dashboard repo rules apply in full (`.claude/CLAUDE.md`).
- release-kit work happens on branch `feat/release-parts` and lands by PR; dashboard work on `ci/release-workflow`, PR titled `ci(release): add release workflow`.

## Review Focus

1. **Hostile title or body text** — a PR titled `feat: $(touch /tmp/pwned)` with a body containing backticks must be tagged and released as literal text.
   Pinned in Task 5 (CLI test with a fake `gh`).
2. **CRLF bodies** — PR bodies edited in the GitHub web UI arrive with `\r\n`; `## What's new` must still be found and the notes carry `\n` only. Task 2.
3. **Tags that are not releases** — a lightweight `v9.9.9`, the floating `v1`, an annotated `v1.2.3-rc1`: none may become the base version, `current`, or
   a list entry. Tasks 3 and 4.
4. **Re-running a target already released** — a second run (GitHub "Re-run", or the next push's range) must change nothing and end green: no duplicate
   tag, no second Release. Task 4.
5. **Notes whose last paragraph looks like trailers** — notes ending in `Note: see #12` must survive the round-trip; only the final `Release-*` block is
   trailers. Task 2.

---

### Task 1: TypeScript toolchain, `checkTitle` moves to `src/conventional.ts`

**Files:**
- Create: `release-kit/src/conventional.ts`, `release-kit/src/index.ts`, `release-kit/scripts/build.mjs`, `release-kit/tsconfig.json`,
  `release-kit/tsconfig.esm.json`, `release-kit/tsconfig.cjs.json`, `release-kit/package-lock.json`, `release-kit/dist/{esm,cjs}/**`
- Modify: `release-kit/package.json`, `release-kit/scripts/pr-title.mjs`, `release-kit/.github/workflows/self.yml`, `release-kit/test/workflows.test.mjs`
- Test: `release-kit/test/dist-drift.test.ts`, existing `release-kit/test/pr-title.test.mjs` (unmodified)

**Interfaces:**
- Produces: `checkTitle(title: string): TitleCheck` and `type TitleCheck = { ok: boolean; type?: string; scope?: string; breaking: boolean; reason?: string }`
  from `src/conventional.ts`; `scripts/pr-title.mjs` re-exports `checkTitle` from `../dist/esm/conventional.js` and keeps its CLI block.
- `package.json`: `exports` `"."` → `{ types: ./dist/esm/index.d.ts, import: ./dist/esm/index.js, require: ./dist/cjs/index.js }`; `files: ["dist"]`; scripts `build`
  (`node scripts/build.mjs`), `typecheck` (`tsc -p tsconfig.json`), `test` (`node --import tsx --test 'test/**/*.test.mjs' 'test/**/*.test.ts'`).
  `src/index.ts` re-exports the public surface (grows in Tasks 2–4).

- [ ] **Step 1:** Copy `lookout-widgets`' `tsconfig.json` / `tsconfig.esm.json` / `tsconfig.cjs.json` / `scripts/build.mjs` (build takes an optional out dir,
  as there), except all three tsconfigs set `"types": ["node"]` (the two build
  configs re-declare `types`, so the base's setting alone is overridden), and `tsconfig.cjs.json` `exclude`s `src/releases-json.ts` and
  `src/release-cli.ts` — CLI entries use `import.meta.url`, which `module: commonjs` rejects (TS1343); they ship esm only. `npm install -D` the three pinned versions, committing `package-lock.json`.
- [ ] **Step 2: Failing test** `dist-drift.test.ts`: "committed dist/ matches a fresh build of src/" — same shape as `lookout-widgets/test/dist-drift.test.ts`.
- [ ] **Step 3:** Move the three regexes, `RULE` and `described()` into `conventional.ts` unchanged in behaviour; build; point `pr-title.mjs` at dist.
- [ ] **Step 4: Run** `npm run typecheck && npm test` — all pass, `pr-title.test.mjs` untouched (`git diff --stat test/pr-title.test.mjs` empty).
- [ ] **Step 5:** `self.yml` `check-commands` becomes `npm run typecheck` then `npm test` (install comes from the lockfile). `workflows.test.mjs:94`
  asserts the old `node --test` command: change it to assert `check-commands` contains `npm run typecheck` before `npm test`.
- [ ] **Step 6: Commit** `build: typescript src compiled into committed dist`.

### Task 2: Bump, notes extraction, tag-message contract

**Files:** Modify `release-kit/src/conventional.ts`, `src/index.ts`, `dist/`. Test: `release-kit/test/conventional.test.ts`.

**Interfaces:**
- `type ReleaseType = 'feat' | 'fix' | 'perf'`
- `isBreaking(check: TitleCheck, body: string | null): boolean` — `check.breaking`, or a body line matching `^BREAKING CHANGE: ` (after CRLF → LF).
- `parseVersion(v: string): [number, number, number] | null` — accepts `1.2.3` and `v1.2.3` only.
- `nextVersion(base: string, type: ReleaseType, breaking: boolean): string` — returns without `v`; throws on an unparsable base.
- `extractWhatsNew(body: string | null): string`
- `formatTagMessage(r: { title: string; pr: number; notes: string; type: ReleaseType; scope?: string; breaking: boolean }): string`
- `parseTagMessage(msg: string): { subject: string; title: string; type: ReleaseType | 'baseline'; scope?: string; pr?: number; breaking: boolean; notes: string }`
  — `subject` is the first line verbatim; `title` is it without a trailing ` (#N)`; `pr` comes from the `Release-PR` trailer.

- [ ] **Step 1: Failing tests**, one `test()` per row:

  | Call | Expected |
  |---|---|
  | `nextVersion('0.1.0','feat',false)` / `('0.1.0','fix',false)` / `('0.1.0','perf',false)` | `0.2.0` / `0.1.1` / `0.1.1` |
  | `nextVersion('0.4.2','feat',true)` / `('0.4.2','fix',true)` | `0.5.0` / `0.5.0` |
  | `nextVersion('1.4.2','feat',false)` / `('1.4.2','fix',false)` / `('1.4.2','perf',false)` | `1.5.0` / `1.4.3` / `1.4.3` |
  | `nextVersion('1.4.2','feat',true)` / `('1.4.2','fix',true)` / `('1.4.2','perf',true)` / `('0.4.2','perf',true)` | `2.0.0` / `2.0.0` / `2.0.0` / `0.5.0` |
  | `nextVersion('v0.9.0','feat',false)` | `0.10.0` |
  | `nextVersion('1.2','feat',false)` | throws |
  | `isBreaking(checkTitle('feat!: x'), null)` / `(checkTitle('feat: x'), 'a\r\nBREAKING CHANGE: y')` / `(checkTitle('feat: x'), 'not BREAKING CHANGE: y')` | true / true / false |
  | `extractWhatsNew` — section present, followed by `## Why this shape` | its lines only, surrounding blank lines trimmed |
  | — section is the last one, then a blank line and `🤖 Generated with [Claude Code](…)` | the footer is excluded |
  | — contains `### Detail` and a line `#123 fixed` | both kept |
  | — absent / `null` / only inside `<!-- … -->` spanning lines | `''` |
  | — fixture `test/fixtures/pull_request_template.md`: the dashboard template today with Task 6's `## What's new` section (heading + hint comment) inserted | `''` |
  | — CRLF body (Review Focus 2) | found; result contains no `\r` |
  | round-trip `parseTagMessage(formatTagMessage(r))` for `feat(hub)` + notes + breaking, `fix` + empty notes, notes ending `Note: see #12` | every field equal; `title` = PR title |
  | `formatTagMessage({title:'fix: x', pr:7, notes:'', type:'fix', breaking:false})` | exactly `fix: x (#7)\n\nRelease-Type: fix\nRelease-PR: 7\n` |
  | `parseTagMessage('Baseline — versioning starts here\n')` | `type: 'baseline'`, `breaking: false`, `notes: ''`, no `pr` |

- [ ] **Step 2: Run** `npm test` — new cases fail.
- [ ] **Step 3: Implement.** `extractWhatsNew`: CRLF → LF, strip every `<!--[\s\S]*?-->`, then take the lines after the first line equal to `## What's new`
  (trailing whitespace ignored) up to the next `^## ` line or a line starting `🤖 Generated with`. `parseTagMessage`: trailers are the last paragraph only
  when every line in it is `Key: value` and one key is `Release-Type`; otherwise there are none and the type is `baseline`.
- [ ] **Step 4: Run** `npm run build && npm run typecheck && npm test` — all pass.
- [ ] **Step 5: Commit** `feat: bump rules and the tag-message contract`.

### Task 3: `readReleases` and `releases-json`

**Files:** Create `release-kit/src/git.ts`, `src/read-releases.ts`, `src/releases-json.ts`; modify `src/index.ts`, `dist/`. Test: `test/read-releases.test.ts`,
helper `test/fixtures/repo.ts`.

**Interfaces:**
- `git.ts`: `VERSION_TAG = /^v\d+\.\d+\.\d+$/`; `DESCRIBE_FILTER: string[]` (the two flags from Global Constraints);
  `git(cwd: string, args: string[]): Promise<string>` (execFile, trimmed stdout, rejects on non-zero); `versionTagsAt(cwd, sha): Promise<string[]>`
  (annotated `VERSION_TAG` tags pointing at `sha`). Task 4 consumes all four.
- `type Release = { version: string; date: string; title: string; type: ReleaseType | 'baseline'; scope?: string; pr?: number; breaking: boolean; notes: string; url?: string }`
- `type ReleasesResponse = { current: { version: string; ahead: number } | null; releases: Release[] }` — field names exactly as spec §API.
- `readReleases(repoRoot: string): Promise<ReleasesResponse>` — never rejects.
- `writeReleasesJson(repoRoot: string, outFile: string): Promise<void>` lives in `read-releases.ts` (exported from `index.ts`).
  `releases-json.ts` is the CLI entry only, never imported by `index.ts`, esm only: `node dist/esm/releases-json.js <outFile> [repoRoot=cwd]`.
  `release-cli.ts` (Task 5) follows the same rule.
- Fixture `repo.ts`: `makeRepo(o?: { bareOrigin?: boolean }): { dir, origin?: string, commit(subject): sha, tag(name, sha, message?): void,
  setOrigin(url: string): void, cleanup() }` — `bareOrigin` creates a bare repo in the tmpdir as `origin` (Tasks 4–5 push to it); `message` present → annotated with
  `--cleanup=verbatim`, absent → lightweight. Sets a local `user.name`/`user.email`.

- [ ] **Step 1: Failing tests:**
  - non-git directory → `{ current: null, releases: [] }`; repo with no tags → same; only lightweight `v9.9.9` and `v1` → same
  - annotated `v0.1.0` (baseline message) + lightweight `v9.9.9` + lightweight `v1` + annotated `v1.2.3-rc1` on HEAD → `current` `{ version: '0.1.0', ahead: 0 }`,
    one release (Review Focus 3)
  - two releases, HEAD 3 commits past the newest → `ahead: 3`; `releases` newest first; `date` parses as a date
  - tag made with `formatTagMessage` for `feat(hub)!` PR 12 with notes holding `### x` and `#123 y` → every `Release` field matches, notes verbatim
  - origin `git@github.com:futin/x.git` and `https://github.com/futin/x` → `url` `https://github.com/futin/x/pull/12`; origin a local path → no `url`
  - `writeReleasesJson` → file parses to the same object `readReleases` returns
- [ ] **Step 2: Run** `npm test` — new cases fail.
- [ ] **Step 3: Implement.** Tags from one `git for-each-ref --sort=-creatordate refs/tags/v*` with `%(refname:short)`, `%(objecttype)`,
  `%(creatordate:iso-strict)`, `%(contents)` and separators that cannot occur in a message (NUL); keep `objecttype == tag` and `VERSION_TAG`.
  `current` from `git describe --long <DESCRIBE_FILTER>`. Any git failure → the empty shape.
- [ ] **Step 4: Run** `npm run build && npm run typecheck && npm test` — all pass.
- [ ] **Step 5: Commit** `feat: release reader and build-time releases json`.

### Task 4: Release engine

Logic-heavy (ordering, idempotence, the dispatch guard): gets its own review agent.

**Files:** Create `release-kit/src/release.ts`; modify `dist/`. Test: `test/release.test.ts` (tmpdir repo + bare origin + in-memory fake port).

**Interfaces:**
- `type PullRequest = { number: number; title: string; body: string | null; merged: boolean; mergeCommitSha: string | null }`
- `interface GitHubPort { pullsForCommit(sha: string): Promise<PullRequest[]>; getPull(n: number): Promise<PullRequest | null>; releaseExists(tag: string): Promise<boolean>; createRelease(tag: string, title: string, notes: string): Promise<void> }`
- `interface Log { info(m: string): void; warning(m: string): void }`
- `type Outcome = { sha: string; action: 'already-released' | 'release-repaired' | 'no-pr' | 'not-releasing' | 'released'; version?: string }`
- `runRelease(o: { cwd: string; target: string; github: GitHubPort; log: Log }): Promise<Outcome[]>` — rejects with `a newer release exists: <tag>` per spec.
  Guard, run first: any annotated `VERSION_TAG` tag whose commit is a strict descendant of `target` (`git merge-base --is-ancestor <target> <tagcommit>`
  succeeds and `tagcommit != target`). Tags on unrelated branches never trip it.

- [ ] **Step 1: Failing tests** (each asserts outcomes, tags on the bare origin, and the fake's `createRelease` calls):
  - no `vX.Y.Z` tag reachable → `[]`, one warning containing `no baseline tag`, no tag pushed
  - baseline `v0.1.0` whose Release is missing, target = its commit → `release-repaired`; Release title `Baseline — versioning starts here`, notes `''`
  - baseline (fake: its Release exists) + three squash commits `feat: a (#1)`, `docs: b (#2)` (body has a `BREAKING CHANGE:` line — ignored), `fix: c (#3)` → `already-released`, `released 0.2.0`,
    `not-releasing`, `released 0.2.1`; tags created oldest first (a cancelled pending run's commits)
  - run the same target twice → second run all `already-released`, no new tag, no `createRelease` (Review Focus 4)
  - a commit whose `pullsForCommit` is `[]` and whose subject has no `(#N)` → `no-pr` + warning `no PR for <sha>`; the next commit is still released
  - `pullsForCommit` empty but subject ends `(#4)` → `getPull(4)` used; an unmerged PR from either path counts as no PR
  - `pullsForCommit` lists two PRs, only one with `mergeCommitSha === sha` → that one is used
  - target older than a commit carrying `v0.2.0` → rejects `a newer release exists: v0.2.0`; nothing pushed
  - an annotated `v0.9.0` on a side branch that is not a descendant of `target` → the run proceeds normally
  - lightweight `v9.9.9` on the baseline commit → the next `feat` is still `0.2.0` (Review Focus 3)
  - released tag's message equals `formatTagMessage` of the PR (title, number, `extractWhatsNew(body)`, scope, `isBreaking`)
- [ ] **Step 2: Run** `npm test` — new cases fail.
- [ ] **Step 3: Implement.** Range: base tag = `git describe --abbrev=0 <DESCRIBE_FILTER> <target>`, the list is
  `git rev-parse <base>^{commit}` **followed by** `git rev-list --first-parent --reverse <base>..<target>` (the `..` range alone excludes the base). Per commit, spec steps 1–6 in order; the version base is described at the commit itself, so
  tags made earlier in the same run count. Push each tag (`git push origin refs/tags/<tag>`) before `createRelease`. Release title = tag subject line
  verbatim; notes = parsed notes.
- [ ] **Step 4: Run** `npm run build && npm run typecheck && npm test` — all pass.
- [ ] **Step 5: Commit** `feat: release engine`.

### Task 5: `gh` adapter CLI, reusable `release.yml`, README

**Files:** Create `release-kit/src/release-cli.ts`, `release-kit/.github/workflows/release.yml` (**dictated**); modify `dist/`, `README.md`,
`test/workflows.test.mjs`, `.github/workflows/self.yml`. Test: `test/release-cli.test.ts`, fixture `test/fixtures/fake-gh-release.sh`.

**Interfaces:**
- CLI env: `TARGET_SHA` (required, `^[0-9a-f]{7,40}$`, else exit 1), `GITHUB_REPOSITORY` (required), `GH_TOKEN` (passed through to `gh`). Implements
  `GitHubPort` with `gh api repos/<repo>/commits/<sha>/pulls`, `gh api repos/<repo>/pulls/<n>` (404 → `null`), `gh release view <tag>` (exit code),
  `gh release create <tag> --verify-tag --title <t> --notes-file <tmp>`. `Log.warning` prints `::warning::` with `%`, `\r`, `\n` escaped
  (`%25`, `%0D`, `%0A`). A rejection prints `::error::<message>` and exits 1.
- `release.yml` (`workflow_call`): inputs `sha` (default `''`), `kit-ref` (default `v1`), `node-version` (default `'22'`). One job `release`,
  `permissions: contents: write, pull-requests: read`. Steps: checkout app with `fetch-depth: 0`; checkout `futin/release-kit` at `kit-ref` into
  `.release-kit`; setup-node with `package-manager-cache: false`; set the tagger identity; run `node .release-kit/dist/esm/release-cli.js` with
  `TARGET_SHA: ${{ inputs.sha || github.sha }}`, `GH_TOKEN: ${{ github.token }}` in `env:` only.

- [ ] **Step 1: Failing tests:**
  - CLI over a tmpdir repo with the fake `gh` first on `PATH` (canned JSON per call, records argv to a file): PR title `feat: $(touch <tmp>/pwned)` and a
    body with backticks → tag `v0.2.0` exists, `<tmp>/pwned` does not, recorded `--title` argv equals the subject (Review Focus 1)
  - `TARGET_SHA=nope` → exit 1, no `gh` call; `gh api …/pulls/9` 404 → treated as no PR, run continues
  - warning text containing `\n` → one `::warning::` line with `%0A`
  - `workflows.test.mjs`: `release.yml` has exactly the three inputs and defaults; job `release` has no `name:`; its first checkout has `fetch-depth` `'0'` (BaseLoader keeps strings);
    no `run:` contains `${{`; the CLI step's env has `TARGET_SHA` and `GH_TOKEN`
- [ ] **Step 2: Run** `npm test` — new cases fail.
- [ ] **Step 3: Implement** the CLI; dictate `release.yml` to the user (or write it under `/autopilot`).
- [ ] **Step 4: Run** `npm run build && npm run typecheck && npm test` — all pass.
- [ ] **Step 4b:** `self.yml` (spec §release-kit repo: it calls both reusable workflows) gains job `release`, `if: github.event_name == 'push'`,
  job-level `permissions: contents: write, pull-requests: read`, `uses: ./.github/workflows/release.yml` with `kit-ref: ${{ github.ref_name }}`;
  `concurrency` stays per-ref with `cancel-in-progress: true`, accepted on purpose for the kit: a cancelled run leaves at worst a pushed tag
  without its Release, which the next run repairs (spec step 1). App callers keep `cancel-in-progress: false`. `workflows.test.mjs` pins that job's `uses`, `if` and permissions.
- [ ] **Step 5:** README: table rows for the new paths; an "Adopting releases" section — caller `release.yml` (as Task 6), the `## What's new` PR-template
  section, the baseline tag command, and the `0.x` bump table from the spec; the package's `exports` for a server reader.
- [ ] **Step 6: Commit** `feat: reusable release workflow`.

### Held: release-kit lands (controller, with the user)

- Push `feat/release-parts`, open the PR titled `feat: release workflow, tag-message contract and release reader` with a `## What's new` section,
  wait for `ci / checks` green, user merges (squash).
- The merge's `release` run (Task 5's self.yml job) is the first real run: it must repair the missing `v1.0.1` Release and cut `v1.1.0` from the PR
  (`v1.0.0` keeps no Release: the range starts at the newest reachable tag).
  Record the run URL. If it fails, tag `v1.1.0` by hand per README and fix forward.
- Move `v1` per README §Moving `v1` (by hand — the workflow never moves it, spec §release-kit repo).
- Prove: `gh api repos/futin/release-kit/git/ref/tags/v1 --jq .object.sha` equals `git rev-parse v1.1.0^{commit}` (`v1` is lightweight, `v1.1.0` annotated).

### Task 6: Dashboard `ci(release): add release workflow` PR

**Files:** Create `.github/workflows/release.yml` (**dictated**); modify `.github/pull_request_template.md`, `docs/workflows/ci.md`, `.claude/CLAUDE.md`.

- [ ] **Step 1:** Dictate the caller: `on: push` to `main` + `workflow_dispatch` with input `sha`; `permissions: contents: write, pull-requests: read`;
  `concurrency: { group: release, cancel-in-progress: false }`; job id `release` → `uses: futin/release-kit/.github/workflows/release.yml@v1` with
  `sha: ${{ inputs.sha }}` and `kit-ref: v1`. Header comment: the tag is the record (spec D3), link `docs/workflows/ci.md` §Releases.
- [ ] **Step 2:** PR template: uncommented `## What's new` directly above `## Why this shape`, its hint inside an HTML comment ("1–3 lines in user terms;
  delete for PRs with nothing user-visible"). It must match Task 2's fixture; if it had to differ, update the fixture in release-kit too.
- [ ] **Step 3:** `docs/workflows/ci.md`: new §Releases (what cuts one, the bump table, where notes come from, baseline, `workflow_dispatch` re-run, "a
  newer release exists"); replace the stale "`--pr` mode … is pending in `futin/backlog-manager`" sentence — it merged as futin/backlog-manager#279.
  `.claude/CLAUDE.md` §PR rules: "cut a release once Phase C lands" → "cut a release (`docs/workflows/ci.md` §Releases)". If the user's uncommitted
  CI-gate line is still in the working tree, ask before carrying it in this PR.
- [ ] **Step 4: Commit** `ci(release): add release workflow`. No local suite: no code changed, and CI is the gate.

### Held: dashboard lands and baselines (controller, with the user)

1. Open the PR; `ci / checks`, `ci / pr-title`, `ci / skills` green; user merges.
2. The first `release` run must end green with the warning `no baseline tag` (proves the bootstrap path). Record the run URL.
3. Dictate on the merge commit: `git tag -a v0.1.0 <sha> -m "Baseline — versioning starts here" --cleanup=verbatim` and `git push origin v0.1.0`.
4. Dictate `gh workflow run release.yml -f sha=<sha>`; that run must create the `v0.1.0` GitHub Release (proves the repair path). Record the run URL.
5. `v0.2.0` from a real `feat` PR (part 2's API + UI PR) proves the release path; until then it is **unproven**, and the PR says so.

## Not in this plan

Part 2: `shared/types.ts` `Release`/`ReleasesResponse`, `/api/releases` with its cache key, the `release-kit` server dependency and
`test/server-deps.test.ts`, the version chip and What's new panel (mockups first). Other apps' adoption (rollout step 6).
