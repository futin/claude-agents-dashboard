/**
 * sessionAnalyticsLog.ts — parse `~/.claude/session-analytics-log.md`, the append-only learning log
 * the `/kaizen` skill writes (one line per analyzed session, across all projects).
 *
 * Three line shapes (see the kaizen skill — this parser and that skill are the
 * two halves of one contract; never change one alone):
 *   - <date> [<project>] <session-id>: <billable> billable (<ctx>), top cost <x>. Lesson: <text>.
 *   - <date> [<project>] <session-id>: status actioned — added to project CLAUDE.md
 *   - <date> review: swept 12 lessons, promoted 1, pruned 2
 *
 * The log is **append-only** — a lesson's fate is recorded by appending a later
 * `status` line, never by editing the original. That is what makes it safe for
 * the parallel sessions this dashboard exists to watch: concurrent appends can't
 * lose each other's work the way a read-modify-write rewrite can.
 *
 * The `<session-id>` is a short prefix of the full transcript UUID (e.g.
 * `d04e9b52`). We surface the `Lesson:` text as the Analytics tab's
 * "research & suggestions" — the only human/Claude-authored judgment on disk.
 *
 * Pure + fail-open: unparseable lines are skipped, a missing file yields `[]`,
 * never throws.
 */

import fs from 'node:fs';
import path from 'node:path';

import { claudeHome } from './management.js';
import type { LessonStatus } from '../../shared/types.js';

/** One parsed session-analytics-log entry. */
export interface SessionAnalyticsLesson {
  /** YYYY-MM-DD as written in the log. */
  date: string;
  /** Project tag (`[project]`). */
  project: string;
  /** Session-id prefix as written — a prefix of the full transcript UUID. */
  idPrefix: string;
  /** The `Lesson:` text (trailing period preserved as written). */
  lesson: string;
}

/** A `status` line: what became of one session's lesson. */
export interface SessionAnalyticsStatus extends LessonStatus {
  /** Project tag (`[project]`). */
  project: string;
  /** Session-id prefix as written — a prefix of the full transcript UUID. */
  idPrefix: string;
}

/** Everything the log carries, in one pass. */
export interface SessionAnalyticsEvents {
  /** Lesson lines, file order (oldest-first). */
  lessons: SessionAnalyticsLesson[];
  /** Status lines, file order (oldest-first). */
  statuses: SessionAnalyticsStatus[];
  /** Newest `review:` marker date (YYYY-MM-DD), or null if the log has none. */
  lastReviewDate: string | null;
}

/** Absolute path to the global session-analytics log. */
export function sessionAnalyticsLogPath(homeDir?: string): string {
  return path.join(claudeHome(homeDir), 'session-analytics-log.md');
}

// - <date> [<project>] <id>: …prose… Lesson: <text>
const LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(\S+?):\s+.*?\bLesson:\s*(.+)$/;

// - <date> [<project>] <id>: status actioned — <note>   (note optional)
const STATUS_RE =
  /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(\S+?):\s+status\s+(actioned|promoted|dropped)\b\s*(?:[—–-]\s*(.*))?$/i;

// - <date> review: <summary>
const REVIEW_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+review\b\s*:?/i;

/** Parse the log body into entries (file order = chronological, oldest-first). */
export function parseSessionAnalyticsLog(text: string): SessionAnalyticsLesson[] {
  if (typeof text !== 'string') return [];
  const out: SessionAnalyticsLesson[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    out.push({ date: m[1], project: m[2], idPrefix: m[3], lesson: m[4].trim() });
  }
  return out;
}

/**
 * Parse every line shape in one pass. A line is classified by the first pattern
 * it matches (status → review → lesson), so a status note containing the word
 * `Lesson:` can never be mistaken for a lesson. Malformed lines are skipped, as
 * everywhere else here.
 */
export function parseLogEvents(text: string): SessionAnalyticsEvents {
  const out: SessionAnalyticsEvents = { lessons: [], statuses: [], lastReviewDate: null };
  if (typeof text !== 'string') return out;

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    const s = STATUS_RE.exec(line);
    if (s) {
      const note = (s[5] ?? '').trim();
      out.statuses.push({
        date: s[1],
        project: s[2],
        idPrefix: s[3],
        status: s[4].toLowerCase() as LessonStatus['status'],
        ...(note ? { note } : {})
      });
      continue;
    }

    const r = REVIEW_RE.exec(line);
    if (r) {
      // Dates are YYYY-MM-DD, so string compare is date compare — take the max
      // rather than trusting the file to be chronological.
      if (!out.lastReviewDate || r[1] > out.lastReviewDate) out.lastReviewDate = r[1];
      continue;
    }

    const m = LINE_RE.exec(line);
    if (m) out.lessons.push({ date: m[1], project: m[2], idPrefix: m[3], lesson: m[4].trim() });
  }

  return out;
}

/**
 * The newest status recorded for a session, or null while its lesson is still
 * open. Prefix match + newest-wins, mirroring {@link lessonForSession}.
 */
export function statusForSession(
  statuses: SessionAnalyticsStatus[], sessionId: string
): LessonStatus | null {
  if (!sessionId) return null;
  for (let i = statuses.length - 1; i >= 0; i--) {
    const s = statuses[i];
    if (!sessionId.startsWith(s.idPrefix)) continue;
    return s.note ? { status: s.status, date: s.date, note: s.note } : { status: s.status, date: s.date };
  }
  return null;
}

/** Read + parse every line shape at `logPath` (default: global). Empty if unreadable. */
export function readLogEvents(logPath = sessionAnalyticsLogPath()): SessionAnalyticsEvents {
  let text: string;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return { lessons: [], statuses: [], lastReviewDate: null };
  }
  return parseLogEvents(text);
}

/** Read + parse the log at `logPath` (default: global). `[]` if unreadable. */
export function readSessionAnalyticsLog(logPath = sessionAnalyticsLogPath()): SessionAnalyticsLesson[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return parseSessionAnalyticsLog(text);
}

/**
 * The lesson for a session, or null. Matches where the logged `idPrefix` is a
 * prefix of the full session UUID; newest match wins (entries are oldest-first,
 * so scan in reverse).
 */
export function lessonForSession(lessons: SessionAnalyticsLesson[], sessionId: string): string | null {
  if (!sessionId) return null;
  for (let i = lessons.length - 1; i >= 0; i--) {
    if (sessionId.startsWith(lessons[i].idPrefix)) return lessons[i].lesson;
  }
  return null;
}

/**
 * The last `limit` distinct sessions in the log, newest-first. A session logged
 * more than once keeps only its newest entry (entries are oldest-first, so scan
 * in reverse and dedupe by `idPrefix`).
 */
export function recentLessons(lessons: SessionAnalyticsLesson[], limit: number): SessionAnalyticsLesson[] {
  const seen = new Set<string>();
  const out: SessionAnalyticsLesson[] = [];
  for (let i = lessons.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lessons[i];
    if (seen.has(l.idPrefix)) continue;
    seen.add(l.idPrefix);
    out.push(l);
  }
  return out;
}
