# Desktop-launch plan — review round 1

Reviewed: `docs/superpowers/plans/2026-10-30-desktop-launch.md` (315 lines) against `docs/superpowers/specs/2026-10-29-desktop-launch-design.md`
(167 lines) and the code in this worktree at `2833621`. Every code claim below was checked with codegraph or a narrow read; nothing in the plan or spec was
edited.

## Verdict

**APPROVE WITH FIXES.** No Critical finding. Seven Important findings, all fixable with plan text only; none changes the spec.

## Critical

None.

## Important

### I1 — Task 1 alone breaks `pnpm typecheck` (plan:57, plan:66, plan:76)

Task 1 makes `ServerSettings.launchSurfaceDefault` a **required** field (plan:66) and claims Step 4 leaves `pnpm typecheck` green (plan:76). But
`test/visual/fixtures/settings.ts:4` builds a full literal `export const settings: ServerSettings = { … }` with no such field, and `tsconfig.json` includes
`test` (`"include": ["shared", "server", "client/src", "test", …]`), so `tsc --noEmit` fails on that fixture the moment the field is added. The other
`ServerSettings` producers are safe: `server/api.ts:576-584` (`settingsBody`) spreads `...settings`, and `server/lib/settings.ts:258` (`getSettings`) is the
file Task 1 edits. `HealthResponse`'s new fields are optional (plan:66), so `test/visual/fixtures/health.ts` is unaffected.

Fix: add `test/visual/fixtures/settings.ts` to Task 1's **Files: Modify** list (set `launchSurfaceDefault: 'dashboard'` in the fixture), or make the field
optional (not recommended: the spec treats it as always present, decision 10 spec:118-126).

### I2 — `archivedIds` injection lives in `scan-snapshot.ts`, not `api.ts` (plan:127)

Task 3 Files says `server/api.ts` holds "the sessions list's `scanSessions` options, which inject `archivedIds`". The sessions-list options are built in
`server/lib/scan-snapshot.ts:61-75` (`archivedIds: archivedSessionIds()` at line 67); `server/api.ts:1338` calls `archivedSessionIds()` only for
`listRecentProjects` (Claude Configs), not for the sessions list. `server/api.ts` **is** still right for `serveSessionRow` (api.ts:1905-1908, which passes
`liveCwds: null` to `sessionFromRef`).

Fix: add `server/lib/scan-snapshot.ts` to Task 3 Files and name it as the place `desktopOwnedIds` is injected into `scanSessions`; keep `server/api.ts` for
`serveSessionRow`.

### I3 — `releaseDesktopLaunch(handOverId, at)` consumes a value the plan never produces (plan:96-99, plan:182)

Task 2 Produces `reserveDesktopLaunch(handOverId?, now)` returning `'ok' | 'rail-full' | 'in-flight'` and `releaseDesktopLaunch(handOverId, at)` (plan:96-99).
Task 4 (plan:182) tells the handler to release on `open` failure, but the handler has no `at` to pass: the reserve call returns only a status string, so the
timestamp the mark recorded never reaches the handler. If the release must clear exactly the mark the reserve set (so a later reserve is not released by an
older failed one), the handler needs the recorded `at`.

Fix (one of): (a) make `reserveDesktopLaunch` return `{ status, at }` (or the reservation object) and state that the handler passes that `at` to the
release; or (b) state the handler computes `now = Date.now()` once and passes it to both calls, and that `releaseDesktopLaunch` compares by that value.
Add the "release clears only the mark it reserved" test case to Task 2 Step 1.

### I4 — Hand-over parse rule leaves the `prompt` field's handling ambiguous and silently reorders validation (plan:169-171)

Plan:169-171 says the prompt check is "skipped for exactly `resume` valid + `surface === 'desktop'`; the input's `prompt` is then `''`". Two gaps:
(1) it does not say whether a hand-over body that still carries a `prompt` (non-string, empty, or > `PROMPT_CAP`) is rejected 400 or ignored; (2) the
current `parseSpawnRequest` (`server/lib/spawn.ts:157-208`) checks `prompt` at 163-172 **before** it validates `resume` at 196-205 (`bad resume id`), so
"skip the prompt check when resume is valid" requires reordering those checks, which the plan does not state. Review Focus 2 (plan:45) hinges on this.

