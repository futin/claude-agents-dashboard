/**
 * wait-store.ts — the state machine the three remote-answer stores share: `pending.ts` (questions), `plans.ts` (plans) and `messages.ts` (reply windows).
 * One entry per session, a held HTTP response behind each, every terminal transition settling it at most once, and one idle reaper across all three.
 *
 * The payloads, the validation and the prose stay in each store — they share nothing. What lives here is only what they used to hold three copies of:
 * the map, `settle`, supersede-on-register, the stale-id-safe `cancel`, the test reset, and the 5 s `backAtDesk()` sweep.
 *
 * See `docs/subsystems/remote-answer.md`.
 */

import { backAtDesk } from './idle.js';

/** What every held wait carries, whatever its payload. */
export interface WaitEntry<R> {
  sessionId: string;
  timer: NodeJS.Timeout;
  /** Completes the hook's held response. Called at most once. */
  resolve: (r: R) => void;
}

export interface WaitStoreOptions<E, R> {
  /** What an older entry is settled with when a newer one for the same session replaces it. */
  superseded: R;
  /** What the idle sweep settles with. */
  released: R;
  /** Whether the idle sweep may hand this entry back to the terminal; every entry when omitted. */
  releasable?: (entry: E) => boolean;
  /** Runs on every settle — answer, timeout, supersede, release, dismiss — after the entry leaves the map and before `resolve`. Never on `cancel`. */
  onSettle?: (entry: E, result: R) => void;
}

export interface WaitStore<E extends WaitEntry<R>, R> {
  /** Finish an entry: clear its timer, drop it from the map if it is still the session's, run `onSettle`, fire `resolve`. A second settle is a no-op. */
  settle(entry: E, result: R): void;
  /** Hold `entry` for its session, settling any previous one as superseded, and start the shared reaper. */
  add(entry: E): void;
  /** Drop the session's entry without resolving it — its peer is gone — but only when `isCurrent` says it is the one the caller means. */
  cancel(sessionId: string, isCurrent: (entry: E) => boolean): void;
  get(sessionId: string): E | undefined;
  /** A snapshot, so a settle while iterating cannot skip an entry. */
  values(): E[];
  /** A fresh Set: callers never get a handle on the store's keys. */
  sessionIds(): Set<string>;
  readonly size: number;
  /** This store's own idle sweep: release its releasable entries if the user is back at the desk. Never reads idle with nothing to release. */
  sweepIdle(): number;
  /** Test seam: drop every entry without resolving. Stops the shared reaper once every store is empty. */
  reset(): void;
}

interface Reapable {
  readonly size: number;
  releasable(): (() => void)[];
}

const stores = new Set<Reapable>();
let reaper: NodeJS.Timeout | null = null;

function stopReaperIfEmpty(): void {
  if (reaper && [...stores].every(s => s.size === 0)) { clearInterval(reaper); reaper = null; }
}

/**
 * One tick of the shared reaper, exported as the test seam for it. Collects the releasable entries of every store; with none, returns 0 without calling
 * {@link backAtDesk}, so an idle server and a headless-only hold never spawn `ioreg`. Otherwise asks once — one `ioreg` per tick, not one per store — and
 * releases them all. Returns how many.
 */
export function reapIdle(): number {
  const release = [...stores].flatMap(s => s.releasable());
  if (release.length === 0 || !backAtDesk()) return 0;
  for (const r of release) r();
  return release.length;
}

/** The 5 s interval behind {@link reapIdle}. Runs only while some store holds an entry; `unref()` so it cannot hold the process open. */
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    reapIdle();
    stopReaperIfEmpty();
  }, 5_000);
  reaper.unref();
}

export function createWaitStore<E extends WaitEntry<R>, R>(opts: WaitStoreOptions<E, R>): WaitStore<E, R> {
  const entries = new Map<string, E>();
  const settled = new WeakSet<E>();
  const releasable = opts.releasable ?? (() => true);

  const settle = (entry: E, result: R): void => {
    if (settled.has(entry)) return;
    settled.add(entry);
    clearTimeout(entry.timer);
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
    opts.onSettle?.(entry, result);
    entry.resolve(result);
  };

  const releasableEntries = (): E[] => [...entries.values()].filter(releasable);

  const store: WaitStore<E, R> = {
    settle,
    add(entry) {
      const prev = entries.get(entry.sessionId);
      if (prev) settle(prev, opts.superseded);
      entries.set(entry.sessionId, entry);
      ensureReaper();
    },
    cancel(sessionId, isCurrent) {
      const entry = entries.get(sessionId);
      if (!entry || !isCurrent(entry)) return;
      settled.add(entry);
      clearTimeout(entry.timer);
      entries.delete(sessionId);
    },
    get: sessionId => entries.get(sessionId),
    values: () => [...entries.values()],
    sessionIds: () => new Set(entries.keys()),
    get size() { return entries.size; },
    sweepIdle() {
      const release = releasableEntries();
      if (release.length === 0) return 0; // nothing to release — don't spawn ioreg
      if (!backAtDesk()) return 0;
      for (const entry of release) settle(entry, opts.released);
      return release.length;
    },
    reset() {
      for (const entry of entries.values()) { settled.add(entry); clearTimeout(entry.timer); }
      entries.clear();
      stopReaperIfEmpty();
    }
  };

  stores.add({
    get size() { return entries.size; },
    releasable: () => releasableEntries().map(entry => () => settle(entry, opts.released))
  });
  return store;
}
