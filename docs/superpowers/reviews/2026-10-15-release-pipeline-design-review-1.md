# Review 1 — `docs/superpowers/specs/2026-10-15-release-pipeline-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-15. Checklist: facts vs code/outside sources, internal consistency, edge cases, copy, scope, CLAUDE.md rules.
Verified against the main checkout at `/Users/andrejajevtic/Documents/custom-projects/claude-agents-dashboard` (branch `fix/request-guards`, HEAD 11d9c75),
sibling repos `lookout-widgets` and `backlog-manager`, and `gh api` (2026-10-15). Line numbers are the spec's.

## Verdict: REVISE

One Critical (the ruleset as specified locks `main`), fifteen Important. Most Important findings are single-sentence fixes; the design itself holds.

## Facts checked and found true

- No tags, no `.github/workflows/`, no CHANGELOG, no releases, no rulesets (`gh api repos/futin/claude-agents-dashboard/rulesets` → `[]`), no branch
  protection (404) — spec:15.
- `package.json` `version` 0.1.0 (`package.json:3`); `plugin/.claude-plugin/plugin.json` 0.3.0 (`:4`) — spec:16.
- `Merge backlog/<id>: …` merge commits, 14 on `main` — spec:17-18.
- `git-sync` pushes the trunk when checks are green, has one decision round, `survey.unattended`, and `push-trunk` reports `rejected` for every failed
  push and never retries (`plugin/skills/git-sync/SKILL.md:5,7,54,60,85-88`) — spec:19,74-77.
- `backlog-orchestrate` has `--base <ref>` and `--merge-mode branch` (`backlog-manager/skills/backlog-orchestrate/SKILL.md:30-32`); no `--pr` yet — spec:78.
- `lookout-widgets` pinned as `github:futin/lookout-widgets#v0.1.0` (`package.json:38`); `test/server-deps.test.ts:17-18,65-73` pins exactly one name and
  one spec by equality, so the test must change for a second package — spec:160-161.
- `test/outbound.test.ts` scans `server/*.ts` for `node:http`/`https`/… and `fetch(` only (`:50-58`), so a `git` spawn inside a dependency leaves it
  unchanged — spec:162. It also asserts the CLAUDE.md "Keep new deps out of" rule still names `lib/git-fetch.ts` (`:115-118`): the rewrite that names
  `release-kit` must keep that sentence.
- `packageManager: pnpm@12.6.0`, `engines.node >=18` (`package.json:28-31`) — spec:41.
- `.github/pull_request_template.md` sections are `##` headings (`:18,24,42`) — the "up to the next `##`" cut at spec:127 works for the template.
- `SideRail.tsx` and `Markdown.tsx` exist under `client/src/components/`; `localStorage` is already used in five client files — spec:166-170.
- Memory `plan-docs-commit-straight-to-main.md` exists and says what spec:82 says it says.
- Current repo merge settings (gh api): merge commits and rebase allowed, squash title `COMMIT_OR_PR_TITLE`, message `COMMIT_MESSAGES`, delete-branch off —
  so `apply-repo-settings.sh` (spec:62) has real work to do.

## Critical

### C1 — spec:52,59 — required check names from a reusable workflow are `<caller job> / <called job>`, not `ci` / `pr-title` / `skills`

