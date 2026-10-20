/**
 * schedules.ts — the Management › Schedules page's view logic, apart from React so `test/schedules-view.test.ts` can drive it: what a ledger row says, how
 * the Runs list groups by day, how the stats band formats, and the Repos helper's two directions over a job file's `foreach:` / `cwd:` lines.
 *
 * Everything takes `now` and formats in local time with fixed English names, so the output is the same in every TZ and locale a test runs under (the
 * dashboard shows the clock of the machine the job runs on, which is the browser's in the single-machine case this page is built for).
 */
import { scalarEnd, writeFrontmatterLine } from '../../../shared/frontmatter';
import type { ReconcileChange, ScheduleJobRow, ScheduleRun, ScheduleStats, ScheduleStep, SchedulesResponse } from '../../../shared/types';
import { READ_ONLY_TEXT, refusalKind } from './writeRefusal';

/** The chip colours a pill may take; `run` is the cyan "in flight" one the mock draws, `dim` the dashed one. */
export type PillTone = 'green' | 'amber' | 'red' | 'mustard' | 'run' | 'dim';
export interface Pill { text: string; tone: PillTone }

/** The Runs page's filters, as `GET /api/schedules/runs` takes them; an empty string is "no filter". */
export interface ScheduleRunsQuery {
  days: 7 | 30 | 90;
  job: string;
  outcome: '' | 'failed' | 'lost';
  runner: '' | 'claude' | 'shell';
}

/** The query string for `GET /api/schedules/runs`, empty filters left out. */
export function runsQueryString(q: ScheduleRunsQuery): string {
  const params = new URLSearchParams({ days: String(q.days) });
  if (q.job) params.set('job', q.job);
  if (q.outcome) params.set('outcome', q.outcome);
  if (q.runner) params.set('runner', q.runner);
  return `?${params.toString()}`;
}

/**
 * The poll hooks' ordering rule, apart from React. A timed or visibility tick (`next(false)`) is skipped while a fetch is out, so a slow 90-day fold is not
 * piled on; `refresh()` (`next(true)`) always goes, because its caller just changed something the fetch in flight may predate. Each fetch carries the number
 * `next` gave it, and `settle` says whether its answer is still the newest issued: only then may the hook apply it, so an older fold resolving late can never
 * overwrite a newer one. A superseded fetch settles as stale and leaves the in-flight flag to the newest.
 */
