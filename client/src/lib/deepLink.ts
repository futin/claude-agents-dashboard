/**
 * deepLink.ts — the `?session=<id>`, `?view=git|routines|usage` and `&run=<id>` entry points.
 *
 * A push notification's whole value is landing you on the thing that needs a
 * decision, not on the dashboard's front page. `server/lib/notify.ts` puts this
 * URL in ntfy's `Click` header; this module is what the page does with it.
 *
 * The id is consumed once and stripped from the URL: session ids churn, so a
 * bookmarked or refreshed deep link would reopen a drawer for a session that no
 * longer exists — the same reasoning that keeps `chatId` out of persisted state
 * (see `docs/subsystems/view-persistence.md`).
 *
 * `?view=git` is Lookout's "Git pending" tile (`server/lib/hub-widgets.ts`): it lands on Management › Git. It is consumed and stripped the same way, in the
 * same read, so whichever of the two callers runs first cannot strip the other's param.
 *
 * `?view=routines&run=<id>` is a failed routine run's push (`server/lib/notify.ts`): Routines › Runs with that run's fold open. `run` is read in the
 * same pass as the other two, so the strip that follows cannot lose it before the Routines page asks.
 *
 * `?view=usage` is a usage-limit push (`server/lib/notify.ts` `usageClickUrl`): it lands on the Usage section, with no sub-view to set.
 */
import type { Section } from './sections';

/** A session id is a UUID; anything else is junk and is ignored. Pure — tested. */
export function readSessionParam(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('session');
    if (!id || id.length > 64) return null;
    return /^[0-9a-fA-F-]{8,64}$/.test(id) ? id : null;
  } catch {
    return null; // malformed query string
  }
}

/** The sub-views a link may name. */
export type DeepLinkView = 'git' | 'routines' | 'usage';

/** The one sub-view a link may name; anything else is ignored. Pure — tested. */
export function readViewParam(search: string): DeepLinkView | null {
  try {
    const view = new URLSearchParams(search).get('view');
    if (view === 'schedules') return 'routines'; // a push sent before Schedules became Routines
    return view === 'git' || view === 'routines' || view === 'usage' ? view : null;
  } catch {
    return null; // malformed query string
  }
}

/** The section a linked view lands on. Pure — tested. */
export function sectionForView(view: DeepLinkView): Section {
  return view === 'git' ? 'management' : view;
}

/** A run id is the wrapper's uuid or a refusal's `refused-<machine>-<job>-<epoch>`; it only ever reaches a lookup in the polled list, so the shape check keeps junk out of the key. Pure — tested. */
export function readRunParam(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('run');
    return id && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : null;
  } catch {
    return null; // malformed query string
  }
}

type Where = { location: Pick<Location, 'search' | 'pathname'>; history: Pick<History, 'replaceState'> };

export interface DeepLink {
  /** The id this page was opened with, or null. */
  session(): string | null;
  /** The sub-view this page was opened with (`?view=git`, `?view=routines`, `?view=usage`), or null. */
  view(): DeepLinkView | null;
  /** The routine run this page was opened with (`&run=<id>`), or null. */
  run(): string | null;
  /**
   * The sub-view the link asks for, at most once: null when a `?session=` outranks the view (that link lands on Sessions, so it must not rewrite the
   * stored tab) and on every call after the first, so an effect that re-runs cannot re-apply it.
   */
  takeTab(): DeepLinkView | null;
}

/**
 * The params are read once, on the first call to any accessor, and the URL is stripped then, so every caller sees the same answer no matter which renders
 * first. Takes the window so a test can hand it a fake one; the app uses the module-level instance below.
 */
export function createDeepLink(where: Where): DeepLink {
  let read: { session: string | null; view: DeepLinkView | null; run: string | null } | null = null;
  let tabTaken = false;
  const consume = () => {
    if (read) return read;
    const search = where.location.search;
    read = { session: readSessionParam(search), view: readViewParam(search), run: readRunParam(search) };
    if (read.session || read.view || read.run) {
      try {
        where.history.replaceState(null, '', where.location.pathname);
      } catch {
        /* older engines / file:// — the param staying put is harmless */
      }
    }
    return read;
  };
  return {
    session: () => consume().session,
    view: () => consume().view,
    run: () => consume().run,
    takeTab: () => {
      if (tabTaken) return null;
      tabTaken = true;
      const { session, view } = consume();
      return session ? null : view;
    }
  };
}

let link: DeepLink | null = null;
const page = (): DeepLink => (link ??= createDeepLink(window));

/**
 * The id this page was opened with, or null.
 *
 * Memoised, and the URL is stripped on the first call, so the two callers
 * (`AppShell` picking the section, `SessionsView` opening the drawer) see the
 * same answer no matter which renders first.
 */
export function deepLinkSession(): string | null {
  return page().session();
}

/** The sub-view this page was opened with (`?view=git`, `?view=routines`, `?view=usage`), or null. Memoised with {@link deepLinkSession}. */
export function deepLinkView(): DeepLinkView | null {
  return page().view();
}

/** The routine run this page was opened with (`&run=<id>`), or null. Memoised with {@link deepLinkSession}, so it still answers after the URL was stripped. */
export function deepLinkRun(): string | null {
  return page().run();
}

/** {@link DeepLink.takeTab} for this page: `AppShell` applies it to the `managementTab` or `routinesTab` setting once; `usage` has no tab to set. */
export function takeDeepLinkTab(): DeepLinkView | null {
  return page().takeTab();
}
