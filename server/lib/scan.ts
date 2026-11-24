/**
 * scan.ts — enumerate Claude Code session transcripts under ~/.claude/projects,
 * parse the most-recent ones, and build the ranked session list.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

import { launchCwd, readTranscript } from './transcript.js';
import { readAgentsCached } from './agents-cache.js';
import { cachedEntries } from './dir-cache.js';
import { SUBAGENT_DIR } from './subagent-usage.js';
import { refreshCwd } from './token-refresh.js';
import { DASHBOARD_ENTRYPOINT, HEADLESS_ENTRYPOINT } from './entrypoint.js';
import { readSessionTasks } from './tasks.js';
import { repoNameFor } from './worktree-repo.js';
import { defaultClaudeRoots, isClaudeOwned } from './paths.js';
import { readSessionAnalyticsLog, lessonForSession } from './sessionAnalyticsLog.js';
import type { SessionAnalyticsLesson } from './sessionAnalyticsLog.js';
import type { Config } from './config.js';
import type { Session, SessionSurface, SessionsResponse, StopState } from '../../shared/types.js';

export interface TranscriptRef {
  file: string;
  dirName: string;
  id: string;
  mtimeMs: number;
  /** Bytes at listing time — lets the usage ledger skip a second `stat` per file. */
  size: number;
}

