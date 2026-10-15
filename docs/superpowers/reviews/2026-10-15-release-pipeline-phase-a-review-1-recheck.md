# Plan re-check — Phase A (CI gate), changes after review 1

Reviewed: `docs/superpowers/plans/2026-10-15-release-pipeline-phase-a.md` at `f2725f3`, only the hunks in `plan-a-diff.patch` (header override lines
9–11; Task 1 lines 66, 76–80, 93, 95; Task 2 lines 110–117, 123, 129–133; Task 3 lines 145–182; Task 5 lines 227, 234–241), against the spec
`docs/superpowers/specs/2026-10-15-release-pipeline-design.md` and review 1. Reviewer model: Fable 5.1. Autopilot: no decisions or parked questions
were needed — the brief was fully specified.

## Verdict

**REVISE.** One Critical: the install auto-detect the diff adds to `ci-node.yml` falls through to `npm ci` for release-kit itself, which has no lockfile,
so release-kit's own `self.yml` run is red and the new held step 1b (wait for it to go green) can never be passed. Three Important: `engines.node >=20`
is false for the new test glob (probed on Node 20.19.5), the six merge fields are named without the `-f`/`-F` distinction that decides whether GitHub
receives booleans or strings, and one new test case ("grep its `run:` for the push branch") names no string to grep for.

Review 1's findings C-1 and I-1 … I-9 are all addressed by the diff; the Critical below is a consequence of the I-5 fix (the `install-command` input and
its auto-detect fallback) meeting release-kit's own zero-dependency layout.

## Critical

**C-1. release-kit's own `checks` job runs `npm ci` with no lockfile and fails.** Plan lines 160–161 (changed): "run `install-command` when given, else
install with the lockfile frozen (`pnpm install --frozen-lockfile` when `pnpm-lock.yaml` exists, else `npm ci`)". Plan line 172 (changed): `self.yml`
passes only `check-commands` and `kit-ref` — no `install-command`. Task 1 Step 1 (line 66) scaffolds release-kit with `package.json`, `.gitignore`,
`LICENSE` and "no dependencies"; nothing in the plan runs `npm install`, so no `package-lock.json` ever exists. Probed on this machine with the npm that
ships with Node 22.23.1 (npm 10.9.8): `npm ci` in a directory holding only `package.json` exits with `npm error code EUSAGE — The npm ci command can
only install with an existing package-lock.json or npm-shrinkwrap.json`. So every `self.yml` run on release-kit — the push at held step 1 and any PR —
reports `ci / checks` red, held step 1b (line 227, "wait for release-kit's own `self.yml` run … to go green") never completes, and the `v1` tag is never
cut as the spec orders it (spec line 262). The Task 3 tests (lines 166–175) cannot catch this; the plan itself marks runtime behaviour unverified until
the held push (line 181).
→ Make the auto-detect three-way: `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `package-lock.json` → `npm ci`; neither → a step that echoes
"no lockfile — install skipped" and succeeds. Add a Task 3 test case: the install step's `run:` names both lockfile filenames and the skip text.
(Alternative that keeps the fallback as written: `self.yml` passes `install-command: 'echo no dependencies'` and the test pins it — but then every
adopter without a lockfile hits the same red run, so the three-way detect is the better fix.)

## Important

**I-1. `engines.node >=20` is false for the new test script.** Plan line 66 (changed) sets `scripts.test` = `node --test 'test/**/*.test.mjs'` and keeps
`engines.node` `>=20`. Probed on this machine: Node v20.10.0 and v20.19.5 (the last 20.x installed under `~/.nvm`) both print
`Could not find '…/test/**/*.test.mjs'` — positional arguments are paths on 20.x, globs only from 21. Node 22.23.1 runs the glob (`# pass 2`). The
plan's Tech Stack line (20) already says Node 22, and `ci-node.yml` defaults `node-version` to `22`.
→ `engines.node` `>=22` (or `>=21`, but 22 is what every other line of the plan assumes).

