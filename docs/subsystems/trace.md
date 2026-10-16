# Trace — why each tool call happened

The chat modal's second view. **Chat** shows what was said; **Trace** shows what was *done*, one row per user prompt or tool call, each linked back to the
earlier steps that led to it. It answers "why did it read that file?" and "what was that edit for?" without scrolling a transcript. Read-only, like the
rest of the app. Design source: the redesign mock (`docs/guides/mockups/redesign-mock.html`, `const TRACE =` and the Trace pieces under it).

The transcript's own `parentUuid` chain is a straight line, so it says nothing about *why*. The causes here are **inferred** by eight rules over the steps
already folded, which means every link is a hint, not a record. Chat's [drawer](chat.md) hosts it; this doc is the data and the rules.

## What it shows

`Chat | Trace` is a switch in the drawer head, right of the spacer, next to ✕. The modal always opens in Chat (the view is not persisted). The spine is the
transcript column; the sidecar swaps the Tasks card for the **inspector** (the picked step in full); the foot swaps the message filter for the step filter.

- **Spine** (`TraceSpine`): turns as headers (`Turn n` plus a label), a dot and card per step, subagent steps indented under their Task. A step's card is
  tool, detail and flags (`failed`, `waiting on you`, the user's answer, a commit sha, `thinking`), then the model's stated intent, then `→ result`. The
  gutter's SVG draws the turn line, a magenta curve from each subagent step to its Task dot, and the picked step's cause arcs (solid one hop back, dashed
  further). A pick of the user's own, or scrolling away from the tail, stops **following**; `↓ Follow live` returns to the newest step.
- **Inspector** (`TraceInspector`): the picked step's title, intent, outcome, readable thinking, then `Why` (its causes nearest first, each labelled with the
  relation) and `Led to` (the steps whose own causes name it), then the step's facts: Status, Turn, At, Plan task, Intent from, Thinking. On a phone the
  card is capped at 30vh and At / Intent from / Thinking are hidden (`.f.wide`, as Chat's facts).
- **Foot:** `n steps · n running · thinking readable in n of n`, plus `· n older not loaded` when the response was capped; the `Only this step's why` toggle;
  and the filter `All | Edits | Fails | You`. A prompt row always passes a filter, and **the picked row stays visible even when the filter excludes it**.
- **`why?` on Chat's tool lines:** every chat tool line that carries a tool_use id (`ChatToolCall.id`) has a `why?` button that switches to Trace with that
  step picked, not following. A body-bearing tool (`ExitPlanMode`, `AskUserQuestion`) renders as a plan block and has none.

Empty and error copy: `Loading trace…`, `Couldn’t read this session’s trace.`, `No tool calls in this transcript yet.`

## The endpoint

`GET /api/sessions/:id/trace` → `SessionTrace` (`shared/types.ts`), handled by `serveSessionTrace` in `api.ts`, builder in `server/lib/trace.ts`.

- No query → the **full** trace: the newest `TRACE_STEP_CAP` (500) steps and `dropped`, how many older ones were left out. There is no "load older" in v1,
  and a cause that points at a step the client does not hold is simply not drawn.
- `?after=<cursor>&epoch=<epoch>` → the **live tail**: only the steps that changed since that revision (a step changes when it lands and again when its
  result does). Unlike chat, **the cursor is a revision, not a byte offset**: subagent files have their own offsets, so one offset cannot say where the
  trace stands. `epoch` is the builder's identity; a different epoch, or an `after` past the builder's revision, answers with the full trace and
  `reset: true`, and the client **replaces** its steps rather than merging stale ids into a new trace.
- Bad id → 400, unknown id or unreadable file → 404, a thrown read → 500, each with `error: true`. A bad `after` or a missing `epoch` is a 400.
- ⚠️ **Route order:** the match sits above the `:id` detail regex in `index.ts`, which would swallow `/trace`.
- ⚠️ **Path safety:** same as chat. The id is `ID_RE`-checked and resolved through `findTranscript`; the path only ever comes from the scan.

The client polls only while Trace is showing (`useSessionTrace(id, enabled, refreshMs)`), the full response once, then `?after=` at the Settings refresh
rate. `mergeTrace` (`client/src/lib/trace.ts`) replaces by id, appends unseen ids and stable-sorts by `at`.

## The builder and its cache

`TraceBuilder` folds already-parsed transcript records and holds no file state; it stamps each step with the revision it last changed at. `readTrace` is the
file side:

- **Cache:** `Map<transcriptPath, entry>`, an LRU of 8 (`TRACE_CACHE_SIZE`). An entry is a builder plus the byte offset read to in the main file and in each
  linked subagent file. The first open of a transcript parses the whole file once, synchronously (a 9,162-step transcript took 1.5 s, 2026-10-16); after that
  a poll costs the appended bytes.
- **Complete lines only.** A pass reads the complete new lines and stops at the last newline, leaving a partial trailing line for the next pass, the rule
  `chat.ts` and `tasks.ts` follow.
- **Time-ordered ingest.** One pass reads the main file *and every linked subagent file*, stable-sorts the parsed records by `timestamp`, then folds them
  together, so "earlier" in every rule means earlier in time across scopes. A record with no timestamp keeps its file position.
- **Subagents** link through `agent-<id>.meta.json`'s `toolUseId`; a file without that sidecar is skipped and looked at again on the next pass (so a sidecar
  that appears after the first poll is picked up without re-reading bytes already folded). In the main file `isSidechain` records are skipped (they copy the
  subagent files); in a subagent file user text is the dispatch prompt and is not a turn.
