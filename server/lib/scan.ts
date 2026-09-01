/**
 * scan.ts — enumerate Claude Code session transcripts under ~/.claude/projects,
 * parse the most-recent ones, and build the ranked session list.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readTranscript } from './transcript.js';
import { refreshCwd } from './token-refresh.js';
import { readSessionAnalyticsLog, lessonForSession } from './sessionAnalyticsLog.js';
import type { SessionAnalyticsLesson } from './sessionAnalyticsLog.js';
import type { Config } from './config.js';
import type { Session, SessionSurface, SessionsResponse } from '../../shared/types.js';

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
  /**
   * Sessions with a remote-answer wait held right now (`pending.ts`
   * `pendingSessionIds()`), injected by the handler so this module stays pure and
   * free of the store. Omitted/null ⇒ no session is flagged.
   */
  pendingIds?: ReadonlySet<string> | null;
  /**
   * Sessions with a remote plan wait held right now (`plans.ts`
   * `planSessionIds()`). Same injection rule and same lead over the transcript
   * as {@link pendingIds}. Omitted/null ⇒ no session is flagged.
   */
  planIds?: ReadonlySet<string> | null;
  /**
   * Sessions holding a turn-end reply window, same injected-Set pattern as
   * {@link pendingIds}. Omitted/null ⇒ no session is flagged.
   */
  messageIds?: ReadonlySet<string> | null;
  /**
   * Sessions the PermissionRequest hook reported as showing a permission dialog
   * (`permissions.ts` `permissionWaits()`), as `sessionId → notifiedAt` epoch ms,
   * injected by the handler so this module stays free of the store. A flag is
   * ignored once the transcript has advanced past `notifiedAt` — answering the
   * dialog, either way, appends a record. Omitted/null ⇒ no session is flagged.
   */
  permissionWaits?: ReadonlyMap<string, number> | null;
  /**
   * Transcript ids the desktop app has archived — "deleted" in its session list
   * (`archived.ts` `archivedSessionIds()`), injected by the handler so this
   * module never reaches into the app's own store. Omitted/null ⇒ nothing is
   * hidden, which is also what every tmpdir fixture wants.
   */
  archivedIds?: ReadonlySet<string> | null;
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

/** The transcript `entrypoint` value a headless `claude -p` run writes. */
const HEADLESS_ENTRYPOINT = 'sdk-cli';

/**
 * Which surfaces a session exists on, from the transcript's own `entrypoint`
 * (see {@link SessionSurface} for what each value promises the reader).
 *
 * Only `sdk-cli` — a headless `-p` run, which is what a dashboard spawn is —
 * earns `dashboard`. Everything else, **an unrecognized or absent value
 * included**, is `local`: the failure direction matters, because `local` is the
 * unremarkable case that prints no pill, while a wrong `dashboard` would tell
 * you a session is invisible to the desktop app when it is sitting in its
 * sidebar. Under-claiming loses a pill; over-claiming makes the row lie.
 *
 * The known imprecision, in the honest direction: `sdk-cli` says *headless*,
 * not *launched by this dashboard*. Another SDK launcher on this machine reads
 * the same — and the pill's claim (no other surface lists this session) is
 * still true for it. Precise attribution would need a record of the ids
 * `launch()` minted, which the RAM-only launch store deliberately does not
 * keep past adoption (see `docs/subsystems/spawn.md`).
 */
