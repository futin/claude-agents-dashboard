# Review 1 — routine drawer form implementation plan

Plan: `docs/superpowers/plans/2026-10-24-routine-form.md` (313 lines). Spec: `docs/superpowers/specs/2026-10-24-routine-form-design.md`. Reviewed
2026-10-24 against the tree at `docs/routine-form-spec` (HEAD 4e13b7b). Every code claim below was read in the repo, not taken from the plan.

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Four Important ones: one false path that breaks the first build of Task 4, one vacuous test that leaves the
spec's `desired` change unpinned, one spec verification item with no task, and one false statement about a test file. The rest is Minor.

## Checklist

1. **Coverage.** Every spec section maps to a task (field registry/unreadable/validation → T4+T6; rows → T4/T6; presets → T5/T6; plain words → T3; Manual
   parser/reconcile/API/ledger/menu/docs → T1/T2; drawer Save → T6; constraints → T6; verification → T4/T5/T7). One spec test case has no task: "the
   wrapper computes no slot" (spec:218) — see I-3.
2. **Values.** Every copy string checked matches the spec: `Manual · Run now only`, `Every hour at :25` / `Every 2h at :25`, `Daily at 09:25`,
   `Weekdays at 09:25`, `Mon, Thu at 09:25`, `No prompt yet`, `Any tool`, `1h timeout (default)`, `All pinned (6)`, `edit in File`,
   `machines needs mac, wsl or both` (routine-file.ts:135), `claude job needs a prompt` at line 0 (routine-file.ts:217), the five-fields message
   (cron.ts:76). The `jobTemplate('skill')` facts the Task 4 tests rely on hold: `cron: "0 22 * * *"` is line 2, `model: opus` is line 8, `# cwd:` is a
   comment (routines.ts:260-273).
3. **Reality.** All Modify paths and line ranges exist and point at the named code (routine-file.ts:119-125/148-152, types.ts:2043, cron.ts:161-182,
   routine-reconcile.ts:203-210, api.ts:1953-1959/1990-1996, routines.ts:124-127, JobLedger.tsx:62/86-90/97, JobMenu.tsx:26-28, JobDrawer.tsx:184-221/
   230-249, routines.md:72/118/293-294, overview.md:309). Create paths (`client/src/lib/routineForm.ts`, `test/routine-form.test.ts`, `JobRows.tsx`) do
   not exist. `writeFrontmatterLine(text, key, value, afterKey?)` and `scalarEnd` are exported (frontmatter.ts:71,89); `readForeach`/`setRepos`/
   `ForeachMode`/`jobTemplate` exported (routines.ts:202-276); `JobError` exported (routine-file.ts:12); `parseCron`/`nextAfter`/`describeCron` exported
   (cron.ts:74,104,169); `ctl.machine/pins/phone/owner/locked` exist (ctl.ts:9-19); `save(true)` exists (JobDrawer.tsx:102); `dev-verify` 4700/5700
   exists (.claude/launch.json); `pnpm plugin:gen` exists (package.json:18); the visual fixture `pr-triage` carries `*/30 9-18 * * 1-5`
   (test/visual/fixtures/routines.ts:131). Two stated facts are false: the client import path (I-1) and "the file has no builder helper" (I-4).
4. **Interfaces.** Every Consumes is Produced earlier with the same spelling: `isManualCron` (T1 → T2, T5), `FieldDef`/`fmValue`/`setKey`/`UNREADABLE`
   (T4 → T5), the full T4/T5 surface (→ T6). `pausedLook` is produced and consumed inside T2.
5. **Order.** T1 → T2; T3 independent but before T5 (T5's Custom summary asserts T3's wording); T4 → T5 → T6 → T7. No forward dependency.
6. **Tests.** Recomputed every `describeCron` pair in Task 3 from the plan's own rules; all 14 phrased pairs and the 5 fallbacks agree (`*/15 9-17` →
   LL = 45; `*/30 9-18` → LL = 30; `*/7` → 0..56, 56+7 > 59 so a full step; `*/15 */2` → hours 0,2,…,22 are neither a single hour nor contiguous, so
   unphraseable; `0 1,3,5,7,9` → five hours > 4). The three cases the plan removes from "anything else is the expression itself" (cron.test.ts:221-225) are
   all re-pinned with words. Fixtures discriminate (machines `[mac, wsl]` / `[wsl]` / `[]` / `[mac, linux]`; two insertion keys; two removal shapes LF/CRLF).
   One test is vacuous (I-2); one Review Focus claim has no test (M-9).
7. **Conventions.** "Behaviour and exact test cases, not literal code" is followed; the one code-shaped line (`[T, D, Mo].filter(Boolean).join(', ')`,
   plan:124) is a rule, not a body. The size budget is marked soft (plan:21, plan:263).

## Important

- **I-1 — plan:24** "client imports from `shared/` as the existing files do (`../../../../shared/...`)". For `client/src/lib/routineForm.ts` (Task 4) the
  correct depth is three: `client/src/lib/routines.ts:8` imports `'../../../shared/frontmatter'`. Four hops is the depth of
  `client/src/components/routines/*.tsx` (JobLedger.tsx:4). Written as stated, Task 4's module fails `pnpm typecheck` and the test import. → Say "three hops
  from `client/src/lib/`, four from `client/src/components/routines/`", citing both files.
