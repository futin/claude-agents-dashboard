/**
 * notify.ts — server-sent ntfy pushes for "a session needs you".
 *
 * Why the server sends rather than the hooks: three of the four events already
 * arrive here as hook POSTs (`/api/questions/wait`, `/api/plans/wait`,
 * `/api/permissions/notify`), each at the moment it happens and with the
 * granularity the user picks events at. Delivering from here keeps the whole
 * policy in one testable place instead of re-implementing it in four shell
 * scripts — which is exactly what this replaces.
 *
 * Why it exists at all, given the in-browser alerts: WebKit exposes no
 * `Notification` API in a tab (Safari *and* Chrome-on-iOS), so
 * `client/src/lib/alerts.ts` can never reach an iPhone. ntfy already holds a
 * native push connection; the dashboard only has to decide when to publish.
 *
 * This is the one part of the backend that talks to the internet. It stays
 * zero-dependency (`node:https`), fire-and-forget, and can never fail or delay
 * the request that triggered it.
 *
 * See `docs/subsystems/push-notify.md`.
 */

import type { NotifyEvent, NotifyPolicy } from '../../shared/types.js';

/**
 * Permission modes that count as "running unattended".
 *
 * Deliberately duplicated from `MODES` in `scripts/remote-decision-hook.sh`
 * rather than shared: one is TypeScript and the other is bash, and three words
 * of rule is not worth coupling a shell script to a module. The same call was
 * made for `NEEDS_YOU` across `alertStream.ts` and `client/src/lib/alerts.ts`.
 * Change one, change the other.
 */
export const AUTO_MODES: ReadonlySet<string> = new Set(['auto', 'bypassPermissions', 'dontAsk']);

export interface PredicateContext {
  /** `remoteState.getState().remoteAnswer` — the env gate AND the UI toggle. */
  remoteAnswer: boolean;
  /** `settings.idleSecs` — the same threshold the remote-answer hooks use. */
  thresholdSecs: number;
  /** From the hook payload. Absent on paths that cannot see it. */
  permissionMode?: string;
  /**
   * Seconds since the last HID event, or null when unreadable. A thunk, not a
   * value: reading it spawns `ioreg`, and the whole point of the clause order
   * below is that a policy without `requireAfk` never pays for that.
   */
  readIdle: () => number | null;
}

/**
 * The whole policy. Clauses are ordered cheapest-first and short-circuit, so
 * `readIdle` is called only when every free check has already passed.
 */
export function shouldNotify(event: NotifyEvent, policy: NotifyPolicy, ctx: PredicateContext): boolean {
  if (!policy.enabled) return false;
  if (!policy.events[event]) return false;
  if (policy.requireRemoteAnswer && !ctx.remoteAnswer) return false;
  if (policy.requireAutoMode && !AUTO_MODES.has(ctx.permissionMode ?? '')) return false;

  if (policy.requireAfk) {
    const idle = ctx.readIdle();
    // Unreadable (Docker, non-macOS) → push anyway. Failing silent here would
    // reintroduce the missed-notification bug this feature exists to fix, and a
    // wrong guess costs one extra push rather than a hidden dialog — which is
    // why this fails the opposite way to `ask-remote-hook.sh`.
    if (idle !== null && idle < ctx.thresholdSecs) return false;
  }
  return true;
}
