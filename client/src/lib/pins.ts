/**
 * pins.ts — the pure pieces of the pinned-projects UI (#161): the launch
 * select's option label, the older-projects filter, and `~` path shortening.
 * Shared by the launch sheet and Settings › Pinned; unit-tested server-side.
 */

import { formatAgo } from './format';
import type { ProjectRef } from '../../../shared/types';

/** A native `<option>` cannot hold an icon, so a pin is spelled out. */
export function pinnedOptionLabel(ref: ProjectRef): string {
  return ref.pinned ? `${ref.name} · pinned` : ref.name;
}

/** Case-insensitive substring match over name and path. A blank query matches everything. */
export function matchesPinFilter(ref: { name: string; path: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return ref.name.toLowerCase().includes(q) || ref.path.toLowerCase().includes(q);
}

/** `~/…` for a path under `home`; anything else, or no home known, unchanged. */
export function shortenHome(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/** `last session 5d ago`. */
export function lastSessionLabel(ms: number): string {
  return `last session ${formatAgo(ms)} ago`;
}
