import type { TraceRel, TraceStep } from '../../../shared/types';

/** The Trace spine's filter chips. A prompt row always passes (it anchors its turn). */
export type TraceFilter = 'all' | 'edits' | 'fails' | 'you';

export const TRACE_FILTERS: { key: TraceFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'edits', label: 'Edits' },
  { key: 'fails', label: 'Fails' },
  { key: 'you', label: 'You' }
];

/** A cause read from the step that has it: "informed by …". */
export const REL_LABEL: Record<TraceRel, string> = {
  asked: 'asked by',
  answer: 'your answer',
  plan: 'follows plan',
  informed: 'informed by',
  verifies: 'checks',
  retry: 'retrying',
  delegated: 'delegated by',
  commits: 'commits'
};

/** The same edges read forward, for the Why card's "Led to" rows. */
export const REL_FWD_LABEL: Record<TraceRel, string> = {
  asked: 'next step',
  answer: 'uses the answer',
  plan: 'carries out',
  informed: 'used by',
  verifies: 'checked by',
  retry: 'fixed by',
  delegated: 'subagent ran',
  commits: 'committed in'
};

/**
 * Fold a response into the steps held. A `reset` replaces everything (the
 * server's epoch changed — stale ids must not survive into the new trace).
 * Otherwise: replace by id in place, append unseen ids, then stable-sort by
 * `at` so a late arrival lands where it happened. ISO strings sort lexically;
 * `''` (no timestamp yet) sorts first, and the sort is stable so equal `at`
 * keeps arrival order.
 */
