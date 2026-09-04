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
 * tapped, the dashboard tab you already had open picks it up on its next
 * `/api/sessions` poll, and the throwaway closes itself. The handoff is
 * server-side rather than `BroadcastChannel` precisely because the two tabs may
 * not share an origin — in dev the client is on 5174 and the API on 4173.
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
 * How recently `/api/sessions` must have been polled for a dashboard tab to
 * count as open. Same 60s clamp as above, plus 30s for one dropped tick.
 *
 * A phone polling from the couch also counts, which is the known imprecision
 * here: it would take the record-and-close branch when no desktop tab is open.
 * Harmless — the desk push only goes out when the HID idle reading says you are
 * at this machine.
 */
export const POLL_FRESH_MS = 90_000;

let pending: { id: string; atMs: number } | null = null;
/**
 * Sentinel, not `0`: a poll whose clock reads 0 is still a poll, and the tests
 * drive these from a zero base. `-Infinity` makes "never polled" unreachable by
 * any real timestamp instead of colliding with one.
 */
let lastPollMs = Number.NEGATIVE_INFINITY;

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

/** Called by `serveSessions` on every poll — the "a dashboard is watching" signal. */
export function notePoll(nowMs: number = Date.now()): void {
  lastPollMs = nowMs;
}

/**
 * Is something polling the session list right now?
 *
 * False on a fresh process by construction (`lastPollMs` starts at `-Infinity`),
 * which is what makes the redirect branch testable without waiting out
 * `POLL_FRESH_MS` — restart the server and nothing has polled.
 */
export function dashboardOpen(nowMs: number = Date.now()): boolean {
  return nowMs - lastPollMs < POLL_FRESH_MS;
}

/** Test seam: drop both timestamps. */
export function resetFocus(): void {
  pending = null;
  lastPollMs = Number.NEGATIVE_INFINITY;
}

/**
 * The throwaway tab's page.
 *
 * Static — no session id is interpolated, so there is no escaping question and
 * one constant serves every request. It carries no label and no session id for
 * the same reason: anything that could reach the endpoint can read this page.
 *
 * `window.close()` is permitted here because the tab `clients.openWindow()`
 * creates has a single history entry and no opener, which satisfies Blink's rule
 * (`LocalDOMWindow::close`: closable when opened by DOM **or** the back/forward
 * list has one entry). Verified 2026-09-04 — see task-17's `### Task 1 result`.
 * The 500ms fallback covers an engine that refuses anyway; the deep link has
 * already landed in the real dashboard tab by then either way.
 */
export function focusPageHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Opening on the dashboard</title>
<body style="font:14px system-ui;padding:2rem;color:#888">
<p id="m">Opening on the dashboard&hellip;</p>
<script>
window.close();
setTimeout(function () {
  document.getElementById('m').textContent = 'You can close this tab.';
}, 500);
</script>
`;
}
