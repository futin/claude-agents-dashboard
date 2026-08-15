import { useEffect, useState } from 'react';

import { Markdown } from './Markdown';
import type { PendingPlanState } from '../hooks/usePendingPlan';

/**
 * The action bar for a plan a session is waiting on. Type what to change and
 * send it back; the model revises and proposes again. "Decide on the card"
 * releases the hook instead, so the plan card appears in the terminal within a
 * second.
 *
 * ⚠️ No approve button, and unlike `PermissionBanner` this is not a policy
 * choice we made: the CLI drops a hook `allow` for tools that declare
 * `requiresUserInteraction()`, and `ExitPlanMode` is one — its card *is* the
 * approval surface. An approve button here would be a lie.
 *
 * Fed by the plan store (the markdown from the hook's stdin), so it works even
 * before the `tool_use` record reaches the transcript the drawer renders.
 */
export default function PlanPanel({ state }: { state: PendingPlanState }) {
  const { pending, phase, needsToken, reject, dismiss, setToken } = state;
  const [feedback, setFeedback] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [open, setOpen] = useState(false);

  // A revised plan (or a fresh drawer) starts from a clean slate.
  const planId = pending?.planId ?? null;
  useEffect(() => {
    setFeedback('');
    setOpen(false);
  }, [planId]);

  if (phase === 'gone') {
    return (
      <div className="qpanel gone">
        <span className="qp-note">That plan was decided in the terminal, or it expired.</span>
      </div>
    );
  }

  // Checked before `pending`: the poll can take up to 3s to notice the wait is
  // over, and until then the form must not re-offer a send that would just 404.
  if (phase === 'sent') {
    return (
      <div className="qpanel sent">
        <span className="qp-note">✓ Sent back for revision · the session is re-planning</span>
      </div>
    );
  }

  if (!pending) return null;

  const busy = phase === 'submitting';

  return (
    <div className="qpanel">
      <div className="qp-head">
        <span className="qp-badge">plan proposed</span>
        <span className="qp-hint">approve on the card · revise from here</span>
      </div>

      <div className="qp-q">
        <button
          type="button"
          className="qp-opt"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <span className="qp-label">{open ? 'hide plan' : 'show plan'}</span>
        </button>
        {open && (
          <div className="qp-plan">
            <Markdown text={pending.plan} />
          </div>
        )}
      </div>

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
        maxLength={2000}
        rows={3}
        placeholder="What should change? (sent to the model verbatim)"
        value={feedback}
        disabled={busy}
        onChange={e => setFeedback(e.target.value)}
      />

      <div className="qp-actions">
        <button
          type="button"
          className="qp-send"
          disabled={busy || !feedback.trim()}
          onClick={() => void reject(feedback)}
        >
          {busy ? 'sending…' : 'send back for revision'}
        </button>
        <button type="button" className="qp-term" disabled={busy} onClick={() => void dismiss()}>
          decide on the card
        </button>
      </div>
    </div>
  );
}
