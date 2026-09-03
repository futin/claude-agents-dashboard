/**
 * backClose.ts — the phone's exit from a modal overlay.
 *
 * A full-screen drawer at `<=700px` has no scrim to tap and no Escape key, so
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
export function armBackClose(host: BackCloseHost, onClose: () => void): () => void {
  // pending: nothing pushed yet · live: our entry is on the stack · gone: spent.
  let phase: 'pending' | 'live' | 'gone' = 'pending';

  function onPop() {
    if (phase !== 'live') return;
    phase = 'gone';
    host.removeEventListener('popstate', onPop);
    onClose();
  }

  const handle = host.defer(() => {
    if (phase !== 'pending') return; // torn down before we ran
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
  });

  return () => {
    if (phase === 'pending') {
      phase = 'gone';
      host.cancel(handle);
      return;
    }
    if (phase !== 'live') return; // already popped, or never pushed
    phase = 'gone';
    // Unregister before back(): its popstate would otherwise re-enter onClose().
    host.removeEventListener('popstate', onPop);
    host.back();
  };
}

/** The real browser behind `BackCloseHost`. Exercised by the browser checks, not units. */
export function browserHost(): BackCloseHost {
  return {
    pushState: (state, title) => window.history.pushState(state, title),
    back: () => window.history.back(),
    addEventListener: (type, fn) => window.addEventListener(type, fn),
    removeEventListener: (type, fn) => window.removeEventListener(type, fn),
    defer: (fn) => window.setTimeout(fn, 0),
    cancel: (handle) => window.clearTimeout(handle)
  };
}
