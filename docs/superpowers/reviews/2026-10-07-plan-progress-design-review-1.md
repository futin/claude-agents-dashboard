# Review 1 — `docs/superpowers/specs/2026-10-07-plan-progress-design.md`

Reviewer: Fable 5.1 subagent, 2026-10-07. Read-only: the spec was not edited; no git state changed. Every data figure below was recomputed over
`~/.claude/projects/*/*.jsonl` (1,907 transcripts, 2.5 GB) with three one-pass scripts in the session scratchpad (`survey.py`, `survey2.py`, `survey3.py`),
and every code claim was read in the repo at HEAD `a6aa4b8`.

## Verdict: REVISE

Two Critical findings, both in the §2.1 signal rules: the "names an `sdd/…/progress.md` path" test is at once too narrow (misses the shell-variable
ledger writes most real runs use, so done counts come out wrong on 14 of the 51 surveyed runs) and too wide (a `Write`/`Edit` whose *content* quotes a
ledger counts as a ledger write — this very spec, written in this session, would mark Tasks 1–3 done on the next plan the session runs). Neither is
hard to fix; both change the fixtures and the survey rows, so the spec should be revised before a plan is written from it.

## Critical

### C1 · §2.1 lines 51, 54, 55 and §2.2 line 61 — the literal-path test misses the ledger writes real runs make

