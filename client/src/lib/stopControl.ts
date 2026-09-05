/**
 * stopControl.ts — what the Stop control on an expanded row shows, and what it
 * sends.
 *
 * Every branch of a two-stage destructive control lives here rather than in
 * `SessionRow`, so the component stays declarative and this stays testable
 * without a DOM — the same split `panelCollapse.ts` and `holds.ts` already use
 * (this repo's client tests import `client/src/lib/*` and never render).
 */

import type { StopState } from '../../../shared/types';

/** What to draw, given a row's `stopState` and whether the confirm step is armed. */
export type StopControlView =
  /** Nothing at all — this session cannot be stopped from here. */
  | { render: false }
  | {
      render: true;
      /** Label on the primary button. */
      label: string;
      /**
       * The primary button only arms the confirm step and sends no request.
       * This is what makes stopping two deliberate taps rather than one.
       */
      arms: boolean;
      /** `force` flag in the POST body the primary button sends once `arms` is false. */
      force: boolean;
      /** Draw a `cancel` button beside the primary one. */
      cancel: boolean;
      /** Visible text for the row's second line, or null. Text, never a `title` — a tooltip is dead on touch. */
      badge: string | null;
    };

/**
 * The control for a row.
 *
 * - **No `stopState`** ⇒ nothing renders. The honest answer for a session this
 *   server never spawned, one resumed within the last launch-TTL window, and
 *   anything from before the last dashboard restart — in every case there is no
 *   handle to signal, so a button would only be able to fail.
 * - **`'ready'`** ⇒ `stop session`, which arms; then `really stop?` + `cancel`,
 *   which sends the graceful stop. Same two-stage inline pattern as Settings'
 *   `Reset…` / `Confirm reset`; this repo has no modal component and a phone
 *   does not want one.
 * - **`'stopping'`** ⇒ a visible `stopping…` badge, and `force stop` replacing
 *   the confirm pair. `confirming` is ignored here on purpose: the graceful stop
 *   has already been confirmed and sent, so there is no arming step left to be
 *   in, and a stale `confirming` from the previous poll must not resurrect one.
 *
 * Force is offered immediately rather than after a client-side grace timer. The
 * server escalates to SIGKILL on its own after `STOP_GRACE_MS`, so this button
 * exists only for impatience — and no timer here means no second clock that
 * could drift out of step with the server's.
 */
export function stopControl(stopState: StopState | undefined, confirming: boolean): StopControlView {
  if (!stopState) return { render: false };
  if (stopState === 'stopping') {
    return { render: true, label: 'force stop', arms: false, force: true, cancel: false, badge: 'stopping…' };
  }
  return confirming
    ? { render: true, label: 'really stop?', arms: false, force: false, cancel: true, badge: null }
    : { render: true, label: 'stop session', arms: true, force: false, cancel: false, badge: null };
}
