# Review 1 — Release Pipeline Phase A plan

Plan: `docs/superpowers/plans/2026-10-15-release-pipeline-phase-a.md` (at fd9539a)
Spec: `docs/superpowers/specs/2026-10-15-release-pipeline-design.md` (same commit)
Reviewer: Fable 5.1, fresh session, paths + checklist only. Autopilot run: no questions asked; nothing in the document was edited.

## Verdict

**REVISE.** One Critical: the test command the plan hands to `package.json`, every Run step and `self.yml` (`node --test test/`) does not run tests
on Node 22 — it treats the directory as a module and exits red with zero cases executed (probed on this machine, v22.23.1). Nine Important findings,
most of them places where an implementer must guess a value the GitHub API or PyYAML will reject, plus three spec deviations the plan does not record.

## Coverage — spec sections in scope → tasks

| Spec section (line) | Plan task | Status |
|---|---|---|
| §Workflows in each app: thin caller, Node version input, check commands (43–45) | T3, T5 | covered; **install-command input dropped** (I-5) |
| Path-filtered `skills` job, filter inside the job (47–49) | T3 (143–145), T5 | covered; push-event behaviour unspecified (I-6) |
| `test:visual` stays out (50) | Global constraint 28 | covered |
| `pr-title` job: regex, `!` only on releasing types, re-runs on `edited` (51–53) | T1, T3, T5 (193) | covered |
| Contexts `ci / checks|pr-title|skills`, caller job id `ci`, `skills` always runs (55–58) | Global 23–27, T3 | covered; job `name:` can silently rename a context (I-4) |
| Names read off the first real PR before `apply-repo-settings.sh` (58–59) | T5 held steps 4–5 | covered |
| §Ruleset: target main, PR required, 0 approvals, dismiss nothing, 3 checks strict, linear, no force/delete, no bypass (63–67) | T2 | covered; `dismiss_stale_reviews_on_push` omitted (I-2) |
| Repo merge options, idempotent (69–70) | T2 | covered; "the four settings" is six API fields (I-3) |
| §First-run risk: Linux green before ruleset (72–75) | T4 | covered |
| §release-kit repo tree, Phase A files (212–224) | T1–T3, T5 | covered (see M-8 on `scripts/` vs `files: ["dist"]`) |
| Tags `v1.0.0`, floating `v1` moved by hand (230–232) | T5 held step 2, README (199) | covered; tag before self-CI is green (I-8) |
| §Testing, release-kit title classification cases (238) | T1 Step 2 | **partial** — see I-1 |
| §Testing line 258: real runs, "the plan records which runs proved which behaviour" | T3 Step 4 (161) | no record slot in the plan (I-8) |
| §Rollout steps 1–2 (262–263) | T5 held steps | covered |
| Line 270: workflow and ruleset files are dictated for the user to type | — | **contradicted** by T2 S4, T3 S3, T5 S1 (I-9) |

