# Review 1 — release pipeline phase B plan

**Plan:** `docs/superpowers/plans/2026-10-15-release-pipeline-phase-b.md` · **Spec:** `docs/superpowers/specs/2026-10-15-release-pipeline-design.md`
§Phase B (lines 77-94) · **Worktree:** `.claude/worktrees/git-sync-pr-only` · **Reviewer:** Fable 5.1 subagent, 2026-10-15.

**Verdict: APPROVE WITH FIXES.** No Critical findings. Five Important findings, all in how the plan describes existing tests it tells the implementer to
touch, plus one ambiguous warning condition. The feature design, spec values, interfaces and task order are sound; an implementer following the plan
literally would hit the five below as surprises mid-task, and two of them ("keep the world and add an assertion", "nothing else in it") point them at an
edit that cannot be done as written.

Method: every plan claim about the code was checked by reading `plugin/skills/git-sync/tools/git-sync.mjs`, `test/world.mjs`, `test/survey.test.mjs`,
`test/push.test.mjs`, `test/e2e.test.mjs`, `test/skill.test.mjs`, `test/plan.test.mjs`, `test/apply.test.mjs`, `SKILL.md`, `references/design.md`,
`.claude/CLAUDE.md` and `docs/workflows/ci.md`. No test suite was run (per brief). Line numbers below are at the worktree's current HEAD.

## Checklist

| # | Area | Result |
|---|------|--------|
| 1 | Coverage | Complete. Every §Phase B git-sync bullet (spec 80-88: survey probes once; `push-trunk` ok + `pr-only`; carry branch/title; unattended leaves commits and reports; downgrade unchanged; gh absent/failing ⇒ PR-only "and say so") maps to Tasks 1-5. Spec docs bullets (93-94) map to Tasks 6-7. Spec 51 pr-title regex is Task 2's `prTitleOk`. |
| 2 | Values | Match. Regex (plan 27-28 = spec 51), branch `sync/<trunk>-<YYYYMMDD-HHMM>` (plan 29 = spec 84), fallback title (plan 31-32 = spec 85), reasons list (plan 85) consistent with spec 87-88. |
| 3 | Reality | Mostly accurate; four misstatements about existing tests (I-1..I-4 below). All code anchors the plan cites exist: `remoteKindOf` 197, `repo` 238, `runGhPrList` 762, `ghStatus` 786, `branchRecords` 991 with the proof-ref ternary, `survey` 1087, `rounds` 1227, `ANSWER_KEYS` 1265, `ACTION_RANK` 1271 (max rank 4 today, so 5 is free), `buildPlan` 1281, `pushTrunk` 1617 gate order as stated, `readPlan` 1665, `pushWithUpstream` 1782, `localYmd` 1840, `apply` 2012, `REASON_TEXT` 2052, `trunkLines` 2110, `warningLines` 2229. `world.mjs` has no `rules` helper yet; `stub()` byArgs is substring-of-joined-argv, first match wins, re-stub overwrites. |
| 4 | Interfaces | Consistent across tasks: `trunkPrOnly`/`trunkPrOnlyReason`/`trunkAhead`/`carry` produced in T1-T2, consumed by T3-T5 under the same names; `carry-trunk` result shape `{kind,target,status,reason,detail}` matches `apply`'s existing result shape (2012-2050). |
| 5 | Order | Sound: survey fields → plan/answers → push gate → apply action → report → docs. Each task's tests depend only on earlier tasks. |
| 6 | Tests | Mostly specified as cases with expected values. Gaps: I-3 (fallout underscoped), I-4 (red-first cases that are already red), I-1 (named test does not contain what the plan says). |
| 7 | Plan's own conventions | Followed: no literal code blocks, exact expected values, red→green→commit per task, soft size budget, controller follow-ups listed. |

## Important

**I-1 — plan:235 — T14.3 does not hold a copy of the "Destructive operations…" rule.**
Plan: "update `skill.test.mjs` T14.3's verbatim copy to match, and nothing else in it." `test/skill.test.mjs:48-58` (T14.3) asserts exactly four
verbatim rules and none is `SKILL.md:136-138` "Destructive operations happen only in `apply`…". So there is nothing to update there, and "nothing
else in it" forbids the edit that *is* needed: T14.6 `everyKindSurvey()` (`skill.test.mjs:62-74`) has no `carry` field and asserts the exact prefix
list `['asked','merged','merged-pick','push','stash','worktree']`, so the new `carry` question either breaks T14.6 (if `rounds` emits it from that
fixture) or goes unpinned.
→ Replace with: T14.3 is untouched; extend T14.6's `everyKindSurvey()` with a `carry` offer and add `carry` to its prefix list, so the new row and its
label are checked. If the intent was to not pin the new SKILL.md sentence, say so explicitly.

**I-2 — plan:112 — "keep the world and add an assertion" cannot hold for T7.10.**
Plan: for the `s.gh === 'absent'` case (~line 341) "keep the world and add an assertion that `trunkPrOnlyReason` is `gh-absent`". But T7.10
(`survey.test.mjs:292-353`) also asserts `sq.bucket === 'merged'`, `sq.proof === 'M3'`, `mergedSet === ['sq']` against a squash commit that exists only
in local `main` (never pushed). Under the plan's own rule (gh absent ⇒ PR-only ⇒ proof ref `refs/remotes/origin/main`, plan 100-101) `sq` is no longer
merged, so the existing assertions flip — exactly the "weaken an assertion" the plan forbids at line 113.
→ Spell out the fixture change: push `main` after the squash in T7.10 (then `sq` is merged by M3 on both refs and the `gh-absent` assertion can be added),
or move the `gh-absent` reason assertion into its own small case and give T7.10 `w.rules([])`. Either way, say which.

