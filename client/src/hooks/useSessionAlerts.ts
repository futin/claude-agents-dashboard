import { useEffect, useRef } from 'react';

import { useSettings } from './useSettings';
import { alertText, diffAlerts, statusMap, titleWithCount } from '../lib/alerts';
import type { Session } from '../../../shared/types';

const BASE_TITLE = 'Claude Sessions';

/**
 * Ask the browser for notification permission. Must be called from a click —
 * every engine now requires a user gesture — which is why the Settings toggle
 * owns this rather than the hook below.
 */
export async function requestAlertPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return 'denied'; }
}

/** Current permission, or 'unsupported' where the API doesn't exist at all (iOS Safari in a tab). */
export function alertPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Two short tones from an oscillator. No audio file, no dependency — the same
 * zero-dep posture the backend keeps. Silently does nothing if the AudioContext
 * is blocked (no prior gesture in this tab), which is the correct failure: a
 * missing beep must never break the poll.
 */
function beep(): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1174].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      // Ramp instead of a hard stop: a square-edged gate clicks audibly.
      gain.gain.setValueAtTime(0.0001, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.14);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* autoplay policy / no audio device — not worth surfacing */
  }
}

/**
 * Notify when a session starts needing you.
 *
 * Fed by the same 3-second snapshot the rows render from, so it costs no extra
 * request. Three behaviours worth knowing:
 *
 *  - **No baseline, no alerts.** The first snapshot after a load has nothing to
 *    diff against, so it only seeds the ref. Otherwise every already-waiting
 *    session would fire at once on every page load.
 *  - **The ref updates even when alerts are off.** Turning them on mid-session
 *    must not replay the backlog — the baseline has been tracked all along.
 *  - **The tab title always flashes**, notification permission or not. On iOS
 *    Safari `Notification` only exists for a home-screen PWA, and that is the
 *    single most likely device to be watching this. A count in the title works
 *    everywhere.
 */
export function useSessionAlerts(sessions: Session[] | null | undefined): void {
  const { settings } = useSettings();
  const previous = useRef<Map<string, Session['status']> | null>(null);
  const pending = useRef(0);

  useEffect(() => {
    if (!sessions) return;
    const prev = previous.current;
    previous.current = statusMap(sessions);
    if (!prev) return; // first snapshot — baseline only

    if (!settings.alertsEnabled) return;
    const fresh = diffAlerts(prev, sessions);
    if (fresh.length === 0) return;

    pending.current += fresh.length;
    document.title = titleWithCount(BASE_TITLE, pending.current);

    if (alertPermission() === 'granted') {
      for (const target of fresh) {
        // `tag` collapses repeats for the same session into one notification
        // rather than stacking a new banner on every status change.
        try { new Notification('Claude Sessions', { body: alertText(target), tag: target.id }); }
        catch { /* some engines throw outside a service worker — title still flashed */ }
      }
    }
    if (settings.alertsSound) beep();
  }, [sessions, settings.alertsEnabled, settings.alertsSound]);

  // Coming back to the tab is the acknowledgement — clear the count.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      pending.current = 0;
      document.title = BASE_TITLE;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}
