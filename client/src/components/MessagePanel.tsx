import { useEffect, useState } from 'react';

import MicButton from './MicButton';
import { MinimisedPanel, PanelHead } from './PanelChrome';
import { appendTranscript } from '../lib/dictation';
import { collapsedSummary, fmtLeft } from '../lib/panelCollapse';
import type { PendingMessageState } from '../hooks/usePendingMessage';

/** Seconds left in the window, clamped at 0. */
function secsLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
}

/**
 * The composer for a turn-end reply window. The session finished a turn while
 * you were away and is holding briefly — anything typed here continues the
 * model as its next instruction; "let it stop" releases the hold instead.
 *
 * Coming back to the keyboard also releases every hold within ~5s (the server
 * sweeps idle), so this panel can vanish on its own — that is the feature, not
 * a bug. The window carries no content: the turn's final message is already the
 * last message in the transcript above.
 */
export default function MessagePanel({ state }: { state: PendingMessageState }) {
  const { pending, phase, needsToken, send, dismiss, setToken } = state;
  const [text, setText] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [left, setLeft] = useState(0);
  const [minimised, setMinimised] = useState(false);

  // A new window (or a fresh drawer) starts from a clean slate — expanded
  // included, so a fresh window is never hidden behind an old stub.
  const messageId = pending?.messageId ?? null;
  useEffect(() => {
    setText('');
    setMinimised(false);
  }, [messageId]);

  // 1s countdown while a window is open — typing against an invisible
  // deadline is worse than watching it tick.
  const expiresAt = pending?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) return;
    setLeft(secsLeft(expiresAt));
    const timer = setInterval(() => setLeft(secsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (phase === 'gone') {
    return (
      <div className="qpanel gone">
        <span className="qp-note">That window closed — the session stopped, or another tab replied.</span>
      </div>
    );
  }

  // Checked before `pending`: the poll can take a tick to notice the wait is
  // over, and until then the form must not re-offer a send that would just 404.
  if (phase === 'sent') {
    return (
      <div className="qpanel sent">
        <span className="qp-note">✓ Sent · the session is continuing with your follow-up</span>
      </div>
    );
  }

  if (!pending) return null;

  if (minimised) {
    return (
      <MinimisedPanel
        badge="turn finished"
        summary={collapsedSummary({ kind: 'message', secsLeft: left })}
        onExpand={() => setMinimised(false)}
      />
    );
  }

  const busy = phase === 'submitting';

  return (
    <div className="qpanel">
      <PanelHead
        badge="turn finished"
        hint={`reply to continue it · closes in ${fmtLeft(left)}`}
        onMinimise={() => setMinimised(true)}
      />

      {needsToken && (
        <div className="qp-token">
          <span className="qp-note">This dashboard needs its answer token.</span>
          <input
            className="qp-other"
            type="password"
            placeholder="ANSWER_TOKEN"
            value={tokenDraft}
            onChange={e => setTokenDraft(e.target.value)}
          />
          <button type="button" className="qp-send" onClick={() => setToken(tokenDraft.trim())}>
            save
          </button>
        </div>
      )}

      <textarea
        className="qp-feedback"
        maxLength={4000}
        rows={3}
        placeholder="Follow-up for this session (sent to the model verbatim)"
        value={text}
        disabled={busy}
        onChange={e => setText(e.target.value)}
      />

      <div className="qp-actions">
        <MicButton disabled={busy} onText={t => setText(cur => appendTranscript(cur, t))} />
        <button
          type="button"
          className="qp-send"
          disabled={busy || !text.trim()}
          onClick={() => void send(text)}
        >
          {busy ? 'sending…' : 'send'}
        </button>
        <button type="button" className="qp-term" disabled={busy} onClick={() => void dismiss()}>
          let it stop
        </button>
      </div>
    </div>
  );
}