Spec test cases out of scope for Phase A (bump table, tag round-trip, release range, What's new extraction, `readReleases`, dashboard API/UI) are
correctly listed under "Not in this plan" (213–216).

## Critical

**C-1. `node --test test/` runs nothing on Node 22.** Plan lines 62 (`scripts.test`), 84, 86, 119, 121, 159, 161 (every Run step) and 147
(`self.yml` `check-commands: node --test test/`). Probed on this machine with Node v22.23.1 (the version the plan pins at line 16 and the
`node:22` image runs, 22.23.1 per `docker run node:22 node -v`): a one-test fixture under `test/a.test.mjs` gives
`Error: Cannot find module '.../test'`, `# pass 0 / # fail 1` — the directory argument is loaded as a module, no test file is discovered, exit code 1.
`node --test 'test/**/*.test.mjs'` on the same fixture gives `# pass 1`. As written, Task 1 Step 3 "expect every case to fail" passes for the wrong
reason, Step 5 "all pass" can never be reached, and the committed `package.json` plus `self.yml` ship a red self-CI that the plan says is
unverified until the held push (161). → Replace every occurrence with `node --test 'test/**/*.test.mjs'` (quoted, so Node's own glob expands it and
the fixture `.sh` under `test/fixtures/` is never picked up), including the `check-commands` value in `self.yml` and the test at line 158 if it
pins that value.

## Important

**I-1. Spec title-classification cases not all mapped.** Spec line 238 requires "each allowed type" and "missing colon". Plan Step 2 table (66–80)
has positive rows for `feat`, `fix`, `perf`, `docs`, `ci` only — `chore`, `test`, `refactor`, `build` have no passing case (a regex that drops
one of them passes every listed test), and there is no missing-colon case (`feat add x`); `feat:x` at line 75 is the missing-*space* case. → Add
one `ok: true` row per remaining type (at least `chore: x`, `test: x`, `refactor: x`, `build: x`) and a `feat add x` → false row.

**I-2. `pull_request` rule parameters incomplete for the API.** Plan line 101 lists "0 approvals, no code-owner/last-push/thread requirements".
The rulesets API's `pull_request` rule requires all five parameters — `dismiss_stale_reviews_on_push`, `require_code_owner_review`,
`require_last_push_approval`, `required_approving_review_count`, `required_review_thread_resolution` — and the POST is rejected (422) when one is
missing; the spec names the fifth at line 65 ("dismiss nothing"). Same for `conditions.ref_name`, which needs both `include` and `exclude` (plan
names only `include`). → Enumerate all five parameter names with their values (`dismiss_stale_reviews_on_push: false`,
`required_approving_review_count: 0`, the other three `false`) and `exclude: []`, and add them to the line-117 JSON assertions.

**I-3. "The four merge settings" is ambiguous — it is six API fields.** Plan lines 31, 103, 111. "Squash only" (spec line 69: merge commits and
rebase off) is `allow_squash_merge: true`, `allow_merge_commit: false`, `allow_rebase_merge: false`; plus `squash_merge_commit_title: PR_TITLE`,
`squash_merge_commit_message: PR_BODY`, `delete_branch_on_merge: true`. An implementer who sends literally four fields leaves merge commits enabled
and D4 (spec line 32) unenforced. → Name the six `-f`/`-F` fields in the Behaviour block and make the line-111 log assertion check each one.

**I-4. A job `name:` would silently rename a required context.** Plan lines 23–24 and the Task 3 test at line 153 check job *ids*. GitHub reports a
reusable-workflow job as `<caller job name> / <called job name>`, where `name:` overrides the id when set. Nothing in the plan forbids `name:` on
`checks`/`pr-title`/`skills` in `ci-node.yml` or on `ci` in `self.yml`/`ci.yml`, so a tidy-minded implementer adding `name: Checks` makes the
contexts `ci / Checks` and `main.json` locks `main` (spec 58–59). → Add "no job sets `name:`" to the Task 3 behaviour block and the line-153 test,
and to Task 5's `ci.yml` behaviour (193).

**I-5. Spec's install-command input dropped without a recorded deviation.** Spec lines 43–44: inputs are "Node version, the install command
(pnpm via `packageManager` + corepack), and the list of check commands". Plan line 133–134 lists five inputs with no install command; line 139
auto-detects from `pnpm-lock.yaml`. The auto-detect is reasonable (dashboard has `pnpm-lock.yaml` and `packageManager: pnpm@12.6.0`,
`package.json:31`), but the spec and plan now disagree on the workflow's public interface, which is exactly what `v2` is reserved for (spec 232).
→ Either add an `install-command` input (default empty = auto-detect) or state the deviation in the plan's header so the spec is amended in the
same PR.

**I-6. `skills` job behaviour on `push` is unspecified.** Plan line 143–144 computes `git diff --name-only <base sha>...<head sha>` "of the PR",
but `ci.yml` (193) also triggers on `push` to `main`, where `github.event.pull_request.base.sha` is empty and the diff command fails — turning the
always-green job red on every merge. → State what `skills` does on a non-PR event (simplest: echo and succeed, nothing gates pushes), and add a
test case or a line in the Task 3 behaviour block.

**I-7. The workflow tests look up `on.workflow_call`, but PyYAML yields key `true`.** Plan line 151–152. `yaml.safe_load` (YAML 1.1) parses the
bare key `on` as boolean; through `json.dumps` it becomes `"true"`. Probed with the plan's exact one-liner on this machine's python3 (PyYAML 6.0.3):
`on:\n  workflow_call: {}` → `{"true": {"workflow_call": {}}}`. A test written as "has `on.workflow_call`" fails against a correct workflow and the
implementer must guess why. → Say the test reads `doc["on"] ?? doc["true"]`, or pass `yaml.load(..., Loader=yaml.BaseLoader)` (no implicit typing)
in the one-liner — which also keeps `node-version: 22` a string, as the input default at line 133 wants.

**I-8. Held steps tag `v1` before release-kit's own CI has run.** Plan lines 206–207: step 1 pushes, step 2 tags `v1.0.0`/`v1` immediately. Spec
rollout step 1 (262) puts "its own CI" before the tag, and spec line 258 says the plan "records which runs proved which behaviour" — the plan has
no such slot. Since Task 3 Step 4 (161) declares runtime behaviour unverified until this push, a broken `ci-node.yml` would reach `@v1` and every
dashboard PR check would fail at workflow parse. → Insert "wait for the `push` run of `self.yml` on release-kit to go green (`gh run watch`)"
between held steps 1 and 2, and add a table (behaviour → run URL) for Review Focus 1, 2, 4 to be filled by the user after the held steps.

**I-9. Plan has subagents write the workflow and ruleset files; the spec says they are dictated for the user to type.** Spec line 270
("Workflow and ruleset files are dictated for the user to type; mechanical code edits are done directly"); plan Task 2 Step 4 (120), Task 3 Step 3
(160), Task 5 Step 1 (201) all say "write"/"implement". The plan already states one override of a template (5–7); this one is of the approved spec
and is silent. → Either mark those steps "dictate the file content to the user" or add an explicit override line in the header (and amend spec
line 270) so the choice is recorded rather than defaulted.

## Minor

- **M-1** Plan 108–109: the real call is `gh api repos/o/r/rulesets` with no `-X`; say the fake treats "no `-X` and path ends in `/rulesets`" as
  the GET, so it is not confused with `-X PUT …/rulesets/42`.
- **M-2** Plan 138–139: "run each line … as its own step-equivalent" — a reusable workflow cannot create steps dynamically; say "one `run:` step,
  `set -e`, `::group::<command>` per line" so the intent is implementable.
- **M-3** Plan 195: concurrency keyed on the PR number collapses every `push` to `main` into one group (`number` is empty), and
  `cancel-in-progress: true` then cancels the previous merge's run. Harmless (nothing gates pushes) but worth `|| github.sha` as the fallback key.
- **M-4** Plan 175–177: add `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` to the container environment; `node:22` ships corepack 0.34.6 (probed
  2026-10-15), which supports `pnpm@12.6.0` but prompts before downloading on some shells.
- **M-5** Plan 209: `gh pr create --title …` without `--body-file`/`--fill` prompts interactively; the PR body must follow
  `.github/pull_request_template.md`, so say so.
- **M-6** Plan 85: comparing `import.meta.url` with `process.argv[1]` needs `pathToFileURL(process.argv[1]).href` (and `realpath` under symlinks);
  mention the conversion, else the CLI guard never fires.
- **M-7** Plan 154: the injection guard greps `run:` values only; `with:` values that reach a script-running action are the same surface. Cheap to
  widen to "any string value anywhere".
- **M-8** Plan 59 vs spec 223: Phase C's `conventional` importing `scripts/pr-title.mjs` conflicts with `"files": ["dist"]` — `scripts/` is not in
  the published package, so `dist/` would import a file consumers never receive. Not a Phase A defect; note it for the Phase C plan (move the regex
  to `src/` then, or add `scripts` to `files`).
- **M-9** Review Focus 5 (44–45) has no test, only a procedure (Task 4). Acceptable for a platform-portability item; say so explicitly in the list.
- **M-10** Plan 203 claims doc-link coverage; confirmed — `test/docs-links.test.ts:1-7` resolves every relative link under `docs/`.
  `docs/overview.md:357-362` is the workflow-docs list the new line goes under.

## Checklist notes

- **Values**: regexes (plan 25 = spec 51), contexts (23 = 56–57), ruleset name, merge options (31 = 69–70), tag commands (207 = 230–231) all
  match the spec verbatim. The CLI hostile-title case `feat: $(touch …)` matches `^(feat…)…: .+` so exit 0 is the right expectation (82).
- **Reality**, all verified on this machine 2026-10-15: `/Users/andrejajevtic/Documents/custom-projects/release-kit` does not exist (61);
  `lookout-widgets/LICENSE` is MIT with a holder line (52); `.github/` holds only `pull_request_template.md` and issue templates, no `workflows/`
  (186); `docs/workflows/ci.md` absent, directory exists (187); `docs/overview.md` has `## Map` at :331 (188); `.claude/CLAUDE.md` has
  `## Commands` :25 and `## PR rules` :101 (188–189); no test under `test/` mentions `.github` (201); branch `docs/release-pipeline-spec` exists
  (170); `shellcheck` not on PATH (121); `node:22` image present, `python3` has PyYAML 6.0.3 (151, 177); `package.json:14-15` has `test` and
  `test:skills`, `:31` `packageManager: pnpm@12.6.0`, `pnpm-lock.yaml` present (139, 180).
- **Interfaces**: `PR_TITLE` env / exit codes (T1 → T3), the five `ci-node.yml` inputs (T3 → T5: `check-commands`, `skills-command`,
  `skills-paths`, `kit-ref` default `v1`), `apply-repo-settings.sh <owner/repo> [--dry-run]` (T2 → T5 held step 5) all agree in spelling and type.
- **Order**: T1 → T3 (CLI), T3 → T5 (inputs), T4 independent, T5 last; held steps ordered so `v1` exists before the dashboard PR is opened. Only
  gap is I-8.
- **Tests**: each task's tests precede its implementation and would fail on a missing module/file. Review Focus 1–4 each have a pinning test
  (checks no `if:` 155; title only via `env:` 82 + 154; PUT-not-POST 112; skills no job-level `if:` 156). RF5 is procedural (M-9). Gaps: I-1,
  I-2/I-3 (assertions reference an unnamed field set), I-4, I-6.
- **Conventions**: "behaviour not literal code" is respected — the only literals are shell/docker commands (151, 175, 206–211), which are
  values, not code. Dated machine figures carry their date (121, 177, 181). 160-column wrap holds.