export function sessionSurface(entrypoint: string | null | undefined): SessionSurface {
  return entrypoint === HEADLESS_ENTRYPOINT ? 'dashboard' : 'local';
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

/**
 * Newest conversational message in one session's transcript, in ms — or null
 * when the session is unknown, unreadable, or has no stamped message yet.
 *
 * The staleness probe behind the remote stores' `sweepDecided`. Deliberately
 * `lastMessageTs` and not `lastTimestamp`: hook and queue-operation records bump
 * the file without a turn happening, and treating one of those as "the terminal
 * decided it" would yank a plan out of the dashboard while it was still live.
 * Same field, and so the same fail direction, as the `permissionWait` gate in
 * {@link scanSessions}.
 *
 * Known imprecision, inherited from that gate: `readTranscript` does not filter
 * sidechains, so a subagent writing while the main thread is parked on a wait
 * would read as the session moving on. It needs a single assistant message that
 * pairs a `Task` call with the wait tool, and it fails toward the terminal card
 * — the direction this subsystem always prefers — so it is documented rather
 * than guarded.
 */
export function lastMessageMs(root: string, sessionId: string): number | null {
  let ref: TranscriptRef | undefined;
  try { ref = listTranscripts(root).find(t => t.id === sessionId); }
  catch { return null; }
  if (!ref) return null;
  const parsed = readTranscript(ref.file);
  if (!parsed || !parsed.lastMessageTs) return null;
  const ms = Date.parse(parsed.lastMessageTs);
  return Number.isFinite(ms) ? ms : null;
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
 * Pids of every running `claude` CLI process, from `ps -Ao pid=,comm=` stdout.
 *
 * Matches comm against `/(^|\/)claude$/` — the same test `countClaudeProcesses`
 * uses, so the two can no longer disagree. Comm is everything after the pid and
 * may contain spaces (`…/Application Support/Claude/…`), so the split is at the
 * first whitespace run only.
 */
export function parsePsClaudePids(out: string): string[] {
  const pids: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m && /(^|\/)claude$/.test(m[2])) pids.push(m[1]);
  }
  return pids;
}

/** Cwd set from `lsof … -Fn` stdout. Non-`n` lines and a bare `n` are ignored. */
export function parseLsofCwds(out: string): Set<string> {
  const set = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.startsWith('n') && line.length > 1) set.add(normCwd(line.slice(1)));
  }
  return set;
}

/**
 * The live-cwd set from both probes' stdout, or `null` to skip the gate.
 *
 * Fail open on every uncertain input — a `null` here costs a stalled session a
 * yellow badge instead of a gray one, while a wrongly empty set would mark
 * *every* session dead, which is exactly the bug this replaced. So: `ps` failed,
 * `ps` matched no pid at all (a launcher we no longer recognize), or `lsof`
 * produced nothing usable all return `null`.
 */
export function composeLiveCwds(psOut: string | null, lsofOut: string | null): Set<string> | null {
  if (psOut === null) return null;
  if (parsePsClaudePids(psOut).length === 0) return null;
  if (lsofOut === null) return null;
  const set = parseLsofCwds(lsofOut);
  // Pids exist but lsof named no cwd: it answered nothing usable, so fail open
  // rather than let an empty set condemn every session.
  return set.size === 0 ? null : set;
}

/**
 * The stdout of a *failed* `lsof` run, when it can still be trusted.
 *
 * A non-zero exit is normal here — lsof warns and exits 1 on processes it may
 * not inspect, having already printed the ones it could, so that stdout is a
 * complete answer about a subset. A timeout or signal kill is not: the child was
 * cut off mid-stream, so its stdout is a *truncated* list, and a truncated live
 * set marks live sessions dead — the very failure this probe exists to avoid.
 * Everything but a clean non-zero exit therefore fails open with `null`.
 */
export function usableLsofStdout(err: unknown): string | null {
  const e = (err ?? {}) as { status?: number | null; signal?: string | null; stdout?: string | Buffer };
  if (typeof e.status !== 'number' || e.status === 0) return null;  // killed, or never ran
  if (e.signal) return null;
  const out = typeof e.stdout === 'string' ? e.stdout : e.stdout ? e.stdout.toString('utf8') : '';
  return out === '' ? null : out;
}

/**
 * Working directories of every running `claude` CLI process, via `ps` + `lsof`.
 * The transcript records a session's `cwd`; if no live process shares it, the
 * session is dead (closed/cleaned) and cannot be actively working.
 *
 * Pids come from `ps` rather than `lsof -c claude`, which matches the *binary's
 * filename*: the native installer runs each version as a file named after it
 * (`~/.local/share/claude/versions/2.1.250`) reached through a `claude` symlink,
 * so lsof reported it as `2.1.250` and every session under it read dead. `ps`
 * reports the launcher path, which ends in `claude` for both install flavours.
 *
 * Returns `null` when the probe can't run — callers fail open and skip liveness
 * gating rather than mislabel every session dead. Granularity is per-cwd: two
 * sessions in the same directory can't be told apart, so a dead session sharing
 * a directory with a live one still reads live.
 */
