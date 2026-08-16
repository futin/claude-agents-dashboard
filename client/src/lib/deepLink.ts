/**
 * deepLink.ts — the `?session=<id>` entry point.
 *
 * A push notification's whole value is landing you on the thing that needs a
 * decision, not on the dashboard's front page. `server/lib/notify.ts` puts this
 * URL in ntfy's `Click` header; this module is what the page does with it.
 *
 * The id is consumed once and stripped from the URL: session ids churn, so a
 * bookmarked or refreshed deep link would reopen a drawer for a session that no
 * longer exists — the same reasoning that keeps `chatId` out of persisted state
 * (see `docs/subsystems/view-persistence.md`).
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

let consumed = false;
let value: string | null = null;

/**
 * The id this page was opened with, or null.
 *
 * Memoised, and the URL is stripped on the first call, so the two callers
 * (`AppShell` picking the section, `SessionsView` opening the drawer) see the
 * same answer no matter which renders first.
 */
export function deepLinkSession(): string | null {
  if (consumed) return value;
  consumed = true;
  value = readSessionParam(window.location.search);
  if (value) {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      /* older engines / file:// — the param staying put is harmless */
    }
  }
  return value;
}
