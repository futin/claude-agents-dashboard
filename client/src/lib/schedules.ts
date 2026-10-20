/**
 * schedules.ts — the Management › Schedules page's view logic, apart from React so `test/schedules-view.test.ts` can drive it: what a ledger row says, how
 * the Runs list groups by day, how the stats band formats, and the Repos helper's two directions over a job file's `foreach:` / `cwd:` lines.
 *
 * Everything takes `now` and formats in local time with fixed English names, so the output is the same in every TZ and locale a test runs under (the
 * dashboard shows the clock of the machine the job runs on, which is the browser's in the single-machine case this page is built for).
 */
import type { ScheduleJobRow, ScheduleRun } from '../../../shared/types';

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
  const value = line.replace(/^foreach\s*:/, '').trim();
  if (value === 'pinned') return { mode: 'all', picks: [] };
  const list = /^\[(.*)\]$/.exec(value);
  if (!list) return { mode: 'cwd', picks: [] };
  const picks = list[1].split(',').map(x => x.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(x => x !== '');
  return { mode: 'pick', picks };
}
