/**
 * deepLink.ts — the `?session=<id>` and `?view=git` entry points.
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
 */

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

/** The one sub-view a link may name; anything else is ignored. Pure — tested. */
export function readViewParam(search: string): 'git' | null {
  try {
    return new URLSearchParams(search).get('view') === 'git' ? 'git' : null;
  } catch {
    return null; // malformed query string
  }
}

let consumed: { session: string | null; view: 'git' | null } | null = null;

function consume(): { session: string | null; view: 'git' | null } {
  if (consumed) return consumed;
  const search = window.location.search;
  consumed = { session: readSessionParam(search), view: readViewParam(search) };
  if (consumed.session || consumed.view) {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      /* older engines / file:// — the param staying put is harmless */
    }
  }
  return consumed;
}

/**
 * The id this page was opened with, or null.
 *
 * Memoised, and the URL is stripped on the first call, so the two callers
 * (`AppShell` picking the section, `SessionsView` opening the drawer) see the
 * same answer no matter which renders first.
 */
export function deepLinkSession(): string | null {
  return consume().session;
}

/** The sub-view this page was opened with (`?view=git`), or null. Memoised with {@link deepLinkSession}. */
export function deepLinkView(): 'git' | null {
  return consume().view;
}
