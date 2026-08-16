import { useEffect, useState } from 'react';

import type { HealthResponse } from '../../../shared/types';

/**
 * Is dictation available on the server?
 *
 * Fetched once per page load and memoised at module scope, not polled: the
 * server's own probe is cached for its process lifetime, so the answer cannot
 * change without a restart. Same read-once-then-share shape as lib/deepLink.ts.
 */
let cached: Promise<boolean> | null = null;

function read(): Promise<boolean> {
  if (!cached) {
    cached = fetch('/api/health')
      .then(res => res.json())
      .then((body: HealthResponse) => body?.transcribe === true)
      .catch(() => false);
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
