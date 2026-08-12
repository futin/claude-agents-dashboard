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
import { readLogEvents, recentLessons, statusForSession } from './sessionAnalyticsLog.js';
import type { AnalyticsReport } from '../../shared/types.js';

/** Logged ids are transcript UUID prefixes — restrict to safe chars (mirrors api.ts). */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/** The global log path, honouring an injected home dir (tests). */
function logPath(homeDir?: string): string {
  return path.join(claudeHome(homeDir), 'session-analytics-log.md');
}

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
  const { lessons, statuses } = readLogEvents(logPath(opts.homeDir));
  const recent = recentLessons(lessons, limit);
  if (!recent.length) return [];

  const transcripts = listTranscripts(projectsRoot(opts.homeDir));

  return recent.map(entry => {
    const ref = ID_RE.test(entry.idPrefix)
      ? transcripts.find(t => t.id.startsWith(entry.idPrefix))
      : undefined;
    const analysis = ref ? analyzeSession(ref.file, ref.id) : null;
    const sessionId = ref?.id ?? entry.idPrefix;
    return {
      sessionId,
      project: projectName(analysis?.cwd ?? null, entry.project),
      cwd: analysis?.cwd ?? null,
      models: analysis?.models ?? [],
      loggedAt: entry.date,
      analysis,
      lesson: entry.lesson,
      lessonStatus: statusForSession(statuses, sessionId)
    };
  });
}

/** A review is stale after this many days without a `review:` marker. */
const REVIEW_INTERVAL_DAYS = 7;

/**
 * Whether the log is due a sweep. `reviewDue` is true only when there are
 * lessons to sweep AND no `review:` marker landed in the last
 * {@link REVIEW_INTERVAL_DAYS} days — a fresh install with an empty log is never
 * "due". Fails open to not-due if the log can't be read.
 */
export function reviewStatus(
  opts: { homeDir?: string; now?: Date } = {}
): { lastReviewAt: string | null; reviewDue: boolean } {
  const { lessons, lastReviewDate } = readLogEvents(logPath(opts.homeDir));
  if (!lessons.length) return { lastReviewAt: lastReviewDate, reviewDue: false };

  const ms = lastReviewDate ? Date.parse(`${lastReviewDate}T00:00:00Z`) : NaN;
  // No marker (or an unreadable one) means nothing has ever swept the log — due.
  if (!Number.isFinite(ms)) return { lastReviewAt: lastReviewDate, reviewDue: true };

  const days = ((opts.now ?? new Date()).getTime() - ms) / 86_400_000;
  return { lastReviewAt: lastReviewDate, reviewDue: days > REVIEW_INTERVAL_DAYS };
}
