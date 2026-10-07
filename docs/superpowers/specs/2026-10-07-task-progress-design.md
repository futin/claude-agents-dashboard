# Task progress — design

A session working through a long task list (13 tasks is common) gives no sign of how far it has got: the row shows the current tool, the chat drawer shows
the transcript, and the sidecar column below the facts is empty. This adds the session's own task list — the one Claude builds with `TaskCreate` and ticks
off with `TaskUpdate` — to two places: a **Tasks card** in the chat drawer's sidecar (count, bar, the full checklist) and a **`7/13` pill** on the session
row. No new endpoint: the list rides the existing 3s sessions poll.

Brainstormed 2026-10-07 in this repo. Mockups: [2026-10-07-task-progress-mockups.html](2026-10-07-task-progress-mockups.html) — the chosen shapes are
**B · Checklist** for the sidecar and **pill with mini bar** for the row; A, C and D (the YAGNI'd timings variant) are drawn there for comparison. Where the
mock and this spec disagree, **this spec wins**. Known differences:

- The mock's B sidecar keeps the facts block under the Tasks card at full size; §4 keeps it, but the list, not the facts, is what flexes.
- The mock's phone band shows the folded line only; §4.2 also defines the unfolded list.
- The mock's example data (task subjects) is invented; it is not this feature's task list.

## Decisions

| #   | Decision |
| --- | -------- |
| D1  | **Source is the transcript, nothing else.** There is no on-disk task store on this machine (`~/.claude/tasks` does not exist, checked 2026-10-07). The list is rebuilt by folding the main transcript's `TaskCreate` / `TaskUpdate` tool calls and their results. |
| D2  | **A whole-file fold, kept incrementally.** `readTranscript` reads only the last 256 KB, and `TaskCreate` records are typically written at a session's start, far below that window. A new module folds the whole file once, remembers the byte offset it reached, and on every later poll reads only the appended bytes. Transcripts are append-only; a file that shrank resets its entry. |
| D3  | **Rides `Session`, no new endpoint.** `Session.tasks` carries the items; the drawer already receives the live `Session` as a prop and the row already renders from it. Payload cost is ~100 bytes a task. |
| D4  | **Server sends items, client derives counts.** The contract carries the list only; `done`, `total`, the running item and "all done" are computed by one pure client helper that both the card and the pill use. One source of truth, no redundant fields to keep consistent. |
| D5  | **A result confirms the call.** A `TaskCreate` becomes a task only when its tool result carries `toolUseResult.task.id`; a `TaskUpdate` applies only when its result is `success: true`. A call that failed validation (seen once, 2026-10-07: a string `InputValidationError` with `is_error`) changes nothing. |
| D6  | **Main transcript only.** Subagent transcripts are not folded, and the legacy `TodoWrite` tool is ignored (1 transcript on this machine uses it, 2026-10-07). |
| D7  | **Nothing when there is nothing.** A session that never created a task gets `tasks: null` and renders no card and no pill — never an empty card. |

## 1. Contract — `shared/types.ts`

New types, added before the server producer per the repo rule:

- `TaskStatus` = `'pending' | 'in_progress' | 'completed'`. `deleted` is not a status the client sees: a deleted task is removed (§2.3).
- `SessionTask` = `{ id: string; subject: string; status: TaskStatus; activeForm: string | null }`. `activeForm` is the present-tense label
  (`"Building the sidecar Tasks panel"`), absent on ~3% of creates (431 of 443, 2026-10-07), hence nullable.
- `Session.tasks: SessionTask[] | null` — creation order (ascending by the order the create results were folded, which is also ascending id). `null`
  when the transcript holds no confirmed `TaskCreate`; an all-deleted list is `[]` and renders like `null` (§4.4).

## 2. Server — `server/lib/tasks.ts`

Zero runtime deps, Node built-ins only. Exports one reader plus test seams, in the same shape as `record-cache.ts`:

- `readSessionTasks(filePath): SessionTask[] | null`
- `resetTaskCache()` and `taskCacheStats(): { entries, bytesRead }` for tests.

### 2.1 The record shapes (measured 2026-10-07 over 61 transcripts, 443 creates, 837 updates)

| Record | Where | Fields used |
| ------ | ----- | ----------- |
| `TaskCreate` call | assistant `message.content[]` block, `type: 'tool_use'`, `name: 'TaskCreate'` | `id` (the tool_use id), `input.subject`, `input.activeForm` |
| `TaskCreate` result | user record whose `message.content[]` holds `type: 'tool_result'` with that `tool_use_id` | record-level `toolUseResult.task.id` (string, `"1"`, `"2"`…) |
| `TaskUpdate` call | assistant `tool_use`, `name: 'TaskUpdate'` | `input.taskId`, `input.status` (`pending` / `in_progress` / `completed` / `deleted`), optional `input.subject`, `input.activeForm` |
| `TaskUpdate` result | user `tool_result` with that `tool_use_id` | `toolUseResult.success === true`; `toolUseResult.statusChange.to` when present |

The result line of a `TaskUpdate` does **not** contain the text `Task` (it reads `"taskId"`, lowercase) — any prefilter has to account for that (§2.2).

### 2.2 The fold

Per file, one cache entry: `{ offset, size, pending: Map<toolUseId, {name, input}>, tasks: Map<id, SessionTask>, order: string[] }`.

On each call:

1. `stat` the file. Missing → drop the entry, return null. `size < entry.size` → the file was rotated or truncated: drop the entry and start from 0.
   `size === entry.offset` → return the remembered list without touching the disk.
2. Read `[offset, size)` in chunks of at most 1 MB, **splitting on `0x0A` before decoding** (same byte discipline as `chat.ts` — a multibyte sequence can
   straddle any chunk boundary). A trailing line with no newline is left unread: `offset` advances only past the last complete line, so the next poll
   picks it up whole.
3. Per line, a cheap substring prefilter decides whether to `JSON.parse` at all. Parse when the line contains `"TaskCreate"` or `"TaskUpdate"` (a call),
   **or** when `pending` is non-empty and the line contains one of its tool_use ids (a result). Everything else is skipped unparsed — most of a
   transcript. A substring hit is not trusted: the record's shape is checked (`tool_use` block with that exact `name`; `tool_result` block with that exact
   `tool_use_id`), so the words appearing in message text (as they do in this very spec's session) change nothing.
4. A call goes into `pending` keyed by its tool_use id. A result pops its pending call and applies it (§2.3). A pending call whose result never arrives
   (7 such at EOF across the 61 transcripts, 2026-10-07 — sessions killed mid-call) simply stays pending and is never applied.
5. Return the tasks in `order`, or null when no create was ever confirmed.

Cost: the first call per file reads it once in full (the largest transcripts here run to 5.8 MB, per `record-cache.ts`); later polls read only what was
appended in the last 3 s. Memory is bounded by an LRU cap of 64 entries — `scan.ts` shows `maxSessions` (default 5) at a time, so the cap only matters
when sessions churn.

### 2.3 Applying a result

| Call | Result | Effect |
| ---- | ------ | ------ |
| `TaskCreate` | `toolUseResult.task.id` is a non-empty string | add `{ id, subject: input.subject, status: 'pending', activeForm: input.activeForm ?? null }`, append id to `order` |
| `TaskCreate` | anything else | nothing |
| `TaskUpdate` | `success !== true` | nothing |
| `TaskUpdate` | success, unknown `taskId` | nothing (a task created before a file split, or by another list — never invented) |
| `TaskUpdate` | success, status `deleted` | remove the task and its `order` entry |
| `TaskUpdate` | success, other status | set `status` (prefer `statusChange.to`, else `input.status`); apply `input.subject` / `input.activeForm` when they are non-empty strings |

A status outside the three known values is ignored, not passed through.

### 2.4 Wiring

`scanSessions` calls `readSessionTasks(c.file)` for each session it actually pushes (after the `maxSessions` cap, not for the over-fetched pool) and sets
`Session.tasks`. No other `readTranscript` caller needs it. The field is required, so every other `Session` literal sets `tasks: null` — today that is
`test/web-notify.test.ts`, `test/triage.test.ts` and `test/visual/fixtures/sessions.ts` (2026-10-07; `pnpm typecheck` lists any others). The visual
fixtures stay `null` on purpose: a populated list would move every Sessions baseline, and the visual suite is macOS-only and on demand.

## 3. Client helper — `client/src/lib/tasks.ts`

One pure function, `taskProgress(tasks: SessionTask[] | null)`, returning `null` for `null` or `[]`, else
`{ done, total, pct, live: SessionTask[], next: SessionTask | null, allDone }`:

- `done` = count of `completed`; `total` = length; `pct` = `Math.round(done / total * 100)`.
- `live` = every `in_progress` task, in order (parallel work can leave several running).
- `next` = the first `pending` task, or null.
- `allDone` = `done === total`.

## 4. Client UI

All colours from theme tokens (no literal below the token block), class names as in the mock. Both components render nothing when `taskProgress` is null.

### 4.1 Drawer sidecar (desktop, ≥ `md`)

In `ChatDrawer`'s `.chat-side`, a `.kv.tasks-kv` card between the Context card and `.chat-facts`:

- Head row: `Tasks` left, `done / total` right.
- A 6px `.track` with `.fill` at `pct`.
- `<ol class="task-list">`, one `<li>` per task, class `done` / `live` / `todo`: a `✓` glyph for done (green, text dimmed to `--ink3`), a pulsing dot for
  live (row tinted, text weight 600), a hollow `○` for pending. The subject wraps; nothing is ellipsised.
- The card flexes to fill the column (`flex: 1; min-height: 0`), the list scrolls inside it, and `.chat-facts` keeps its natural height below.
- On open, the first live task (else the first pending) is scrolled into view **once** — later polls never move the list, so a reader scrolling it is not
  fought.
- The pulse respects `prefers-reduced-motion`.

### 4.2 Phone band (< `md`)

The sidecar is a band there (`docs/subsystems/chat.md` §The pinned panels' own shapes), and the card follows the Context card's band shape:

- Folded (default): one baseline — `Tasks`, `done/total`, then the first live task's `activeForm` (else its subject; else `next`'s subject prefixed
  `Next:`; else `All done`), ellipsised, and a 4px track below.
- Tapping the line unfolds the same `<ol class="task-list">` beneath it, capped at 40% of the viewport height and scrolling inside. Fold state is component
  state, not persisted.

### 4.3 Row pill

In `Tags` (`client/src/components/sessions/atoms.tsx`), so every layout gets it: `<span class="ag-pill tasks">7/13<span class="mini"><i/></span></span>`
after the model pill. Like the other pills it carries no handler. An accessible label reads `7 of 13 tasks done`.

### 4.4 States

| State | Card | Pill |
| ----- | ---- | ---- |
| `tasks` null or `[]` | not rendered | not rendered |
| tasks exist, none started | `0 / 6`, empty bar, list all hollow | `0/6` |
| some live | as drawn in the mock | `7/13` green |
| all completed | bar in `--ink3`, head reads `13 / 13`, folded phone line `All done` | `13/13 ✓`, dimmed (`--steel` ground, `--ink2` text) |
| tasks remain but none live (between tasks, or the session stopped) | as "some live" minus the pulse; phone line shows `Next:` | unchanged |

## 5. Testing

`test/tasks.test.ts` (node-assert, tmpdir JSONL fixtures, registered in `test/run-all.ts`), each fixture built from the shapes in §2.1:

1. create ×3 → update 1 `in_progress` → update 1 `completed`: three tasks in order, statuses `completed`, `pending`, `pending`.
2. A create whose result line is missing: no task.
3. An update whose result is the string `InputValidationError` with `is_error: true`: status unchanged.
4. `deleted`: the task leaves the list; deleting every task returns `[]`.
5. An update to an unknown `taskId`: nothing changes, nothing thrown.
6. `subject` / `activeForm` edits through `TaskUpdate` apply.
7. A message whose text contains `"TaskCreate"` and `"TaskUpdate"` (not a tool_use block): no task.
8. Partial line: write a result line without its newline, read (task absent), append the newline, read again (task present).
9. Incremental: after a first read, append one update; `taskCacheStats().bytesRead` grows by that line's length only.
10. Shrink: truncate the file to a shorter valid transcript; the entry resets and the list reflects the new content.
11. A file with no task records at all: `null`, and a second call reads 0 new bytes.
12. A multibyte subject (`"Übersicht — ✓ prüfen"`) split across the 1 MB chunk boundary decodes intact.

`taskProgress` cases, in the same file or `test/client-tasks.test.ts`: null and `[]` → null; 7 of 13 → `pct` 54; two `in_progress` → both in `live`;
all completed → `allDone`; no live and some pending → `next` is the first pending.

Mutation-check case 3 and case 7: delete the `success` check, then the shape check, and confirm each test goes red.

Then `pnpm typecheck`, `pnpm test`, and a live look in the preview pane at this very session's drawer (desktop and 375px), plus one other session's row.

## 6. Docs

- `docs/subsystems/chat.md` — the Tasks card in §What's shown and its band shape in §The pinned panels' own shapes.
- `docs/subsystems/sessions.md` — the row pill in §What a session shows; `Session.tasks` and the fold in the mechanism section, with D2's reasoning.
- `docs/overview.md` §Map — one line for `server/lib/tasks.ts` and `client/src/lib/tasks.ts`.

## Out of scope

- Per-task timings, durations and an ETA (mock variant D).
- Subagents' own task lists, and `TodoWrite`.
- backlog-orchestrate run items (`task-3`…`task-15`) — a different list with its own board in backlog-manager.
- A task list shared across sessions (`/clear` starts a new transcript, so the drawer shows that transcript's tasks only).
- Notifications on task completion.

## Verification — not proven by this design

- Whether Claude Code writes `TaskCreate` results with the same `toolUseResult.task` shape in every version: measured on this machine's transcripts only
  (v2.1.x, 2026-10-07).
- Whether a `--resume`d session that continues in a new file loses the tasks created in the old one. §2.3 drops updates to unknown ids rather than guess,
  so the worst case is a shorter list, never a wrong one.
