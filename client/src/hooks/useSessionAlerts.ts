import { useEffect, useRef } from 'react';

import { useSettings } from './useSettings';
import { alertText, dedupe, diffAlerts, statusMap, titleWithCount, type AlertTarget } from '../lib/alerts';
import type { AlertEvent, Session } from '../../../shared/types';

const BASE_TITLE = 'Claude Sessions';

/**
 * How long one announcement suppresses a repeat of itself. Comfortably longer
 * than the gap between the two producers noticing the same transition (a tick
 * or two), comfortably shorter than a session plausibly re-entering the same
 * status for a real second reason.
 */
const DEDUPE_MS = 60_000;

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
 * Fire the real alert path once, on demand, and say what happened.
 *
 * Every failure mode in this feature is silent by design — a `default`
 * permission, a suspended AudioContext and an OS that swallowed the banner all
 * look identical from the page: nothing. That is fine for a background poll and
 * useless for someone asking "why did I get nothing?". Called from a click, so
 * it can also unlock audio on the way through.
 */
export async function fireTestAlert(): Promise<string> {
  const audio = await unlockAudio();
  const notes: string[] = [];

  const permission = alertPermission();
  if (permission === 'unsupported') {
    notes.push('no Notification API in this browser — the tab title is the only channel');
  } else if (permission === 'denied') {
    notes.push('notifications blocked for this site in browser settings');
  } else if (permission === 'default') {
    notes.push('notification permission never granted — turn the toggle above off and on to ask');
  } else {
    try {
      new Notification('Claude Sessions', { body: 'Test alert — a session needs you', tag: 'test-alert' });
      notes.push('notification sent');
    } catch (err) {
      notes.push(`notification threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  beep();
  notes.push(audio === 'running' ? 'sound played' : audio === 'unsupported' ? 'no audio support' : 'sound blocked by the browser');
  return notes.join(' · ');
}

/**
 * One context for the tab's lifetime, not one per beep.
 *
 * A context constructed without user activation starts `suspended`, and
 * scheduling into a suspended context is a silent no-op — the old
 * one-context-per-beep version could never recover from that, because the
 * poll that wants to beep is by definition not a click. Holding a single
 * context lets `unlockAudio` open it from a real gesture (the Sound toggle,
 * the test button) and every later beep ride on it.
 */
let audioCtx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try { audioCtx = new Ctor(); }
    catch { return null; }
  }
  return audioCtx;
}

/**
 * Open the audio path from a user gesture. Must be called from a click —
 * `resume()` on a suspended context stays pending forever without activation,
 * which is exactly why a beep fired from a background poll can be inaudible on
 * a tab that has never been clicked. Returns the resulting state so the caller
 * can say so out loud instead of failing silently.
 */
export async function unlockAudio(): Promise<'running' | 'blocked' | 'unsupported'> {
  const ctx = audioContext();
  if (!ctx) return 'unsupported';
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* fall through to the state read */ }
  }
  return ctx.state === 'running' ? 'running' : 'blocked';
}

/**
 * Two short tones from an oscillator. No audio file, no dependency — the same
 * zero-dep posture the backend keeps. A blocked context still can't make sound,
 * but it now *tries* to resume rather than scheduling into the void, and a
 * missing beep still never breaks the poll.
 */
export function beep(): void {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // No activation yet — the resume may never settle, so don't await it.
      void ctx.resume().then(() => schedule(ctx)).catch(() => {});
      return;
    }
    schedule(ctx);
  } catch {
    /* autoplay policy / no audio device — not worth surfacing */
  }
}

/** Read `currentTime` at play time: it does not advance while suspended. */
function schedule(ctx: AudioContext): void {
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
  // The context is reused, so it is deliberately NOT closed here.
}

/**
 * The announcement ledger and pending count live at module scope, not in a
 * hook: there are two producers in different parts of the tree — the poll diff
 * inside SessionsView and the SSE stream mounted on the shell — and they have
 * to share one tab-title count and one dedupe window.
 */
const seen = new Map<string, number>();
let pendingCount = 0;

/** Announce a batch through every channel the browser allows. Deduped. */
function announce(targets: readonly AlertTarget[], sound: boolean): void {
  const fresh = dedupe(targets, seen, Date.now(), DEDUPE_MS);
  if (fresh.length === 0) return;

  pendingCount += fresh.length;
  document.title = titleWithCount(BASE_TITLE, pendingCount);

  if (alertPermission() === 'granted') {
    for (const target of fresh) {
      // `tag` collapses repeats for the same session into one notification
      // rather than stacking a new banner on every status change.
      try { new Notification('Claude Sessions', { body: alertText(target), tag: target.id }); }
      catch { /* some engines throw outside a service worker — title still flashed */ }
    }
  }
  if (sound) beep();
}

/** Coming back to the tab is the acknowledgement — clear the count. */
function useTitleReset(): void {
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      pendingCount = 0;
      document.title = BASE_TITLE;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}

/**
 * Subscribe to the server's push stream. **Mount this on the shell, not in a
 * section** — the whole point is that it keeps working when SessionsView is
 * unmounted or its poll is throttled to a standstill.
 *
 * `EventSource` reconnects on its own, and the server seeds a baseline per
 * connection, so a reconnect never replays a backlog. Delivery is event-driven
 * rather than timer-driven, which is what survives a hidden tab: the bytes sit
 * on the socket until the tab is allowed to run again.
 */
export function useAlertStream(): void {
  const { settings } = useSettings();
  // Read through a ref so toggling alerts or sound never tears down the socket.
  const live = useRef({ enabled: settings.alertsEnabled, sound: settings.alertsSound });
  live.current = { enabled: settings.alertsEnabled, sound: settings.alertsSound };

  useTitleReset();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/alerts/stream');
    const onAlert = (e: MessageEvent<string>): void => {
      if (!live.current.enabled) return;
      let event: AlertEvent;
      try { event = JSON.parse(e.data) as AlertEvent; }
      catch { return; }
      if (!event?.id || !event.status) return;
      announce([{ id: event.id, label: event.label, status: event.status }], live.current.sound);
    };
    source.addEventListener('alert', onAlert as EventListener);
    // No onerror handling on purpose: EventSource retries by itself, and a
    // server that is simply down is already surfaced by the poll's footer.
    return () => {
      source.removeEventListener('alert', onAlert as EventListener);
      source.close();
    };
  }, []);
}

/**
 * Notify when a session starts needing you.
 *
 * Fed by the same 3-second snapshot the rows render from, so it costs no extra
 * request. It is the *local* half of alerting — accurate only while this tab is
 * actually running its timer, which a hidden tab is not; `useAlertStream` is
 * what covers that case, and the two are deduped against each other.
 *
 * Three behaviours worth knowing:
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

  useEffect(() => {
    if (!sessions) return;
    const prev = previous.current;
    previous.current = statusMap(sessions);
    if (!prev) return; // first snapshot — baseline only

    if (!settings.alertsEnabled) return;
    announce(diffAlerts(prev, sessions), settings.alertsSound);
  }, [sessions, settings.alertsEnabled, settings.alertsSound]);
}
