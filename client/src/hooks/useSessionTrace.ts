import { useEffect, useRef, useState } from 'react';

import { mergeTrace } from '../lib/trace';
import type { SessionTrace, TraceStep } from '../../../shared/types';

export interface TraceState {
  /** Oldest-first by `at`. */
  steps: TraceStep[];
  thinking: { recorded: number; readable: number };
  /** Older steps the server left out of the full response. */
  dropped: number;
  /** The first full response hasn't landed yet. */
  loading: boolean;
  error: boolean;
}

const NO_THINKING = { recorded: 0, readable: 0 };

/**
 * Fetch `/api/sessions/:id/trace` — the full trace once `enabled` turns true,
 * then only what changed since (`?after=<cursor>&epoch=<epoch>`) every
 * `refreshMs`. Polls only while enabled (Trace is the view showing). The
 * cursor is a builder revision, so a `reset` answer replaces the steps.
 */
export function useSessionTrace(id: string, enabled: boolean, refreshMs: number): TraceState {
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [thinking, setThinking] = useState(NO_THINKING);
  const [dropped, setDropped] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const cursor = useRef(0);
  const epoch = useRef('');
  /** A full response landed — until then the poll must not fire. */
  const ready = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ready.current = false;
    cursor.current = 0;
    epoch.current = '';
    setSteps([]);
    setThinking(NO_THINKING);
    setDropped(0);
    setLoading(true);
    setError(false);

    async function get(query: string): Promise<SessionTrace | null> {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/trace${query}`);
        return (await res.json()) as SessionTrace;
      } catch {
        return null; // keep the last snapshot; the next poll retries
      }
    }

    let inflight = false;
    async function full(): Promise<void> {
      if (inflight) return;
      inflight = true;
      const t = await get('');
      inflight = false;
      if (!live) return;
      if (!t || t.error) {
        setLoading(false);
        setError(true);
        return;
      }
      cursor.current = t.cursor;
      epoch.current = t.epoch;
      ready.current = true;
      setSteps(mergeTrace([], t.steps, true));
      setThinking(t.thinking);
      setDropped(t.dropped);
      setError(false);
      setLoading(false);
    }

    async function poll(): Promise<void> {
      if (!ready.current) { void full(); return; } // the first fetch failed: retry it
      const t = await get(`?after=${cursor.current}&epoch=${encodeURIComponent(epoch.current)}`);
      if (!live || !t || t.error) return;
      cursor.current = t.cursor;
      epoch.current = t.epoch;
      setSteps(cur => mergeTrace(cur, t.steps, !!t.reset));
      setThinking(t.thinking);
      if (t.reset) setDropped(t.dropped);
    }

    void full();
    const timer = setInterval(() => void poll(), refreshMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, enabled, refreshMs]);

  return { steps, thinking, dropped, loading, error };
}