The spec counts a done, running or header signal only when the input "names a path matching `sdd/[^\s"']+/progress\.md`". Real controllers mostly
write the ledger through a shell variable, e.g. (this repo's own task-progress run, transcript `94a35534`):

```
cd …/.claude/worktrees/task-progress; W=.superpowers/sdd/2026-10-07-task-progress; cat >> $W/progress.md <<'EOF'
Task 2: complete (commits …)
EOF
```

That input contains `sdd/2026-10-07-task-progress` and `$W/progress.md` but never the contiguous `sdd/<x>/progress.md`, so under the rule as written it
is not a ledger write. Measured 2026-10-07 over all transcripts:

| Signal | contiguous `sdd/<x>/progress.md` in input | `progress.md` only via a variable | missed |
| --- | --- | --- | --- |
| `Task N: complete` inputs | 432 | 199 | 32 % |
| `SDD ledger — plan:` header writes | 57 | 38 | 40 % |
| `Task N: dispatched` inputs | 201 | 65 | 24 % |

Per run (the 51 runs since 2026-09-15 the spec surveys): 14 runs end with a different set of done ids under the strict rule than the ledger actually
holds — e.g. (strict, actual) = (0, 14), (0, 7), (0, 7), (5, 13), (2, 7), (8, 10) — and 5 of them show **0 done** while their ledger records 7–14
completions. The spec's own acceptance probe (line 136, "done count equal to the ledger's distinct completed ids") fails on those 14 before the PR
is opened. The survey row "SDD 14/18 wrote `Task N: complete`" (line 19) hides this because it counts runs with *at least one* strict hit.

**Fix.** Define "names the ledger" as: the input contains `progress.md` **and** `.superpowers/sdd/` (or `sdd/`) anywhere in the matched strings — not
one contiguous path. Add a fixture in the `W=…; cat >> $W/progress.md <<'EOF'` shape to tests 1 and 4, recompute survey lines 18–19 under the new
rule, and note the Trap (line 21) still holds because the header check keeps the `.md` requirement on `<p>`.

### C2 · §2.1 lines 45–46, 51, 54 — for `Write`/`Edit` the path is sought in `content`/`new_string`, so a document that quotes a ledger counts as one

Line 45 says matching runs on Write `file_path` + `content` and Edit `file_path` + `new_string`, and lines 51/54 say the input must "name" the
progress path — anywhere in those strings. So a `Write` of a spec, plan or test file whose body contains both `sdd/x/progress.md` and
`Task 2: complete` is a done signal for tasks 2 (and every other quoted N). Checked against this session's transcript: the `Write` of
`2026-10-07-plan-progress-design.md` (this spec: line 114 has `…/sdd/x/progress.md`, lines 117/118/134 have `Task 2: complete`, `Task 3: complete`)
matches the rule and yields done ids `1, 2, 3`. Under §2.2 line 65 those are *held* and applied to the first plan the session runs — so the next SDD
run in this session starts with three tasks already ticked. The implementer of this feature will write exactly such fixtures into `test/tasks.test.ts`
during Task N of the plan, and the card for that run will show spurious completions on every poll. D3 ("tool inputs only, never prose") does not
protect against this: a Write body *is* a tool input.

**Fix.** For `Write` and `Edit`, only `file_path` may qualify the input as naming the ledger (`file_path` matches `sdd/<x>/progress.md`); `content` /
`new_string` carry the lines. For `Bash`, the `command` qualifies (per C1). Add to test 4: a `Write` of `docs/…/spec.md` whose content quotes
`sdd/x/progress.md` and `Task 2: complete` → no effect; record it as the mutation proof for the `file_path`-only rule.

## Important

### I1 · §2.1 lines 52, 55 — `task-brief <p> <N>` as written misses the quoted-script form

Of 462 real `task-brief` invocations, 69 (15 %) have a closing quote immediately after the word — `SDD=…; "$SDD/scripts/task-brief" docs/plan.md 3` —
and 9 quote the plan argument. A regex built from the spec's text (`task-brief\s+(\S+)\s+(\d+[a-z]?)`) matches neither. **Fix:** allow an optional
`"` or `'` after `task-brief`, and strip quotes from `<p>` before the `.md` check; add one such fixture to test 5.

### I2 · §2.1 lines 51, 57 — `<p>` "ending in `.md`" is undefined at the token's end

Real headers are written as `printf '# SDD ledger — plan: docs/x.md\n' >> …` (the literal `\n` escape follows `.md`), or with `"`, `'` or a backtick
after the path: 7 of the 95 observed header writes end that way. A whitespace-delimited `<p>` fails the `.md` test and the plan signal is lost.
**Fix:** define `<p>` as the run of non-whitespace after `plan: `, with a trailing `\n` escape, quotes and backticks stripped, then require `.md`.
(One run wrote `# SDD ledger — plan: gh issue #183 (no plan file; plan is the issue body)` — correctly no plan; worth a row in §4.)

### I3 · §2.2 lines 61–62 — the record's `cwd` is the drifted shell cwd, not the run's root

The spec resolves a relative plan path against "the `cwd` field of the record that carried the plan signal" and claims a run that `cd`s into a
worktree thereby "resolves against the right root". The record's `cwd` is the shell's current directory *before* that command runs (the tool's own
`cd` has not happened yet), and it drifts to wherever the previous command left it — observed: record `cwd`
`…/worktrees/phase4a-inventory/.superpowers/sdd/2026-09-30-phase4a-inventory` (the SDD workspace itself) while the command reads
`cd …/worktrees/phase4a-inventory; … task-brief docs/superpowers/plans/… 3`. Resolving `docs/…` against that cwd gives a path that does not exist, and
the card silently degrades to `Task <id>` rows. 27 of 436 relative-path `task-brief` invocations begin with a `cd <dir>` that differs from the record
cwd. **Fix:** when the Bash `command` starts with `cd <dir>` (`;` or `&&`), use `<dir>` as the base; otherwise the record cwd. State the fallback when
the resolved file is missing (the sessions row's `projectPath`, i.e. the launch cwd, is the obvious second base). Test 15 should cover the `cd` form.

### I4 · §Survey line 18 and §Out of scope line 149 — "6/33" and "27 of 33" are false under the spec's own signal table

§2.1 lists `review-package <p> …` as a plan signal. Applying the full table to the 33 `executing-plans`-only runs resolves **8**, not 6: two runs
(`2026-10-02-index-strategy-environments`, `2026-09-30-schreiben`) name their plan only through `review-package`. So "the other 27 name no plan in
any signal" is 25. **Fix:** recompute line 18 and line 149 (8/33, 25), or drop `review-package` from §2.1 — the two must agree because the live probe
(line 136) compares against them. The SDD figures (18/18; ledger 13, task-brief 14, Skill 4; done 14/18; 9 of 12 since 09-28 with header; Agent
`Task N` 17/18; task-brief 14/18; EP 0/33 running signals) all recomputed exactly.

### I5 · §2.1 line 55 and §Verification line 158 — `Task <N>: dispatched` is not a superpowers 6.4.1 format

Line 158 says the ledger formats are those of the 6.4.1 skills. `subagent-driven-development/SKILL.md` and `executing-plans/SKILL.md` define only
`# SDD ledger — plan: <plan file path>` and `Task <N>: complete (…)`; neither contains a `dispatched` line (grep over both skill directories). The
266 `dispatched` lines on this machine are a controller habit, which a prompt or model change can drop with no skill revision. **Fix:** label the
`dispatched` signal as an observed convention (with the count and date) in §2.1 and in Verification, and keep Agent `description` + `task-brief`
as the running signals the design relies on.

### I6 · §2.4 line 81 and test 10 line 123 — "numeric order" is undefined for suffixed ids

Plans on this machine carry `### Task 4b:`, `5a:`, `5b:`, `9b:`. "Appended in numeric order" does not say whether `5a` sorts before `5b`, before or
after a bare `5`, or where `10` lands against `9b`; test 10 asserts the order, so two implementers write two different green tests. **Fix:** define
the key as (integer part ascending, then suffix ascending, bare before suffixed) and give test 10 ids that exercise it, e.g. input order `10, 5b, 2, 5a, 5`
→ `2, 5, 5a, 5b, 10`.

## Minor

- Line 39 vs lines 83 and 126: §1 says a plan with no headings and no ids "yields `null`"; §2.4 and test 13 say it falls back to the `TaskCreate` list
  (null only without one). Align §1 with §2.4.
- Line 21: the template literal count is 268 occurrences in 178 records (measured 2026-10-07, UTF-8 em dash; no `—`-escaped form exists), not 251.
  Either figure makes the point; state the counting unit.
- Line 64: "updates `cwd` only if it was null" is dead — every assistant record carries `cwd` (24,592 of 24,592 parsed, 2026-10-07). Harmless; say
  "never expected" or drop it.
- Line 129, test 16: "reuse case 13's construction" — `test/tasks.test.ts:177` (case 12) is the byte-exact chunk-boundary straddle; case 13
  (`:190`) is a > 1 MB record spanning chunks. Name the one you mean.
- Lines 131–134: the mutation-proofs paragraph sits between items 16 and 17; move 17 above it.
- Line 55: when a running signal names an id already in `done` (a late re-review dispatch "Review Task 4"), `live` becomes a done id, no row is
  `in_progress`, and the earlier live id is lost. Say whether running signals skip done ids.
- Lines 72–73 and 156–160: a plan file inside a worktree that was removed after the merge resolves to nothing, so a finished run's titles degrade to
  `Task <id>` — the same "workspace deleted" argument D1 (line 26) uses against reading `progress.md`. Name it under Verification, or fall back to the
  launch cwd (I3).
- Line 53: `args` "is a path ending in `.md`" misses forms like `docs/…/plan.md — continue P0-4 (13 domains outstanding)` and
  `Execute docs/…/plan.md task by task` — 6 EP invocations across 3 runs that have no other signal, 3 SDD. A deliberate choice is fine; say it is one,
  or take the first whitespace token ending in `.md`.
- Line 89: the prefilter marker `progress.md` also matches every line naming a plan file called `*-progress.md` — this repo's
  `2026-10-07-task-progress.md` — which is why 616 non-ledger inputs hit the prefilter in the survey. Cost only; worth a note beside the 1.5 s gate.
- Lines 8, 26, 117, 136 run to 161–215 columns (table rows on 15, 18, 51, 52, 55 are exempt); the user convention is 160 for prose.
- Line 95: the full `taskPlan` in a `title` is desktop-only here, which is right — the memory `title-attr-is-dead-on-touch` is why the phone line
  cannot carry it; a one-word pointer would stop the next reader asking.
- Line 37/38: adding a required `Session.taskPlan` breaks every fixture that builds a `Session` literal (`test/visual/fixtures/sessions.ts`,
  `test/filter-sort.test.ts`, `test/triage.test.ts`, `test/git-sync-client.test.ts`, per CodeGraph's blast radius); §1 could name them so the plan does.

## Verified true (no finding)

- Task-tool availability (lines 5–6): https://code.claude.com/docs/en/tools.md §"Task tool availability" — Claude 3.x, Opus 4–4.7, Sonnet 4–4.6,
  Haiku 4.5; "applies in Claude Code v2.1.268 and later"; anchor `#task-tool-availability` exists; opt-in `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
- Line 7: last `TaskCreate`/`TaskUpdate` call 2026-08-20T13:44Z, version 2.1.229; 0 task-tool calls and 0 `TodoWrite` in the 300 newest transcripts
  (300th mtime 2026-10-06 10:22); 1,907 transcripts; newest 300 run Opus 5.5 in 221, Sonnet 5.5 in 72, CLI 2.1.280–2.1.292.
- Line 15: 28 of the 30 newest plans have task headings; `### Task N:` 583, `## Task N:` 39; only `##`/`###` levels exist (40/588), no task heading
  inside a fenced block in any plan, so the `#{2,3}` rule and the absence of a fence rule are both safe today. Line 16: 1 of 30 has `- [x]`.
- Line 17: 51 runs since 2026-09-15 — 18 SDD, 33 executing-plans-only — exactly.
- Line 45: tool_use blocks are named `Agent` (2,065; `Task` 0) and `Skill` inputs carry `skill` + optional `args` (753 with args, 567 without);
  `"name":"Agent"` appears literally in the JSON, so the prefilter marker works.
- Line 46: no read-only Bash command (grep/cat/tail of the ledger) contains `Task N: complete` together with the path — 0 false-done candidates.
- Line 76: `^#{2,3} Task (\d+[a-z]?)(?: \([^)]*\))?\s*[:.—–-]\s*(.+?)\s*$` matches `### Task 8 — x`, `### Task 7 (conditional):`, `### Task 5a:` and
  rejects `## Task 1 findings` (the only separator-less heading in the corpus). `task-brief` itself accepts any heading level and separator and skips
  fences (`scripts/task-brief:33-39`) — a superset, so every brief-able task is a row.
- Line 90: the 1.5 s first-call gate is `docs/superpowers/plans/2026-10-07-task-progress.md:137`.
- Line 107: `TaskPill` (`client/src/components/sessions/atoms.tsx:66-74`) renders `3/3 ✓` when `allDone`; `TasksCard` shows `Not started` only when
  done = 0 and nothing is live (`TasksCard.tsx:38`).
- Lines 142–144: `docs/subsystems/sessions.md` §What a session shows (line 52, task subsection at 100), `docs/subsystems/chat.md` §What's shown
  (line 73), `docs/overview.md:167` Map line — all exist.
- Line 158: 6.4.1 is the only cached superpowers version; `# SDD ledger — plan:` and `Task <N>: complete (…)` are its formats
  (`SKILL.md:149, 437-438`; executing-plans `SKILL.md:138, 229`); `scripts/sdd-workspace` makes `.superpowers/sdd/<plan-basename>/`.
- CLAUDE.md: no `.claude/rules/`; the spec follows "types first, then producer, then consumer", keeps `server/` dependency-free, dates every
  measured figure, and keeps the dashboard read-only.
