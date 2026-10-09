import type { PinRow, PinsResponse, ProjectRef } from '../../../shared/types.js';
import { matchesPinFilter, shortenHome, splitPath } from './pins.js';

/**
 * The shapes Management › Projects can take, and the pure pieces its page reads: the pinned / offered split, the `~`-shortened parent dir and the copy strings.
 * Modelled on `gitLayouts.ts`, but with no narrow-window coercion: all three shapes are offered at every width and the CSS stacks the columns.
 *
 * The choice persists per device under `management.projectsLayout` (an OWNED_KEYS entry, so Reset sweeps it), default `tiles`; there is no Settings picker for it.
 */
export type ProjectsLayout = 'tiles' | 'columns' | 'lists';

export const PROJECTS_LAYOUTS: { key: ProjectsLayout; label: string }[] = [
  { key: 'tiles', label: 'Tiles' },
  { key: 'columns', label: 'Columns' },
  { key: 'lists', label: 'Lists' },
];

export const DEFAULT_PROJECTS_LAYOUT: ProjectsLayout = 'tiles';

export function isProjectsLayout(v: unknown): v is ProjectsLayout {
  return PROJECTS_LAYOUTS.some(l => l.key === v);
}

/**
 * Both groups the page draws, whole and filtered. `offers` is `recent` then `older`, in the server's order (each already newest-first); the `*Shown` lists
 * run the one query through the launch sheet's own `matchesPinFilter`, so the page and the sheet agree on what a match is. The unfiltered lists stay in the
 * result because the empty-state copy needs the total: no pins at all and no pin matching read differently.
 */
export function splitProjects(
  pins: PinsResponse,
  query: string,
): { pinned: PinRow[]; offers: ProjectRef[]; pinnedShown: PinRow[]; offersShown: ProjectRef[] } {
  const offers = [...pins.recent, ...pins.older];
  return {
    pinned: pins.pinned,
    offers,
    pinnedShown: pins.pinned.filter(r => matchesPinFilter(r, query)),
    offersShown: offers.filter(r => matchesPinFilter(r, query)),
  };
}

/**
 * The parent directory a row sets above its name: `~`-shortened, with the trailing slash (`/Users/u/Projects/x` under home `/Users/u` is `~/Projects/`), or the
 * absolute parent for a path outside home (`/opt/x/`). A path with no parent left after shortening (home itself, a bare name, `/x`) yields '' rather than a
 * lone `/`, so the row draws no dir prefix.
 */
export function projectDir(path: string, home: string): string {
  const dirs = splitPath(shortenHome(path, home)).dirs;
  const dir = dirs.join('');
  return dir === '/' ? '' : dir;
}

export const PROJECTS_BAND_SUB =
  'Every project with a session in the last 30 days. Pin one to keep it in the launch sheet whatever the lookback; pins are stored by the dashboard server, so they show up on every device.';

/** A dead pin's note: its cwd is gone, so every list hides it until it is unpinned. */
export const PROJECTS_MISSING = 'Folder no longer exists. Hidden from every list until unpinned.';

/** The pinned group's empty state; `total` is the unfiltered count, so a filter that matches nothing reads differently from no pins at all. */
export function noPinsText(total: number): string {
  return total === 0 ? 'No projects are pinned.' : 'No pinned project matches.';
}

/** The offered group's empty state; `total` is the unfiltered count. */
export function noOffersText(total: number): string {
  return total === 0 ? 'Every project active in the last 30 days is already pinned.' : 'No project matches.';
}

/** The Lists layout's sub-lines under each group heading. */
export const LIST_SUB_OFFERS = 'a session in the last 30 days, gone from the launch sheet once it ages out';
export const LIST_SUB_PINNED = 'kept in the launch sheet whatever the lookback';
