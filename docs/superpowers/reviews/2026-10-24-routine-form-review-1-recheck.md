# Routine form plan — review 1 re-check (4e13b7b → 42850bd)

Scope: only the hunks of `git diff 4e13b7b 42850bd -- docs/superpowers/plans/2026-10-24-routine-form.md`, read against the spec
(`docs/superpowers/specs/2026-10-24-routine-form-design.md`) and the code the hunks cite. Line numbers are those of the plan at 42850bd.

## Verdict: APPROVE WITH FIXES

Every cited file, line range, export and message in the changed hunks exists as stated (checked: `client/src/lib/routines.ts:8` three-hop import,
`test/routine-file.test.ts:33-39` builders with the hardcoded `cron: "0 9 * * *"`, `shared/routine-file.ts:90` `${key} given twice`,
`JobLedger.tsx:62` / `RunsList.tsx:78` `dotTone` callers, `JobLedger.tsx:86-89, 97`, `JobMenu.tsx:26-28`, `test/run-routine.test.ts:684-692`,
`server/api.ts:1963` `installedFrom`, `server/api.ts:2212` `/validate` summary). The three new `describeCron` examples recompute from the stated rule
(`*/15 9 * * *` → LL = 45). The `scheduled` helper matches spec §Manual lines 177-182. Two statements in the diff are not true of the repo as it stands;
both are cheap to fix and neither ships wrong behaviour.

## Important

- **[I] plan:53 — Review Focus 5 says "that the row never writes is checked by hand in Task 7", but Task 7 (plan:315-327) has no such step.** Its Step 2
  edits Schedule, Model, Limits and Tools on readable files; nothing there produces an "edit in File" row (block-list `allowed-tools:`, unclosed fence,
  unknown machine). → Either add to Task 7 Step 2: "open a throwaway whose `allowed-tools:` is a block list; its Tools row reads 'edit in File', has no
  control, and File is byte-identical after Save", or reword Focus 5 to say the write side is pinned by `routeErrors`/`UNREADABLE` unit cases only
  (Task 4's `read → UNREADABLE` cases exist; a "write is never called" pin would need the row component, which no task tests).

- **[I] plan:115 (and :125) — "Run the three files; the new cases fail" is stale on both counts.** Task 2's Test list now names four files, and the
  `test/run-routine.test.ts` case the diff adds cannot fail at Task 2: once Task 1 has regenerated `plugin/lib/routine-file.mjs`, the wrapper already
  takes `cron: manual` and `plugin/lib/run-routine.mjs:263-270` already records no `slot` and `late: false` when `parseCron` fails (the spec says so at
  §Manual line 190: "as today — no change"). The plan's Files line does say "test only, no change expected", but Step 2 contradicts it. → "Run the four
  files; the new cases fail except the run-routine one, which is a pin and passes already." Also have it assert `start.kind === 'start'`: a refusal
  record (`run-routine.mjs:143`) has no `slot` key and no `late: true` either, so without the kind check the case passes on a refused run too.

- **[I] plan:104-106 — "the api test alone cannot pin this" is false.** `test/api-routines.test.ts:189-202` unit-tests `installedFrom` directly, outside
  the `no-plugin` HTTP harness, and `:199` already asserts `installedFrom(report('in-sync', [], 1), 'x', false) === false`. The new assertion is that
  line composed with `scheduled(manualJob)`, and placing it in `test/routine-reconcile.test.ts` means importing `installedFrom` from `../server/api.js`
  into a file that today imports nothing from `server/api.ts` (`test/routine-reconcile.test.ts:6-22`). → Put the `installedFrom(..., scheduled(manualJob))`
  assertion beside `test/api-routines.test.ts:199` and import `scheduled` there; keep the four `scheduled` truth-table cases in
  `test/routine-reconcile.test.ts`; drop the parenthetical.

## Minor

- plan:109-111 — the "manual job not on this machine reads `—` / `<machines> only`" case is a regression pin: `client/src/lib/routines.ts:139` returns
  that before any enabled/manual logic, so it passes as soon as Task 1 lets the job parse. The hunk hints at this ("that branch keeps winning");
  say "passes already" outright, per the plan's own convention for pins.
- plan:125 — Step 6 "Run the three test files" → four.
- plan:84-85 — Task 2 Files line mixes a prose note (`plugin/lib/run-routine.mjs (test only, no change expected)`) into the Modify list; moving it to
  the Test line (or a "Read:" entry) keeps Modify to files that change.
- plan:144-145 — the T rule says "`Every minute, HH:00–HH:59` over a single hour or a contiguous hour range that is not all 24"; an hour field written
  `0-23` parses to all 24 values and so reads plain `Every minute` by the first clause — consistent, but worth one example in the list so the
  implementer does not special-case the source text.

## Checked and fine

- plan:25-26 import hops: `client/src/lib/routines.ts:8` is `../../../shared/frontmatter`; `client/src/components/routines/JobLedger.tsx:3-4` is
  `../../../../shared/...`.
- plan:69-70 builder note: `claude(...)` / `shell(...)` at `test/routine-file.test.ts:33-39` hardcode the cron; a second `cron:` through `extra` hits
  `shared/routine-file.ts:90` `cron given twice`. The `.replace` workaround is correct.
- plan:80-81 Task 1 commit list (three sources `shared/cron.ts`, `shared/routine-file.ts`, `shared/types.ts`; two tests; two `.mjs`) matches Task 1's
  Files and `scripts/gen-plugin-lib.ts`'s outputs.
- plan:86-88 `dotTone` callers: exactly two (`JobLedger.tsx:62`, `RunsList.tsx:78`); the plan's split is right.
- plan:91-93 `scheduled`: spec §Manual 177-182 asks for `desired` to be the same predicate as `notDesired`; this helper gives it.
- plan:107-108 run-routine expected output recomputes from `run-routine.mjs:263-270` (slot only when `parsed.ok`; `late` starts false).
- plan:110-111 `/validate` summary: `routineSummary` (`server/api.ts:1953-1959`) falls back to `job.cron` for an unparsed cron, so `manual · shell · …`
  is right; the `enabled: false` → no `paused` half fails before Step 3 and passes after.
- plan:157 three new `describeCron` examples recompute from the stated T rule.
- plan:238-239 `routeErrors` `machines:` → `byField.machines` is consistent with the `model:` case and `FIELDS.machines.keys`.
- plan:40-41 attribution line: wording only.
