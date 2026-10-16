/**
 * backClose.ts — the phone's exit from a modal overlay.
 *
 * A full-screen drawer below `md` (768px) has no scrim to tap and no Escape key, so
 * the back button/swipe is the exit a phone user already reaches for. Arming it
 * means pushing one synthetic history entry and closing on the popstate that
 * pops it — and, just as importantly, spending that entry with `back()` when the
 * drawer closes any other way, so no back press is ever swallowed by an entry
 * nobody is watching.
 *
 * Everything here runs over an injected host so the state machine is testable
 * with no DOM (`test/back-close.test.ts`); `browserHost()` is the only impure
 * part.
 */

/** The seam: every browser capability `armBackClose` needs, and nothing else. */
export interface BackCloseHost {
  pushState(state: unknown, title: string): void;
  back(): void;
  addEventListener(type: 'popstate', fn: () => void): void;
  removeEventListener(type: 'popstate', fn: () => void): void;
  /** Schedule as a *macrotask* — see the deferral note in `armBackClose`. */
  defer(fn: () => void): number;
  cancel(handle: number): void;
}

/**
 * Arm one history entry that closes something; returns its teardown.
 *
 * The push is deferred to a macrotask because `history.back()` is asynchronous:
 * its popstate lands in a later task. React's StrictMode double-invoke
 * (arm → teardown → arm) and a keyed remount both produce teardown-then-arm, and
 * a synchronous push would let the first teardown's in-flight `back()` pop the
 * second arm's entry — slamming the drawer shut as it opens. Deferring the push
 * *and* the listener registration makes the cancel win instead. A microtask
 * would flush before the pending popstate and fix neither case.
 */
/**
 * The `back()` calls on a host whose popstate has not landed yet, and the arms waiting for it. One overlay closing as another opens — the phone menu's
 * version chip opening What's new — is teardown-then-arm across two components, and a single macrotask is not enough there: in Chromium the menu's
 * popstate landed after the drawer's deferred push about half the time, popping the drawer's own entry and closing it as it opened. So an arm that comes
 * due while a `back()` is in flight waits for that popstate, then pushes on a fresh macrotask.
 */
interface InFlight {
  backs: number;
  waiting: Set<() => void>;
}
const inFlight = new WeakMap<BackCloseHost, InFlight>();

function inFlightOn(host: BackCloseHost): InFlight {
  let s = inFlight.get(host);
  if (!s) inFlight.set(host, (s = { backs: 0, waiting: new Set() }));
  return s;
}

/** `host.back()`, counted until its popstate lands; the arms that waited on it then run on the next macrotask. */
function countedBack(host: BackCloseHost): void {
  const s = inFlightOn(host);
  s.backs++;
  const landed = () => {
    host.removeEventListener('popstate', landed);
    if (--s.backs > 0) return;
    host.defer(() => {
      const ready = [...s.waiting];
      s.waiting.clear();
      for (const fn of ready) fn();
    });
  };
  host.addEventListener('popstate', landed);
  host.back();
}

export function armBackClose(host: BackCloseHost, onClose: () => void): () => void {
  // pending: nothing pushed yet · live: our entry is on the stack · gone: spent.
  let phase: 'pending' | 'live' | 'gone' = 'pending';
  const flight = inFlightOn(host);

  function onPop() {
    if (phase !== 'live') return;
    phase = 'gone';
    host.removeEventListener('popstate', onPop);
    onClose();
  }

  function push() {
    if (phase !== 'pending') return; // torn down before we ran
    if (flight.backs > 0) {
      flight.waiting.add(push);
      return;
    }
    try {
      // No url argument: the entry carries the current URL unchanged, so the
      // drawer never looks bookmarkable and `deepLinkSession()`'s strip stands.
      host.pushState({ chatDrawer: true }, '');
    } catch {
      // Safari throttles pushState and file:// can reject it. Fail open: no
      // entry, no listener, and teardown must not call back() — navigating the
      // user off the dashboard is worse than the trap this removes.
      phase = 'gone';
      return;
    }
    phase = 'live';
    host.addEventListener('popstate', onPop);
  }

  const handle = host.defer(push);

  return () => {
    if (phase === 'pending') {
      phase = 'gone';
      host.cancel(handle);
      flight.waiting.delete(push);
      return;
    }
    if (phase !== 'live') return; // already popped, or never pushed
    phase = 'gone';
    // Unregister before back(): its popstate would otherwise re-enter onClose().
    host.removeEventListener('popstate', onPop);
    countedBack(host);
  };
}

let browser: BackCloseHost | null = null;

/**
 * The real browser behind `BackCloseHost`. Exercised by the browser checks, not units. One object for the page, because the in-flight `back()` count is
 * kept per host and every overlay shares the one history.
 */
export function browserHost(): BackCloseHost {
  return (browser ??= {
    pushState: (state, title) => window.history.pushState(state, title),
    back: () => window.history.back(),
    addEventListener: (type, fn) => window.addEventListener(type, fn),
    removeEventListener: (type, fn) => window.removeEventListener(type, fn),
    defer: (fn) => window.setTimeout(fn, 0),
    cancel: (handle) => window.clearTimeout(handle)
  });
}
