/**
 * schedule-log.ts — folds the run wrapper's JSONL log (`~/.claude/schedules/runs/*.jsonl`) into runs, then into stats and push copy.
 * The producer is `plugin/lib/run-schedule.mjs`; the record kinds and what `lost` means are in
 * docs/superpowers/specs/2026-10-19-scheduled-workflows-design.md §The run log.
 *
 * The reader is incremental: per file it keeps the inode and the byte offset of the last complete line it folded, and a poll reads only what was
 * appended. Folding is keyed by run id (and step index), so reading a record twice changes nothing — which is what lets a renamed or re-read file be
 * absorbed without bookkeeping. `lost` is derived at `read()` time from the injected liveness check, never stored.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ScheduleRun, ScheduleStats, ScheduleStep } from '../../shared/types.js';

const AGE_SLACK_MS = 5 * 60_000;
const WATCH_DEBOUNCE_MS = 100;
const OUTCOMES = new Set(['ok', 'failed', 'skipped', 'timeout', 'stopped']);

type Rec = Record<string, unknown>;

interface Fold {
  start: Rec | null;
  steps: Map<number, ScheduleStep>;
  end: Rec | null;
}

interface FileState {
  ino: number;
  offset: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `<machine>.jsonl` and `<machine>.<yyyymmdd>[.<n>].jsonl` both belong to `<machine>`. */
function machineOf(file: string): string {
  return file.split('.')[0];
}

function emptyStep(index: number, at: string): ScheduleStep {
  return {
    index, repo: null, cwd: null, startedAt: at, endedAt: null, outcome: null, ms: null, exit: null, why: null, tail: null,
    costUsd: null, tokensIn: null, tokensOut: null, turns: null, model: null, sessionId: null,
  };
}

