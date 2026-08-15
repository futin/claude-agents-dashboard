import type { Session } from '../../../shared/types';

/**
 * Pinned strip saying this session is stuck on a permission dialog in its
 * terminal, naming the tool call it's asking about (from `Session.activity` —
 * the tool_use record is written before the dialog appears).
 *
 * Deliberately controls-free, unlike `QuestionPanel`: nothing outside the TUI
 * can answer a permission dialog, so offering a button here would be a lie. It
 * exists to answer "which session, and what is it asking?" from the phone.
 */
export function PermissionBanner({ session }: { session: Session }) {
  const act = session.activity;
  return (
    <div className="pbanner">
      <span className="pb-badge">permission</span>
      <span className="pb-text">
        {act ? (
          <>
            waiting to run <span className="tool">{act.tool}</span>
            {act.detail ? ' ' + act.detail : ''}
          </>
        ) : (
          'waiting on a permission prompt'
        )}
      </span>
      <span className="pb-note">answer in that terminal</span>
    </div>
  );
}

export default PermissionBanner;
