# Analytics — kaizen-fed session post-mortems

An **Analytics** section (third `SideRail` entry, persisted `dashboard.section`) shows the
last N (default 5) sessions the **`/kaizen` skill has logged**.
`~/.claude/session-analytics-log.md` (one line per `/kaizen` run) is the **sole trigger** —
a session appears here only because `/kaizen` logged it. The dashboard never writes that
log; it only reads it. The `/kaizen` skill is **vendored** at `.claude/skills/kaizen/` so
collaborators can populate the tab against their own global log.

## The band

Two rows, the shape `.mgmt-bar` set. The title row carries **state and one verb**:
**Analytics**, a **`Review due`** chip beside it when the log has gone unswept, and a
glyph-only ↻. The chip is the Management scope pill's shape (`.set-scope` — a filled 24px
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
Management's band too: both sections reload the same way, so the control is the same
control, and the word "refresh" beside it left the glyph two characters of room once the
scope path shared that line.

## The shapes: two Sessions shapes, with a different subject

The tab draws the Sessions **split** and the Sessions **tiles**, borrowed whole — `.split`,
the `.list` card with its `.list-h` and `.lrow` rows, the `.inspect` card beside it, and
the `.tiles` grid of `.tile` cards, shared verbatim down to the CSS. Only the subject
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
  metric's tooltip carries `subagentTotals.usage`'s billable / cache-read split. `/kaizen`'s vendored `kaizen.mjs` does the
  same, and `test/analyze.test.ts` runs it against `analyzeSession` to keep the two in step.
- **Research & suggestions** — the one-line lesson `/kaizen` wrote for that session. The
  server does **no** LLM calls and invents no advice; the qualitative judgment is
  entirely `/kaizen`'s.
- **Status badge** (`.an-status`) — `actioned` / `promoted` / `dropped` / `open`: did you
  ever act on the lesson? `/kaizen` records that by appending a `status` line to the same
  log; no line means still open. The same fact leads the row as `.an-dot`.

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
  transcript by **prefix-matching** the logged short id against
  `listTranscripts(projectsRoot())` (never joined into a path — same philosophy as
  `serveSessionDetail`; validated with `ID_RE`) → `analyzeSession(ref.file, ref.id)`
  live. `analysis` is `null` when the transcript is gone.
- **`reviewDue`** = lessons exist AND no `review:` marker within 7 days
  (`REVIEW_INTERVAL_DAYS` in `analytics.ts`; `now` injectable for tests). An empty log is
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
- **⚠️ Log grammar (the contract with `/kaizen` — three line shapes, all append-only):**

  ```
  - 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: <takeaway>.
  - 2026-08-09 [dashboard] d04e9b52: status actioned — added to project CLAUDE.md
  - 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2
  ```

  `parseLogEvents` classifies each line by the **first** pattern it matches (status →
  review → lesson), so a status note containing `Lesson:` can't be mistaken for a lesson.
  The older `parseSessionAnalyticsLog` is untouched (still used by `scan.ts`) and skips
  the two newer shapes — they lack `Lesson:` — so a log with status/review lines reads
  byte-for-byte as before to every pre-existing consumer. **Never add a line shape on one
  side only** (skill ↔ parser).
- **Status + review are why the log stays append-only.** A lesson's fate is recorded by
  appending a later `status` line, never by rewriting the original — the machine runs
  many sessions at once and a read-modify-write of a shared file loses concurrent entries
  silently. `AnalyticsReport.lessonStatus` is the newest status matching the session
  (prefix + newest-wins, mirroring `lessonForSession`); `null`/absent = still **open**.

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
    - .claude/skills/kaizen/
  kind: subsystem
  verified: f436519f31ef4120521792db7658e2bc5431f0e9
-->
