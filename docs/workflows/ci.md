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
after PR #204 reported all three contexts green. Re-running the script updates the ruleset in place. Until phase B, direct pushes to `main` — git-sync's
trunk push, backlog-orchestrate, plan docs — are refused.
