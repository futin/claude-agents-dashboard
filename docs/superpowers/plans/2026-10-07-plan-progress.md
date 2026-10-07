# Plan Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose:** this plan specifies behaviour, signatures and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch (user's global CLAUDE.md, §Learnings). Where the template asks for a
> code block, read the behaviour list instead and write the code yourself. If the spec and this plan disagree, the spec wins; if you think both are
> wrong, say so in your report rather than guessing.

**Goal:** Feed the shipped task-progress pill and drawer card from the superpowers plan a session is executing, since current models never call
`TaskCreate`.

**Architecture:** A new pure module `server/lib/plan-progress.ts` turns one `tool_use` block into plan / done / running signals, parses a plan file's task
headings (cached by mtime), orders ids and composes the row list. The existing incremental fold in `server/lib/tasks.ts` calls it per block, keeps the
plan state on its per-file entry, and `readSessionTasks` returns `{ tasks, plan }`. `Session` gains `taskPlan`; the card head reads `Plan · <name>`.

**Tech Stack:** Node + TypeScript via `tsx` (server, Node built-ins only), React + Vite (client), node-assert tests in `test/` run by `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-10-07-plan-progress-design.md` — read it whole before Task 1; its §2.1 signal table and §5 test list are the
authority this plan argues from. The shipped design it extends: `docs/superpowers/specs/2026-10-07-task-progress-design.md`.

## Global Constraints

- `server/` takes **no new dependencies** — Node built-ins only; no new outbound call (`test/outbound.test.ts` pins the list).
- ESM, server imports use the `.js` suffix; cross-boundary imports are `import type`.
- `shared/types.ts` changes first, then the server producer, then the client consumer.
- **No colour or shadow literal** in `client/src/styles.css` below the theme-token block; **no `max-width` media query** (`test/breakpoints.test.ts`).
- Keep existing CSS class names stable (`tasks-kv`, `tf-k`, `k`, `ag-pill tasks`, …).
- **D3 — tool inputs only.** A signal counts only inside a `tool_use` block's `input`: never message text, tool_result blocks, `toolUseResult`, or
  compaction summaries.
- Matching reads these input fields only: Bash `command`; Write `file_path` + `content`; Edit `file_path` + `new_string` (never `old_string`); Skill
  `skill` + `args`; Agent `description`.
- `<N>` is `\d+[a-z]?`. Template literal `SDD ledger — plan: <plan file path>` must never resolve.
- The fold stays never-throw, incremental, chunked (spec D4 → task-progress spec §2.2). No second pass over a transcript.
- Every figure measured off this machine's data carries its date inline. Authored prose and comments wrap at 160 columns; comments say *why* only.
- Run `pnpm test` in the foreground — no background wait loops. Ad-hoc scripts run from the scratchpad directory, never the repo root (`server/lib`
  writes are cwd-relative).

## Review Focus

