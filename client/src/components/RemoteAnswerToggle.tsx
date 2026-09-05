import type { RemoteAnswerControl } from '../hooks/useRemoteAnswer';

/**
 * The remote-answer switch in the status plate.
 *
 * On, it only *allows* remote answers — the hook still hands a question straight
 * to the terminal while you're at the keyboard, so this reads "when I'm away"
 * rather than "instead of the terminal". Off releases anything already waiting.
 *
 * A switch rather than the old dot pill: it is the one control in the plate you
 * flip rather than read, and the plate's other occupants (the origin badge, the
 * counts, the clock) are all read-only. The kill-switch state keeps the pill
 * styling instead — a switch that cannot move is worse than a plain label.
 *
 * The hook is owned by `SessionsView` and passed in, so the sibling OriginBadge
 * can read the same `/api/health` snapshot instead of starting a second poll.
 */
export function RemoteAnswerToggle({ control }: { control: RemoteAnswerControl }) {
  const { state, busy, needsToken, toggle } = control;
  if (!state) return null;

  if (!state.available) {
    return (
      <span className="ra-pill off" title="REMOTE_ANSWER=false in the server config">
        <span className="ra-dot" />remote answers: disabled
      </span>
    );
  }

  const title = needsToken
    ? 'The server wants its ANSWER_TOKEN — open a question panel to enter it'
    : state.enabled
      ? 'On: a question asked while you are away from the keyboard waits here. At your desk it still goes straight to the terminal.'
      : 'Off: every question goes to the terminal dialog.';

  return (
    <button
      className={`ra-switch${state.enabled ? ' on' : ''}`}
      onClick={() => void toggle()}
      disabled={busy}
      role="switch"
      aria-checked={state.enabled}
      title={title}
    >
      <span>remote answers</span>
      <span className="ra-track" aria-hidden="true"><i /></span>
      {state.enabled && !state.persisted && <span className="ra-warn" title="Couldn’t be saved — resets when the server restarts">*</span>}
      {needsToken && <span className="ra-warn">token?</span>}
    </button>
  );
}
