# Chat Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the session chat modal a second mode, Trace: every tool call as a row on a spine, with its inferred causes, served live by a new `GET /api/sessions/:id/trace`.

**Architecture:** A server-side `TraceBuilder` folds a session transcript (main file + `subagents/agent-*.jsonl`) record by record into steps, inferring each step's `why` the moment its `tool_use` lands (every rule looks backward). Builders are cached in memory per transcript and advanced incrementally, so the 3s poll only parses appended bytes; the client asks `?after=<rev>&epoch=<e>` and upserts the steps that changed. The client renders the spine, the step inspector in the sidecar and the step filter in the foot inside the existing `ChatDrawer`.

**Tech Stack:** Node + TypeScript via tsx (server, zero new deps), React + Vite (client), node-assert tests (`pnpm test`), Playwright visual suite (`pnpm test:visual`, macOS).

**Spec:** `docs/guides/mockups/redesign-mock.html`: the header note (~line 130), the Trace CSS (~lines 1941-2048) and the Trace fixture, contract comment and render code (~lines 4954-5330). There is no separate design doc. The mock plus the **Decisions** section below are binding; where they differ, Decisions wins (each one says why).

## Global Constraints

- `shared/types.ts` first, then the server producer, then the client consumer (CLAUDE.md "Adding an API field"). Cross-boundary imports are `import type`.
- Server: ESM, `.js` import suffix, Node built-ins only. No new npm dependency anywhere. No outbound network call.
- Never hardcode a color or shadow in `client/src/styles.css` below the theme-token block. The mock uses token names that do not all exist live (e.g. `--green-600`, `--red-500`, `--ink-inverse`, `--r-sm`). Map each to the live token the existing chat rules use for the same role. Never introduce a literal.
- Keep existing CSS class names stable. Live chat classes are `chat-*` / `cmsg-*` (the mock's `ch-*` / `cm-*` are the same elements). New Trace classes keep the mock's `tr-` prefix. `.sel` is NOT used for the picked row (`tr-on`, see mock commit 4bec464).
- Copy is exact as written in the mock and in the tasks below (tab labels, flags, foot text, empty states, fact labels).
- Measured figures from this machine carry their date inline (CLAUDE.md), e.g. "86 of 1,306 thinking blocks carried text (60 newest transcripts, 2026-10-16)".
- `pnpm test` and `pnpm typecheck` green at every commit. New test files register in `test/run-all.ts` (`./tmp-root.js` stays the first import).

## Decisions (the spec is a mock; these settle what it leaves open)

1. **Cursor is a revision, not a byte offset.** Subagent files have their own offsets, so one byte offset cannot say where the trace stands. The response carries `cursor` (builder revision) and `epoch` (builder identity). A mismatched epoch, or `after > cursor`, answers with the full trace and `reset: true`.
2. **Server keeps a builder cache.** `Map<transcriptPath, TraceBuilder>`, LRU of 8. The builder is replaced when the main file shrinks. The first open of a large transcript parses the whole file once.
3. **Time-ordered ingest.** Each pass reads the complete new lines of the main file and every subagent file, then stable-sorts the parsed records by `timestamp` before folding. That way "earlier" in every rule means earlier in time across scopes. A record without a timestamp keeps file order.
4. **Subagent files link through `agent-<id>.meta.json` `toolUseId`.** A file without that sidecar is skipped. In the main file, `isSidechain` records are skipped. In a subagent file, user text records are skipped (they are the dispatch prompt, not a turn).
5. **Kinds.** `agent`: Task, Agent. `edit`: Edit, Write, MultiEdit, NotebookEdit. `bash`: Bash, BashOutput, KillShell, KillBash. `decide`: AskUserQuestion, ExitPlanMode, EnterPlanMode. `read`: every other tool, MCP included. `prompt`: a main-file user record that `parseChatRecord` returns as a user message with non-empty text (it already drops noise and strips `<system-reminder>`).
6. **`at` is always a string.** It is the record's ISO timestamp, or the previous step's `at` when the record has none (`''` for the first).
7. **`task` is the subject text** of the task `in_progress` when the step landed, not an id, so the fact renders without a client lookup. It is read through the existing `server/lib/tasks.ts` fold (Task 2).
8. **Turn label** is derived on the client from the turn's prompt step (`detail`, first line, 48 chars). It is not a contract field.
9. **Response cap.** A full response carries the newest 500 steps (`TRACE_STEP_CAP`) plus `dropped` (how many older steps were left out). Causes that point at a step the client doesn't have are not drawn. There is no "load older" in v1.
10. **`why` rules** (all 8, user's pick), in this order, deduplicated by id (the first rel wins):
    - `retry`: the previous non-prompt step in the same scope had `status === 'error'` when this one landed.
    - `verifies`: a bash step whose command matches `TEST_RE` links to every edit step in the same scope since the previous `TEST_RE` step, newest 8.
    - `commits`: a bash step whose command matches `/\bgit\s+commit\b/` links to every edit step in any scope since the previous commit step, newest 12.
    - `informed`: for a step with a file F, (a) the nearest earlier read-kind step in the same scope with the same file, and (b) the nearest earlier resolved read- or agent-kind step (same scope, or an agent step when this one is in main) whose result text contains F's absolute path or its cwd-relative path, if that step differs from (a).
    - `plan`: a step with a file F, when the newest approved `ExitPlanMode` (main scope) has plan text containing F's cwd-relative path or its basename (only when the basename contains a `.`).
    - `answer`: main scope. The nearest earlier `decide` step in the same turn that resolved with status `ok` links every later step of that turn.
    - `delegated`: subagent scope, only when none of the above fired. Links to the step's Task step.
    - `asked`: main scope, only when none of the above fired. Links to the turn's prompt step, if the turn has one.
    - `TEST_RE = /\b(test|tests|typecheck|tsc|vitest|jest|pytest|playwright|lint|eslint|mypy|ruff)\b|\bcargo\s+(test|check|clippy)\b|\bgo\s+(test|vet)\b/`
11. **Intent.** `input.description`, when it is a non-empty string, gives `intentFrom: 'description'`. Otherwise the assistant text since the previous tool_use in the same scope, applied to every tool_use that shares that text's `message.id`, gives `intentFrom: 'text'`. It is trimmed to the first sentence (up to the first `. `, `.\n` or newline) and capped at 160 chars. Otherwise `null`.
12. **Thinking.** The thinking blocks since the previous tool_use in the same scope attach to the tool_uses that follow them in the same `message.id`. `'text'` if any block has non-empty `thinking` text (`thinkingText` is the joined text, capped at 1200), `'signature'` if they carry only a signature, else `null`. The response's `thinking.recorded` / `readable` count every thinking block ingested, each block once.
13. **Result.** Flatten `tool_result.content` (a string, or an array of `text` blocks; an image block reads `[image]`). A Read that resolves `ok` reads `"<n> lines"` (`n` = non-empty lines). Any other result is its first non-empty line with `<tool_use_error>` tags stripped, capped at 160 chars. The full text (capped at 16 KB) is kept server-side only, for read- and agent-kind steps, for the `informed` rule.
14. **Answer / sha.** AskUserQuestion: the `"<question>"="<answer>"` pairs in the result text, answers joined with ` · `. ExitPlanMode: `'approved'` when it resolves ok, `'rejected'` (status `error`) when it resolves as an error. sha: a bash step matching the commit regex whose result matches `/\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/` takes the first 7 hex characters.
15. **Tool label.** `tool` is the tool name. For an agent step it is `"<name> · <subagent_type>"` when `subagent_type` is set. `detail` is `describeTool(block)`; for an agent step it is `input.description` when present. A prompt step has `tool: 'Prompt'`, `id` = record uuid and `detail` = prompt text capped at 300.
16. **Chat → Trace link.** `ChatToolCall` gains `id` (the tool_use id). Every chat tool line with an id gets a `why?` button that switches the modal to Trace with that step picked. View mode is not persisted: the modal always opens in Chat.
17. **Trace polls only while Trace is showing.** Same `refreshMs` as the chat.

## Review Focus

1. **A transcript appended mid-line between polls.** The builder must fold only complete lines and resume at the partial line's start, the same rule `chat.ts` and `tasks.ts` follow. Test in Task 5.
2. **The transcript is replaced or shrinks** (new epoch). The client must replace its steps, not merge stale ids into a new trace. Tests in Task 5 (server `reset`) and Task 6 (client merge on `reset`).
3. **A session with no tool calls yet** (prompt only), or an unknown or malformed id. The spine shows the prompt row, and the endpoint answers 400/404 with `error: true` the way chat does. Tests in Task 5.
4. **A picked step that scrolls out of the delivered set or is filtered out.** The picked row stays visible even when the filter excludes it (mock `trPasses(s) || s.id === S.sel`). Causes to missing steps are dropped, never thrown. Tests in Task 6 (`causesOf` over a missing id).
5. **A subagent file whose meta sidecar appears after the first poll.** It must be picked up on a later pass without re-folding already-read bytes. Test in Task 5.

---

### Task 1: Trace contract and the chat tool id

**Files:**
- Modify: `shared/types.ts` (next to `ChatToolCall` / `SessionChat`, ~line 849)
- Modify: `server/lib/chat.ts` (`parseChatRecord`, ~line 136, where `describeTool` is called)
- Test: `test/chat.test.ts`

**Interfaces:**
- Produces (shared/types.ts, exact):
```ts
export type TraceKind = 'prompt' | 'decide' | 'read' | 'edit' | 'bash' | 'agent';
export type TraceRel = 'asked' | 'answer' | 'plan' | 'informed' | 'verifies' | 'retry' | 'delegated' | 'commits';
export interface TraceWhy { id: string; rel: TraceRel }
export interface TraceStep {
  id: string; turn: number; kind: TraceKind; tool: string; detail: string;
  intent: string | null; intentFrom: 'description' | 'text' | null;
  at: string; status: 'running' | 'ok' | 'error' | null; result: string | null;
  answer?: string; sha?: string; agent?: string; task?: string;
  why: TraceWhy[]; thinking: 'text' | 'signature' | null; thinkingText?: string;
}
export interface SessionTrace {
  id: string; steps: TraceStep[]; cursor: number; epoch: string;
  thinking: { recorded: number; readable: number };
  dropped: number; reset?: boolean; error?: boolean;
}
```
  Each field carries a one-line doc comment taken from the mock's contract comment and the Decisions above.
- Produces: `ChatToolCall.id?: string`, the tool_use id.

- [ ] **Step 1: Failing test** in `test/chat.test.ts`. An assistant record with a `tool_use` block `{ id: 'toolu_x', name: 'Read', input: { file_path: '/r/a.ts' } }` parses to a message whose `tools[0].id === 'toolu_x'`.
- [ ] **Step 2:** `pnpm test`. Expect FAIL on that case.
- [ ] **Step 3:** Add the types. Set `id` in `parseChatRecord` when `block.id` is a string.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(trace): trace contract and tool ids on chat tool lines`.

### Task 2: Expose the task fold per record

**Files:**
- Modify: `server/lib/tasks.ts`
- Test: `test/tasks.test.ts`

**Interfaces:**
- Produces (exported from `server/lib/tasks.ts`):
  - `export type TaskFold` (the existing `Entry`, renamed or aliased)
  - `export function newTaskFold(): TaskFold`
  - `export function foldTaskRecord(fold: TaskFold, rec: unknown): boolean` folds one parsed record (the object half of today's `foldLine`, after `JSON.parse`) and returns true when it changed tasks or plan state.
  - `export function liveTaskSubject(fold: TaskFold, projectPath: string | null): string | null` returns the subject of the `in_progress` row of `snapshot(fold, projectPath).tasks`, else null.
- `foldLine` keeps its byte-marker prefilter and then calls `foldTaskRecord`. `readSessionTasks` behavior and cache are unchanged.

- [ ] **Step 1: Failing test** in `test/tasks.test.ts`. Fold a `TaskCreate` tool_use, its result (`toolUseResult: { task: { id: '1' } }`), a `TaskUpdate` with `{ taskId: '1', status: 'in_progress' }` and its success result through `foldTaskRecord` on a `newTaskFold()`. Assert `liveTaskSubject(fold, null) === '<the subject>'`, and assert that folding an unrelated assistant text record returns `false`.
- [ ] **Step 2:** `pnpm test`. Expect FAIL (not exported).
- [ ] **Step 3:** Refactor as above. No behavior change for `readSessionTasks`.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS, with every existing tasks/plan-progress case still green.
- [ ] **Step 5:** Commit `refactor(tasks): fold one record at a time for the trace`.

### Task 3: TraceBuilder: steps from records

**Files:**
- Create: `server/lib/trace.ts`
- Test: `test/trace.test.ts` (register in `test/run-all.ts`)

**Interfaces:**
- Consumes: `describeTool` (`server/lib/transcript.ts`), `parseChatRecord` + `DEFAULT_CAPS` (`server/lib/chat.ts`), Task 2's `newTaskFold` / `foldTaskRecord` / `liveTaskSubject`, the Task 1 types.
- Produces:
```ts
export const TRACE_STEP_CAP = 500;
export class TraceBuilder {
  constructor(projectPath: string | null);
  readonly epoch: string;               // random, per instance
  rev: number;                          // bumped once per ingest() that changed anything
  /** Fold records already parsed, in the order given. scope 'main' or the Task step id. */
  ingest(records: { rec: any; scope: string }[]): void;
  /** Steps in `at` order (stable), each with the rev it last changed at. */
  steps(): TraceStep[];
  changedSince(rev: number): TraceStep[];
  thinking(): { recorded: number; readable: number };
}
```
  Internally, each step also keeps `scope`, `file` (absolute, from `input.file_path` / `notebook_path` / `path`, else null), `cwd`, `command` (bash), `planText` (ExitPlanMode `input.plan`), `resultText` (Decision 13) and `rev`. None of these reach the response. The `why` array stays `[]` in this task. Task 4 fills it through one call site: `this.why(draft)` returning `TraceWhy[]`, which in this task is a method that returns `[]`.

Everything about a step's fields follows Decisions 5, 6, 7, 11-15. A tool_result updates the step it names (status, result, answer, sha, resultText) and bumps that step's rev. A turn counter increments per prompt step. `liveTaskSubject` gets the constructor's `projectPath`, or when that is null the newest record `cwd` seen. Recompute the live subject only when `foldTaskRecord` returns true. Subagent-scope steps take the turn of their Task step and set `agent` to its id.

- [ ] **Step 1: Failing tests** in `test/trace.test.ts`. Build records with small helpers (`prompt(uuid, text, ts)`, `use(id, name, input, ts, msgId, scope?)`, `result(id, content, isError?, toolUseResult?)`, `text(t, msgId)`, `thinking(t | null, msgId)`). Cases, one assertion group each:
  - `prompt + Read use`: two steps; the prompt has `kind 'prompt'`, `tool 'Prompt'`, `status null`, `turn 1`; the Read has `kind 'read'`, `status 'running'`, `result null`.
  - Read result with 3 numbered non-empty lines → `status 'ok'`, `result '3 lines'`.
  - Bash `{ command: 'pnpm typecheck', description: 'Typecheck' }` with `is_error: true` and content `'<tool_use_error>x.ts(1,1): boom</tool_use_error>'` → `intent 'Typecheck'`, `intentFrom 'description'`, `status 'error'`, `result 'x.ts(1,1): boom'`.
  - text `'Read the doc first. Then edit.'` + Read use sharing msgId → `intent 'Read the doc first'`, `intentFrom 'text'`.
  - thinking with text + use → `thinking 'text'`, `thinkingText` set; thinking signature-only → `'signature'`; `thinking()` → `{ recorded: 2, readable: 1 }`.
  - AskUserQuestion resolved with content `'User has answered your questions: "Which view?"="Triage", "Persist?"="The view". You can now continue'` → `answer 'Triage · The view'`, `kind 'decide'`.
  - ExitPlanMode ok → `answer 'approved'`; error → `status 'error'`, `answer 'rejected'`.
  - Bash `git commit -m x` resolved with `'[main 5d21e08] x\n 3 files changed'` → `sha '5d21e08'`, `kind 'bash'`.
  - Agent use `{ subagent_type: 'cavecrew-investigator', description: 'map toolbar' }` → `kind 'agent'`, `tool 'Agent · cavecrew-investigator'`, `detail 'map toolbar'`; a Read in scope `<that id>` → `agent === <that id>`, same `turn`.
  - TaskCreate + TaskUpdate in_progress (with results), then an Edit → Edit's `task` is the subject.
  - Second prompt → later steps have `turn 2`.
  - `changedSince(r)` after a second ingest of only a result returns exactly the resolved step.
  - A use record with no timestamp takes the previous step's `at`.
- [ ] **Step 2:** `pnpm test`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement `server/lib/trace.ts`.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(trace): fold a transcript into trace steps`.

### Task 4: The eight why rules

**Files:**
- Create: `server/lib/trace-why.ts`
- Modify: `server/lib/trace.ts` (the single `why(draft)` call site from Task 3)
- Test: `test/trace-why.test.ts` (register in `test/run-all.ts`)

**Interfaces:**
- Consumes: Task 3's internal step record. Export it from `trace.ts` as `export interface StepRecord` (TraceStep plus the internal fields listed in Task 3) if it isn't exported yet.
- Produces: `export function inferWhy(step: StepRecord, earlier: readonly StepRecord[], turnPrompt: StepRecord | null): TraceWhy[]`. `earlier` is every step folded before this one, in fold order. `export const TEST_RE`.

Rules, order, caps and dedup are exactly Decision 10. Results and statuses are read as they stand when the step lands (`earlier`'s current state). Rules never look forward.

- [ ] **Step 1: Failing tests**, one per rule, through `TraceBuilder.ingest` (so they also prove the wiring), plus two order/dedup cases:
  - `asked`: prompt → Read (no other cause) → `why = [{ id: <prompt uuid>, rel: 'asked' }]`.
  - `informed (a)`: Read /r/a.ts → Edit /r/a.ts → Edit's why contains `{ id: read, rel: 'informed' }`.
  - `informed (b)`: Grep resolved with content `'/r/b.ts:3: x'` → Read /r/b.ts → `informed` → Grep.
  - `retry`: Bash resolves error → Edit → `{ id: bash, rel: 'retry' }` first.
  - `verifies`: Edit e1, Edit e2, Bash `pnpm test` → why contains e2 and e1 as `verifies` (newest first). A second `pnpm test` after one more edit e3 links only e3.
  - `commits`: e1, Bash `git commit -m a`, e2, e3, Bash `git commit -m b` → second commit links e3, e2 (not e1).
  - `plan`: ExitPlanMode `{ plan: 'Touch client/src/x.tsx' }` resolves ok (cwd `/r`) → Edit `/r/client/src/x.tsx` → contains `{ rel: 'plan' }`.
  - `answer`: AskUserQuestion resolved ok → Read in same turn → `{ rel: 'answer' }`, and no `asked`. A Read after the next prompt has no `answer`.
  - `delegated`: Agent step A → in scope A a Bash with no other cause → `[{ id: A, rel: 'delegated' }]`.
  - dedup: Read r1 of /r/a.ts whose result contains `/r/a.ts`, then Edit /r/a.ts → `informed` → r1 appears once.
- [ ] **Step 2:** `pnpm test`. Expect FAIL.
- [ ] **Step 3:** Implement `inferWhy` and wire it in.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(trace): infer each step's causes`.

### Task 5: Reading files, the cache, and the endpoint

**Files:**
- Modify: `server/lib/trace.ts` (add the file reader and cache)
- Modify: `server/api.ts` (add `serveSessionTrace` next to `serveSessionChat`)
- Modify: `server/index.ts` (route above the detail regex, beside the chat route)
- Test: `test/trace.test.ts` (reader cases), `test/api-read-endpoints.test.ts` (route cases)

**Interfaces:**
- Consumes: `TraceBuilder`, `SUBAGENT_DIR` (`server/lib/subagent-usage.ts`), `findTranscript` / `projectsRoot` / `ID_RE` as `serveSessionChat` uses them.
- Produces:
  - `export function readTrace(file: string, projectPath: string | null, after?: { rev: number; epoch: string }): Omit<SessionTrace, 'id'> | null`. It gets or creates the cached builder (Decision 2), advances it (Decisions 3 and 4, complete lines only, a per-file byte offset), then answers. With no `after`: the newest `TRACE_STEP_CAP` steps and `dropped`. With a matching `after`: `changedSince(after.rev)` and `dropped: 0`. When the epoch doesn't match or `after.rev > rev`: the full answer plus `reset: true`. It returns null when the main file is unreadable.
  - `export function resetTraceCache(): void` (for tests).
  - Route: `GET /api/sessions/:id/trace[?after=<int>&epoch=<str>]`, regex `/^\/api\/sessions\/([^/?]+)\/trace(?:[?#]|$)/`. A bad id gives 400; a non-integer or negative `after`, or `after` without `epoch`, gives 400; an unknown session gives 404; a throw gives 500. Every failure body is `{ id, steps: [], cursor: 0, epoch: '', thinking: { recorded: 0, readable: 0 }, dropped: 0, error: true }` with `Cache-Control: no-store`, the same shape as chat's `fail`. `projectPath` comes from the record `cwd` the builder sees (pass `null`; the builder reads cwd off records).

- [ ] **Step 1: Failing tests.**
  - Reader (tmpdir JSONL fixtures, `resetTraceCache()` per case):
    - full read gives steps, `cursor === 1`, a non-empty `epoch`.
    - appending a result and calling with `{ rev: 1, epoch }` returns only that step, `cursor 2`.
    - a file ending mid-line folds only complete lines, and the next call after the line completes picks it up exactly once.
    - truncating the file (shorter) gives a new epoch, and `{ rev, oldEpoch }` gets `reset: true`.
    - a subagent dir `<main>/subagents/agent-a1.jsonl` without meta is skipped; once `agent-a1.meta.json` `{ toolUseId: <Agent step id> }` appears, the next pass adds its steps with `agent` set, and earlier main steps are not duplicated.
    - a prompt-only transcript gives one prompt step.
    - 520 steps give 500 steps and `dropped: 20` on a full read.
  - Route (`test/api-harness.ts`): `/api/sessions/<known>/trace` returns 200 with steps; `/api/sessions/<known>/trace?after=x` returns 400; `?after=1` with no epoch returns 400; an unknown id returns 404 with `error: true`; the trace path is not swallowed by the detail route (mirror the chat route-order test at `:163`).
- [ ] **Step 2:** `pnpm test`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): GET /api/sessions/:id/trace`.

### Task 6: Client trace logic and the polling hook

**Files:**
- Create: `client/src/lib/trace.ts`
- Create: `client/src/hooks/useSessionTrace.ts`
- Test: `test/client-trace.test.ts` (register in `test/run-all.ts`; follow how `test/chat-filter.test.ts` imports client lib code)

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`client/src/lib/trace.ts`):
  - `export type TraceFilter = 'all' | 'edits' | 'fails' | 'you'`
  - `export const TRACE_FILTERS: { key: TraceFilter; label: string }[]`: All, Edits, Fails, You.
  - `export const REL_LABEL: Record<TraceRel, string>` and `export const REL_FWD_LABEL: Record<TraceRel, string>`, copied verbatim from the mock's `REL` / `REL_FWD`.
  - `export function mergeTrace(prev: TraceStep[], incoming: TraceStep[], reset: boolean): TraceStep[]`. A reset returns `incoming`. Otherwise it replaces by id in place, appends new ids, then stable-sorts by `at`.
  - `export function causesOf(steps: TraceStep[], id: string): Map<string, { d: number; rel: TraceRel; from: string }>`. Breadth-first over `why`, nearest first, only over ids present in `steps` (the mock's `causes`).
  - `export function ledTo(steps: TraceStep[], id: string): TraceStep[]`
  - `export function passesFilter(s: TraceStep, f: TraceFilter): boolean`. Mock `trPasses`: a prompt always passes, `edits` → kind edit, `fails` → status error, `you` → kind decide.
  - `export function turnLabel(steps: TraceStep[], turn: number): string` (Decision 8).
- Produces (`client/src/hooks/useSessionTrace.ts`): `useSessionTrace(id: string, enabled: boolean, refreshMs: number): { steps: TraceStep[]; thinking: { recorded: number; readable: number }; dropped: number; loading: boolean; error: boolean }`. A full fetch when enabled turns true, then polls `?after=<cursor>&epoch=<epoch>` every `refreshMs` while enabled, merging with `mergeTrace`. Raw `fetch` with try/catch, the way `useSessionChat` does it. Stop the timer when disabled or unmounted.

- [ ] **Step 1: Failing tests** for every lib function: merge upsert keeps order and sorts a late `at` into place; `reset` replaces; `causesOf` gives a 2-hop chain with `d` 1 and 2, nearest first, and skips a why id not in `steps` without throwing; `ledTo`; `passesFilter` for each filter including that a prompt passes `fails`; `turnLabel` truncation at 48 chars and `''` for a turn with no prompt.
- [ ] **Step 2:** `pnpm test`. Expect FAIL.
- [ ] **Step 3:** Implement both files.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `feat(trace): client trace merge, causes and polling hook`.

### Task 7: Trace mode: head switch, spine and foot

**Files:**
- Create: `client/src/components/TraceSpine.tsx`
- Modify: `client/src/components/ChatDrawer.tsx`
- Modify: `client/src/styles.css` (the Trace block: the mock's `.tr-*` rules from ~1941-2015 plus `.chat-foot .tr-tog`)

**Interfaces:**
- Consumes: Task 6 lib + hook.
- Produces: `export function TraceSpine(props: { steps: TraceStep[]; sel: string | null; filter: TraceFilter; focus: boolean; follow: boolean; onPick(id: string): void; onFollow(): void }): JSX.Element`. It renders the mock's `traceBody()` as React: `.chat-body.tr-body`, `.tr-spine` with `tr-focus` / `tr-dim`, turn headers (`Turn N` + label), one `.tr-row` per passing step (the picked step always renders), and the `↓ Follow live` jump button shown when `follow` is false. Row classes, flags and result text follow the mock exactly. `tr-fresh` goes on steps that arrived in the latest poll. The arcs SVG is in Task 8; leave `<svg className="tr-arcs" aria-hidden />` in place, empty.
- ChatDrawer state: `view: 'chat' | 'trace'` (default `'chat'`, not persisted), `sel: string | null`, `traceFilter: TraceFilter` (default `'all'`), `focus: boolean`, `follow: boolean` (default true). While `follow` is on, `sel` tracks the newest step and the body scrolls to the tail when steps arrive. Picking a row sets `follow = false`. Enter/Space on a focused row picks it.
- Head: `.seg` with `role="tablist"`, `aria-label="View"`, buttons `Chat` / `Trace` (`role="tab"`, `aria-selected`), before the spacer.
- Foot in trace view: live text as in chat; count `"<n> steps · <m> running · thinking readable in <r> of <t>"` (n excludes prompts), with ` · <dropped> older not loaded` appended when `dropped > 0`; button `.tr-tog` "Only this step's why" (`aria-pressed`); `.seg` `aria-label="Step filter"` with the four filters.
- The chat body, sidecar and wait panels are unchanged in chat view. In trace view the pinned panels stay where they are.

- [ ] **Step 1:** Implement. Port the CSS under the Global Constraints token rule.
- [ ] **Step 2:** `pnpm typecheck && pnpm test`. Expect PASS.
- [ ] **Step 3:** Verify in the browser: `pnpm dev` through the preview tools (`.claude/launch.json`), open a session's chat, switch to Trace. Rows render, filters narrow, the jump button appears after picking and restores follow. No console errors. Check light (Daylight) and one dark theme. Screenshot it.
- [ ] **Step 4:** Commit `feat(chat): Trace mode spine, switch and step filter`.

### Task 8: Step inspector, cause arcs, and "why?" from chat

**Files:**
- Create: `client/src/components/TraceInspector.tsx`
- Modify: `client/src/components/TraceSpine.tsx` (arcs)
- Modify: `client/src/components/ChatDrawer.tsx` (the sidecar in trace view, `why?` on tool lines)
- Modify: `client/src/styles.css` (the mock's `.tr-one` / `.tr-*` sidecar rules ~2016-2044, `.cmsg-why` from `.cm-why`)

**Interfaces:**
- Consumes: Task 6 lib, Task 7 state.
- Produces: `export function TraceInspector(props: { steps: TraceStep[]; sel: string | null; questionPending: boolean; onPick(id: string): void }): JSX.Element`. It renders the mock's `inspector()` card and facts, after the existing Context card. Extract the Context `.kv` from ChatDrawer into a small local component so both views share it. With no picked step, or one not in `steps`: the empty card `Pick a step to see why it happened.`. Otherwise:
  - The `.kv.tasks-kv.tr-one.tr-k-<kind>` card. Head: tool + `N cause` / `N causes`. Then the title, the intent and the outcome line, with exact mock copy: `Waiting for your answer — it is in the panel below` when the decide step is running and `questionPending`, `Waiting for your answer` when it is running otherwise, `Waiting for its tool_result…`, `✕ <result>`, `You answered <b>…</b>`, `✓ <result>[ · sha]`. Then the Thinking block when readable, then the `Why` list from `causesOf` (sorted by `d`, then step order; `near` when d = 1; labels from `REL_LABEL`) or `A prompt is where a turn starts; nothing comes before it.`, then `Led to` from `ledTo` with `REL_FWD_LABEL`. Row detail is cut at 64 chars with `…`. Each row is a button that calls `onPick`.
  - `.chat-facts`: Status (`prompt` / `waiting on you` / `running` / `failed` / `ok`), Turn (`<n> · <turnLabel>`), At (local `HH:MM:SS`), Plan task (`task` or `—`), Intent from (`call description` / `Claude's text` / `—`), Thinking (`readable` / `signature only` / `none`, with the mock's title on `signature only`).
- Arcs: port the mock's `drawArcs()` into a `useLayoutEffect` in `TraceSpine`. It draws the same-turn spine segments between main-scope dots, the subagent curves in `var(--magenta)`, and the cause arcs for `sel` (solid at d = 1, dashed further back, colored with the row's `--c`). Redraw on steps, sel, filter or focus change and on resize (`ResizeObserver` on the spine). Arcs read token colors through `var(...)` or computed `--c`, never literals.
- Chat tool lines: when `t.id` is set, append `<button className="cmsg-why" title="Open this step in Trace">why?</button>`. A click sets `view = 'trace'`, `sel = t.id` and `follow = false`.
- `questionPending` is true when the drawer's `question` state has a pending question (use what `QuestionPanel` keys its render on).

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm typecheck && pnpm test`. Expect PASS.
- [ ] **Step 3:** Verify in the browser as in Task 7. Pick a step: its causes highlight and the arcs draw. Picking a Why row moves the selection. `why?` on a chat tool line lands on that step. Check phone width (375) too: the layout must not scroll horizontally. Screenshot it.
- [ ] **Step 4:** Commit `feat(chat): Trace step inspector, cause arcs and why? links`.

### Task 9: Visual fixture, screenshots and docs

**Files:**
- Create: `test/visual/fixtures/session-trace.ts`, the mock's `TRACE` fixture typed as `SessionTrace` (absolute ISO `at`s, `task` as subject text), with the session-chat fixture's tool lines given matching ids.
- Modify: `test/visual/fixtures/index.ts`, `test/visual/mock-api.ts` (answer `/api/sessions/:id/trace`), `test/visual/views.spec.ts` (Trace shots at 375 and 1280 with a step picked)
- Create: `docs/subsystems/trace.md` (the contract, the Decisions in short, the why rules, the cache and cursor, the dated thinking-text figure)
- Modify: `docs/overview.md` §Map (one line for trace.md, plus the file-map lines for the new files), `docs/subsystems/chat.md` (Trace mode, and the tool-line `id` / `why?`)

- [ ] **Step 1:** Add the fixture, mock route and specs.
- [ ] **Step 2:** `pnpm build && pnpm test:visual --update-snapshots`, then `pnpm test:visual`. Expect PASS. List which existing baselines changed: the chat head's new switch legitimately changes the chat drawer shots. Any other changed baseline is a regression to fix, not re-baseline.
- [ ] **Step 3:** Write the docs.
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Expect PASS.
- [ ] **Step 5:** Commit `test(visual): Trace shots; docs: trace subsystem`.