interface ScanOptions {
  homeDir?: string;
  now?: number;
  root?: string;
  /**
   * The process probe the caller already ran ({@link probeProcesses}, shared through `scan-snapshot.ts`'s `sharedProcProbe`). The scan spawns
   * nothing itself, so absent or null fails open: no liveness gate, no `processLive`, `runningClaudeProcs` null.
   */
  proc?: ProcProbe | null;
  /** Ignore `proc`, as if the probe was skipped (tests). */
  skipProcScan?: boolean;
  /** Override the live-cwd set (tests). null disables gating; undefined takes `proc`'s. */
  liveCwds?: Set<string> | null;
  /** Override the set of session ids named by a live `claude` argv (tests). null = unknown, no row is flagged `processLive`; undefined takes `proc`'s. */
  liveSessionIds?: Set<string> | null;
  /** Override kaizen lessons (tests). null skips tagging; undefined reads the log. */
  lessons?: readonly SessionAnalyticsLesson[] | null;
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
  /**
   * Transcript ids the desktop app holds in a non-archived record (`archived.ts` `desktopLiveSessionIds()`), injected like `archivedIds`. A row in the
   * set carries `desktopOwned`, whatever its surface; omitted/null ⇒ none does.
   */
  desktopOwnedIds?: ReadonlySet<string> | null;
  /**
   * Transcript ids whose hand-over watch gave up (`handover.ts` `handOverFailedIds()`), injected the same way. A `dashboard` row in the set carries
   * `handOverFailed`, unless the app holds it.
   */
  handOverFailedIds?: ReadonlySet<string> | null;
  /**
   * Sessions this server spawned and still holds a live child handle for
   * (`spawn.ts` `stopStates()`), as `sessionId → StopState`, injected by the
   * handler so this module stays free of the launch store. A Map rather than a
   * Set because the one field carries two states. Omitted/null ⇒ no row is
   * flagged, and an id simply absent from it means the session cannot be
   * stopped — see {@link Session.stopState}.
   */
  stopStates?: ReadonlyMap<string, StopState> | null;
  /**
   * Keep only sessions whose picker name ({@link pickerProjectOf}) is one of these, chosen *before* the `maxSessions` cap — so a project with no session
   * among the newest N overall still fills its rows. Omitted/null/empty ⇒ every project. `GET /api/sessions?project=…` passes it.
   */
  projects?: ReadonlySet<string> | null;
  /** Override the dirs Claude makes for itself (tests); undefined ⇒ `defaultClaudeRoots(homeDir)`. */
  claudeRoots?: readonly string[];
  /**
   * A listing the caller already took (`scanSnapshot` shares one with the held-wait sweep), used in place of `listTranscripts(root)`. The archived,
   * lookback and newest-per-id steps still apply to it. Omitted ⇒ the scan lists `root` itself.
   */
  transcripts?: readonly TranscriptRef[];
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

/**
 * Which surfaces a session exists on, from the transcript's own `entrypoint`
 * (see {@link SessionSurface} for what each value promises the reader).
 *
 * Only `sdk-cli` — a headless `-p` run, which is what a dashboard spawn is —
 * and `claude-agents-dashboard` — what a spawn stamps under `SPAWN_OWN_ENTRYPOINT`
 * (`entrypoint.ts`), read whatever the switch says now so a session launched
 * with it on stays resumable after it is turned off — earn `dashboard`. Everything else, **an unrecognized or absent value
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
  return entrypoint === HEADLESS_ENTRYPOINT || entrypoint === DASHBOARD_ENTRYPOINT ? 'dashboard' : 'local';
}

/** One transcript file as a ref, or null when it is gone or not a file. */
function statRef(full: string, dirName: string): TranscriptRef | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    file: full,
    dirName,
    id: path.basename(full).replace(/\.jsonl$/, ''),
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

/** A held ref stat-ed again, so its `mtimeMs` and `size` are current — null when the file has gone since it was listed. */
export function restatRef(ref: TranscriptRef): TranscriptRef | null {
  return statRef(ref.file, ref.dirName);
}

/** Directory entry names ending `.jsonl`, or [] when the dir is unreadable. Read through `dir-cache.ts`, so an unchanged dir costs one stat. */
function jsonlNames(dir: string): string[] {
  return cachedEntries(dir).filter(e => e.name.endsWith('.jsonl')).map(e => e.name);
}

/** Visit every `.jsonl` name in every project dir, statting nothing. An unreadable root visits nothing and an unreadable dir is skipped. */
function forEachJsonlName(root: string, visit: (name: string, dir: string, dirName: string) => void): void {
  for (const d of cachedEntries(root)) {
    if (!d.isDir) continue;
    const dir = path.join(root, d.name);
    for (const name of jsonlNames(dir)) visit(name, dir, d.name);
  }
}

/**
 * List every `.jsonl` transcript with its mtime, across all project dirs.
 * Directory mtime cannot narrow the **stats**: an append does not move it, so a session still writing to an old file would lose its row — every file is
 * stat-ed on every walk. It does gate the **readdir**: an entry added, removed or renamed moves it, so each dir is re-read only then (`dir-cache.ts`).
 */
export function listTranscripts(root: string): TranscriptRef[] {
  const results: TranscriptRef[] = [];
  forEachJsonlName(root, (name, dir, dirName) => {
    const ref = statRef(path.join(dir, name), dirName);
    if (ref) results.push(ref);
  });
  return results;
}

/** A transcript that carries spend, and whose session it belongs to. */
export interface UsageTranscriptRef extends TranscriptRef {
  /**
   * The session that launched this subagent, for a
   * `<sessionId>/subagents/*.jsonl` file — null for a top-level transcript.
   */
  parentId: string | null;
}

/**
 * Every transcript that carries *spend*: the top-level files plus the nested
 * `<projectDir>/<sessionId>/subagents/agent-*.jsonl` ones the CLI writes for
 * each subagent a session launches.
 *
 * Deliberately a second enumeration rather than a wider {@link listTranscripts}:
 * that one's callers treat one file as one session, so a subagent file reaching
 * them would become an extra session row, an extra analytics report and a
 * resolvable `/api/sessions/:id`. Only the usage ledger asks the question a
 * subagent file answers — what the *account* spent, where a subagent turn spends
 * like any other — so only it reads this list.
 *
 * The nesting depth is exactly one session dir plus `subagents/`, matching what
 * the CLI writes; nothing deeper is walked.
 */
export function listUsageTranscripts(root: string): UsageTranscriptRef[] {
  const top: UsageTranscriptRef[] = [];
  const nested: UsageTranscriptRef[] = [];
  // One pass per project dir: its cached entries give both the top-level `.jsonl` names and the session dirs.
  for (const d of cachedEntries(root)) {
    if (!d.isDir) continue;
    const dir = path.join(root, d.name);
    for (const e of cachedEntries(dir)) {
      if (!e.isDir) {
        if (!e.name.endsWith('.jsonl')) continue;
        const ref = statRef(path.join(dir, e.name), d.name);
        if (ref) top.push({ ...ref, parentId: null });
        continue;
      }
      const agentDir = path.join(dir, e.name, SUBAGENT_DIR);
      for (const name of jsonlNames(agentDir)) {
        const ref = statRef(path.join(agentDir, name), d.name);
        if (ref) nested.push({ ...ref, parentId: e.name });
      }
    }
  }
  return top.concat(nested);
}

/**
 * Collapse per-file refs to one per session id, keeping the newest file.
 *
 * An id does not name a file: Claude Code files each record under the project
 * dir derived from the cwd at write time, so a session that `cd`s into a git
 * worktree keeps its id and starts a second `.jsonl` in a second project dir.
 * `listTranscripts` stays the raw per-file enumeration — the usage ledger and
 * analytics need every half — and this reduction is the one answer to "which
 * file *is* this session now".
 */
function newestPerId(refs: readonly TranscriptRef[]): TranscriptRef[] {
  const byId = new Map<string, TranscriptRef>();
  for (const ref of refs) {
    const seen = byId.get(ref.id);
    if (!seen || ref.mtimeMs > seen.mtimeMs) byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

/**
 * The live transcript for one session id, or undefined when nothing names it.
 *
 * Every caller resolving an id to a file to *read* goes through here (or
 * {@link findTranscriptByPrefix}) rather than a plain `find` over a listing,
 * which returns whichever half
 * `readdirSync` yielded first, so a split session's chat drawer or detail pane
 * could be served the abandoned half of its own transcript.
 *
 * `refs`, when given, is a listing the caller already took this request (`scanSnapshot` lists once and resolves every held wait from it); nothing is
 * read from disk then. Without them each call walks the directory names and stats only the matches, so an id is compared with enumerated names and
 * never joined into a path, and nothing is cached: a transcript created a moment ago is found.
 */
export function findTranscript(root: string, id: string, refs?: readonly TranscriptRef[]): TranscriptRef | undefined {
  if (refs) return newestPerId(refs.filter(t => t.id === id))[0];
  const wanted = id + '.jsonl';
  const matches: TranscriptRef[] = [];
  forEachJsonlName(root, (name, dir, dirName) => {
    if (name !== wanted) return;
    const ref = statRef(path.join(dir, name), dirName);
    if (ref) matches.push(ref);
  });
  return newestPerId(matches)[0];
}

/**
 * The live transcript for a logged id *prefix* (the `/kaizen` log keys sessions by one), or undefined. Same rule as {@link findTranscript}: newest half
 * per id, then the newest of those ids, so a split session resolves to the half it is writing now rather than whichever `readdirSync` yielded first.
 */
export function findTranscriptByPrefix(refs: readonly TranscriptRef[], prefix: string): TranscriptRef | undefined {
  return newestPerId(refs.filter(t => t.id.startsWith(prefix))).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
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
 * A subagent cannot move this value: it writes its own file under
 * `<id>/subagents/`, and no sidechain record ever lands in the parent transcript
 * `findTranscript` returns, so the newest message is always the main thread's.
 */
export function lastMessageMs(root: string, sessionId: string, refs?: readonly TranscriptRef[]): number | null {
  let ref: TranscriptRef | undefined;
  try { ref = findTranscript(root, sessionId, refs); }
  catch { return null; }
  if (!ref) return null;
  const parsed = readTranscript(ref.file);
  if (!parsed || !parsed.lastMessageTs) return null;
  const ms = Date.parse(parsed.lastMessageTs);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How long a subagent file may go unwritten and still count as running. Longer
 * than the Bash tool's 10-minute maximum timeout, so a subagent sitting inside
 * its longest possible single tool call is still evidence.
 */
export const SUBAGENT_STALL_MS = 15 * 60 * 1000;

/**
 * Each subagent file's last verdict, keyed by path: reused while its `mtimeMs` and `size` hold, so an unchanged file is not re-parsed every poll.
 * Entries go when their file passes {@link SUBAGENT_STALL_MS}, which bounds the map to files written in the last 15 minutes.
 */
const subagentVerdicts = new Map<string, { mtimeMs: number; size: number; unfinished: boolean }>();
let subagentReads = 0;

/** Test seam: how many subagent files {@link subagentRunning} actually parsed since the last reset. */
export function subagentCheckStats(): { reads: number; entries: number } {
  return { reads: subagentReads, entries: subagentVerdicts.size };
}

/** Test seam: forget every held subagent verdict and zero the counter. */
export function resetSubagentCheckCache(): void {
  subagentVerdicts.clear();
  subagentReads = 0;
}

/**
 * Is a subagent of this session still running? The status ladder's evidence for
 * a parent parked on a dispatched agent (bug-25): the parked parent writes
 * nothing while it waits, so its own transcript reads finished (background
 * launch → `end_turn`) or stalled (sync `tool_use` gone quiet).
 *
 * True only when all three hold, cheapest first:
 *  1. an `agent-*.jsonl` under `<dir>/<sessionId>/subagents/` was written within
 *     {@link SUBAGENT_STALL_MS} — no directory is the common case, one `stat` (the listing goes through `dir-cache.ts`);
 *  2. that file's newest message is mid-turn (a finished subagent ends `end_turn` or on an API-error record) — parsed only when its size or mtime moved
 *     since the last call;
 *  3. the parent still has a launch `running` per `readAgentsCached` — the veto
 *     for an interrupted run, where Esc gives the parent a `tool_result` but
 *     leaves the subagent file fresh and mid-turn.
 */
export function subagentRunning(parentFile: string, sessionId: string, nowMs: number): boolean {
  const dir = path.join(path.dirname(parentFile), sessionId, SUBAGENT_DIR);
  const unfinished = cachedEntries(dir).some(({ name }) => {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) return false;
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { subagentVerdicts.delete(file); return false; }
    if (nowMs - stat.mtimeMs > SUBAGENT_STALL_MS) {
      subagentVerdicts.delete(file);
      return false;
    }
    const seen = subagentVerdicts.get(file);
    if (seen && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) return seen.unfinished;
    subagentReads++;
    const sub = readTranscript(file);
    const verdict = !!sub && sub.hasMessages && !sub.turnComplete;
    subagentVerdicts.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, unfinished: verdict });
    return verdict;
  });
  if (!unfinished) return false;
  const jobs = readAgentsCached(parentFile);
  return !!jobs && jobs.some(j => j.status === 'running');
}

/**
 * Running `claude` processes (informational cross-check), counted from the `ps -Ao pid=,comm=` stdout the live-cwd set already reads — so one probe
 * forks one `ps` for both. `null` when `ps` failed; `0` when it ran and matched nothing, where the cwd set answers `null` instead.
 */
export function countClaudeProcs(psOut: string | null): number | null {
  return psOut === null ? null : parsePsClaudePids(psOut).length;
}

/** Strip a trailing slash so cwd strings compare consistently. */
function normCwd(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Pids of every running `claude` CLI process, from `ps -Ao pid=,comm=` stdout.
 *
 * Matches comm against `/(^|\/)claude$/`; `countClaudeProcs` counts these same
 * matches, so the live-cwd probe and the process count cannot disagree. Comm is everything after the pid and
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

/** One finished probe child: its exit code (null when it never ran, or died by a signal), the signal, and whatever stdout it printed. */
export interface ProbeResult {
  code: number | null;
  signal: string | null;
  stdout: string;
}

/** What runs one probe child. Resolves on every outcome, a failed spawn included; {@link setProbeExec} swaps it in tests. */
export type ProbeExec = (bin: string, args: string[], opts: { timeoutMs: number; maxBuffer?: number }) => Promise<ProbeResult>;

/** Every process-liveness answer one scan needs; each field null when its probe could not answer (callers fail open). */
export interface ProcProbe {
  /** Running `claude` CLI processes, from `ps -Ao pid=,comm=`. */
  runningClaudeProcs: number | null;
  /** Cwds of those processes, from `lsof` ({@link composeLiveCwds}). */
  liveCwds: Set<string> | null;
  /** Session ids named in a live `claude` argv, from `ps -Ao pid=,args=` ({@link parsePsSessionIds}). */
  liveSessionIds: Set<string> | null;
}

/** Per-child kill timer for the probe. */
export const PROBE_CHILD_TIMEOUT_MS = 2000;

/**
 * Run one probe child without blocking the event loop. The kill timer is its own because `execFile`'s `timeout` destroys stdout on a stalled event loop
 * and still reports success with empty output (#168), the same reason `makeGitRunner` in `git-stats.ts` keeps one. A child our timer killed reads
 * `code: null`, so its truncated stdout is never taken for a complete answer.
 */
export function runProbeChild(bin: string, args: string[], opts: { timeoutMs: number; maxBuffer?: number }): Promise<ProbeResult> {
  return new Promise(resolve => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = execFile(bin, args, { encoding: 'utf8', maxBuffer: opts.maxBuffer ?? 1024 * 1024 }, (err, stdout) => {
        clearTimeout(timer);
        if (!err) return resolve({ code: 0, signal: null, stdout });
        const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals | null };
        const code = !timedOut && typeof e.code === 'number' ? e.code : null;
        resolve({ code, signal: e.signal ?? (timedOut ? 'SIGTERM' : null), stdout: typeof stdout === 'string' ? stdout : '' });
      });
      timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
    } catch {
      resolve({ code: null, signal: null, stdout: '' });
    }
  });
}

