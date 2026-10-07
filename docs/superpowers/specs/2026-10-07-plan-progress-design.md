# Plan progress — Design

Status: approved in chat 2026-10-07 · Follows: `docs/superpowers/specs/2026-10-07-task-progress-design.md` (PR futin/claude-agents-dashboard#185, merged)

The task-progress pill and drawer card shipped reading `TaskCreate` / `TaskUpdate`. Current sessions never call those tools: since Claude Code v2.1.268
they are provided by default only on Claude 3.x, Opus 4–4.7, Sonnet 4–4.6 and Haiku 4.5 (https://code.claude.com/docs/en/tools.md#task-tool-availability),
and this machine runs Opus 5.5. The last task-tool call on this machine is dated 2026-08-20 (v2.1.229); none of the 300 newest transcripts (mtime back to
2026-10-06) calls `TaskCreate`, `TaskUpdate` or `TodoWrite` (measured 2026-10-07, 1,907 transcripts). This design feeds the same UI from the plan documents that multi-task runs actually execute, without enabling the
task tools.

## Survey (measured 2026-10-07, all transcripts in `~/.claude/projects`, recency checked — see memory `survey-data-recency-before-design`)

| Signal | Finding |
| --- | --- |
| Plan headings | 28 of the 30 newest plan files across `~/Documents/custom-projects/*/docs/superpowers/plans/` have task headings. Heading forms over all plans: `### Task N:` 583, `## Task N:` 39, plus `### Task 5a:` and `### Task 7 (conditional):` |
| Plan checkboxes | 1 of those 30 plans has any `- [x]`; checkboxes are not a progress signal |
| Runs | 51 transcripts first written since 2026-09-15 invoke the skill: 18 `subagent-driven-development` (SDD), 33 `executing-plans` only |
| Plan signal (§2.1) | SDD 18/18 (ledger header 13, `task-brief` 14, Skill args 4). `executing-plans`-only 6/33 — the other 27 name no plan in any signal and show no card |
| `Task N: complete` ledger lines | SDD 14/18 (9 of the 12 since 2026-09-28 also wrote the header); `executing-plans`-only 2/33 |
| Running signals | Agent description `Task N`: SDD 17/18; `task-brief <plan> N`: SDD 14/18; `executing-plans`-only 0/33 (it runs inline, no dispatches) |
| Trap | the literal `SDD ledger — plan: <plan file path>` occurs 251 times — it is the skill's own template text, not a run |

## Decisions

- **D1 · Source = the session's own transcript plus the plan file on disk (approach A).** The plan path and done/running state come from the session's tool
  calls; task titles come from the plan file. Rejected: reading `.superpowers/sdd/<plan>/progress.md` on disk — runs delete that workspace when they finish, so
  a finished run would lose its card; both sources combined — two code paths for little gain.
- **D2 · Plan wins.** When a transcript yields both a plan run and a `TaskCreate` list, `Session.tasks` is the plan's list.
- **D3 · Tool inputs only, never prose.** Signals count only inside a `tool_use` block's `input`. Chat text, compaction summaries, skill bodies and tool
  results never count — this conversation itself quotes `Task 1: complete` in prose.
- **D4 · Same fold.** The plan signals ride the shipped incremental fold in `server/lib/tasks.ts` — same offset, chunking, deferral, shrink-reset, LRU and
  never-throw rules (task-progress spec §2.2). No second pass over the file.
- **D5 · Same UI.** The pill, card, phone fold, states and helpers are unchanged except the card's head label (§3).

## 1. Contract — `shared/types.ts`

- `SessionTask` is unchanged. Plan rows use `id` = the task number as written (`"3"`, `"5a"`), `subject` = the heading title, `activeForm: null`.
- New `Session.taskPlan: string | null` — the plan's file name without `.md` (e.g. `2026-10-07-task-progress`) when `tasks` came from a plan, else `null`.
- `Session.tasks` keeps its meaning: `null` = nothing to show. A plan with no task headings and no task numbers seen in the transcript yields `null`.

## 2. Server — `server/lib/tasks.ts`

### 2.1 Signals (all inside one `tool_use` block's `input`, D3)

The raw line only feeds the prefilter (§2.5). Matching runs on these string values of the parsed input and nothing else: Bash `command`; Write `file_path` +
`content`; Edit `file_path` + `new_string` (never `old_string` — an Edit that turns `Task 3: dispatched` into `Task 3: complete` must not re-mark 3 running);
Skill `skill` + `args`; Agent `description`. Within one input, done signals apply after running signals.

| Signal | Matches when | Effect |
| --- | --- | --- |
| Plan, from ledger | input names a path matching `sdd/[^\s"']+/progress\.md` **and** contains `SDD ledger — plan: <p>` with `<p>` ending in `.md` | plan = `<p>` |
| Plan, from script | Bash `command` runs `task-brief <p> <N>` or `review-package <p> …` with `<p>` ending in `.md` | plan = `<p>` (task-brief also marks N running) |
| Plan, from skill | Skill `skill` ends with `subagent-driven-development` or `executing-plans` and `args` is a path ending in `.md` | plan = `args` |
| Done | input names an `sdd/…/progress.md` path and contains `Task <N>: complete` | N done (every match in the input) |
| Running | `Task <N>: dispatched` in an input naming `sdd/…/progress.md`; an Agent `description` containing `Task <N>` (word-bounded); a `task-brief <p> <N>` command | the latest such N is the running candidate |

`<N>` is `\d+[a-z]?`. The `<plan file path>` template literal never matches because it does not end in `.md`.

### 2.2 Entry state

The per-file entry gains `plan: { path: string; cwd: string | null; done: Set<string>; live: string | null } | null`. `path` is as written; `cwd` is the
`cwd` field of the record that carried the plan signal (records carry their own `cwd`; a run that `cd`s into a worktree resolves against the right root).

- A plan signal naming the same resolved path as the current plan updates `cwd` only if it was null. A **different** path replaces the plan and resets `done`
  and `live` — a session that runs two plans shows the latest.
- Done and running signals before any plan signal are held and applied to the first plan (a ledger is often written before the first `task-brief`), then
  dropped on any later plan change.
- `live` is cleared when that N becomes done.

### 2.3 Plan file read

At `readSessionTasks` time, when `entry.plan` is set: resolve `path` (absolute as-is, else against `plan.cwd`), `stat` it, and parse task headings when its
mtime differs from the cached one (module-level cache by resolved path, bounded like the transcript LRU). Never throws: a missing or unreadable plan is an
empty heading list.

Heading rule: a line matching `^#{2,3} Task (\d+[a-z]?)(?: \([^)]*\))?\s*[:.—–-]\s*(.+?)\s*$`. Ids keep plan order; a duplicate id keeps the first heading.
`## Task 1 findings` (no separator) does not match.

### 2.4 Composing the list

Rows = the plan's headings in order, then any id seen in done/running signals but absent from the headings, appended in numeric order with subject
`Task <id>`. Status per row: in `done` → `completed`; equal to `live` → `in_progress`; else `pending`. If the row list is empty → fall back to the
`TaskCreate` list (D2 only applies when the plan yields rows). `taskPlan` = basename without `.md` when the plan yields rows, else `null`.

The return type widens to `{ tasks: SessionTask[] | null; plan: string | null }`; `scan.ts` sets `tasks` and `taskPlan` from it.

### 2.5 Prefilter

The line prefilter adds markers `progress.md`, `task-brief`, `review-package`, `"name":"Agent"`, `subagent-driven-development`, `executing-plans`. Agent
lines are common but short; the measured cost on the largest transcript must stay under the 1.5 s first-call gate (task-progress plan, Task 2).

## 3. Client

- `client/src/lib/tasks.ts` — unchanged.
- `TasksCard` desktop head: `Plan · <name>` when `taskPlan` is non-null, else `Tasks`. `<name>` is `taskPlan` with a leading `YYYY-MM-DD-` removed
  (`2026-10-07-task-progress` → `task-progress`); the full `taskPlan` goes in a `title`. The label ellipsises in one line (`min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap`); the count stays right-aligned and never shrinks. The phone folded line reads `Plan` instead of `Tasks`
  (no room for the name there). Pill unchanged.
- Pass `taskPlan` from `ChatDrawer` alongside `tasks`.

## 4. States

| Case | Shows |
| --- | --- |
| No plan signal, no `TaskCreate` | nothing (unchanged) |
| Plan signal, plan file found, 0 done | card + `0/N` pill, `Not started` |
| Plan file missing, ledger says Tasks 1–3 done | rows `Task 1`…`Task 3` completed, `3/3 ✓` |
| Inline `executing-plans` run without ledger lines | the plan at `0/N` — honest: nothing recorded progress |
| Plan amended mid-run (new heading) | new row on the next poll (mtime changed) |
| Two plans in one session | the latest plan only |

## 5. Testing — `test/tasks.test.ts` (new cases), fixtures in the per-run temp root, plan files written beside them

1. Ledger header via a Bash `printf … >> …/sdd/x/progress.md` resolves the plan; headings become pending rows in order; `taskPlan` = basename.
2. Same header written via Write `content`, and via Edit `new_string` — both resolve.
3. The template literal `SDD ledger — plan: <plan file path>` in a tool input yields no plan.
4. `Task 2: complete` in a Bash input naming `progress.md` → row 2 completed; the same string in assistant text, a user record, or a tool_result → no effect.
5. `task-brief docs/…/p.md 3` → plan resolved **and** row 3 in_progress; a later `Task 3: complete` clears live.
6. Agent `description: "Implement Task 4: …"` → row 4 in_progress; `"Review Task 4 (spec + quality)"` keeps 4 live; a description without a number does not.
7. Skill `subagent-driven-development` with `args` = plan path resolves the plan; empty args does not.
8. Done lines before any plan signal apply once the plan appears.
9. A second, different plan resets done/live; the list is the second plan's.
10. Plan file missing → rows from done/running ids, subject `Task <id>`, numeric order.
11. Plan amended (append a heading, bump mtime) → new row on the next call; the transcript is not re-read (bytesRead unchanged).
12. Heading forms: `## Task 1:`, `### Task 5a:`, `### Task 7 (conditional):`, `### Task 8 — x` match; `## Task 1 findings` does not; duplicate id keeps first.
13. Plan with zero headings and no ids → falls back to the `TaskCreate` list (and to `null` without one).
14. Plan and `TaskCreate` both present → plan rows win.
15. Relative plan path resolves against the carrying record's `cwd`, not the process cwd.
16. Chunk boundary: a ledger line straddling `CHUNK_BYTES` still counts (reuse case 13's construction).

Mutation proofs to record: drop the `progress.md` requirement → 4's prose/tool_result variants stay green but a fixture with `Task 2: complete` in an
unrelated Bash input must go red (add it as 4b); drop the `.md` check → 3 red; drop the reset → 9 red.

17. Edit with `old_string` `Task 3: dispatched` and `new_string` `Task 3: complete` on a `progress.md` path → 3 completed, not live.

**Live probe (acceptance):** run the fold over the 51 runs since 2026-09-15 (survey table). Report: runs that resolve a plan; of those with ledger `Task N: complete` lines,
how many show a done count equal to the ledger's distinct completed ids; first-call time on the largest transcript. A mismatch is investigated before the PR,
not explained away.

## 6. Docs

`docs/subsystems/sessions.md` §What a session shows and `docs/subsystems/chat.md` §What's shown: the source is now plan-first, why (the task-tool
availability change, with its date and the doc link), the signals table in brief, and `taskPlan`. `docs/overview.md` Map line for `server/lib/tasks.ts`
updated.

## Out of scope

- Inline runs that never write ledger lines getting progress (they show 0/N).
- `executing-plans` runs that name their plan in no signal — 27 of 33 measured (2026-10-07). Inferring the plan from a `Read` of a plans file was weighed and
  left out: sessions read many plans they don't execute.
- backlog-manager items and `backlog-orchestrate` runs (their progress lives in the backlog store, not a plan ledger).
- Native plan mode (`~/.claude/plans/*.md`) and `ExitPlanMode`.
- Ticking plan checkboxes, or writing anything anywhere — the dashboard stays read-only.
- Enabling `CLAUDE_CODE_ENABLE_TODO_TOOLS`.

## Verification — not proven by this design

- Ledger and script formats are those of superpowers 6.4.1 skills (`subagent-driven-development`, `executing-plans`) as used here through 2026-10-07; a skill
  revision that renames `Task N: complete` silently drops progress to 0 done (degrades, does not lie).
- A plan edited after a run finished shows today's headings against yesterday's progress.
