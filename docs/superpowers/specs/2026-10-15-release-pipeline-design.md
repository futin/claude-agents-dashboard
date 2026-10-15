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
- `main` moves two ways: PR merge commits with Conventional Commits titles (`feat(hub): …`) and `backlog-orchestrate` merge commits
  (`Merge backlog/194: …`) that carry no type prefix. Specs and plans are committed straight to `main` by habit.
- `git-sync` (this repo's plugin) pushes the trunk when checks are green.
- All five repos named above are public on GitHub, so rulesets and Actions minutes cost nothing.
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

Required check names are fixed by release-kit (`ci`, `pr-title`, `skills` when present) so the ruleset JSON is identical across apps.

### Ruleset and repo settings

`release-kit/rulesets/main.json`, applied by `release-kit/scripts/apply-repo-settings.sh <owner/repo>` through `gh api`:

- target `main`; require a pull request; required approvals 0; dismiss nothing
- required status checks `ci` and `pr-title` (and `skills` where the app declares it), strict = branch must be up to date
- require linear history; block force pushes and deletion; no bypass actors (D9)

The same script sets repo merge options: squash only (merge commits and rebase off), `squash_merge_commit_title=PR_TITLE`,
`squash_merge_commit_message=PR_BODY`, delete head branch on merge. It is idempotent: re-running converges, never duplicates the ruleset.

### First-run risk

The test suite has never run on Linux. Phase A includes making it green there (home-dir, path-case and `ps`/`lsof` assumptions are the likely suspects)
before the ruleset is switched on; the ruleset goes on last so a red first run never locks `main`.

## Phase B — PR-only flow

Everything that writes `main` directly today changes:

- **`git-sync`** (this repo, `plugin/skills/git-sync/`): never pushes the trunk. When local `main` is ahead of `origin/main` it offers — inside its existing
  single decision round — to move those commits onto a new branch, reset local `main` to `origin/main`, push the branch and open a PR. Unattended runs
  take the safe default: report and leave the commits where they are. A trunk push that the ruleset rejects stays a reported `rejected`, never a retry.
  `pnpm test:skills` must stay green.
- **`backlog-orchestrate`** (separate repo `futin/backlog-manager`, separate plan there): a `--pr` mode. It cuts `backlog/run-<YYYY-MM-DD>-<n>` from
  `main`, drains onto it through the existing `--base`, and at the end pushes the branch and runs `gh pr create`. PR title type = the highest-ranked item
  type (any `feat` → `feat`, else any `fix` → `fix`, else `chore`), scope `backlog`, summary "<N> items". PR body has a `## What's new` section listing one
  line per item (its title and id). It never merges the PR.
- **Specs, plans and other docs** go through a `docs:` PR, which passes CI and cuts no release. The memory "plan docs go straight to main" and the PR rules
  in `.claude/CLAUDE.md` are updated to say so.

## Phase C — releases

### Release workflow

`.github/workflows/release.yml` calls `futin/release-kit/.github/workflows/release.yml@v1` on `push` to `main`, with `concurrency: release` and
`cancel-in-progress: false` (queue, never drop), `permissions: contents: write`, checkout with full history. Also `workflow_dispatch` with a `sha` input for
re-runs.

Behaviour, in order:

1. **Skip if already released:** a `v*` tag already points at the sha → exit 0.
2. **Find the PR:** `GET /repos/{repo}/commits/{sha}/pulls`; fall back to the trailing `(#N)` of the commit subject. No PR found → exit 0 with a notice
   (a ruleset bypass happened; not this workflow's job to fix).
3. **Classify the title** with the same regex as `pr-title`. Type not in `feat|fix|perf` → exit 0, no release.
4. **Compute the next version** from `git describe --tags --abbrev=0 --match 'v[0-9]*'`:

   | Title | While major = 0 | From 1.0.0 |
   |---|---|---|
   | `feat` | minor | minor |
   | `fix`, `perf` | patch | patch |
   | `!` after type/scope, or `BREAKING CHANGE:` in the body | minor | major |

   No tag at all → fail loudly: the baseline tag is missing (see Baseline).
5. **Tag:** `git tag -a v<next> <sha>` with the message below, pushed.
6. **GitHub Release:** `gh release create v<next> --verify-tag` with the same subject as title and the same body as notes.

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
- Body = only the `## What's new` section of the PR body (up to the next `##` heading), not the whole body: PR bodies here carry verification tables that are
  not release notes. Missing section → empty body; the title alone is the entry.
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

`GET /api/releases` (server) calls release-kit's `readReleases(repoDir)`:

- releases from `git for-each-ref --sort=-creatordate refs/tags/v*` (annotated tags only; lightweight tags are ignored)
- `current` from `git describe --tags --match 'v[0-9]*'`: `v0.5.0` → `{ version: "0.5.0", ahead: 0 }`; `v0.5.0-3-gabc123` → `ahead: 3`
- not a git checkout, git missing, or no `v*` tags → `{ current: null, releases: [] }`, never an error status
- cached in memory, invalidated when `HEAD` or the refs change (stat of `.git/HEAD`, `.git/packed-refs`, `.git/refs/tags`), never re-read every poll

No fetch is added: `git pull` already brings annotated tags that point at pulled commits, so the list is exactly what the running checkout contains.

### Dependency

`release-kit` becomes the second allowed package under `server/`, pinned to a git tag (`github:futin/release-kit#v1.x.y`) the same way as `lookout-widgets`.
`test/server-deps.test.ts` pins both names and tags; `.claude/CLAUDE.md` "Keep new deps out of `server/`" names it. `readReleases` uses Node built-ins only
and launches `git`, which is not a new outbound-call kind (`test/outbound.test.ts` unchanged).

### UI

- **Version chip** at the foot of `SideRail`: `v0.5.0`, or `v0.5.0+3` when `ahead > 0`. Hidden when `current` is `null`.
- **Unseen dot** on the chip when the newest release's version is above `lastSeen` in `localStorage` (try/catch, per-viewer convenience only). First ever
  visit seeds `lastSeen` to the newest version with no dot, so a fresh install never shows "every release is new". Opening the panel sets `lastSeen`.
- **What's new panel**, opened from the chip: newest first; each entry shows version, date, a type badge (Feature / Fix / Performance / Breaking),
  title, notes through the existing `Markdown` component, and the PR link. Baseline entry renders as a plain divider ("Versioning starts here").
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
└── README.md                            adoption checklist per app
```

Tagged `v1.0.0` with a floating `v1` that callers reference. Breaking a reusable workflow's inputs or the tag-message contract means `v2`.

## Testing

release-kit (`node --test`, tmpdir git repos as fixtures):

- title classification: each allowed type; scope present and absent; `!`; unknown type; missing colon; uppercase type rejected
- bump table: every row, at major 0 and major ≥ 1; `BREAKING CHANGE:` in the body
- tag message round-trip: format → `git tag -a` → `readReleases` returns the same fields; empty notes; notes containing `##` sub-headings; a baseline tag
- `## What's new` extraction: present, absent, last section in the body, followed by another `##` section
- `readReleases`: no git dir; no tags; only lightweight tags; HEAD exactly on a tag; HEAD 3 commits ahead; origin remote non-GitHub → no `url`

Dashboard:

- `/api/releases` over a tmpdir repo (same fixture style as existing tests) for the `null` and populated shapes
- client domain logic: unseen-dot decision, first-visit seed, version comparison (`0.10.0` > `0.9.0`)
- `test/server-deps.test.ts` updated for the second package
- visual baseline for chip and panel in `pnpm test:visual` (macOS, on demand)

Workflows are verified by real runs on release-kit itself and then on a throwaway PR here; the plan records which runs proved which behaviour.

## Rollout

1. release-kit: CI workflow, `pr-title`, ruleset, settings script, its own CI.
2. Dashboard Phase A: `ci.yml`, Linux green, then `apply-repo-settings.sh`.
3. Phase B: `git-sync` here; `--pr` mode in backlog-manager (its own plan in that repo); CLAUDE.md and memory updates.
4. release-kit: `release.yml`, `conventional.ts`, `read-releases.ts`, `v1.0.0`.
5. Dashboard Phase C: `release.yml`, PR template section, baseline `v0.1.0`, API, UI (after mockups).
6. Other apps adopt A + C from the README, each building its own chip and panel.

Workflow and ruleset files are dictated for the user to type; mechanical code edits are done directly.

## Out of scope

Lookout "recent releases" widget; `plugin.json` versioning; a `CHANGELOG.md` file; required approvals; editing release notes after the tag (re-tagging is
not supported — fix forward with the next release).

## Unproven

- That `pnpm test` can be made green on `ubuntu-latest` without restructuring tests.
- That a skipped-inside-the-job `skills` check is treated as passing by the ruleset in practice (documented GitHub behaviour, not yet observed here).
- That `git pull` with the user's git config brings tags along (default `fetch.tags` behaviour; a user-level `--no-tags` setting would break it).
