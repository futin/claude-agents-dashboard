# Plan review 1 — Routines per machine

Date: 2026-11-09. Reviewer: fresh subagent (Fable 5.1), plan ↔ spec ↔ code.
Plan: `docs/superpowers/plans/2026-11-09-routines-per-machine.md`. Spec: `docs/superpowers/specs/2026-11-09-routines-per-machine-design.md`.

## Verdict: APPROVE WITH FIXES

No Critical finding. Every file path, line number and exported name the plan cites was checked against the tree and holds (table at the end). The
fixes below are about one step whose stated outcome is false (Task 1's typecheck), two tests an implementer cannot write from the text as given, one
spec requirement the plan drops, one spec test case with no import-level coverage, and two doc lines the plan's own grep would not catch.

## Important

**I1 — plan:52-53, :86 — Task 1's `pnpm typecheck → clean` cannot be true while `test/visual/fixtures/routines.ts` is left for Task 5 (plan:209).**
`tsconfig.json:16` includes `test`, and the fixture is typed: `test/visual/fixtures/routines.ts:18-20` builds `RoutineJob` literals with `machines: ['mac']`,
`:144` another with `machines: ['wsl']`, and `:150-158`/`:178` build `RoutineJobRow` literals with `onThisMachine` and `j.machines.includes('mac')`. Once
Task 1 removes `RoutineJob.machines` (`shared/types.ts:2242`) and `RoutineJobRow.onThisMachine` (`:2350-2351`), `tsc --noEmit` fails on that file.
→ Move `test/visual/fixtures/routines.ts` into Task 1's Files (compile fixes: drop `machines`, `onThisMachine`, and derive `installed` from `j.enabled` alone)
and drop it from Task 5.

**I2 — plan:107-108 — the `routines-view` subtitle test has nothing to call.** `test/routines-view.test.ts:5-15` imports only `client/src/lib/*` helpers and
`shared/*`; no test under `test/` renders React (`grep react-dom|jsdom|renderToString|RoutinesView test/` hits only the registry line in `run-all.ts:182` and
a comment in `web-notify-client.test.ts:18`). The copy lives in JSX at `client/src/components/routines/RoutinesView.tsx:126-127`, so an implementer must
guess whether to extract a helper or grep the TSX source. → State one: add to Task 2's Produces an exported `jobsSubtitle(machine: 'mac' | 'wsl'): string`
(or similar) in `client/src/lib/routines.ts` that returns the sentence after the `<code>{data.dir}</code>` fragment, have `RoutinesView.tsx` render it, and
test that helper for both machines.

**I3 — plan:168-169, :172 — `rewriteImported` is asserted as full expected text, but the plan never says where `cwd:` is inserted, nor the order of the
two insertions when both `enabled:` and `cwd:` are absent.** `serializeEnabled` inserts `enabled:` after `run:` (`shared/routine-file.ts:252-255`, via
`writeFrontmatterLine`'s `afterKey`, `shared/frontmatter.ts:89,125-127`); `writeFrontmatterLine` with no `afterKey` inserts just before the closing fence.
Two implementers would produce two different "byte-identical" expectations. → Name the anchor for `cwd:` (e.g. after `run:`, matching the drawer's
`KEY_ORDER` at `client/src/lib/routineForm.ts:53`, or after `enabled:`) and the edit order (strip `machines:` → `enabled` → `cwd`), so the expected text in
the test is derivable from the plan.

**I4 — plan:196 "(nothing on `skipped`)" contradicts spec:126 "The import is skipped (and logged) if the old folder and the new jobs folder resolve to the
same path or one contains the other".** → Log one line on `why: 'overlap'` naming both folders; the other `skipped` reasons may stay silent.

**I5 — plan:177-178 — spec:113 lists "copies an unparseable file" among the import tests, but the only `importSharedJobs` fixture holds two parseable files
(`a.md`, `b.md`).** The `rewriteImported` case at plan:174 proves the text edits, not that the import copies such a file; an implementation that filters
through `readJobs(...).filter(s => s.job)` would pass every listed `importSharedJobs` case. → Add a `c.md` with `run: bogus` (and a `machines:` line) to
the `imports every .md disabled` fixture: `count: 3`, `jobs/c.md` exists, has no `machines:` line, has `enabled: false`, and parses with exactly the
`run must be shell or claude` error.

**I6 — plan:205-208 — two doc lines that become false are neither cited nor caught by the Step 2 grep (plan:215).** `docs/subsystems/routines.md:76`
("`cwd` … default is the routines folder's parent") is the doc line spec:75-76 names for the home-folder change, and `docs/overview.md:474` describes
"job files in a git-synced folder". Neither contains `machines:`, `onThisMachine`, `not-this-machine` or `claude-global/routines`. → Cite both in Task 5's
Files and add `folder's parent\|git-synced\|sync through git` to the Step 2 grep.

## Minor

- plan:192-193 — the stated order "overlap check → jobs-exist check → resolve old folder" is self-contradictory: the overlap check needs the old folder.
  Say whether overlap compares against the first *existing* old folder (then `no-old` wins when neither exists) or against both constants regardless.
- plan:188 — "inject a failing write on the 2nd file (host seam or a read-only file trick)": `RoutineHost` (`server/lib/routine-config.ts:40`) has
  `platform, readProcVersion, env, homedir, username, exists` and no write member, and a chmod trick is root- and CI-sensitive. The cleaner seam is an
  optional `copyFile`/`writeFile` on the import's own host param; naming it would save the implementer a guess.
- plan:77-78 — spec:62 "Run-log readers must still accept old `refused` records whose `why` is `not this machine`" is handled by "verify no enum narrows
  it" (true: `shared/types.ts:2271,2308` type `why` as `string | null`), but no test pins it. One fold of a record with `why: 'not this machine'` through
  `routine-log`'s reader or `rowText`/`runPill` would close it.
- plan:135 — "Update the existing cases at :126-134": `test/routine-config.test.ts:121` (`d.routines` equals `~/claude-global/routines` under the
  `/tmp/seam` state root) also changes, to `/tmp/seam/jobs`; the value is already given at plan:133, only the line reference is short.
- plan:79 — "the ledger's machine chips (`.rtn-mach`)": `RoutinesView.tsx:122` also renders a `git-chip rtn-mach rtn-here` header chip with `data.machine`,
  and `JobLedger.tsx:103` uses `rtn-mach` for the fan-out chip. Both should stay (the header chip *is* the "belongs to this machine" cue); say "the
  per-job `job.machines` chips and the `only` pill" to avoid an over-removal, and `styles.css:3339` keeps its rule.
- plan:124 — `test/routine-boot.test.ts:124` names "the eight calls in order"; with `importSharedJobs` it becomes nine. Worth a word so the test title is
  updated with the assertion.
- plan:139 — "summary ends `· your home folder`": true only for an enabled, non-manual job with neither key (`server/api.ts:1774` appends `paused`
  otherwise). The existing fixture at `test/api-routines.test.ts:332` is a manual shell job, which also ends in the `where` segment; either works, just
  pick one that is not `enabled: false`.

## Checklist results

1. **Coverage.** Every spec section maps to a task: Where the files live → T3; `machines:` key → T1/T2; Default cwd → T3 (+T5 docs, see I6); Import → T4;
   Rollout order → T5; Docs and tests → T1-T5; Settled 1-8 → T3/T4 (3: see I4; 4: the orphan case survives at `test/routine-reconcile.test.ts:345` as
   the deleted-file half, plan:82-83). Spec test list (spec:110-115): all present except the import-level "copies an unparseable file" (I5).
2. **Values.** The `machines:` parse message, launchd message, subtitle, `.env.example` lines, `Empty = your home folder.`, marker shape and boot order
   all agree with the spec; the spec leaves the exact copy to the builder, and the plan fixes it, which is the right place.
3. **Reality.** All cited paths and lines verified (table below). `server/lib/routine-import.ts` and `test/routine-import.test.ts` do not exist (Create ✓).
4. **Interfaces.** `parseJob`/`readJobs` new signatures (T1) consumed by T2-T4 with the same spelling; `routineDirs` shape (T3) matches the current return
   type at `routine-config.ts:103`; `OLD_SHARED_DIRS` is produced in T3 and consumed in T4; `serializeEnabled` (`routine-file.ts:253`) and
   `writeFrontmatterLine` (`frontmatter.ts:89`) exist with the signatures the plan assumes.
5. **Order.** No forward dependency between tasks. `pnpm plugin:gen` is placed inside T1 before the test run (plan:73-74) ✓.
6. **Tests.** Review Focus 1-5 each have a test (T1 Step 1; T4 `jobs-exist`; T4 `ignores non-.md…`; T4 `foreach`/`cwd` rewrite cases; T3 routine-config +
   T4 `explicit-dir`). Fixtures discriminate: launchd rule on both machines, import with two files of differing `enabled`/`machines`, six distinct
   `routineDirs` inputs. Gaps are I2, I3, I5 and the Minor run-log item.
7. **Conventions.** No literal code anywhere; signatures and expected values only ✓. 160-column wrap respected.

## Citation table (plan line → checked location)

| plan | claim | checked | ok |
|---|---|---|---|
| 43 | KNOWN/LIST_KEYS, machines block ~137-148, launchd ~158-162 | `shared/routine-file.ts:25,28,137-148,159-161,229-231` | ✓ |
| 44 | types 2242 / 2331 / 2350-2351 | `shared/types.ts:2242,2331,2350-2351` | ✓ |
| 46 | `routine-store.ts:37,53`; `readJobs` callers | `routine-store.ts:37,53`; `api.ts:1799,1840,1858,1870,1892,1927`; `routine-reconcile.ts:264`; `routine-boot.ts:72`; `routine-run.ts:103` | ✓ |
| 47 | `parseJob` callers 1761/1938, summary 1774, row 1808-1809 | `server/api.ts:1761,1938,1774,1808-1809` | ✓ |
| 48 | reconcile 217, run 107-108 | `routine-reconcile.ts:217`; `routine-run.ts:107-108` | ✓ |
| 49 | wrapper 152-154 | `plugin/lib/run-routine.mjs:152-154` | ✓ |
| 50-51 | client compile sites | `JobMenu.tsx:12`, `JobFold.tsx:72`, `RunsList.tsx:118`, `JobLedger.tsx:63,104-109`, `routines.ts:104-122,322` | ✓ |
| 52-53 | test anchors | `plugin-manifest.test.ts:80-84`; `run-routine.test.ts:70,74,420-425,754`; `routine-run.test.ts:315`; `routines-view.test.ts:340`; `routine-reconcile.test.ts:345` | ✓ |
| 92-95 | routineForm 17,53,190,205-217,535-547; JobRows 45,259; routines.ts 244,273-274; RoutinesView 126-127 | all present | ✓ |
| 118-122 | config 135-136,173,363; routine-config 42-50,103-115; wrapper 126-128,208; api 1773; JobRows 94; routines.ts 224,247; `.env.example:150-155` | all present | ✓ |
| 154 | boot 19-40, 124-135 | `routine-boot.ts:19-40,124-135` (`step` at 132) | ✓ |
| 205-207 | routines.md 3-4,16-34,39-47,60,73,83,91-96,118-120,182,218,280,302, stamp | all present; stamp at `:337` | ✓ (but see I6) |
| 207 | overview.md 62, routine-* map lines | `docs/overview.md:62,255-261` | ✓ (but see I6) |