let probeExec: ProbeExec | null = null;

/** Test seam: swap what runs the probe's children. `null` restores {@link runProbeChild}. Mirrors {@link setPsRunner}. */
export function setProbeExec(fn: ProbeExec | null): void {
  probeExec = fn;
}

/**
 * The process-liveness probe: which `claude` CLI processes run, in which working directories, under which session ids. The transcript records a
 * session's `cwd`; if no live process shares it, the session is dead (closed/cleaned) and cannot be actively working.
 *
 * Pids come from `ps` rather than `lsof -c claude`, which matches the *binary's filename*: the native installer runs each version as a file named
 * after it (`~/.local/share/claude/versions/2.1.250`) reached through a `claude` symlink, so lsof reported it as `2.1.250` and every session under it
 * read dead. `ps` reports the launcher path, which ends in `claude` for both install flavours.
 *
 * Async, with both `ps` reads in parallel and `lsof` after them, so a hung child costs this probe its kill timer and never blocks every other request
 * for it. Each field fails open on its own: `ps comm` failed → count and cwds null; no claude pid → `lsof` is not run, cwds null, count 0; `ps args`
 * failed → ids null. Granularity of the cwd set is per-cwd: two sessions in one directory cannot be told apart. Resolves on every failed or killed
 * child; only an exec that breaks the {@link ProbeResult} contract can make it reject.
 */
