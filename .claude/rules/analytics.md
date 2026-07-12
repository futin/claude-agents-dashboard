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
- **Endpoint:** `GET /api/analytics` only (AnalyticsResponse: last N reports, newest-first).
  Handler `serveAnalytics` in `api.ts`; reader in `lib/analytics.ts` (`listReports`);
  session-analytics-log parser in `lib/sessionAnalyticsLog.ts` (`parseSessionAnalyticsLog` / `recentLessons`). Both unit-tested.
- **How the reader works (`lib/analytics.ts`):** `readSessionAnalyticsLog` → `recentLessons(limit)` (dedupe
  by id-prefix, newest-first) → for each, resolve the transcript by **prefix-matching** the logged
  short id against `listTranscripts(projectsRoot())` (never joined into a path — same philosophy as
  `serveSessionDetail`; validated with `ID_RE`) → `analyzeSession(ref.file, ref.id)` live.
  `analysis` is `null` when the transcript is gone (card falls back to lesson-only); `project`
  then falls back to the session-analytics-log project tag.
- **No polling:** the list changes only when `/kaizen` runs. `AnalyticsView` is a `React.lazy`
  default export (own chunk); `useAnalytics` fetches on mount + manual ↻. `useAnalytics` is
  client-only.
- **Toggle:** `SHOW_ANALYTICS=false`, display cap `ANALYTICS_KEEP=<n>` (config.ts, default 5).
