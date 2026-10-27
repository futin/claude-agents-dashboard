import { useCallback, useRef, useState } from 'react';

import type { OpenFolderRequest } from '../../../shared/types';
import { useAnswerToken } from './useAnswerToken';
import { authHeaders } from '../lib/answerToken';
import { openFolderNote } from '../lib/openFolder';

export interface OpenFolderControl {
  /** `POST /api/open-folder` `{path}`. A no-op while this hook's own POST is out. Never throws. */
  open(path: string): void;
  pending: boolean;
  /** Why the last open did nothing, in words for the user. Null after a success. */
  note: string | null;
}

/**
 * The Open folder key (management redesign spec §6.3). Same Bearer pattern as `useGitFetch`: the shared `dashboard.answerToken` key, so a token saved
 * elsewhere is seen without a remount. The note itself is `openFolderNote`'s.
 */
export function useOpenFolder(): OpenFolderControl {
  const [token] = useAnswerToken();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A ref, not the state, so two clicks inside one render both see the first one's POST.
  const pendingRef = useRef(false);

  const open = useCallback((path: string): void => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const headers = authHeaders(token, { 'Content-Type': 'application/json' });
    const body: OpenFolderRequest = { path };
    fetch('/api/open-folder', { method: 'POST', headers, body: JSON.stringify(body) })
      .then(async res => openFolderNote(res.status, res.status === 403 ? await res.json().catch(() => null) : null))
      .catch(() => "Couldn't open the folder.")
      .then(setNote)
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [token]);

  return { open, pending, note };
}
