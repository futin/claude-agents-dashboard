---
id: bug-8
title: Deleted sessions still show in the dashboard
created: 2026-08-29
tags: sessions, scan, ui
---

## Symptom

Deleting a session from the Claude Code desktop app's session list does not remove it
from the dashboard. The session keeps appearing in the Sessions view after the delete,
and survives the 3s poll — it is not a stale-render problem.

## Repro

1. Have the dashboard running (`pnpm dev`) with the Sessions view open.
2. In the Claude Code desktop app, delete a session from the session list.
3. Wait for at least one 3s poll cycle.
4. The deleted session is still listed in the dashboard.

## Affects

- `server/lib/scan.ts:102` — `listTranscripts()` returns every `.jsonl` under
  `~/.claude/projects/*/`, with no notion of a deleted, archived, or hidden session.
- `server/lib/scan.ts:107-130` — the readdir loop filters only on the `.jsonl` suffix.
- `server/lib/scan.ts:62` — `projectsRoot()`; the on-disk transcript tree is the sole
  source of the session list.
- Grep for `delete|hidden|dismiss` across `server/lib/scan.ts` and
  `server/lib/management.ts` returns nothing — there is no exclusion mechanism to fix,
  one has to be added.

## Cause

Confirmed on disk, not hypothesis: the desktop app's delete is an **archive**, and
archiving never touches the transcript.

The app keeps one JSON record per session at
`~/Library/Application Support/Claude/claude-code-sessions/<install-id>/<account-id>/local_<sessionId>.json`
(613 records on this machine). Each carries `isArchived: true|false` and `cliSessionId`.
Note the two ids are different things: the app's `sessionId` is `local_<uuid>`, while
`cliSessionId` is the uuid the `.jsonl` is named after. `cliSessionId` is the join key
between the app's list and `~/.claude/projects/`.

31 of those records are archived. The two whose activity falls inside Claude Code's
30-day transcript retention still have their transcript sitting on disk:

- `SD Docs Sync` → `projects/-Users-…-speach-development/6747da3e-b2f2-445a-802e-369daa27dbfe.jsonl`
  (2.9 MB, mtime 2026-08-22)
- `Tutor skill series organization` → `projects/-Users-…-guide-manager/6a901e8a-23ea-41c8-952c-110df9567f7a.jsonl`
  (1.5 MB, mtime 2026-08-26)

The other 26 archived records have no transcript only because *no* session that old does:
the oldest surviving top-level transcript is 2026-07-31, 29 days before today, matching the
default `cleanupPeriodDays: 30`. Age-based cleanup removed them, not the delete.

So the transcript outlives the delete, `listTranscripts()` (`server/lib/scan.ts:102`) still
returns it, and `scanSessions` keeps it in the candidate pool (`server/lib/scan.ts:229`) until
it ages out of the lookback window — 24 h by default, up to the 168 h cap in
`server/api.ts:63`. That is exactly the reported symptom: it survives the 3 s poll and
disappears only much later, by age.

There is no exclusion mechanism anywhere in the dashboard, so the fix is an addition.

## Fix

Read the app's own `isArchived` flag. No dashboard-side hide list is needed — the app
already records the deletion, and it records un-deletion for free (reopening from the
Archived list rewrites the record, so the session comes back on the next poll).

**1. New `server/lib/archived.ts`** — Node built-ins only, per the zero-runtime-deps rule.

- Glob `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json`. Both
  path segments must be wildcards: the first is an install id, the second an account id, and
  a second signed-in account adds a second directory.
- Produce `Set<string>` of `cliSessionId` for every record with `isArchived === true`.
- **Cache incrementally, keyed on each record's mtime — a full re-parse per poll is not
  affordable.** Measured on this machine: `glob` + `stat` of all 613 records is 3.7 ms, but
  parsing all 613 is 2318 ms, against a 3 s poll. The records are ~195 KB each (112 MB total)
  because they embed `remoteMcpServersConfig` with full tool descriptions. Stat-sweep every
  poll, re-parse only files whose mtime advanced. Archiving rewrites the record, so its mtime
  moves and the sweep notices within one poll.
- Fail open on every error — directory missing, unreadable, malformed JSON, non-macOS host:
  return an empty set, hide nothing. Records with no `cliSessionId` (67 live, 3 archived here)
  never started a CLI run and have no transcript; skip them.

**2. Apply the filter at the call sites, NOT inside `listTranscripts()`.** Filtering in
`listTranscripts()` is the tempting one-liner and it is wrong — four of its six callers must
keep seeing archived transcripts:

| Caller | Filter? | Why |
|---|---|---|
| `scan.ts:229` `scanSessions` | **yes** | the Sessions view — the actual bug |
| `management.ts:411` `listRecentProjects` | **yes** | a project whose only session was deleted should stop showing as recently active |
| `analytics.ts:47` `listReports` | **no** | resolves a kaizen log entry to its transcript; filtering would silently drophistorical reports |
| `api.ts:180,231,434,1008` | **no** | id lookups for the transcript/chat panels and `sessionExists`; a panel already open would 404 for no gain |

Thread the set (or a resolver function) into the two that filter, rather than letting
`scan.ts` reach for the Application Support path itself — that keeps the app-store dependency
in one file and keeps the existing tmpdir-fixture tests working with no store present.

**3. Test cases** (`test/`, tmpdir fixtures for both trees):

- archived `cliSessionId` → excluded from `scanSessions` output.
- unarchived record → still listed.
- record with no `cliSessionId` → ignored, no crash.
- store directory absent → nothing filtered (fail-open), all sessions listed.
- two account directories under one install id → records from both are read.
- record flipped `isArchived: false → true` with a bumped mtime → gone on the next call, and
  the untouched records were not re-parsed.
- `listReports` still resolves a transcript whose session is archived.

**Caveats to state in the PR, not to fix:**

- The store path is macOS-only. Linux/Windows fail open and filter nothing.
- A transcript with no app record — a plain terminal `claude` run, or a dashboard `-p` spawn —
  is never filtered. Correct: the app's list never showed it, so there is nothing to mirror.
- Archiving also stops the process and cleans the worktree, but only the `isArchived` flag
  matters here.
