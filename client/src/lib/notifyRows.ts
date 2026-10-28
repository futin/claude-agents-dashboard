/**
 * notifyRows.ts — the Settings page's push-event rows and when each one is usable. Pure — tested (`test/notify-rows.test.ts`).
 */
import type { NotifyEvent } from '../../../shared/types';

export interface NotifyEventRow {
  key: NotifyEvent;
  name: string;
  hint: string;
}

/** The push events, ordered by how much they matter when you are away. */
export const NOTIFY_EVENT_ROWS: readonly NotifyEventRow[] = [
  { key: 'question', name: 'Question waiting', hint: 'A session is asking something you can answer from the dashboard.' },
  { key: 'permission', name: 'Permission dialog open', hint: 'A terminal permission dialog is blocking a session until you return.' },
  { key: 'plan', name: 'Plan waiting for review', hint: 'A proposed plan is held for a remote send-back.' },
  { key: 'stop', name: 'Task finished', hint: 'A session finished its turn. Suppressed while background agents are still running.' },
  { key: 'routine-failed', name: 'Routine failed', hint: 'A routine failed, was refused or never finished. Ignores the three conditions below.' },
  {
    key: 'tick-capped',
    name: 'Backlog tick blocked',
    hint: 'A backlog-tick job stopped grooming: its plans awaiting review reached the cap. Ignores the three conditions below.'
  },
  {
    key: 'usage-limit',
    name: 'Usage limit reached',
    hint: 'Your 5-hour usage window hit 100%. Ignores the three conditions below. Needs Record usage history (Usage forecast).'
  },
  {
    key: 'usage-reset',
    name: 'Usage limit reset',
    hint: 'The 5-hour window you hit has reset. Ignores the three conditions below. Needs Record usage history (Usage forecast).'
  }
];

const USAGE_EVENTS: ReadonlySet<NotifyEvent> = new Set(['usage-limit', 'usage-reset']);

/**
 * Whether a row's switch is disabled, and the note that replaces its hint. Every row needs a topic; the usage rows also need `SHOW_USAGE` and Record usage
 * history. The `SHOW_USAGE` note wins (it is the outer gate); the recording note shows only once push is configured, since without a topic the row's own
 * hint is the better pointer, as on the other rows.
 */
export function notifyRowState(
  key: NotifyEvent,
  s: { notifyAvailable: boolean; usageAvailable: boolean; recordUsageHistory: boolean }
): { disabled: boolean; note: string | null } {
  const pushOff = !s.notifyAvailable;
  if (!USAGE_EVENTS.has(key)) return { disabled: pushOff, note: null };
  if (!s.usageAvailable) return { disabled: true, note: 'Usage is hidden (SHOW_USAGE=false) on this server.' };
  if (pushOff) return { disabled: true, note: null };
  if (!s.recordUsageHistory) return { disabled: true, note: 'Turn on Record usage history under Usage forecast to use this.' };
  return { disabled: false, note: null };
}
