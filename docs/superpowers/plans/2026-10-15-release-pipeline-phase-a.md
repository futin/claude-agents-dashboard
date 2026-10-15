# Release Pipeline — Phase A (CI gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim and a bug in the plan becomes a bug in the branch. Where a step says "implement", the implementer writes the code and may
> disagree with the plan; say so in the task report rather than bending the code to the text.

**Goal:** Every PR into `main` of `claude-agents-dashboard` runs typecheck + tests on Linux and a PR-title check through reusable workflows that live in a
new `futin/release-kit` repo, ready for a ruleset that makes those checks required.

**Architecture:** `release-kit` (new local repo at `/Users/andrejajevtic/Documents/custom-projects/release-kit`) holds a reusable `ci-node.yml`, a zero-dep
`pr-title` checker with its own tests, the ruleset JSON and an idempotent settings script. The dashboard gets a ~15-line `ci.yml` that calls `ci-node.yml`,
plus whatever test fixes Linux needs. Nothing is pushed and no GitHub setting changes in this plan: those are the held steps at the end.

**Tech Stack:** GitHub Actions (reusable `workflow_call`), Node 22 ESM + `node --test`, POSIX `sh`/`bash` + `gh api`, Docker `node:22` for local Linux runs.

**Spec:** `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` (§Phase A, §release-kit repo, §Rollout steps 1–2)

## Global Constraints

- release-kit has **zero runtime dependencies**; its tests use `node:test` + `node:assert` only.
- Required check contexts, verbatim: `ci / checks`, `ci / pr-title`, `ci / skills`. The caller job id in every app's `ci.yml` is `ci`; the called job ids
  are `checks`, `pr-title`, `skills`.
- PR-title rule, verbatim: matches `^(feat|fix|perf)(\([a-z0-9-]+\))?!?: .+` or `^(docs|chore|test|refactor|ci|build)(\([a-z0-9-]+\))?: .+`.
- `ci-node.yml` **always** runs a `skills` job; with no `skills-command` input, or when its path filter does not match, it reports success without running
  anything. Path filtering happens inside the job, never via a workflow-level `paths:` filter.
- `test:visual` is never run in CI.
- The PR title reaches any shell only through an environment variable, never through `${{ }}` interpolation inside `run:` (script injection).
- Ruleset: target `main`, PR required, 0 approvals, the three checks above with strict up-to-date, linear history, no force push, no deletion, **no bypass
  actors**. Repo settings: squash only, `squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`, `delete_branch_on_merge=true`.
- Authored prose wraps at 160 columns; commit bodies at 72. Conventional Commits subjects.
- Dashboard repo rules apply in full (`.claude/CLAUDE.md`): no new deps under `server/`, figures measured off this machine carry their date inline.
- Kill only processes you started, by recorded pid. Docker containers are run with `--rm` and named, and stopped by that name only.

## Review Focus

1. **Title edit after a red run** — editing the PR title re-runs the whole caller workflow; `checks` must run again rather than be skipped, or a skipped
   job would report success for the same head sha and turn a red PR green. Pinned in Task 3 (workflow condition review) and Task 5 (README note).
2. **Hostile title text** — a title such as `feat: $(touch /tmp/pwned)` or one containing backticks or `"` must be evaluated as literal text. Pinned in
   Task 1 (CLI reads the title from `PR_TITLE` env) and Task 3 (workflow passes it only through `env:`).
3. **Running the settings script twice** — must leave exactly one ruleset named `main-pr-only`, updated in place. Pinned in Task 2.
4. **An app with no skills suite** — `ci / skills` must still report success, or the shared ruleset locks that app's `main`. Pinned in Task 3.
5. **Linux-only test failures** — macOS-isms in the dashboard suite (home dir, case-insensitive paths, `ps`/`lsof` output) must fail in the container
   run, not first on GitHub. Pinned in Task 4.

---

### Task 1: release-kit scaffold + PR-title checker

**Files:**
- Create: `release-kit/package.json`, `release-kit/.gitignore`, `release-kit/LICENSE` (MIT, copy the holder line from `lookout-widgets/LICENSE`)
- Create: `release-kit/scripts/pr-title.mjs`
- Test: `release-kit/test/pr-title.test.mjs`