export function createLogReader(
  dir: string,
  liveness: (pid: number, job: string) => boolean | null,
  timeoutMsFor: (job: string) => number,
  now: () => number = Date.now,
): { read(): ScheduleRun[]; watch(onChange: () => void): () => void } {
  let folds = new Map<string, Fold>();
  let refusals = new Map<string, ScheduleRun>();
  let files = new Map<string, FileState>();

  const foldOf = (id: string): Fold => {
    let f = folds.get(id);
    if (!f) folds.set(id, (f = { start: null, steps: new Map(), end: null }));
    return f;
  };

  function apply(rec: Rec, machine: string): void {
    const kind = rec.kind;
    if (kind === 'refused') {
      const job = str(rec.job);
      const at = str(rec.at);
      const why = str(rec.why);
      // A refusal because a live wrapper holds the lock is the lock working, not a run that failed to happen.
      if (!job || !at || !why || why === 'running') return;
      const id = `refused-${machine}-${job}-${Date.parse(at)}`;
      refusals.set(id, {
        id, job, machine, trigger: rec.trigger === 'manual' ? 'manual' : 'schedule', startedAt: at, endedAt: at, ms: null, late: false, state: 'refused',
        ok: 0, failed: 0, skipped: 0, total: 0, stopped: false, error: null, why, steps: [],
      });
      return;
    }
    const id = str(rec.run);
    if (!id) return;
    const f = foldOf(id);
    if (kind === 'start') f.start = rec;
    else if (kind === 'end') f.end = rec;
    else if (kind === 'step-start' || kind === 'step-end') {
      const index = num(rec.step);
      const at = str(rec.at);
      if (index === null || !at) return;
      let s = f.steps.get(index);
      if (!s) f.steps.set(index, (s = emptyStep(index, at)));
      if (kind === 'step-start') {
        s.startedAt = at;
        s.repo = str(rec.repo);
        s.cwd = str(rec.cwd);
        s.sessionId = str(rec.session);
        return;
      }
      s.endedAt = at;
      s.ms = num(rec.ms);
      s.exit = num(rec.exit);
      s.why = str(rec.why);
      s.tail = str(rec.tail);
      s.costUsd = num(rec.cost);
      s.tokensIn = num(rec.tokensIn);
      s.tokensOut = num(rec.tokensOut);
      s.turns = num(rec.turns);
      s.model = str(rec.model);
      // An outcome the fold does not know must not read as in flight.
      s.outcome = OUTCOMES.has(rec.outcome as string) ? (rec.outcome as ScheduleStep['outcome']) : 'failed';
    }
  }

  /** Complete lines from `offset` on; a torn last line stays unread until its newline arrives. Returns the new offset. */
  function readFrom(file: string, offset: number, size: number): number {
    if (size <= offset) return offset;
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(path.join(dir, file), 'r');
    let got = 0;
    try {
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    const last = buf.subarray(0, got).lastIndexOf(0x0a);
    if (last < 0) return offset;
    const machine = machineOf(file);
    for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
      if (line === '') continue;
      let rec: unknown;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) apply(rec as Rec, machine);
    }
    return offset + last + 1;
  }

  function sync(): void {
    let names: string[];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(); } catch { names = []; }
    const current = new Map<string, fs.Stats>();
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.isFile()) current.set(n, st);
      } catch { /* vanished between readdir and stat */ }
    }
    const byIno = new Map<number, string>();
    for (const [n, st] of current) byIno.set(st.ino, n);

    // A file whose inode shows up under another name was renamed (rotation) and keeps its offset; one that is gone, or shrank in place, may have
    // taken records with it, and the only honest fold is a rebuild.
    let rebuild = false;
    const next = new Map<string, FileState>();
    for (const [n, state] of files) {
      const st = current.get(n);
      if (st && st.ino === state.ino) {
        if (st.size < state.offset) rebuild = true;
        next.set(n, state);
        continue;
      }
      const moved = byIno.get(state.ino);
      if (moved !== undefined && !next.has(moved)) next.set(moved, state);
      else rebuild = true;
    }
    if (rebuild) {
      folds = new Map();
      refusals = new Map();
      next.clear();
    }
    for (const [n, st] of current) {
      const state = next.get(n) ?? { ino: st.ino, offset: 0 };
      if (state.ino !== st.ino) { state.ino = st.ino; state.offset = 0; }
      try { state.offset = readFrom(n, state.offset, st.size); } catch { /* unreadable this poll; retried the next */ }
      next.set(n, state);
    }
    files = next;
  }

  function build(id: string, f: Fold): ScheduleRun | null {
    const start = f.start;
    if (!start) return null;
    const job = str(start.job);
    const startedAt = str(start.at);
    if (!job || !startedAt) return null;
    const steps = [...f.steps.values()].sort((a, b) => a.index - b.index);
    const total = num(start.steps) ?? steps.length;
    const end = f.end;
    let ok = 0, failed = 0, skipped = 0;
    if (end) {
      ok = num(end.ok) ?? 0;
      failed = num(end.failed) ?? 0;
      skipped = num(end.skipped) ?? 0;
    } else {
      for (const s of steps) {
        if (s.outcome === 'ok') ok++;
        else if (s.outcome === 'skipped') skipped++;
        else if (s.outcome !== null) failed++;
      }
    }
    const error = end ? str(end.error) : null;
    let state: ScheduleRun['state'];
    let why: string | null = null;
    if (end) {
      state = failed > 0 || error ? 'failed' : 'ok';
    } else {
      const pid = num(start.pid);
      const alive = pid === null ? null : liveness(pid, job);
      if (alive === true) state = 'running';
      else if (alive === false) { state = 'lost'; why = 'wrapper not running'; }
      else if (now() - Date.parse(startedAt) > timeoutMsFor(job) * Math.max(total, 1) + AGE_SLACK_MS) { state = 'lost'; why = 'no end record past its timeout'; }
      else state = 'running';
    }
    return {
      id, job, machine: str(start.machine) ?? '', trigger: start.trigger === 'manual' ? 'manual' : 'schedule', startedAt,
      endedAt: end ? str(end.at) : null, ms: end ? num(end.ms) : null, late: start.late === true, state, ok, failed, skipped, total,
      stopped: end?.stopped === true, error, why, steps,
    };
  }

  return {
    read() {
      sync();
      const runs: ScheduleRun[] = [...refusals.values()];
      for (const [id, f] of folds) {
        const r = build(id, f);
        if (r) runs.push(r);
      }
      // ISO timestamps from toISOString() are UTC and fixed-width, so string order is time order.
      return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? -1 : 1));
    },

    watch(onChange) {
      let timer: NodeJS.Timeout | null = null;
      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(dir, { persistent: false }, () => {
          // One append is often two events (create + change); the poll and the start-up read cover a watcher that never arms.
          if (timer) return;
          timer = setTimeout(() => { timer = null; onChange(); }, WATCH_DEBOUNCE_MS);
          timer.unref();
        });
        watcher.on('error', () => { /* the folder went away; the next poll reads whatever is there */ });
      } catch { /* no runs/ folder yet */ }
      return () => {
        if (timer) clearTimeout(timer);
        timer = null;
        watcher?.close();
      };
    },
  };
}

