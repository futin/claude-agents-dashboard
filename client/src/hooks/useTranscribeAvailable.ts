import { useEffect, useState } from 'react';

import type { HealthResponse } from '../../../shared/types';

/**
 * Is dictation available on the server?
 *
 * Fetched once per page load and memoised at module scope, not polled: the
 * server's own probe is cached for its process lifetime, so a *completed*
 * answer cannot change without a restart. Same read-once-then-share shape as
 * lib/deepLink.ts.
 *
 * That reasoning only covers a request that actually got an answer. A request
 * that never arrived (dropped tailnet packet, phone walking out of range) says
 * nothing about whether the engine exists, so it must not be remembered —
 * same "keep the last snapshot; the next tick retries" rule useRemoteAnswer.ts
 * applies to its poll, just applied to a single retry instead of an interval.
 */
let cached: Promise<boolean> | null = null;

function read(): Promise<boolean> {
  if (!cached) {
    const attempt = fetch('/api/health')
      .then(res => res.json())
      .then((body: HealthResponse) => body?.transcribe === true);
    cached = attempt.catch(() => {
      // Nothing was learned — evict so the next call (next mount, or a later
      // tap) starts a fresh fetch instead of being stuck on this failure.
      cached = null;
      return false;
    });
  }
  return cached;
}

export function useTranscribeAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void read().then(v => { if (live) setAvailable(v); });
    return () => { live = false; };
  }, []);
  return available;
}
