/**
 * pollSeq.ts — kept apart from `routines.ts` so `useSessions`, in the eager Sessions bundle, can use it without pulling the lazy Routines section's view
 * logic in with it. `routines.ts` re-exports it for the Routines hooks and their tests.
 */

/**
 * The poll hooks' ordering rule, apart from React. A timed or visibility tick (`next(false)`) is skipped while a fetch is out, so a slow 90-day fold is not
 * piled on; `refresh()` (`next(true)`) always goes, because its caller just changed something the fetch in flight may predate. Each fetch carries the number
 * `next` gave it, and `settle` says whether its answer is still the newest issued: only then may the hook apply it, so an older fold resolving late can never
 * overwrite a newer one. A superseded fetch settles as stale and leaves the in-flight flag to the newest. Only a fetch settling opens the skip again, so one
 * that never settles would stop the poll for good: every guarded poll goes through {@link pollFetch}.
 */
export function createPollSeq(): { next(force: boolean): number | null; settle(seq: number): boolean } {
  let issued = 0;
  let inFlight = false;
  return {
    next(force) {
      if (inFlight && !force) return null;
      inFlight = true;
      return ++issued;
    },
    settle(seq) {
      if (seq !== issued) return false;
      inFlight = false;
      return true;
    }
  };
}

/** Clears a legitimately slow answer: a too-short bound would turn a slow board into one that never updates. The cost is a hang taking this long to show. */
export const POLL_TIMEOUT_MS = 30_000;

/** `fetch` for a guarded poll. The signal also fails a stalled body read, so the hook's `res.json()` is bounded too; a timeout reads as any other failed poll. */
export function pollFetch(url: string, timeoutMs = POLL_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
