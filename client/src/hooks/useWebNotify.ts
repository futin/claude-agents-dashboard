import { useEffect, useRef } from 'react';

import { useSettings } from './useSettings';
import {
  NOTIFY_TITLE, dedupe, diffNeeds, iconColorVar, kindMap, notifyBody,
  type NotifyKind, type NotifyTarget
} from '../lib/webNotify';
import type { Session } from '../../../shared/types';

/**
 * How long one announcement suppresses a repeat of itself — comfortably longer
 * than a poll or two, comfortably shorter than a session plausibly re-entering
 * the same hold for a real second reason.
 */
const DEDUPE_MS = 60_000;

/**
 * One glyph per kind, drawn into the icon. Chosen to be solid shapes rather
 * than thin strokes: the OS draws the banner at ~20px, and anything hairline
 * disappears there. `▸` is the plan going out for review, `◂` the reply coming
 * back to you.
 */
const GLYPH: Record<NotifyKind, string> = { question: '?', plan: '▸', reply: '◂' };

/** Whether this engine has the API at all. iOS Safari in a tab does not. */
export function webNotifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function webNotifyPermission(): NotificationPermission | 'unsupported' {
  return webNotifySupported() ? Notification.permission : 'unsupported';
}

/**
 * Ask for permission. Must be called from a click — every engine requires a
 * user gesture — which is why the Settings switch owns this and the poll below
 * never calls it.
 */
export async function requestWebNotifyPermission(): Promise<NotificationPermission> {
  if (!webNotifySupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return 'denied'; }
}

/**
 * A 64×64 disc in the live theme colour with the kind's glyph on it, as a PNG
 * data URL. The icon is the *only* styling a Web Notification allows — title,
 * body, icon, `tag`, `silent`, and the banner itself is drawn by the OS with no
 * CSS reachable from here.
 *
 * Memoised per kind + resolved colour, so a theme switch repaints and a repeat
 * does not. Returns `undefined` rather than throwing: a missing icon must never
 * cost the banner.
 */
const iconCache = new Map<string, string>();

export function notifyIcon(kind: NotifyKind): string | undefined {
  try {
    const style = getComputedStyle(document.documentElement);
    const disc = style.getPropertyValue(iconColorVar(kind)).trim();
    const ink = style.getPropertyValue('--on-accent').trim();
    if (!disc || !ink) return undefined;

    const key = `${kind}:${disc}:${ink}`;
    const hit = iconCache.get(key);
    if (hit) return hit;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = ink;
    ctx.font = '700 38px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH[kind], 32, 35);

    const url = canvas.toDataURL('image/png');
    iconCache.set(key, url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * One context for the tab's lifetime, not one per beep.
 *
 * A context constructed without user activation starts `suspended`, and
 * scheduling into a suspended context is a silent no-op. Holding a single
 * context lets `unlockAudio` open it from a real gesture (the Settings switch,
 * the Test button) and every later beep ride on it — the poll that wants to
 * beep is by definition not a click.
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
 * Open the audio path from a user gesture. Returns the resulting state so the
 * caller can say so out loud instead of failing silently.
 */
export async function unlockAudio(): Promise<'running' | 'blocked' | 'unsupported'> {
  const ctx = audioContext();
  if (!ctx) return 'unsupported';
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* fall through to the state read */ }
  }
  return ctx.state === 'running' ? 'running' : 'blocked';
}

/** Two short tones from an oscillator. No audio file, no dependency. */
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

/** The announcement ledger, at module scope so it survives a remount of the poll. */
const seen = new Map<string, number>();

/** Announce a batch: one banner per fresh target, then exactly one beep for the batch. */
function announce(targets: readonly NotifyTarget[]): void {
  const fresh = dedupe(targets, seen, Date.now(), DEDUPE_MS);
  if (fresh.length === 0) return;

  if (webNotifyPermission() === 'granted') {
    for (const target of fresh) {
      try {
        // `tag` collapses repeats for one session into a single banner rather
        // than stacking a new one on every hold it enters. `silent` is ours on
        // purpose: one sound per batch, and the same sound on every OS.
        new Notification(NOTIFY_TITLE, {
          body: notifyBody(target),
          tag: target.id,
          icon: notifyIcon(target.kind),
          silent: true
        });
      } catch { /* some engines throw outside a service worker — the beep still fires */ }
    }
  }
  beep();
}

/**
 * Fire the real path once, on demand, and say what happened.
 *
 * Every failure mode here is silent by design — a `default` permission, a
 * suspended AudioContext and an OS that swallowed the banner all look identical
 * from the page: nothing. Same principle as `POST /api/notify/test`. Called
 * from a click, so it can unlock audio on the way through.
 */
export async function fireTestNotification(): Promise<string> {
  const audio = await unlockAudio();
  const notes: string[] = [];

  const permission = webNotifyPermission();
  if (permission === 'unsupported') {
    notes.push('no Notification API in this browser');
  } else if (permission === 'denied') {
    notes.push('notifications blocked for this site in browser settings');
  } else if (permission === 'default') {
    notes.push('notification permission never granted — turn the switch off and on to ask');
  } else {
    try {
      new Notification(NOTIFY_TITLE, {
        body: 'Test — a headless session needs you',
        tag: 'web-notify-test',
        icon: notifyIcon('question'),
        silent: true
      });
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
 * Notify this browser when a dashboard-spawned session starts needing you.
 *
 * Fed by the same snapshot the rows render from, so it costs no extra request —
 * and bounded by it: only sessions inside the poll's window are seen at all, and
 * nothing fires while another section is open. Both blind spots are written
 * down in `docs/subsystems/push-notify.md`; ntfy is the channel that has neither.
 *
 * Two behaviours worth knowing:
 *
 *  - **No baseline, no announcements.** The first snapshot after a load only
 *    seeds the ref, or every already-waiting session would fire at once on
 *    every page load.
 *  - **The ref updates even while the switch is off**, so turning it on
 *    mid-session cannot replay a backlog.
 */
export function useWebNotify(sessions: Session[] | null | undefined): void {
  const { settings } = useSettings();
  const previous = useRef<Map<string, NotifyKind> | null>(null);

  useEffect(() => {
    if (!sessions) return;
    const prev = previous.current;
    previous.current = kindMap(sessions);
    if (!prev) return; // first snapshot — baseline only

    if (!settings.notifyBrowser) return;
    announce(diffNeeds(prev, sessions));
  }, [sessions, settings.notifyBrowser]);
}
