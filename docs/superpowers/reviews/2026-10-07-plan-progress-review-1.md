# Plan review 1 — `docs/superpowers/plans/2026-10-07-plan-progress.md`

Reviewed against `docs/superpowers/specs/2026-10-07-plan-progress-design.md` and the code at `main` (7ecb283), 2026-10-07. Reviewer: Fable 5.1, fresh
session, paths + checklist only. No document or source file was edited.

**Verdict: APPROVE WITH FIXES** — no Critical findings; two Important, both one-line additions to the plan.

## 1. Coverage — spec section / test case → plan task

| Spec | Plan |
| --- | --- |
| §1 contract (`taskPlan`, `SessionTask` unchanged, literals gain `taskPlan: null`) | Task 2 Files + Interfaces (plan:138, :143–144) |
| §2.1 signals, strip loop, `.md` check, `dispatched` not a signal | Task 1 Behaviour (plan:75–84) |
| §2.2 entry state, `cd` base, same/different plan, held signals, done-ignores-running, live cleared | Task 1 `base` (plan:80–81) + Task 2 Behaviour (plan:155–159) |
| §2.3 plan file read, heading rule, mtime cache, never throws | Task 1 (plan:86–88) + Task 2 (plan:160–163) |
| §2.4 compose, id order, fallback to TaskCreate, `taskPlan` basename, signature | Task 1 (plan:85, :89–90) + Task 2 (plan:148, :160–162) |
| §2.5 prefilter markers, 1.5 s gate | Task 2 (plan:152–153, :198–199) |
| §3 client head label, phone fold, pass-through | Task 3 (plan:218–223) |
| §4 states table | rows 1–3, 5, 6 pinned by P13/P1/P10/P11/P9; row 4 (inline run at 0/N) by P5 first half |
| §5 cases 1–20, 4b, 4c | 1 U1/P1 · 2 U2 · 3 U3 · 4 U4/P4 · 4b U4b · 4c U4c · 5 U5/P5 · 6 U6/P6 · 7 U7 · 8 P8 · 9 P9 · 10 U10/P10 · 11 U11/P11 · 12 U12 · 13 P13 · 14 P14 · 15 U15/P15 · 16 P16 · 17 U17 · 18 U18 · 19 U19/P19 · 20 P20 |
| §5 mutation proofs (content→4c, literal path→4b, .md→3, reset→9) | Task 1 Step 4 (a)(b)(c) + Task 2 Step 4 (plan:130–131, :191–192); plan adds (d) old_string→U17 and held→P8 |
| §5 live probe | Task 2 Step 5 (plan:193–197) |
| §6 docs | Task 4 |

No spec section or test case is without a task. The spec names no test for `review-package <p>` (§2.1) and neither does the plan — see Minor M3.

## 2. Values

Every expected value checked against the spec and by hand: U1 strip of `docs/p.md\n'` → `docs/p.md`; U10 order `2,5,5a,5b,10` and compose statuses
`completed,in_progress,completed,completed` for done `{10,5b,2}` / live `5a`; U14 done-over-live; U15 `cd ../wt` from `/r/sub` → `/r/wt`; Task 3
`planName('2026-10-07')` unchanged. Commit messages, markers (plan:152) and the task-tool availability sentence (plan:242–243) match spec §2.5 / header.

## 3. Reality (grep/read 2026-10-07)

