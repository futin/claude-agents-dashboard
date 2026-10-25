# Review 2 — Chat PR card design spec

Document: `docs/superpowers/specs/2026-10-24-chat-pr-card-design.md` (spec) · `docs/superpowers/specs/2026-10-24-chat-pr-card-mockups.html` (mock)
Reviewer: Fable 5.1, fresh session, 2026-10-25. Scope: the text changed since round 1 (`git diff HEAD~1 -- <spec>`) and its consistency with the rest.
Every code claim was read in the worktree; the three machine-measured figures were recomputed over `~/.claude/projects/`.

## Verdict: APPROVE WITH FIXES

No Critical. Every round-1 Important is addressed and the fixes are correct against the code (table below). Three Important findings remain: one
contradiction the round-1 fix introduced (Client decides the relative-time wording, "Left to the builder" still delegates it), one false file name that
round 1 verified against the right file without noticing the spec names the wrong one, and one measured figure that names the wrong thing.

## Round-1 fixes verified

| Round-1 finding | Spec now | Evidence |
|---|---|---|
| Merge copy `unknown` vs `checking…` | `Checking…` at :20, :111, :174; mock cell added (mock :379-382) | consistent |
| Checks row / band copy missing | §Copy :160-185; mock open card `3 of 4 passed · 1 running` (mock :212), draft cell `1 failed · 3 passed` (:370), band `3/4 checks · review required` (:232) all satisfy the rules at :167-169, :180 | recomputed |
| Check enum mapping thin | full table :101-109; values match GitHub's `CheckStatusState`, `CheckConclusionState`, `StatusState` enums | — |
| Missing / null cwd → `gh not installed` | :87-89; `spawn('ls', [], { cwd: '/nonexistent' })` → `ENOENT spawn ls ENOENT` re-run 2026-10-25 | true |
| Unvalidated URL in argv | :90-92; every `gitOperation.pr.url` on this machine matches the anchored form (sample: `https://github.com/futin/claude-agents-dashboard/pull/66`) | true |
| Await vs answer-at-once | :125-127 awaits the shared promise; hook skips a tick while pending | decided |
| Read-failure status | :121-122 → 500, as `serveSessionChat`'s `fail(500)` (`server/api.ts:299-300`); test at :204-205 | true |
| Visual fixture precondition | :208-211; `test/visual/harness.ts:2-3`, `test/visual/mock-api.ts:5, 97-98` | true |
| Tints on `:root` + Daylight | :45-47; `client/src/styles.css:52, 56, 61` root `color-mix`, `:132-137` Daylight overrides | true (see Minor) |
| `GH_NO_UPDATE_NOTIFIER` / `GH_PROMPT_DISABLED` | :84; both listed by `gh help environment` (:50, :67); `lib/codegraph.ts:25` is the cited precedent (`CODEGRAPH_ENV`) | true |
| `rel="noopener noreferrer"` | :155; `Markdown.tsx:17`, `management/GitBranches.tsx:70` | true |
| `formatAgo` → `2h` / `1d` | :156-157; `client/src/lib/format.ts:30-43` (`ageAt`) | true |
| `.claude/DESIGN.md` §8.6 | :193; `.claude/DESIGN.md:394` | true |
| Subagent count | :69-70 "3,047 files, no `gitOperation.pr`"; today 3,074 files, 0 files / 0 records | true (dated figure fine) |
| Title forms in scope | :71-73 | see Minor on :200 |
| State precedence, `total = 0` → null, `UNKNOWN` short window, `pr-top`/`pr-glyph`, poll count | :99, :98, :95, :153, :227 | consistent |

## Important

**[I] spec:218 vs spec:156-157 — "Left to the builder" still lists "The relative-time wording on Merged / Closed", which the Client section now
decides (`formatAgo`, `2h` / `1d`, "No new helper").** An implementer who reads :218 may keep the mock's `2h ago` / `yesterday` and add the helper :157
forbids. → Delete :218.

**[I] spec:115 — "an injectable runner for tests, as `git-fetch.ts` and `codegraph-store.ts` do": `codegraph-store.ts` has no runner seam.** It
consumes `currentCodegraphRunner()` imported from `codegraph.ts` (`server/lib/codegraph-store.ts:14, 118, 195, 285`); the seams are
`overrideCodegraphRunner` at `server/lib/codegraph.ts:84` and `overrideFetchRunner` at `server/lib/git-fetch.ts:98`. Round 1 verified the right file
without flagging the wrong name. → Write `codegraph.ts` (`overrideCodegraphRunner`).

