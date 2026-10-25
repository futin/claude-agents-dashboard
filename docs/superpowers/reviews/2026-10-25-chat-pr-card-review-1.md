# Review 1 — Chat PR card implementation plan

Plan: `docs/superpowers/plans/2026-10-25-chat-pr-card.md` · Spec: `docs/superpowers/specs/2026-10-24-chat-pr-card-design.md` · Reviewer: fresh subagent
(Fable 5.1), 2026-10-25. Every code claim below was read in the worktree at `feat/chat-pr-card` (HEAD `2290ac1`).

## Verdict

**APPROVE WITH FIXES.** One Critical (a CSS wording that, read naturally, fails `test/daylight-contrast.test.ts` in CI), five Important (two test cases that
cannot fail on the bug they exist for, one test that the previous case's cache poisons, one copy rule the band loses, one Review Focus item with no test).
All are local edits to the plan; no task needs restructuring.

## Checklist results

1. **Coverage** — every spec section and every spec §Verification case maps to a task (table below). Nothing uncovered.
2. **Values** — all copy strings, failure reasons, argv, regexes, windows and envelope codes match the spec verbatim. One copy rule is lost on the band (I4).
3. **Reality** — all 10 Create paths are absent; all Modify paths and line anchors exist (`shared/types.ts:1248` `SessionPlan`; `test/run-all.ts:19/:38/:53/:199/:239`;
   `server/lib/git-fetch.ts:53-54` `makeFetchRunner({timeoutMs?, bin?})`; `server/api.ts:93` `ID_RE`, `:1219` `serveSessionPlan`; `server/index.ts:45` import,
   `:421-422` comment, `:435` plan route; `docs/overview.md:86`; `client/src/components/ChatDrawer.tsx:265` `<TasksCard/>`; `client/src/styles.css:52-61`,
   `:130-137`, `:1612`, `:2069-2080`; `client/src/lib/format.ts:41` `formatAgo(ms: number)`; `.claude/DESIGN.md:394` §8.6; `test/visual/fixtures/index.ts:32-36`;
   `server/lib/scan.ts:97` `projectsRoot`, `:263` `findTranscript`; `test/api-harness.ts:121` `withServer`). The real `gitOperation` record shape at plan:86-89
   matches a transcript on this machine (record-level `cwd`, `content` string, `is_error: false`, `toolUseResult` keys `stdout, stderr, interrupted, isImage,
   noOutputExpected, gitOperation`, `pr: { number, url, action: 'created' }`).
4. **Interfaces** — every Consumed name is Produced earlier with the same spelling (`FetchRunner`/`makeFetchRunner` exist at `git-fetch.ts:21/:54`;
   `FetchRunner` resolves `{ code, stdout, stderr, timedOut }` and rejects only on spawn failure, which is exactly what `classifyGhFailure`'s union expects).
5. **Order** — Task 1 → 2 → 3 → 4 → 5 → 6, no forward dependency.
6. **Tests** — all tests fail before implementation (modules absent). Review Focus 1–4 are pinned (D4, D15, S12, S13–S15); RF5 is not (I5). Three fixtures
   do not discriminate (I1, I2, I3).
7. **Conventions** — no literal code; the one JSON shape is fixture data. Wrapped at 160. Size budgets soft.

### Coverage map

| Spec | Task |
|---|---|
| §Goals card, newest PR, rows, fold, merged/closed, degrade (:17-25) | 4, 5 |
| §Anti-goals no writes / no per-poll launch / no outbound / no literal colours (:38-47) | 2 (outbound test), 3 (modal-only route), 5 |
| §How a PR is found 1-3, subagents, title, incremental, failed create (:57-76) | 1 (D1-D16) |
| builder may widen to `bind_pr` (:77-78) | not taken — allowed ("may"); see M7 |
| §How status is read argv/env/cwd/URL guard/cache/fold/failure/runner (:82-116) | 2 (S1-S16) |
| §API envelope, await, hook skip-while-pending, payload (:120-146) | 1 (types), 3 (A1-A6), 5 (hook) |
| §Client placement, classes, link attrs, `formatAgo`, both rows on draft (:151-159) | 5 |
| §Copy checks/review/merge/band (:163-186) | 4 (C1-C7) |
| §Constraints CLAUDE.md sentence, overview map, chat.md, DESIGN.md, themes (:190-195) | 2 step 5, 3 step 3, 6 |
| §Verification unit/fold/API/visual/live/typecheck/visual fixture (:199-212) | 1, 2, 3, 6 |
| §Left to builder (:216-218) | all decided in plan |

## Findings

### Critical

**C1 — plan:290-291 Daylight tint lines "in the same `color-mix` form" fail the contrast test.**
`test/daylight-contrast.test.ts:54-58` (`daylightMixTokens`) only recognises a Daylight token written as `--X-tint:color-mix(in srgb,#rrggbb N%,transparent)`
— the regex is `(#[0-9a-fA-F]{6})`. The rule `.pr-state.closed{color:var(--red);background:var(--red-tint)}` is picked up by `tintPairs` (:87-104) as
`{ token: 'red', bg: 'red-tint', pct: 100 }`; at :176-178 a missing `mixes['red-tint']` falls through to `at('red-tint')`, which asserts
"`--red-tint` is not a #rrggbb token in the daylight block" (:111-113). So a Daylight line of `color-mix(in srgb,var(--red) 14%,transparent)` — the "same form"
as the `:root` line — turns `pnpm test` red in CI. The existing Daylight tints use hexes for this reason (`styles.css:136-137`).
→ Rewrite plan:291 to: "Daylight: `--red-tint:color-mix(in srgb,#aa3927 14%,transparent)` and `--magenta-tint:color-mix(in srgb,#6950a5 14%,transparent)` —
Daylight's own `--red`/`--magenta` hexes (`styles.css:130`) as literals, the form `daylightMixTokens` in `test/daylight-contrast.test.ts:56` parses." Add
`npx tsx test/daylight-contrast.test.ts` to Task 5 Step 2's run list.

### Important

**I1 — plan:212-214 A4's merged answer is cached forever and poisons A5.** Task 2 caches merged/closed "forever" (plan:156), keyed by URL; A4 and A5 both use
`https://github.com/o/r/pull/7`. `withServer` (`test/api-harness.ts:121-170`) calls `resetStores()` (:106-112), which resets nothing in `pr-status.ts` or
`pr-detect.ts`. A5 therefore answers from A4's cache with `live.state: 'merged'`, never reaching the ENOENT stub.
→ Task 3 Step 1: "call `resetPrStatusCache()` and `resetPrDetectCache()` before each case" (or add both to `resetStores` in `test/api-harness.ts`, and say so
in Files).

**I2 — plan:212-214 A4 does not discriminate `live.title ?? detected.title` from the reverse.** A4's transcript has no `--title` (A5 adds one), so
`detected.title` is null and either precedence yields `Real title`; A5 has `live: null`, so either yields `Arg title`.
→ A4's create command carries `--title "Arg title"` too, and the case still expects `title: 'Real title'`.

**I3 — plan:160-161 S2 expects `failed: 2, running: 2`.** A fold that swaps the failed and running buckets passes S2 unchanged; S13 only catches it by a side
effect (window choice).
→ Give the three buckets distinct counts, e.g. add CheckRun `QUEUED` ×2 → `{ passed: 3, failed: 2, running: 4, total: 9 }` (also exercises a second
not-COMPLETED status the spec table lists at :103).

**I4 — plan:286 the `.pr-band` renders a pill unconditionally.** Spec:184: `live null (unavailable)` → `status unavailable` — **no pill**. Plan:284 carries the
exception for `.pr-top` ("unless `live` is null"); plan:286 lists the band's contents as "`PR #<n>`, pill, `bandLine`, chevron" with no condition, so an
implementer reading the band line alone renders a pill on the unavailable band.
→ "…the pill under the same condition as `.pr-top`…".

**I5 — plan:45-46 Review Focus 5 has no test.** The checklist requires a test per Review Focus item; RF5 is pinned only by a manual dev-server step. The repo
has no React hook harness (no `renderHook`/`@testing-library` under `test/`), so a hook test is not a small add.
→ Either (a) move the decision to a pure function in `client/src/lib/pr.ts` — e.g. `acceptPrAnswer(currentId, answeredId, prev, body): SessionPr` returning
`prev` on `error`/id mismatch and `body.pr` otherwise — and pin it in Task 4 (C8: old-id answer dropped, `error: true` keeps `prev`, matching id replaces); or
(b) state in RF5 that it is manual-only and why (no hook harness), so the final review does not look for a test that was never planned.

### Minor

- **M1 — plan:33** hardcodes `Co-Authored-By: Claude Opus 5.5`. The implementing session's attribution reminder names the model actually running (this review
  ran under Fable 5.1); say "end with the attribution line the session's reminder gives" rather than a model name.
- **M2 — plan:72** "LRU of 64": `server/lib/tasks.ts:235` evicts `cache.keys().next()` and never re-inserts on a hit, so it is insertion-order (FIFO), not LRU.
  "The same 64-entry eviction as `tasks.ts`" is accurate.
- **M3 — plan:307** fixture answers a populated PR for every id; spec:211 asks `{ id, pr: null }` for every session and a populated PR for one. Unobservable — every
  chat-opening case opens `FIXTURE_SESSION_ID` (`test/visual/views.spec.ts:71,73`, `stage.spec.ts:68,77`) — but the plan's own rule (:7) is "spec wins and you
  say so"; add the one-line justification to Task 6 so the builder does not re-derive it.
- **M4 — plan:81** `cwd` comes from the Bash record; spec:82-83 says the session's `projectPath`. `TranscriptRef` (`server/lib/scan.ts:23-29`) carries no project
  path and the chat handler has no `Session`, so the record `cwd` is the practical source — note the deviation in Task 1 (the spec itself calls the cwd
  "not required for a full URL").
- **M5 — plan:138** "`GH_PR_RE` … capturing `owner/repo` and the number": one group or two? Task 3 (:204) uses `owner/repo` as one string; say "group 1 = `owner/repo`,
  group 2 = number".
- **M6 — plan:289** draft pill "on a neutral existing tint": name it. `--steel` is the one whose `--ink2` contrast Daylight pins (`test/daylight-contrast.test.ts:124`).
- **M7 — spec:77-78** offers widening detection to `mcp__ccd_pr__bind_pr` (its record is `{"name":"mcp__ccd_pr__bind_pr","input":{"url":"https://github.com/…/pull/279"}}`
  on this machine). The plan neither takes nor declines it; one line in Task 1 ("not widened: bind_pr binds an existing PR, which is not 'created'") closes it.
- **M8 — plan:206** the comment is at `server/index.ts:421-422`, not :420 (the `~` convention elsewhere in the plan would cover it).
- **M9 — plan:184-185** `test/outbound.test.ts:116-118` reads CLAUDE.md only between "Keep new deps out of" and "`client/dist/`"; the new `lib/pr-status.ts`
  sentence lands in that span if added to the launched-programs sentence as written — worth saying so the builder does not put it in a new bullet below.

## What was verified and how

- `makeFetchRunner` semantics (`git-fetch.ts:54-93`): resolves `{ code: -1, timedOut: true }` on timeout after `killGroup`, rejects on the child's `error` event
  (ENOENT), `env` is spread over `process.env` — all consistent with Task 2's runner, classifier and S1/S8/S12.
- `tasks.ts:163-183` fold: carries the partial last line and advances `offset` only past a newline — RF2/D15 are achievable with the "same shape".
- `usePendingPlan.ts:56-73`: the sibling already resets on id change and drops stale answers via a `live` flag; only the skip-while-pending guard is new, as
  plan:280-281 claims.
- `test/plan-progress.test.ts:200-202`: the `chmodSync(…, 0)` + `getuid` skip precedent D14/A6 reuse.
- `test/visual/mock-api.ts:44-58, 97-100`: `:id` segment matching and the "no fixture" 404 — Task 6's fixture key and the "no function body needed" claim hold.
