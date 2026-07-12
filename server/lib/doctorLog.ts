/**
 * doctorLog.ts — parse `~/.claude/doctor-log.md`, the append-only learning log
 * the `/doctor` skill writes (one line per analyzed session, across all projects).
 *
 * Line shape (see the doctor skill):
 *   - <date> [<project>] <session-id>: <billable> billable (<ctx>), top cost <x>. Lesson: <text>.
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

/** One parsed doctor-log entry. */
export interface DoctorLesson {
  /** YYYY-MM-DD as written in the log. */
  date: string;
  /** Project tag (`[project]`). */
  project: string;
  /** Session-id prefix as written — a prefix of the full transcript UUID. */
  idPrefix: string;
  /** The `Lesson:` text (trailing period preserved as written). */
  lesson: string;
}

/** Absolute path to the global doctor log. */
export function doctorLogPath(homeDir?: string): string {
  return path.join(claudeHome(homeDir), 'doctor-log.md');
}

// - <date> [<project>] <id>: …prose… Lesson: <text>
const LINE_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(\S+?):\s+.*?\bLesson:\s*(.+)$/;

/** Parse the log body into entries (file order = chronological, oldest-first). */
export function parseDoctorLog(text: string): DoctorLesson[] {
  if (typeof text !== 'string') return [];
  const out: DoctorLesson[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    out.push({ date: m[1], project: m[2], idPrefix: m[3], lesson: m[4].trim() });
  }
  return out;
}

/** Read + parse the log at `logPath` (default: global). `[]` if unreadable. */
export function readDoctorLog(logPath = doctorLogPath()): DoctorLesson[] {
  let text: string;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  return parseDoctorLog(text);
}

/**
 * The lesson for a session, or null. Matches where the logged `idPrefix` is a
 * prefix of the full session UUID; newest match wins (entries are oldest-first,
 * so scan in reverse).
 */
export function lessonForSession(lessons: DoctorLesson[], sessionId: string): string | null {
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
export function recentLessons(lessons: DoctorLesson[], limit: number): DoctorLesson[] {
  const seen = new Set<string>();
  const out: DoctorLesson[] = [];
  for (let i = lessons.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lessons[i];
    if (seen.has(l.idPrefix)) continue;
    seen.add(l.idPrefix);
    out.push(l);
  }
  return out;
}
