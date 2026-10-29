# CI gate

Every PR into `main` runs `.github/workflows/ci.yml`, a thin caller of release-kit's reusable `ci-node.yml` (`futin/release-kit`, referenced at `@v1`, with `kit-ref: v1` kept equal to that ref).
Design: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase A.

## What runs

| Context | What it does | When it is green without running anything |
|---|---|---|
| `ci / checks` | `pnpm install --frozen-lockfile`, then `scripts/ci-scope.ts`: `pnpm typecheck`, `pnpm build`, `pnpm test`, each reported on its own — or, on a docs-only PR, only the suites that read the changed docs (§Scoped checks) | never |
| `ci / pr-title` | the PR title must match the Conventional Commits rule in release-kit's `scripts/pr-title.mjs`; a `feat`/`fix`/`perf` PR also needs its What's new notes (§Releases) | on `push` (no title) |
| `ci / skills` | `pnpm test:skills` (~4 min, 2026-10-01) when the PR touches `plugin/skills/git-sync/**` | any PR that does not touch it, and every `push` |

`pnpm test` does not need a built client: `test/api-usage-rates.test.ts` accepts either the SPA shell or the static handler's `pnpm build` 404 hint for an
unmatched path (#214), so the order of `pnpm build` and `pnpm test` here is incidental. `pnpm test:visual` is never run here (macOS-only, on demand).

Allowed title types: `feat`, `fix`, `perf` (these may carry `!`), and `docs`, `chore`, `test`, `refactor`, `ci`, `build` (these may not). The scope, if
any, is lowercase `[a-z0-9-]`. A GitHub "Revert …" title fails until it is retitled.

## Scoped checks

`scripts/ci-scope.ts` is the one check command, ported from backlog-manager's `scripts/ci-scope.mjs`. It reads the PR's changed files and runs only what
they can break: a PR that touches only docs never needs `tsc` or `vite build` (no client or server module imports a `.md`), and most suites never read a doc.

| The PR changes only…                                                                                          | Runs                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| docs — `docs/**` and any other `*.md` (`CLAUDE.md`, a `SKILL.md`, `backlog/**`)                                 | the `run-all.ts` suites (through `test/run-some.ts`) and kaizen `node --test` suites whose code names a changed file; no typecheck, no build |
| anything else — `server/`, `client/`, `shared/`, `plugin/` code, configs, the lockfile, and always `scripts/**`, `test/**`, `.github/**` | everything: `pnpm typecheck`, `pnpm build`, `pnpm test`                                                          |

- **Docs are not test-free.** `docs-links.test.ts` walks `docs/` for dead links, `plugin-manifest.test.ts` pins what lives under `plugin/`,
  kaizen's `skill.test.mjs` reads its `SKILL.md`, and a handful more read `CLAUDE.md`. A docs-only PR still runs those, so a doc that breaks a guard is red
  on the PR, not on `main`.
- **Which suites "name" a file** is found by scanning the suites' source at run time — no hand-kept list. A path piece counts when it is bounded by quotes or
  slashes on a code line (comment lines are dropped): the file's top-level directory (`'docs'`, which `docs-links` joins from), its parent, the file
  itself, its basename (`'../SKILL.md'`) or its parent's name. The suite lists are read too: `run-all.ts`'s imports, and the `*.test.mjs` glob in
  `package.json`'s `test` script. It is a heuristic, generous on purpose: a suite picked wrongly costs seconds.
- **Every doubt runs the full suite**: a push to `main`, a PR merge commit that is not two-parented, a failed fetch, an empty diff, and any path that is
  not a doc. `scripts/**`, `test/**` and `.github/**` are full even when they are markdown, because they change how the suites run.
- **The push run on `main` is the backstop.** A suite the scan misses — one that reaches a doc through a helper or a computed path — passes the PR and fails
  the push run after the merge. That is the price of the scoped run; it shows up as a red `main` and is fixed by the next PR.
- **How the diff is read.** The PR checkout is the merge ref at depth 1; the script fetches that merge commit's first parent (the base tip) and diffs the two
  with `--no-renames`, so a file moved from `server/` into `docs/` lists both paths and runs full.
- **The job is never skipped.** release-kit's rule — a skipped job reports success for the same head sha — is why the scope is decided inside the step,
  from the diff alone: a title edit's re-run reaches the same verdict, red stays red.
- **`ci / skills` is unchanged.** The git-sync suite keeps its own path gate, so there is no skills scope here, unlike backlog-manager.
- The scope is posted as a `ci scope` notice on the run's summary page. To check one by hand:
  `pnpm exec tsx scripts/ci-scope.ts --dry-run --files docs/overview.md` prints the plan without running it.

Local `pnpm test` is unchanged — it always runs everything.

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
detection. Its default-value test follows detection since #310, so it no longer fails there, but removing the marker keeps the container's defaults the
runner's. The runner is a VM with git and jq, so none of these applies there. Compare the `✓` count with a macOS run.

## The ruleset

The `main-pr-only` ruleset (PR required, the three contexts above, linear history, no force push or deletion, no bypass) and the squash-only merge
settings are applied by release-kit's `scripts/apply-repo-settings.sh futin/claude-agents-dashboard`. **Applied on 2026-10-15** (ruleset id 25157835),
after PR #204 reported all three contexts green. Re-running the script updates the ruleset in place. Direct pushes to `main` are refused, so every change reaches it
through a PR. git-sync reads the rule (one `gh api` call per survey), never pushes the trunk, and offers to carry local trunk commits to a PR branch
([design §6](../../plugin/skills/git-sync/references/design.md)). backlog-orchestrate's `--pr` mode gives it the same path (merged as
futin/backlog-manager#279).

## Releases

`.github/workflows/release.yml` is a thin caller of release-kit's reusable `release.yml` (`@v1`, with `kit-ref: v1` kept equal to that ref) in
`mode: rollup`, run each night at 04:00 UTC (`schedule`, `0 4 * * *`) and on `workflow_dispatch`. A merge into `main` releases nothing by itself. Designs:
`docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase C, and `docs/superpowers/specs/2026-10-29-batched-releases-design.md` for the
nightly rollup. It needs both `contents: write` (the tag push and the Release) and `pull-requests: read` — setting `contents` alone drops `pull-requests`
to none and the PR lookup then fails on a private repo. The group is `release` with `cancel-in-progress: false`, so a dispatch and the nightly run never tag
at once.

**One version per run.** A run gathers every releasing PR merged since the newest version tag into a single release: the bump is the largest among their
types (below), and the notes hold one `### <Scope>` section per title scope, oldest PR first, with unscoped PRs under `### Other`. A night with only
`docs`, `chore` and the like, or no merges at all, cuts nothing and ends green. Tags cut before the switch keep their one-PR shape; the reader handles both.

**The tag is the record.** The version exists only as an annotated `vX.Y.Z` tag whose message carries the grouped notes and `Release-*` trailers; a
`Release-Items` trailer lists each PR with its type, scope and breaking flag, so the dashboard can show the release item by item.
`package.json` `version` is not read and is not bumped; the same tags feed the GitHub Release.
The dashboard reads these tags back at `GET /api/releases` for its version chip and What's new drawer ([releases](../subsystems/releases.md)).

**What cuts one.** Each PR's title decides its type; the run takes the largest, and the version is bumped from the newest `vX.Y.Z` tag reachable from the run's target:

| Title | While major = 0 | From 1.0.0 |
|---|---|---|
| `feat` | minor | minor |
| `fix`, `perf` | patch | patch |
| `!` after the type or scope, or a `BREAKING CHANGE: ` line in the PR body | minor | major |

`docs`, `chore`, `test`, `refactor`, `ci` and `build` cut nothing, and a `BREAKING CHANGE:` line on one of them is
ignored. A commit on `main` with no PR is skipped with the warning `no PR for <sha>`; the commits after it are still released.

**Where the notes come from.** The `## What's new` section of the PR body (`.github/pull_request_template.md` carries it above `## Why this shape`), up to
the next `## ` heading, with HTML comments stripped first. A missing or empty section, which is what the untouched template yields, means the title alone is
the entry. `require-notes: true` in `ci.yml` makes `ci / pr-title` fail a `feat`/`fix`/`perf` PR while that section is missing, empty or only the template
comment; `ci.yml` triggers on `edited`, so filling in the body re-runs it. A releasing PR with nothing worth saying writes `None` (any case, optionally
`None — <reason>`) as the section's only content: the check passes and the PR's entry falls back to its title, with the `None` never shown. `docs`, `chore`
and the other silent types are never asked for notes.

**Baseline.** Until a `vX.Y.Z` tag exists the workflow releases nothing and ends green with the warning `no baseline tag`. `v0.1.0` is tagged once, by hand,
on the `main` commit that contains the workflow (`git tag -a v0.1.0 <sha> -m "Baseline — versioning starts here" --cleanup=verbatim`, then
`git push origin v0.1.0`); every later version is cut from it.

**Re-running.** `gh workflow run release.yml -f sha=<sha>` releases that commit and every unreleased commit before it; with no `sha` it uses the branch head.
It is idempotent: a commit with its tag and its Release is left alone, and a tag whose Release is missing only gets the Release. That is also how the
baseline gets its GitHub Release. A dispatch whose target has a later version tag fails with `a newer release exists: <tag>`, since versions are never
assigned out of order; a scheduled run in the same state ends green with `a newer release exists: <tag> — nothing to do`, because it can only be a superseded run.
A dispatch `sha` must be a commit on `main`; any other commit fails with `target <sha> is not on origin/main` and nothing is tagged.

<!-- docs-sync:
  sources:
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
    - .github/pull_request_template.md
  kind: workflow
  verified: 142439e51a92c5c5faebaf0c867bc5a36fef7c57
-->