1. **A plan quoting task headings inside a fenced code block** (plans show examples) — a person expects no phantom rows. Headings inside ` ``` ` fences
   are ignored. Owned by Task 1 (case U12b).
2. **A plan file with CRLF line endings** — titles must not carry a trailing `\r`. Owned by Task 1 (case U12c).
3. **A plan path that names a directory, or a file that cannot be read** — no throw; treated as a missing plan (`Task <id>` rows). Owned by Task 1
   (case U13).
4. **A session that switches plan A → B → A** — shows A, with A's progress reset (only signals after the switch back count). Owned by Task 2 (case 9b).
5. **A transcript dense with Agent dispatches** (prompts of several KB each) — first poll stays under the 1.5 s gate. Owned by Task 2 (Step 6 measure).

---

### Task 1: Pure plan module (`server/lib/plan-progress.ts`)

**Files:**
- Create: `server/lib/plan-progress.ts`
- Create: `test/plan-progress.test.ts`
- Modify: `test/run-all.ts` — import `run` from `./plan-progress.test.js` and add it to the `failed +=` sequence like the other modules.

**Interfaces:**
- Consumes: nothing from other tasks; `SessionTask` / `TaskStatus` from `shared/types.ts` (already exist).
- Produces (exact names; Task 2 imports them):
  - `type PlanSignal = { kind: 'plan'; path: string; base: string | null } | { kind: 'done'; id: string } | { kind: 'live'; id: string }`
  - `planSignals(name: string, input: Record<string, unknown>, recordCwd: string | null): PlanSignal[]` — every signal in one block, in this order:
    plan signals, then running, then done (spec §2.1 "done applies after running").
  - `stripPlanToken(raw: string): string` — the strip loop.
  - `compareTaskIds(a: string, b: string): number`
  - `parsePlanHeadings(text: string): { id: string; title: string }[]`
  - `readPlanHeadings(absPath: string): { id: string; title: string }[] | null` — `null` when missing, not a regular file, or unreadable; cached.
  - `resolvePlanFile(p: string, base: string | null, projectPath: string | null): string | null` — first absolute candidate whose
    `readPlanHeadings` is non-null; else `null`.
  - `composePlanTasks(headings: { id: string; title: string }[], done: ReadonlySet<string>, live: string | null): SessionTask[]`
  - `resetPlanCache(): void` — test seam.

**Behaviour (spec §2.1, §2.3, §2.4 are authoritative; summary only):**
- **Ledger input:** Bash `command` containing both `progress.md` and `sdd/`; or Write/Edit whose `file_path` contains `/sdd/` and ends with
  `/progress.md`. For Write/Edit, `content` / `new_string` never qualify the input — only `file_path` does.
- **Plan signals:** ledger header `SDD ledger — plan: <p>` in a ledger input; `task-brief|task-start|task-done <p> <N>` or `review-package <p>` in a Bash
  command (the script word may end in a closing quote: `"$SDD/scripts/task-brief" …`); Skill whose `skill` ends with `subagent-driven-development` or
  `executing-plans`, plan = first whitespace token of `args` ending in `.md`. Every `<p>` passes through `stripPlanToken` and must then end in `.md`.
- **`base` of a plan signal:** if the Bash `command` starts with `cd <dir> &&` or `cd <dir>;`, that dir (resolved against `recordCwd` when relative);
  else `recordCwd`. Non-Bash signals use `recordCwd`.
- **Done:** every `Task <N>: complete` in a ledger input; `task-done <p> <N>`. **Running:** Agent `description` containing word-bounded `Task <N>`;
  `task-brief <p> <N>`; `task-start <p> <N>`. `Task <N>: dispatched` is not a signal.
- **`stripPlanToken`:** repeat until unchanged — remove one leading or trailing `"`, `'` or backtick; remove a trailing literal backslash-n.
- **`compareTaskIds`:** integer part ascending; bare id before its suffixed ids; suffixes alphabetical.
- **Headings:** lines matching `^#{2,3} Task (\d+[a-z]?)(?: \([^)]*\))?\s*[:.—–-]\s*(.+?)\s*$`; skip lines inside ` ``` ` fenced blocks; strip `\r`;
  plan order; a duplicate id keeps its first heading.
- **Plan cache:** keyed by absolute path; re-parse only when `mtimeMs` or `size` changed; at most 64 entries (evict oldest); never throws.
- **Compose:** rows = headings in plan order, then ids in `done ∪ {live}` that have no heading, sorted by `compareTaskIds`, subject `Task <id>`. Status:
  in `done` → `completed`; else equal to `live` → `in_progress`; else `pending`. `activeForm: null` on every row.

- [ ] **Step 1: Write the failing tests** — `test/plan-progress.test.ts`, same module shape as `test/tasks.test.ts` (`test(name, fn)` helper, exported
  `run(): number`). Plan files go in `fs.mkdtempSync(path.join(os.tmpdir(), …))`. Call `resetPlanCache()` per case. Exact cases (`U` = unit; spec §5
  numbers in brackets):
  - U1 [1] Bash `printf '# SDD ledger — plan: docs/p.md\n' >> .superpowers/sdd/p/progress.md`, recordCwd `/r` → `[{plan, 'docs/p.md', '/r'}]`.
  - U2 [2] Write `file_path` `/r/.superpowers/sdd/p/progress.md`, `content` `# SDD ledger — plan: docs/p.md\n` → plan `docs/p.md`; Edit with the same
    `file_path` and that line in `new_string` → same.
  - U3 [3] Bash writing `# SDD ledger — plan: <plan file path>` to a `sdd/x/progress.md` → `[]`.
  - U4 [4] Bash `echo 'Task 2: complete (abc..def)' >> .superpowers/sdd/p/progress.md` → `[{done,'2'}]`. Bash `echo 'Task 2: complete'` with no
    `progress.md` → `[]`.
  - U4b [4b] `W=.superpowers/sdd/p; printf 'Task 2: complete (x)\n' >> "$W/progress.md"` → `[{done,'2'}]`.
  - U4c [4c] Write `file_path` `/r/docs/superpowers/specs/s.md`, `content` holding `/r/.superpowers/sdd/x/progress.md` and `Task 1: complete` → `[]`.
  - U5 [5] `bash scripts/task-brief docs/p.md 3` → `[{plan,'docs/p.md'}, {live,'3'}]`; `"$SDD/scripts/task-brief" "docs/p.md" 3` → same.
  - U6 [6] Agent `description` `Implement Task 4: wire it` → `[{live,'4'}]`; `Review Task 4 (spec + quality)` → `[{live,'4'}]`; `Final review` → `[]`;
    `Task 40 prep` → `[{live,'40'}]`, never `'4'`.
  - U7 [7] Skill `superpowers:subagent-driven-development`, args `docs/p.md` → plan; args `Execute docs/p.md task by task` → plan `docs/p.md`; args `''`
    → `[]`; Skill `superpowers:brainstorming` with args `docs/p.md` → `[]`.
  - U17 [17] Edit `file_path` `/r/.superpowers/sdd/p/progress.md`, `old_string` `Task 3: dispatched`, `new_string` `Task 3: complete (x)` →
    `[{done,'3'}]` only.
  - U18 [18] `stripPlanToken`: `docs/p.md\n'` → `docs/p.md`; `docs/x.md"` → `docs/x.md`; `` `docs/y.md` `` → `docs/y.md`; `"docs/z.md\n"` →
    `docs/z.md`; `$PLAN` → `$PLAN` (and `planSignals` ignores it: no `.md`).
  - U19 [19] `task-start docs/p.md 2` → `[{plan}, {live,'2'}]`; `"$EP/scripts/task-done" docs/p.md 2 abc1234 -- pnpm test` → `[{plan}, {done,'2'}]`.
  - U15 [15] `cd /wt/x && bash scripts/task-brief docs/p.md 3` with recordCwd `/elsewhere` → plan `base` `/wt/x`; `cd ../wt; task-brief docs/p.md 3`
    with recordCwd `/r/sub` → base `/r/wt`.
  - U-order: one Bash command `W=.superpowers/sdd/p; bash scripts/task-brief docs/p.md 5; echo 'Task 5: complete' >> $W/progress.md` → exactly
    `[{plan,'docs/p.md'}, {live,'5'}, {done,'5'}]` in that order.
  - U10 [10] `compareTaskIds` sorting `['10','5b','2','5a','5']` → `['2','5','5a','5b','10']`. `composePlanTasks([], done {'10','5b','2'}, live '5a')`
    → ids `2,5a,5b,10`, subjects `Task 2`…, statuses `completed,in_progress,completed,completed`.
  - U12 [12] `parsePlanHeadings` over: `## Task 1: One`, `### Task 5a: Five A`, `### Task 7 (conditional): Seven`, `### Task 8 — Eight`,
    `## Task 1 findings`, `### Task 1: Dup` → `[{1,One},{5a,Five A},{7,Seven},{8,Eight}]`.
  - U12b (Review Focus 1) a ` ``` ` fenced block containing `### Task 9: Example` between real headings 1 and 2 → ids `[1,2]`.
  - U12c (Review Focus 2) CRLF text `### Task 1: One\r\n### Task 2: Two\r\n` → titles `One`, `Two` with no `\r`.
  - U13 (Review Focus 3) `readPlanHeadings` on a missing path, on a directory, and on a file chmod 0 (skip as pass when root) → `null`, no throw.
    `resolvePlanFile('docs/p.md', '/missing', projectPath)` where only `projectPath/docs/p.md` exists → that path; neither exists → `null`.
  - U11 [11 part] `readPlanHeadings` twice → same result; append a heading and bump mtime (`fs.utimesSync` +2 s) → the new heading appears.
  - U14 compose: headings `1,2,3`, done `{1}`, live `'1'` → statuses `completed,pending,pending` (done wins over live).