**I-3 — plan:165 — push-test fallout is wider than "cases that expect a push".**
Plan 165: "fix the existing push and e2e cases that expect a push: add `w.rules([])` and a `survey` call". But with `pr-only` gated *before* the verify
chain (plan 156) and "no readable `survey.json` ⇒ `pr-only`" (plan 157), **every** non-downgraded push-trunk test that never ran `survey` flips to
`pr-only`, including ones that expect other reasons: T10.2 (`red`/`stale-verify`/`no-verify`), T10.5 (`nothing-to-push`), T10.6/T10.7 (`rejected`) in
`test/push.test.mjs:1-158` — none runs `survey`, none stubs `gh`. Only T10.4 (downgraded, `not-allowed`) survives on order.
→ "every non-downgraded `push-trunk` test gains `w.rules([])` and a `survey` call before `push-trunk`; only the downgraded `not-allowed` case does not."
(e2e T14.4/T14.5 already run survey via `run()`, `e2e.test.mjs:96,135`; they need only `w.rules([])`.)

**I-4 — plan:145 — the readPlan `bad-plan` cases are already green before implementation.**
Plan 145: hand-written `carry-trunk` with `target: 'a b'` / `expectTip: 'main'` → `bad-plan`. Today `readPlan` (`git-sync.mjs:1665-1700`) returns
`bad-plan` for *any* unknown kind (1683, 'unknown action kind'), so those cases pass before Task 2 and the red step at plan 146 does not red on them.
→ Assert `detail.why` (`'not a branch name'` / `'expectTip must be a full sha'`, whatever wording Task 2 picks) so the case distinguishes "kind known,
field rejected" from "kind unknown".

**I-5 — plan:219-220 — warning condition "no `carry-trunk` result" is ambiguous.**
A `skipped` or `failed` carry (plan 177-182 re-proofs) also leaves the commits unpushed, yet a literal reading suppresses the "stay unpushed" warning
because a result exists. The trunk-section line at 216-218 already keys on `done`.
→ "and no `carry-trunk` result with `status: 'done'`".

## Minor (file only)

- **M-1 — plan:85, 103** `world.rules(list)` keyed on argv containing `api` collides: `stub` matches by substring of the space-joined argv
  (`world.mjs` stub impl), and B2's fixture uses a title `fix(api): x`; a `gh pr create --title 'fix(api): x'` call would match the `api` key first.
  Key on `api repos/` (and `pr list`, `pr create` separately).
- **M-2 — plan:198-205 (B4 stub note)** `w.stub('gh', …)` overwrites the stub `w.rules()` installed, so a B4 test that calls both ends up with only the
  later one. Note that `rules()` and the `pr create` stub must be one combined `byArgs` map, or have `rules()` accept extra byArgs.
- **M-3 — plan:157** "no readable `survey.json`" should also cover a `survey.json` whose envelope is `ok: false` (readState returns the parsed object,
  `git-sync.mjs:136-150`; a stopped survey still writes its envelope). Safe side means treat that as PR-only too.
- **M-4 — plan:217** the hand-open fallback `gh pr create --base <trunk> --head <branch>` omits `--title`; the title lives in the plan.json action, not in
  the apply result, so either copy `title` into the `carry-trunk` result's extra fields or print the command without claiming it reproduces the title.
- **M-5 — plan:132** `survey.carry === null` → `== null`; plan-test surveys are sometimes hand-built (`plan.test.mjs` `planCli` takes answers against a
  CLI survey, but `test/skill.test.mjs` `everyKindSurvey()` is a literal) and will omit the field.
- **M-6 — plan:97** `trunkPrOnly && !downgraded` is redundant if `trunkPrOnly` is only computed for github remotes (`not-github` reason otherwise);
  keep one or the other, not both, or the two can disagree after a future edit.
- **M-7 — plan:158** `ahead: null` for `pr-only` though `trunkAhead` is in the survey the gate just read; `null` is fine for "no survey" but loses a
  known number otherwise. Cosmetic; the report gets it from `survey.trunkAhead` anyway.
- **M-8 — plan:255** `docs/workflows/ci.md:44-49` paragraph to replace is correctly identified ("Until phase B, direct pushes to `main` … are refused");
  `.claude/CLAUDE.md:103-117` already names `ci / pr-title`, so the new bullet should sit beside it rather than duplicate the rule.
- **M-9 — plan:2052 ref** `REASON_TEXT` has no gloss for `tip-moved` today although the reason is emitted three times; Task 5 adds glosses for the new
  reasons — adding `tip-moved` there too is in scope of "every reason has a gloss" but not of this plan; noting only so the implementer does not assume
  it exists.

## Strengths (one line)

Spec values transcribed verbatim; interfaces named once and reused; the proof-ref switch and "safe side when survey missing" are the two decisions a
naive implementer would get wrong and the plan calls both out.
