# Analytics — kaizen-fed session post-mortems

An **Analytics** section (third `SideRail` entry, persisted `dashboard.section`) shows the
last N (default 5) sessions the **`/kaizen` skill has logged**.
`~/.claude/session-analytics-log.md` (one line per `/kaizen` run) is the **sole trigger** —
a session appears here only because `/kaizen` logged it. The dashboard never writes that
log; it only reads it. The `/kaizen` skill ships in this repo's plugin at `plugin/skills/kaizen/` (`README.md` §Install the skills), so
collaborators can populate the tab against their own global log.

## The band

Two rows, the shape `.mgmt-bar` set. The title row carries **state and one verb**:
**Analytics**, a **`Review due`** chip beside it when the log has gone unswept, and a
glyph-only ↻. The chip is the Claude Configs scope pill's shape (`.set-scope` — a filled 24px
capsule with a dot) in the amber it has always worn; it was an outline chip, which read as
a control you could press. The row is `align-items:center`, because a 19px title, a 24px
capsule and a 32px button share no text baseline.

The facts are prose in the row below (`.an-sub`), held to **two lines at that measure** so
it stays a caption rather than a paragraph nobody reads. It carries only what the page
cannot show: where the list comes from (`The last n sessions /kaizen logged…`), that
nothing here writes, and — when a review is due — the one move, `run /kaizen review`. Why
it does not poll and when the log was last swept live in the chip's tooltip and in this
doc. **One colour throughout**: the sentence that asks for something is not a different
kind of sentence, and an inked half made the caption look like two captions.

`/kaizen` is set as a chip in **ink** wherever it appears here (`.an-hint code`,
`.an-sub code`, `.an-lesson-body code`) — the same treatment `.set-hint code` gives a
command on Settings. It used to be the accent green, which made a third colour in a line
that already carries two. The ↻ is the shared **`.icon-refresh`** atom, used by
Claude Configs' band too: both sections reload the same way, so the control is the same
control, and the word "refresh" beside it left the glyph two characters of room once the
scope path shared that line.

## The shapes: two Sessions shapes, with a different subject

The tab draws the Sessions **split** and the Sessions **tiles**, borrowed whole — `.split`,
the `.list` card with its `.list-h` and `.lrow` rows, the `.inspect` card beside it, and
the `.tiles` grid of `.tile` cards, shared verbatim down to the CSS — one exception: between
md and lg the analytics split is one column (`.analytics .split`), because a 184px
inspector cannot hold the ledger columns. Only the subject
differs, so a report's lead dot carries what became of the lesson where Sessions carries
a session's state, and the figure is billable tokens where Sessions shows context used.
(Four other shapes were drawn as artboards first — a stack of collapsing cards, a ledger
table, tiles, a lesson-first digest — in `docs/guides/mockups/redesign-mock.html`, which
records why the split won. Tiles came back as the second shape, and as the only one a
phone draws.)

Both are fed by `AnalyticsView`, which owns the state and hands each shape the filtered
list; `AnalyticsSplit.tsx` and `AnalyticsTiles.tsx` are the two shapes, and
`analytics/atoms.tsx` is what they share — the lesson's fate in its three forms, the five
figures, the two ledgers, and `ReportBody`, which is everything under a report's own
heading. The split draws `ReportBody` in the inspector; a tile draws it when opened.

**Split.** A `.lrow` is the dot, the project, the billable total, then a second line
carrying the status badge, the 8-char session id and the date `/kaizen` logged it. A
report with no analysis shows `—` for the figure and `transcript gone` in place of the
id. Selection replaces expansion: exactly one report is open, and it falls through to the
first row so the inspector is never blank while there is something to show.

**Tiles.** Every report a metric card — dot, project and status badge in the header, the
models / id / logged date under it, then the billable total as the figure with the
context beside it and the lesson clamped to three lines. Cards are **collapsed by
default** and open in place, spanning two columns (`.tile.selected`) to make room for the
figures and the ledgers. Expansion, not selection: a grid whose first cell is always open
reads as a mistake, and comparing figures side by side is what a grid is for. The figure
and the clamped lesson are dropped from an open tile — the strip below leads with that
same billable total in the same green and carries context as its second cell, and the
lesson is spelled out in full under its own label.

The two shapes keep **separate** open-state: `selectedId` for the split, an `expanded`
set for the tiles. Opening three tiles and then switching to the split should not pick
one of them at random — the same two-state rule the Sessions board follows.

**The inspector** shows:

