import { useSyncExternalStore } from 'react';

import { answerTokenStore } from '../lib/answerToken';

/**
 * The Answer token, shared by every component on the page: a token saved through any returned setter re-renders every other caller with it (#200). Never
 * read `dashboard.answerToken` through `usePersistedState` — that copy would not see a write made here until it remounted.
 */
export function useAnswerToken(): [string, (token: string) => void] {
  const token = useSyncExternalStore(answerTokenStore.subscribe, answerTokenStore.get);
  return [token, answerTokenStore.set];
}