**I-2. The six merge fields are named without saying which are typed.** Plan lines 114–116 (changed) list `allow_squash_merge=true`,
`allow_merge_commit=false`, `allow_rebase_merge=false`, `squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`,
`delete_branch_on_merge=true`; line 123 (changed) asserts "each of the six fields with its value". `gh api` has two flags: `-f`/`--raw-field` sends the
value as a JSON string, `-F`/`--field` converts `true`/`false` to JSON booleans. An implementer who writes all six with `-f` (the more common flag) sends
`"allow_squash_merge": "true"`, which the API's schema validation rejects as not a boolean — and neither the fake `gh` test (it only logs argv) nor
`--dry-run` (it makes no write call) can tell the two apart. Review 1 I-3 asked for "the six `-f`/`-F` fields"; the diff kept the fields and dropped the
flags.
→ State it: the four booleans go through `-F`, the two enum strings through `-f`; make the line-123 assertion check the exact `-F key=value` /
`-f key=value` tokens.

**I-3. "grep its `run:` for the push branch" names no string.** Plan line 173 (changed): "the `skills` job's script handles `push` without reading a PR
base sha (grep its `run:` for the push branch)". "The push branch" reads as a git branch; the implementer must guess what to assert. The behaviour block
(lines 164–165) does give the observable text: `push — skills gate is PR-only`.
→ "assert the `skills` job's `run:` contains the literal `push — skills gate is PR-only`, and that the line reading the base sha is inside a branch
on `github.event_name`".

## Minor

- Line 172 (changed): `self.yml`'s `check-commands: node --test 'test/**/*.test.mjs'` — inside a YAML scalar the single quotes are passed to the shell
  verbatim, which is what is wanted; say "quoted exactly as in `package.json`" so nobody "cleans" them off (unquoted, the runner's `bash` expands `**`
  without `globstar` and matches one level only).
- Line 169 and line 172 overlap: "exactly the six inputs above and their defaults" already covers "`install-command` input with an empty default".
  Keep one.
- Line 227: numbering `1b.` inside an ordered list; and `gh run list -R futin/release-kit` does not wait — `gh run watch -R futin/release-kit <id>` does
  (review 1's suggestion).
- Line 240: the checker prints only `ok: ci` (line 62), never the title, so "the log shows the text unexpanded" is observed in the step's expanded
  `env:` block, not in the checker's output — say so. Also say the test PR is closed, not merged.
- Line 237–241 table: fine as a slot; it lacks a row for Review Focus 3 (settings script run twice). That one is proved by the Task 2 tests, so a row
  reading "Task 2 test `existing [{"id":42 …}] → PUT`, plus running held step 5 twice" would make the table complete.
- Wrap at 160 columns (user CLAUDE.md §Conventions, applies to new text): changed lines 66 (161), 115 (202), 123 (183), 133 (168), 151 (189),
  163 (167), 240 (175) exceed it. Line 3 (222) is template text, not new.
- Line 151–152 "No job sets `name:`" — correct (a reusable-workflow context is `<caller job name> / <called job name>`, `name:` overriding the id).
  Task 5's `ci.yml` behaviour block (line 213) was not updated, but "or any app's `ci.yml`" on line 151 covers it.

## Checklist notes

1. Coverage — the override (9–11) mirrors spec lines 270–271; `install-command` (148) restores the spec line 43 input; held step 1b restores spec
   rollout step 1's order; the proof table answers spec line 258. The four new positive title rows and `feat add x` cover spec line 238.
2. Values — ruleset parameters (110–113) match the rulesets API's `pull_request` parameter names; `ref_name.exclude: []` is required alongside
   `include`; the six merge fields match spec lines 69–70. The hostile title on line 240 matches the `ci` alternative of the regex. The `BaseLoader`
   claim (166–168) is true: probed, `safe_load("on:\n x: 1")` → `{True: …}`, `BaseLoader` → `{'on': …}`.
3. Reality — `/Users/andrejajevtic/Documents/custom-projects/release-kit` does not exist (Create, correct); `lookout-widgets/LICENSE` exists;
   `python3` is 3.11 with PyYAML 6.0.3; `gh` on PATH, `shellcheck` not (plan says so, dated); `docker` on PATH. `node --test 'test/**/*.test.mjs'`
   runs 2/2 on Node 22.23.1 and excludes `test/fixtures/fake-gh.sh`.
4. Interfaces — the six inputs (148–150) are consumed consistently by 160, 169, 172; the job ids and contexts are unchanged.
5. Order — Task 3 depends on nothing later; held step 1b sits before 2 as the spec requires.
6. Tests — every new case (76–80, 123, 129–130, 171–173) fails before its implementation; the line-173 case is under-specified (I-3) and the
   line-123 case cannot distinguish `-f` from `-F` (I-2).
7. Conventions — behaviour, not code, throughout the changed text; one 160-column slip per Minor above.
