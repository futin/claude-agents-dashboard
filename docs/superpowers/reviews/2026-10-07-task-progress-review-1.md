# Plan review 1 — task progress

Plan: `docs/superpowers/plans/2026-10-07-task-progress.md` (240 lines). Spec: `docs/superpowers/specs/2026-10-07-task-progress-design.md` (222 lines).
Reviewed 2026-10-07 by a fresh Fable session, read-only, against the checked-in code at `bd9a7b5`.

## Verdict

**APPROVE WITH FIXES.** No Critical findings. Four Important findings, each a one-line edit: one test case would fail against a correct implementation
because of how the named fixture helper writes files, one test cannot pin what it claims to pin without a constant the plan never states, one UI
requirement leaves the phone DOM ambiguous, and one stated fact about the test suite is false.

## Checklist results

| # | Item | Result |
| - | ---- | ------ |
| 1 | Coverage | Every spec section and every spec §5 case maps to a task (table below). Nothing uncovered. |
| 2 | Values | All copy strings, counts and expected values match the spec (`7 of 13 tasks done`, `✓ All tasks done`, `Not started`, `All done`, `Next:`, `13/13 ✓`, `pct` 54, `[completed,pending,pending]`, `[]` vs `null`). |
| 3 | Reality | Every Modify path exists, every Create path is absent. Line references verified (table below); one off-by-one (M9). |
| 4 | Interfaces | Every Consumes is Produced earlier with the same spelling and type. |
| 5 | Order | Tasks 1→6 have no forward dependency. `Session.tasks` is deliberately deferred to Task 2 so Task 1 typechecks. |
| 6 | Tests | All red-before-green. Review Focus 1 is a measurement, not a test (M6); the rest each have a case. One case would stay red against a correct implementation (I1); one could pass vacuously (I2). |
| 7 | Conventions | "Never literal code" is held except one JSX-ish fragment lifted from the spec (M8). No size budget stated. |

### Coverage map

| Spec | Plan task |
| ---- | --------- |
| §1 types | Task 1 (`TaskStatus`, `SessionTask`), Task 2 (`Session.tasks`) |
| §2.1–2.3 fold | Task 1 behaviour list + cases 1–14 |
| §2.4 wiring, `tasks: null` literals | Task 2 |
| §3 helper | Task 3 |
| §4.1 card, §4.2 band, §4.4 card states | Task 5 |
| §4.3 pill, §4.4 pill states | Task 4 |
| §5 cases 1–14 | Task 1 cases 1–14 (1:1, same order) |
| §5 `taskProgress` cases | Task 3 (superset) |
| §5 mutation-check 3 and 7 | Task 1 Step 4 (adds a third, chunk-tail → case 13) |
| §5 typecheck / test / live look | Tasks 4–5 Step 3, Finish |
| §6 docs | Task 6 |
| Verification (unproven) | Finish, Unproven row |

### Reality checks (all verified by reading the code)

| Plan claim | Code | OK |
| ---------- | ---- | -- |
| `atoms.tsx:56-58` kaizen pill last in `Tags` | `client/src/components/sessions/atoms.tsx:57-58` | yes |
| `ListView.tsx:56-57` kaizen pill in `.name` | `client/src/components/sessions/ListView.tsx:56-57` | yes |
| `Tags` used by Board, Triage, Split, Tiles | `BoardView.tsx`, `TriageView.tsx`, `SplitView.tsx`, `TilesView.tsx` | yes |
| `.ag-pill.done` at `styles.css:737`; `.ag-pill.*` block ~`:736-743` | `client/src/styles.css:735-743` | yes |
| `.ag-pill.kaizen` uses `color-mix` of `--green` | `client/src/styles.css:738` | yes |
| phone `.chat-side` block `:1848-1870`, 4px track `:1862` | `client/src/styles.css:1854-1868`, `:1862` | yes |
| `@media (min-width:768px)` chat block `:1902`, `.kv{display:block}` `:1914`, `.track{height:10px}` `:1919` | `:1902`, `:1915`, `:1919` | off by one (M9) |
| `breakpoints.test.ts:209-215` fails on `max-width` | `test/breakpoints.test.ts:208-215` | yes |
| `ChatDrawer.tsx:215-234` Context `.kv` → `.chat-facts`; no `matchMedia` | `client/src/components/ChatDrawer.tsx:215,234`; no match | yes |
| `scan.ts` `sessions.push({` ~`:633`, `c.file`, after the cap | `server/lib/scan.ts:633`, `:552`, `:551` | yes |
| `run-all.ts` `import { run as … }` + `failed +=` | `test/run-all.ts:3-60`, `:55-…` | yes |
| `filter-sort.test.ts` `test(name, fn)`, `sess()`, `run(): number` | `test/filter-sort.test.ts:26,34,64` | yes |
| `tmp-root.ts` cleans `os.tmpdir()` fixtures | `test/tmp-root.ts:13-20` repoints `TMPDIR`, `rmSync` at exit | yes |
| `Session` literal sites: web-notify, triage, filter-sort, visual fixtures | grep over `server client shared test scripts`: those four plus `test/git-sync-client.test.ts:41` (`as Session` cast on a partial — unaffected) | yes |
| `test/visual/fixtures/sessions.ts` reached by `pnpm typecheck` | `tsconfig.json` includes `test` | yes |
| `chat.ts` splits on `0x0A` before decoding | `server/lib/chat.ts:12,186,194` | yes |
| no DOM test harness for components | no `react-dom`/`renderToString`/testing-library under `test/` | yes |
| `scanSessions` callers `api.ts:146`, `notify.ts:233` | `server/api.ts:146`, `server/lib/notify.ts:233` | yes |
| doc anchors: `chat.md:10-19` "Two columns inside it", `sessions.md` §What a session shows, `overview.md` §Map | `docs/subsystems/chat.md:10`, `docs/subsystems/sessions.md:52`, `docs/overview.md:323` | yes |
| mock all-done pill has no `.mini` | `docs/superpowers/specs/2026-10-07-task-progress-mockups.html:327` | yes |
| `test/outbound.test.ts` pins outbound calls | exists | yes |