export async function probeProcesses(opts: { exec?: ProbeExec; timeoutMs?: number } = {}): Promise<ProcProbe> {
  const exec = opts.exec ?? probeExec ?? runProbeChild;
  const timeoutMs = opts.timeoutMs ?? PROBE_CHILD_TIMEOUT_MS;
  const run = (bin: string, args: string[], maxBuffer?: number): Promise<ProbeResult | null> =>
    Promise.resolve().then(() => exec(bin, args, { timeoutMs, maxBuffer })).catch(() => null);
  const stdoutOf = (r: ProbeResult | null): string | null => (r && r.code === 0 ? r.stdout : null);

  const [comm, args] = await Promise.all([
    run('ps', ['-Ao', 'pid=,comm=']).then(stdoutOf),
    run('ps', ['-Ao', 'pid=,args='], 8 * 1024 * 1024).then(stdoutOf)
  ]);
  const pids = comm === null ? [] : parsePsClaudePids(comm);
  let lsofOut: string | null = null;
  if (pids.length) {
    const r = await run('lsof', ['-p', pids.join(','), '-a', '-d', 'cwd', '-Fn']);
    lsofOut = !r ? null : r.code === 0 ? r.stdout : usableLsofStdout({ status: r.code, signal: r.signal, stdout: r.stdout });
  }
  return {
    runningClaudeProcs: countClaudeProcs(comm),
    liveCwds: composeLiveCwds(comm, lsofOut),
    liveSessionIds: args === null ? null : parsePsSessionIds(args)
  };
}

