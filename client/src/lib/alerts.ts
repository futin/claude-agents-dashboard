/**
 * alerts.ts — the pure half of "tell me when a session needs me".
 *
 * The dashboard's whole premise is that you are not watching it. A row turning
 * amber is useless if nobody is looking at the tab, so `useSessionAlerts` turns
 * that transition into a notification. This module owns the decision of *what
 * counts as a transition*, which is the only part with edge cases worth testing.
 *
 * See `docs/subsystems/settings.md`.
 */

import type { Session } from '../../../shared/types';

/**
 * Statuses that mean a human has to do something: `question` is a held remote
 * question, a plan awaiting a verdict, or an open permission dialog; `incomplete`
 * is "your turn" — the agent finished and is waiting on you.
 */
const NEEDS_YOU: ReadonlySet<Session['status']> = new Set(['question', 'incomplete']);

/** A session worth alerting on, reduced to what the notification needs. */
export interface AlertTarget {
  id: string;
  label: string;
  status: Session['status'];
}

/** Snapshot of the statuses a previous poll saw, keyed by session id. */
export type StatusMap = ReadonlyMap<string, Session['status']>;

export function statusMap(sessions: readonly Session[]): Map<string, Session['status']> {
  return new Map(sessions.map(s => [s.id, s.status]));
}

/**
 * Sessions that just *became* something you need to act on.
 *
 * Only genuine transitions count. A session already waiting when you opened the
 * tab is not news, and re-alerting on every 3-second poll while it sits there
 * would be unusable — so a row must have been in a different status last time.
 *
 * `prev` being empty means we have no baseline (first poll after a load): the
 * caller skips that round entirely rather than alerting on the whole list at
 * once. That's the caller's job, not ours — this function stays a pure diff.
 */
export function diffAlerts(prev: StatusMap, next: readonly Session[]): AlertTarget[] {
  const out: AlertTarget[] = [];
  for (const s of next) {
    if (!NEEDS_YOU.has(s.status)) continue;
    const before = prev.get(s.id);
    if (before === s.status) continue; // still waiting — already announced
    out.push({ id: s.id, label: s.sessionName || s.project, status: s.status });
  }
  return out;
}

/** The line a notification shows for one session. */
export function alertText(t: AlertTarget): string {
  return t.status === 'question'
    ? `${t.label} needs an answer`
    : `${t.label} finished — your turn`;
}

/** The tab-title prefix used when alerts are pending (works where Notification doesn't). */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}
