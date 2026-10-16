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