/**
 * Session ids carried by live `claude` command lines, from `ps -Ao pid=,args=`
 * stdout. Pure; {@link liveSessionIds} runs the probe.
 *
 * Both flag spellings are collected — `--session-id <id>` (a fresh headless
 * launch names its own id) and `--resume <id>` — and a hand-typed `--flag=<id>`
 * is the same live process, so `=` counts too. The id charset mirrors
 * `RESUME_ID_RE` in `spawn.ts`, and the match must end on whitespace or the end
 * of the line: an id with an out-of-charset character (`--resume a/b`) is not
 * this repo's id shape, and a prefix of it (`a`) would be a different session.
 *
 * A line only counts if it mentions `claude` at all. That is a substring test,
 * not the launcher-basename test {@link parsePsClaudePids} does, because `args=`
 * carries the whole command line: an argv-based match can therefore false-
 * positive on some unrelated command mentioning both. Deliberate — a false
 * positive costs one refused resume, a false negative costs a second writer.
 */
export function parsePsSessionIds(out: string): Set<string> {
  const ids = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.includes('claude')) continue;
    for (const m of line.matchAll(/--(?:session-id|resume)[ =]([A-Za-z0-9._-]+)(?=\s|$)/g)) {
      ids.add(m[1]);
    }
  }
  return ids;
}

/** Test seam for {@link liveSessionIds}, the resume guard's synchronous `ps`. */
export type PsRunner = () => string;

let psRunner: PsRunner | null = null;

/**
 * Test seam: swap the `ps` runner. `null` restores the real `execFileSync`.
 * Mirrors `setSpawner` in `spawn.ts` — no test shells out for real, and none
 * depends on what happens to be running on the machine.
 */
export function setPsRunner(fn: PsRunner | null): void {
  psRunner = fn;
}

/**
 * Every session id a live `claude` process names in its argv, or `null` when
 * the probe could not run.
 *
 * The per-session-id answer the live-cwd set cannot give: it resolves to a
 * *directory*, so two sessions in one repo are indistinguishable. `serveSpawn`'s
 * resume guard needs the id, and needs it for children this process never
 * spawned — a session started from a terminal, from a second dashboard, or
 * before the last restart, none of which the launch store can see.
 *
 * **`null` means the opposite of what it means for the cwd set.** There, failing
 * open costs a badge colour; here it means the guard cannot fire, so the
 * store-based check stands alone and a legal resume is never refused on a
 * probe that never ran. Keep this probe as simple as it looks.
 *
 * A second `ps` fork rather than teaching the cwd probe's one to serve both: that
 * one parses `comm=`, and the launcher path can contain spaces
 * (`…/Application Support/…`), so a merged format reintroduces exactly the
 * parsing ambiguity its comment warns about — for one saved fork per poll.
 *
 * Synchronous, unlike {@link probeProcesses}, which answers the same question for the scan: the resume guard runs on a rare POST and must see a
 * session launched a moment ago, which the shared probe's cache could miss.
 */
export function liveSessionIds(): Set<string> | null {
  try {
    const out = psRunner
      ? psRunner()
      : execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
    return parsePsSessionIds(out);
  } catch {
    return null;
  }
}

/** What one row needs beyond its transcript: the clock, the activity window and the injected sets `scanSessions` documents on {@link ScanOptions}. */
export interface RowOptions extends Pick<ScanOptions, 'homeDir' | 'claudeRoots' | 'pendingIds' | 'planIds' | 'messageIds' | 'permissionWaits' | 'stopStates' | 'desktopOwnedIds' | 'handOverFailedIds'> {
  now: number;
  activeWindowMin: number;
  /** The live-cwd set; null fails open, as `skipProcScan` does. */
  liveCwds: Set<string> | null;
  /** Session ids named by a live `claude` argv; null or omitted fails open, as `skipProcScan` does: no row is flagged `processLive`. */
  liveSessionIds?: Set<string> | null;
  lessons: readonly SessionAnalyticsLesson[] | null;
  /**
   * Apply the list's skips (no conversational message, slash-command only, the token-refresh cwd) by answering null. The row-by-id route leaves them
   * off, so a routine run the list would hide still opens.
   */
  scanSkips?: boolean;
}

