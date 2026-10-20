import { useState } from 'react';

import type { StopState } from '../../../../shared/types';
import { stopControl } from '../../lib/stopControl';
import { useStopSession } from '../../hooks/useStopSession';

/**
 * The two-stage Stop control: `Stop session` arms, `Really stop?` sends the graceful stop, `Force stop` once the server reports `stopping`. One component for
 * the expanded row and the chat drawer's sidecar, so both places follow `stopControl()` and send through the same `useStopSession`. Renders nothing for a
 * session without `stopState` — no wrapper, no gap.
 */
export function SessionStopControl({ sessionId, stopState, showBadge = false }: {
  sessionId: string;
  stopState: StopState | undefined;
  /** Draw the `stopping…` badge inside the control. The row draws it on its own second line instead, so only the drawer asks for it here. */
  showBadge?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const { stop, pending, error, needsToken } = useStopSession();
  const ctl = stopControl(stopState, confirming);
  if (!ctl.render) return null;

  return (
    <div className="stop-ctl">
      {showBadge && ctl.badge && <span className="stop-badge">{ctl.badge}</span>}
      <button
        type="button"
        className="stop-go"
        disabled={pending}
        onClick={() => {
          if (ctl.arms) return setConfirming(true);
          setConfirming(false);
          void stop(sessionId, ctl.force);
        }}
      >
        {ctl.label}
      </button>
      {ctl.cancel && (
        <button type="button" className="stop-cancel" onClick={() => setConfirming(false)}>Cancel</button>
      )}
      {needsToken && <span className="stop-msg">Needs the dashboard token — set it in Settings › Local › Connection.</span>}
      {!needsToken && error && <span className="stop-msg">{error}</span>}
    </div>
  );
}
