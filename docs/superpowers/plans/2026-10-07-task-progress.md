# Task Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Override of the writing-plans template, on purpose:** this plan specifies behaviour, signatures and exact test *cases* — never literal code. Handed
> code gets transcribed verbatim, so a bug in the plan becomes a bug in the branch (user's global CLAUDE.md, §Learnings). Where the template asks for a
> code block, read the behaviour list instead and write the code yourself. If the spec and this plan disagree, the spec wins; if you think both are
> wrong, say so in your report rather than guessing.

**Goal:** Show a session's own `TaskCreate` / `TaskUpdate` checklist as a Tasks card in the chat drawer sidecar and a `7/13` pill on the session row.

**Architecture:** A new zero-dep server module folds the whole transcript incrementally (append-only byte offset per file) into `Session.tasks`, which
rides the existing 3s `/api/sessions` poll. One pure client helper derives counts and the running task; the drawer card and the row pill both render from
it. Mobile-first CSS: the card is a band on phones (folded by default) and a flexing column card on desktop.

**Tech Stack:** Node + TypeScript via `tsx` (server, Node built-ins only), React + Vite (client), node-assert tests in `test/` run by `test/run-all.ts`.

**Spec:** `docs/superpowers/specs/2026-10-07-task-progress-design.md` — read it whole before Task 1. Mockups: `docs/superpowers/specs/2026-10-07-task-progress-mockups.html` (variant B + pill with mini bar).

## Global Constraints

- `server/` takes **no new dependencies** — Node built-ins only; no new outbound call (`test/outbound.test.ts` pins the list).
- ESM, server imports use the `.js` suffix; cross-boundary imports are `import type`.
- `shared/types.ts` changes first, then the server producer, then the client consumer.
- **No colour or shadow literal** in `client/src/styles.css` below the theme-token block — tokens only (`--green`, `--ink2`, `--ink3`, `--steel`, …).
- **No `max-width` media query** — `test/breakpoints.test.ts:209-215` fails the suite on one. Phone is the base tier; desktop lives in `@media (min-width:768px)`.
- Keep existing CSS class names stable; new classes: `tasks-kv`, `task-list`, `folded`, `ag-pill tasks`, `all-done`, `mini`, keyframe `task-pulse`.
- Transcript bytes are split on `0x0A` **before** decoding (same discipline as `server/lib/chat.ts`).
- Every new figure measured off this machine's data carries its date inline (repo CLAUDE.md §Where things go).
- Authored prose and comments wrap at 160 columns; comments say *why* only.
- Test runs stay in the foreground — no background wait loops.

## Review Focus

1. **A 23 MB transcript on first poll** — the one-off full fold runs synchronously in `/api/sessions`; a person opening the dashboard expects the list
   within a normal poll, not a multi-second stall. Owned by Task 2 (timed measurement step, recorded in the PR).
2. **Two tasks `in_progress` at once** (parallel work) — both rows highlighted in the card; the phone line and scroll target use the *first* live one
   in list order, never the newest-updated. Owned by Task 3 (helper cases).
3. **A very long subject or activeForm** (200+ chars, no spaces in a path) — wraps inside the 290px card without widening it; ellipsised on the phone
   line; the row pill is unaffected. Owned by Task 5 (CSS `overflow-wrap:anywhere` + a 200-char fixture in the live check) and Task 3 (helper passes the
   string through untrimmed).
4. **Drawer open before the first task exists** — `tasks` null at open, a list on a later poll: the card appears and scrolls to the running task once;
   subsequent polls never move a list the reader has scrolled. Owned by Task 3 (`scrollTargetId` cases) and Task 5 (the once-guard, live check).
5. **An old session whose list finished days ago** — still shown in the row with a dimmed `13/13 ✓` pill, not a green one that reads as active. Owned
   by Task 3 (`allDone` case) and Task 4 (pill class `all-done`, checked in both a light and a dark theme).

---

### Task 1: Task types + the incremental fold (`server/lib/tasks.ts`)

**Files:**
- Modify: `shared/types.ts` — add `TaskStatus` and `SessionTask` (spec §1). Do **not** touch `Session` yet (Task 2), so typecheck stays green.
- Create: `server/lib/tasks.ts`
- Create: `test/tasks.test.ts`
- Modify: `test/run-all.ts` — import `run` from `./tasks.test.js` and add it to the `failed +=` sequence, matching the existing modules.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `shared/types.ts`: `type TaskStatus = 'pending' | 'in_progress' | 'completed'`; `interface SessionTask { id: string; subject: string; status: TaskStatus; activeForm: string | null }`.
  - `server/lib/tasks.ts`: `readSessionTasks(filePath: string): SessionTask[] | null`; `resetTaskCache(): void`; `taskCacheStats(): { entries: number; bytesRead: number }`
    (`bytesRead` is cumulative since the last reset).

**Behaviour (spec §2 is authoritative; summary only):**
- Per-file entry `{ offset, size, pending, tasks, order }`; LRU of 64 entries, every call refreshes recency.
- `ENOENT` → drop entry, return null. Size shrank → drop entry, re-fold from 0. `size === offset` → return remembered list, read nothing.
- Read `[offset, size)` in ≤ 1 MB chunks; carry each chunk's tail after its last `0x0A` into the next chunk; only the file's final unterminated line is
  deferred (offset stops before it).
- Prefilter before `JSON.parse`: line contains `"TaskCreate"` or `"TaskUpdate"`, or `pending` is non-empty and the line contains one of its ids. Then
  check shape: `tool_use` block with exact `name`; `tool_result` block with exact `tool_use_id`.
- Apply results per spec §2.3 table, including the status-less edit row, duplicate-id replace, `activeForm || null` on create, unknown-id no-op,
  `deleted` removal, unknown status ignored. "New status" = `statusChange.to` else `input.status`.
- Any other `stat`/`open`/`read` error → return remembered list (or null), offset unchanged, never throw.
- Output order = order of confirmed creates (never sort by `id`).

- [ ] **Step 1: Write the failing tests** — `test/tasks.test.ts`, same module shape as `test/filter-sort.test.ts` (`test(name, fn)` helper, exported
  `run(): number` returning the failure count, prints the pass count). Fixtures: write JSONL into `fs.mkdtempSync(path.join(os.tmpdir(), …))`
  (`tmp-root.ts` cleans up). Build records with small local helpers: an assistant record holding a `tool_use` block, and a user record holding a
  `tool_result` block plus a record-level `toolUseResult`. Call `resetTaskCache()` at the start of each case. Exact cases:
  1. 3 creates (ids `"1"`,`"2"`,`"3"`, subjects `A`,`B`,`C`) → update `1` to `in_progress` → update `1` to `completed`. Expect subjects `[A,B,C]`, statuses
     `[completed,pending,pending]`.
  2. A create call with no result line → `null`.
  3. Create `1`; then a `TaskUpdate` to `in_progress` whose result is the string `"InputValidationError: …"` with `is_error: true` and no record-level
     object → task `1` still `pending`.
  4. Create `1`,`2`; delete `1` (`statusChange.to: 'deleted'`) → only `2`. Then delete `2` → `[]` (not null).
  5. Update for `taskId: "9"` (never created), success true → list unchanged, no throw.
  6. Status-less update: `success: true`, `updatedFields: ['subject','activeForm']`, no `statusChange`, input `{ taskId:'1', subject:'A2', activeForm:'Doing A2' }`
     → subject `A2`, activeForm `Doing A2`, status still `pending`.
  7. A user text message whose text contains `"TaskCreate"` and `"TaskUpdate"` (not a `tool_use` block) and nothing else → `null`.
  8. Partial line: create call + its result written **without** the trailing newline → `null`; append `\n` → task present.
  9. Incremental: fold a file with one create; note `bytesRead`; append one update line of length L (bytes incl. newline); call again → `bytesRead` grew
     by exactly L.
  10. Shrink: fold a 3-task file; overwrite the file with a shorter valid 1-task file (subject `Z`) → `[Z]`.
  11. No task records at all (a few plain user/assistant lines) → `null`; second call → `bytesRead` unchanged.
  12. Multibyte: a create whose subject is `Übersicht — ✓ prüfen`, positioned so the 1 MB chunk boundary falls inside that subject (pad with a preceding
      filler line of computed length) → subject decodes exactly.
  13. A single create-result line padded to ~1.2 MB (e.g. a long extra field in `toolUseResult`), followed by a normal update → task created and updated.
  14. Read error: fold once; append an update; `fs.chmodSync(file, 0)` → call returns the earlier list, no throw; `fs.chmodSync(file, 0o644)` → next
      call shows the update. Skip (count as pass with a note) when `process.getuid?.() === 0`.
  Also: `activeForm` empty string on create → `null`; a create with no `activeForm` → `null`.
- [ ] **Step 2: Run to verify they fail** — `pnpm test` → the new module fails (import of `../server/lib/tasks.js` cannot resolve).
- [ ] **Step 3: Implement** `shared/types.ts` additions and `server/lib/tasks.ts` per the behaviour list. Header comment: why a fold and not
  `record-cache.ts` (it finds one newest record; this needs every Task record), and why the chunk tail is carried.
- [ ] **Step 4: Run** `pnpm test` → all pass, case count up by the new cases. Then mutation-prove: (a) delete the `success === true` check → case 3 must
  go red; (b) delete the `tool_use` shape check (trust the prefilter hit) → case 7 must go red; (c) drop the chunk-tail carry → case 13 must go red.
  Restore each. Note the three red results in the task report.
- [ ] **Step 5: `pnpm typecheck`** → clean.
- [ ] **Step 6: Commit** — `feat(tasks): fold TaskCreate/TaskUpdate into a per-session task list`.

### Task 2: Wire `Session.tasks` through the scan

**Files:**
- Modify: `shared/types.ts` — `Session.tasks: SessionTask[] | null` with a JSDoc line (null = no confirmed create; `[]` renders like null).
- Modify: `server/lib/scan.ts` — in the `sessions.push({...})` at ~`:633`, set `tasks: readSessionTasks(c.file)` (only for pushed sessions, after the cap).
- Modify every other `Session` literal so typecheck passes: `test/web-notify.test.ts`, `test/triage.test.ts`, `test/filter-sort.test.ts` (`sess()`),
  `test/visual/fixtures/sessions.ts` — all `tasks: null`. Run `pnpm typecheck` to find any the spec missed and fix those too.
- Modify: `test/scan.test.ts` — one case.

**Interfaces:**
- Consumes: `readSessionTasks` (Task 1), `SessionTask` (Task 1).
- Produces: `Session.tasks: SessionTask[] | null` on every `/api/sessions` row.

- [ ] **Step 1: Failing test** in `test/scan.test.ts`, using that file's existing fixture helpers: a transcript with 2 creates + 1 completed update →
  the scanned session's `tasks` has length 2 with statuses `[completed, pending]`; a second transcript with no task records → `tasks === null`.
- [ ] **Step 2: Run** `pnpm test` → that case fails (`tasks` undefined).
- [ ] **Step 3: Implement** the type field, the scan wiring and the `tasks: null` fixture updates.
- [ ] **Step 4: Run** `pnpm typecheck` and `pnpm test` → clean / all pass.
- [ ] **Step 5: Measure (Review Focus 1)** — from the scratchpad directory (never the repo: `server/lib` writes are cwd-relative), run a one-off `tsx`
  script that imports `readSessionTasks` by absolute path and times the first and second call on the largest transcript
  (`ls -S ~/.claude/projects/*/*.jsonl | head -1`). Record both timings and the file size, dated, in the task report for the PR. If the first call
  exceeds 1.5 s, stop and report — do not optimise unasked.
- [ ] **Step 6: Commit** — `feat(scan): expose Session.tasks`.

### Task 3: Client helper (`client/src/lib/tasks.ts`)

**Files:**
- Create: `client/src/lib/tasks.ts`
- Create: `test/client-tasks.test.ts`; register in `test/run-all.ts`.

**Interfaces:**
- Consumes: `SessionTask` (`import type` from `shared/types`).
- Produces:
  - `taskProgress(tasks: SessionTask[] | null): TaskProgress | null` where
    `TaskProgress = { done: number; total: number; pct: number; live: SessionTask[]; next: SessionTask | null; allDone: boolean }`.
  - `taskLine(p: TaskProgress): { text: string; kind: 'live' | 'next' | 'done' }` — the phone folded line's trailing text (spec §4.2).
  - `scrollTargetId(p: TaskProgress): string | null` — first live id, else first pending id, else null.

- [ ] **Step 1: Failing tests**, exact cases:
  - `taskProgress(null)` → null; `taskProgress([])` → null.
  - 13 tasks, 7 completed, task 8 `in_progress`, 5 pending → `done 7`, `total 13`, `pct 54`, `live` = [task 8], `next` = task 9, `allDone false`.
  - 6 pending, none started → `done 0`, `pct 0`, `live []`, `next` = task 1, `allDone false`.
  - Two `in_progress` (tasks 3 and 5) → `live` = [3, 5] in list order; `taskLine` text = task 3's activeForm; `scrollTargetId` = `"3"` (Review Focus 2).
  - Live task with `activeForm: null` → `taskLine` text = its subject, kind `live`.
  - No live, some pending → `taskLine` = `Next: <first pending subject>`, kind `next`; `scrollTargetId` = first pending id.
  - All 13 completed → `allDone true`, `pct 100`, `taskLine` = `All done`, kind `done`, `scrollTargetId` null (Review Focus 5).
  - A 200-character subject is returned untrimmed by `taskLine` (Review Focus 3 — truncation is CSS's job).
  - `scrollTargetId` on a list whose ids are `"2"`, `"10"` with `"10"` live → `"10"` (no string sort anywhere).
- [ ] **Step 2: Run** `pnpm test` → fails (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` → pass.
- [ ] **Step 5: Commit** — `feat(client): task progress helper`.

### Task 4: Row pill at both sites

**Files:**
- Modify: `client/src/components/sessions/atoms.tsx` — new exported `TaskPill({ s }: { s: Session })`; render it last inside `Tags`, after the kaizen pill.
- Modify: `client/src/components/sessions/ListView.tsx:56-57` — render `<TaskPill s={s} />` after the kaizen pill in the `.name` cell.
- Modify: `client/src/styles.css` — pill rules next to the existing `.ag-pill.*` block (~`:736-743`).

**Interfaces:**
- Consumes: `taskProgress` (Task 3), `Session.tasks` (Task 2).
- Produces: `TaskPill` (used only here).

**Behaviour:** renders nothing when `taskProgress(s.tasks)` is null. Otherwise `<span class="ag-pill tasks">` with text `${done}/${total}` and a
`<span class="mini"><i style={{width: pct%}}/></span>` bar; class `all-done` added when `allDone`, which shows `13/13 ✓` and drops the mini bar.
`aria-label` = `${done} of ${total} tasks done`. No click handler (a click does what a click on the row does). Colours: unfinished = green tint
(`color-mix` of `--green` like `.ag-pill.kaizen`), all-done = `--steel` ground, `--ink2` text. Do not reuse `.ag-pill.done` (`styles.css:737`).

- [ ] **Step 1:** No DOM test harness exists for components; logic is pinned by Task 3. Write the component and CSS.
- [ ] **Step 2: Run** `pnpm typecheck` and `pnpm test` (includes `breakpoints.test.ts` and the theme-literal checks) → pass.
- [ ] **Step 3: Live check** in the preview pane against the dev server: one session with tasks shows the pill in Board **and** List layouts; one
  finished session shows the dimmed `✓` pill — check in daylight and in the default navy theme (Review Focus 5). Screenshot for the PR.
- [ ] **Step 4: Commit** — `feat(sessions): task progress pill on the row`.

### Task 5: Drawer Tasks card + phone fold

**Files:**
- Modify: `client/src/components/ChatDrawer.tsx` — a `TasksCard` (same file or `client/src/components/TasksCard.tsx`, implementer's call) placed
  between the Context `.kv` and `.chat-facts` (`ChatDrawer.tsx:215-234`).
- Modify: `client/src/styles.css` — base-tier rules near the phone `.chat-side` block (`:1848-1870`) and desktop rules inside the existing
  `@media (min-width:768px)` block (`:1902-1920`).

**Interfaces:**
- Consumes: `taskProgress`, `taskLine`, `scrollTargetId` (Task 3); `session.tasks` (Task 2).
- Produces: nothing for later tasks.

**Behaviour (spec §4.1, §4.2, §4.4):**
- Renders nothing when `taskProgress` is null.
- Card `.kv.tasks-kv`: head row `Tasks` · `done / total`; a track with fill at `pct` (fill `--ink3` when `allDone`); a status line — `✓ All tasks done`
  when all done, `Not started` when `done === 0` and no live task, else none on desktop; then `<ol class="task-list">` with one `<li>` per task, class
  `done` / `live` / `todo`, glyph `✓` / pulsing dot / `○`. Subjects wrap (`overflow-wrap:anywhere`), never ellipsised in the list.
- Phone folded line (base tier): `Tasks`, `done/total`, `taskLine(p).text` ellipsised, `▾ list` cue (`▴ list` when unfolded), 4px track. The whole line
  is a button toggling `.folded` on the card (component state, default folded, not persisted). Unfolded list max-height 40vh, scrolls inside.
- CSS per spec §4.2: base tier `.chat-side .tasks-kv.folded .task-list{display:none}`; inside `min-width:768px` the list shows regardless of `.folded`,
  the folded line is hidden, the card is `.chat-side .tasks-kv` with `display:flex; flex-direction:column; flex:1; min-height:0`, the list
  `flex:1; overflow:auto`, the track `.chat-side .tasks-kv .track{height:6px}`. Live dot uses new keyframe `task-pulse` (opacity), disabled under
  `prefers-reduced-motion`.
- Scroll once: a ref remembers whether this drawer instance has scrolled; on the first render where `scrollTargetId` is non-null, scroll that `<li>`
  into view within the list (not the page) and set the ref. Later polls never scroll.

- [ ] **Step 1:** Logic is pinned by Task 3; write the component and CSS.
- [ ] **Step 2: Run** `pnpm typecheck` and `pnpm test` → pass (watch `breakpoints.test.ts`).
- [ ] **Step 3: Live check** in the preview pane:
  - Desktop width: open this session's drawer (or any session with a task list) — card between Context and facts, list fills the column, running task
    in view; scroll the list up, wait two polls (6 s), confirm it did not jump (Review Focus 4).
  - A session whose transcript has no tasks → no card.
  - `resize_window` mobile (375px): folded line shows, tap unfolds, list capped and scrolling; no horizontal page scroll.
  - Long-subject check (Review Focus 3): in a scratch session (or a fixture transcript under a temp `projects` root), create a task with a 200-char
    no-space subject and confirm the 290px column does not widen.
  - Daylight and navy themes. Screenshots of desktop and 375px for the PR. Reset viewport to desktop after.
- [ ] **Step 4: Commit** — `feat(chat): tasks card in the drawer sidecar`.

### Task 6: Docs

**Files:**
- Modify: `docs/subsystems/chat.md` — the Tasks card and its band/fold in the intro's "Two columns inside it" paragraph (`:10-19`) and §What's shown.
- Modify: `docs/subsystems/sessions.md` — §What a session shows: the pill (both render sites) and `Session.tasks`, the fold and why it is whole-file
  (spec D2), with the dated figures.
- Modify: `docs/overview.md` §Map — one line each for `server/lib/tasks.ts` and `client/src/lib/tasks.ts`.

- [ ] **Step 1:** Write the doc changes; new prose wraps at 160; do not reflow untouched lines.
- [ ] **Step 2: Run** `pnpm test` (doc-link checks, if any, run there) → pass.
- [ ] **Step 3: Commit** — `docs: task progress in chat and sessions subsystems`.

## Finish

Whole-branch review, then PR per `.github/pull_request_template.md`: title `feat(chat): task progress in the drawer and on the row`; Verification lists
the `pnpm test` case count and `pnpm typecheck` output verbatim, the Task 2 timings, the mutation-proof results from Task 1, screenshots from Tasks 4–5,
and an **Unproven** row: other Claude Code versions' result shapes; `--resume` into a new file; the visual suite not re-run (fixtures stay `null`).
