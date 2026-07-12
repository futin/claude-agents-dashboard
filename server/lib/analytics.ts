/**
 * analytics.ts — read-only view of the sessions `/kaizen` has logged.
 *
 * `~/.claude/session-analytics-log.md` is the sole trigger: for each of the last N distinct
 * logged sessions we pair the log line's `lesson` with a LIVE re-run of
 * {@link analyzeSession} (the deterministic post-mortem). Nothing is written —
 * this restores the app's read-only invariant. `/kaizen` produces; the dashboard
 * only reads.
 *
 * A logged session id is a short prefix (e.g. `d04e9b52`); it's resolved to a
 * transcript by prefix-matching the enumerated transcript list, never joined
 * into a path (same philosophy as `serveSessionDetail`).
 */

import path from 'node:path';

import { analyzeSession } from './analyze.js';
import { listTranscripts, projectsRoot } from './scan.js';
import { claudeHome } from './management.js';
import { readSessionAnalyticsLog, recentLessons } from './sessionAnalyticsLog.js';
import type { AnalyticsReport } from '../../shared/types.js';

/** Logged ids are transcript UUID prefixes — restrict to safe chars (mirrors api.ts). */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/** basename of a cwd, or the fallback (the session-analytics-log project tag). */
function projectName(cwd: string | null, fallback: string): string {
  if (!cwd) return fallback || 'unknown';
  return path.basename(cwd) || fallback || 'unknown';
}

/**
 * The last `limit` logged sessions, newest-first. Each report pairs the
 * session-analytics-log lesson with a live analysis (null if the transcript is gone).
 * Pure read; fails open to [] only at the caller.
 */
export function listReports(limit: number, opts: { homeDir?: string } = {}): AnalyticsReport[] {
  const lessons = readSessionAnalyticsLog(path.join(claudeHome(opts.homeDir), 'session-analytics-log.md'));
  const recent = recentLessons(lessons, limit);
  if (!recent.length) return [];

  const transcripts = listTranscripts(projectsRoot(opts.homeDir));

  return recent.map(entry => {
    const ref = ID_RE.test(entry.idPrefix)
      ? transcripts.find(t => t.id.startsWith(entry.idPrefix))
      : undefined;
    const analysis = ref ? analyzeSession(ref.file, ref.id) : null;
    return {
      sessionId: ref?.id ?? entry.idPrefix,
      project: projectName(analysis?.cwd ?? null, entry.project),
      cwd: analysis?.cwd ?? null,
      models: analysis?.models ?? [],
      loggedAt: entry.date,
      analysis,
      lesson: entry.lesson
    };
  });
}