- **I-2 — plan:100-101** (Task 2 api test) "a manual, enabled job on this machine → its row has `installed: false`, `nextAt: null`". Both assertions pass
  before Task 2's `desired` change: the api harness never installs the plugin, so `reconcile.state` is `no-plugin` (test/api-routines.test.ts:167) and
  `installedFrom` returns false for every job regardless of `desired` (api.ts:1963-1965); and `nextAt` is already null because `nextFire` fails
  `parseCron('manual')` (api.ts:1973-1975). The plan's Step 3 change to `desired` in `serveRoutines` (api.ts:1992) — the spec's "or an enabled manual job
  reads `installed: true`" (spec:181-182) — is therefore pinned by no test. → Either export the predicate (`desiredHere(job, machine)` or similar) from
  `server/lib/routine-reconcile.ts`, use it in both `notDesired` and `serveRoutines`, and unit-test it (manual enabled on this machine → false; scheduled
  enabled → true; scheduled disabled → false), or assert `installedFrom(report('in-sync', [], 1), name, <desired computed by the exported predicate>)` is
  false for a manual job. State in the plan that `installed`/`nextAt` through GET are not the proof.
- **I-3 — spec:218 vs plan Task 2** The spec's verification list names "the wrapper computes no slot" for a manual job. No task adds that case:
  `test/run-routine.test.ts:172` ("manual has no slot") covers the manual *trigger*, not a `--trigger schedule` fire of a `cron: manual` file. The code
  path is `plugin/lib/run-routine.mjs:265-268` (`parsed.ok ? lastBefore(...) : null`), and the plan says "no change" (plan:12, spec:190), which is right,
  but the spec asks for the pin. → Add to Task 1 or Task 2 a `test/run-routine.test.ts` case mirroring :684-692: a `cron: manual` job, `--trigger
  schedule`, assert `!('slot' in start)` and `late` absent/false.
- **I-4 — plan:47-48** "(the file has no builder helper; write the texts inline…)" contradicts the line above it ("use its existing job-text builder") and
  is false: `test/routine-file.test.ts:33-39` has `claude(...extra)` and `shell(...extra)` builders, plus the `EXAMPLE` text (:13-30). Both builders
  hardcode `cron: "0 9 * * *"`, so a `cron: manual` case cannot be built by appending `extra` (it would be `cron given twice`, routine-file.ts:90). → Say:
  "use `shell(...)`/`claude(...)` with `.replace('cron: "0 9 * * *"', 'cron: manual')` (and `.replace(…, '')` for the no-cron case), or inline text".

## Minor

- **M-1 — plan:42** The commit trailer hardcodes `Claude Opus 5.5`. The attribution line is per implementing session (this one is told `Claude Fable 5.1`).
  → "the model attribution line the session is given", not a literal.
- **M-2 — plan:93** `client/src/lib/routines.ts:523-526 (dotTone callers)` is `dotTone`'s definition. Callers are `JobLedger.tsx:62` (the one to change)
  and `RunsList.tsx:78` (passes `true`; unaffected). → Cite JobLedger.tsx:62 and note RunsList needs no change.
- **M-3 — plan:69** "with the four source files" — Task 1 touches five (`cron.ts`, `routine-file.ts`, `types.ts`, two test files).
- **M-4 — plan:128-129** Minute `*/N` rule: "plus `, HH:00–HH:LL` over a single hour or contiguous hour range" does not exclude the full 0–23 range, yet
  `*/15 * * * *` → `Every 15 minutes` (plan:138) needs it excluded. The one-minute rule (plan:126) does say "not all 24". → Add "not all 24" here too, and
  under "Every minute".
- **M-5 — plan:127-128** The "Every minute, HH:00–HH:59" and single-hour variants have no test pair. → Add `* 9-17 * * *` and `* 9 * * *` to Step 1.
- **M-6 — plan:102, 108** `rowText` for a manual job that does not name this machine is not specified; today that branch returns `nextLine: '—'`
  (routines.ts:139) before the paused/next logic. The spec says "reads 'manual' in the next column whatever `enabled:` says" (spec:185). → State which wins
  and add the case.
- **M-7 — spec:70 vs plan Task 4** The spec names `jobPins` as part of the Repos field's read; the plan consumes only `readForeach`/`setRepos`. Harmless
  (`pinCount` arrives through `SummaryCtx`), but say so.
- **M-8 — plan:276** Phone labels `All | Pick | Folder` are the plan's choice; the spec relabels only the wide form (spec:118). Fine; mark it as a plan call.
- **M-9 — plan:60** Review Focus 5 says "the write is never called" for an UNREADABLE field; Task 6 has no test for it (JobRows is untested by design).
  → Either drop that clause or add a note that Task 7 checks it by hand.
- **M-10 — plan:52-53** Task 1's launchd note: the check at routine-file.ts:148-151 already skips a manual cron (its inner `parseCron` fails), so the
  "runs only for a cron that is not manual" guard is belt-and-braces. Keep it, but the test at plan:51 passes either way.
- **M-11 — plan:150** `routeErrors` tests have no machines-line case although the spec's Machines row relies on it (spec:114-115). Line-ownership covers
  it; one assertion would make it explicit.
