# Release Pipeline — Phase B (PR-only flow, dashboard part) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template:** this plan specifies behaviour, signatures, exact values and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim and a bug in the plan becomes a bug in the branch. Where a step says "implement", the implementer writes the code and may
> disagree with the plan; say so in the task report rather than bending the code to the text. Size figures here are soft targets, never budgets to
> compress rules into.

**Goal:** `git-sync` stops trying to push a trunk that a GitHub ruleset makes PR-only, and instead offers to carry the local trunk commits onto a
`sync/<trunk>-<YYYYMMDD-HHMM>` branch, reset the local trunk to `origin/<trunk>`, push the branch and open a PR; this repo's own rules stop sending docs
straight to `main`.

**Architecture:** `survey` makes one `gh api repos/<owner>/<repo>/rules/branches/<trunk>` call and records `trunkPrOnly` + `trunkPrOnlyReason` (and, when
the trunk is ahead, a `carry` offer) in `survey.json`. The decision round gains one `carry` question; `plan` turns a yes into a `carry-trunk` action;
`push-trunk` reads `survey.json` and returns `reason: 'pr-only'`; `apply` runs `carry-trunk` last; `report` words all of it. No later phase calls the
rules endpoint again. Repos without the rule keep today's behaviour byte for byte.

**Tech Stack:** Node 22 ESM, `node --test` (git-sync's own suite, `pnpm test:skills`), `gh` CLI, git.

**Spec:** `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` §Phase B (first and third bullets). The `backlog-orchestrate --pr` bullet is out
of scope here: it lives in `futin/backlog-manager` with its own plan. git-sync's own spec is `plugin/skills/git-sync/references/design.md`; every
behaviour change below lands there too (Task 6).

## Global Constraints

- PR-title rule, verbatim from the spec: a title passes when it matches `^(feat|fix|perf)(\([a-z0-9-]+\))?!?: .+` or
  `^(docs|chore|test|refactor|ci|build)(\([a-z0-9-]+\))?: .+`.
- Carry branch name: `sync/<trunk>-<YYYYMMDD-HHMM>`, local time, computed once in `survey` (the question shows it) and carried verbatim into the plan.
- Carry PR title: the commit subject when there is exactly one carried commit and that subject passes the PR-title rule; otherwise
  `chore(git-sync): carry <n> local <trunk> commits` (`<n>` is the number, always plural wording — n ≥ 2 on this path, or n = 1 with a failing subject,
  where it reads `carry 1 local main commits`; accept that, do not add singular logic).
- `gh` absent, the rules call failing, or its output not a JSON array → the trunk is treated as PR-only (the safe side) and the report says so.
- A non-GitHub remote or a downgraded repo (`git-sync.push=false`) never calls the rules endpoint and is never PR-only: `trunkPrOnly: false`.
- `gh` and `git` are spawned with argv arrays, never through a shell; a branch name, title or body never crosses a shell.
- The trunk is never force-pushed and never moved with `reset --hard`; the local trunk moves only by `git reset --keep`, only inside `carry-trunk`, and
  only after the carry branch is on `origin`.
- git-sync's existing invariants (`references/design.md` §10) all still hold; `carry-trunk` adds invariant 11 (Task 4).
- `pnpm test:skills` must be green at the end of every task (CLAUDE.md: required for any change under `plugin/skills/git-sync/`). Run it in the
  foreground; never stack background waits.
- Authored prose wraps at 160 columns; commit bodies at 72. Conventional Commits subjects; the PR title for this branch is
  `feat(git-sync): carry local trunk commits to a PR when main is PR-only`.
- Kill only processes you started, by recorded pid. This plan starts no servers.

## Review Focus

1. **gh absent on a GitHub remote now means PR-only.** Every existing github-host test world has no `gh` on PATH, so after Task 1 those worlds are
   PR-only: trunk proofs move to `origin/<trunk>` and `push-trunk` stops pushing. Existing tests that are *not about* gh must opt out with the new
   `w.rules([])` helper; tests that *are* about gh absence keep it and gain an assertion of the PR-only consequence. Never weaken an assertion to
   make it pass. (Task 1 owns the helper; Tasks 1 and 3 own the fallout.)
2. **Merged proof against an unpushable local trunk.** With a PR-only trunk ahead of origin, a branch merged only into those local commits must not be
   offered as merged (apply would refuse it against `origin/<trunk>` anyway, which reads as a bug). Mirror case: not PR-only → still merged. (Task 1)
3. **The user switched branches or the tree moved between survey and apply.** `carry-trunk` must re-prove HEAD is the trunk, the trunk tip equals
   `expectTip`, and `origin/<trunk>` is an ancestor of it — and skip without side effects otherwise. `reset --keep` on the wrong branch would rewind
   someone's feature branch. (Task 4)
4. **Push of the carry branch fails.** Nothing may be left half-done: no trunk reset, and the just-created local branch is removed (it points at the
   trunk tip, so nothing is lost). (Task 4)
5. **`gh pr create` fails after the branch is pushed and the trunk reset.** The work is safe on `origin`; the result is still `done`, with `pr: null` and
   the error, and the report prints the exact `gh pr create` line to open it by hand. (Tasks 4, 5)

---

## File map

| File | Change |
| --- | --- |
| `plugin/skills/git-sync/tools/git-sync.mjs` | rules probe, survey fields, proof ref, carry question + answer, `carry-trunk` action, `pr-only` push reason, report lines |
| `plugin/skills/git-sync/test/world.mjs` | `rules(list)` helper |
| `plugin/skills/git-sync/test/survey.test.mjs`, `plan.test.mjs`, `push.test.mjs`, `apply.test.mjs`, `report.test.mjs`, `e2e.test.mjs`, `skill.test.mjs` | new cases + opt-outs |
| `plugin/skills/git-sync/SKILL.md`, `references/design.md` | procedure and spec |
| `.claude/CLAUDE.md`, `docs/workflows/ci.md` | every change reaches `main` through a PR |

---

### Task 1: Rules probe and survey fields

**Files:** modify `tools/git-sync.mjs` (`repo`/`remoteKindOf` neighbourhood, `branchRecords`, `survey`); modify `test/world.mjs`; test
`test/survey.test.mjs`.

**Interfaces:**
- Produces `githubSlugOf(ctx) → string | null`: `owner/repo` parsed from `remote.origin.url` when the host is `github.com`, trailing `.git` and `/`
  stripped; both `https://github.com/o/r.git` and `git@github.com:o/r.git` → `o/r`; anything else → `null`.
- Produces `trunkRules(repo) → { prOnly: boolean, reason: 'ruleset' | 'no-rule' | 'gh-absent' | 'gh-failed' | 'not-github' | 'downgraded' }`:
  not GitHub → `not-github`, downgraded → `downgraded` (both without spawning anything); otherwise one
  `gh api repos/<slug>/rules/branches/<trunk, URI-encoded>` with `GH_TIMEOUT_MS`; ENOENT → `gh-absent`; non-zero exit, timeout, or stdout that is not a
  JSON array → `gh-failed`; an array containing an element whose `type` is `pull_request` → `ruleset`; any other array → `no-rule`. Both failure reasons
  return `prOnly: true`; `ruleset` returns `true`; the rest `false`. Slug `null` on a GitHub remote → `gh-failed`.
- `survey` payload gains `trunkPrOnly` (boolean), `trunkPrOnlyReason` (the reason above), `trunkAhead` (commits on local trunk not on
  `origin/<trunk>`, `0` when `origin/<trunk>` is missing), and `carry` (Task 2 fills it; `null` here). `trunkRules` runs once per survey, before
  `branchRecords`.
- `branchRecords` proof ref: `origin/<trunk>` when downgraded **or** `trunkPrOnly`; the local trunk otherwise. Pass the decision in rather than calling
  `trunkRules` again.
- `world.mjs` gains `rules(list)`: stubs `gh` so that argv containing `api` prints `JSON.stringify(list)` and argv containing `pr list` prints `[]`,
  both exit 0. (`pr list` must answer `[]`, not empty stdout, or every branch becomes "PR status unknown".)

- [ ] **Step 1: Write the failing tests** in `survey.test.mjs` (one `test()` each, names prefixed `B1.`):
  1. `w.rules([{ type: 'pull_request' }])` → `trunkPrOnly: true`, reason `ruleset`.
  2. `w.rules([{ type: 'deletion' }, { type: 'non_fast_forward' }])` → `false`, `no-rule`. `w.rules([])` → `false`, `no-rule`.
  3. No `gh` stub on a github world → `true`, `gh-absent`.
  4. `gh` stubbed with `byArgs: { api: { exit: 1, stderr: 'HTTP 404' } }` → `true`, `gh-failed`; with `api` printing `{"message":"x"}` → `gh-failed`.
  5. `world(t, { host: 'gitlab.com' })` → `false`, `not-github`, and `w.calls()` holds no `gh` call with `api` in its argv.
  6. `git config git-sync.push false` on a github world with `w.rules([{ type: 'pull_request' }])` → `false`, `downgraded`, no `api` call recorded.
  7. Exactly one `gh` call whose argv contains `api` per `survey`, and its path argument is `repos/<slug>/rules/branches/main` where `<slug>` matches
     the world's origin. Plus direct unit cases of `githubSlugOf` for the https and scp forms above, `https://github.com/o/r` (no `.git`) and a
     `gitlab.com` URL (→ `null`).
  8. `trunkAhead`: trunk 2 commits ahead of `origin/main` → `2`; in sync → `0`.
  9. Review Focus 2: a branch merged only into 1 unpushed local trunk commit, PR-only world → not in bucket `merged`. Mirror with `w.rules([])` → `merged`.
- [ ] **Step 2: Run** `node --test test/survey.test.mjs` from `plugin/skills/git-sync/`. Expected: the B1 cases fail (missing fields / helper).
- [ ] **Step 3: Implement** `githubSlugOf`, `trunkRules`, the survey fields, the proof-ref switch and `rules()` in `world.mjs`.
- [ ] **Step 4: Run** `pnpm test:skills` from the repo root. Expect existing failures from Review Focus 1 (e.g. `survey.test.mjs` ~line 190
  `mergedLocallyOnly` on a github world now reads PR-only). Fix each by adding `w.rules([])` where the test is not about `gh`; where it is (e.g. the
  `s.gh === 'absent'` case ~line 341), keep the world and add an assertion that `trunkPrOnlyReason` is `gh-absent`. List every touched existing test in
  the task report. Re-run until green.
- [ ] **Step 5: Commit** `feat(git-sync): read the trunk's ruleset once per survey`.

### Task 2: Carry offer, question and plan action

**Files:** modify `tools/git-sync.mjs` (`survey`, `rounds`, `unattended`, `buildPlan`, `ACTION_RANK`, `readPlan` validation); test
`test/survey.test.mjs`, `test/plan.test.mjs`.

**Interfaces:**
- Consumes Task 1's `trunkPrOnly`, `trunkAhead`.
- `survey.carry`: `null` unless `trunkPrOnly && !downgraded && trunkAhead > 0`; then
  `{ branch, tip, ahead, commits: [{ sha, subject }] (oldest first), title }` with `branch`/`title` per Global Constraints and `tip` the full trunk sha.
- Produces `prTitleOk(title) → boolean` (the PR-title rule), exported for tests.
- Question appended **first** in `rounds` (it is about the trunk, the most important thing the run does): `id: 'carry'`, `header: 'PR-only'`,
  `multiSelect: false`, question `<trunk> only accepts pull requests here and <n> local commit(s) are not on origin. Move them to <branch> and open a PR?`
  (use the existing `plural` helper for "commit"), options `Open a PR` (description: `push <branch>, reset local <trunk> to origin/<trunk>, open "<title>"`)
  and `Leave on <trunk>` (description: `keep them local; nothing is pushed`).
- Answer key `carry`: `'pr' | 'keep'`. Add it to `ANSWER_KEYS`. `unattended` never sets it.
- `buildPlan`: `'pr'` → one action `{ kind: 'carry-trunk', target: carry.branch, expectTip: carry.tip, title: carry.title, commits: carry.commits }`;
  `'keep'` or absent → none; `'pr'` with `survey.carry === null` → `bad-answers` ("carry was not offered"); any other value → `bad-answers`.
- `ACTION_RANK['carry-trunk'] = 5` (after `delete-local`). `readPlan` accepts the kind: `target` must pass `check-ref-format --branch`, `expectTip` a
  `FULL_SHA`, `title` a non-empty string.

- [ ] **Step 1: Write the failing tests** (names prefixed `B2.`):
  - survey: PR-only, trunk 2 ahead → `carry.branch` matches `^sync/main-\d{8}-\d{4}$`, `ahead: 2`, `tip` = trunk sha, 2 commits oldest first, title
    `chore(git-sync): carry 2 local main commits`; `rounds[0][0].id === 'carry'` with the two labels exactly.
  - one commit `fix(api): x` → title `fix(api): x`; one commit `WIP stuff` → chore title; one commit `chore!: x` → chore title (`!` not allowed on chore).
  - PR-only, not ahead → `carry: null`, no `carry` question. Not PR-only (`w.rules([])`), ahead → `carry: null`, no question.
  - `unattended` has no `carry` key.
  - `prTitleOk`: true for `feat: a`, `fix(x-1): a`, `perf!: a`, `docs(y): a`; false for `chore!: a`, `Feat: a`, `feat(X): a`, `feat a`, `revert: a`.
  - plan: `{ carry: 'pr' }` → one `carry-trunk` action with those fields; `{ carry: 'keep' }` → no action; `{ carry: 'pr' }` against a survey with
    `carry: null` → stop `bad-answers`; `{ carry: 'yes' }` → `bad-answers`; a plan with a `delete-local` and a `carry-trunk` sorts `carry-trunk` last.
  - readPlan: a hand-written `carry-trunk` with `target: 'a b'` or `expectTip: 'main'` → stop `bad-plan`.
- [ ] **Step 2: Run** the two files; expect B2 failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:skills`; green.
- [ ] **Step 5: Commit** `feat(git-sync): offer to carry local trunk commits to a PR branch`.

### Task 3: `push-trunk` refuses a PR-only trunk

**Files:** modify `tools/git-sync.mjs` (`pushTrunk`, `REASON_TEXT`); test `test/push.test.mjs`, `test/e2e.test.mjs`.

**Interfaces:**
- Consumes `survey.json` (`readState(ctx, 'survey')`). Gate order: `not-allowed`, then **`pr-only`**, then the existing `no-verify` … chain.
- `pr-only` when `survey.json` says `trunkPrOnly: true` (`detail`: the reason), **or** when there is no readable `survey.json` this run (safe side;
  `detail: 'no survey this run'`). Shape `{ pushed: false, reason: 'pr-only', ahead: null, detail }`.
- `REASON_TEXT['pr-only'] = 'the trunk only accepts pull requests here'`.

- [ ] **Step 1: Write the failing tests** (`B3.`): PR-only survey, verify green, trunk 1 ahead → `pr-only`, `detail: 'ruleset'`, origin's `main`
  unchanged. No survey run → `pr-only`, `detail: 'no survey this run'`. Mirror: `w.rules([])` + survey + green verify → pushes (`reason: 'pushed'`).
  Downgraded world with no survey → still `not-allowed` (order).
- [ ] **Step 2: Run** `node --test test/push.test.mjs`; expect B3 failures.
- [ ] **Step 3: Implement.** Then fix the existing push and e2e cases that expect a push: add `w.rules([])` and a `survey` call before `push-trunk`.
  Do not change what they assert.
- [ ] **Step 4: Run** `pnpm test:skills`; green.
- [ ] **Step 5: Commit** `feat(git-sync): never push a trunk that only accepts PRs`.

### Task 4: `apply` runs `carry-trunk`

Logic-heavy (moves the trunk, pushes, spawns `gh`): this task gets its own review.

**Files:** modify `tools/git-sync.mjs` (`APPLY_STEPS`, a new `carryTrunk(ctx, r, a)`); test `test/apply.test.mjs`.

**Interfaces:**
- Consumes the Task 2 action. Returns the usual `[status, reason, detail?, extra?]`; `extra` is `{ pr: <url> | null, tip: <sha> }` on `done`.
- Re-proofs, in order, each a `skipped` with no side effects: HEAD is not the trunk → `not-on-trunk`; trunk tip ≠ `expectTip` → `tip-moved`;
  `refs/remotes/origin/<trunk>` missing or not an ancestor of the tip → `trunk-diverged`; `target` exists locally or as `refs/remotes/origin/<target>`
  → `branch-exists`.
- Then: create `refs/heads/<target>` at `expectTip`; push it to `origin` with upstream, never forced (reuse `pushWithUpstream` if it fits). Push fails →
  delete the just-created local branch, `failed`, `push-failed`, git's stderr as detail; trunk untouched.
- Then `git reset --keep refs/remotes/origin/<trunk>` on the trunk. Failure → `failed`, `reset-failed`, detail; the branch stays on origin (the
  report says the commits are on both).
- Then `gh pr create --base <trunk> --head <target> --title <title> --body <body>` with `GH_TIMEOUT_MS`. Body: one line
  `Opened by /git-sync: <trunk> only accepts pull requests here, so these local commits moved to this branch. Retitle before merging if they deserve a release.`,
  a blank line, then one `- <7-char sha> <subject>` line per commit. Success → `done`, `carried`, `{ pr: <first line of stdout, trimmed>, tip }`.
  Failure or ENOENT → still `done`, `carried`, detail = `gh pr create failed: <stderr first line>` (or `gh absent`), `{ pr: null, tip }`.
- Every carried branch is not a deletion, so nothing goes to `deleted.log`.
- `references/design.md` §10 gains invariant 11 (Task 6 writes it): "`carry-trunk` moves the trunk only after its carry branch is on `origin`, only by
  `reset --keep`, and only when HEAD is the trunk at the surveyed tip."

- [ ] **Step 1: Write the failing tests** (`B4.`, each with a real bare origin from `world`, `gh` stubbed with `byArgs: { 'pr create': { stdout:
  'https://github.com/o/r/pull/7\n' } }` unless stated):
  1. Happy path: origin has `refs/heads/<target>` at the old tip; local trunk equals `origin/main`; `w.calls()` holds one `gh` call whose argv
     includes `pr`, `create`, `--base`, `main`, `--head`, `<target>`, `--title`, `<title>`; result `done`/`carried`, `pr` = the URL.
  2. An extra commit on the trunk after the plan → `skipped`/`tip-moved`; origin has no `<target>`; trunk tip unchanged.
  3. HEAD switched to another branch → `skipped`/`not-on-trunk`; that branch's tip unchanged.
  4. `<target>` already exists locally → `branch-exists`; same name only on origin → `branch-exists`.
  5. Push refused (make origin reject: e.g. a `pre-receive` hook in the bare repo exiting 1) → `failed`/`push-failed`; no local `<target>`; trunk unchanged.
  6. `gh` stub `pr create` exits 1 with stderr `GraphQL error` → `done`, `pr: null`, detail starts `gh pr create failed: GraphQL error`; branch on
     origin; trunk reset. No `gh` on PATH → `done`, `pr: null`, detail `gh absent`.
  7. A title containing `$(touch pwned)` and a body subject with `` ` `` → passed verbatim as argv (assert the recorded argv), no file `pwned` created.
- [ ] **Step 2: Run** `node --test test/apply.test.mjs`; expect B4 failures.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test:skills`; green.
- [ ] **Step 5: Commit** `feat(git-sync): carry-trunk moves local trunk commits onto a PR`.

### Task 5: Report

**Files:** modify `tools/git-sync.mjs` (`report` and its helpers, `REASON_TEXT`); test `test/report.test.mjs`.

**Interfaces:**
- `REASON_TEXT` gains `not-on-trunk`, `tip-moved` (if absent), `trunk-diverged`, `branch-exists`, `push-failed`, `reset-failed` glosses, each one short
  clause in the existing voice.
- Trunk section, when push-trunk said `pr-only`: the existing "not pushed: pr-only (…)" line, plus — when a `carry-trunk` result is `done` — a line naming
  the branch, the PR URL (or `open it by hand: gh pr create --base <trunk> --head <branch>`), and a recovery line `git reset --keep <tip>` (run on
  `<trunk>`) to undo the trunk move.
- Warnings: `trunkPrOnlyReason` `gh-absent` / `gh-failed` → `could not read <trunk>'s rules (<reason>): treated as PR-only`. PR-only, `trunkAhead > 0`
  and no `carry-trunk` result → `<n> local <trunk> commit(s) stay unpushed: <trunk> only accepts pull requests here`.

- [ ] **Step 1: Write the failing tests** (`B5.`) over state files written directly, as the existing report tests do: carried with URL; carried with
  `pr: null`; `pr-only` with no carry and `trunkAhead: 3` (warning text exact); `gh-absent` warning; a non-PR-only run's report byte-identical to
  today's (pick one existing report fixture and assert it did not change).
- [ ] **Step 2–4:** run, implement, `pnpm test:skills` green.
- [ ] **Step 5: Commit** `feat(git-sync): report PR-only trunks and carried commits`.

### Task 6: SKILL.md, design.md, end-to-end

**Files:** modify `SKILL.md`, `references/design.md`; test `test/skill.test.mjs`, `test/e2e.test.mjs`.

- SKILL.md: step 3 — when `trunkPrOnlyReason` is `gh-absent` or `gh-failed`, say in one line before the decision round that the trunk is treated as
  PR-only and why. Step 4 table — row `carry` | `Open a PR` / `Leave on <trunk>` | `"carry": "pr"` / `"carry": "keep"`. Step 6 — add `pr-only` to the
  reason list and one sentence: on `pr-only` never offer to push by other means. The hard rule "Destructive operations happen only in `apply`…" gains
  "moving the trunk's local commits onto a PR branch" in its list; update `skill.test.mjs` T14.3's verbatim copy to match, and nothing else in it.
- design.md: §4 phase 6 row mentions PR-only; §6 gains a "PR-only trunk" bullet (the probe, the reasons, safe side, proof ref); §7 gains the `carry` row
  and `carry-trunk` in the action list; §10 gains invariant 11 (Task 4 text) and invariant 9's order gains `carry-trunk` last; §11 nothing; §12 gains the
  carry/pr-only lines; §16 gains one ruling "Phase B (2026-10-15): PR-only trunks" pointing at the release-pipeline spec.
- e2e (`B6.`): PR-only world with 2 local trunk commits, full flow with answers `{ "carry": "pr" }` → origin has the sync branch, local trunk equals
  origin, report contains the PR URL. Same world with `{}` → nothing pushed, report carries the "stay unpushed" warning.

- [ ] **Step 1–4:** tests, run, implement/edit, `pnpm test:skills` green; `pnpm test` at the repo root green (`test/plugin-manifest.test.ts` reads
  the plugin tree).
- [ ] **Step 5: Commit** `docs(git-sync): PR-only trunks in SKILL.md and design.md`.

### Task 7: Repo rules

**Files:** modify `.claude/CLAUDE.md`, `docs/workflows/ci.md`.

- `.claude/CLAUDE.md` §PR rules: add one bullet — `main` is PR-only (ruleset `main-pr-only`, `docs/workflows/ci.md`): every change reaches it through a
  PR, docs included; specs, plans and notes go through a `docs:` PR, which passes CI and cuts no release. Never bypass the ruleset.
- `docs/workflows/ci.md` §The ruleset: replace "Until phase B, direct pushes … are refused." with what now happens: git-sync reads the rule and offers a
  carry PR (link `plugin/skills/git-sync/references/design.md` §6); backlog-orchestrate's `--pr` mode is pending in `futin/backlog-manager`.
- [ ] **Step 1:** edit; `pnpm test` green (no doc-test touches these, but run it).
- [ ] **Step 2: Commit** `docs: main is PR-only, docs included`.

### After the branch (controller, not a task)

- Update memory `plan-docs-commit-straight-to-main.md` (lives outside the repo): docs now go through a `docs:` PR; rename/re-describe it and its
  `MEMORY.md` line.
- PR per the template; *Not verified* names: a real run of `/git-sync` against this repo's live ruleset (needs `pnpm plugin:sync` after merge), and
  backlog-orchestrate still writing `main` directly until its `--pr` mode lands.
- After merge: `pnpm plugin:sync`.
