# Review 2 — `docs/superpowers/specs/2026-10-07-plan-progress-design.md`

Reviewer: fresh subagent (Fable 5.1), 2026-10-07. Inputs: the spec, the repo at `3bf95c5`, superpowers 6.4.1 as installed under
`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/`, all 1,907 transcripts under `~/.claude/projects` (read-only), and
https://code.claude.com/docs/en/tools.md. Scripts used for the measurements live in the session scratchpad (`survey.mjs`, `precise.mjs`, `edge.mjs`).

## Verdict: REVISE

One Critical: the design's done signal is blind to the ledger-writing script that superpowers 6.4.1's `executing-plans` skill ships, so a third of the
inline runs it surveys would show `0/N` while the spec calls that "honest". Three Important ambiguities/false facts, none expensive to fix.

## Critical

**C1 · spec:56–62, 121, 166, 176–177 — `executing-plans` 6.4.1 records progress through `scripts/task-done`, which no signal row matches.**
`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/executing-plans/scripts/task-done:39-42` writes
`# SDD ledger — plan: <plan>` and `Task <N>: complete (commits …, tests: …)` to `<workspace>/progress.md` itself; the controller's Bash input is
`bash …/scripts/task-done PLAN_FILE N BASE -- <test command>` (SKILL.md:224), which contains neither `progress.md` nor `Task N: complete`. The ledger
line reaches the transcript only as the script's stdout (`ledger: Task N: complete …`, line 42) — a `tool_result`, which D3 (spec:29) rightly excludes.
`scripts/task-start PLAN_FILE N` (the running signal's counterpart) is likewise unmatched. Measured over the 51 runs the spec surveys (first written
since 2026-09-15): 9 of 33 `executing-plans`-only runs run `task-done` (10 run `task-start`); 1 of 18 SDD runs does too. For those runs the design
yields `0/N`, and spec:121 ("honest: nothing recorded progress") and spec:166 ("inline runs that never write ledger lines") are false — they did write
ledger lines, through the skill's own script. The Verification row at spec:176 claims the formats are 6.4.1's; this is the 6.4.1 format it missed.
Also note `task-done <p> <N>` carries the plan path, so it is a plan signal for runs that today "name no plan in any signal" (spec:18).
→ Add two signal rows: Bash `command` containing `task-done <p> <N>` → plan = `<p>`, N done; `task-start <p> <N>` → plan = `<p>`, N running (same
quote handling as `task-brief`). Add `task-done` and `task-start` to the §2.5 prefilter, add test cases (plain and `"$S/scripts/task-done"` forms,
and a failing task-done — the script exits non-zero and writes nothing when tests fail, line 34 — must still count as *not* done only if the design
reads results; since it reads inputs, state explicitly that a failed `task-done` is counted done and accept or reject that), and re-run the survey
rows at spec:18–19 with the new rows before the live probe at spec:154.

## Important

**I1 · spec:74, 145, 179 — `Session.cwd` does not exist, and nothing carries the launch cwd into the fold.** The contract field is
`Session.projectPath` (`shared/types.ts:59-65`), produced at `server/lib/scan.ts:571` as `parsed.originCwd || parsed.cwd || null`.
`readSessionTasks(filePath)` takes only the path (`server/lib/tasks.ts:135`) and §2.4 (spec:98) widens the return type without adding a parameter, so
the implementer must invent how the retry base arrives. The same section leaves `plan.cwd === null` (spec:70, a record with no `cwd` field) with no
resolution rule for a relative `path`. → Name `projectPath`, give the new signature (e.g. `readSessionTasks(filePath, launchCwd: string | null)`),
state that a relative path with `cwd: null` goes straight to the launch-cwd attempt, and that both null means "unresolvable → empty heading list".