/** One `Session` row from one transcript; null when it cannot be read, or when `scanSkips` drops it. */
export function sessionFromRef(ref: TranscriptRef, opts: RowOptions): Session | null {
  const skips = opts.scanSkips === true;
  const live = opts.liveCwds;
  const parsed = readTranscript(ref.file);
  if (!parsed) return null;
  // Skip transcripts with no conversational message: a session just started or
  // just `/clear`ed writes a fresh UUID file holding only queue-operation/
  // attachment/meta records. Its fresh mtime would read recent + turnComplete
  // = "incomplete", showing a phantom "pending" row beside the real session
  // (which `/clear` abandoned). Nothing to display → drop it.
  if (skips && !parsed.hasMessages) return null;
  // Skip a transcript whose whole conversation is local slash-command plumbing
  // — `/login` (or `!ls`) run in a fresh terminal. Those records are user-role
  // messages, so the guard above passes them, but no assistant ever answered
  // and no tokens were spent: a 0% phantom row reading "your turn". Same
  // policy as above — nothing to display → drop it.
  if (skips && parsed.commandOnly) return null;
  // The launch cwd, not the newest record's: a `cd` inside a Bash tool call
  // moves the transcript's cwd for the rest of the session, which would label
  // the row with a fragment like `open` and group it there in the Settings
  // filter. Falls back to the newest cwd when the head window held none.
  const projectPath = parsed.originCwd || parsed.cwd || null;
  // The dashboard's own token-renewal turns run in a dedicated cwd; their
  // transcripts are plumbing, not a session to display.
  if (skips && projectPath && normCwd(projectPath) === normCwd(refreshCwd(opts.homeDir))) return null;
  const project = projectPath ? projectNameOf(projectPath) : decodeProjectName(ref.dirName);
  // Recency tracks real agent activity, not file touches: selecting a session
  // in Claude Code appends timestamp-less mode/last-prompt/custom-title records
  // that bump the file mtime without any turn happening. Use the newest
  // conversational message's timestamp; fall back to mtime only if absent.
  const lastMsgMs = parsed.lastMessageTs ? Date.parse(parsed.lastMessageTs) : NaN;
  const activityMs = Number.isFinite(lastMsgMs) ? lastMsgMs : ref.mtimeMs;
  const recent = opts.now - activityMs <= opts.activeWindowMin * 60 * 1000;
  let status: Session['status'];
  // Dead process (cwd not in the live set) → nothing is running and nothing
  // will resume on its own, so the session is idle no matter what the last
  // transcript record implies (interrupted mid-turn, unanswered question…).
  // Two keys, either one matching is proof of life. `lsof` reports the
  // *process* cwd, and the transcript's newest cwd drifts away from it in
  // both directions — shell drift moves the transcript (a `cd` in a tool
  // call), process drift moves the process (entering a worktree) — so
  // neither key alone is reliable (bug-7). Still exact equality per key: no
  // containment, so per-cwd granularity stays the documented limit.
  const liveKeys = [parsed.originCwd, parsed.cwd].filter((k): k is string => !!k);
  const dead = live !== null && liveKeys.length > 0
    && !liveKeys.some(k => live.has(normCwd(k)));
  // A held wait outranks even the liveness gate: the hook is holding a socket
  // open right now, which is stronger evidence of a live session than lsof's
  // per-cwd view. It also beats the transcript, which won't show the question
  // until the tool call resolves.
  const remoteQuestion = opts.pendingIds ? opts.pendingIds.has(ref.id) : false;
  // A held plan is the same kind of evidence as a held question — an open
  // socket right now — so it sits beside it, above the liveness gate.
  const remotePlan = !remoteQuestion && (opts.planIds ? opts.planIds.has(ref.id) : false);
  // A held reply window is the same kind of evidence again — the Stop hook is
  // holding a socket open right now — so it joins the chain above the gates.
  const remoteReply = !remoteQuestion && !remotePlan
    && (opts.messageIds ? opts.messageIds.has(ref.id) : false);
  // A permission dialog is open in the terminal. It never reaches the
  // transcript, so the flag comes from the Notification hook — and it is
  // believed only until the transcript moves on: answering the dialog (allow
  // OR deny) appends a record, so a message newer than the notification means
  // the dialog is gone. Unlike a held remote wait this carries no liveness
  // evidence (the hook fired and exited), so it sits BELOW the dead gate.
  const notifiedAt = opts.permissionWaits?.get(ref.id);
  const permissionWait = !remoteQuestion && !remotePlan && !remoteReply && !dead && notifiedAt !== undefined
    && !(Number.isFinite(lastMsgMs) && lastMsgMs > notifiedAt);
  if (remoteQuestion) status = 'question';                           // blue — a wait is held for it
  else if (remotePlan) status = 'question';                          // blue — a plan is held for a verdict
  else if (remoteReply) status = 'question';                         // blue — a reply window is open
  else if (dead) status = 'idle';                                    // gray — no live process
  else if (permissionWait) status = 'question';                      // blue — dialog open in the terminal
  else if (parsed.waitingOnQuestion) status = 'question';            // blue — needs an answer, beats all
  else if (recent && !parsed.turnComplete) status = 'working';       // green — machine actively churning
  // A parent parked on a subagent writes nothing, so its own transcript reads
  // done or stalled. Below `dead` and every question arm; evaluated only when
  // the ladder would otherwise say idle/incomplete, so the probe stays off
  // every row the arm above already settled.
  else if (subagentRunning(ref.file, ref.id, opts.now)) status = 'working';   // green — parked on a running subagent
  else if (parsed.turnComplete && !recent) status = 'idle';          // gray — finished and dormant
  else status = 'incomplete';                                        // yellow — your turn (recent+done) OR stalled (stale+pending)
  // Only present when this server holds a live handle for the id — the field
  // is deliberately absent, not false, for every other row (see `stopState`).
  const stopState = opts.stopStates?.get(ref.id);
  const surface = sessionSurface(parsed.entrypoint);
  // A process this server cannot signal but the process table shows (see `processLive`): the same absent-not-false encoding.
  const processLive = surface === 'dashboard' && !stopState && !!opts.liveSessionIds?.has(ref.id);
  // Any row the desktop app lists. A `dashboard` one was imported but not yet continued there, so its transcript still reads `dashboard`. A `local` one
  // was started or continued in the app: this dashboard's own readers gate on `surface === 'dashboard'` and ignore it, but `local` alone cannot tell a
  // terminal from the app, and a consumer of `/api/sessions` (backlog-manager's Jira cards) needs that to say where the session runs and whether opening
  // it in the app is safe mid-turn.
  const desktopOwned = !!opts.desktopOwnedIds?.has(ref.id);
  // A mark outlives the failure until the user acts, and the app may have imported the session by then: it holds it, so nothing is left to report.
  const handOverFailed = surface === 'dashboard' && !desktopOwned && !!opts.handOverFailedIds?.has(ref.id);
  const taskState = readSessionTasks(ref.file, projectPath);
  return {
    id: ref.id,
    project,
    projectPath,
    repo: repoNameFor(projectPath),
    // A row with no launch cwd is named only by its parsed `project`, which stands in.
    pickerProject: projectPath === null ? project : pickerProjectOf(projectPath, opts.claudeRoots ?? defaultClaudeRoots(opts.homeDir)),
    sessionName: parsed.sessionName || null,
    gitBranch: parsed.gitBranch || null,
    model: parsed.model || '',
    effort: parsed.effort,
    tokens: parsed.tokens,
    contextWindow: parsed.contextWindow,
    contextPct: parsed.contextPct,
    status,
    surface,
    remoteQuestion,
    remotePlan,
    remoteReply,
    permissionWait,
    ...(stopState ? { stopState } : {}),
    ...(processLive ? { processLive: true as const } : {}),
    ...(desktopOwned ? { desktopOwned: true as const } : {}),
    ...(handOverFailed ? { handOverFailed: true as const } : {}),
    ...(parsed.apiError ? { apiError: parsed.apiError } : {}),
    activity: parsed.activity,
    lastTimestamp: parsed.lastTimestamp,
    updatedMs: ref.mtimeMs,
    version: parsed.version || null,
    kaizenLesson: opts.lessons ? lessonForSession(opts.lessons, ref.id) : null,
    tasks: taskState.tasks,
    taskPlan: taskState.plan
  };
}