function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Rename every `<machine>.jsonl` over `limitBytes` to `<machine>.<yyyymmdd>.jsonl`, never over an earlier rotation the same day. Owner only. */
export function rotateIfLarge(dir: string, limitBytes = 20 * 1024 * 1024): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const stamp = ymd(new Date());
  const moved: string[] = [];
  for (const n of names) {
    const m = /^([^.]+)\.jsonl$/.exec(n);
    if (!m) continue;
    try {
      if (fs.statSync(path.join(dir, n)).size <= limitBytes) continue;
      let target = `${m[1]}.${stamp}.jsonl`;
      for (let i = 2; fs.existsSync(path.join(dir, target)); i++) target = `${m[1]}.${stamp}.${i}.jsonl`;
      fs.renameSync(path.join(dir, n), path.join(dir, target));
      moved.push(target);
    } catch { /* raced with another rotation or a deletion; the next pass looks again */ }
  }
  return moved;
}

function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Totals over `days` whole local days ending today (the last entry of `byDay`), and `prev` for the same number of days just before. Built from calendar
 * arithmetic rather than 24 h multiples so a DST change cannot shift a run into the neighbouring day. Refusals are not runs.
 */
export function computeStats(runs: ScheduleRun[], days: 7 | 30 | 90, now: Date): ScheduleStats {
  const dayStart = (offset: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const from = dayStart(-(days - 1)).getTime();
  const to = dayStart(1).getTime();
  const prevFrom = dayStart(-(2 * days - 1)).getTime();

  const byDay = new Map<string, { day: string; ok: number; failed: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const day = localDay(dayStart(-i));
    byDay.set(day, { day, ok: 0, failed: 0 });
  }
  const stats: ScheduleStats = { runs: 0, ok: 0, failed: 0, lost: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, wallMs: 0, byDay: [...byDay.values()], prev: { costUsd: 0, runs: 0 } };

  for (const r of runs) {
    if (r.state === 'refused') continue;
    const t = Date.parse(r.startedAt);
    if (!Number.isFinite(t)) continue;
    const cost = r.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    if (t >= prevFrom && t < from) {
      stats.prev.runs++;
      stats.prev.costUsd += cost;
      continue;
    }
    if (t < from || t >= to) continue;
    stats.runs++;
    stats.costUsd += cost;
    for (const s of r.steps) {
      stats.tokensIn += s.tokensIn ?? 0;
      stats.tokensOut += s.tokensOut ?? 0;
    }
    stats.wallMs += r.ms ?? 0;
    const bucket = byDay.get(localDay(new Date(t)));
    if (r.state === 'ok') { stats.ok++; if (bucket) bucket.ok++; }
    else if (r.state === 'failed') { stats.failed++; if (bucket) bucket.failed++; }
    else if (r.state === 'lost') { stats.lost++; if (bucket) bucket.failed++; }
  }
  return stats;
}

function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The runs that earn a push, with the spec's copy (§Notifications). Dedupe against runs already pushed is the caller's: this only says what qualifies. */
export function pushableEvents(runs: ScheduleRun[]): Array<{ run: ScheduleRun; title: string; body: string }> {
  const out: Array<{ run: ScheduleRun; title: string; body: string }> = [];
  for (const run of runs) {
    if (run.state === 'lost') {
      out.push({ run, title: `${run.job} · lost`, body: `started ${clock(run.startedAt)}, no end record · machine slept?` });
    } else if (run.state === 'refused') {
      out.push({ run, title: `${run.job} · not run`, body: run.why ?? '' });
    } else if (run.state === 'failed') {
      if (run.error) {
        out.push({ run, title: `${run.job} · failed before start`, body: run.error });
        continue;
      }
      const first = run.steps.find((s) => s.outcome !== null && s.outcome !== 'ok' && s.outcome !== 'skipped');
      out.push({ run, title: `${run.job} · ${run.failed} of ${run.total} failed`, body: first?.why ?? first?.outcome ?? '' });
    }
  }
  return out;
}