- **The file shrank** (main or a subagent file): the entry is replaced, which is a new epoch, and read from the start.

## Fields (the Decisions in short)

- **Kinds.** `agent`: Task, Agent. `edit`: Edit, Write, MultiEdit, NotebookEdit. `bash`: Bash, BashOutput, KillShell, KillBash. `decide`: AskUserQuestion,
  ExitPlanMode, EnterPlanMode. `read`: every other tool, MCP included. `prompt`: a main-file user record `parseChatRecord` keeps as a user message with
  text. CLI plumbing is not a turn: a slash command or skill is (`/<name> <args>`, the `<command-name>` tag looked for anywhere in the plumbing), but a
  lone `<command-message>`, `<local-command-*>`, `<bash-*>`, the interrupt marker, a compaction summary and a `<task-notification>` (a background task
  completing) are not.
- **`at`** is always a string: the record's ISO timestamp, else the previous step's, `''` for the first. **`task`** is the *subject* of the task
  `in_progress` when the step landed, read through the same fold as the Tasks card, so the fact needs no client lookup. Subagent TaskUpdates do not move it.
- **Turn** counts user prompts (0 before the first). A subagent step takes its Task's turn. The turn *label* is derived on the client from the prompt's
  `detail` (first line, 48 chars); it is not a contract field.
- **`tool` / `detail`.** An agent step reads `Task · <subagent_type>` and its detail is `input.description`; otherwise `detail` is `describeTool`, the label
  Chat uses. A prompt is `tool: 'Prompt'`, `id` the record uuid, `detail` the text capped at 300.
- **Intent.** `input.description` when set (`intentFrom: 'description'`), else the assistant text since the previous tool_use in the same scope, applied to
  every tool_use sharing that text's `message.id` (`'text'`), trimmed to the first sentence and 160 chars, else null.
- **Thinking.** The thinking blocks since the previous tool_use in the scope attach to the calls that follow in the same message: `'text'` when any block
  has text (`thinkingText`, joined, capped at 1200), `'signature'` when only a signature was recorded, else null. The response's `thinking.recorded` /
  `readable` count each block once.
- **Result.** A Read that succeeds reads `<n> lines`. Anything else is the first line containing a letter or digit (so a JSON result does not read `[`),
  `<tool_use_error>` tags stripped, capped at 160. The full result text (16 KB) stays server-side, for read- and agent-kind steps, for the `informed` rule.