**[I] spec:77-78 — "`mcp__ccd_pr__*` calls occur 43 times in this project's top-level transcripts (2026-10-24)" names the wrong thing.** Recomputed
2026-10-25 over `~/.claude/projects/-Users-andrejajevtic-Documents-custom-projects-claude-agents-dashboard/*.jsonl`: 132 `mcp__ccd_pr__*` tool
calls — `get_status` 80, **`bind_pr` 43**, `set_monitor` 7, `set_auto_merge` 2. The 43 is exactly the `bind_pr` count (the tool round 1 named as the
one carrying a PR URL), not the wildcard; a day's growth cannot explain 43 → 132. The decision (builder may widen; read the real shape first) does not
depend on it, but the figure is the one a builder will quote. → `mcp__ccd_pr__bind_pr` occurs 43 times (and `get_status` 80) …, dated.

## Minor

- spec:46-47 — "plus a Daylight line only if Daylight overrides its siblings": it does — `styles.css:132-137` override `--green-tint`, `--amber-tint`
  and `--mustard-tint` — so say outright: one `:root` line plus one Daylight line each.
- spec:99-109 — the check-fold table is indented under the **State** bullet (:99) but belongs to **Checks** (:97-98). Move it or give it a caption.
- spec:171 vs mock :213, :370 — segment order: the spec says failed, running, passed; the mock's open card draws three passed then the running one
  (`<i></i><i></i><i></i><i class="run"></i>`), the draft cell draws failed first. The mock difference is not called out (checklist 4).
- spec:168 — Tone `running` vs the mock's class `run` (mock :117, :119). Class names are proposals (:153), so either is fine; name one.
- spec:25 — `Status · unavailable · <short reason>` puts a `·` between label and value, where the other rows are written `Checks (…)`; the mock row
  (:396) is `Status` + `unavailable · gh not signed in`. Write it as the others: **Status** (`unavailable · <short reason>`).
- spec:200 — "title parsed from `--title` and `-t`": :71-72 scopes four forms each (`"…"`, `'…'`, `=…` quoted or not) and the heredoc → `null`
  case; the test list should name them so the fixed list at :72 is what gets tested.
- spec:217 — garbled: "Whether the `—` fallback title is the `--title` arg or `#<n>` alone when neither the arg nor `gh` gave one" — the arg cannot
  be the fallback when the arg gave nothing. Reword: "What the title slot shows when neither the arg nor `gh` gave one: `—` or `#<n>` alone".
- spec:204-205 — no sibling test exercises a transcript-read throw (`serveSessionChat`'s 500 at `server/api.ts:300` has no case in `test/chat.test.ts`
  or `test/api-read-endpoints.test.ts`), so the builder has no pattern to copy. `withServer` (`test/api-harness.ts:121`) runs under a throwaway
  `$HOME`; say how the throw is provoked (e.g. `chmod 000` the `<id>.jsonl`, or write a directory in its place) so the case is not dropped as infeasible.
- spec:210 — a fixture that answers `pr: null` for most ids and a populated PR for one needs a function body keyed on the pathname; `mock-api.ts:20-21`
  documents function bodies as "for the one endpoint whose answer must depend on its query" (the chat tail, `fixtures/index.ts:35`). Either update that
  comment or answer the populated PR for every id — every chat-opening case opens `FIXTURE_SESSION_ID` (`index.ts:29`) anyway.
- spec:101-109 — an item whose `__typename` is neither `CheckRun` nor `StatusContext` is unmapped; say "excluded".
- spec:126 — "the hook skips a poll tick while its previous request is still pending" is new behaviour: `usePendingPlan.ts:63-86` (the sibling :119
  points at) has no such guard. Fine, but say "unlike the siblings" so the builder does not look for a pattern to copy.
- spec:191 — the CLAUDE.md launched-programs sentence names codegraph's env vars beside the program; the `gh` entry should name
  `GH_NO_UPDATE_NOTIFIER` / `GH_PROMPT_DISABLED` the same way, since :84 sets them.

## Checklist coverage

1. Facts — every changed code claim read (`api.ts`, `codegraph.ts`, `codegraph-store.ts`, `git-fetch.ts`, `format.ts`, `Markdown.tsx`,
   `GitBranches.tsx`, `styles.css`, `harness.ts`, `mock-api.ts`, `fixtures/index.ts`, `usePendingPlan.ts`, `.claude/DESIGN.md`); `gh help environment`
   and the Node `spawn` ENOENT claim re-run; three transcript figures recomputed (one wrong: Important 3; one stale file name: Important 2).
2. Consistency — one contradiction (Important 1); copy rules at :167-169, :180 recomputed against the mock's three check rows and the band; cache
   windows (:94-96, :113, :228) agree; envelope (:120-123, :204-205, :225) agrees.
3. Edge cases — unknown `__typename` (Minor); null/missing cwd, flag-shaped URL, all-excluded rollup, draft+closed, in-flight first call, read throw
   all now covered.
4. Copy — §Copy is exact; two mock differences not called out (segment order, `run` tone), one notation mismatch (:25).
5. Scope — unchanged from round 1; nothing in scope depends on a non-goal.
6. CLAUDE.md — zero-deps rule respected (local launch, env vars silenced as `codegraph.ts` does); field order, no colour literals, stable class names,
   docs updates named; `main` PR-only honoured by the no-writes anti-goal.
