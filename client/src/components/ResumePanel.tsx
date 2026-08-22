import { useEffect, useState } from 'react';

import MicButton from './MicButton';
import { appendTranscript } from '../lib/dictation';
import { useSpawn } from '../hooks/useSpawn';
import type { Session } from '../../../shared/types';

/**
 * How long the "resuming" note stands in for the row waking up. A healthy
 * resume shows activity well inside this (the drawer live-tails every poll);
 * past it the composer returns so a silently failed resume can be retried —
 * the failed launch itself is also visible as a phantom row in the list.
 */
const SENT_RESET_MS = 15_000;

/**
 * The composer for an ENDED dashboard session — the counterpart to
 * `MessagePanel`, which needs the session still holding a reply window. This
 * one needs the opposite (nothing pending, turn over — `resumeEligible`
 * decides, in the drawer): it POSTs `/api/spawn` with `resume: session.id`,
 * which relaunches `claude -p --resume <id>` in the session's own cwd; the
 * transcript keeps its id, so this very drawer live-tails the continuation.
 */
export default function ResumePanel({ session }: { session: Session }) {
  const { launch, pending: busy, error, needsToken, setToken } = useSpawn();
  const [text, setText] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(false), SENT_RESET_MS);
    return () => clearTimeout(timer);
  }, [sent]);

  async function onSend() {
    const id = await launch({ prompt: text, resume: session.id });
    if (id) {
      setSent(true);
      setText('');
    }
  }

  if (sent) {
    return (
      <div className="qpanel sent">
        <span className="qp-note">✓ Resuming · the session is picking your follow-up back up</span>
      </div>
    );
  }

  return (
    <div className="qpanel">
      <div className="qp-head">
        <span className="qp-badge">session ended</span>
        <span className="qp-hint">send a follow-up to resume it</span>
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

      {error && <div className="qp-note">{error}</div>}

      <textarea
        className="qp-feedback"
        maxLength={4000}
        rows={3}
        placeholder="Follow-up for this session (resumes it with this as your next message)"
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
          onClick={() => void onSend()}
        >
          {busy ? 'resuming…' : 'resume session'}
        </button>
      </div>
    </div>
  );
}
