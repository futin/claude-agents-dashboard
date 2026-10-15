# Review 2 — `docs/superpowers/specs/2026-10-15-release-pipeline-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-15. Read-only; the document was not edited. Repo state: worktree `spec-wt` on `fix/request-guards`.
`<doc>` below is the spec; line numbers are from `cat -n` of the file as reviewed (264 lines).

## Verdict

**APPROVE WITH FIXES.** No Critical findings. Nine Important findings: three are internal contradictions (tag filter, release range vs recovery step,
breaking-`chore` type), the rest are gaps an implementer would have to guess at (loop semantics on "no PR", ruleset-identical vs optional `skills`
check, HTML-commented template sections leaking into notes, how a reusable workflow reaches its own `dist`, token permissions for the pulls call, and
where git-sync's rules call lives plus the PR title it would use).

## What was verified as true

| Claim (doc line) | Evidence |
|---|---|
| No tags, workflows, CHANGELOG, releases, protection, rulesets (15) | `git tag` empty; `.github/` has only `ISSUE_TEMPLATE`, `pull_request_template.md`; `gh api …/rulesets` → `[]`; `…/branches/main/protection` → 404; `gh release list` empty |
| `package.json` 0.1.0 never moved; `plugin.json` 0.3.0 (16) | `git log -p -- package.json` shows one `+ "version": "0.1.0"`; `plugin/.claude-plugin/plugin.json:4` |
| Merge shapes on `main` (17) | 67 `Merge pull request`, `Merge backlog/194: …` etc. present |
| git-sync pushes trunk when green; `git-sync.push=false` downgrade (19, 83) | `plugin/skills/git-sync/tools/git-sync.mjs:15,220,1617-1622` (`not-allowed` when `!pushAllowed`) |
| Visibility: dashboard, lookout-widgets, backlog-manager, guide-manager public; lookout private (20-21) | `gh repo view … --json visibility` |
| `pnpm test:skills` required-green rule (47) | `.claude/CLAUDE.md:31` |
| `--base` on backlog-orchestrate (85) | `backlog-manager/skills/backlog-orchestrate/SKILL.md:30` |
| Memory "plan docs go straight to main" (89) | `~/.claude/projects/…/memory/plan-docs-commit-straight-to-main.md` |
| `git tag --cleanup=strip` deletes `#` lines; `verbatim` keeps them; trailers parse (123-124, 147) | Probed in a tmp repo: strip dropped `# heading` and `#123 ref`; verbatim kept both; `git interpret-trailers --parse` returned `Release-Type: feat` |
| `gh release create --verify-tag` exists (125) | `gh 2.94.0` help |
| `repoRoot()` walk-up in `server/lib/usage-history.ts` (167) | `server/lib/usage-history.ts:426-439` |
| `lookout-widgets` dep form and package shape (181, 208, 213) | `package.json:38` `github:futin/lookout-widgets#v0.1.0`; `lookout-widgets/package.json` `exports` → `dist/esm`+`dist/cjs`, `files: ["dist"]`; `dist/` tracked in git |
| `test/server-deps.test.ts` pins name + tag (182) | `test/server-deps.test.ts:17-18` |
| `Markdown` takes `{ text }`; `SideRail` exists (187, 191) | `client/src/components/Markdown.tsx:85`, `client/src/components/SideRail.tsx` |
| Bump example: `ci` merge cuts nothing, hand tag `v0.1.0`, next `feat` → `v0.2.0` (249-250) | Agrees with the table at 115-119 |
| `feat(backlog): 3 items` passes the pr-title regex (51, 87) | Recomputed |
| No `Release`/`ReleasesResponse` name collision in `shared/types.ts` (163-165) | grep empty |

## Important

### I1 — `<doc>:113`, `<doc>:170-172` — `--tags` + `v[0-9]*` contradict "lightweight tags ignored / same vX.Y.Z filter"
Line 170 says the list keeps only annotated full `vX.Y.Z` tags and that `git describe` "uses the same `vX.Y.Z` filter"; lines 113 and 172 then give
`git describe --tags --match 'v[0-9]*'`. `--tags` makes lightweight tags candidates and `v[0-9]*` matches the floating `v1` (which release-kit's own
repo carries, and release-kit runs the same `release.yml` on itself per line 202). Probed: with annotated `v0.1.0`, lightweight `v1` and lightweight
`v9.9.9`, `git describe --tags --match 'v[0-9]*'` → `v9.9.9-1-g…`; without `--tags` → `v0.1.0-2-g…`. So `current` can name a version the `releases`
list does not contain (chip shows `v9.9.9`, panel has no such entry), and step 4 in release-kit can describe to `v1` and fail to parse.
→ Drop `--tags` in both commands (annotated only, which is what the reader keeps) and use `--match 'v[0-9]*.[0-9]*.[0-9]*'`; add a test "lightweight
`v9.9.9` and floating `v1` present → `current` and the bump ignore them" (line 231 only covers "only lightweight tags").

### I2 — `<doc>:101-103` vs `<doc>:107-108`, `<doc>:228-229` — the range excludes the commit step 1's recovery needs
The range is "every first-parent commit **after** the newest `v*` tag reachable from the target". If step 6 failed after step 5 pushed the tag, that
tagged commit is the newest tag and is therefore outside every later run's range, so "tag present but release missing → run step 6 only" never
executes, and the test at line 229 asserts behaviour the range definition prevents. A `workflow_dispatch` on the tagged sha is self-contradictory
("after the newest tag" vs "up to and including the target").
→ Define the range as starting **at** the newest tag's commit (inclusive) so step 1 sees it, or add a step 0 "ensure the newest tag has its GitHub
Release" before the loop; say which and keep the line-229 test.

### I3 — `<doc>:109-110` — "No PR found → exit 0 with a notice" inside a per-commit loop
Steps run "once per commit in the range" (102). `exit 0` ends the job, so one untracked commit (the baseline-tag commit after a hand push, a doc
pushed straight to `main` before Phase B lands, or any direct push on `lookout`, whose gate is explicitly not enforced per lines 21-22) stops every
later commit in the range from being released, silently and green.
→ "No PR found → annotate a notice, skip this commit, continue with the next"; add it to the release-range tests (line 228).

### I4 — `<doc>:111-112` vs `<doc>:30`, `<doc>:137`, `<doc>:163`, `<doc>:191` — `chore!:` releases, but nothing downstream can represent it
Step 3 says a breaking change releases whatever its type, `chore!:` included. The trailer contract allows only `Release-Type: <feat|fix|perf>`, the
API `type` is `feat|fix|perf|baseline`, and the UI has type badges only for Feature / Fix / Performance ("Breaking is not a fourth type"). D2 says
"other types do not" cut a release. The implementer must invent a value or drop the `chore!` case.
→ Pick one: (a) restrict breaking releases to `feat|fix|perf` and strike "`chore!:` included"; or (b) let `Release-Type` carry any type from the
pr-title regex, widen `type` accordingly, and name the badge for the extra types. Update D2 to match.

### I5 — `<doc>:54` vs `<doc>:64` — "ruleset JSON identical across apps" vs `ci / skills` only where declared
One `rulesets/main.json` cannot both be identical everywhere and list `ci / skills` only for this repo. `apply-repo-settings.sh <owner/repo>` has
no input for it. A required `ci / skills` on an app whose `ci.yml` never declares the job leaves every PR pending forever — the very failure line 57
warns about.
→ Either make `main.json` a template and give the script a `--check ci/skills` (or `--with-skills`) flag that appends the context, or require every
app's `ci-node.yml` call to always emit `ci / skills` (reporting success when the input is off) so the ruleset really is identical. State the choice.

### I6 — `<doc>:144-149` + `.github/pull_request_template.md:58-115`, `.claude/CLAUDE.md` PR rules — HTML-commented sections and the footer leak into notes
The repo's template keeps optional sections as multi-line `<!-- … -->` blocks that contain `## Heading` lines, and CLAUDE.md says optional sections
"are commented out — delete the ones that don't apply". A `## What's new` added that way matches `^## ` from inside the comment, so the extractor
(line 144) would return the placeholder prose as release notes; and when the section is the last one before the template's trailing
`🤖 Generated with …` line (`pull_request_template.md:117`), that line becomes part of the notes. Line 149's "deleted for PRs with nothing
user-visible" also means an undeleted placeholder ships as notes.
→ Specify: strip `<!-- … -->` blocks before extraction; place the section uncommented above `## Why this shape` (so it is never last); treat a
section whose only content is the template placeholder as empty. Add test cases "section inside an HTML comment → absent" and "section followed by the
footer line → footer excluded" to line 230.

### I7 — `<doc>:96-97`, `<doc>:213-214` — the reusable `release.yml` has no checkout of release-kit, so it cannot run `dist/`
A called reusable workflow runs in the caller's repository; `actions/checkout` there checks out the app, not `futin/release-kit`, so "`release.yml`
runs the compiled `dist` through Node" has nothing to run. Also, "checkout with full history" is a step the called workflow owns, not something the
caller configures.
→ State that `release.yml` performs a second `actions/checkout` of `futin/release-kit` at `ref: ${{ github.job_workflow_sha }}` (the called
workflow's own sha, so the `v1` pointer governs the script too) into a sub-directory, and runs `node <that dir>/dist/...`; move "full history" to the
called workflow's own checkout of the app.

### I8 — `<doc>:97` — `permissions: contents: write` alone makes `GET /repos/{repo}/commits/{sha}/pulls` fail where it matters
An explicit `permissions:` block sets every unlisted scope to `none`, so `GITHUB_TOKEN` has no `pull-requests` read. On the private `lookout`
(lines 21-22, which adopts Phase C) the step-2 call returns 403/404 and every commit becomes "no PR found" (then I3). Public repos may be served
anyway, which would hide the defect until lookout adopts.
→ `permissions: contents: write, pull-requests: read` in the caller (the called workflow can only narrow), and list it in the adoption README.

### I9 — `<doc>:79-84` — where the rules call lives, and the PR title of the offered branch, are unspecified
The offer is made "inside its existing single decision round", which is built from `survey` (phase 3) and answered into `plan` (phase 4)
(`git-sync.mjs:12-15`), while the `gh api …/rules/branches/{trunk}` check is described on `push-trunk` (phase 6). Both need the answer, and
`push-trunk` deliberately never calls out (`git-sync.mjs:1605-1610`). And `gh pr create` needs a title that passes Phase A's `pr-title` check; the
spec names none, so a branch named after the first commit subject fails CI on arrival.
→ Say: `survey` makes the single rules call, records `trunkPrOnly` (and the reason: `rule`, `gh-absent`, `call-failed`) in its state; `plan` and
`push-trunk` read it. Name the title rule (a decision-round question, or `chore(sync): <N> commits moved off <trunk>`) and the branch name pattern.

## Minor

- `<doc>:83` vs `<doc>:84` — "repos without that rule keep today's behaviour" is contradicted one line later: a rule-less repo without `gh` goes
  PR-only. Reword to "repos where the call succeeds and lists no rule".
- `<doc>:101` — "first-parent" range, but `git describe` (113) is not first-parent-restricted; true only on the linear history D4 enforces. Say so,
  or compute the range with `git rev-list --first-parent <tag>..<target>` and name that command.
- `<doc>:113` — in a multi-commit range, `git describe` must run from the commit being processed after the previous iteration's tag exists locally;
  the chaining is implicit. One sentence.
- `<doc>:119` / `<doc>:111` — "`BREAKING CHANGE:` in the body": whole PR body or only the `## What's new` section? Say "anywhere in the PR body".
- `<doc>:174` — `git rev-parse --git-common-dir` prints the relative `.git` from the main worktree (probed); resolve against `repoRoot()` or pass
  `--path-format=absolute`. `packed-refs` may not exist; say a missing file hashes as "absent".
- `<doc>:216`, `<doc>:248` — `v1.1.0` "at rollout step 4": by hand, or by release-kit's own `release.yml`, which runs on the very push that adds it
  (its merge is presumably `feat`)? Both at once races on the same tag name. Name one.
- `<doc>:3`, `<doc>:29` vs `<doc>:85` — "a plan per phase" but Phase B has two (one here, one in backlog-manager).
- `<doc>:51` — the regex omits `style` and `revert`; 5 of the 75 merged PR titles to date would not pass (`Redesign`, `Feat/usage token refresh`, …),
  which is fine going forward but worth a line in the README so the first failing title is not a surprise.
- `<doc>:144` — stop condition is `^## ` only; a stray `# ` top-level heading would be swallowed into the notes. Taste.
- `<doc>:188` — the `localStorage` key name is not given; the client test at 237 needs one.
- `<doc>:17` — `main` also moves by `Merge branch 'main'` back-merges inside PR branches (19 of them); not a third way onto `main`, but the sentence
  reads as exhaustive.

## Checklist coverage

1. Facts — verified above; the false/contradicted ones are I1, I5, I7.
2. Consistency — I1, I2, I4, I5, Minor 1 and 7.
3. Edge cases — I2 (step-6 failure recovery), I3 (untracked commit in a range), I6 (comments/footer), I8 (private repo), I9 (title); Minor on
   `packed-refs` absent.
4. Copy — badges, chip and tooltip rules consistent across §UI; the only copy gap is the git-sync PR title (I9).
5. Scope — out-of-scope list is explicit; nothing in scope depends on it (the Lookout widget and `plugin.json` are untouched).
6. CLAUDE.md hard rules — `shared/types.ts` first, the `server/` dep allow-list + `test/server-deps.test.ts`, `test:skills` green, theme tokens, no
   `process.cwd()`: all respected by the text. The PR-template convention is the one rule the spec trips (I6).