- [ ] **Step 2: Run** `pnpm test` → the new module fails (import cannot resolve).
- [ ] **Step 3: Implement** `server/lib/plan-progress.ts` per the behaviour list. Header comment: why tool inputs only (D3), why `file_path` alone
  qualifies Write/Edit, and a pointer to the spec.
- [ ] **Step 4: Run** `pnpm test` → all pass. Mutation-prove and restore each, noting the red cases in the report: (a) let Write `content` qualify a ledger
  input → U4c red; (b) require a literal `sdd/…/progress.md` path → U4b red; (c) drop the `.md` check → U3 red; (d) read Edit `old_string` → U17 red.
- [ ] **Step 5:** `pnpm typecheck` → clean.
- [ ] **Step 6: Commit** — `feat(tasks): plan signals and plan heading parser`.

### Task 2: Plan state in the fold, `Session.taskPlan`, scan wiring

**Files:**
- Modify: `shared/types.ts` — `Session.taskPlan: string | null` beside `tasks` (around line 135), JSDoc one line.
- Modify: `server/lib/tasks.ts` — entry state, prefilter, signature, compose (behaviour below).
- Modify: `server/lib/scan.ts:657` — pass `projectPath` (computed at :571), set `tasks` and `taskPlan`.
- Modify: `test/tasks.test.ts` — existing calls take the new return shape; new cases below. Extend the `call()` helper with an optional record-level `cwd`.
- Modify: `test/scan.test.ts:194` case — also assert `taskPlan: null` for both sessions; add one plan-wiring case.
- Modify: every `Session` literal the typecheck flags (today: `test/visual/fixtures/sessions.ts`, `test/filter-sort.test.ts`, `test/triage.test.ts`,
  `test/web-notify.test.ts`) — add `taskPlan: null`.

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `readSessionTasks(filePath: string, projectPath: string | null): { tasks: SessionTask[] | null; plan: string | null }`;
  `Session.taskPlan: string | null`. `resetTaskCache()` also calls `resetPlanCache()`.

