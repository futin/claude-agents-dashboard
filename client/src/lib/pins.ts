/**
 * pins.ts — the pure pieces of the pinned-projects UI (#161): the picker's
 * filter, `~` path shortening, the split a picker row sets its path from, and
 * the reorder helpers behind Management › Pinned's grip. Shared by the launch sheet and Management › Pinned; unit-tested server-side.
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

/**
 * `order` with `name` moved so it sits at `toIndex` in the result (clamped to the list). An unknown name, or a move to where it already is, returns `order`
 * itself, so a caller can skip the write by reference comparison.
 */
export function movePin(order: readonly string[], name: string, toIndex: number): string[] {
  const from = order.indexOf(name);
  if (from < 0) return order as string[];
  const to = Math.min(Math.max(toIndex, 0), order.length - 1);
  if (to === from) return order as string[];
  const next = order.filter(d => d !== name);
  next.splice(to, 0, name);
  return next;
}

/**
 * `rows` re-sorted into `order` — the optimistic list a reorder shows before the server answers. A row `order` does not name keeps its relative place
 * after the named ones, and a name with no row is skipped, so a stale order can never drop or duplicate a row.
 */
export function applyPinOrder<T extends { dirName: string }>(rows: readonly T[], order: readonly string[]): T[] {
  const byName = new Map(rows.map(r => [r.dirName, r]));
  const named = order.flatMap(d => {
    const r = byName.get(d);
    byName.delete(d);
    return r ? [r] : [];
  });
  return [...named, ...rows.filter(r => byName.has(r.dirName))];
}