export function createPollSeq(): { next(force: boolean): number | null; settle(seq: number): boolean } {
  let issued = 0;
  let inFlight = false;
  return {
    next(force) {
      if (inFlight && !force) return null;
      inFlight = true;
      return ++issued;
    },
    settle(seq) {
      if (seq !== issued) return false;
      inFlight = false;
      return true;
    }
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole local calendar days from `a` to `b` (positive when `b` is later). DST-proof: compares the date parts, not 24h spans. */
function dayDiff(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

/** `6:00`, `22:00` — the 24h clock with no padded hour, as the mock's rows write it. */
function clock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** `38s`, `6m`, `1h 5m`: a ledger line's duration, coarser than the fold's. */
function spanText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(0, s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** When a finished run started, against `now`: `6:00 today`, `yesterday 22:00`, `12d ago`, then `Oct 1` once it is a fortnight old. */
function whenText(at: Date, now: Date): string {
  const back = dayDiff(at, now);
  if (back <= 0) return `${clock(at)} today`;
  if (back === 1) return `yesterday ${clock(at)}`;
  if (back < 14) return `${back}d ago`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** When the next fire is: `today 22:00`, `tomorrow 07:00`, `Nov 1 09:30` (a stack of two short lines in the mock, one ellipsizable line here). */
function nextText(at: Date, now: Date): string {
  const ahead = dayDiff(now, at);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (ahead <= 0) return `today ${time}`;
  if (ahead === 1) return `tomorrow ${time}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

function runCost(run: ScheduleRun): number | null {
  const costs = run.steps.map(s => s.costUsd).filter((c): c is number => c !== null);
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null;
}

/** The pill a finished run reads as: `14 ok` (a fan-out) or `ok`, `2 of 12 failed` (amber) or `failed` (red), `lost` and `not run` in mustard. */
function finishedPill(run: ScheduleRun): Pill {
  if (run.state === 'lost') return { text: 'lost', tone: 'mustard' };
  if (run.state === 'refused') return { text: 'not run', tone: 'mustard' };
  if (run.state === 'failed') {
    if (run.error !== null || run.total <= 1) return { text: 'failed', tone: 'red' };
    // Some steps still ran fine: amber is "look at it", red is "nothing worked".
    return { text: `${run.failed} of ${run.total} failed`, tone: run.failed >= run.total ? 'red' : 'amber' };
  }
  return { text: run.total > 1 ? `${run.ok} ok` : 'ok', tone: 'green' };
}

function runningPill(run: ScheduleRun): Pill {
  if (run.total > 1) return { text: `running · ${run.steps.filter(s => s.outcome !== null).length} of ${run.total}`, tone: 'run' };
  const repo = run.steps[0]?.repo;
  return { text: repo ? `running · ${repo}` : 'running', tone: 'run' };
}

/**
 * What one ledger row says in its three stacked cells. `lastLine` goes under the pill (it is empty when there is nothing to say), `nextLine` is the Next
 * column. A job that does not name this machine reads `<machines> only` and has no next line; a paused one reads `paused` there; a file that does not parse
 * reads `invalid` so the row still draws.
 */
export function rowText(job: ScheduleJobRow, now: Date): { lastLine: string; nextLine: string; pill: Pill } {
  const parsed = job.job;
  if (parsed === null) return { lastLine: '', nextLine: '—', pill: { text: 'invalid', tone: 'red' } };
  const nextLine = !parsed.enabled ? 'paused' : job.nextAt !== null && Number.isFinite(Date.parse(job.nextAt)) ? nextText(new Date(job.nextAt), now) : '—';

  if (job.running) {
    const run = job.running;
    const startedMs = Date.parse(run.startedAt);
    const so = Number.isFinite(startedMs) ? spanText(now.getTime() - startedMs) : '';
    // The mock words a scheduled run's elapsed time "3m so far" and a manual one's plain "20s".
    const lastLine = run.trigger === 'manual'
      ? ['by hand', so].filter(Boolean).join(' · ')
      : [Number.isFinite(startedMs) ? clock(new Date(startedMs)) : '', so ? `${so} so far` : ''].filter(Boolean).join(' · ');
    return { lastLine, nextLine, pill: runningPill(run) };
  }
  if (!job.onThisMachine) return { lastLine: '', nextLine: '—', pill: { text: `${parsed.machines.join(' + ')} only`, tone: 'dim' } };
  const last = job.last;
  if (!last) return { lastLine: '', nextLine, pill: { text: 'never run', tone: 'dim' } };

  const at = Date.parse(last.startedAt);
  const cost = runCost(last);
  const lastLine = [
    Number.isFinite(at) ? whenText(new Date(at), now) : '',
    last.ms !== null ? spanText(last.ms) : '',
    cost !== null ? `$${cost.toFixed(2)}` : ''
  ].filter(Boolean).join(' · ');
  return { lastLine, nextLine, pill: finishedPill(last) };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The Runs list's day groups, in the order the runs arrive (the server sends newest first): `Today · Sun 19`, `Yesterday · Sat 18`, then `Wed 15` for
 * anything older. A run with no readable start time lands in a `—` group rather than vanishing.
 */
export function groupRunsByDay(runs: ScheduleRun[], now: Date): Array<{ label: string; runs: ScheduleRun[] }> {
  const groups = new Map<string, { label: string; runs: ScheduleRun[] }>();
  for (const run of runs) {
    const t = Date.parse(run.startedAt);
    const d = Number.isFinite(t) ? new Date(t) : null;
    const key = d ? dayKey(d) : '—';
    let group = groups.get(key);
    if (!group) {
      let label = '—';
      if (d) {
        const short = `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
        const back = dayDiff(d, now);
        label = back === 0 ? `Today · ${short}` : back === 1 ? `Yesterday · ${short}` : short;
      }
      group = { label, runs: [] };
      groups.set(key, group);
    }
    group.runs.push(run);
  }
  return [...groups.values()];
}

/** `$24.10`, `4.1M` / `310k` / `850`, `5h 12m` / `5m 40s` / `38s`, `85%` — the stats band's four number shapes. A non-finite input reads `—`. */
export function formatStat(n: number, kind: 'usd' | 'tokens' | 'ms' | 'pct'): string {
  if (!Number.isFinite(n)) return '—';
  if (kind === 'usd') return `$${n.toFixed(2)}`;
  if (kind === 'pct') return `${Math.round(n * 100)}%`;
  if (kind === 'tokens') {
    if (n >= 999_500) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e5) return `${Math.round(n / 1e3)}k`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return String(Math.round(n));
  }
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return sec % 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec / 60}m`;
  const min = Math.round(n / 60_000);
  return min % 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min / 60}h`;
}