**Behaviour (spec §2.2, §2.4, §2.5):**
- Prefilter adds markers `progress.md`, `task-brief`, `task-start`, `task-done`, `review-package`, `"name":"Agent"`, `subagent-driven-development`,
  `executing-plans` to the existing ones. Every `tool_use` block of a parsed line goes through `planSignals(block.name, block.input, rec.cwd ?? null)`;
  the TaskCreate/TaskUpdate path is unchanged.
- Entry gains `plan: { path; base; done: Set<string>; live: string | null } | null` and held `done`/`live` for signals seen before any plan.
- Two plan signals name the same plan when their lexical keys match: `path` if absolute, else `path.resolve(base, path)` when `base` is set, else
  `path` as written. Same plan → nothing changes. Different plan → replace, `done` and `live` reset (held signals were already consumed by the first plan).
  First plan → takes the held done/live.
- A running signal for an id already in `done` is ignored. A done signal clears `live` when it names it.
- At return time with `entry.plan` set: `resolvePlanFile(plan.path, plan.base, projectPath)`; headings = `readPlanHeadings(...) ?? []`; rows =
  `composePlanTasks(headings, done, live)`. Non-empty rows → `{ tasks: rows, plan: basename of plan.path without .md }`. Empty rows, or no plan →
  `{ tasks: <TaskCreate list as before>, plan: null }`.
- Plan file reads happen on every call (cheap: `stat` + cache), so an amended plan shows on the next poll even when the transcript did not grow.

