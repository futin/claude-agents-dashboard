/**
 * releases.ts — the one thing about the version chip and the What's new drawer that is this app's own rather than ui-kit's: the `localStorage` key the
 * unseen dot is kept under. It predates ui-kit and stays as it was, so no viewer's dot state resets (docs/subsystems/releases.md).
 */
export const LAST_SEEN_KEY = 'dashboard.releases.lastSeen';