export type ForeachMode = 'all' | 'pick' | 'cwd';

/**
 * The `foreach:` line the Repos helper writes for a mode: `foreach: pinned` for All pinned, `foreach: [a, b]` for Pick, and `''` for Single cwd — the caller
 * removes the line and writes `cwd:` instead, since a file may name only one of the two.
 */
export function foreachLine(mode: ForeachMode, picks: string[]): string {
  if (mode === 'all') return 'foreach: pinned';
  if (mode === 'pick') return `foreach: [${picks.join(', ')}]`;
  return '';
}

/** The frontmatter block of a job file, or '' when it has none. The first line must be `---`. */
function frontmatterOf(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return m ? m[1] : '';
}

/**
 * What the file's frontmatter says about its repos, the inverse of {@link foreachLine}: `foreach: pinned` → all, `foreach: [a, b]` → pick with the names,
 * anything else (a `cwd:` line, or neither) → cwd. Reads the first `foreach:` line only and never looks past the frontmatter, so a prompt that quotes the
 * key does not change the helper's reading.
 */
export function readForeach(text: string): { mode: ForeachMode; picks: string[] } {
  const line = frontmatterOf(text).split(/\r?\n/).find(l => /^foreach\s*:/.test(l));
  if (line === undefined) return { mode: 'cwd', picks: [] };
  // A trailing ` # comment` is not part of the value: the spec's example file carries one on this very line.
  const raw = line.replace(/^foreach\s*:/, '').trim();
  const value = raw.slice(0, scalarEnd(raw));
  if (value === 'pinned') return { mode: 'all', picks: [] };
  const list = /^\[(.*)\]$/.exec(value);
  if (!list) return { mode: 'cwd', picks: [] };
  const picks = list[1].split(',').map(x => x.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(x => x !== '');
  return { mode: 'pick', picks };
}

/**
 * The Repos helper's write side: set the frontmatter to `mode`, touching only the `foreach:` / `cwd:` lines. All and Pick write `foreach:` (in place, its
 * trailing comment kept, or after `run:`) and drop a `cwd:` line, since a file may name only one; Single cwd drops `foreach:` and leaves any `cwd:` as it
 * is, so the default (the schedules folder's parent) applies until the file names one. Comment lines are never touched; text with no frontmatter is returned
 * unchanged.
 */
export function setRepos(text: string, mode: ForeachMode, picks: string[]): string {
  const lines = text.split('\n');
  const strip = (l: string): string => l.replace(/\r$/, '');
  if (strip(lines[0] ?? '').replace(/^﻿/, '') !== '---') return text;
  const end = lines.findIndex((l, i) => i >= 1 && strip(l) === '---');
  if (end === -1) return text;
  const drop = (key: string) => lines.filter((l, i) => !(i > 0 && i < end && new RegExp(`^${key}\\s*:`).test(l)));
  if (mode === 'cwd') return drop('foreach').join('\n');
  const kept = drop('cwd').join('\n');
  return writeFrontmatterLine(kept, 'foreach', foreachLine(mode, picks).replace(/^foreach: /, ''), 'run');
}

/** The drawer's three kinds; each is a whole file, so picking one replaces the text. */
export type JobKind = 'shell' | 'prompt' | 'skill';

const CLAUDE_HEAD = `---
cron: "0 22 * * *"            # five fields, local time of the machine that runs it
machines: [mac, wsl]          # which profiles install it; one or both
run: claude                   # shell | claude
foreach: pinned               # absent = run once in \`cwd\`; pinned = every pinned repo; [a, b] = only these pins, by name
# cwd: ~/Documents/x          # only without foreach; default = the schedules folder's parent
enabled: true                 # absent = true
model: opus                   # claude only; absent = CLI default
effort: medium                # claude only
permission-mode: acceptEdits  # claude only; plan | acceptEdits | auto; default = the Sync button's (\`SYNC_PERMISSION_MODE\`, \`auto\`)
allowed-tools: [Bash, Read]   # claude only; absent = CLI default
max-turns: 60                 # claude only
timeout: 30m                  # both; 30s | 30m | 2h; wrapper kills the step after this; default 60m
---
`;

/** Shell is the mock's template; both Claude kinds are the spec's example file, the skill one verbatim and the prompt one with the mock's multi-step body. */
export function jobTemplate(kind: JobKind): string {
  if (kind === 'skill') return `${CLAUDE_HEAD}/git-sync\n`;
  if (kind === 'prompt') {
    return `${CLAUDE_HEAD}Weekly housekeeping for this repo, in order:
1. Run the git-sync skill. Stop here if it reports a diverged trunk.
2. Run docs-sync. Re-baseline only the docs it rewrote.
3. If anything changed, open one \`docs:\` PR titled
   "docs: weekly sync" and put the docs-sync report in the body.
Reply with one line per step: done, skipped (why) or failed (why).
`;
  }
  return `---
# Every weekday at 07:00; five cron fields.
cron: "0 7 * * 1-5"
# Which machines install it: mac, wsl, or both.
machines: [mac, wsl]
run: shell
# pinned = every pinned repo; a list = only these, by folder name.
foreach: pinned
enabled: true
---
\`\`\`bash
git pull --ff-only --quiet
\`\`\`
`;
}

const JOB_NAME = /^[a-z0-9-]+$/;
const RESERVED_NAMES = new Set(['runs', 'validate', 'reconcile', 'reveal']);

/** The Name field's live check, the same rules the server applies (pattern, reserved route segments, an existing file); null when the name is usable. */
export function nameProblem(name: string, existing: readonly string[]): string | null {
  if (name === '') return 'Name the job; it becomes the filename.';
  if (!JOB_NAME.test(name)) return 'Lowercase letters, digits and - only.';
  if (RESERVED_NAMES.has(name)) return `${name} is reserved.`;
  if (existing.includes(name)) return `A job named ${name} already exists.`;
  return null;
}

/** The file asks for `permission-mode: acceptEdits`, which is what the drawer's amber note warns about. Read off the frontmatter, so it shows mid-edit too. */
export function editsWithoutAsking(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return false;
  const line = m[1].split(/\r?\n/).find(l => /^permission-mode\s*:/.test(l));
  if (line === undefined) return false;
  const raw = line.replace(/^permission-mode\s*:/, '').trim();
  return raw.slice(0, scalarEnd(raw)).replace(/^(["'])(.*)\1$/, '$2') === 'acceptEdits';
}

/** `nextLine` as the Next cell's two stacked lines: what day, then the clock. A line with no space (`paused`, `—`) is one line. */
export function splitNext(line: string): [string, string | null] {
  const at = line.lastIndexOf(' ');
  return at < 0 ? [line, null] : [line.slice(0, at), line.slice(at + 1)];
}

/** A row's or a Runs line's text with `late` after its first part (the time), for a scheduled run that fired after its slot. */
export function withLate(line: string, late: boolean): string {
  if (!late) return line;
  if (line === '') return 'late';
  const parts = line.split(' · ');
  return [parts[0], 'late', ...parts.slice(1)].join(' · ');
}

/** The one line a refused write leaves under the toolbar. `what` names the action (`Run now`, `Save`); `status` 0 is a fetch that never answered. */
export function writeFailureText(what: string, status: number, body: unknown): string {
  const kind = refusalKind(status, body);
  if (kind === 'read-only') return READ_ONLY_TEXT;
  if (kind === 'token') return `${what} needs the Answer token — set it under Settings › Local › Connection.`;
  if (status === 0) return `${what} failed: the server did not answer.`;
  const error = body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (status === 409 && error === 'not-owner') return 'Another server owns the schedules on this machine; this one only reads.';
  if (status === 409 && error === 'already-running') return `${what}: the job is already running.`;
  if (status === 409 && error === 'not-running') return `${what}: the job is not running.`;
  if (status === 409 && error === 'exists') return `${what}: a job with that name already exists.`;
  if (status === 404) return `${what}: no such job.`;
  if (status === 422) return `${what}: the file has errors.`;
  if (status === 501) return `${what} needs macOS.`;
  return `${what} failed (HTTP ${status}).`;
}

/** The cost tile's second line: the change against the window before, `up` (red) when it grew. */
export function costDelta(stats: ScheduleStats, days: number): { text: string; dir: 'up' | 'dn' | null } {
  if (stats.prev.runs === 0 && stats.prev.costUsd === 0) return { text: `nothing in the previous ${days}d`, dir: null };
  const d = stats.costUsd - stats.prev.costUsd;
  if (Math.abs(d) < 0.005) return { text: `same as previous ${days}d`, dir: null };
  return { text: `${d > 0 ? '↑' : '↓'} $${Math.abs(d).toFixed(2)} vs previous ${days}d`, dir: d > 0 ? 'up' : 'dn' };
}

/** ok over every finished run, lost counted against it; NaN (which `formatStat` reads `—`) when nothing finished. */
export function successRate(stats: ScheduleStats): number {
  const finished = stats.ok + stats.failed + stats.lost;
  return finished > 0 ? stats.ok / finished : Number.NaN;
}

/** The job whose runs used most of the window's tokens, and its share, when more than one job used any. */
export function topTokenShare(runs: ScheduleRun[]): { job: string; share: number } | null {
  const byJob = new Map<string, number>();
  for (const r of runs) {
    const n = r.steps.reduce((sum, s) => sum + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);
    if (n > 0) byJob.set(r.job, (byJob.get(r.job) ?? 0) + n);
  }
  if (byJob.size < 2) return null;
  let total = 0;
  let top: [string, number] = ['', 0];
  for (const [job, n] of byJob) {
    total += n;
    if (n > top[1]) top = [job, n];
  }
  return { job: top[0], share: top[1] / total };
}

/** The median duration of the finished runs, or NaN when none has one. */
export function medianMs(runs: ScheduleRun[]): number {
  const ms = runs.map(r => r.ms).filter((m): m is number => m !== null).sort((a, b) => a - b);
  if (ms.length === 0) return Number.NaN;
  const mid = ms.length >> 1;
  return ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
}

/** A run fans out over repos when it planned more than one step or a step names a repo. */
export function isFanOut(run: ScheduleRun): boolean {
  return run.total > 1 || run.steps.some(s => s.repo !== null);
}

/** The fold's kicker over one run: `Yesterday 22:00 · by schedule · late · 12 repos · 11m 4s · $0.84`, or `Now · by hand · 1 repo · 20s so far`. */
export function runKicker(run: ScheduleRun, now: Date): string {
  const t = Date.parse(run.startedAt);
  let when = '—';
  if (run.state === 'running') when = 'Now';
  else if (Number.isFinite(t)) {
    const d = new Date(t);
    const back = dayDiff(d, now);
    const day = back <= 0 ? 'Today' : back === 1 ? 'Yesterday' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    when = `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const cost = runCost(run);
  const took = run.state === 'running'
    ? Number.isFinite(t) ? `${formatStat(now.getTime() - t, 'ms')} so far` : ''
    : run.ms !== null ? formatStat(run.ms, 'ms') : '';
  return [
    when,
    run.trigger === 'manual' ? 'by hand' : 'by schedule',
    run.late ? 'late' : '',
    isFanOut(run) ? `${run.total} repo${run.total === 1 ? '' : 's'}` : '',
    took,
    cost !== null ? `$${cost.toFixed(2)}` : ''
  ].filter(Boolean).join(' · ');
}

/** One step's pill. A failure reads its exit code when it has a non-zero one; a step with no outcome is in flight, or lost with its run. */
export function stepPill(step: ScheduleStep, runState: ScheduleRun['state']): Pill {
  switch (step.outcome) {
    case 'ok': return { text: 'ok', tone: 'green' };
    case 'failed': return { text: step.exit !== null && step.exit !== 0 ? `exit ${step.exit}` : 'failed', tone: 'red' };
    case 'timeout': return { text: 'timeout', tone: 'red' };
    case 'stopped': return { text: 'stopped', tone: 'mustard' };
    case 'skipped': return { text: 'skipped', tone: 'dim' };
    default: return runState === 'running' ? { text: 'running', tone: 'run' } : { text: 'lost', tone: 'mustard' };
  }
}

/** A run's own pill on the Runs page: the ledger's finished reading, or `running · n of N`. */
export function runPill(run: ScheduleRun): Pill {
  return run.state === 'running' ? runningPill(run) : finishedPill(run);
}

/**
 * Which steps a fold lists and how many ok ones it only counts: every step that is not ok (failures, skips, in flight) always shows, then ok steps fill up
 * to `keepOk` lines. Steps keep their order.
 */
export function splitSteps(steps: ScheduleStep[], keepOk: number): { shown: ScheduleStep[]; hiddenOk: number } {
  const notOk = steps.filter(s => s.outcome !== 'ok').length;
  let room = Math.max(0, keepOk - notOk);
  let hiddenOk = 0;
  const shown = steps.filter(s => {
    if (s.outcome !== 'ok') return true;
    if (room > 0) { room--; return true; }
    hiddenOk++;
    return false;
  });
  return { shown, hiddenOk };
}

/** The Runs page's When cell: `22:00`, `22:00 · late`. */
export function runClock(run: ScheduleRun): string {
  const t = Date.parse(run.startedAt);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return withLate(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, run.late);
}

/** The launchd label a job is installed under (spec §Reconcile), what the menu's Copy puts on the clipboard. */
export function launchdLabel(name: string): string {
  return `com.claude-dashboard.schedule.${name}`;
}

/**
 * The toolbar's reconcile chip. A server that does not own the schedules says whose they are (`owned by <cwd>:<port>`), or `not owner` when it never opted
 * in; the owner reads its reconcile verdict.
 */
export function reconcileChip(data: Pick<SchedulesResponse, 'owner' | 'reconcile' | 'jobs'>): Pill {
  if (data.owner !== 'owner') return { text: data.owner.ownedBy ? `owned by ${data.owner.ownedBy}` : 'not owner', tone: 'dim' };
  const { state, changes } = data.reconcile;
  switch (state) {
    case 'in-sync': return { text: `${data.jobs.filter(j => j.installed).length} installed · in sync`, tone: 'green' };
    case 'drift': return { text: `drift · ${changes.length} to apply`, tone: 'amber' };
    case 'pending': return { text: `${changes.length} pending`, tone: 'mustard' };
    case 'failed': return { text: 'reconcile failed', tone: 'red' };
    case 'no-plugin': return { text: 'plugin not installed', tone: 'red' };
    case 'cron-down': return { text: 'cron is not running', tone: 'red' };
    case 'bad-machine': return { text: 'bad SCHEDULE_MACHINE', tone: 'red' };
    case 'no-claude': return { text: 'claude CLI not found', tone: 'red' };
    default: return { text: 'not owner', tone: 'dim' };
  }
}

/** What the first Reconcile click shows before anything is applied: one row per planned change, a summary line, and whether Apply has work to do. */
export interface ReconcilePreview {
  summary: string;
  rows: Array<{ key: string; name: string; action: ReconcileChange['action']; why: string }>;
  error: string | null;
  canApply: boolean;
}

/**
 * The dry plan `POST /api/schedules/reconcile` answers without `apply`, as the preview shows it; null when the body is not a report. A `pending` change is
 * deferred, so it is listed but does not count toward Apply; the nameless change is the crontab block's unrecognised lines.
 */
export function reconcilePreview(body: unknown): ReconcilePreview | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { changes?: unknown }).changes)) return null;
  const { changes, unchanged, error } = body as { changes: ReconcileChange[]; unchanged?: unknown; error?: unknown };
  const acts = changes.filter(c => c.action !== 'pending').length;
  const pending = changes.length - acts;
  const parts: string[] = [];
  if (acts > 0) parts.push(`${acts} change${acts === 1 ? '' : 's'} to apply`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (parts.length === 0) parts.push('Nothing to do');
  if (typeof unchanged === 'number' && unchanged > 0) parts.push(`${unchanged} unchanged`);
  return {
    summary: parts.join(' · '),
    rows: changes.map((c, i) => ({ key: `${i}:${c.name}`, name: c.name || 'crontab block', action: c.action, why: c.why })),
    error: typeof error === 'string' && error !== '' ? error : null,
    canApply: acts > 0
  };
}

/** The ledger's and the Runs page's status dot, read off the row's pill: a paused job is `off` whatever its last run said. */
export function dotTone(pill: Pill, enabled: boolean): 'ok' | 'warn' | 'bad' | 'live' | 'off' | 'lost' | '' {
  if (pill.tone === 'run') return 'live';
  if (!enabled) return 'off';
  switch (pill.tone) {
    case 'green': return 'ok';
    case 'amber': return 'warn';
    case 'red': return 'bad';
    case 'mustard': return 'lost';
    default: return '';
  }
}

/** The Success tile's second line: the job behind most of the window's failed or lost runs, `7 of 9 failures: lookout`; null when none failed. */
export function topFailure(runs: ScheduleRun[]): string | null {
  const byJob = new Map<string, number>();
  let total = 0;
  for (const r of runs) {
    if (r.state !== 'failed' && r.state !== 'lost') continue;
    total++;
    byJob.set(r.job, (byJob.get(r.job) ?? 0) + 1);
  }
  if (total === 0) return null;
  let top: [string, number] = ['', 0];
  for (const e of byJob) if (e[1] > top[1]) top = e;
  return top[1] === total ? `all ${total} from ${top[0]}` : `${top[1]} of ${total} failures: ${top[0]}`;
}

/**
 * The pins a fan-out job runs over, for the Run-now popover and the fan-out chip: every listed pin for `foreach: pinned`, the file's own list otherwise (a
 * name not pinned here still shows; the wrapper skips it). Empty for a single-cwd job.
 */
export function jobPins(foreach: 'pinned' | string[] | null, pinned: readonly { name: string; listed: boolean }[]): string[] {
  if (foreach === 'pinned') return pinned.filter(p => p.listed).map(p => p.name);
  return Array.isArray(foreach) ? [...foreach] : [];
}

/** Each pin's last outcome in the job's newest finished run, for the popover's middle column; null for a pin that run never reached. */
export function pinOutcome(last: ScheduleRun | null, pin: string): Pill | null {
  const step = last?.steps.find(s => s.repo === pin);
  return step ? stepPill(step, last!.state) : null;
}

/** The last non-blank line of a shell step's output, or its `why`: the one mono line a failed step shows under its name. */
export function stepErrLine(step: ScheduleStep): string | null {
  const tail = step.tail?.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop();
  return tail ?? step.why ?? null;
}

/** A pill as its chip's classes: the Git tab's four `.git-chip` tones, plus the red and running ones Schedules adds. */
export function chipClass(tone: PillTone): string {
  if (tone === 'red') return 'git-chip sch-red';
  if (tone === 'run') return 'git-chip sch-runner';
  return `git-chip ${tone}`;
}
