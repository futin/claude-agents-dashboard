/**
 * pins.ts — the pure pieces of the pinned-projects UI (#161): the picker's
 * filter, `~` path shortening and the split a picker row sets its path from.
 * Shared by the launch sheet and Settings › Pinned; unit-tested server-side.
 */

/**
 * Case-insensitive substring match over name and path. A blank query matches
 * everything; a dead pin has no path and matches by name alone.
 */
export function matchesPinFilter(ref: { name: string; path: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return ref.name.toLowerCase().includes(q) || (ref.path !== null && ref.path.toLowerCase().includes(q));
}

/** `~/…` for a path under `home`; anything else, or no home known, unchanged. */
export function shortenHome(p: string, home: string): string {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/**
 * A path as a picker row sets it: the parent segments, each with its slash so
 * the row can wrap only between them, and the basename on its own — it is the
 * row's title, so the row carries no second name line.
 */
export function splitPath(p: string): { dirs: string[]; name: string } {
  const i = p.lastIndexOf('/');
  if (i < 0) return { dirs: [], name: p };
  return { dirs: p.slice(0, i + 1).match(/[^/]*\//g) ?? [], name: p.slice(i + 1) };
}
