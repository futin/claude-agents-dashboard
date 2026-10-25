/**
 * pollSeq.ts — kept apart from `routines.ts` so `useSessions`, in the eager Sessions bundle, can use it without pulling the lazy Routines section's view
 * logic in with it. `routines.ts` re-exports it for the Routines hooks and their tests.
 */

/**
 * The poll hooks' ordering rule, apart from React. A timed or visibility tick (`next(false)`) is skipped while a fetch is out, so a slow 90-day fold is not
 * piled on; `refresh()` (`next(true)`) always goes, because its caller just changed something the fetch in flight may predate. Each fetch carries the number
 * `next` gave it, and `settle` says whether its answer is still the newest issued: only then may the hook apply it, so an older fold resolving late can never
 * overwrite a newer one. A superseded fetch settles as stale and leaves the in-flight flag to the newest.
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
