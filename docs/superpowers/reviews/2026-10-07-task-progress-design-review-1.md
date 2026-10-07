# Review 1 — `docs/superpowers/specs/2026-10-07-task-progress-design.md`

Reviewer: Fable 5.1 subagent, read-only, 2026-10-07. Every claim below was checked against the code or against this machine's transcripts
(`~/.claude/projects/*/*.jsonl`, 1909 main transcripts + 1887 subagent files at review time) with a measurement script in the session scratchpad.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. Eight Important ones: three false statements about the code or the docs (a layout that does not go through
`Tags`, a fourth `Session` literal, a wrong `chat.md` section), one stale cost figure (23 MB transcripts, not 5.8), and four places the implementer has to
guess (lines longer than a chunk, a read error mid-fold, a status-less `TaskUpdate`, how one DOM is both "always shown" and "folded by default").

## Measurements that back the findings

| Spec says | Measured 2026-10-07 |
| --------- | ------------------- |
| 61 transcripts, 443 creates, 837 updates (l.45) | 63 / 445 calls (443 confirmed by a `task.id` result) / 838 — the spec's numbers are the morning's, fine |
| `activeForm` absent on ~3% (431 of 443) (l.34) | present on 431, **absent on 14** of 445 calls (3.1%) |
| 7 pending calls at EOF (l.72) | 7, all `TaskUpdate`; 0 `TaskCreate` |
| `TaskUpdate` result line never contains `Task` (l.54) | 830 of 831; the one exception is the `InputValidationError` line, which contains "TaskUpdate failed" |
| one `InputValidationError` (l.24) | 1 `TaskUpdate` (`is_error`) **plus 2 `TaskCreate`** whose `toolUseResult` is the error string |
| `TodoWrite` used in 1 transcript (l.25) | 0 files carry a `"name":"TodoWrite"` tool_use (recursive); 15 mention the word in text |
| largest transcript 5.8 MB (l.75) | **23,023,739 bytes** |
| lines all shorter than the 1 MB chunk (implied, l.64) | **11 lines > 1 MB in 8 transcripts, longest 1,355,625 bytes** |
| `~/.claude/tasks` absent (l.20) | absent |
| first `TaskCreate` below the 256 KB tail window (l.21) | 63 of 63 files |
| create ids ascend in result order (l.35) | 0 inversions |
| `statusChange.to` always equals `input.status` | 0 mismatches over 828 results; `deleted` → `statusChange.to === 'deleted'` in all 5 |
| status-less `TaskUpdate` | **3** calls with no `input.status` |
| updates to an unknown `taskId` | 1 |

## Important

- **I1 — doc:137 — `Tags` is not every layout.** `client/src/components/sessions/ListView.tsx:5-7,56-57` imports `surfacePill` and renders the surface
  and kaizen `ag-pill`s itself; it never renders `<Tags>` (codegraph lists `Tags` callers as Board/Split/Tiles/Triage only, and `SessionsView.tsx:126`
  draws `ListView` for `drawn === 'list'`). As written the list layout gets no pill. → Either name `ListView.tsx:56` as a second insertion site, or move
  the two existing pills plus the new one into a shared atom and have both render it.
- **I2 — doc:96 — the `Session` literal list is incomplete.** `test/filter-sort.test.ts:34-57` has a typed `sess(p: Partial<Session>): Session`
  factory (ends in `kaizenLesson: p.kaizenLesson ?? null`). The sentence says "today that is" three files. → Add `test/filter-sort.test.ts`; keep the
  `pnpm typecheck` hedge.
- **I3 — doc:128 and doc:176 — wrong `chat.md` section.** `docs/subsystems/chat.md:191-224` "§The pinned panels' own shapes" describes
  `QuestionPanel` / `PlanPanel` / the wait panels, not the sidecar. The sidecar-becomes-a-band shape lives in the intro paragraph at `chat.md:10-19`
  ("Below `md` the sidecar becomes a band over the transcript…"), under no heading; the card content belongs in §What's shown (`chat.md:66`). → Point
  §4.2 at `chat.md:10-19` (or DESIGN.md §8.6, `.claude/DESIGN.md:383`) and §6 at the intro + §What's shown.
- **I4 — doc:75 — the cost figure is stale by 4×.** The 5.8 MB in `server/lib/record-cache.ts:11` is a comment from an earlier day; the largest main
  transcript today is 23.0 MB, and `scanSessions` is synchronous inside the `/api/sessions` handler (`server/api.ts:146`) and the notify path
  (`server/lib/notify.ts:233`). The first poll after a restart folds every shown file in full on the request thread. → Restate the figure with today's
  date, say the first fold is a one-off up to ~23 MB per shown session, and either accept the one slow first response explicitly or cap/spread it.
- **I5 — doc:64 — a line longer than one chunk is unspecified.** "Chunks of at most 1 MB" plus "a trailing line with no newline is left unread"
  reads naturally as per-chunk; 8 transcripts here hold records of 1.0–1.36 MB (the base64 tool_results `server/lib/chat.ts:38` already notes). An
  implementation that drops each chunk's partial tail stalls on such a line forever — `offset` never passes it, the list freezes, no error. Test 12
  (multibyte split) nudges toward carrying bytes across chunks but never exercises a > 1 MB line. → State that the undecoded partial tail of a chunk is
  prepended to the next chunk and only the **file's** final partial line is left unread; add a test with a 1.2 MB single-line record followed by a
  create.