export function mergeTrace(prev: TraceStep[], incoming: TraceStep[], reset: boolean): TraceStep[] {
  if (reset) return incoming;
  const out = prev.slice();
  const at = new Map<string, number>();
  out.forEach((s, i) => at.set(s.id, i));
  for (const s of incoming) {
    const i = at.get(s.id);
    if (i === undefined) { at.set(s.id, out.length); out.push(s); }
    else out[i] = s;
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Everything that led to `id`: breadth-first over `why`, nearest first, each
 * id kept at its first (shortest) reach. Ids not in `steps` are skipped — a
 * cause outside the delivered set is simply not drawn.
 */
export function causesOf(steps: TraceStep[], id: string): Map<string, { d: number; rel: TraceRel; from: string }> {
  const byId = new Map<string, TraceStep>();
  for (const s of steps) byId.set(s.id, s);
  const out = new Map<string, { d: number; rel: TraceRel; from: string }>();
  const q: [string, number][] = [[id, 0]];
  while (q.length) {
    const [cur, d] = q.shift()!;
    const s = byId.get(cur);
    if (!s) continue;
    for (const w of s.why) {
      if (w.id === id || !byId.has(w.id) || out.has(w.id)) continue;
      out.set(w.id, { d: d + 1, rel: w.rel, from: cur });
      q.push([w.id, d + 1]);
    }
  }
  return out;
}

/** The steps whose `why` names `id` — what this step led to. */
export function ledTo(steps: TraceStep[], id: string): TraceStep[] {
  return steps.filter(s => s.why.some(w => w.id === id));
}

/** Does the filter keep this step? The caller also keeps the picked row regardless. */
export function passesFilter(s: TraceStep, f: TraceFilter): boolean {
  if (f === 'all' || s.kind === 'prompt') return true;
  if (f === 'edits') return s.kind === 'edit';
  if (f === 'fails') return s.status === 'error';
  return s.kind === 'decide';
}

const TURN_LABEL_CAP = 48;

/**
 * Label for a turn: its prompt's first line, at most 48 chars (an ellipsis
 * counts toward the cap). `''` when the turn has no prompt step.
 */
export function turnLabel(steps: TraceStep[], turn: number): string {
  const p = steps.find(s => s.turn === turn && s.kind === 'prompt');
  if (!p) return '';
  const line = p.detail.split('\n')[0].trim();
  return line.length > TURN_LABEL_CAP ? line.slice(0, TURN_LABEL_CAP - 1).trimEnd() + '…' : line;
}

/** What the reader opened or closed by hand, by fold key. An explicit close beats the auto-open on a pick. */
export interface TraceFolds { open: ReadonlySet<string>; closed: ReadonlySet<string> }

/**
 * A run folded into one summary row: a subagent's steps under their Task
 * (`key` is the Task id), or 4+ consecutive main-thread calls of one tool in
 * one turn (`key` is `'run:' + first id`, `task` is null).
 */
export interface TraceFold {
  key: string;
  task: TraceStep | null;
  /** The run's own steps, one tick each. */
  members: TraceStep[];
  /** The summary's depth: one past its Task's, 0 for a main-thread run. */
  depth: number;
  open: boolean;
  /** The Task is still running (a run: one of its steps is). */
  live: boolean;
  ok: number;
  failed: number;
  running: number;
  /** Members plus everything nested under them: the steps the toggle stands for while they are hidden. */
  ids: string[];
}

/** The spine, top to bottom. `TraceSpine` renders this list and decides nothing. */
export type TraceItem =
  | { t: 'dropped'; key: string; n: number }
  | { t: 'turn'; key: string; turn: number; label: string }
  | { t: 'step'; key: string; step: TraceStep; depth: number }
  | { t: 'fold'; key: string; fold: TraceFold }
  | { t: 'more'; key: string; fold: string; n: number; depth: number; sub: boolean };

/** A running fold that is closed still shows this many of its newest steps. */
export const FOLD_TAIL = 3;
/** Consecutive main-thread calls of one tool that fold into a run. */
export const RUN_MIN = 4;

/** `Agent · general-purpose` → `general-purpose`: the tool string with a leading `Word · ` stripped. */
export function subagentType(tool: string): string {
  return tool.replace(/^\w+ · /, '');
}

/** `Xm YYs` between two ISO stamps, or `Ns` under a minute. A bad or reversed pair reads `0s`. */
export function traceDuration(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  const d = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return d >= 60 ? `${Math.floor(d / 60)}m ${String(d % 60).padStart(2, '0')}s` : `${d}s`;
}

/** `t` cut to `n` characters, the ellipsis counting toward them. */
export function clipText(t: string, n: number): string {
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * Lay the spine out: turn headers, step rows with their depth, fold summaries
 * and their "N earlier steps" line, and the not-loaded notice on top. Port of
 * the mock's `traceBody()` / `foldedRows()` / `foldRun()`.
 *
 * - Depth walks `agent` up the chain; a step whose Task is not delivered sits
 *   on the main thread.
 * - Under `filter: 'all'` every Task's children fold into one summary. A fold
 *   is open when the reader opened it, or when it holds `sel` (not already in
 *   its visible tail) and the reader did not close it. Closed and running, it
 *   shows its last `FOLD_TAIL` steps under a `more` line.
 * - Under any other filter nothing folds: each passing step sits under its own
 *   Task at its depth, a Task with a passing descendant stays so the step has a
 *   parent, and `sel` always shows.
 */
export function traceLayout(steps: TraceStep[], opts: {
  filter: TraceFilter; sel: string | null; folds: TraceFolds; dropped?: number;
}): TraceItem[] {
  const { filter, sel, folds } = opts;
  const byId = new Map<string, TraceStep>();
  for (const s of steps) byId.set(s.id, s);
  const isChild = (s: TraceStep): boolean => !!s.agent && s.agent !== s.id && byId.has(s.agent);
  const kids = new Map<string, TraceStep[]>();
  for (const s of steps) {
    if (!isChild(s)) continue;
    const k = kids.get(s.agent!);
    if (k) k.push(s); else kids.set(s.agent!, [s]);
  }
  const depths = new Map<string, number>();
  const depthOf = (s: TraceStep): number => {
    const known = depths.get(s.id);
    if (known !== undefined) return known;
    let d = 0;
    const seen = new Set([s.id]);
    for (let p = s; isChild(p) && !seen.has(p.agent!); d++) { seen.add(p.agent!); p = byId.get(p.agent!)!; }
    depths.set(s.id, d);
    return d;
  };
  const under = (s: TraceStep, out: Set<string>): Set<string> => {
    for (const k of kids.get(s.id) ?? []) if (!out.has(k.id)) { out.add(k.id); under(k, out); }
    return out;
  };
  const holds = (ms: TraceStep[]): boolean =>
    sel != null && ms.some(m => m.id === sel || under(m, new Set()).has(sel));

  const out: TraceItem[] = [];
  if (opts.dropped && opts.dropped > 0) out.push({ t: 'dropped', key: 'dropped', n: opts.dropped });

  // A turn's header leads its first rendered root only; turn 0 (steps before any prompt) gets none.
  const headed = new Set<number>([0]);
  const labels = new Map<number, string>();
  const head = (s: TraceStep) => {
    if (headed.has(s.turn)) return;
    headed.add(s.turn);
    if (!labels.has(s.turn)) labels.set(s.turn, turnLabel(steps, s.turn));
    out.push({ t: 'turn', key: 'h-' + s.id, turn: s.turn, label: labels.get(s.turn)! });
  };
  const roots = steps.filter(s => !isChild(s));

  if (filter !== 'all') {
    const keep = new Map<string, boolean>();
    const kept = (s: TraceStep): boolean => {
      let k = keep.get(s.id);
      if (k === undefined) {
        keep.set(s.id, false); // a cycle reads as not kept
        k = passesFilter(s, filter) || s.id === sel || (kids.get(s.id) ?? []).some(kept);
        keep.set(s.id, k);
      }
      return k;
    };
    const emit = (s: TraceStep) => {
      out.push({ t: 'step', key: s.id, step: s, depth: depthOf(s) });
      for (const k of kids.get(s.id) ?? []) if (kept(k)) emit(k);
    };
    for (const r of roots) if (kept(r)) { head(r); emit(r); }
    return out;
  }

  const fold = (key: string, members: TraceStep[], task: TraceStep | null) => {
    const n = members.length;
    let ok = 0, failed = 0, running = 0;
    for (const m of members) {
      if (m.status === 'ok') ok++;
      else if (m.status === 'error') failed++;
      else if (m.status === 'running') running++;
    }
    const live = task ? task.status === 'running' : running > 0;
    const tail = live ? members.slice(-FOLD_TAIL) : [];
    const open = folds.open.has(key) || (holds(members) && !holds(tail) && !folds.closed.has(key));
    const depth = task ? depthOf(task) + 1 : 0;
    const ids = new Set<string>();
    for (const m of members) { ids.add(m.id); under(m, ids); }
    out.push({ t: 'fold', key: 'f-' + key, fold: { key, task, members, depth, open, live, ok, failed, running, ids: [...ids] } });
    const rows = open ? members : tail;
    if (!open && rows.length && n > rows.length) {
      out.push({ t: 'more', key: 'm-' + key, fold: key, n: n - rows.length, depth, sub: !!task });
    }
    for (const m of rows) row(m);
  };
  const row = (s: TraceStep) => {
    out.push({ t: 'step', key: s.id, step: s, depth: depthOf(s) });
    const k = kids.get(s.id);
    if (k?.length) fold(s.id, k, s);
  };

  for (let i = 0; i < roots.length;) {
    const s = roots[i];
    let j = i + 1;
    if (s.kind !== 'prompt' && s.kind !== 'agent') {
      while (j < roots.length && roots[j].tool === s.tool && roots[j].turn === s.turn) j++;
    }
    head(s);
    if (j - i >= RUN_MIN) fold('run:' + s.id, roots.slice(i, j), null);
    else { row(s); j = i + 1; }
    i = j;
  }
  return out;
}
