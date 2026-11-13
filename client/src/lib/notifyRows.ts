/**
 * notifyRows.ts — the Settings page's push-event rows and when each one is usable. Pure — tested (`test/notify/notify-rows.test.ts`).
 */
import type { NotifyEvent, NotifyPolicy } from '../../../shared/types';

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

/**
 * Whether Settings warns that turning "Only when I'm away" off does **not** make `question` and `plan` unconditional.
 *
 * Both are published from the endpoint the remote-answer hook POSTs to, and the hook applies its own idle check *before* that POST (`ask-remote.sh`,
 * `plan-remote.sh`). At the desk it exits and lets the terminal dialog take the question, so the server never learns there is anything to push about and the
 * policy is never consulted. `permission` and `stop` have no such gate in their hooks, so those two really do become unconditional.
 *
 * True only in the state where that surprises you: pushes configured and on, the switch off, the idle threshold live, and at least one of the two affected
 * events on. `notify` is absent while the settings are still loading.
 */
export function afkStillGatesRemote(s: {
  pushUnconfigured: boolean;
  notify: Pick<NotifyPolicy, 'enabled' | 'requireAfk' | 'events'> | undefined;
  idleSecs: number | undefined;
}): boolean {
  const n = s.notify;
  if (s.pushUnconfigured || !n?.enabled || n.requireAfk) return false;
  return (n.events.question || n.events.plan) && (s.idleSecs ?? 0) > 0;
}