Fix: state the exact rule (recommended: "on the hand-over shape `prompt` is ignored entirely, whatever it holds") and that the resume-id check moves ahead
of the prompt check (or that the surface/resume pair is peeked first). Add two test cases to Task 4 Step 1: hand-over with `prompt: 42` → 200/launch (or
400, whichever is chosen), and `surface: 'desktop'` with a bad `resume` and no prompt → `bad resume id`, not `prompt is required`.

### I5 — `handOverState` offers the hand-over to `question` rows (plan:262-263)

Plan:262-263: `handOverState` returns `offer` "for any other status" once holds / `stopState` / `processLive` are clear, so a row whose `status` is
`question` (set from `waitingOnQuestion` / `permissionWait` in `server/lib/scan.ts:632-637`) would get the "Open in desktop app" button while the session
still has a pending prompt. Spec decision 5 (spec:88-94) and the existing `resumeEligible` (`client/src/lib/resume.ts:29-40`) allow resume only for `idle`
and `incomplete`.

Fix: `offer` only for `idle` / `incomplete`; everything else (`working`, `question`, any future status) is `stop-first`. Add a `{ status: 'question' }` →
`stop-first` case to Task 6's test list (plan:272).

### I6 — "a fresh `readStored`" names a non-exported function (plan:71)

Task 1 Step 1 asks the test to confirm the write with "a fresh `readStored`". `readStored` is module-private (`server/lib/settings.ts:187`); the test seam
the file's other cases use is `resetSettings()` (`settings.ts:383-386`) followed by `getSettings()`. The parenthetical "reset the cache the way the file's
other cases do" points the right way, but the named function cannot be called from a test.

Fix: replace "a fresh `readStored`" with "`resetSettings()` then `getSettings()`".

### I7 — Spec test case "a desktop 200 never shows `Launch failed`" has no task (spec:126; plan:205-211)

Spec decision 10's test list (spec:126) includes: a desktop 200 produces decision 12's launch-form line, never `Launch failed`. Task 4 changes
`useSpawn.launch` to return the union (plan:209-211) and Task 5 renders the copy (plan:231-236), but no task lists a test for the response-to-copy mapping,
including the old-server `{ sessionId }` → dashboard fallback (plan:210). The repo's client tests are pure-function node-assert files
(`test/resume-eligible.test.ts`, `test/client-settings.test.ts`), so a pure mapper is testable.

Fix: have Task 4 produce a pure `parseSpawnResponse(body: unknown): SpawnResponse | null` in `client/src/lib/` (or fold it into Task 5's
`launchSurface.ts`) and add the three cases — `{ surface: 'desktop' }` → desktop line, `{ sessionId }` (old server) → dashboard, `{ surface: 'dashboard',
sessionId }` → dashboard — to `test/launch-surface.test.ts`.

## Minor

- plan:126 — `ScanOptions` is not exported (`server/lib/scan.ts:33-100`), which is fine, but `RowOptions` is `Pick<ScanOptions, …>` (scan.ts:549-562) and
  the `rowOptions` literal at scan.ts:765-769 must both gain `desktopOwnedIds` for `sessionFromRef` to see it; name both in Task 3 so the implementer does
  not add the option to `ScanOptions` only.
- plan:282 — "whatever client settings hook types the server patch" is `client/src/hooks/useServerSettings.ts` (`save` at line 72, `SavingKey` at line 9);
  name it.
- plan:284 — the Task 7 conditional resolves to "no test": `grep -n "gitFetchSecs\|launchSurface" test/client-settings.test.ts` is empty, so the file does
  not cover the server-settings patch shape. State "none; typecheck is the gate" outright instead of leaving the implementer to discover it.
