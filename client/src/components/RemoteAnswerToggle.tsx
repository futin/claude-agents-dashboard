import type { RemoteAnswerControl } from '../hooks/useRemoteAnswer';

/**
 * Toolbar pill for the remote-answer switch.
 *
 * On, it only *allows* remote answers — the hook still hands a question straight
 * to the terminal while you're at the keyboard, so this reads "when I'm away"
 * rather than "instead of the terminal". Off releases anything already waiting.
 *
 * The hook is owned by the Toolbar and passed in, so the sibling OriginBadge can
 * read the same `/api/health` snapshot instead of starting a second poll.
 */
export function RemoteAnswerToggle({ control }: { control: RemoteAnswerControl }) {
  const { state, busy, needsToken, toggle } = control;
  if (!state) return null;

  if (!state.available) {
    return (
      <span className="ra-pill off" title="REMOTE_ANSWER=false in the server config">
        <span className="ra-dot" />phone answers: disabled
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
      className={`ra-pill${state.enabled ? ' on' : ''}`}
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={state.enabled}
      title={title}
    >
      <span className="ra-dot" />
      phone answers: {state.enabled ? 'on' : 'off'}
      {state.enabled && !state.persisted && <span className="ra-warn" title="Couldn’t be saved — resets when the server restarts">*</span>}
      {needsToken && <span className="ra-warn">token?</span>}
    </button>
  );
}