- [ ] **Step 1: Write the failing tests** in `test/tasks.test.ts`. Plan files are written into the same temp root; records carry `cwd` = that root
  unless the case says otherwise. Exact cases (spec §5 numbers):
  - P1 [1] Bash header via printf to `.superpowers/sdd/p/progress.md` naming `docs/p.md` (3 headings `A`,`B`,`C`) → subjects `[A,B,C]`, all `pending`,
    `plan` `p`.
  - P4 [4] then a ledger `Task 2: complete` → row 2 `completed`; the same text as assistant text, as a plain user message, and as a tool_result content
    (each alone, in a fresh file with the header) → no row completed.
  - P5 [5] `task-brief docs/p.md 3` alone → plan resolved, row 3 `in_progress`; append a ledger `Task 3: complete` → row 3 `completed`, none live.
  - P6 [6] Agent `Implement Task 2: x` after the header → row 2 live; then `Review Task 2 (spec + quality)` → still 2 live.
  - P8 [8] ledger `Task 1: complete` written before any plan signal, then `task-brief docs/p.md 2` → row 1 `completed`, row 2 live.
  - P9 [9] plan `docs/a.md` with 1 and 2 done, then header for `docs/b.md` → `plan` `b`, B's headings, none done.
  - P9b (Review Focus 4) A → B → A, with `Task 1: complete` only before the first switch → `plan` `a`, none done.
  - P10 [10] header names `docs/gone.md` (no file), ledger completes `10`, `2`; Agent `Task 5a` → rows `2,5a,10`, subjects `Task 2`…, `plan` `gone`.
  - P11 [11] after a first call, append a heading to the plan file and bump mtime → next call shows the new row and `taskCacheStats().bytesRead` is
    unchanged.
  - P13 [13] plan file with zero headings and no ids seen, plus a confirmed `TaskCreate` `X` → `{ tasks: [X], plan: null }`; without the create →
    `{ tasks: null, plan: null }`.
  - P14 [14] confirmed `TaskCreate` `X` and a plan with headings → plan rows, `plan` set.
  - P15 [15] relative plan, record `cwd` = a dir without the file, `projectPath` = the temp root that has it → resolves (headings shown).
  - P16 [16] a ledger `Task 1: complete` line straddling `CHUNK_BYTES` — reuse the case-12 byte-exact straddle construction → row 1 `completed`.
  - P19 [19] `task-start docs/p.md 2`, then `task-done docs/p.md 2 abc1234 -- pnpm test` whose tool_result content is `Task 2: complete` → row 2
    `completed`; a file with only that tool_result (no command) after the header → row 2 `pending`.
  - P20 [20] after `Task 4: complete` and Agent `Implement Task 5: x`, an Agent `Review Task 4` → 5 stays `in_progress`.
  - Existing cases 1–14 and the named ones keep passing with `.tasks` on the new return value, and every existing case asserts `plan === null`.
