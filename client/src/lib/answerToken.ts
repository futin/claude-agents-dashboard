/**
 * answerToken.ts — the one copy of the Answer token this dashboard holds.
 *
 * Every hook that sends a token used to own a private `usePersistedState('dashboard.answerToken')`, and that hook reads localStorage once on mount and only
 * writes after. So a token entered in one panel never reached the siblings mounted beside it: dictate (403), enter the token in the message panel, dictate
 * again — still 403, until the drawer remounted (#200). One module-level store, read through `useAnswerToken`, means one write is seen by every reader.
 *
 * The stored shape stays the JSON string `usePersistedState` wrote, so a token saved by an older release still reads. A `storage` event for the key (another
 * tab, or the key cleared) re-reads it. The store itself has no React in it so the tests can drive it without a DOM.
 */

export const ANSWER_TOKEN_KEY = 'dashboard.answerToken';

export interface AnswerTokenStore {
  get(): string;
  set(token: string): void;
  /** Shape `useSyncExternalStore` wants: returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

function read(storage: Storage | undefined): string {
  try {
    const raw = storage?.getItem(ANSWER_TOKEN_KEY);
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

/**
 * `storage` is a getter because Node has no `localStorage` at import time; `target` is where `storage` events arrive (`window` in the browser), and the
 * listener is attached only while somebody is subscribed.
 */
export function createAnswerTokenStore(storage: () => Storage | undefined, target?: EventTarget): AnswerTokenStore {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const l of [...listeners]) l(); };
  const onStorage = (e: Event) => {
    const key = (e as StorageEvent).key;
    if (key !== null && key !== ANSWER_TOKEN_KEY) return;
    const next = read(storage());
    if (next === value) return;
    value = next;
    emit();
  };

  return {
    get() {
      if (value === null) value = read(storage());
      return value;
    },
    set(token) {
      if (value === null) value = read(storage());
      if (token === value) return;
      value = token;
      try {
        storage()?.setItem(ANSWER_TOKEN_KEY, JSON.stringify(token));
      } catch {
        /* ignore: private mode / quota — the in-memory copy still serves this page */
      }
      emit();
    },
    subscribe(listener) {
      if (listeners.size === 0) target?.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) target?.removeEventListener('storage', onStorage);
      };
    }
  };
}

/** The page's store. Hooks read it through `useAnswerToken`. */
export const answerTokenStore = createAnswerTokenStore(
  () => (typeof localStorage === 'undefined' ? undefined : localStorage),
  typeof window === 'undefined' ? undefined : window
);

/** Request headers with `Authorization: Bearer <token>` added when there is a token — the one place that header is spelled. */
export function authHeaders(token: string, headers: Record<string, string> = {}): Record<string, string> {
  return token ? { ...headers, Authorization: `Bearer ${token}` } : { ...headers };
}
