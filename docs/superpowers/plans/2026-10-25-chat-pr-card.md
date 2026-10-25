# Chat PR card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan specifies behaviour, signatures and exact test cases — never literal code** (global CLAUDE.md override of the writing-plans template). Write the
> bodies yourself; where this plan and the spec disagree, the spec wins and you say so in the commit. Size budgets anywhere here are soft.

**Goal:** Show the session's newest created pull request — live state, checks, review and merge — as a card in the chat modal's sidecar.

**Architecture:** A server reader folds the transcript for the newest created PR (`gitOperation.pr`, else a `gh pr create` parse). A second module launches
`gh pr view --json …` through the existing git-fetch runner, folds the JSON and caches it per URL. `GET /api/sessions/:id/pr` composes both. The client polls
it from the chat modal only and renders `PrCard` after `TasksCard`; all copy rules live in a pure `client/src/lib/pr.ts` so node-assert can pin them.

**Tech Stack:** Node + TypeScript via tsx (zero runtime deps), React + Vite, node-assert tests through `test/run-all.ts`, Playwright visual suite.

**Spec:** `docs/superpowers/specs/2026-10-24-chat-pr-card-design.md` (mockups beside it, variant A + "States of A").

## Global Constraints

- Server: Node built-ins only; no `fetch`, no `node:https` — `gh` is launched, `test/outbound.test.ts` stays green **unchanged**.
- ESM, `.js` suffix on server imports; client and server import `shared/types.ts` with `import type`.
- API field order: `shared/types.ts` → server producer → client consumer.
- No colour or shadow literal below the theme-token block in `client/src/styles.css`; new tints are `color-mix` on `:root` plus one Daylight line each.
- Class names, once shipped, are stable: `pr-kv`, `pr-top`, `pr-glyph`, `pr-state` (+ `open`/`draft`/`merged`/`closed`), `pr-title`, `pr-ref`, `pr-rows`,
  `pr-row`, `pr-checks`, `pr-band`; tones `ok` / `bad` / `dim` / `run`.
- `gh` argv is exactly `pr view <url> --json number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable,mergedAt,closedAt`;
  child env adds `GH_NO_UPDATE_NOTIFIER=1` and `GH_PROMPT_DISABLED=1`; no shell; timeout 10s.