/**
 * The launch ids whose transcript already makes a row under the list's own skips, whatever project filter the poll carries. Adoption asks this for the
 * launches the served rows did not cover: a filtered-out launch never reaches `sessions`, and without it would read `launching` until its TTL (#471).
 * `scanSkips` keeps adoption at the poll where the row is a real conversation, so an unfiltered board never loses the phantom before its row arrives.
 * `refs` is required: the caller passes the listing the poll already took (`sharedListing`), so adoption never walks the tree; a launch whose
 * transcript appears after that listing is adopted on the next poll.
 */
export function launchRowIds(ids: readonly string[], opts: { root: string; refs: readonly TranscriptRef[]; homeDir?: string }): string[] {
  const rowOptions: RowOptions = { homeDir: opts.homeDir, now: Date.now(), activeWindowMin: 1, liveCwds: null, lessons: null, scanSkips: true };
  return ids.filter(id => {
    const ref = findTranscript(opts.root, id, opts.refs);
    return !!ref && sessionFromRef(ref, rowOptions) !== null;
  });
}

/** A `Session.project` from its launch cwd: the folder's basename. */
function projectNameOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() || cwd;
}

/**
 * The name the Sessions project picker files a cwd under, or null when it offers none: a linked worktree folds into its repo, so its sessions come with
 * the repo's chip instead of a chip of their own, and a dir Claude made for itself (a scratchpad, a scratch workspace, `~/.claude`) has no chip at all —
 * its sessions show only under "All projects". Every row carries the answer as `Session.pickerProject`, which the client's `filterProjectOf` reads
 * instead of re-deriving the rule.
 */
function pickerProjectOf(cwd: string, claudeRoots: readonly string[]): string | null {
  if (isClaudeOwned(cwd, claudeRoots)) return null;
  return repoNameFor(cwd) ?? projectNameOf(cwd);
}

