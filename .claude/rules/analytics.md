# Analytics section (session post-mortems)

An **Analytics** tab (third `SectionTabs` entry, persisted `dashboard.section`) shows the last
N (default 5) sessions the **`/kaizen` skill has logged**. `~/.claude/session-analytics-log.md` (one line
per `/kaizen` run) is the **sole trigger** — a session appears here only because `/kaizen`
logged it. For each logged session the server pairs the log line's **lesson** ("research &
suggestions") with a **live re-run** of the deterministic analyzer (`server/lib/analyze.ts`
`analyzeSession()` → `SessionAnalysis`: billable/context tokens, per-tool cost, subagent
breakdown, error signals). The server does **no** LLM calls and no heuristic advice — the
qualitative judgment is entirely `/kaizen`'s.

- **Read-only — no write path.** The dashboard never writes; `/kaizen` is the only producer.
  (An earlier design had an Inspect button + a `POST /api/analytics/inspect` that generated and
  persisted report JSON; that was removed in favor of letting `/kaizen` own report creation, so
  the app keeps its read-only invariant.)
- **Endpoint:** `GET /api/analytics` only (AnalyticsResponse: last N reports, newest-first,
  plus `lastReviewAt` / `reviewDue`). Handler `serveAnalytics` in `api.ts`; reader in
  `lib/analytics.ts` (`listReports`, `reviewStatus`); session-analytics-log parser in
  `lib/sessionAnalyticsLog.ts` (`parseSessionAnalyticsLog` / `recentLessons` / `parseLogEvents` /
  `statusForSession`). Both unit-tested.
- **⚠️ Log grammar (the contract with `/kaizen` — three line shapes, all append-only):**

  ```
  - 2026-07-12 [dashboard] d04e9b52: 210k billable (1.4M ctx), top cost Explore. Lesson: <takeaway>.
  - 2026-08-09 [dashboard] d04e9b52: status actioned — added to project CLAUDE.md
  - 2026-08-09 review: swept 12 lessons, promoted 1, pruned 2
  ```

  `parseLogEvents` classifies each line by the **first** pattern it matches (status → review →
  lesson), so a status note containing `Lesson:` can't be mistaken for a lesson. The older
  `parseSessionAnalyticsLog` is untouched (still used by `scan.ts`) and skips the two new shapes
  — they lack `Lesson:` — so a log with status/review lines reads byte-for-byte as before to
  every pre-existing consumer. **Never add a line shape on one side only** (skill ↔ parser).
- **Status + review are why the log stays append-only.** A lesson's fate is recorded by
  appending a later `status` line, never by rewriting the original — the machine runs many
  sessions at once and a read-modify-write of a shared file loses concurrent entries silently.
  `AnalyticsReport.lessonStatus` is the newest status matching the session (prefix + newest-wins,
  mirroring `lessonForSession`); `null`/absent = the lesson is still **open**.
- **`reviewDue`** = lessons exist AND no `review:` marker within 7 days (`REVIEW_INTERVAL_DAYS`
  in `analytics.ts`; `now` injectable for tests). An empty log is never "due". The client renders
  it as an `.an-review` chip in the section bar prompting `/kaizen review`; each card carries an
  `.an-status` badge (`actioned` / `promoted` / `dropped` / `open`).
- **How the reader works (`lib/analytics.ts`):** `readLogEvents` → `recentLessons(limit)` (dedupe
  by id-prefix, newest-first) → for each, resolve the transcript by **prefix-matching** the logged
  short id against `listTranscripts(projectsRoot())` (never joined into a path — same philosophy as
  `serveSessionDetail`; validated with `ID_RE`) → `analyzeSession(ref.file, ref.id)` live.
  `analysis` is `null` when the transcript is gone (card falls back to lesson-only); `project`
  then falls back to the session-analytics-log project tag.
- **No polling:** the list changes only when `/kaizen` runs. `AnalyticsView` is a `React.lazy`
  default export (own chunk); `useAnalytics` fetches on mount + manual ↻. `useAnalytics` is
  client-only.
- **Toggle:** `SHOW_ANALYTICS=false`, display cap `ANALYTICS_KEEP=<n>` (config.ts, default 5).