**I2 · spec:64 — the `<p>` strip rule is ambiguous on exactly the forms the data holds.** "Surrounding quotes … stripped" reads as balanced pairs, but
the common header form is `echo "# SDD ledger — plan: docs/x.md" > …`, where the non-whitespace run is `docs/x.md"` — a *trailing-only* quote (4 of
the 46 header commands measured, e.g. `docs/superpowers/plans/2026-09-28-tracker-header-strip.md"`). And test 18 (spec:148) needs `docs/p.md\n'`
→ `docs/p.md`, which only works if the quote is stripped *before* the `\n`; the other order leaves `docs/p.md\n` and fails the `.md` check.
→ Specify a loop: repeatedly strip a leading or trailing `"`, `'`, `` ` `` and a trailing literal `\n` until nothing changes, then require `.md`.
Add the trailing-only-quote form to test 1 or 18.

**I3 · spec:42 — `test/git-sync-client.test.ts` holds no `Session` literal.** `grep -rn "tasks: null" test client/src` names exactly
`test/filter-sort.test.ts`, `test/triage.test.ts`, `test/web-notify.test.ts`, `test/visual/fixtures/sessions.ts`; the spec lists git-sync-client (none)
and omits web-notify. Low impact — "any other the typecheck names" covers it — but the stated fact is false. → Replace git-sync-client with web-notify.

## Minor

- spec:109 — the full plan name goes in a `title` attribute. `docs/subsystems/usage-limits.md:382-384` records why this repo avoids `title` (never fires
  on touch, and this dashboard is mostly read from a phone); the phone line drops the name entirely (spec:110), so on the phone the plan name is
  unreachable. Taste; the repo rule is written for one grid, not globally.
- spec:102 — "Agent lines are common but short": an Agent `tool_use` carries the whole dispatch prompt (the SDD implementer prompt is several KB), so
  the lines are not short; the claim is unmeasured. The 1.5 s gate still bounds it (plan:136-137).
- spec:61 — a read-only or in-place command on the ledger that names a task (`sed -i '' "s#^Task 1: …"`, `grep 'Task 3: complete' $W/progress.md`)
  counts as a done signal. Measured: 2 of 528 ledger-done inputs lack a `>`/`>>`/heredoc; negligible, worth one sentence.
- spec:21 — the literal `SDD ledger — plan: <plan file path>` count is 181 today (spec: 178); drift since the morning's measurement, not an error.
- spec:20 — "435 of 484 task-brief calls match §2.1" was not re-verified over all transcripts; over the since-2026-09-15 window 195 of 227 match the
  spec's quote-aware pattern, 13 pass a `$VAR` plan (ignored by the `.md` rule as the spec says).
- spec:95 — id order example `2, 5, 5a, 5b, 10` agrees with the rule as stated; fine.

## Verified true (checklist 1)

- spec:5–7 — doc section "Task tool availability": "available by default only on Claude 3.x models, Opus 4 through 4.7, Sonnet 4 through 4.6, and
  Haiku 4.5"; "The default set described here applies in Claude Code v2.1.268 and later" (fetched 2026-10-07). Installed CLI is 2.1.292.
- spec:7–8 — 1,907 transcripts; the 300 newest by mtime reach back to 2026-10-06T08:22Z and none contains a `TaskCreate`/`TaskUpdate`/`TodoWrite`
  tool_use; the last task-tool call is 2026-08-20T13:44Z on version 2.1.229; `claude-opus-5-5` is the dominant model (6,464 of the records sampled).
- spec:15–16 — 93 plan files; `### Task N:` 583, `## Task N:` 39, three `### Task Nb:`, one `### Task Na:`, one `(conditional)`, one `## Task 1 findings`
  (the spec's own non-match); 28 of the 30 newest have task headings; 1 of 30 has a `- [x]`. No `#### Task` headings exist.
- spec:17–20 — 18 SDD / 33 executing-plans-only runs since 2026-09-15; ledger `Task N: complete` in an input: SDD 16/18, EP 4/33; Agent `Task N`
  descriptions SDD 17/18, EP 0/33; plan signal SDD 18/18, EP 12/33 by my (slightly broader, review-package-inclusive) count vs the spec's 11/33.
- spec:26 — both skills tell the controller to `rm -rf <workspace>` after the final review (SDD SKILL.md:482-483; executing-plans SKILL.md:300).
- spec:31–32 — D4's list (offset, chunking, deferral, shrink-reset, LRU, never-throw) matches task-progress spec §2.2 and `server/lib/tasks.ts:105-172`.
- spec:66 — `Task <N>: dispatched` appears in no 6.4.1 skill text; `Task <N>: complete (…)` is the ledger grammar (SDD SKILL.md:437-438,
  executing-plans SKILL.md:229).
- spec:71–73 — transcript records carry `cwd`, and `cd <dir>; W=.superpowers/sdd/…; echo "# SDD ledger — plan: docs/…" …` is a real observed form.
- spec:103 — the plan's Task 2 step 5 sets the 1.5 s first-call gate on the largest transcript (`2026-10-07-task-progress.md:134-137`); the largest
  file is 23.0 MB.
- spec:120 — the pill renders `3/3 ✓` (`client/src/components/sessions/atoms.tsx:72`); the card's `✓ All tasks done` / `Not started` copy matches
  `client/src/components/TasksCard.tsx:38`.
- spec:146 — test case 12's byte-exact straddle construction exists at `test/tasks.test.ts:177-188`.
- spec:160–161 — `docs/subsystems/sessions.md:52` "What a session shows", `docs/subsystems/chat.md:73` "What's shown", `docs/overview.md:167` Map line.
- Scope (checklist 5): out-of-scope items are named; nothing in scope depends on them. CLAUDE.md hard rules (no server deps, `shared/types.ts` first,
  dated measurements inline, stable CSS class names): respected.
