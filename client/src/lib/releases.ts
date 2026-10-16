/**
 * releases.ts — what the version chip and the What's new drawer decide, with no React and no DOM in it (`test/releases-client.test.ts`).
 *
 * The unseen dot is a per-viewer convenience over `localStorage`, never a record: a first visit seeds the newest version so a fresh install never shows
 * every release as new, a stored value that is not a version counts as missing, and storage that throws means no dot rather than a crash
 * (docs/subsystems/releases.md).
 */
import type { Release, ReleasesResponse } from '../../../shared/types';

export const LAST_SEEN_KEY = 'dashboard.releases.lastSeen';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** `X.Y.Z` as three numbers, or `null` for anything else — a leading `v` and a prerelease suffix included. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Numeric order per part, so `0.10.0` is above `0.9.0`. Both must be valid versions. */
export function cmpVersion(a: string, b: string): number {
  const [x, y] = [parseVersion(a)!, parseVersion(b)!];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** `v0.5.0`, `v0.5.0+3` three commits past it, or `null` — no chip — when the checkout has no version. */
export function chipLabel(current: ReleasesResponse['current']): string | null {
  if (!current) return null;
  return current.ahead > 0 ? `v${current.version}+${current.ahead}` : `v${current.version}`;
}

/** The newest release's version; the baseline counts, so a baseline-only history's newest is `0.1.0`. */
export function newestVersion(releases: Release[]): string | null {
  return releases[0]?.version ?? null;
}

/** The last version the viewer opened the drawer on. Both methods swallow storage failures. */
export interface SeenStore {
  get(): string | null;
  set(v: string): void;
}

export function localSeenStore(): SeenStore {
  return {
    get() {
      try {
        return localStorage.getItem(LAST_SEEN_KEY);
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        localStorage.setItem(LAST_SEEN_KEY, v);
      } catch {
        /* a private window or blocked storage: the dot just never shows */
      }
    },
  };
}

/**
 * Should the chip carry the dot? Only when the newest release is above the stored one. A missing or unreadable stored value is seeded with the newest
 * instead, which is why this writes: call it from an effect, not during render.
 */
export function unseen(newest: string | null, store: SeenStore): boolean {
  if (newest === null || !parseVersion(newest)) return false;
  let seen: string | null;
  try {
    seen = store.get();
  } catch {
    return false;
  }
  if (seen === null || !parseVersion(seen)) {
    try {
      store.set(newest);
    } catch {
      /* nothing to seed into */
    }
    return false;
  }
  return cmpVersion(newest, seen) > 0;
}

/** Opening the drawer marks the newest release seen. */
export function markSeen(newest: string | null, store: SeenStore): void {
  if (newest === null) return;
  try {
    store.set(newest);
  } catch {
    /* as above */
  }
}

export type BadgeKind = 'feat' | 'fix' | 'perf' | 'breaking';

const TYPE_LABEL = { feat: 'Feature', fix: 'Fix', perf: 'Performance' } as const;

/** The type badge, then Breaking as a badge of its own — breaking is not a fourth type. The baseline has none: it renders as a divider. */
export function badges(r: Release): { kind: BadgeKind; label: string }[] {
  if (r.type === 'baseline') return [];
  const out: { kind: BadgeKind; label: string }[] = [{ kind: r.type, label: TYPE_LABEL[r.type] }];
  if (r.breaking) out.push({ kind: 'breaking', label: 'Breaking' });
  return out;
}

const CC_PREFIX = /^[a-z]+(?:\([a-z0-9-]+\))?!?: ?/;

/** The title without its `type(scope)!: ` prefix, which the badge already says. A title with no prefix is returned as it is. */
export function displayTitle(title: string): string {
  return title.replace(CC_PREFIX, '');
}

/** `16 Oct 2026`, in the viewer's own timezone; an unparseable date is shown as it came. */
export function formatReleaseDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