/** Build the ranked session snapshot. */
export function scanSessions(config: Partial<Config>, options: ScanOptions = {}): SessionsResponse {
  const cfg = config || {};
  const maxSessions = (cfg.maxSessions ?? 0) > 0 ? (cfg.maxSessions as number) : 5;
  const activeWindowMin = (cfg.activeWindowMin ?? 0) > 0 ? (cfg.activeWindowMin as number) : 5;
  const lookbackHours = (cfg.lookbackHours ?? 0) > 0 ? (cfg.lookbackHours as number) : 48;

  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();
  const root = options.root || projectsRoot(options.homeDir);

  const lookbackMs = lookbackHours * 60 * 60 * 1000;

  // Candidate POOL, not the display count: the two skips below (no messages,
  // slash-command-only) can only be decided after parsing, so a slice of exactly
  // maxSessions let a dropped transcript cost a display slot — two `/login`
  // phantoms on a maxSessions=5 config showed 3 rows. Over-fetch, then hold the
  // real cap in the loop. Costs extra readTranscript calls only when phantoms
  // exist; with none, the loop breaks at maxSessions like before.
  // Archived first, so a deleted session doesn't eat a pool slot either.
  const archived = options.archivedIds || null;
  // Deduped by id *before* the slice: a session split across two project dirs
  // (see `newestPerId`) would otherwise spend two pool slots on itself and be
  // pushed as two `Session`s with the same id — one row per half, parsed from
  // different halves, so reading `working` and `idle` at once.
  const inLookback = newestPerId(
    (options.transcripts ?? listTranscripts(root))
      .filter(t => !archived || !archived.has(t.id))
      .filter(t => now - t.mtimeMs <= lookbackMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Project of every transcript in the lookback from the cached head read alone (`launchCwd`), never the tail parse: this runs over all of them each
  // poll, ~226 at a 7-day lookback (2026-10-21). null = the head holds no cwd yet, so the project is unknown until the row is parsed. The dashboard's own
  // token-renewal cwd is plumbing that `sessionFromRef` drops, so it is no project to offer.
  const refresh = normCwd(refreshCwd(options.homeDir));
  const claudeRoots = options.claudeRoots ?? defaultClaudeRoots(options.homeDir);
  const projectOf = new Map<TranscriptRef, string | null>();
  for (const t of inLookback) {
    const cwd = launchCwd(t.file, t.size);
    // '' = a cwd the picker offers nothing for: known, so a `?project=` filter drops it here instead of parsing it.
    projectOf.set(t, cwd && normCwd(cwd) !== refresh ? pickerProjectOf(cwd, claudeRoots) ?? '' : null);
  }
  const wanted = options.projects && options.projects.size ? options.projects : null;
  // Under a filter, matching and still-unknown transcripts each get a pool of their own: unknowns sharing one pool could fill it ahead of every
  // match, leaving a filtered board short of rows while matching transcripts exist. An unknown stays a candidate because the parsed row settles it.
  let candidates: TranscriptRef[];
  if (wanted) {
    candidates = [];
    let matched = 0, unknown = 0;
    for (const t of inLookback) {
      const p = projectOf.get(t);
      if (p == null) { if (unknown < maxSessions * 2) { unknown++; candidates.push(t); } }
      else if (wanted.has(p) && matched < maxSessions * 2) { matched++; candidates.push(t); }
    }
  } else candidates = inLookback.slice(0, maxSessions * 2);

  const proc = options.skipProcScan ? null : options.proc ?? null;
  // Set of cwds with a live `claude` process. null = probe skipped/unavailable
  // → fail open (no gating). A session whose cwd is absent has no live process,
  // so it can't be working/pending — force it to idle regardless of transcript.
  const live = options.liveCwds !== undefined ? options.liveCwds : proc?.liveCwds ?? null;
  // Session ids in a live `claude` argv. A null probe fails open (no row flagged), leaving the server-side 409 on POST as the safety net.
  const liveIds = options.liveSessionIds !== undefined ? options.liveSessionIds : proc?.liveSessionIds ?? null;

  // `/kaizen` lessons keyed to each session by UUID-prefix match. Read once per
  // scan (tiny, fail-open file). Skipped when analytics is disabled or injected
  // (tests). null ⇒ no tagging → every session's kaizenLesson stays null.
  const lessons = options.lessons !== undefined
    ? options.lessons
    : cfg.showAnalytics === false ? null : readSessionAnalyticsLog();

  const rowOptions: RowOptions = {
    homeDir: options.homeDir, claudeRoots, now, activeWindowMin, liveCwds: live, liveSessionIds: liveIds, lessons, scanSkips: true,
    pendingIds: options.pendingIds, planIds: options.planIds, messageIds: options.messageIds,
    permissionWaits: options.permissionWaits, stopStates: options.stopStates, desktopOwnedIds: options.desktopOwnedIds,
    handOverFailedIds: options.handOverFailedIds
  };
  const sessions: Session[] = [];
  for (const c of candidates) {
    if (sessions.length >= maxSessions) break;   // the pool over-fetches; this is the cap
    const row = sessionFromRef(c, rowOptions);
    if (row && (!wanted || wanted.has(row.pickerProject ?? ''))) sessions.push(row);
  }

  const projects = new Set<string>();
  for (const s of sessions) if (s.pickerProject) projects.add(s.pickerProject);
  for (const p of projectOf.values()) if (p) projects.add(p);

  return {
    generatedAt: new Date(now).toISOString(),
    activeWindowMin,
    maxSessions,
    runningClaudeProcs: proc?.runningClaudeProcs ?? null,
    totals: {
      shown: sessions.length,
      active: sessions.filter(s => s.status === 'working').length
    },
    sessions,
    projects: Array.from(projects).sort((a, b) => a.localeCompare(b))
  };
}
