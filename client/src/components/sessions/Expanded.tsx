import { useState } from 'react';

import type { Session } from '../../../../shared/types';
import { SessionDetail } from '../SessionDetail';
import { stopControl } from '../../lib/stopControl';
import { useStopSession } from '../../hooks/useStopSession';

/**
 * The open body of a session — the kaizen lesson, the two-stage stop control
 * and the subagent timeline. One component for the four views that expand a
 * session in place (board, list, tiles) or in an inspector (split), so the
 * arm-then-confirm stop and the shared time axis are written once.
 *
 * Every click inside stops here: the containers that render this toggle on
 * click, and a confirm step that collapses its own row is no confirm step.
 */
export function Expanded({ s }: { s: Session }) {
  const [confirming, setConfirming] = useState(false);
  const { stop, pending, error, needsToken } = useStopSession();
  const ctl = stopControl(s.stopState, confirming);

  return (
    <div className="expanded" onClick={e => e.stopPropagation()}>
      {s.kaizenLesson && (
        <div className="kaizen-lesson">
          <span className="ag-pill kaizen">kaizen</span>
          <span>{s.kaizenLesson}</span>
        </div>
      )}
      {ctl.render && (
        <div className="stop-ctl">
          <button
            type="button"
            className="stop-go"
            disabled={pending}
            onClick={() => {
              if (ctl.arms) return setConfirming(true);
              setConfirming(false);
              void stop(s.id, ctl.force);
            }}
          >
            {ctl.label}
          </button>
          {ctl.cancel && (
            <button type="button" className="stop-cancel" onClick={() => setConfirming(false)}>cancel</button>
          )}
          {needsToken && <span className="stop-msg">Needs the dashboard token — set it in Settings › Local › Connection.</span>}
          {!needsToken && error && <span className="stop-msg">{error}</span>}
        </div>
      )}
      <SessionDetail id={s.id} />
    </div>
  );
}