- **I6 — doc:62 — read failure is not covered.** Step 1 covers a missing file and a shrunk one; nothing says what `readSessionTasks` does when `stat` or
  `readSync` throws for another reason (EACCES, EBUSY during rotation). `record-cache.ts:173-174` keeps the remembered value; an exception here
  propagates out of `scanSessions` and fails the whole sessions response. → Add: any I/O error → return the remembered list (or null), leave `offset`
  unchanged, never throw.
- **I7 — doc:88 and doc:90 — a status-less `TaskUpdate` is ambiguous.** Three real updates carry no `input.status` (subject/activeForm edits);
  their result has `success: true` and no `statusChange`. The row "success, other status → set `status` (prefer `statusChange.to`, else
  `input.status`)" would set `undefined`; l.90 ("a status outside the three known values is ignored") can be read as rescuing that or not. → Add an
  explicit row: success, no status in result or input → leave `status`, apply the edits; and make test 6 a status-less update.
- **I8 — doc:121 vs doc:132 — one DOM, two default states.** `ChatDrawer` renders one tree for both widths (`client/src/components/ChatDrawer.tsx`
  has no `matchMedia`; the band is CSS at `client/src/styles.css:1854-1862` / `1911-1922`). §4.1 says the list is always shown on desktop; §4.2 says
  it starts folded on the phone with fold as component state. A `folded` state that gates rendering hides the desktop list. → Say how: always render
  the `<ol>`, and let the fold class hide it only under `@media (max-width: 767px)`; or drive the fold from a `matchMedia('(min-width: 768px)')` check.

## Minor

- doc:12 — the "known difference" is not one: the mock's B frame already has `.tasks-kv{flex:1}`, `.task-list{flex:1;overflow:auto}` and sets the facts
  block to `flex:none` (mock `:111-112`, `:275`). Drop the bullet or restate it.
- doc:13 / doc:147 — mock differences not called out: the B band draws a `▾ list` affordance on the folded line (mock `:292`), which §4.2 omits (the tap
  target then has no visible cue); the mock's all-done card has a `✓ All tasks done` line and the none-started card a `Not started` line (mock
  `:317-324`), neither in §4.4.
- doc:34 — the parenthetical gives the *present* count; it should read "absent on 14 of 445 (3%)".
- doc:24 — "seen once": three validation failures exist (1 update, 2 creates with a string `toolUseResult`). §2.3 already handles both; just fix the count.
- doc:25 — 0 transcripts carry a `TodoWrite` tool_use on this machine; the "1" was probably a text mention. Harmless either way.
- doc:3 — "13 tasks is common" is a figure off this machine without a date (CLAUDE.md §Where things go, last bullet).
- doc:76 — "LRU cap of 64": say whether a cache hit refreshes recency, and what eviction does to a file still being shown (it re-folds in full next poll).
- doc:87 — say which field decides `deleted` (`statusChange.to` or `input.status`); they agree in all 5 observed cases, so either is fine, but pick one.
- doc:83 — a second confirmed `TaskCreate` returning an already-known id (never observed) would double the `order` entry under a Map overwrite. One
  clause: ignore or replace.
- doc:147 — `.ag-pill.done` already exists (`client/src/styles.css:737`, `--strip-hi` ground). `class="ag-pill tasks done"` matches it too;
  `.ag-pill.tasks.done` wins on specificity, but name the collision or use `all-done`.
- doc:122 — "on open … once": define the case where `tasks` is null at open and arrives on a later poll (scroll on first non-null, or never).
- doc:145 — the `0/6` pill's colour is unstated (green like "some live", or dimmed?).
- doc:167 — "in the same file or `test/client-tasks.test.ts`": pick one; `run-all.ts` registration (l.152) needs the name.
- doc:177 — `docs/subsystems/sessions.md` has no "mechanism section" (headings at `sessions.md:8,52,150,196,413,444,463`); name the heading.
- doc:58 — `pending` is never pruned; 7 orphans across 63 files today, so a sentence that says "bounded by the file's own unresolved calls" is enough.

## Checked and found correct

D1 (`~/.claude/tasks` absent), D2 (`DEFAULT_TAIL_BYTES = 256 * 1024` at `server/lib/transcript.ts:28`; all first creates sit below the window),
`maxSessions` default 5 (`server/lib/scan.ts:506`), the push-site description of `scanSessions` (`scan.ts:550-657`), the result shapes in §2.1
(`toolUseResult.task.id` string; `success`/`statusChange.from/to`), the 0x0A-before-decode discipline (`chat.ts:12,186-196`), `md` = 768px
(`styles.css:1832,1902`; `ChatDrawer.tsx:83`), the Context card → `.chat-facts` order (`ChatDrawer.tsx:215-234`), the pill copy and `--steel`/`--ink2`
all-done tint against the mock (`:105-109`, `:320`), `pct` 7/13 → 54, the fold-line fallback chain being exhaustive over the three statuses, and the
CLAUDE.md rules the spec touches (types first, zero server deps, no literal colours, run-all registration).