## Important

**I1 — plan:124-125 — the Task 2 scan test would fail against a correct fold.** `test/scan.test.ts:31` builds each transcript with
`spec.records.map(JSON.stringify).join('\n')` — no trailing newline. Spec §2.2 step 2 and plan:68-69 defer the file's final unterminated line, so
the last record of the fixture (the `completed` update's result) is never folded and the session's statuses read `[pending, pending]`, not the
`[completed, pending]` the case expects. Fix: state that this case appends `'\n'` to the file (or ends with a trailing non-task record), and add
to Task 1 Step 1 that every fixture record is written with a trailing `\n` unless the case says otherwise (cases 8 and 12 depend on this being
explicit).

**I2 — plan:96-97 — case 12 cannot pin the chunk boundary it claims to test.** The test positions the multibyte subject "so the 1 MB chunk
boundary falls inside that subject", but the plan never fixes the chunk size (1,000,000 vs 1,048,576 — `server/lib/record-cache.ts:31` uses
`512 * 1024`, the MiB convention) and Task 1 Produces no constant for the test to read. If the implementer's chunk size differs from the test's
assumption the boundary lands in filler and the case passes vacuously. Fix: add `export const CHUNK_BYTES = 1024 * 1024` to Task 1 Produces and
have the test compute the padding from it (or make the subject a multibyte run long enough to cover 1,000,000–1,048,576).

**I3 — plan:200-204 — the phone DOM is ambiguous and, read literally, duplicates the head.** Task 5 gives the card a desktop head row (`Tasks` ·
`done / total`) plus a status line, *and* a phone folded line (`Tasks`, `done/total`, text, cue); plan:206 hides only the folded line on desktop.
Nothing hides the head row or the status line in the base tier, so a phone would show `Tasks 7/13` twice stacked, contradicting spec §4.2's "one
baseline". Fix: state that the base tier hides the head row and the status line (`display:none`) and the `min-width:768px` block restores them —
or that the folded line *is* the head, with its text and cue hidden on desktop.

**I4 — plan:181 — "the theme-literal checks" do not exist.** No test under `test/` checks `client/src/styles.css` for colour or shadow
literals; `test/breakpoints.test.ts:208-215` checks width queries only, and the other two files that read `styles.css` (`chat-pinned-pad.test.ts`,
`split-plan.test.ts`) check padding and the strip. An implementer told `pnpm test` guards the no-literal rule will not look. Fix: replace with a
manual step — grep the new rules for `#`, `rgb(`, `hsl(` and `box-shadow` values that are not `var(--…)`.

## Minor

- **M1 — plan:183** "the default navy theme": the theme id is `midnight` (`client/src/lib/settings.ts:27`, default at `:134`); "navy" is its hint
  text. Name the id.
- **M2 — plan:102** "the new module fails (import … cannot resolve)": `test/run-all.ts` imports every module statically, so a missing
  `server/lib/tasks.ts` aborts the whole `tsx test/run-all.ts` run at load — still red, but no case count prints. Say so, or have Step 1 import
  lazily.
- **M3 — plan:233** "doc-link checks, if any": `test/docs-links.test.ts` exists and runs in `pnpm test`. Name it.
- **M4 — plan:146-147 vs spec:113** spec §3 says "One pure function"; the plan produces three (`taskLine`, `scrollTargetId` added). Sensible — the
  §4.2 line and §4.1 scroll target need a home — but plan:8 says the spec wins on disagreement, so add one line saying the extension is deliberate
  (or amend spec §3).
- **M5 — plan:91** case 8: say the create *call* line ends with `\n` and only the result line lacks it; "create call + its result written without
  the trailing newline" could be read as both.
- **M6 — plan:36-37** Review Focus 1 is owned by a timing measurement, not a test. Acceptable (spec §2.2 asks for exactly that), noted because the
  review checklist asks for a test per focus item.
- **M7 — plan:62-63, 92-93** `bytesRead` "cumulative since reset": say whether a deferred partial line counts once (bytes advanced) or twice (bytes
  read from disk). Case 9 holds either way once the fixture ends with `\n` (I1).
- **M8 — plan:175-176** `<span class="mini"><i style={{width: pct%}}/></span>` is a literal JSX fragment under a plan that forbids literal code
  (plan:6). Lifted from spec §4.3 / the mock, so harmless; could read "a `.mini` bar whose `<i>` width is `pct%`".
- **M9 — plan:191-192 (and spec:147)** `.chat-side .kv{display:block}` is at `client/src/styles.css:1915`, not `:1914`.

## Not verified

- No command was run against a built branch; this is a document review. Timings, the live checks and the mutation proofs are the implementer's.
- `DESIGN.md §8.6` was not opened.
