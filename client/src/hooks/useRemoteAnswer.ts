import { useCallback, useEffect, useRef, useState } from 'react';

import { useAnswerToken } from './useAnswerToken';
import { createPollSeq, pollFetch } from '../lib/pollSeq';
import { postWrite } from '../lib/postWrite';
import { refusalFlags } from '../lib/writeRefusal';
import type { HealthResponse, RemoteAnswerState } from '../../../shared/types';

/** Slow poll: the switch only changes when someone flips it. */
const POLL_MS = 15_000;

export interface RemoteAnswerControl {
  state: HealthResponse | null;
  busy: boolean;
  /** Set when the server refused the token. */
  needsToken: boolean;
  /** Set when the server says this network is read-only: no token can help, so the surface says so instead of prompting. */
  readOnly: boolean;
  toggle: () => Promise<void>;
}

/**
 * The remote-answer switch behind the toolbar pill. Reads `GET /api/health` and
 * flips it with `POST /api/remote-answer`.
 *
 * Polled (not just fetched once) because the other surface can flip it — your
 * phone turning it on should show up on the laptop without a reload. The read follows the `pollSeq` rule, and a successful toggle forces one that
 * supersedes any read still in flight, so a health answer sent before the flip cannot put the old state back.
 */
export function useRemoteAnswer(): RemoteAnswerControl {
  const [state, setState] = useState<HealthResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [token] = useAnswerToken();
  const readRef = useRef<(force: boolean) => void>(() => {});

  useEffect(() => {
    let live = true;
    const seq = createPollSeq();
    async function read(force: boolean): Promise<void> {
      const n = seq.next(force);
      if (n === null) return;
      try {
        const res = await pollFetch('/api/health');
        const body = (await res.json()) as HealthResponse;
        if (seq.settle(n) && live && typeof body?.remoteAnswer === 'boolean') setState(body);
      } catch {
        seq.settle(n); // keep the last snapshot; the next tick retries
      }
    }
    readRef.current = force => void read(force);
    void read(false);
    const timer = setInterval(() => void read(false), POLL_MS);
    return () => { live = false; readRef.current = () => {}; clearInterval(timer); };
  }, []);

  const toggle = useCallback(async () => {
    if (!state?.available || busy) return;
    setBusy(true);
    try {
      // A network failure leaves the pill as it was; the poll will re-sync.
      const result = await postWrite('/api/remote-answer', { token, body: { enabled: !state.enabled } });
      if (result.refusal) {
        const flags = refusalFlags(result.refusal);
        setReadOnly(flags.readOnly);
        setNeedsToken(flags.needsToken);
      } else if (result.ok) {
        setNeedsToken(false);
        setReadOnly(false);
        // This endpoint answers with the switch state alone — merge, or the
        // health-only fields (origin) would blank out until the next poll.
        const body = result.body as RemoteAnswerState | undefined;
        if (body) setState(prev => ({ ...(prev ?? { ok: true as const }), ...body }));
        // A read sent before the flip may answer after it; the forced read settles it as stale and brings the post-toggle health.
        readRef.current(true);
      }
    } finally {
      setBusy(false);
    }
  }, [state, busy, token]);

  return { state, busy, needsToken, readOnly, toggle };
}
