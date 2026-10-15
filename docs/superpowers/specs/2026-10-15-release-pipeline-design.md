# Release pipeline — CI gate, PR-only main, versions and "What's new"

Status: design approved in conversation 2026-10-15; this file awaits review. Built in three phases (A → B → C), one implementation plan per phase.

## Goal

Every change reaches `main` through a pull request that CI has passed, every user-visible change becomes a numbered release with notes, and each app shows its
running version plus a browsable release history. The mechanism is shared across the user's apps (this repo first, then `lookout`, `lookout-widgets`,
`backlog-manager`, `guide-manager`, …) through one new repo, `futin/release-kit`.

Primary job of "What's new": a durable **release record** — what shipped, when. An unseen-releases dot is a convenience on top, not the point.

## Starting state (measured 2026-10-15)

- No git tags, no GitHub Releases, no CHANGELOG, no `.github/workflows/`, no branch protection or ruleset on `main`.
- `package.json` `version` is `0.1.0` and has never moved; `plugin/.claude-plugin/plugin.json` is `0.3.0` and versions independently.
- `main` moves two ways: PR merge commits (`Merge pull request #N from …`, whose PR *titles* are Conventional Commits, `feat(hub): …`) and
  `backlog-orchestrate` merge commits (`Merge backlog/194: …`) with no type prefix anywhere. Specs and plans are committed straight to `main` by habit.