| Plan claim | Code |
| --- | --- |
| Create `server/lib/plan-progress.ts`, `test/plan-progress.test.ts` | neither exists ✓ |
| `test/run-all.ts` import + `failed +=` pattern (plan:57) | `test/run-all.ts:17,148` ✓ |
| `shared/types.ts` `tasks` around line 135 (plan:138) | `shared/types.ts:135` ✓; `projectPath: string \| null` at :65 ✓ |
| `server/lib/scan.ts:657` call, `:571` projectPath (plan:140) | `scan.ts:657 tasks: readSessionTasks(c.file)`, `:571 const projectPath = parsed.originCwd \|\| parsed.cwd \|\| null` ✓ |
| `readSessionTasks(filePath)` today (plan:148 widens it) | `server/lib/tasks.ts:135` ✓; `resetTaskCache` :175, `taskCacheStats` :181, `CHUNK_BYTES` :20 ✓ |
| `test/tasks.test.ts` `call()` helper has no record `cwd` (plan:141) | `test/tasks.test.ts:28–30` ✓; case 12 is the byte-exact straddle (`:177–188`) ✓ |
| `test/scan.test.ts:194` tasks case (plan:142) | `:194` ✓ |
| Session literals in the four named files (plan:143) | `test/visual/fixtures/sessions.ts:40`, `test/filter-sort.test.ts:57`, `test/triage.test.ts:36`, `test/web-notify.test.ts:39`; no others under `client/`, `server/`, `shared/` ✓ |
| `TasksCard({ tasks })`, head `<span>Tasks</span>`, `.tf-k` (plan:206, :220–222) | `client/src/components/TasksCard.tsx:16,41–47` ✓ |
| `ChatDrawer.tsx:231` (plan:207) | `<TasksCard tasks={session.tasks} />` at :231 ✓ |
| `client/src/lib/tasks.ts` exports, `test/client-tasks.test.ts` imports it (plan:205, :209) | `:15,:30,:38`; `test/client-tasks.test.ts:3` ✓ |
| No `max-width` media query, `test/breakpoints.test.ts` (plan:28) | `test/breakpoints.test.ts:212` asserts it ✓ |
| Class names `tasks-kv`, `tf-k`, `k`, `ag-pill tasks` (plan:29) | `client/src/styles.css:739,1870,1872,1955` ✓ |
| Docs anchors (plan:239–240) | `sessions.md:100–130` task section, `chat.md:73` "What's shown", `overview.md:167` tasks.ts line ✓ |
| 1.5 s gate from task-progress plan Task 2 (spec §2.5) | `docs/superpowers/plans/2026-10-07-task-progress.md:137` ✓ |

## 4. Interfaces

Task 2 consumes `planSignals`, `readPlanHeadings`, `resolvePlanFile`, `composePlanTasks`, `resetPlanCache`, `PlanSignal` — all Produced by Task 1 with
the same spelling and types (plan:62–72 ↔ :153, :160–161, :149). Task 3 consumes `Session.taskPlan` (Task 2, plan:149). `planSignals(name, input,
recordCwd)` ↔ call `planSignals(block.name, block.input, rec.cwd ?? null)` ✓.

## 5. Order

1 → 2 → 3 → 4; no forward dependency. Spec prerequisite (task-progress, PR #185) is merged (`git log`: a603a60).

## 6. Tests

All U/P cases fail before implementation (module absent; `readSessionTasks` returns an array today, so `.tasks`/`.plan` reads fail). They pin behaviour
through the public functions, not internals. Review Focus 1–4 each have a case (U12b, U12c, U13, P9b); Review Focus 5 is a measurement gate (Step 6), not
a test — acceptable for a timing gate, noted as M7.

## 7. Plan's own conventions

"Behaviour, not literal code" held throughout — no code blocks. 160-column wrap held. Dates carried on every measured figure (plan:194, :197, :199).

---

## Findings

### Important

**I1 — plan:42–43, :86–87 — the fenced-block skip is a plan ruling against spec §2.3, not flagged as one.** Spec §2.3 (spec:91) defines a heading as
*any line* matching the regex; the plan's Review Focus 1 / U12b make a matching line inside a ` ``` ` fence *not* a heading. Plan:8 says "if the spec and
this plan disagree, the spec wins", so an implementer reading both must guess which rule to code. The plan already shows the right shape for this in
Task 3 (plan:211–212, "Ruling (plan vs spec §3)"). → Add a one-line **Ruling** under Task 1 Behaviour: fenced lines are skipped on purpose (plans quote
example headings), spec §2.3's rule is otherwise unchanged; or have the spec author amend §2.3.

**I2 — plan:189–190 — the scan.test plan-wiring case cannot be written as described without a real directory for the session cwd.** The case says the
plan file sits "under the session's launch cwd", but `test/scan.test.ts`'s fixture gives sessions a *fake* cwd (`metaRec('/a/tasks', 'main')`,
`test/scan.test.ts:46–47`, used at `:200`), and `scan.ts:571` takes `projectPath` from exactly that record. A plan file cannot be placed under `/a/tasks`.
→ Say the case passes a real temp directory (e.g. a subdir of `root`) as `metaRec`'s cwd and writes the plan file beneath it.

