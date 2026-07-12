/**
 * scan.ts — enumerate Claude Code session transcripts under ~/.claude/projects,
 * parse the most-recent ones, and build the ranked session list.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readTranscript } from './transcript.js';
import { readSessionAnalyticsLog, lessonForSession } from './sessionAnalyticsLog.js';
import type { SessionAnalyticsLesson } from './sessionAnalyticsLog.js';
import type { Config } from './config.js';
import type { Session, SessionsResponse } from '../../shared/types.js';

interface TranscriptRef {
  file: string;
  dirName: string;
  id: string;
  mtimeMs: number;
}

interface ScanOptions {
  homeDir?: string;
  now?: number;
  root?: string;
  skipProcScan?: boolean;
  /** Override the live-cwd set (tests). null disables gating; undefined probes. */
  liveCwds?: Set<string> | null;
  /** Override kaizen lessons (tests). null skips tagging; undefined reads the log. */
  lessons?: SessionAnalyticsLesson[] | null;
}

/** Default transcripts root. */
export function projectsRoot(homeDir?: string): string {
  return path.join(homeDir || os.homedir(), '.claude', 'projects');
}

/**
 * Best-effort human label for a project when no cwd is available: decode the
 * Claude Code directory name (`-a-b-c` → `a/b/c`) and take the basename.
 * Lossy (can't distinguish `/` from original `-`), so only a fallback.
 */
export function decodeProjectName(dirName: string): string {
  const decoded = String(dirName).replace(/^-/, '').replace(/-/g, '/');
  const base = decoded.split('/').filter(Boolean).pop();
  return base || dirName;
}

/** List every `.jsonl` transcript with its mtime, across all project dirs. */
export function listTranscripts(root: string): TranscriptRef[] {
  const results: TranscriptRef[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      results.push({ file: full, dirName: d.name, id: name.replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs });
    }
  }
  return results;
}

/** Count running `claude` processes (informational cross-check). */
export function countClaudeProcesses(): number | null {
  try {
    const out = execFileSync('ps', ['-Ao', 'comm='], { encoding: 'utf8', timeout: 2000 });
    return out.split('\n').filter(l => /(^|\/)claude$/.test(l.trim())).length;
  } catch {
    return null;
  }
}

/** Strip a trailing slash so cwd strings compare consistently. */
function normCwd(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Working directories of every running `claude` CLI process, via `lsof`.
 * The transcript records a session's `cwd`; if no live process shares it, the
 * session is dead (closed/cleaned) and cannot be actively working.
 *
 * Returns `null` when the probe can't run (no lsof, timeout, error) — callers
 * fail open and skip liveness gating rather than mislabel every session dead.
 *
 * `-c claude` is case-sensitive, so it matches only the lowercase CLI binary,
 * not the capital-`C` `Claude.app` desktop shell. Granularity is per-cwd: two
 * sessions in the same directory can't be told apart, so a dead session sharing
 * a directory with a live one still reads live.
 */
export function liveCwds(): Set<string> | null {
  try {
    const out = execFileSync('lsof', ['-c', 'claude', '-a', '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000
    });
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.startsWith('n') && line.length > 1) set.add(normCwd(line.slice(1)));
    }
    return set;
  } catch {
    return null;
  }
}

/** Build the ranked session snapshot. */
export function scanSessions(config: Partial<Config>, options: ScanOptions = {}): SessionsResponse {
  const cfg = config || {};
  const maxSessions = (cfg.maxSessions ?? 0) > 0 ? (cfg.maxSessions as number) : 5;
  const activeWindowMin = (cfg.activeWindowMin ?? 0) > 0 ? (cfg.activeWindowMin as number) : 5;
  const lookbackHours = (cfg.lookbackHours ?? 0) > 0 ? (cfg.lookbackHours as number) : 24;

  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const root = options.root || projectsRoot(options.homeDir);

  const lookbackMs = lookbackHours * 60 * 60 * 1000;
  const activeMs = activeWindowMin * 60 * 1000;

  const candidates = listTranscripts(root)
    .filter(t => now - t.mtimeMs <= lookbackMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessions);

  // Set of cwds with a live `claude` process. null = probe skipped/unavailable
  // → fail open (no gating). A session whose cwd is absent has no live process,
  // so it can't be working/pending — force it to idle regardless of transcript.
  const live = options.liveCwds !== undefined
    ? options.liveCwds
    : options.skipProcScan ? null : liveCwds();

  // `/kaizen` lessons keyed to each session by UUID-prefix match. Read once per
  // scan (tiny, fail-open file). Skipped when analytics is disabled or injected
  // (tests). null ⇒ no tagging → every session's kaizenLesson stays null.
  const lessons = options.lessons !== undefined
    ? options.lessons
    : cfg.showAnalytics === false ? null : readSessionAnalyticsLog();

  const sessions: Session[] = [];
  for (const c of candidates) {
    const parsed = readTranscript(c.file);
    if (!parsed) continue;
    // Skip transcripts with no conversational message: a session just started or
    // just `/clear`ed writes a fresh UUID file holding only queue-operation/
    // attachment/meta records. Its fresh mtime would read recent + turnComplete
    // = "incomplete", showing a phantom "pending" row beside the real session
    // (which `/clear` abandoned). Nothing to display → drop it.
    if (!parsed.hasMessages) continue;
    const projectPath = parsed.cwd || null;
    const project = projectPath ? (projectPath.split('/').filter(Boolean).pop() || projectPath) : decodeProjectName(c.dirName);
    // Recency tracks real agent activity, not file touches: selecting a session
    // in Claude Code appends timestamp-less mode/last-prompt/custom-title records
    // that bump the file mtime without any turn happening. Use the newest
    // conversational message's timestamp; fall back to mtime only if absent.
    const lastMsgMs = parsed.lastMessageTs ? Date.parse(parsed.lastMessageTs) : NaN;
    const activityMs = Number.isFinite(lastMsgMs) ? lastMsgMs : c.mtimeMs;
    const recent = now - activityMs <= activeMs;
    let status: Session['status'];
    // Dead process (cwd not in the live set) → nothing is running and nothing
    // will resume on its own, so the session is idle no matter what the last
    // transcript record implies (interrupted mid-turn, unanswered question…).
    const dead = live !== null && projectPath !== null && !live.has(normCwd(projectPath));
    if (dead) status = 'idle';                                         // gray — no live process
    else if (parsed.waitingOnQuestion) status = 'question';            // blue — needs an answer, beats all
    else if (recent && !parsed.turnComplete) status = 'working';       // green — machine actively churning
    else if (parsed.turnComplete && !recent) status = 'idle';          // gray — finished and dormant
    else status = 'incomplete';                                        // yellow — your turn (recent+done) OR stalled (stale+pending)
    sessions.push({
      id: c.id,
      project,
      projectPath,
      sessionName: parsed.sessionName || null,
      gitBranch: parsed.gitBranch || null,
      model: parsed.model || '',
      tokens: parsed.tokens,
      contextWindow: parsed.contextWindow,
      contextWindowLabel: parsed.contextWindowLabel,
      contextPct: parsed.contextPct,
      status,
      activity: parsed.activity,
      lastTimestamp: parsed.lastTimestamp,
      updatedMs: c.mtimeMs,
      version: parsed.version || null,
      kaizenLesson: lessons ? lessonForSession(lessons, c.id) : null
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    activeWindowMin,
    maxSessions,
    runningClaudeProcs: options.skipProcScan ? null : countClaudeProcesses(),
    totals: {
      shown: sessions.length,
      active: sessions.filter(s => s.status === 'working').length
    },
    sessions
  };
}
