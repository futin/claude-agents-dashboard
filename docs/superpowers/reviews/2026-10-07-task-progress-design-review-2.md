# Review 2 — `docs/superpowers/specs/2026-10-07-task-progress-design.md`

Reviewer: Fable 5.1 subagent, read-only, 2026-10-07 (after the revision that addressed review 1). Every claim below was checked against the code or
against this machine's transcripts (`~/.claude/projects/*/*.jsonl`, 1909 main transcripts at review time) with a measurement script in the session
scratchpad (`measure.mjs`).

## Verdict

**REVISE.** One Critical: §4.2's folding mechanism is specified as a rule "inside the below-`md` media query", and the stylesheet is mobile-first with a
test that fails `pnpm test` on any `max-width` query — the cited `styles.css:1854` is the *base* tier, not a query. It is a one-paragraph fix. Two
Important: the read-error test has no seam to drive it, and the pill's position differs between the two insertion sites.

All eight Important findings from review 1 are resolved in this revision (I1 `ListView` site, I2 fourth `Session` literal, I3 `chat.md` sections, I4 the
23 MB figure, I5 lines longer than a chunk, I6 read errors, I7 status-less update, I8 one DOM for both widths — the last one incompletely, see C1).

## Measurements (2026-10-07, afternoon)

| Spec says | Measured |
| --------- | -------- |
| 61 transcripts, 443 creates, 837 updates (l.45) | 63 files with task calls / 445 `TaskCreate` calls, 443 confirmed by a `toolUseResult.task.id` / 838 `TaskUpdate` calls, 831 with a result |
| `activeForm` absent on 14 of 445 (l.34) | 14 of 445 calls — note l.34 counts calls (445) and l.45 counts confirmed creates (443) |
| 3 validation failures (l.24) | 2 `TaskCreate` with a string `toolUseResult` + 1 `TaskUpdate` `is_error` |
| 3 status-less `TaskUpdate` (l.96) | 3 |
| 7 pending at EOF (l.73) | 838 − 831 = 7 |
| `TaskUpdate` result line never contains `Task` (l.54) | 830 of 831; the one `InputValidationError` line does |
| largest main transcript 23.0 MB (l.80) | 23,023,739 bytes |
| `~/.claude/tasks` absent (l.20) | absent |
| `toolUseResult.task` shape | always `{ id, subject }` |
| one result per user record; one `TaskCreate` block per assistant record | 0 records with two task results; 0 records with two `TaskCreate` blocks — the one-call-one-result fold in §2.2 matches the data |

## Critical

