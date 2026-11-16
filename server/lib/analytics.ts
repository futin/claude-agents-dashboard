/**
 * analytics.ts — read-only view of the sessions `/kaizen` has logged.
 *
 * `~/.claude/session-analytics-log.md` is the sole trigger: for each of the last N distinct
 * logged sessions we pair the log line's `lesson` with a run of {@link analyzeSession}
 * (the deterministic post-mortem), re-run whenever the main transcript or its `subagents/`
 * dir changed and otherwise served from an in-memory memo of the last N. Nothing is written —
 * this restores the app's read-only invariant. `/kaizen` produces; the dashboard
 * only reads.
 *
 * A logged session id is a short prefix (e.g. `d04e9b52`); it's resolved to a
 * transcript by prefix-matching the enumerated transcript list, never joined
 * into a path (same philosophy as `serveSessionDetail`).
 */

import fs from 'node:fs';
import path from 'node:path';

import { analyzeSession } from './analyze.js';
import { findTranscriptByPrefix, listTranscripts, projectsRoot } from './scan.js';
import type { TranscriptRef } from './scan.js';
import { subagentDirOf } from './subagent-usage.js';
import { claudeHome } from './paths.js';
import { readLogEvents, recentLessons, statusForSession, verdictForSession } from './sessionAnalyticsLog.js';
import type { AnalyticsReport, SessionAnalysis } from '../../shared/types.js';

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

/** Subagent files whose change must re-run the analysis: transcripts and their `.meta.json` sidecars. */
const SUBAGENT_FILE_RE = /^agent-.+\.(?:jsonl|meta\.json)$/;

/**
 * The `subagents/` dir's listing as `name:mtimeMs:size`, sorted by name — in the key because a synchronous Agent call writes its subagent
 * transcript while the main transcript sits unchanged. An absent or unreadable dir signs as '', an entry whose stat throws is left out.
 */
function subagentDirSignature(mainPath: string): string {
  const dir = subagentDirOf(mainPath);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const parts: string[] = [];
  for (const name of names.filter(n => SUBAGENT_FILE_RE.test(n)).sort()) {
    try {
      const st = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch { /* gone between readdir and stat — leave it out */ }
  }
  return parts.join('|');
}

/** What an analysis was computed from; equal keys mean the same files on disk. */
function analysisKey(ref: TranscriptRef): string {
  return JSON.stringify([ref.mtimeMs, ref.size, ref.id, subagentDirSignature(ref.file)]);
}

/** Memoised analyses by transcript path, pruned to the paths the latest {@link listReports} call looked up. */
const analysisCache = new Map<string, { key: string; analysis: SessionAnalysis }>();

/** The memoised analysis when the transcript and its subagent dir are unchanged, else a fresh one. A null result is never stored. */
function cachedAnalysis(ref: TranscriptRef): SessionAnalysis | null {
  const key = analysisKey(ref);
  const hit = analysisCache.get(ref.file);
  if (hit && hit.key === key) return hit.analysis;
  const analysis = analyzeSession(ref.file, ref.id);
  if (analysis) analysisCache.set(ref.file, { key, analysis });
  else analysisCache.delete(ref.file);
  return analysis;
}

/** Test hook: drop every memoised analysis. */
export function _resetAnalyticsCache(): void {
  analysisCache.clear();
}

/** Test hook: how many analyses are memoised. */
export function _analyticsCacheSize(): number {
  return analysisCache.size;
}

/**
 * The last `limit` logged sessions, newest-first. Each report pairs the
 * session-analytics-log lesson with an analysis of the transcript as it is on disk now
 * (null if the transcript is gone), memoised while the transcript and its subagent dir are
 * unchanged. The report's other fields are rebuilt every call — the log can change while
 * the transcript does not. Fails open to [] only at the caller.
 */
export function listReports(limit: number, opts: { homeDir?: string } = {}): AnalyticsReport[] {
  const { lessons, statuses, verdicts } = readLogEvents(logPath(opts.homeDir));
  const recent = recentLessons(lessons, limit);
  if (!recent.length) { analysisCache.clear(); return []; }

  const transcripts = listTranscripts(projectsRoot(opts.homeDir));
  const looked = new Set<string>();

  const reports = recent.map(entry => {
    const ref = ID_RE.test(entry.idPrefix)
      ? findTranscriptByPrefix(transcripts, entry.idPrefix)
      : undefined;
    if (ref) looked.add(ref.file);
    const analysis = ref ? cachedAnalysis(ref) : null;
    const sessionId = ref?.id ?? entry.idPrefix;
    return {
      sessionId,
      project: projectName(analysis?.cwd ?? null, entry.project),
      cwd: analysis?.cwd ?? null,
      models: analysis?.models ?? [],
      loggedAt: entry.date,
      analysis,
      lesson: entry.lesson,
      ...(entry.fields ? { lessonFields: entry.fields } : {}),
      ...(entry.none ? { lessonNone: true } : {}),
      lessonStatus: statusForSession(statuses, sessionId),
      lessonVerdict: verdictForSession(verdicts, sessionId)
    };
  });
  // Bound: a session that dropped out of the last N is released.
  for (const file of analysisCache.keys()) if (!looked.has(file)) analysisCache.delete(file);
  return reports;
}

/** A review is stale after this many days without a `review:` marker. */
const REVIEW_INTERVAL_DAYS = 7;

/**
 * Whether the log is due a sweep. `reviewDue` is true only when there are
 * lessons to sweep AND no `review:` marker landed in the last
 * {@link REVIEW_INTERVAL_DAYS} days — a fresh install with an empty log is never
 * "due", and neither is one holding only `none` lessons, which are born closed.
 * Fails open to not-due if the log can't be read.
 */
export function reviewStatus(
  opts: { homeDir?: string; now?: Date } = {}
): { lastReviewAt: string | null; reviewDue: boolean } {
  const { lessons, lastReviewDate } = readLogEvents(logPath(opts.homeDir));
  if (!lessons.some(l => !l.none)) return { lastReviewAt: lastReviewDate, reviewDue: false };

  const ms = lastReviewDate ? Date.parse(`${lastReviewDate}T00:00:00Z`) : NaN;
  // No marker (or an unreadable one) means nothing has ever swept the log — due.
  if (!Number.isFinite(ms)) return { lastReviewAt: lastReviewDate, reviewDue: true };

  const days = ((opts.now ?? new Date()).getTime() - ms) / 86_400_000;
  return { lastReviewAt: lastReviewDate, reviewDue: days > REVIEW_INTERVAL_DAYS };
}
