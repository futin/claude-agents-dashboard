import type { Session } from '../../../../shared/types';
import { SessionDetail } from '../SessionDetail';
import { ActFull } from './atoms';
import { SessionStopControl } from './SessionStopControl';

/**
 * The open body of a session — the full tool call, the kaizen lesson, the
 * two-stage stop control and the subagent timeline. One component for the four
 * views that expand a session in place (board, list, tiles) or in an inspector
 * (split), so the arm-then-confirm stop and the shared time axis are written
 * once.
 *
 * The tool call leads because it is what the collapsed row could not say: up
 * there it is a bare name, here it is the whole argument, wrapped. That holds
 * in the split inspector too: its "Now" tile carries the bare name, this body
 * carries the argument.
 *
 * Every click inside stops here: the containers that render this toggle on
 * click, and a confirm step that collapses its own row is no confirm step.
 */
export function Expanded({ s }: { s: Session }) {
  return (
    <div className="expanded" onClick={e => e.stopPropagation()}>
      <ActFull s={s} />
      {s.kaizenLesson && (
        <div className="kaizen-lesson">
          <span className="ag-pill kaizen">kaizen</span>
          <span>{s.kaizenLesson}</span>
        </div>
      )}
      <SessionStopControl sessionId={s.id} stopState={s.stopState} />
      <SessionDetail id={s.id} />
    </div>
  );
}