- **C1 — doc:140-142 — the fold is specified against a media query that must not exist.** l.140 says "the band is CSS under the `md` query
  (`styles.css:1854`)"; `client/src/styles.css:1854` sits in the **base** tier — the comment at `styles.css:1843-1845` reads "Phone is the base tier
  now; `md` below rebuilds the desktop shape", and the ≥ `md` rebuild is the `@media (min-width:768px)` block at `styles.css:1902-1920`. l.141 then
  says folding "hides it **only inside the below-`md` media query**". There is no below-`md` query in the file (0 `@media … max-width` rules), the
  stylesheet is mobile-first by contract (`docs/subsystems/breakpoints.md:3-5`), and `test/breakpoints.test.ts:209-215` ("every width query is
  min-width") fails `pnpm test` the moment one is added. Built as written, the branch goes red. → Restate the mechanism in the stylesheet's own
  direction: a base-tier rule `.chat-side .tasks-kv.folded .task-list{display:none}` (the phone), and inside the existing `@media (min-width:768px)`
  block at `styles.css:1902` a `.chat-side .tasks-kv .task-list{display:flex}` that applies regardless of `.folded`. Cite `styles.css:1848-1870` as the
  band CSS, not "under the `md` query". (`ChatDrawer.tsx` having no `matchMedia`, and the one-DOM decision, are correct.)

## Important

- **I1 — doc:183 (test 14) vs doc:40-43 — no seam can make the reader throw.** Test 14 says "fake the reader to throw EACCES once", but §2 exports only
  `readSessionTasks`, `resetTaskCache` and `taskCacheStats`; the "same shape as `record-cache.ts`" model offers no I/O override either
  (`server/lib/record-cache.ts:46-61` exposes `reset` and `stats` only), and no existing test fakes `fs` (`test/title-cache.test.ts` only calls
  `fs.statSync`). The implementer has to invent the seam or the test. → Name it: either an exported override (e.g. `setTaskIo({ statSync, openSync,
  readSync, closeSync })` restored by `resetTaskCache()`), or specify the fixture route — `fs.chmodSync(file, 0)` before the second call and
  `0o644` after — and say which errors it must swallow (`EACCES`, `EBUSY`, `EPERM`, `EMFILE`).
- **I2 — doc:151-153 — the pill's position differs between the two sites.** `Tags` (`client/src/components/sessions/atoms.tsx:56-58`) renders model →
  surface → kaizen; "inside `Tags` after the model pill" puts the task pill *before* the surface and kaizen pills, while the `ListView` site is "after
  the kaizen pill", i.e. last. Board/Triage/Split/Tiles and List would show a different order. → State one order for both — "last, after the kaizen
  pill" matches `ListView.tsx:56-57` and the mock's row (`mockups.html:300`).

## Minor

- doc:34 vs doc:45 — 445 and 443 are both right but count different things (calls vs confirmed creates); say so in one of them.
- doc:45, doc:73, doc:84 — "61 transcripts" and "837 updates" are the morning's; now 63 / 838. Harmless; redate if touched.
- doc:54 — "does **not** contain the text `Task`" is true for 830 of 831 lines; the `InputValidationError` result line reads "TaskUpdate failed". The
  id-based prefilter in §2.2 step 3 covers it anyway, so "almost never" is enough.
- doc:35 — "also ascending id": ids are strings (`"2"`, `"10"`), ascending *numerically*; say numeric or drop the clause so nobody sorts by string.
- doc:90 vs doc:95 — a create stores `input.activeForm ?? null`, which keeps an empty string; an update applies `activeForm` only when non-empty. Use
  `|| null` on the create for symmetry, or §4.2's folded line can render blank.
- doc:10-14 — two mock differences not called out: the mock's all-done card carries a `✓ All tasks done` line (`mockups.html:326`) and its none-started
  card a `Not started` line (`mockups.html:330`); §4.4 draws neither. Since "this spec wins", add both to the known-differences list.
- doc:22 — "~100 bytes a task": `{"id":"1","subject":"<50 chars>","status":"in_progress","activeForm":"<50 chars>"}` is ~150-180 bytes. Say ~150.
- doc:79 — `scanSessions` is also called from `server/lib/notify.ts:233`, so the one-off fold may land on the notify path instead of the API handler.
  Same cache, same cost; a half-sentence keeps the "once per server start" claim honest.
- doc:130 — a `pulse` keyframe already exists (`styles.css:716`, a box-shadow ring on `.sdot`); the mock's pulse is an opacity fade
  (`mockups.html:102-103`). Say which one the dot uses, or name the new keyframe, so the two don't collide.
- doc:129 — the card's 6px `.track` has to beat `.chat-side .kv .track{height:10px}` at `styles.css:1919` (≥ `md`) and `height:4px` at `:1862`
  (base); a `.tasks-kv .track` override at both tiers is needed. Likewise `.chat-side .kv{display:block}` at `:1914` (0,2,0) beats the mock's
  `.tasks-kv{display:flex}` (0,1,0) — the selector must be `.chat-side .tasks-kv`.
- doc:12 — stands as a known difference, but the mock has no unfolded phone list to differ from; "the mock shows the folded line only" already says it.

## Checked and found correct

`.ag-pill.done` at `styles.css:737`; `record-cache.ts:11`'s "5.8 MB" comment; `api.ts:146` scanSessions call; `ListView.tsx:56-57` surface/kaizen
pills and no `<Tags>` in ListView (callers: Board, Split, Tiles, Triage); `maxSessions` default 5 at `scan.ts:506`, the over-fetch to `maxSessions * 2`
(`:533`) and the cap-then-push loop (`:551-633`); `DEFAULT_TAIL_BYTES = 256 * 1024` (`transcript.ts:28`); the 0x0A-before-decode discipline
(`chat.ts:12,186-194`); the four `Session` literals outside `scan.ts` (`web-notify.test.ts:38`, `triage.test.ts:35`, `filter-sort.test.ts:56`,
`visual/fixtures/sessions.ts:39,70`); Context card → `.chat-facts` order in `ChatDrawer.tsx:215-234` and no `matchMedia` there; `.chat-side` is a
flex column with a definite height on desktop (`styles.css:1512-1513`, `:1910-1911`) so `flex:1; min-height:0` scrolls the list; `--ink3`, `--ink2`,
`--steel`, `--green` are theme tokens overridden per `[data-theme]`; `docs/subsystems/chat.md:10` "Two columns inside it" and `:66` §What's shown;
`sessions.md:52` §What a session shows; `.claude/DESIGN.md:383` §8.6; `test/run-all.ts` registration style; client lib tests importing
`../client/src/lib/*` (`triage.test.ts:4-5`); `pct` 7/13 → 54; the folded-line fallback chain is exhaustive over the three statuses and agrees with
§4.4; `TaskStatus`/`SessionTask`/`Session.tasks` collide with nothing in `shared/types.ts`; the CLAUDE.md rules touched (types first, zero server deps,
no literal colours, docs in `docs/subsystems/` + `overview.md` §Map, dated machine-measured figures).