- **Answer / sha.** AskUserQuestion: the answers from the result's `"<question>"="<answer>"` pairs, joined with ` · ` and capped at 160 with `…`.
  ExitPlanMode: `approved`, or `rejected` when it resolves as an error. A `git commit` Bash step takes the first 7 hex characters of the new commit.

### Thinking is mostly a signature

The transcript records a thinking block's text only sometimes: 86 of 1,306 thinking blocks carried text (60 newest transcripts, 2026-10-16). So the
inspector says when a step's thinking was *recorded but unreadable* (`signature only`) instead of showing nothing, and the foot counts both numbers.

## The `why` rules

`inferWhy` (`server/lib/trace-why.ts`) runs eight rules in this order, deduplicated by id so **the first relation wins**. Each reads only the steps folded
before it, so a result that arrives later never rewrites an earlier step's causes and no rule looks forward.

| Rel | Fires when | Links to |
|---|---|---|
| `retry` | the previous non-prompt step in the same scope ended in `error` | that step |
| `verifies` | a bash step that is a *check* | every edit step in the same scope since the previous check, newest 8 |
| `commits` | a bash step matching `/\bgit\s+commit\b/` | every edit step in any scope since the previous commit, newest 12 |
| `informed` | the step names a file F: (a) the nearest earlier read of F in this scope; (b) the nearest earlier resolved read or agent step (this scope, or an agent step when this one is in main) whose result text contains F's absolute or cwd-relative path | up to two steps |
| `plan` | the step names F and the newest approved `ExitPlanMode` (main scope) has plan text containing F's cwd-relative path, or its basename when that has a `.` | the plan step |
| `answer` | main scope: the nearest earlier `AskUserQuestion` or `ExitPlanMode` in the same turn that resolved `ok` | that step, for every later step of the turn |
| `delegated` | subagent scope, **only when nothing above fired** | the step's Task |
| `asked` | main scope, **only when nothing above fired** | the turn's prompt, if it has one |

A *check* is `TEST_RE` (`test|tests|typecheck|tsc|vitest|jest|pytest|playwright|lint|eslint|mypy|ruff`, `cargo test|check|clippy`, `go test|vet`) matched
against the command with quoted strings removed and tokens containing `/` or `.` dropped, so `foo.test.ts` in a `sed`, `git add test/x.ts` and the word
"tests" in a commit message do not count. A `git commit` is never a check. The cost: an invocation written only as a path (`./run-tests.sh`) does not
count either. `EnterPlanMode` resolves without a user verdict, so it is not an `answer`.

Known limits, accepted for v1: the `informed` scan is O(n²) over the steps (the 1.5 s first open above); path matches have no boundary (`a.ts` is inside
`a.tsx`); a same-size rewrite of the main file is not detected.

## Tests

`test/trace.test.ts` (the builder, the file side, the endpoint's cursor and reset), `test/trace-why.test.ts` (the eight rules), `test/client-trace.test.ts`
(merge, `causesOf`, filter). The picked-step views are pinned by the Playwright shots `sessions-daylight-1280-trace.png` and
`sessions-daylight-375-trace.png` ([visual-tests](visual-tests.md)); the fixture is `test/visual/fixtures/session-trace.ts`, whose tool-line ids the chat
fixture reuses so `why?` has a step to land on.

<!-- docs-sync:
  sources:
    - server/lib/trace.ts
    - server/lib/trace-why.ts
    - server/api.ts
    - client/src/lib/trace.ts
    - client/src/hooks/useSessionTrace.ts
    - client/src/components/TraceSpine.tsx
    - client/src/components/TraceInspector.tsx
    - client/src/components/ChatDrawer.tsx
    - test/visual/fixtures/session-trace.ts
  kind: subsystem
  verified: 00ab0477ab7000418e7548e7de27bf84297cec7b
-->