When `.github/workflows/ci.yml` is a thin caller (`jobs.<id>.uses: futin/release-kit/.github/workflows/ci-node.yml@v1`, spec:41), every job the reusable
workflow defines reports under the name `<caller job name> / <called job name>` (GitHub Actions, "Reusing workflows": the called jobs are prefixed by the
caller's job name). A ruleset whose `required_status_checks` list `ci`, `pr-title`, `skills` waits on contexts that are never reported, and — exactly as
spec:47 warns for `paths:` — a required check that never starts leaves every PR unmergeable. With D9 (no bypass actor) `main` is then locked until the
ruleset is disabled by hand.

Fix: fix the caller's job id in release-kit's README/template (one job, id `ci`) and put `ci / ci`, `ci / pr-title`, `ci / skills` in `rulesets/main.json`;
make rollout step 2 (spec:213) read the names off the first real PR's checks page before `apply-repo-settings.sh` runs. The "identical across apps"
property survives as long as the caller job id is part of the contract.

## Important

### I1 — spec:20 — `futin/lookout` is private

`gh repo view futin/lookout --json visibility` → `PRIVATE` (2026-10-15). The other four are public. On a private repo Actions minutes are billed and a
ruleset that requires a PR on `main` needs a paid plan. Fix: correct the sentence and say what lookout does (make it public, pay, or adopt A without the
ruleset).

### I2 — spec:89-90 — `cancel-in-progress: false` does not mean "queue, never drop"

GitHub keeps at most one running and one pending run per concurrency group; a newer pending run cancels the older pending one (Actions docs, "Using
concurrency"). Three merges inside one ~1 min run → the middle sha's run is cancelled, its PR is never tagged, and nothing later notices because each run
looks only at its own sha (spec:95-96). Fix: have the workflow release every unreleased PR commit between the last `v*` tag and HEAD (`git log
<lasttag>..HEAD --first-parent`, same steps 2-6 per commit, oldest first), so a dropped run is harmless; or move "a cancelled pending run loses a release"
into Unproven/Known limits and give the `workflow_dispatch` re-run as the recovery.

### I3 — spec:127 vs spec:197 — notes cannot contain `##` sub-headings if the section ends at the next `##`

Line 127 cuts the section at the next `##` heading; line 197 tests "notes containing `##` sub-headings". Both cannot hold. Fix: define the cut as a line
matching `^## ` (two hashes then a space) and say sub-headings inside notes are `###`.

### I4 — spec:108,115-124 — `git tag -a` strips every line that starts with `#`

`git tag`'s default `--cleanup` mode is `strip`, which removes comment lines (lines beginning with `#`). A verbatim `## What's new` heading line, a `###`
sub-heading, or any note line starting with `#` (an issue ref such as `#123 fixed`) silently vanishes from the tag message, and the round-trip test
(spec:197) fails. Fix: write the message with `-F <file> --cleanup=verbatim` (or `whitespace`), and state whether the `## What's new` heading line itself is
part of the body or only the lines under it (spec:118 and 127 read differently).

### I5 — spec:154 — the cache-invalidation stat set misses new commits and breaks in a worktree

`.git/HEAD` holds `ref: refs/heads/main`; neither its content nor its mtime changes when a commit lands on the same branch, so `ahead` (spec:152) goes stale
until a branch switch. In a git worktree `.git` is a file (gitdir pointer), so `.git/HEAD`, `.git/packed-refs` and `.git/refs/tags` do not exist at those
paths — and the dashboard is routinely run from worktrees (memory `worktree-dev-setup.md`). Fix: resolve `git rev-parse --git-dir --git-common-dir` once,
and key the cache on `git rev-parse HEAD` plus the mtimes of `<common>/packed-refs` and `<common>/refs/tags` — or simply on the output of
`git rev-parse HEAD` + `git for-each-ref refs/tags/v[0-9]*` which is cheap enough per poll. Note the spec's own test list (spec:199) has no "commit after
first read" case; add it.

### I6 — spec:149 — `repoDir` is unspecified

The server already has the right helper: `repoRoot()` in `server/lib/usage-history.ts:426-437` walks up from `import.meta.dirname` for `package.json`,
and its comment explains why `process.cwd()` is wrong (a server started from another directory silently reads another tree). Fix: `readReleases(repoRoot())`.

### I7 — spec:160,183-185 — release-kit's package shape is a guess

The tree at spec:176-187 shows `src/*.ts` and no `package.json`, `exports` or `dist/`. `lookout-widgets`, the stated model, ships a committed `dist/`
(`lookout-widgets/package.json` `exports` → `./dist/esm/index.js` + `.d.ts`; `git ls-files dist` non-empty at `v0.1.0`). `pnpm typecheck` (`tsc --noEmit`)
and `tsx` resolving a bare `.ts` entry out of `node_modules` is unproven. Fix: specify `package.json` (`type: module`, `exports` with `types`), a build that
commits `dist/` at each tag, and a `files` list — the same shape as lookout-widgets — or state the tsx-loads-TS path and add it to Unproven.

### I8 — spec:74-76 — "never pushes the trunk" contradicts "a trunk push that the ruleset rejects stays a reported `rejected`"

If the `push-trunk` phase is gone there is no push to reject. git-sync runs in every repo of the user's, including ones without a ruleset (I1), and it
already has a per-repo switch: `git-sync.push=false` marks the repo `downgraded` and never pushes (`SKILL.md:38`; `git-sync.mjs:1621` `not-allowed`).
Fix: say which — remove `push-trunk` outright, or keep it behind the existing config and have Phase A's `apply-repo-settings.sh` set `git-sync.push=false`
locally — and make the "move commits onto a branch and open a PR" offer the replacement in the decision round.

### I9 — spec:41,212-215 — step 2 references `release-kit@v1` two steps before `v1` exists

Rollout step 1 builds release-kit's CI workflow, step 2 points the dashboard's `ci.yml` at `…/ci-node.yml@v1`, step 4 is where release-kit is "tagged
`v1.0.0` with a floating `v1`" (spec:189). Fix: tag `v1.0.0`/`v1` at the end of step 1 (CI only), bump at step 4; or reference `@main` until step 4 and
record the switch.

### I10 — spec:89-91,99 — `workflow_dispatch` with `sha`: which commit is described?

On dispatch the checkout is `main`'s HEAD; `git describe --abbrev=0` from HEAD gives the newest tag, so re-running an older `sha` (say a run dropped per I2)
tags that older commit with a version above the releases that came after it, and `--sort=-creatordate` (spec:151) then lists it first while the chip's
`describe` from HEAD still reports the earlier number. Fix: on dispatch check out `sha`, compute `describe` from `sha`, and refuse (fail loudly) when a
`v*` tag exists on a descendant of `sha` — the fix-forward rule in Out of scope already implies this.

### I11 — spec:95,109 — a failed step 6 can never be repaired

If `git push` of the tag succeeds and `gh release create` fails (API blip, rate limit), every re-run exits at step 1 because the tag exists, so the GitHub
Release mirror stays missing forever. Fix: step 1 skips only when both the tag and the release exist; step 6 is `gh release view v<next> || gh release
create …`.

### I12 — spec:98,105 — a breaking `chore!:` / `refactor!:` cuts no release

Step 3 exits for any type outside `feat|fix|perf` before step 4 ever sees the `!`, so the one case where users most need a release note is skipped.
Fix: either state that `!` or `BREAKING CHANGE:` on any type cuts a release (bump per the breaking row), or name the gap explicitly in Decisions.

### I13 — spec:169 vs spec:145 — "Breaking" is listed as a type badge but `breaking` is a flag

`Release.type` is `feat|fix|perf|baseline` and `breaking` is a separate boolean; the UI line lists four badges "Feature / Fix / Performance / Breaking"
as if they were one enum. A breaking feat: "Feature" replaced by "Breaking", or both? Fix: define it (e.g. type badge always, plus a second "Breaking" badge
when the flag is set) and include it in the mockups.

### I14 — spec:17 — merge commits on `main` do not carry Conventional Commits titles

`git log --first-parent main` subjects are `Merge pull request #196 from futin/management-redesign`; only the PR titles are conventional (`gh pr list
--state merged`: 203, 196, 195, 190 … all match the regex at spec:49, except #67 "Redesign"). The sentence is false as written and D4's parenthetical
depends on the distinction. Fix: "PR merge commits (`Merge pull request #N …`) whose PR titles follow Conventional Commits".

### I15 — spec:180,189 — nothing moves the floating `v1` tag

`self.yml` calls `release.yml` (spec:180), which creates `vX.Y.Z` tags only (spec:108); the floating `v1` that callers reference is created once (spec:189)
and never advanced, so every caller stays on `v1.0.0` forever. Fix: a `floating-major: true` input on the reusable release workflow that force-moves
`v<major>` after step 6, or a documented manual step in the README checklist.

### I16 — spec:135 — the Phase C merge itself trips the "fail loudly" path

The PR that lands `release.yml` triggers it on merge; step 4 finds no tag and fails (if the PR is `feat`/`fix`/`perf`), and the baseline can only be
tagged after that commit exists. Fix: title the Phase C PR `ci(release): …` (step 3 exits cleanly) and tag `v0.1.0` on that merge commit right after; say
so in Rollout step 5.

## Minor

- spec:166 — "at the foot of `SideRail`": the foot already holds the live line (`SideRail.tsx:24,315`, `feat(rail): live line at the rail foot`). Say above
  or below it; the mockups will settle it but the sentence reads as if the foot were free.
- spec:50 — re-running on `edited` re-runs the whole caller workflow, i.e. the 3-minute `ci` job too, on every title edit. Condition `ci` and `skills` on
  `github.event.action != 'edited'`.
- spec:49 — the regex omits `style` and `revert`; a GitHub "Revert" PR fails `pr-title` until retitled. Fine, but say it.
- spec:101-105 — how `1.0.0` is ever reached (a manual tag) is unstated.
- spec:143-146 — `Release`/`ReleasesResponse` live in `shared/types.ts` (the contract, per CLAUDE.md) while `readReleases` returns release-kit's own type;
  `shared/` cannot import from a server dependency (the client bundles it). Say the server adapts (`satisfies ReleasesResponse`) so the two cannot drift
  silently.
- spec:151 vs 99,152 — `refs/tags/v*` vs `--match 'v[0-9]*'`: `v*` also matches release-kit's own floating `v1` (and any `vfoo`), which the reader then
  shows as a baseline entry in release-kit's self-test. Use `refs/tags/v[0-9]*` everywhere.
- spec:170 vs 135 — the divider copy "Versioning starts here" differs from the tag subject "Baseline — versioning starts here"; say the divider is a fixed
  string, not the subject.
- spec:167-168 — a malformed `lastSeen` (not semver) is neither "missing" nor comparable; treat it as missing (re-seed).
- spec:96 — `commits/{sha}/pulls` can return several PRs; pick the merged one whose `merge_commit_sha` is the sha.
- spec:228 — add `pnpm test:skills` on Linux to Unproven (it is the `skills` job; it needs a git identity and takes ~4 min, CLAUDE.md:31).
- spec:136 — "docs state the tag is the source of truth": name the docs (`docs/overview.md` + a `docs/subsystems/releases.md`, per CLAUDE.md "Reference
  docs → docs/subsystems/ + docs/overview.md"); `test/outbound.test.ts:63-64` lists the docs a new `lib/` module must be named in.
- spec:161 — the CLAUDE.md rewrite must keep "lib/git-fetch.ts" inside the "Keep new deps out of" paragraph (`test/outbound.test.ts:115-118` asserts it).
- spec:78 — `backlog/run-<date>-<n>` shares the `backlog/` prefix with the per-item `backlog/<id>` branches; harmless, but git-sync's merged-branch
  pruning will see both — say the run branch is deleted by "delete head branch on merge" (spec:63).