- **The numbers** — a **live re-run** of the deterministic analyzer on every open
  (`server/lib/analyze.ts` `analyzeSession()` → `SessionAnalysis`): billable tokens (the
  real cost signal), total context tokens, subagent count + tokens, turn count,
  tool-error/retry counts, then the priciest tools and subagents. The five figures are a
  strip of one value each — the subagent count and the retry count ride in their
  **labels**, because the inspector is narrower than a full-width card and a two-part
  value wraps there and drops its label out of line with the other four.
- **The subagent figure is summed from the subagents' own transcripts** (`server/lib/subagent-usage.ts`): every
  `<sessionId>/subagents/agent-<agentId>.jsonl`, once per `message.id`, paired to its launch by `agentId` or the
  `.meta.json` sidecar's `toolUseId`. The harness's own number (`toolUseResult.totalTokens` / `<subagent_tokens>`) is the
  subagent's *final context size*, not its spend — 5–130x low on many-turn subagents (bug-27) — so it is only the fallback
  for a finished subagent whose transcript is missing or sums below it, counted in `subagentTotals.fallbackCount`. The
  metric's tooltip carries `subagentTotals.usage`'s billable / cache-read split. `/kaizen`'s `kaizen.mjs` does the
  same, and `test/analyze.test.ts` runs it against `analyzeSession` to keep the two in step.
  A `resumed` row (a SendMessage resume, which `lib/agents.ts` lists as its own row) is left out of the sum: its runs write into the transcript the
  original launch already claims. `kaizen.mjs` lists only `Task`/`Agent` launches, so it has no such row to skip.
  A compaction replays earlier records verbatim; both sides count each `tool_use` id, `tool_result`, Agent launch and SendMessage once and add each
  subagent transcript once (#174, #226), and the parity tests include a replayed fixture.
  Both sides also skip Claude Code 2.1.302's `api-request-blob` records, which replay each request's turns with the same role and content: `analyze.ts`
  through `transcript.ts`'s `isConversationRecord`, `kaizen.mjs` through its own copy of it (#252, #253), with a blob fixture in the parity test.
- **Research & suggestions** — the one-line lesson `/kaizen` wrote for that session. The
  server does **no** LLM calls and invents no advice; the qualitative judgment is
  entirely `/kaizen`'s.
- **Status badge** (`.an-status`) — `actioned` / `promoted` / `dropped` / `open`: did you
  ever act on the lesson? `/kaizen` records that by appending a `status` line to the same
  log; no line means still open. The same fact leads the row as `.an-dot`. A `none` lesson (the session taught nothing new) is born closed: it draws
  `.an-status.none` (`— none`) and a hollow `.an-dot.none`, never `○ open`.
- **Verdict badge** (`.an-verdict`) — `helped` / `hurt` / `no-effect` / `confounded`, beside the status badge in the inspector head and the tile head:
  did the actioned or promoted rule actually work? Only `/kaizen review` writes the `verdict` line, from `kaizen.mjs --compare` (below), so most lessons
  have none and draw no badge — pending is the quiet default. The verdict's note (field, before → after medians, session counts) is spelled out under
  the lesson. A verdict never changes the status badge: open is still "no status line".
- **Lesson fields** (`.an-lesson-fields`) — when the lesson line carries a tail, its `cue` / `component` / `evidence` / `confidence` sit as a labelled list
  under the lesson text; nothing extra when it does not. The collapsed tile clamps the lesson text only, never the tail.

Workflow: run `/kaizen` in a Claude Code session → it appends a lesson → the session
appears in the tab (↻ to pull it in). If the transcript has since been deleted, the
inspector falls back to lesson-only (no live numbers) and `project` falls back to the log
line's project tag.

## Mechanism

- **Read-only — no write path.** `/kaizen` is the only producer. (An earlier design had
  an Inspect button + a `POST /api/analytics/inspect` that generated and persisted report
  JSON; that was removed in favor of letting `/kaizen` own report creation, so the app
  keeps its read-only invariant.)
- **Endpoint:** `GET /api/analytics` only (AnalyticsResponse: last N reports,
  newest-first, plus `lastReviewAt` / `reviewDue`). Handler `serveAnalytics` in `api.ts`;
  reader in `lib/analytics.ts` (`listReports`, `reviewStatus`); log parser in
  `lib/sessionAnalyticsLog.ts` (`parseSessionAnalyticsLog` / `recentLessons` /
  `parseLogEvents` / `statusForSession`). Both unit-tested.
- **How the reader works (`lib/analytics.ts`):** `readLogEvents` →
  `recentLessons(limit)` (dedupe by id-prefix, newest-first) → for each, resolve the
  transcript by **prefix-matching** the logged short id against one
  `listTranscripts(projectsRoot())` through `scan.ts` `findTranscriptByPrefix` — the newest
  half per id, then the newest id, so a session split across two project dirs resolves to its
  live half (never joined into a path — same philosophy as
  `serveSessionDetail`; validated with `ID_RE`) → `analyzeSession(ref.file, ref.id)`
  live. `analysis` is `null` when the transcript is gone.
- **`reviewDue`** = lessons other than `none` ones exist AND no `review:` marker within 7 days
  (`REVIEW_INTERVAL_DAYS` in `analytics.ts`; `now` injectable for tests). An empty log, or one of only `none` lessons, is
  never "due". The client renders it twice over in the band: the `.an-review` chip
  (`Review due`, with `lastReviewAt` in its tooltip) and one appended sentence naming the
  move — run `/kaizen review`, which sweeps accumulated lessons, promotes recurring ones
  and prunes rules that stopped earning their keep. State in the row, instruction in the
  prose.
- **No polling:** the list changes only when `/kaizen` runs. `AnalyticsView` is a
  `React.lazy` default export (own chunk); `useAnalytics` fetches on mount + manual ↻ and
  is client-only.
- **Toggles:** `SHOW_ANALYTICS=false` hides the tab, display cap `ANALYTICS_KEEP=<n>`
  (config.ts, default 5) — see [configuration](../workflows/configuration.md).

## Filter + sort

The tab draws the Sessions toolbar, not a second design of one: the same `.toolbar` row,
the same `.seg.view` switcher, the same filter/sort track, and the same `Popover` dismiss
primitive. The switcher (Split | Tiles) leads the row, then how much of the log is in
front of you (`n of m sessions`). Facets are **project**, **model** (a report
matches if *any* of its models is selected), a **logged-at window**, and a sort key
(recency / tokens / project) with a direction toggle. An empty facet array means "no
filter", not "match nothing". `analyticsFilterCount` counts **per facet, not per value** —
the button says "something is hidden", not how much — and `clearAnalyticsFilters` resets
the three facets while keeping the sort, returning the view by reference when nothing is
active. Both are pure and unit-tested beside `applyAnalyticsView`.

`applyAnalyticsView` in `lib/analyticsFilterSort.ts` is pure — filter, then sort, no
mutation — and unit-tested in `test/analytics-filter-sort.test.ts`. Two deliberate
tolerances: a report whose transcript is gone (`analysis: null`) sorts as **0 tokens**
rather than dropping out of a token sort, and an unparseable `loggedAt` **fails open**
(kept) rather than being silently filtered away.

Windows are **day-granular** (`Any time` / 7 / 30 / 90 days) because `loggedAt` is a
`YYYY-MM-DD` date with no time-of-day — the Sessions view's "15 min / 1 hour" windows have
nothing to bite on here.

The toolbar selection persists to `localStorage` under `dashboard.analyticsView`, and the
shape under its own key `dashboard.analyticsLayout` — a shape is not a filter, so it does
not ride in the object the facets are stored in (see
[view-persistence](view-persistence.md)). `isAnLayout` guards the read, failing open to
`split`. **Which report is open is deliberately not persisted** — session ids churn, so a
restored selection would be stale, and the split's fall-through to the first row makes
one unnecessary. Same rule as the Sessions split's `splitId`.

**The phone draws tiles.** Split is a two-pane master/detail and a 375px measure has no
room for the detail pane to be a pane, so `WIDE_ONLY_AN_LAYOUTS` withholds it under `md`
(768px) (`hooks/useNarrow.ts`) and `drawableAnLayout` draws tiles instead — while the stored key
goes on saying `split`, so widening the window comes straight back without re-picking.
Only the *drawing* is coerced; unlike the Sessions side there is no written-back half,
because no Settings picker pins this tab's shape. With one shape left, the switcher is
dropped from the markup outright rather than left as a lone tab that switches to itself.
`anLayoutsFor` / `drawableAnLayout` / `isAnLayout` are pure and unit-tested beside the
filter helpers. All of it is client-side over the payload `GET /api/analytics` already
returned — no backend change, so the read-only invariant above still holds.

## Invariants

- **⚠️ One turn is not one record — `analyzeSession` counts per `message.id`.** Claude
  Code writes **one transcript record per content block** (a turn that thinks, talks and
  fires two tools is four records), and every one of them carries a full copy of that
  turn's `message.usage` under the same `message.id`. So the walk sums usage on a turn's
  **first** record only and skips the copies, and `perTurn.count` / `maxTurnIndex` are
  ordinals over *turns*, not records. Summing per record inflated every total **1.5–2.3×**
  on real transcripts (`backlog/bugs/done/bug-1-…`). A record with **no** `message.id`
  (old or malformed transcript) counts as its own turn — fail open, never drop a turn.
  `byTool.approxOutputTokens` follows from the same fact: a turn's `output_tokens` is split
  across **all** of that turn's tool blocks, which is why tool blocks are buffered per
  `message.id` and settled after the walk rather than attributed per record — parallel tool
  calls land in separate records, and splitting per record charged each of them the whole
  turn. `count` / `durationMs` / `errors` stay **per call** (parallel calls are real,
  separate calls); only the token split is per turn. `server_tool_use` rides in the same
  usage block, so it is deduped too.
  `byTool.resultTokens` is the opposite case and must stay that way: it sizes each call's own
  matched tool_result (chars ÷ 4, error text included) and is **never** split across the turn,
  so it is the figure that names a context-heavy `Read`. `byTool` sorts by it, and the
  Analytics tab's *Top tools* shows it as `in` beside `approxOutputTokens` as `out`.
  **Not affected:** `lib/transcript.ts` (session rows, chat-drawer context) reads the
  *latest* usage rather than summing, and the copies are identical — its numbers were
  always right.
- **`perTurn.neverCompacted` reads the marker, and infers only as a fallback.** The transcript carries no context-window field (`message.model` reads
  `claude-opus-5`, no `[1m]` suffix), so the window is inferred: `maxCombined` above `NEVER_COMPACTED_PEAK` (250k — a 200k window compacts near 160k, so
  only a larger window reaches it). Compaction is read: any main-chain `compact_boundary` record (`compactMetadata`; a sidechain one does not count)
  makes it `false`. For transcripts that predate the marker, a turn anywhere below `COMPACTION_DROP_RATIO` (half) of the running peak also makes it
  `false` — a turn's `combined` is its whole context, which only grows between compactions, so that fall is the one compaction leaves. No turns reads
  `false`. A `notes[]` entry states the rule, and `/kaizen` §2 treats `true` as a primary explanation for cost. Only `kaizen.mjs` surfaces it today —
  the Analytics tab does not render it. Both sides also skip the boundary's `isCompactSummary` record, so the summary never reaches the correction
  heuristic. `kaizen.mjs`'s `compactions` block — one row per boundary, a replayed boundary with the same timestamp counted once in
  `duplicatesSkipped` — is kaizen-only by decision: a `/kaizen` lesson input with no dashboard consumer, like `--trend`
  (`plugin/skills/kaizen/test/compactions.test.mjs`).
  That heuristic (`errorSignals.userCorrections`) also skips a user turn carrying `<agent-message`, on both sides: it is a subagent's hand-back
  delivered as a user turn, not the user correcting anything (#302).
- **The lesson line's figures are data, not only prose.** `kaizen.mjs --trend [log]` reads the `<billable> billable (<ctx> ctx` prefix back out of
  every lesson line (`k` / `M` / `B` suffixes, decimals, thousands commas; trailing `, 231 turns` and the like ignored) and prints per-project and
  overall ctx series, which `/kaizen review` step 2 reports. Drift is the median ctx of a group's newest 3 sessions at ≥ 1.5× the median of all its
  earlier ones, and needs 6+ sessions: medians on both sides are what keep one outsized session from ever reading as a trend (it takes two of the
  newest three), and a group's own history as baseline is what keeps a project that always runs large from being flagged for size alone. An absolute
  ctx threshold was the rejected alternative — it fires on exactly that single big session. The read keeps the newest line per `[project] id` in memory
  (newest-wins, as `lessonForSession` reads it) and never writes the log. Lines without both figures — status, review, prose, mid-session captures —
  are skipped; a line with `billable` but no `(N ctx)` counts in `withoutCtx` and nowhere else. `--trend` is kaizen-only: no server module or
  Analytics view reads it, so `test/kaizen-trend.test.ts` spawns the plugin's script itself.
- **`kaizen.mjs --compare <project> <since> <field.path>` is what a verdict is measured with.** It re-runs the analyzer over the project's main-session
  transcripts (cwd basename = the log's project tag; subagent transcripts never count) — up to 10 starting after the end of `<since>` (UTC), oldest
  first, and as many, at least 3, immediately before it; a session starting on `<since>` is before. Each side prints `n`, `median`, `values` and
  `missing`: a session where the dotted path resolves to no number is missing, never 0. `byTool.<tool>.<key>` (and `bySubagent.<type>.<key>`) address
  a keyed row. A path that resolves in no session is an error exit. It never reads or writes the log. Kaizen-only like `--trend`, tested in
  `plugin/skills/kaizen/test/compare.test.mjs`; a dir-name prefilter and a 64 KB head read keep it to one full analysis per selected session.
- **⚠️ Log grammar (the contract with `/kaizen` — four line shapes, all append-only):**

  ```
  - 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: <takeaway>. ‖ cue: <…> · component: <…> · evidence: <…> · confidence: high (<why>)
  - 2026-07-12 [dashboard] 7f31c0aa: 95k billable (600k ctx), top cost Edit. Lesson: none — <reason>.
  - 2026-08-09 [dashboard] d04e9b52: status actioned — added to project CLAUDE.md
  - 2026-09-02 [dashboard] d04e9b52: verdict helped — errorSignals.retries median 4 → 1 over 5 sessions (before 5)
  - 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2
  ```

  A lesson line may carry a **tail** after the first ` ‖ ` (space, U+2016, space). Both parsers cut the lesson text there, so `lesson`,
  `lessonForSession` (the Sessions view's `kaizenLesson`) and the collapsed tile never show it, and split it into `cue`, `component`, `evidence` and
  `confidence` — a field starts only where ` · ` (space, U+00B7, space) is followed by one of those keys and a colon, so a value may contain either
  separator. `confidence` must be `high|medium|low` (stored lower-case, an optional `(<why>)` kept as `confidenceReason`) or that one field is dropped;
  unknown text is never a field. `AnalyticsReport.lessonFields` carries what parsed. A lesson whose text is `none` then a dash is `lessonNone`: born
  closed, it takes no status line, draws as `none` rather than open, and `reviewStatus` does not count it as a lesson to sweep. Lines without a tail parse
  exactly as before. `kaizen.mjs --trend` reads only the billable/ctx prefix, so tailed and `none` lines are points like any other.

  A **verdict** line is `verdict` then `helped|hurt|no-effect|confounded` (case-insensitive, stored lower-case; the value must end at whitespace, so
  `helpedx` is no verdict) and an optional em-dash note. Only `/kaizen review` writes one, for an actioned/promoted lesson with ≥ 3 sessions after its
  status date; `parseLogEvents` returns them as `verdicts`, and `AnalyticsReport.lessonVerdict` is the newest one matching the session
  (`verdictForSession`: prefix + newest-wins). It never touches open/settled.

  `parseLogEvents` classifies each line by the **first** pattern it matches (verdict → status →
  review → lesson), so a verdict or status note containing `Lesson:` can't be mistaken for a lesson.
  The older `parseSessionAnalyticsLog` (still used by `scan.ts`) returns the same lesson shape and skips
  the three newer shapes — review lines lack `Lesson:`, and status and verdict lines are skipped by pattern first — so a log with
  status/verdict/review lines yields exactly the lessons it would without them. **Never add a line shape on one
  side only** (skill ↔ parser).
- **Status + review are why the log stays append-only.** A lesson's fate is recorded by
  appending a later `status` line, never by rewriting the original — the machine runs
  many sessions at once and a read-modify-write of a shared file loses concurrent entries
  silently. `AnalyticsReport.lessonStatus` is the newest status matching the session
  (prefix + newest-wins, mirroring `lessonForSession`); `null`/absent = still **open**, unless `lessonNone` is set.

## Live meter

The live session meter (status line, `/compact` nudge, tool and subagent pane) used to ship here as `plugin/hooks/`. It is now the standalone
`session-meter` mod in the user's `claude-global` repo and no longer depends on `/kaizen` or `kaizen.mjs`.

<!-- docs-sync:
  sources:
    - server/lib/analytics.ts
    - server/lib/analyze.ts
    - server/lib/subagent-usage.ts
    - server/lib/sessionAnalyticsLog.ts
    - server/api.ts
    - client/src/components/analytics/
    - client/src/lib/analyticsFilterSort.ts
    - client/src/hooks/useSettings.tsx
    - plugin/skills/kaizen/
  kind: subsystem
  verified: 24f8d773dd459e02b1e4ef4a093aed285939555c
-->
