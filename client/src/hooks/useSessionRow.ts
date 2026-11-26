import { useCallback, useEffect, useState } from 'react';

import type { Session } from '../../../shared/types';
import { nextSessionRow } from '../lib/chatRow';
import { createPollSeq, pollFetch } from '../lib/pollSeq';
import { useSettings } from './useSettings';

const url = (id: string): string => `/api/sessions/${encodeURIComponent(id)}/row`;

/**
 * The session a Routines `session →` link opens in the ChatDrawer, kept live: `open` fetches its row once and resolves to a one-line failure for the
 * link to show in place (null on success), then the row is re-fetched every `refreshMs` while the drawer is open, so a turn ending or a permission prompt
 * reaches the drawer's Resume composer and banner. Same `pollSeq` rule as the other polls; a failed tick keeps the last row (`nextSessionRow`).
 */
export function useSessionRow(): { row: Session | null; open(id: string): Promise<string | null>; close(): void } {
  const [row, setRow] = useState<Session | null>(null);
  const { settings: { refreshMs } } = useSettings();
  const id = row?.id ?? null;

  const open = useCallback(async (next: string): Promise<string | null> => {
    try {
      const res = await pollFetch(url(next));
      if (res.status === 404) return 'session transcript not found';
      if (!res.ok) return 'could not open the session';
      setRow(await res.json() as Session);
      return null;
    } catch {
      return 'could not open the session';
    }
  }, []);
  const close = useCallback(() => setRow(null), []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const seq = createPollSeq();
    const poll = () => {
      const mine = seq.next(false);
      if (mine === null) return;
      pollFetch(url(id))
        .then(async res => ({ ok: res.ok, body: await res.json().catch(() => null) as unknown }))
        .catch(() => ({ ok: false, body: null as unknown }))
        .then(({ ok, body }) => {
          if (alive && seq.settle(mine)) setRow(prev => nextSessionRow(prev, id, ok, body));
        });
    };
    const timer = setInterval(poll, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, refreshMs]);

  return { row, open, close };
}