- Only a URL matching `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$` ever reaches argv.
- Failure reasons, verbatim: `gh not installed`, `gh not signed in`, `timed out`, `gh failed`, `not a GitHub PR`.
- Copy is §Copy of the spec, verbatim (tables reproduced in Task 4's tests).
- New text wraps at 160 columns; a measured figure carries its date.
- Commits: `git add <files>` and `git commit` as separate commands; end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run only the touched suites locally (`npx tsx test/<file>.test.ts`) plus `pnpm typecheck`; CI runs the full `pnpm test`.

## Review Focus

1. **`git push` output in the same result.** `gh pr create` chained after a push prints `https://github.com/o/r/pull/new/<branch>`; it must never be read as a
   PR (the URL pattern needs digits and a non-word boundary after them). Pinned by Task 1 case D4.
2. **A transcript mid-write.** The last line has no newline yet; it is not folded until complete, and the next read picks it up. Pinned by Task 1 case D15.
3. **`gh` hangs or several polls arrive together.** One launch per URL in flight, shared by every caller; the handler is bounded by the 10s timeout. Pinned by
   Task 2 case S12.
4. **The PR merges while the modal is open.** The next poll after the window shows Merged; a merged PR is never launched for again. Pinned by Task 2 cases
   S13–S15.
5. **The modal switches to another session.** The previous session's card must not linger on the new one: the hook resets to `null` on an id change and drops an answer for
   the old id. Pinned by Task 4 case C8 (`acceptPrAnswer`) and Task 6's dev-server step (open session A with a PR, then session B without).

---

### Task 1: Types and PR detection

**Files:**
- Modify: `shared/types.ts` (beside `SessionPlan`, ~line 1248)
- Create: `server/lib/pr-detect.ts`
- Create: `test/pr-detect.test.ts`; register in `test/run-all.ts` (import beside `runTasks` at :19, call beside :199)

**Interfaces:**
- Produces (`shared/types.ts`):
  - `PrChecks { passed: number; failed: number; running: number; total: number }`
  - `SessionPrLive { state: 'open' | 'draft' | 'merged' | 'closed'; title: string; head: string; base: string; checks: PrChecks | null;
    review: 'approved' | 'changes' | 'required' | 'none'; merge: 'clean' | 'conflicts' | 'unknown'; endedAt: string | null }`
  - `SessionPrInfo { url: string; number: number; repo: string | null; title: string | null; live: SessionPrLive | null; unavailable: string | null }`
  - `type SessionPr = SessionPrInfo | null`; `SessionPrResponse { id: string; pr: SessionPr; error?: boolean }`
- Produces (`server/lib/pr-detect.ts`):
  - `interface DetectedPr { url: string; number: number; title: string | null; cwd: string | null }`
  - `readSessionPr(filePath: string): DetectedPr | null` — the newest created PR in transcript order; null when none or the file is missing (ENOENT);
    **throws** on any other I/O error (unlike `readSessionTasks`), keeping what it folded so the next call resumes.
  - `parsePrTitle(command: string): string | null`
  - `resetPrDetectCache(): void` (test seam)

Behaviour:
- Same incremental shape as `server/lib/tasks.ts`: per-file entry with byte offset and size, a 64-entry cache evicting the oldest insertion (as `tasks.ts:235`), `CHUNK_BYTES` reads, a smaller size means the file was
  replaced and is re-folded from 0, a malformed line is skipped.
- Assistant records: remember each `Bash` `tool_use` by id with its `input.command` and the record-level `cwd`.
- User records: for each `tool_result` block answering a remembered Bash id:
  - `toolUseResult.gitOperation.pr` present → it decides alone: `action === 'created'` with a numeric `number` and string `url` sets the newest PR; anything
    else contributes nothing (no fallback).
  - Otherwise, fallback only when the command contains `gh pr create` and `is_error` is not true: the last match of
    `https://github\.com/[\w.-]+/[\w.-]+/pull/\d+(?![\w/])` in the result text (string content, or the joined `text` blocks) sets the newest PR. No match →
    nothing.
  - `title` = `parsePrTitle(command)`; `cwd` = the call's record cwd (null when absent).
- Nothing else counts: no `pr-link` record, no URL in assistant or user prose, no non-Bash tool.
- `parsePrTitle`: `--title "…"`, `--title '…'`, `--title=…` (quoted or bare to the next space), and `-t` in the same three forms. A value starting with `$(`
  (a heredoc or command substitution) → null. No title flag → null.

Fixtures copy the real record shapes (measured 2026-10-25 in this project's transcripts): a user record
`{ type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content: '<text>', is_error: false }] },
toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, gitOperation: { pr: { number: 57, url, action: 'created' } } } }`,
whose stdout ends `remote:      https://github.com/futin/claude-agents-dashboard/pull/new/<branch>\n…\nhttps://github.com/futin/claude-agents-dashboard/pull/57`.
Reuse the `call` / `result` / `line` helper style of `test/tasks.test.ts`.

- [ ] **Step 1: Add the types to `shared/types.ts`** with one JSDoc line each (what `null` means for `checks`, `live`, `SessionPr`).

- [ ] **Step 2: Write the failing tests in `test/pr-detect.test.ts`** (`run(): number` returning the failure count, plus the main guard, as `tasks.test.ts`):
  - D1 gitOperation record for #57 → `{ url: '…/pull/57', number: 57, title: <parsed>, cwd: <record cwd> }`.
  - D2 newest wins across signals: gitOperation #57 then parse-only #58 → 58; parse-only #58 then gitOperation #59 → 59.
  - D3 one call whose gitOperation says #57 and whose text holds `…/pull/99` → 57.
  - D4 parse fallback, compound commands: heredoc body then `gh pr create --title "x" --body-file /tmp/b`, result text with the `pull/new/<branch>` line then
    `https://github.com/o/r/pull/12` → 12; `git push && gh pr create --fill | tail -3` → its URL; `cd x && gh pr create -R other/repo` with
    `https://github.com/other/repo/pull/5` → repo URL `other/repo`, 5. A result holding only the `pull/new/<branch>` URL → null.
  - D5 two PR URLs in one result → the last.
  - D6 failed create: `is_error: true` with a URL in its text → null; success with no URL → null.
  - D7 `gh pr view 123` whose result holds a PR URL → null.
  - D8 a top-level `{ type: 'pr-link', prNumber: 3, prUrl, prRepository }` record → null.
  - D9 a PR URL only in assistant text and in a user prompt → null.
  - D10 gitOperation with `action: 'merged'` → contributes nothing, and the command parse does not run for that call.
  - D11 gitOperation `created` with a non-github URL (`https://ghe.example.com/o/r/pull/4`) → detected as is (status handles it).
  - D12 `parsePrTitle`: `--title "Fix: a"` → `Fix: a`; `--title 'b c'` → `b c`; `--title=d` → `d`; `--title="e f"` → `e f`; `-t "g"` → `g`;
    `-t 'h i'` → `h i`; `-t=j` → `j`; `--title "$(cat <<'EOF'` … → null; `gh pr create --fill` → null.
  - D13 incremental: read with no PR → null; append a create without resetting the cache → the second read returns it; replace the file with a shorter one
    holding a different PR → that PR.
  - D14 missing file → null; a file with mode `000` → throws (skip when running as root).
  - D15 a final create line with no trailing newline → null; append the `\n` → detected.
  - D16 a malformed JSON line between two valid ones is skipped; the valid create after it is detected.

- [ ] **Step 3: Run** `npx tsx test/pr-detect.test.ts` — expect failures (module missing).

- [ ] **Step 4: Implement `server/lib/pr-detect.ts`** per the behaviour above. Header comment: what counts, why `pr-link` never does (2026-10-24: 11 PRs marked
  that sessions did not create), why subagent files are not read.

- [ ] **Step 5: Run** `npx tsx test/pr-detect.test.ts` — all pass; `pnpm typecheck` — clean.

- [ ] **Step 6: Commit** `feat(chat): detect the PR a session created`.

---

### Task 2: Live status through `gh`

**Files:**
- Create: `server/lib/pr-status.ts`
- Modify: `server/lib/git-fetch.ts:53` (the `makeFetchRunner` doc line only: its `bin`/`timeoutMs` knobs now have a production caller)
- Create: `test/pr-status.test.ts`; register in `test/run-all.ts`
- Modify: `.claude/CLAUDE.md` zero-deps rule (launched-programs sentence) and `docs/overview.md` `lib/` map

**Interfaces:**
- Consumes: `FetchRunner`, `makeFetchRunner` from `server/lib/git-fetch.ts`; `SessionPrLive`, `PrChecks` from Task 1.
- Produces (`server/lib/pr-status.ts`):
  - `GH_PR_RE` — the validated-URL pattern from Global Constraints; group 1 = `owner/repo`, group 2 = the number.
  - `foldPrView(json: unknown): SessionPrLive | null` — null when the JSON lacks `state` / `headRefName` / `baseRefName` strings.
  - `classifyGhFailure(failure: Error | { code: number; stderr: string; timedOut: boolean }): string`
  - `readPrStatus(url: string, cwd: string | null): Promise<{ live: SessionPrLive | null; unavailable: string | null }>` — never rejects.
  - `overrideGhRunner(run: FetchRunner | null): void`, `overridePrClock(now: (() => number) | null): void`, `resetPrStatusCache(): void` (test seams)

Behaviour:
- Real runner: `makeFetchRunner({ bin: 'gh', timeoutMs: 10_000 })`.
- A URL failing `GH_PR_RE` → `{ live: null, unavailable: 'not a GitHub PR' }` with no launch.
- cwd: `statSync(cwd).isDirectory()` → cwd; null, missing or not a directory → `os.homedir()`.
- Fold: state precedence MERGED → merged, CLOSED → closed, then `isDraft` → draft, else open. Checks per the spec's table (CheckRun not COMPLETED → running;
  COMPLETED SUCCESS → passed; NEUTRAL/SKIPPED → excluded; other conclusion → failed; StatusContext SUCCESS → passed, PENDING/EXPECTED → running, anything else
  → failed; other `__typename` → excluded); `total = passed + failed + running`; total 0, empty or missing rollup → `checks: null`. Review: `APPROVED` →
  approved, `CHANGES_REQUESTED` → changes, `REVIEW_REQUIRED` → required, anything else → none. Merge: `MERGEABLE` → clean, `CONFLICTING` → conflicts, else
  unknown. `endedAt`: merged → `mergedAt ?? closedAt`, closed → `closedAt`, open/draft → null. `title`, `head`, `base` from `title`, `headRefName`, `baseRefName`.
- Failures: runner rejects with `code: 'ENOENT'` → `gh not installed`; `timedOut` → `timed out`; non-zero exit whose stderr matches `/auth login|not logged in|authenticat/i` →
  `gh not signed in`; any other non-zero exit, unparsable stdout or `foldPrView` null → `gh failed`.
- Cache per URL `{ value, until }` plus an in-flight promise map: a call before `until` returns the value without launching; concurrent callers share one
  launch. Windows: merged/closed → forever; open/draft with `checks.running > 0` or `merge: 'unknown'` → 20s; other open/draft → 60s; a failure → 20s.

- [ ] **Step 1: Write the failing tests in `test/pr-status.test.ts`** with a spy runner recording `(cwd, args, env)` and a fixed clock:
  - S1 argv equals the Global Constraints argv for `https://github.com/o/r/pull/7`; env has both `GH_*` vars `'1'`.
  - S2 rollup of eleven: CheckRun COMPLETED SUCCESS ×2, CheckRun IN_PROGRESS ×1, CheckRun QUEUED ×2, CheckRun COMPLETED SKIPPED ×1, CheckRun COMPLETED FAILURE ×1,
    StatusContext SUCCESS ×1, StatusContext PENDING ×1, StatusContext ERROR ×1, `__typename: 'Other'` ×1 → `{ passed: 3, failed: 2, running: 4, total: 9 }`.
  - S3 all SKIPPED → `checks: null`; `[]` → null; field missing → null.
  - S4 states: MERGED + isDraft true → merged; CLOSED + isDraft true → closed; OPEN + isDraft → draft; OPEN → open.
  - S5 each `reviewDecision` (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, `''`, missing) → approved, changes, required, none, none.
  - S6 each `mergeable` (`MERGEABLE`, `CONFLICTING`, `UNKNOWN`) → clean, conflicts, unknown.
  - S7 `endedAt`: merged with `mergedAt: '2026-10-24T10:00:00Z'`, `closedAt: '2026-10-24T10:00:01Z'` → the mergedAt; closed → closedAt; open → null.
  - S8 failures: ENOENT rejection → `gh not installed`; exit 4, stderr `To get started with GitHub CLI, please run:  gh auth login` → `gh not signed in`;
    `timedOut` → `timed out`; exit 1, stderr `GraphQL: Could not resolve to a PullRequest` → `gh failed`; exit 0, stdout `nope` → `gh failed`.
  - S9 `https://ghe.example.com/o/r/pull/4` and `--web` → `not a GitHub PR`, zero launches.
  - S10 cwd: an existing tmp dir → that dir; a missing path → `os.homedir()`; null → `os.homedir()`.
  - S11 a regular file as cwd → `os.homedir()`.
  - S12 two concurrent calls before the runner resolves → one launch, equal results.
  - S13 open with one running check: +19s → no launch; +21s → launch. Open settled: +59s → none; +61s → launch.
  - S14 merged: +1 day → no launch.
  - S15 a failure: +19s → no launch (same reason returned); +21s → launch.
  - S16 open with `mergeable: UNKNOWN` and no running checks uses the 20s window.

- [ ] **Step 2: Run** `npx tsx test/pr-status.test.ts` — expect failures.

- [ ] **Step 3: Implement `server/lib/pr-status.ts`** per the behaviour above; update the `makeFetchRunner` doc line.

- [ ] **Step 4: Run** `npx tsx test/pr-status.test.ts` and `npx tsx test/outbound.test.ts` — both pass, the latter unchanged; `pnpm typecheck` clean.

- [ ] **Step 5: Docs.** `.claude/CLAUDE.md`: add `lib/pr-status.ts` launches `gh pr view` with `GH_NO_UPDATE_NOTIFIER=1` and `GH_PROMPT_DISABLED=1` set to the
  launched-programs sentence. `docs/overview.md` `lib/` map: one line each for `pr-detect.ts` and `pr-status.ts`.

- [ ] **Step 6: Commit** `feat(chat): read a PR's live status through gh`.

---

### Task 3: `GET /api/sessions/:id/pr`

**Files:**
- Modify: `server/api.ts` (new `serveSessionPr` beside `serveSessionPlan`, ~:1218)
- Modify: `server/index.ts` (route beside `/plan`, ~:436; import at :45)
- Create: `test/api-session-pr.test.ts`; register in `test/run-all.ts` beside `runApiReadEndpoints` (:53, :239)
- Modify: `docs/overview.md` API table (row after `/plan`, ~:86)

**Interfaces:**
- Consumes: `readSessionPr` (Task 1), `readPrStatus`, `GH_PR_RE`, `overrideGhRunner` (Task 2), `findTranscript`, `projectsRoot` (`server/lib/scan.ts`).
- Produces: `serveSessionPr(id: string, res: ServerResponse): Promise<void>`.

Behaviour: `!ID_RE.test(id)` → 400 `{ id, pr: null, error: true }`. Then inside one try: no transcript → 200 `{ id, pr: null }`; no detected PR → 200
`{ id, pr: null }`; else await `readPrStatus(url, cwd)` and answer 200 with `repo` = `owner/repo` from `GH_PR_RE` (else from any `https://<host>/<owner>/<repo>/pull/<n>`,
else null), `title` = `live.title ?? detected.title`, `live`, `unavailable`. A throw → log `[dashboard] session pr failed:` and 500 `{ id, pr: null, error: true }`.
`Cache-Control: no-store` as the siblings. The route must sit before the session-detail regex (the comment at `server/index.ts:421-422` explains why).

- [ ] **Step 1: Write the failing tests** through `withServer` (`test/api-harness.ts`), with `overrideGhRunner` set to a stub and reset after, and `resetPrStatusCache()` + `resetPrDetectCache()` called before each case
  (`withServer`'s `resetStores`, `test/api-harness.ts:106-112`, knows neither module, and A4 caches `…/pull/7` as merged forever):
  - A1 `/api/sessions/bad%20id!/pr` → 400, `error: true`, `pr: null`.
  - A2 a well-formed id with no transcript → 200, `pr: null`, no `error`.
  - A3 a transcript with no PR → 200, `pr: null`.
  - A4 a transcript with a gitOperation create of `https://github.com/o/r/pull/7` whose command carries `--title "Arg title"`, stub answering a merged PR titled `Real title` → 200 with `number: 7`,
    `repo: 'o/r'`, `title: 'Real title'`, `live.state: 'merged'`, `unavailable: null`.
  - A5 same transcript with `--title "Arg title"`, stub rejecting ENOENT → `live: null`, `unavailable: 'gh not installed'`, `title: 'Arg title'`.
  - A6 the transcript file at mode `000` → 500, `error: true` (skip as root).

- [ ] **Step 2: Run** `npx tsx test/api-session-pr.test.ts` — expect failures.

- [ ] **Step 3: Implement** `serveSessionPr` and the route; add the API table row `GET /api/sessions/:id/pr` — the PR this session created, with live `gh` status.

- [ ] **Step 4: Run** `npx tsx test/api-session-pr.test.ts` and `npx tsx test/api-read-endpoints.test.ts` — pass; `pnpm typecheck` clean.

- [ ] **Step 5: Commit** `feat(api): serve a session's pull request`.

---

### Task 4: Card copy rules

**Files:**
- Create: `client/src/lib/pr.ts`
- Create: `test/client-pr.test.ts`; register in `test/run-all.ts` beside `runClientTasks` (:38)

**Interfaces:**
- Consumes: `PrChecks`, `SessionPrLive`, `SessionPrInfo` (Task 1).
- Produces (`client/src/lib/pr.ts`), `type PrTone = 'ok' | 'bad' | 'dim' | 'run'`:
  - `checksRow(c: PrChecks | null): { text: string; tone: PrTone }`
  - `checkSegments(c: PrChecks | null): PrTone[]` — one per counted check, failed (`bad`) then running (`run`) then passed (`ok`); `[]` for null.
  - `reviewRow(r: SessionPrLive['review']): { text: string; tone: PrTone }`
  - `mergeRow(m: SessionPrLive['merge'], base: string): { text: string; tone: PrTone }`
  - `stateLabel(s: SessionPrLive['state']): string`
  - `endedLine(live: SessionPrLive, ago: (iso: string) => string): string` — merged/closed only
  - `bandLine(pr: SessionPrInfo, ago: (iso: string) => string): string`
  - `acceptPrAnswer(currentId: string, body: SessionPrResponse, prev: SessionPr): SessionPr` — the hook's whole update rule: `body.id !== currentId` → `prev`;
    `body.error` → `prev`; else `body.pr`.

- [ ] **Step 1: Write the failing tests** (`ago` stubbed to return `'2h'`):
  - C1 `checksRow`: null → `None`/dim; `{3,1,0,4}` (passed, failed, running, total) → `1 failed · 3 passed`/bad; `{2,1,1,4}` → `1 failed · 2 passed · 1 running`/bad;
    `{3,0,1,4}` → `3 of 4 passed · 1 running`/run; `{4,0,0,4}` → `4 of 4 passed`/ok.
  - C2 `checkSegments({2,1,1,4})` → `['bad','run','ok','ok']`; null → `[]`.
  - C3 `reviewRow`: approved → `Approved`/ok; changes → `Changes requested`/bad; required → `Required`/dim; none → `Not requested`/dim.
  - C4 `mergeRow`: clean → `No conflicts`/ok; conflicts with base `main` → `Conflicts with main`/bad; unknown → `Checking…`/dim.
  - C5 `stateLabel`: `Open`, `Draft`, `Merged`, `Closed`.
  - C6 `endedLine`: merged into `main` → `into main · 2h`; closed → `not merged · 2h`; merged with `endedAt: null` → `into main`.
  - C7 `bandLine`: open `{3,0,1,4}` + required → `3/4 checks · review required`; draft `{2,1,0,3}` + changes → `1 failed · changes requested`; open null checks
    + none → `no checks · no review`; open `{4,0,0,4}` + approved → `4/4 checks · approved`; merged → `into main · 2h`; closed → `not merged · 2h`;
    `live: null` → `status unavailable`.
  - C8 `acceptPrAnswer`: an answer for another id → prev (unchanged object); `error: true` → prev; `pr: null` for the current id → null; a PR for the
    current id → that PR.

- [ ] **Step 2: Run** `npx tsx test/client-pr.test.ts` — expect failures.

- [ ] **Step 3: Implement `client/src/lib/pr.ts`** — copy strings verbatim from spec §Copy.

- [ ] **Step 4: Run** `npx tsx test/client-pr.test.ts` — pass; `pnpm typecheck` clean.

- [ ] **Step 5: Commit** `feat(chat): PR card copy rules`.

---

### Task 5: Hook, card and styles

**Files:**
- Create: `client/src/hooks/usePullRequest.ts`
- Create: `client/src/components/PrCard.tsx`
- Modify: `client/src/components/ChatDrawer.tsx:265` (render after `<TasksCard …/>`)
- Modify: `client/src/styles.css` — tokens on `:root` (~:52-61) and Daylight (~:132-137); desktop rules beside `.chat-side .kv` (~:1609-1616); phone rules
  beside the tasks fold (~:2062-2082)

**Interfaces:**
- Consumes: `SessionPr`, `SessionPrResponse` (Task 1); everything in `client/src/lib/pr.ts` (Task 4); `formatAgo` (`client/src/lib/format.ts:41`).
- Produces: `usePullRequest(id: string): SessionPr`; `PrCard({ pr }: { pr: SessionPr }): JSX.Element | null`.

Behaviour:
- Hook: polls `/api/sessions/:id/pr` every `refreshMs` (`useSettings`), first fetch at once; skips a tick while its previous request is pending (a ref flag —
  no sibling has this guard); on a network failure keeps the last value; every answer goes through `acceptPrAnswer` (Task 4); on an id change resets to `null`
  before the first answer. `acceptPrAnswer`'s `currentId` is the hook's latest id read from a ref at answer time (the `tokenRef` pattern,
  `client/src/hooks/usePendingPlan.ts:51-52`), never the fetch closure's `id` — the server echoes the requested id, so the closure's would never mismatch.
  The effect also keeps the sibling's `live` cleanup flag (`usePendingPlan.ts:63-73`).
- Card: `null` → renders nothing. One DOM for both widths with `.folded` (default folded), the `TasksCard` pattern: `.kv.pr-kv` holding `.pr-top`
  (glyph, `PR #<n>`, the `.pr-state` pill unless `live` is null), the `.pr-title` link (`target="_blank" rel="noopener noreferrer"`; text = `title`, else `—`),
  `.pr-ref` (`head → base`, or `repo` when `live` is null), `.pr-rows` (Checks with `.pr-checks` bar segments, Review, Merge for open/draft; the ended line for
  merged/closed; one **Status** row `unavailable · <reason>` when `live` is null), and the `.pr-band` fold button (`PR #<n>`, the pill under the same condition as `.pr-top`, `bandLine`, chevron) that
  toggles `.folded`. `ago` = `iso => formatAgo(Date.parse(iso))`.
- CSS: desktop hides `.pr-band`; phone (`md` breakpoint block) hides the head/title/ref, shows `.pr-band`, and hides `.pr-rows` when `.folded`. Pills: open →
  `--green` on `--green-tint`, draft → `--ink2` on `--steel` (the pair Daylight already pins, `test/daylight-contrast.test.ts:124`), merged → `--magenta` on new `--magenta-tint`, closed → `--red` on new `--red-tint`.
  Tones: `ok` `--green`, `bad` `--red`, `run` `--mustard`, `dim` `--ink3`. New tints: `color-mix(in srgb,var(--red) 14%,transparent)` and the magenta twin on
  `:root`, plus one Daylight override line each written with Daylight's own hexes — `color-mix(in srgb,#aa3927 14%,transparent)` and
  `color-mix(in srgb,#6950a5 14%,transparent)` (`styles.css:130`) — because `test/daylight-contrast.test.ts:56` parses only `#rrggbb` inside a Daylight mix.

- [ ] **Step 1: Implement the hook, the card and the `ChatDrawer` line.**
- [ ] **Step 2: Add the CSS and tokens.** Then `npx tsx test/ui-kit-guard.test.ts` — pass (no `.uk-*` rule added); grep the new block for `#` and `rgb(` —
  none below the token block. `npx tsx test/daylight-contrast.test.ts` — pass (it checks every accent on its own tint, the new pills included).
- [ ] **Step 3: Run** `pnpm typecheck` and `pnpm build` — clean.
- [ ] **Step 4: Commit** `feat(chat): pull request card in the chat sidecar`.

---

### Task 6: Visual fixture, docs and the live check

**Files:**
- Create: `test/visual/fixtures/session-pr.ts`; Modify: `test/visual/fixtures/index.ts` (import + `'/api/sessions/:id/pr'` entry)
- Modify: `docs/subsystems/chat.md` (sidecar section), `.claude/DESIGN.md` §8.6 (:394, one line → the mockup), visual baselines under `test/visual/`

Behaviour: the fixture answers one populated open PR for every id (`number: 304`, title, `head`/`base`, checks `{3,0,1,4}`, review `required`, merge `clean`);
every chat-opening case opens `FIXTURE_SESSION_ID`, so no function body is needed. The chat.md paragraph covers placement, what it reads (transcript signal,
`gh`), the cache windows, the phone fold and the failure row.

- [ ] **Step 1: Add the fixture and the docs.**
- [ ] **Step 2: Run** `pnpm test:visual` — expect only chat-opening screenshots to differ and no `no fixture` failure; inspect each diff for the card, then
  `pnpm test:visual --update-snapshots` and re-run green.
- [ ] **Step 3: Live check** (dev server on 4273/5273, pid recorded, killed by pid after): open a real session from this machine that ran `gh pr create`;
  at desktop width and at 375px, in Daylight and one dark theme, confirm the card, the pill, the rows, the band and its fold; then open a session with no PR
  and confirm no card and no stale card from the previous session (Review Focus 5). Screenshot each.
- [ ] **Step 4: Commit** `test(visual): fixture and baselines for the PR card` (baselines + fixture) and `docs: PR card in the chat sidecar` (docs).
