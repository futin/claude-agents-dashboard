import { useEffect, useRef } from 'react';

import { armBackClose, browserHost } from '../lib/backClose';

/**
 * Close on the browser's back button/swipe for as long as this is mounted.
 *
 * The only dep is `rearm`, on purpose: callers pass a fresh `onClose` identity
 * every render, and re-arming on each one would push and `back()` at the poll
 * rate — straight into Safari's `pushState` throttle. The ref keeps the latest
 * callback without re-running the effect. A caller that refuses a Back bumps
 * `rearm` from `onClose`, since that Back spent the entry and the next one would
 * otherwise leave the page; it changes only then, never at the poll rate.
 */
export function useBackClose(onClose: () => void, rearm?: number): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => armBackClose(browserHost(), () => latest.current()), [rearm]);
}
