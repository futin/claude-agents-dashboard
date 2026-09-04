/**
 * focus.ts — the pending-focus slot behind a tapped desk notification.
 *
 * A desk push carries `Click: <localUrl>/api/focus?session=<id>` rather than the
 * dashboard route, because ntfy's service worker hardcodes
 * `clients.openWindow()` for a click URL — every tap is a new tab, and no
 * upstream ntfy fix could change that (`clients.matchAll()` is same-origin by
 * spec, so ntfy.sh's worker can never see a tab on this dashboard's origin).
 *
 * So the tab ntfy opens is a throwaway: it tells this store which session you
 * tapped, the dashboard tab you already had open claims it on its next
 * `/api/focus/pending` poll, and the throwaway then closes itself. The handoff is
 * server-side rather than `BroadcastChannel` precisely because the two tabs may
 * not share an origin — in dev the client is on 5174 and the API on 4173.
 *
 * Nothing here guesses whether a dashboard is open. The throwaway page watches
 * whether its own tap gets claimed and decides from that — see
 * {@link focusPageHtml}.
 *
 * RAM only. A restart dropping a two-minute-old tap is correct, and it is the
 * posture `permissions.ts` and `spawn.ts` already take.
 *
 * See `docs/subsystems/push-notify.md`.
 */

/**
 * How long a tap stays claimable.
 *
 * The consumer is the `/api/sessions` poll, whose interval is per-device and
 * clamped to a **60s maximum** (`client/src/lib/settings.ts` `LIMITS.refreshMs`),
 * so any value at or under 60s would silently drop the tap for someone on the
 * slowest setting. 120s clears that with room and is still short enough that a
 * tap you thought better of cannot ambush you later.
 */
export const FOCUS_TTL_MS = 120_000;

/**
 * How long the throwaway page waits for a dashboard to claim its tap before
 * giving up and becoming the dashboard itself.
 *
 * Comfortably over `useFocusWatch`'s fixed 3s poll — that interval is its own
 * constant and deliberately not the user-tunable `refreshMs`, so this does not
 * have to cover the 60s ceiling that `FOCUS_TTL_MS` does.
 */
export const PAGE_WAIT_MS = 5000;

let pending: { id: string; atMs: number } | null = null;

/**
 * Record a tapped session. A second tap replaces the first rather than queueing:
 * two taps in a row mean you want the second one, and a queue would open a
 * drawer you have already moved past.
 *
 * `nowMs` exists so the expiry tests need not sleep. Production passes nothing.
 */
export function requestFocus(sessionId: string, nowMs: number = Date.now()): void {
  pending = { id: sessionId, atMs: nowMs };
}

/**
 * The tapped session, once. Clears the slot either way, so a stale entry cannot
 * survive to be served on a later poll.
 */
export function takeFocus(nowMs: number = Date.now()): string | null {
  const entry = pending;
  pending = null;
  if (!entry) return null;
  return nowMs - entry.atMs < FOCUS_TTL_MS ? entry.id : null;
}

/**
 * Is a tap still waiting to be claimed? Does **not** consume it.
 *
 * The throwaway page polls this to find out whether a real dashboard picked its
 * tap up. That is a fact; the alternative was guessing from "has anything polled
 * recently", which fails precisely when this feature matters — a desk push is
 * sent because you are *not* looking at the dashboard, and Chrome throttles a
 * hidden tab's timers to once a minute after five minutes and can freeze it
 * outright. The guess said "no dashboard open" and opened a second one.
 */
export function focusPending(nowMs: number = Date.now()): boolean {
  return pending !== null && nowMs - pending.atMs < FOCUS_TTL_MS;
}

/** Test seam: drop the pending slot. */
export function resetFocus(): void {
  pending = null;
}

/**
 * The throwaway tab's page. It decides its own fate, which is the point.
 *
 * It polls {@link focusPending} and branches on the answer:
 *  - **claimed** → a real dashboard tab picked the tap up, so close.
 *  - **still pending after {@link PAGE_WAIT_MS}** → nothing is going to claim it,
 *    so navigate to the dashboard and *become* the dashboard.
 *
 * That replaces a server-side guess ("has anything polled in the last 90s") that
 * was wrong in the one case that matters — see {@link focusPending}. The page
 * observes the actual outcome instead, so it is right in both directions and
 * needs no timing heuristic.
 *
 * `window.close()` is permitted here because the tab `clients.openWindow()`
 * creates has a single history entry and no opener, which satisfies Blink's rule
 * (`LocalDOMWindow::close`: closable when opened by DOM **or** the back/forward
 * list has one entry). Confirmed in the user's own Chrome on 2026-09-04 via a
 * beacon from a real openWindow tab. The message fallback covers an engine that
 * refuses anyway.
 *
 * The id is interpolated, unlike the earlier static version, because the
 * navigate branch needs it. `serveFocus` shape-checks it against `SESSION_ID_RE`
 * (hex and dashes only) before we ever get here, but this escapes `<` anyway:
 * `JSON.stringify` handles quotes and backslashes and **not** `</script>`, which
 * ends the element from inside a perfectly valid string literal. Depending on a
 * caller's validation for that is how the next caller introduces the hole.
 */
export function focusPageHtml(sessionId: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Opening on the dashboard</title>
<body style="font:14px system-ui;padding:2rem;color:#888">
<p id="m">Opening on the dashboard&hellip;</p>
<script>
var SID = ${JSON.stringify(sessionId).replace(/</g, '\\u003c')};
var deadline = Date.now() + ${PAGE_WAIT_MS};
function giveUp() { location.replace('/?session=' + encodeURIComponent(SID)); }
function check() {
  fetch('/api/focus/claimed').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.pending) {
      window.close();
      setTimeout(function () {
        document.getElementById('m').textContent = 'You can close this tab.';
      }, 600);
      return;
    }
    if (Date.now() > deadline) return giveUp();
    setTimeout(check, 300);
  }).catch(giveUp);
}
check();
</script>
`;
}