export function liveCwds(): Set<string> | null {
  let psOut: string | null = null;
  try {
    psOut = execFileSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8', timeout: 2000 });
  } catch {
    return null;
  }
  const pids = parsePsClaudePids(psOut);
  if (pids.length === 0) return null;

  let lsofOut: string | null = null;
  try {
    lsofOut = execFileSync('lsof', ['-p', pids.join(','), '-a', '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000
    });
  } catch (e) {
    lsofOut = usableLsofStdout(e);
  }
  return composeLiveCwds(psOut, lsofOut);
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

  // Candidate POOL, not the display count: the two skips below (no messages,
  // slash-command-only) can only be decided after parsing, so a slice of exactly
  // maxSessions let a dropped transcript cost a display slot — two `/login`
  // phantoms on a maxSessions=5 config showed 3 rows. Over-fetch, then hold the
  // real cap in the loop. Costs extra readTranscript calls only when phantoms
  // exist; with none, the loop breaks at maxSessions like before.
  // Archived first, so a deleted session doesn't eat a pool slot either.
  const archived = options.archivedIds || null;
  const candidates = listTranscripts(root)
    .filter(t => !archived || !archived.has(t.id))
    .filter(t => now - t.mtimeMs <= lookbackMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessions * 2);

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
    if (sessions.length >= maxSessions) break;   // the pool over-fetches; this is the cap
    const parsed = readTranscript(c.file);
    if (!parsed) continue;
    // Skip transcripts with no conversational message: a session just started or
    // just `/clear`ed writes a fresh UUID file holding only queue-operation/
    // attachment/meta records. Its fresh mtime would read recent + turnComplete
    // = "incomplete", showing a phantom "pending" row beside the real session
    // (which `/clear` abandoned). Nothing to display → drop it.
    if (!parsed.hasMessages) continue;
    // Skip a transcript whose whole conversation is local slash-command plumbing
    // — `/login` (or `!ls`) run in a fresh terminal. Those records are user-role
    // messages, so the guard above passes them, but no assistant ever answered
    // and no tokens were spent: a 0% phantom row reading "your turn". Same
    // policy as above — nothing to display → drop it.
    if (parsed.commandOnly) continue;
    const projectPath = parsed.cwd || null;
    // The dashboard's own token-renewal turns run in a dedicated cwd; their
    // transcripts are plumbing, not a session to display.
    if (projectPath && normCwd(projectPath) === normCwd(refreshCwd(options.homeDir))) continue;
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
    // A held wait outranks even the liveness gate: the hook is holding a socket
    // open right now, which is stronger evidence of a live session than lsof's
    // per-cwd view. It also beats the transcript, which won't show the question
    // until the tool call resolves.
    const remoteQuestion = options.pendingIds ? options.pendingIds.has(c.id) : false;
    // A held plan is the same kind of evidence as a held question — an open
    // socket right now — so it sits beside it, above the liveness gate.
    const remotePlan = !remoteQuestion && (options.planIds ? options.planIds.has(c.id) : false);
    // A held reply window is the same kind of evidence again — the Stop hook is
    // holding a socket open right now — so it joins the chain above the gates.
    const remoteReply = !remoteQuestion && !remotePlan
      && (options.messageIds ? options.messageIds.has(c.id) : false);
    // A permission dialog is open in the terminal. It never reaches the
    // transcript, so the flag comes from the Notification hook — and it is
    // believed only until the transcript moves on: answering the dialog (allow
    // OR deny) appends a record, so a message newer than the notification means
    // the dialog is gone. Unlike a held remote wait this carries no liveness
    // evidence (the hook fired and exited), so it sits BELOW the dead gate.
    const notifiedAt = options.permissionWaits?.get(c.id);
    const permissionWait = !remoteQuestion && !remotePlan && !remoteReply && !dead && notifiedAt !== undefined
      && !(Number.isFinite(lastMsgMs) && lastMsgMs > notifiedAt);
    if (remoteQuestion) status = 'question';                           // blue — a wait is held for it
    else if (remotePlan) status = 'question';                          // blue — a plan is held for a verdict
    else if (remoteReply) status = 'question';                         // blue — a reply window is open
    else if (dead) status = 'idle';                                    // gray — no live process
    else if (permissionWait) status = 'question';                      // blue — dialog open in the terminal
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
      surface: sessionSurface(parsed.entrypoint),
      remoteQuestion,
      remotePlan,
      remoteReply,
      permissionWait,
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
