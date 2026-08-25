# Analytics — kaizen-fed session post-mortems

An **Analytics** section (third `SideRail` entry, persisted `dashboard.section`) shows the
last N (default 5) sessions the **`/kaizen` skill has logged**.
`~/.claude/session-analytics-log.md` (one line per `/kaizen` run) is the **sole trigger** —
a session appears here only because `/kaizen` logged it. The dashboard never writes that
log; it only reads it. The `/kaizen` skill is **vendored** at `.claude/skills/kaizen/` so
collaborators can populate the tab against their own global log.

## What a card shows

- **The numbers** — a **live re-run** of the deterministic analyzer on every open
  (`server/lib/analyze.ts` `analyzeSession()` → `SessionAnalysis`): billable tokens (the
  real cost signal), total context tokens, subagent count + tokens, turn count,
  tool-error/retry counts, then the priciest tools and subagents.
- **Research & suggestions** — the one-line lesson `/kaizen` wrote for that session. The
  server does **no** LLM calls and invents no advice; the qualitative judgment is
  entirely `/kaizen`'s.
- **Status badge** (`.an-status`) — `actioned` / `promoted` / `dropped` / `open`: did you
  ever act on the lesson? `/kaizen` records that by appending a `status` line to the same
  log; no line means still open.

Workflow: run `/kaizen` in a Claude Code session → it appends a lesson → the session
appears in the tab (↻ to pull it in). If the transcript has since been deleted, the card
falls back to lesson-only (no live numbers) and `project` falls back to the log line's
project tag.

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
  never "due". The client renders it as an `.an-review` chip in the section bar prompting
  `/kaizen review` — the nudge to sweep accumulated lessons, promote recurring ones, and
  prune rules that stopped earning their keep.
- **No polling:** the list changes only when `/kaizen` runs. `AnalyticsView` is a
  `React.lazy` default export (own chunk); `useAnalytics` fetches on mount + manual ↻ and
  is client-only.
- **Toggles:** `SHOW_ANALYTICS=false` hides the tab, display cap `ANALYTICS_KEEP=<n>`
  (config.ts, default 5) — see [configuration](../workflows/configuration.md).

## Filter + sort

The tab mirrors the Sessions toolbar rather than inventing its own — `AnalyticsToolbar`
reuses the same `MultiSelect` widget and `.toolbar` CSS. Facets are **project**, **model**
(a report matches if *any* of its models is selected), a **logged-at window**, and a sort
key (recency / tokens / project) with a direction toggle. An empty facet array means "no
filter", not "match nothing".

`applyAnalyticsView` in `lib/analyticsFilterSort.ts` is pure — filter, then sort, no
mutation — and unit-tested in `test/analytics-filter-sort.test.ts`. Two deliberate
tolerances: a report whose transcript is gone (`analysis: null`) sorts as **0 tokens**
rather than dropping out of a token sort, and an unparseable `loggedAt` **fails open**
(kept) rather than being silently filtered away.

Windows are **day-granular** (`Any time` / 7 / 30 / 90 days) because `loggedAt` is a
`YYYY-MM-DD` date with no time-of-day — the Sessions view's "15 min / 1 hour" windows have
nothing to bite on here.

Cards are **collapsed by default** and expand on click. The toolbar selection persists to
`localStorage` under `dashboard.analyticsView` (see
[view-persistence](view-persistence.md)); which cards are expanded is deliberately
ephemeral, matching Sessions row-expansion. All of it is client-side over the payload
`GET /api/analytics` already returned — no backend change, so the read-only invariant
above still holds.

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
    - server/lib/sessionAnalyticsLog.ts
    - server/api.ts
    - client/src/components/analytics/
    - client/src/lib/analyticsFilterSort.ts
    - .claude/skills/kaizen/
  kind: subsystem
  verified: fa9fdbc0d1f74c5ba2d43f90ecb63806e5b39b14
-->
