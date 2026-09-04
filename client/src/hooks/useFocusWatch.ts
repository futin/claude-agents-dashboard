import { useEffect, useRef, useState } from 'react';

import type { FocusPendingResponse } from '../../../shared/types';

/** One claimed tap. `seq` distinguishes two taps on the *same* session. */
export interface FocusClaim {
  id: string;
  seq: number;
}

/** Matches the session poll's default. Cheap: the response is `{}` almost always. */
const FOCUS_POLL_MS = 3000;

/**
 * Watch for a desk notification the user tapped, on every section.
 *
 * Lives in the app shell rather than in `SessionsView` because that component
 * owns the session poll and unmounts the moment another section is opened. When
 * the pickup lived there, tapping a desk notification while on Management, Usage
 * or **Settings** did nothing at all — and after `POLL_FRESH_MS` the server
 * stopped believing a dashboard was open and started redirecting the tap into a
 * second dashboard tab, the exact outcome the feature exists to prevent.
 * Reported from real use on 2026-09-04.
 *
 * Polling here is also what keeps the server's `dashboardOpen()` honest while
 * the sessions list is hidden — `/api/focus/pending` calls `notePoll()`.
 *
 * The claim is consumed server-side, so this fires once per tap. `seq` rises on
 * every claim so tapping the same session twice still re-opens the drawer, which
 * a bare id could not express.
 */
export function useFocusWatch(): FocusClaim | null {
  const [claim, setClaim] = useState<FocusClaim | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;

    async function poll(): Promise<void> {
      try {
        const res = await fetch('/api/focus/pending');
        const data: FocusPendingResponse = await res.json();
        if (!alive || !data.focusSession) return;
        seq.current += 1;
        setClaim({ id: data.focusSession, seq: seq.current });
      } catch {
        /* server down — the session poll already surfaces that, so stay quiet */
      }
    }

    poll();
    const timer = setInterval(poll, FOCUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return claim;
}
