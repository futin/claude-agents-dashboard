import { useEffect, useRef } from 'react';

import { armBackClose, browserHost } from '../lib/backClose';

/**
 * Close on the browser's back button/swipe for as long as this is mounted.
 *
 * Deps are empty on purpose: callers pass a fresh `onClose` identity every
 * render, and re-arming on each one would push and `back()` at the poll rate —
 * straight into Safari's `pushState` throttle. The ref keeps the latest callback
 * without re-running the effect.
 */
export function useBackClose(onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => armBackClose(browserHost(), () => latest.current()), []);
}
