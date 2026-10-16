# CI gate

Every PR into `main` runs `.github/workflows/ci.yml`, a thin caller of release-kit's reusable `ci-node.yml` (`futin/release-kit`, referenced at `@v1`).
Design: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase A.

## What runs

| Context | What it does | When it is green without running anything |
|---|---|---|
| `ci / checks` | `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm build`, `pnpm test`, each reported on its own | never |
| `ci / pr-title` | the PR title must match the Conventional Commits rule in release-kit's `scripts/pr-title.mjs` | on `push` (no title) |
| `ci / skills` | `pnpm test:skills` (~4 min, 2026-10-01) when the PR touches `plugin/skills/git-sync/**` | any PR that does not touch it, and every `push` |

`pnpm build` runs before `pnpm test` because `test/api-usage-rates.test.ts` checks that an unmatched path falls through to the built SPA shell; a fresh
checkout has no `client/dist`. `pnpm test:visual` is never run here (macOS-only, on demand).

Allowed title types: `feat`, `fix`, `perf` (these may carry `!`), and `docs`, `chore`, `test`, `refactor`, `ci`, `build` (these may not). The scope, if
any, is lowercase `[a-z0-9-]`. A GitHub "Revert …" title fails until it is retitled.

## Why the names look like `ci / …`

A reusable workflow's jobs report as `<caller job id> / <called job id>`. The caller job id here is `ci`, so the contexts are `ci / checks`,
`ci / pr-title` and `ci / skills`. Renaming the caller job, or giving any job a `name:`, changes the reported context — and a ruleset that requires a
context which never reports leaves every PR pending, with no bypass. Read the names off a real PR (`gh pr checks <n>`) before the ruleset requires them.

## Why a title edit re-runs everything

`edited` is one of the trigger types so fixing a title clears `ci / pr-title`. GitHub re-runs the whole caller workflow on that event, so `checks` runs
again (~3–4 min). That is deliberate: if `checks` were skipped on `edited`, the skipped job would report success for the same head sha and a red PR would
turn green.

## Running the Linux suite locally

CI runs on `ubuntu-latest`. To reproduce it on this machine, in a clean copy of the tree as the non-root `node` user, from the repo root:

```bash
docker run --rm --name ci-linux --user root -v "$PWD":/src-ro:ro node:22 bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq git jq >/dev/null && rm -f /.dockerenv && runuser -u node -- bash -c "set -e; mkdir -p ~/app ~/.local/bin && cd ~/app && tar -C /src-ro --exclude=./node_modules --exclude=\"./*/node_modules\" --exclude=./client/dist --exclude=./.git -cf - . | tar -xf - && git init -q -b main && git add -A && git -c user.name=ci -c user.email=ci@example.com commit -qm snapshot && corepack enable --install-directory ~/.local/bin && export PATH=~/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test"'
```

Three container differences from the runner are undone on purpose: the local `node:22` image has no `git` (the git-state suites spawn it) and no
`jq` (the hook suites print `⚠ SKIPPED` and pass without it — 83 cases on 2026-10-15), and `/.dockerenv` exists, which flips `loadConfig`'s Docker
detection and fails its default-value test. The runner is a VM with git and jq, so none of these applies there. Compare the `✓` count with a macOS run.

## The ruleset

The `main-pr-only` ruleset (PR required, the three contexts above, linear history, no force push or deletion, no bypass) and the squash-only merge
settings are applied by release-kit's `scripts/apply-repo-settings.sh futin/claude-agents-dashboard`. **Applied on 2026-10-15** (ruleset id 25157835),
after PR #204 reported all three contexts green. Re-running the script updates the ruleset in place. Direct pushes to `main` are refused, so every change reaches it
through a PR. git-sync reads the rule (one `gh api` call per survey), never pushes the trunk, and offers to carry local trunk commits to a PR branch
([design §6](../../plugin/skills/git-sync/references/design.md)). backlog-orchestrate's `--pr` mode gives it the same path (merged as
futin/backlog-manager#279).

## Releases

`.github/workflows/release.yml` is a thin caller of release-kit's reusable `release.yml` (`@v1`, with `kit-ref: v1` kept equal to that ref), run on every
push to `main` and on `workflow_dispatch`. Design: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase C. It needs both
`contents: write` (the tag push and the Release) and `pull-requests: read` — setting `contents` alone drops `pull-requests` to none and the PR lookup then
fails on a private repo. The group is `release` with `cancel-in-progress: false`; GitHub still drops an older *pending* run when a newer one queues, so a
run releases every unreleased commit since the last tag, not only its own.

**The tag is the record.** The version exists only as an annotated `vX.Y.Z` tag whose message carries the PR title, the notes and `Release-*` trailers.
`package.json` `version` is not read and is not bumped; the same tags feed the GitHub Release.

**What cuts one.** The PR title decides, and the version is bumped from the newest `vX.Y.Z` tag reachable from the commit:

| Title | While major = 0 | From 1.0.0 |
|---|---|---|
| `feat` | minor | minor |
| `fix`, `perf` | patch | patch |
| `!` after the type or scope, or a `BREAKING CHANGE: ` line in the PR body | minor | major |

`docs`, `chore`, `test`, `refactor`, `ci` and `build` cut nothing (this PR's own merge included), and a `BREAKING CHANGE:` line on one of them is
ignored. A commit on `main` with no PR is skipped with the warning `no PR for <sha>`; the commits after it are still released.

**Where the notes come from.** The `## What's new` section of the PR body (`.github/pull_request_template.md` carries it above `## Why this shape`), up to
the next `## ` heading, with HTML comments stripped first. A missing or empty section, which is what the untouched template yields, means the title alone is
the entry. Delete the section from PRs with nothing user-visible.

**Baseline.** Until a `vX.Y.Z` tag exists the workflow releases nothing and ends green with the warning `no baseline tag`. `v0.1.0` is tagged once, by hand,
on the `main` commit that contains the workflow (`git tag -a v0.1.0 <sha> -m "Baseline — versioning starts here" --cleanup=verbatim`, then
`git push origin v0.1.0`); every later version is cut from it.

**Re-running.** `gh workflow run release.yml -f sha=<sha>` releases that commit and every unreleased commit before it; with no `sha` it uses the branch head.
It is idempotent: a commit with its tag and its Release is left alone, and a tag whose Release is missing only gets the Release. That is also how the
baseline gets its GitHub Release. A dispatch whose target has a later version tag fails with `a newer release exists: <tag>`, since versions are never
assigned out of order; a push run in the same state ends green with `a newer release exists: <tag> — nothing to do`, because it can only be a superseded run.
A dispatch `sha` must be a commit on `main`; any other commit fails with `target <sha> is not on origin/main` and nothing is tagged.
