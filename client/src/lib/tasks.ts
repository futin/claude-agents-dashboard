import type { SessionTask } from '../../../shared/types.js';

export interface TaskProgress {
  done: number;
  total: number;
  pct: number;
  /** In list order: a session can run several tasks at once. */
  live: SessionTask[];
  /** First pending task in list order, whether or not something is live. */
  next: SessionTask | null;
  allDone: boolean;
}

/** `null` for a session with no tasks, so callers render nothing for both never-used and all-deleted lists. */
export function taskProgress(tasks: SessionTask[] | null): TaskProgress | null {
  if (!tasks || tasks.length === 0) return null;
  const done = tasks.filter(t => t.status === 'completed').length;
  const total = tasks.length;
  return {
    done,
    total,
    pct: Math.round((done / total) * 100),
    live: tasks.filter(t => t.status === 'in_progress'),
    next: tasks.find(t => t.status === 'pending') ?? null,
    allDone: done === total
  };
}

/** Subjects come back whole: the folded line truncates in CSS, so a wider band shows more. */
export function taskLine(p: TaskProgress): { text: string; kind: 'live' | 'next' | 'done' } {
  const first = p.live[0];
  if (first) return { text: first.activeForm ?? first.subject, kind: 'live' };
  if (p.next) return { text: `Next: ${p.next.subject}`, kind: 'next' };
  return { text: 'All done', kind: 'done' };
}

/** Ids are opaque strings from the transcript, so "first" means list position, never a sort. */
export function scrollTargetId(p: TaskProgress): string | null {
  return p.live[0]?.id ?? p.next?.id ?? null;
}
