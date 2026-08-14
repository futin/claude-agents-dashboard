import type { ConnectionOrigin } from '../../../shared/types';

/** Label + tooltip per route. Keep the labels short — this sits in a busy toolbar. */
const LABEL: Record<ConnectionOrigin, { text: string; title: string }> = {
  local: {
    text: 'local',
    title: 'You are on the machine running the dashboard (localhost).'
  },
  lan: {
    text: 'LAN',
    title: 'You reached this over the local network. The address changes when the network does.'
  },
  tailnet: {
    text: 'tailnet',
    title: 'You reached this over Tailscale — a private tailnet, stable from anywhere.'
  },
  unknown: {
    text: 'public',
    title: 'This request came from off-network (a public tunnel, or an address we can’t place). '
      + 'Every read endpoint is open — set ANSWER_TOKEN and consider auth at the edge.'
  }
};

/**
 * How the current browser reached the dashboard. Informational only — nothing
 * in the app gates on it (see server/lib/origin.ts).
 *
 * `public` is the one worth noticing, so it gets the warning tint. Absent origin
 * (health not loaded yet, or a server that predates the field) renders nothing.
 */
export function OriginBadge({ origin }: { origin?: ConnectionOrigin }) {
  if (!origin || !LABEL[origin]) return null;
  const { text, title } = LABEL[origin];
  return (
    <span className={`ra-pill off origin o-${origin}`} title={title}>
      <span className="ra-dot" />{text}
    </span>
  );
}
