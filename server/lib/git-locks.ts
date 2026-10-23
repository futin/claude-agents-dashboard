/**
 * One lock per git common dir, held while a quick pull or push runs (quick pull/push spec §Shared preconditions). Linked worktrees share refs, so the lock is
 * keyed the way fetch-all groups repos, and a different repo may run in parallel. Fetch-all waits for every held lock instead of racing one, so this module
 * is the leaf both `git-fetch.ts` and `git-quick.ts` import, and it imports neither.
 */

interface Held {
  done: Promise<void>;
  release: () => void;
}

const held = new Map<string, Held>();

/** Takes the lock on `commonDir`, or null when it is already held. The returned release is idempotent. */
export function tryLockRepo(commonDir: string): (() => void) | null {
  if (held.has(commonDir)) return null;
  let resolve!: () => void;
  const done = new Promise<void>(r => { resolve = r; });
  const entry: Held = {
    done,
    release: () => {
      // A later lock on the same dir is a new entry; an old release must not drop it.
      if (held.get(commonDir) === entry) held.delete(commonDir);
      resolve();
    },
  };
  held.set(commonDir, entry);
  return entry.release;
}

/** One promise per lock held now, each settling when that lock is released. */
export function heldRepoLocks(): Promise<void>[] {
  return [...held.values()].map(h => h.done);
}

export function anyRepoLockHeld(): boolean {
  return held.size > 0;
}

/** Test seam: drops every lock and wakes whoever waits on one. */
export function resetRepoLocks(): void {
  for (const h of [...held.values()]) h.release();
}
