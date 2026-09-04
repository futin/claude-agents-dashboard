/**
 * webNotify.ts — the pure half of "tell this browser a headless session needs me".
 *
 * A session spawned from the dashboard has no CLI in front of it, so nothing at
 * the desk announces it: the notification an ordinary session would duplicate
 * does not exist for this one. That scope gate is the whole reason this layer
 * came back after `6a05998` deleted its predecessor, so it lives in
 * `notifyKind` where a test can hold it down.
 *
 * See `docs/subsystems/push-notify.md`.
 */

import { holdKind } from './holds';
import type { Session } from '../../../shared/types';

/**
 * The holds worth a banner. `permission` is deliberately not one: a headless
 * run has no TTY, so there is no permission dialog to answer and a banner would
 * be asking for something impossible.
 */
export type NotifyKind = 'question' | 'plan' | 'reply';

/** One announcement, reduced to what the banner needs. */
export interface NotifyTarget {
  id: string;
  label: string;
  kind: NotifyKind;
}

export const NOTIFY_TITLE = 'Claude Sessions';

/** What this session should announce, or `null` — including for every non-headless row. */
export function notifyKind(s: Session): NotifyKind | null {
  if (s.surface !== 'dashboard') return null;
  const kind = holdKind(s);
  return kind === null || kind === 'permission' ? null : kind;
}

/** The baseline one poll leaves behind for the next one to diff against. */
export function kindMap(sessions: readonly Session[]): Map<string, NotifyKind> {
  const out = new Map<string, NotifyKind>();
  for (const s of sessions) {
    const kind = notifyKind(s);
    if (kind) out.set(s.id, kind);
  }
  return out;
}

/**
 * Sessions that just *became* something worth announcing.
 *
 * A pure diff: an empty `prev` yields the whole waiting set, and skipping that
 * first snapshot is the caller's job, not this function's.
 */
export function diffNeeds(
  prev: ReadonlyMap<string, NotifyKind>,
  next: readonly Session[]
): NotifyTarget[] {
  const out: NotifyTarget[] = [];
  for (const s of next) {
    const kind = notifyKind(s);
    if (!kind) continue;
    if (prev.get(s.id) === kind) continue; // still waiting on the same thing — already said
    out.push({ id: s.id, label: s.sessionName || s.project, kind });
  }
  return out;
}

/** Identity of one announcement. The same session under a different hold is still news. */
export function notifyKey(t: NotifyTarget): string {
  return `${t.id}:${t.kind}`;
}

/**
 * Drop targets already announced within `ttlMs`, and record the survivors.
 *
 * Mutates `seen`, which is the point — it is the ledger a long-lived tab shares
 * across polls. Entries older than the window are evicted on the way through so
 * it cannot grow without bound.
 */
export function dedupe(
  targets: readonly NotifyTarget[],
  seen: Map<string, number>,
  now: number,
  ttlMs: number
): NotifyTarget[] {
  for (const [key, at] of seen) {
    if (now - at > ttlMs) seen.delete(key);
  }
  const out: NotifyTarget[] = [];
  for (const t of targets) {
    const key = notifyKey(t);
    if (seen.has(key)) continue;
    seen.set(key, now);
    out.push(t);
  }
  return out;
}

/** Phrased to match `PHRASE` in `server/lib/notify.ts`, so the away channel and this one read alike. */
export function notifyBody(t: NotifyTarget): string {
  if (t.kind === 'question') return `${t.label} — question waiting`;
  if (t.kind === 'plan') return `${t.label} — plan waiting for review`;
  return `${t.label} — finished — reply window open`;
}

/**
 * The *name* of the theme token this kind's icon is painted in. Resolving and
 * painting it needs a live document, so that stays in the hook and this module
 * stays pure.
 */
export function iconColorVar(kind: NotifyKind): string {
  if (kind === 'question') return '--amber';
  if (kind === 'plan') return '--cyan';
  return '--mustard';
}
