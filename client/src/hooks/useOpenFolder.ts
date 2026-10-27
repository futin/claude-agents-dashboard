import { useCallback, useRef, useState } from 'react';

import type { OpenFolderRequest } from '../../../shared/types';
import { useAnswerToken } from './useAnswerToken';
import { openFolderNote } from '../lib/openFolder';
import { postWrite } from '../lib/postWrite';

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
    const body: OpenFolderRequest = { path };
    postWrite('/api/open-folder', { token, body })
      .then(result => openFolderNote(result.status, result.body ?? null))
      .then(setNote)
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [token]);

  return { open, pending, note };
}