- [ ] **Step 2: Run** `pnpm test` → new cases fail.
- [ ] **Step 3: Implement** types, fold changes, scan wiring and fixture `taskPlan: null` additions. In `test/scan.test.ts` add: a transcript with a
  plan header and one completed task, its plan file under the session's launch cwd → `taskPlan` is the basename, `tasks` has the plan's rows.
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm test` → clean / all pass. Mutation-prove: drop the plan-change reset → P9 red; skip the held-signal
  hand-over → P8 red. Restore.
- [ ] **Step 5: Live probe (acceptance, spec §5)** — from the scratchpad directory, a one-off `tsx` script that, for every transcript first written since
  2026-09-15 invoking `subagent-driven-development` or `executing-plans` (51 on 2026-10-07), calls `readSessionTasks(file, launchCwd)` and an
  independent full-parse reference written in the script (same §2.1 rules, applied to all lines with `JSON.parse`, no prefilter, no chunking). Report: runs
  resolving a plan; runs with a done signal; runs where the fold's done count ≠ the reference's; mismatches listed by file. Any mismatch is fixed before
  the commit, not explained away. Figures go in the task report with the date.
- [ ] **Step 6: Measure (Review Focus 5)** — same script: first-call and second-call time of `readSessionTasks` on the largest transcript on the machine
  and on the largest of the 51 runs. Gate: first call < 1.5 s. Record both in the report with the date.
- [ ] **Step 7: Commit** — `feat(tasks): progress from the plan a session executes`.

### Task 3: Card head reads the plan

**Files:**
- Modify: `client/src/lib/tasks.ts` — add `planName(taskPlan: string): string`.
- Modify: `client/src/components/TasksCard.tsx` — new prop `plan: string | null`; head label and phone label.
- Modify: `client/src/components/ChatDrawer.tsx:231` — pass `plan={session.taskPlan}`.
- Modify: `client/src/styles.css` — the head label ellipsis rule, in the existing tasks card block.
- Test: `test/client-tasks.test.ts`.

> **Ruling (plan vs spec §3):** the spec says `client/src/lib/tasks.ts` is unchanged. This plan adds the one pure helper `planName` there so the date-strip
> rule gets a test (the repo has no component renderer). Behaviour is exactly spec §3.

**Interfaces:**
- Consumes: `Session.taskPlan: string | null` (Task 2).
- Produces: `planName(taskPlan: string): string`; `TasksCard({ tasks, plan }: { tasks: SessionTask[] | null; plan: string | null })`.

**Behaviour (spec §3):**
- `planName` removes one leading `YYYY-MM-DD-`; otherwise returns the input.
- Desktop head `.k`: `Plan · <planName>` when `plan` is non-null, else `Tasks`; the label carries `title={plan}` when non-null. The label ellipsises on one
  line; the count stays right-aligned and never shrinks.
- Phone fold `.tf-k`: `Plan` when `plan` is non-null, else `Tasks`.
- Pill and everything else unchanged.

- [ ] **Step 1: Failing tests** in `test/client-tasks.test.ts`: `planName('2026-10-07-task-progress')` → `task-progress`; `planName('phase0-spike')` →
  `phase0-spike`; `planName('2026-10-07')` → `2026-10-07` (no trailing dash to strip, unchanged).
- [ ] **Step 2: Run** `pnpm test` → fail.
- [ ] **Step 3: Implement** helper, prop, labels, CSS (tokens only; no new class names beyond what already exists, the label can be a `span` styled
  under `.tasks-kv .k`).
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm test` → pass.
- [ ] **Step 5: Live check** in the preview pane against fixture transcripts (fake HOME, worktree ports 4273/5273, servers killed by recorded pid): a
  session whose transcript carries a ledger header for a 13-heading plan with 7 completes and an Agent `Task 8` dispatch → pill `7/13`, card head
  `Plan · <name>`, row 8 pulsing; a long plan name ellipsises at 1440 px without widening the 290 px column; at 375 px the fold reads `Plan 7/13 · …`.
- [ ] **Step 6: Commit** — `feat(chat): card head names the plan`.

### Task 4: Docs

**Files:**
- Modify: `docs/subsystems/sessions.md` (§What a session shows — the task-list paragraph near line 108), `docs/subsystems/chat.md` (§What's shown, the
  Tasks card), `docs/overview.md` (§Map: `server/lib/tasks.ts` line, new `server/lib/plan-progress.ts` line).

**Behaviour:** Source is plan-first. Say why with the date: task tools are default-on only for Claude 3.x / Opus 4–4.7 / Sonnet 4–4.6 / Haiku 4.5 since
v2.1.268 (https://code.claude.com/docs/en/tools.md#task-tool-availability); no task-tool call on this machine since 2026-08-20. A short signals table
(ledger header / scripts / Skill args → plan; ledger line or `task-done` → done; Agent `Task N` / `task-brief` / `task-start` → running), `taskPlan`,
the card head label, and the measured probe figures from Task 2 with their date.

- [ ] **Step 1:** Write the doc changes; new prose wraps at 160; do not reflow untouched lines; leave docs-sync stamps for `/docs-sync`.
- [ ] **Step 2:** `pnpm test` → pass (doc tests included).
- [ ] **Step 3: Commit** — `docs: plan-first task progress in sessions and chat subsystems`.