### Minor

**M1 — plan:62, :155 vs spec:71.** The spec names the entry field `cwd`; the plan names it `base` on both `PlanSignal` and the entry. Either is fine;
pick one and note it so the two documents stop disagreeing on a name.

**M2 — plan:88 vs spec:88.** Spec: cache "bounded like the transcript LRU" (access refreshes recency, `tasks.ts:137`). Plan: "at most 64 entries (evict
oldest)" — insertion-order eviction, not LRU. Harmless at 64 plans; say "LRU, as `tasks.ts`" if that is meant.

**M3 — plan:77–78.** `review-package <p>` is a plan signal in both documents but has no test in either (spec §5 has none). One U-case
(`"$SDD/scripts/review-package" docs/p.md` → `[{plan}]`) would pin it; otherwise the branch ships it untested.

**M4 — plan:176 (P10).** Neither the `projectPath` passed nor the three statuses (`2` completed, `5a` in_progress, `10` completed) are stated; the
implementer must infer them from spec §2.4. Spell them out so the case asserts status, not just ids.

**M5 — plan:193–194.** `readSessionTasks(file, launchCwd)`: the plan does not say where the probe script gets `launchCwd`. The dashboard's rule is
`parsed.originCwd || parsed.cwd` (`server/lib/scan.ts:571`, from `server/lib/transcript.ts:462`). Name it, or the probe may use the drifted newest cwd
and under-resolve plans.

**M6 — plan:44, :86, :122 (U12c).** `strip \r` is redundant: the spec regex ends `(.+?)\s*$` and `\s` already matches `\r`, so titles never carry it
once lines are split on `\n`. Keep the test (it still pins the behaviour), drop the extra rule or say it is belt-and-braces.

**M7 — plan:48, :198–199.** Review Focus 5 is pinned by a measurement, not a test. Fine for a timing gate; note that it is the one Review Focus item
without an automated case.

**M8 — plan:195 vs spec:160–161.** The spec's probe compares the fold's done count with "the ledger's distinct completed ids"; the plan compares with a
reference that applies the same §2.1 rules without prefilter/chunking. Equivalent for the ledger rows, but the plan's reference inherits any rule bug.
Worth one sentence that the reference is *also* checked against raw `Task N: complete` lines in ledger inputs.

## Checks run

```
ls server/lib/plan-progress.ts test/plan-progress.test.ts   # both absent
grep -n "^export" server/lib/tasks.ts
grep -n "tasks\|projectPath" shared/types.ts
grep -n "readSessionTasks\|projectPath" server/lib/scan.ts
sed -n 9,66p / 170,200p test/tasks.test.ts ; sed -n 185,215p test/scan.test.ts ; grep -n metaRec test/scan.test.ts
grep -rn "tasks: null" client/src server shared test
grep -n "max-width" test/breakpoints.test.ts            # :212 forbids it in @media
grep -n "tasks-kv\|\.tf-k\|ag-pill.tasks" client/src/styles.css
grep -n "TasksCard" client/src/components/ChatDrawer.tsx # :231
grep -n "originCwd" server/lib/*.ts
```