**Interfaces:**
- Produces: `checkTitle(title: string): { ok: boolean, type?: string, scope?: string, breaking: boolean, reason?: string }` (named export of
  `scripts/pr-title.mjs`). CLI mode when run directly: reads the title from env `PR_TITLE`, prints `ok: <type>` or the `reason`, exit 0 / 1.
  Phase C's `conventional` module imports `checkTitle` rather than re-declaring the regex.

- [ ] **Step 1: Scaffold the repo.** `git init` in `/Users/andrejajevtic/Documents/custom-projects/release-kit` (it does not exist yet — check first).
  `package.json`: `name` `release-kit`, `version` `0.0.0`, `private: true`, `type: module`, `scripts.test` = `node --test test/`, no dependencies,
  `engines.node` `>=20`. `.gitignore`: `node_modules/`.
- [ ] **Step 2: Write the failing tests** — one `test()` per case:

  | Title | ok | type | scope | breaking |
  |---|---|---|---|---|
  | `feat: add x` | true | feat | — | false |
  | `fix(api): guard y` | true | fix | api | false |
  | `perf(scan)!: drop z` | true | perf | scan | true |
  | `docs: spec` | true | docs | — | false |
  | `ci(release): add workflow` | true | ci | release | false |
  | `chore!: drop node 18` | false (reason names `!` on a non-releasing type) | | | |
  | `Feat: x` | false | | | |
  | `feat:x` (no space) | false | | | |
  | `feat: ` (empty description) | false | | | |
  | `feat(API): x` (uppercase scope) | false | | | |
  | `style: x` | false (unknown type) | | | |
  | `Revert "feat: x"` | false | | | |
  | `` (empty) | false | | | |

  Plus a CLI test: spawn `node scripts/pr-title.mjs` with `PR_TITLE='feat: $(touch <tmpdir>/pwned)'` → exit 0, and `<tmpdir>/pwned` does not exist; with
  `PR_TITLE` unset → exit 1 with a reason naming `PR_TITLE`.
- [ ] **Step 3: Run** `node --test test/` — expect every case to fail (module missing).
- [ ] **Step 4: Implement** `checkTitle` + the CLI guard (`import.meta.url` vs `process.argv[1]`). No regex flags; anchored both ends.
- [ ] **Step 5: Run** `node --test test/` — all pass. Record the case count.
- [ ] **Step 6: Commit** in release-kit: `feat: pr-title checker` (separate `git add <files>` and `git commit`).

### Task 2: Ruleset JSON + idempotent settings script

**Files:**
- Create: `release-kit/rulesets/main.json`
- Create: `release-kit/scripts/apply-repo-settings.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`)
- Test: `release-kit/test/apply-repo-settings.test.mjs`, fixture `release-kit/test/fixtures/fake-gh.sh`

**Interfaces:**
- Produces: CLI `apply-repo-settings.sh <owner/repo> [--dry-run]`. Ruleset name constant `main-pr-only`.

Behaviour:
- `main.json` is a ruleset body for `POST /repos/{o}/{r}/rulesets`: `name` `main-pr-only`, `target` `branch`, `enforcement` `active`, conditions
  `ref_name.include` `["~DEFAULT_BRANCH"]`, `bypass_actors` `[]`, rules: `pull_request` (0 approvals, no code-owner/last-push/thread requirements),
  `required_status_checks` (the three contexts, `strict_required_status_checks_policy: true`), `required_linear_history`, `non_fast_forward`, `deletion`.
- The script: (1) `gh api -X PATCH repos/<r>` with the four merge settings; (2) `gh api repos/<r>/rulesets` → find the id of the one named
  `main-pr-only`; found → `gh api -X PUT repos/<r>/rulesets/<id> --input rulesets/main.json`, else `-X POST repos/<r>/rulesets --input …`; (3) print
  what it did, one line per call. `--dry-run` prints every call it would make and makes only the read call. Missing argument or `gh` not on PATH → exit 2
  with usage. It resolves `main.json` relative to its own location, never the cwd.

- [ ] **Step 1: Write the fake gh.** A shell script that appends its argv (one line per call) to `$FAKE_GH_LOG` and, for a `GET …/rulesets` call, prints
  the contents of `$FAKE_GH_RULESETS` (a JSON array). Every other call prints `{}`.