- plan:160 — names `client/src/hooks/useGitSync.ts` where spec:125 names `client/src/lib/gitSync.ts`; the plan is right (`useGitSync.ts:94-106` is the
  consumer of `launch(...)`'s result; `lib/gitSync.ts` never touches it). Not a plan defect — the spec line should be corrected in its own round.
- plan:39 — the test-run command relies on every named test file exporting `run`; verified for all nine Modify test files (one `export … run` each).
- plan:109 — Task 2 says `open` is launched "through the `OpenRunner` seam"; `open-folder.ts:11` exports `OpenRunner` and `overrideOpenFolder`
  (open-folder.ts:39-42) is the override, both exist. The CLAUDE.md launched-program list already names `lib/open-folder.ts` launches `open`; Task 8
  (plan:300) adds `lib/desktop.ts` to that sentence — `test/outbound.test.ts` scans only network modules and `fetch(`, so an `execFile` of `open` in a new
  file does not trip it (verified: `scanOutbound`, outbound.test.ts:40-59). No change needed, recording that it was checked.

## Checklist results

| # | Check | Result |
|---|-------|--------|
| 1 | Coverage | Every spec decision 1-12 maps to a task (see map below). Spec test cases: decision 4 (spec:86-87) → Task 2 (plan:112-117) and Task 4 (plan:199-204); decision 5 (spec:94) → Task 6 (plan:272) with the I5 gap; decision 10 (spec:126) → **no task** for the 200-copy case (I7); decision 11 (spec:144-146) → Task 3 (plan:142-144). |
| 2 | Values | All status codes and bodies at plan:32-33 and all decision-12 copy at plan:34-35 match spec:147-151 and spec:72-110 byte-for-byte. Expected-shape string extension (plan:74) matches the existing literal at `server/api.ts:723`. |
| 3 | Reality | Create targets absent: `server/lib/desktop.ts`, `client/src/lib/launchSurface.ts`, `test/desktop.test.ts`, `test/launch-surface.test.ts`. All Modify targets present (23 files checked). Wrong attribution: I2. Non-exported name used as a seam: I6. Missing Modify target: I1. |
| 4 | Interfaces | Every Consumed name is Produced earlier with the same spelling, except the `at` argument of `releaseDesktopLaunch` (I3). `Session.desktopOwned?: true` matches the existing `processLive?: true` encoding at `shared/types.ts:143`. |
| 5 | Order | No forward dependency between tasks. Task 1 does not leave typecheck green on its own (I1). `SpawnResponse` deferral to Task 4 (plan:67) is correct: `client/src/hooks/useSpawn.ts:59` and `useGitSync.ts:94-106` are its consumers and both are in Task 4 Files. |
| 6 | Tests | Review Focus 1-5 (plan:44-50) each have a test (plan:199, 201, 200, 204, 142-144). Fixtures discriminate: rail test uses distinct ids and timestamps (plan:112-115); `archived.test.ts` sibling reader exercised with 2 keys (plan:142). Gaps: I3 (release matches its own mark), I4 (prompt on hand-over shape), I5 (`question` row), I7 (response mapping). |
| 7 | Conventions | No literal code blocks; behaviour and exact values only. Size budgets stated soft. Longest line 158 columns; wrap respected. |

## Spec → task map

| Spec section | Task |
|---|---|
| D1 `surface` on `POST /api/spawn` (spec:72-76) | 1 (type), 4 (handler) |
| D2 URL shapes (spec:77-80) | 2 |
| D3 probe + health (spec:81-84) | 2 |
| D4 desktop rail (spec:85-87) | 2, 4 |
| D5 hand-over gate (spec:88-94) | 4, 6 |
| D6 hand-over marks (spec:95-99) | 2, 3 |
| D7 `desktopOwned` sibling reader (spec:100-105) | 3 |
| D8 handler order (spec:106-110) | 4 |
| D9 `SpawnResponse` union (spec:111-117) | 4 |
| D10 setting + health default (spec:118-126) | 1, 7 |
| D11 archived reader tests (spec:127-146) | 3 |
| D12 copy (spec:147-151) | 5, 6, 7 |
| Docs (spec:152-167) | 8 |

## Decisions logged (autopilot)

- Task 1 typecheck break (I1) rated Important, not Critical: it breaks the build only at the Task 1 commit and the fix is a one-line fixture edit; the
  checklist's definition of Critical ("breaks build") is read as the merged branch, which Task 1 alone never is.
- I7 rated Important rather than Minor because it is a spec-listed test case with no owning task (checklist 1).