- `git-sync` (this repo's plugin) pushes the trunk when checks are green.
- `claude-agents-dashboard`, `lookout-widgets`, `backlog-manager` and `guide-manager` are public on GitHub, so rulesets and Actions minutes cost nothing.
  `lookout` is **private** (2026-10-15): on a free plan its ruleset is not enforced and Actions minutes are metered, so `lookout` adopts Phase C and the CI
  workflow but its PR-only gate waits on the user's choice of making it public or upgrading the plan.
- `pnpm test` takes ~3 min locally (2026-10-15) and has only ever run on macOS.

## Decisions

| # | Decision | Rejected alternatives |
|---|---|---|
| D1 | One spec, three phases, a plan per phase. C leans on B: once every change is a PR, the PR is the changelog unit. | Three separate specs; C alone |
| D2 | **Every merged PR is a candidate release.** `feat`/`fix`/`perf` cut one; other types do not. | Release-PR (release-please) batching; manual `pnpm release` |
| D3 | **The annotated git tag is the record.** Notes live in the tag message; a GitHub Release mirrors it. Nothing is committed back to `main`. | Generated `CHANGELOG.md`; bumping `package.json` |
| D4 | **Squash-only merges**, squash commit = PR title + body, so the commit on `main` is the PR title. | Merge commits (title must then be fetched per commit) |
| D5 | **The app reads local tags** through git; no new outbound call. A build-time JSON file is release-kit's fallback for apps without a backend. | GitHub Releases API (a third outbound kind, rate limits, no offline) |
| D6 | **Version chip + What's new panel** in each app. | Settings › About section; GitHub Releases page only; Lookout widget (out of scope) |
| D7 | **Shared parts live in `futin/release-kit`**, consumed as reusable workflows (`uses: …@v1`) and, on the server, as a pinned git-tag dependency like `lookout-widgets`. | A copy-in skill; copy-paste per repo; vendoring the reader |
| D8 | **One PR per `backlog-orchestrate` run**, not per item. | PR per item merged by the orchestrator; PR per item merged by hand |
| D9 | Ruleset has **no bypass actor and requires 0 approvals** (solo maintainer cannot approve their own PR). Emergency = disable the ruleset in the GitHub UI. | Admin bypass; required approvals |

## Phase A — CI gate

### Workflows in each app

`.github/workflows/ci.yml` is a thin caller of `futin/release-kit/.github/workflows/ci-node.yml@v1`. Inputs: Node version, the install command (pnpm via
`packageManager` + corepack), and the list of check commands. For this repo the checks are `pnpm typecheck` and `pnpm test`, on `ubuntu-latest`, triggered
on `pull_request` against `main`.

- **Path-filtered job.** `pnpm test:skills` runs only when the PR touches `plugin/skills/git-sync/**` (CLAUDE.md makes it required-green for those
  changes). The job must report success when skipped so it can be a required check — the filter decides inside the job, not with a workflow-level `paths:`
  filter, because a workflow that never starts leaves a required check pending forever.
- **`test:visual` stays out.** It is macOS-only and on demand.
- **`pr-title` job.** Fails unless the PR title matches `^(feat|fix|perf|docs|chore|test|refactor|ci|build)(\([a-z0-9-]+\))?!?: .+`. A plain regex step,
  no third-party action. It re-runs on `edited` so fixing the title clears it. Phase C reads the type from this title, so the check is load-bearing.

Required check names are fixed by release-kit so the ruleset JSON is identical across apps. A reusable workflow's jobs report as
`<caller job id> / <called job id>`, so every app's `ci.yml` uses the caller job id `ci` and the contexts are `ci / checks`, `ci / pr-title` and
`ci / skills` (when present). Before `apply-repo-settings.sh` runs, the names are read off the first real PR's checks and compared with `main.json`: a
required context that never reports leaves every PR pending forever, and with no bypass actor (D9) that locks `main`.

### Ruleset and repo settings

`release-kit/rulesets/main.json`, applied by `release-kit/scripts/apply-repo-settings.sh <owner/repo>` through `gh api`:

- target `main`; require a pull request; required approvals 0; dismiss nothing
- required status checks `ci / checks` and `ci / pr-title` (and `ci / skills` where the app declares it), strict = branch must be up to date
- require linear history; block force pushes and deletion; no bypass actors (D9)

The same script sets repo merge options: squash only (merge commits and rebase off), `squash_merge_commit_title=PR_TITLE`,
`squash_merge_commit_message=PR_BODY`, delete head branch on merge. It is idempotent: re-running converges, never duplicates the ruleset.

### First-run risk

The test suite has never run on Linux. Phase A includes making it green there (home-dir, path-case and `ps`/`lsof` assumptions are the likely suspects)
before the ruleset is switched on; the ruleset goes on last so a red first run never locks `main`.

## Phase B — PR-only flow

Everything that writes `main` directly today changes:

- **`git-sync`** (this repo, `plugin/skills/git-sync/`) runs in many repos, so the trunk push is **gated per repo, not removed**: when
  `gh api repos/{owner}/{repo}/rules/branches/{trunk}` lists a `pull_request` rule, the trunk is PR-only and `push-trunk` returns `ok: true` with reason
  `pr-only` without pushing. In that case, when local trunk is ahead of `origin/<trunk>`, it offers — inside its existing single decision round — to move
  those commits onto a new branch, reset local trunk to `origin/<trunk>`, push the branch and open a PR; unattended runs report and leave the commits where
  they are. Repos without that rule keep today's behaviour, and the existing `git-sync.push=false` downgrade is unchanged. `gh` absent or the rules call
  failing → treat the trunk as PR-only (the safe side) and say so. `pnpm test:skills` must stay green.
- **`backlog-orchestrate`** (separate repo `futin/backlog-manager`, separate plan there): a `--pr` mode. It cuts `backlog/run-<YYYY-MM-DD>-<n>` from
  `main`, drains onto it through the existing `--base`, and at the end pushes the branch and runs `gh pr create`. PR title type = the highest-ranked item
  type (any `feat` → `feat`, else any `fix` → `fix`, else `chore`), scope `backlog`, summary "<N> items". PR body has a `## What's new` section listing one
  line per item (its title and id). It never merges the PR.
- **Specs, plans and other docs** go through a `docs:` PR, which passes CI and cuts no release. The memory "plan docs go straight to main" and the PR rules
  in `.claude/CLAUDE.md` are updated to say so.

## Phase C — releases

### Release workflow

`.github/workflows/release.yml` calls `futin/release-kit/.github/workflows/release.yml@v1` on `push` to `main`, with `concurrency: release` and
`cancel-in-progress: false`, `permissions: contents: write`, checkout with full history. Also `workflow_dispatch` with a `sha` input for re-runs.

`cancel-in-progress: false` does not mean "never drop": GitHub keeps one running and one pending run per group and cancels an older *pending* run when a
newer one queues. So a run never assumes it only sees its own commit. **The target** is the pushed sha (or the dispatch `sha`, checked out and described
from itself, never from `HEAD`); **the range** is every first-parent commit after the newest `v*` tag reachable from the target, up to and including the
target, oldest first. Steps 1–6 run once per commit in the range, so a cancelled pending run's commit is released by the next run. A dispatch whose target
already has a `v*` tag on a descendant commit fails with "a newer release exists" — versions are never assigned out of order.

Behaviour per commit, in order:

1. **Skip if already released:** a `v*` tag points at the commit **and** its GitHub Release exists → next commit. Tag present but release missing (step 6
   failed earlier) → run step 6 only.
2. **Find the PR:** `GET /repos/{repo}/commits/{sha}/pulls`, keeping the merged PR whose `merge_commit_sha` is the commit (the call can list several); fall back to the trailing `(#N)` of the commit subject. No PR found → exit 0 with a notice
   (a ruleset bypass happened; not this workflow's job to fix).
3. **Classify the title** with the same regex as `pr-title`. A breaking change (`!` after type/scope, or `BREAKING CHANGE:` in the body) releases whatever
   its type (`chore!:` included). Otherwise a type not in `feat|fix|perf` → no release for this commit.
4. **Compute the next version** from `git describe --tags --abbrev=0 --match 'v[0-9]*'`:

   | Title | While major = 0 | From 1.0.0 |
   |---|---|---|
   | `feat` | minor | minor |
   | `fix`, `perf` | patch | patch |
   | `!` after type/scope, or `BREAKING CHANGE:` in the body | minor | major |

   No `v*` tag reachable from the target → the run releases nothing and ends green with a warning annotation "no baseline tag — see Baseline"; it never
   treats the whole history as the range. This is what keeps the Phase C bootstrap merge (rollout step 5) harmless.
5. **Tag:** `git tag -a v<next> <sha> -F <message file> --cleanup=verbatim`, pushed. The default `--cleanup=strip` deletes every line starting with `#`
   (markdown headings, `#123` at line start), so verbatim is required.
6. **GitHub Release:** `gh release view v<next>` succeeds → nothing to do; otherwise `gh release create v<next> --verify-tag` with the same subject as
   title and the same body as notes.

### Tag message — the contract

The reader in §App parses exactly this; the release workflow writes exactly this; release-kit tests round-trip it.

```
<PR title> (#<PR number>)

<the PR body's "## What's new" section, verbatim, or nothing>

Release-Type: <feat|fix|perf>
Release-Scope: <scope, omitted when the title has none>
Release-PR: <number>
Release-Breaking: true            (omitted unless breaking)
```

- Subject line = PR title plus `(#N)`.
- Body = only the content of the `## What's new` section of the PR body, without its heading line, up to the next line matching `^## ` (deeper headings
  such as `###` stay inside the notes), not the whole body: PR bodies here carry verification tables that are not release notes. Missing or empty
  section → empty body; the title alone is the entry.
- Trailers are standard git trailers so `git interpret-trailers --parse` reads them.

`.github/pull_request_template.md` gains an optional `## What's new` section: one to three lines in user terms, deleted for PRs with nothing user-visible.

### Baseline

When Phase C lands, tag `v0.1.0` once on the `main` commit that contains the release workflow, with subject "Baseline — versioning starts here" and no
trailers. The reader treats a tag without `Release-Type` as a baseline entry. `package.json` `version` is left alone and nothing reads it; docs state the tag
is the source of truth. `plugin.json` keeps its own version (out of scope).

## App — read path and UI

### API

`shared/types.ts` first, per the repo rule:

- `Release`: `version` (no leading `v`), `date` (tag creation, ISO), `title` (subject without the `(#N)`), `type` (`feat|fix|perf|baseline`), `scope?`,
  `pr?` (number), `breaking` (boolean), `notes` (markdown, may be empty), `url?` (PR URL, built from the `origin` remote when it is a GitHub URL).
- `ReleasesResponse`: `current` = `{ version, ahead }` or `null`, and `releases: Release[]` newest first.

`GET /api/releases` (server) calls release-kit's `readReleases(repoRoot())`, using the existing walk-up `repoRoot()` in `server/lib/usage-history.ts`
(never `process.cwd()`, which is wrong when the server starts from another directory):

- releases from `git for-each-ref --sort=-creatordate refs/tags/v[0-9]*`, keeping only annotated tags whose name is a full `vX.Y.Z` (lightweight tags and a floating major such as release-kit's own `v1`
  are ignored); `git describe` and the release workflow use the same `vX.Y.Z` filter
- `current` from `git describe --tags --match 'v[0-9]*'`: `v0.5.0` → `{ version: "0.5.0", ahead: 0 }`; `v0.5.0-3-gabc123` → `ahead: 3`
- not a git checkout, git missing, or no `v*` tags → `{ current: null, releases: [] }`, never an error status
- cached in memory, keyed on the output of `git rev-parse HEAD` plus the mtimes of `packed-refs` and `refs/tags` under `git rev-parse --git-common-dir`
  (a worktree's `.git` is a file, and `.git/HEAD` does not change when a commit lands on the same branch); the full tag read runs only when the key changes

No fetch is added: `git pull` already brings annotated tags that point at pulled commits, so the list is exactly what the running checkout contains.

### Dependency

`release-kit` becomes the second allowed package under `server/`, pinned to a git tag (`github:futin/release-kit#v1.x.y`) the same way as `lookout-widgets`.
`test/server-deps.test.ts` pins both names and tags; `.claude/CLAUDE.md` "Keep new deps out of `server/`" names it. `readReleases` uses Node built-ins only
and launches `git`, which is not a new outbound-call kind (`test/outbound.test.ts` unchanged).

### UI

- **Version chip** at the foot of `SideRail`: `v0.5.0`, or `v0.5.0+3` when `ahead > 0`. Hidden when `current` is `null`.
- **Unseen dot** on the chip when the newest release's version is above `lastSeen` in `localStorage` (try/catch, per-viewer convenience only; a value that is not a version counts as missing). First ever
  visit seeds `lastSeen` to the newest version with no dot, so a fresh install never shows "every release is new". Opening the panel sets `lastSeen`.
- **What's new panel**, opened from the chip: newest first; each entry shows version, date, a type badge (Feature / Fix / Performance / Breaking),
  title, notes through the existing `Markdown` component, and the PR link. Breaking is not a fourth type: a breaking release shows its type badge **plus**
  a separate Breaking badge (mockups show both). Baseline entry renders as a plain divider ("Versioning starts here").
- Theme tokens only, stable class names, pointer tooltips per the memory rules. **Mockups first:** two or three variants as an Artifact, real class names,
  phone width, before any UI code.

## release-kit repo

```
futin/release-kit
├── .github/workflows/ci-node.yml        reusable: install + checks + pr-title + optional skills job
├── .github/workflows/release.yml        reusable: Phase C steps 1-6
├── .github/workflows/self.yml           release-kit's own CI, calling the two above
├── rulesets/main.json
├── scripts/apply-repo-settings.sh       idempotent gh api pass: merge options + ruleset
├── src/read-releases.ts                 zero-dep reader, exported for Node backends
├── src/releases-json.ts                 build-time fallback: writes the same ReleasesResponse to a file
├── src/conventional.ts                  title regex, bump rules, tag-message format/parse — shared by release.yml and the reader
├── dist/                                committed build output (esm + cjs + .d.ts), as lookout-widgets ships it
├── package.json                         "exports" → dist, "files": ["dist"], zero runtime deps
└── README.md                            adoption checklist per app
```

Package shape copies `lookout-widgets` (`package.json` `exports` into a committed `dist/`), so a `github:` dependency works without a build step on
install and `tsc` in the consumer type-checks against the `.d.ts`. `release.yml` runs the compiled `dist` through Node; it never needs `tsx`.

Tags: `v1.0.0` at the end of rollout step 1 (CI parts only), `v1.1.0` at rollout step 4 (release parts). The floating `v1` is **moved by hand** after each
`v1.x.y` (`git tag -f v1 v1.x.y && git push -f origin v1`, a README step) — release-kit's own release workflow does not move it, so a bad release never
reaches callers until the user moves the pointer. Breaking a reusable workflow's inputs or the tag-message contract means `v2`.

## Testing

release-kit (`node --test`, tmpdir git repos as fixtures):

- title classification: each allowed type; scope present and absent; `!`; unknown type; missing colon; uppercase type rejected
- bump table: every row, at major 0 and major ≥ 1; `BREAKING CHANGE:` in the body
- tag message round-trip: format → `git tag -a … --cleanup=verbatim` → `readReleases` returns the same fields; empty notes; notes containing `###`
  sub-headings and a line starting `#123`; a baseline tag
- release range: three unreleased commits after the last tag (a cancelled pending run) → three tags in order; a dispatch on an older sha whose descendant
  is tagged → fails; tag present but release missing → release only
- `## What's new` extraction: present, absent, last section in the body, followed by another `##` section
- `readReleases`: no git dir; no tags; only lightweight tags; HEAD exactly on a tag; HEAD 3 commits ahead; origin remote non-GitHub → no `url`

Dashboard:

- `/api/releases` over a tmpdir repo (same fixture style as existing tests) for the `null` and populated shapes, and a commit made after the first read
  (`ahead` must move from 0 to 1)
- client domain logic: unseen-dot decision, first-visit seed, version comparison (`0.10.0` > `0.9.0`)
- `test/server-deps.test.ts` updated for the second package
- visual baseline for chip and panel in `pnpm test:visual` (macOS, on demand)

Workflows are verified by real runs on release-kit itself and then on a throwaway PR here; the plan records which runs proved which behaviour.

## Rollout

1. release-kit: CI workflow, `pr-title`, ruleset, settings script, its own CI; tag `v1.0.0` and point `v1` at it.
2. Dashboard Phase A: `ci.yml` (`uses: …@v1`), Linux green, read the real check names off the PR, then `apply-repo-settings.sh`.
3. Phase B: `git-sync` here; `--pr` mode in backlog-manager (its own plan in that repo); CLAUDE.md and memory updates.
4. release-kit: `release.yml`, `conventional.ts`, `read-releases.ts`, `dist/`; tag `v1.1.0`, move `v1`.
5. Dashboard Phase C, in two PRs: first `ci(release): add release workflow` (type `ci`, so its own merge cuts no release and the "no baseline tag"
   failure cannot fire), then tag `v0.1.0` on that merge commit by hand; then the API + UI PR (after mockups), whose `feat` merge becomes `v0.2.0`.
6. Other apps adopt A + C from the README, each building its own chip and panel.

Workflow and ruleset files are dictated for the user to type; mechanical code edits are done directly.

## Out of scope

Lookout "recent releases" widget; `plugin.json` versioning; a `CHANGELOG.md` file; required approvals; editing release notes after the tag (re-tagging is
not supported — fix forward with the next release).

## Unproven

- That `pnpm test` can be made green on `ubuntu-latest` without restructuring tests.
- That a skipped-inside-the-job `skills` check is treated as passing by the ruleset in practice (documented GitHub behaviour, not yet observed here).
- That `git pull` with the user's git config brings tags along (default `fetch.tags` behaviour; a user-level `--no-tags` setting would break it).