- [ ] **Step 2: Write the failing tests**, running the script with `PATH` prefixed by a tmpdir holding the fake as `gh`:
  - no existing ruleset (`[]`) → log has exactly: one `PATCH repos/o/r` with the four settings, one rulesets GET, one `POST repos/o/r/rulesets`
  - existing `[{"id":42,"name":"main-pr-only"}]` → `PUT repos/o/r/rulesets/42`, no POST
  - existing `[{"id":7,"name":"other"}]` → POST (a differently named ruleset is not touched)
  - `--dry-run` → log has only the GET; stdout names the PATCH and the POST it would make
  - no argument → exit 2; `PATH` without `gh` → exit 2
  - run from a different cwd → still finds `rulesets/main.json`
  - `main.json` parses as JSON and its `required_status_checks` contexts equal exactly `["ci / checks","ci / pr-title","ci / skills"]`; `bypass_actors`
    is `[]`
- [ ] **Step 3: Run** `node --test test/` — the new cases fail.
- [ ] **Step 4: Implement** `main.json` and the script.
- [ ] **Step 5: Run** `node --test test/` — all pass. If `shellcheck` is on PATH run it; it is not installed on this machine (2026-10-15), so otherwise
  note "shellcheck not run" in the task report.
- [ ] **Step 6: Commit** `feat: ruleset and repo settings script`.

### Task 3: Reusable `ci-node.yml` + release-kit's own CI

**Files:**
- Create: `release-kit/.github/workflows/ci-node.yml`
- Create: `release-kit/.github/workflows/self.yml`
- Test: `release-kit/test/workflows.test.mjs`

**Interfaces:**
- Produces: `on: workflow_call` with inputs `node-version` (string, default `22`), `check-commands` (string, newline-separated, required),
  `skills-command` (string, default empty), `skills-paths` (string, newline-separated globs, default empty), `kit-ref` (string, default `v1`).
  Jobs `checks`, `pr-title`, `skills`.

Behaviour:
- `checks`: checkout, set up Node at `node-version`, enable corepack (pnpm comes from the caller's `packageManager`), install with the lockfile frozen
  (`pnpm install --frozen-lockfile` when `pnpm-lock.yaml` exists, else `npm ci`), then run each line of `check-commands` as its own step-equivalent so a
  failure names the command. Never conditioned on the event action.
- `pr-title`: runs only for `pull_request` events (on `push` it is skipped, which reports success); checks out `futin/release-kit` at `kit-ref` into
  `.release-kit/`, then runs `node .release-kit/scripts/pr-title.mjs` with `PR_TITLE: ${{ github.event.pull_request.title }}` in `env:` only.
- `skills`: always runs. If `skills-command` is empty → one step that echoes "no skills suite" and succeeds. Otherwise it computes the changed files of the
  PR (`git diff --name-only <base sha>...<head sha>` with a full-history checkout) and runs the command only when any path matches a `skills-paths` glob;
  no match → echo and succeed.
- Least privilege: `permissions: contents: read` at workflow level.
- `self.yml`: on `pull_request` and `push` to `main`, job id `ci` calling `./.github/workflows/ci-node.yml` with `check-commands: node --test test/` and
  `kit-ref: ${{ github.head_ref || github.ref_name }}`, so release-kit's own PRs check titles with the checker from the branch under review, not from `v1`.

- [ ] **Step 1: Write the failing tests** in `workflows.test.mjs`, parsing each YAML file with a tiny check (no YAML dependency: shell out to
  `python3 -c 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin)))'` when `python3` with PyYAML exists, else `t.skip` with the reason):
  - `ci-node.yml` has `on.workflow_call` with exactly the five inputs above and their defaults
  - jobs are exactly `checks`, `pr-title`, `skills`
  - no `run:` value anywhere in either file contains `${{ github.event.pull_request.title` (injection guard)
  - `checks` has no `if:` (Review Focus 1)
  - `skills` has no job-level `if:` (Review Focus 4)
  - top-level `permissions` is `{ contents: read }`
  - `self.yml` calls `./.github/workflows/ci-node.yml` from a job whose id is `ci`
- [ ] **Step 2: Run** `node --test test/` — the new cases fail (files missing).
- [ ] **Step 3: Write both workflows.**
- [ ] **Step 4: Run** `node --test test/` — all pass. The workflows' runtime behaviour is **unverified** until the held push (record it so).
- [ ] **Step 5: Commit** `feat: reusable node CI workflow`.

### Task 4: Dashboard tests green on Linux

**Files:**
- Modify: whatever test or source file the container run proves macOS-specific (unknown until the run; each fix is the smallest change that makes the
  test honest on both platforms — never `if (process.platform === 'linux') skip` unless the test exercises a macOS-only feature, and then say so in a
  comment that names the feature)
- Work in a new worktree of `claude-agents-dashboard` on branch `ci/phase-a-gate`, cut from `docs/release-pipeline-spec` (so the PR carries spec, plan and
  code). Never touch the user's main checkout, which has a peer branch with uncommitted work.

- [ ] **Step 1: Baseline on macOS.** In the worktree: `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm test` (foreground). Record the
  printed case count and exit codes.
- [ ] **Step 2: Run on Linux.** `docker run --rm --name rk-ci-linux -v <worktree>:/src -w /src node:22 sh -c 'corepack enable && pnpm install
  --frozen-lockfile && pnpm typecheck && pnpm test'` with the worktree's `node_modules` kept out of the mount's way (bind-mount an anonymous volume over
  `/src/node_modules` so macOS-built native modules are not reused). The `node:22` image is already present locally (2026-10-15). Record failures verbatim.
- [ ] **Step 3: For each failure:** reproduce it in the container, find the macOS assumption, fix it, re-run that test file in the container, then on macOS.
  One commit per root cause: `fix(test): <what was macOS-only>`.
- [ ] **Step 4: Full re-run** in the container and on macOS — both green, same case count. Also run `pnpm test:skills` in the container once (it is
  ~4 min, 2026-10-01) since `ci / skills` will run it on Linux; failures there get the same treatment.

### Task 5: Dashboard `ci.yml`, docs, and the held-steps list

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/workflows/ci.md`
- Modify: `docs/overview.md` (§Map, one line under the workflow docs), `.claude/CLAUDE.md` (§Commands: one line saying PRs into `main` run `ci.yml`
  and which commands it runs; §PR rules: the title must pass `pr-title`)
- Create: `release-kit/README.md`

Behaviour:
- `ci.yml`: `on: pull_request` (types `opened`, `synchronize`, `reopened`, `edited`) into `main` and `push` to `main`; one job, id `ci`, `uses:
  futin/release-kit/.github/workflows/ci-node.yml@v1` with `check-commands` `pnpm typecheck` + `pnpm test`, `skills-command` `pnpm test:skills`,
  `skills-paths` `plugin/skills/git-sync/**`. `concurrency` keyed on the PR number with `cancel-in-progress: true` (a newer push supersedes an older run).
- `docs/workflows/ci.md`: what runs, the three contexts and why they are named `ci / …`, why a title edit re-runs everything (Review Focus 1), how to run
  the Linux suite locally (the Task 4 docker line), and that the ruleset is applied by release-kit's script — with today's state "not applied yet".
- `release-kit/README.md`: the adoption checklist — add `ci.yml` (job id must be `ci`), get one PR green, read the three context names off it, then run
  `apply-repo-settings.sh`; how to move the floating `v1`; why `checks` must never be conditioned on the event action.

- [ ] **Step 1:** Write `ci.yml`; add a dashboard test case in `test/` only if an existing test already pins `.github/` content (check with grep first —
  none expected; do not invent a new test file for YAML).
- [ ] **Step 2:** Write the docs and the README; run `pnpm test` (doc-link tests in `test/` cover `docs/overview.md`).
- [ ] **Step 3:** Commit in the dashboard worktree: `ci: run typecheck and tests on every PR` and in release-kit: `docs: adoption checklist`.
- [ ] **Step 4: Held steps — do not run them; list each for the user with the exact command:**
  1. Create and push release-kit: `gh repo create futin/release-kit --public --source /Users/andrejajevtic/Documents/custom-projects/release-kit --push`
  2. Tag it: `git -C …/release-kit tag -a v1.0.0 -m "CI parts" && git -C …/release-kit tag v1 v1.0.0 && git -C …/release-kit push origin v1.0.0 v1`
     (`v1` lightweight, per the spec)
  3. Push the dashboard branch and open the PR: `git push -u origin ci/phase-a-gate` then `gh pr create --title "ci: run typecheck and tests on every PR"`
  4. When the PR is green, read the contexts: `gh pr checks <n>` — they must read `ci / checks`, `ci / pr-title`, `ci / skills`
  5. Only then: `…/release-kit/scripts/apply-repo-settings.sh futin/claude-agents-dashboard --dry-run`, then without `--dry-run`

## Not in this plan

Phase B (git-sync gate, orchestrator `--pr`), Phase C (release workflow, reader, UI), `lookout`'s private-repo decision, and the CLAUDE.md / memory change
that ends "plan docs straight to main" (Phase B owns it).
