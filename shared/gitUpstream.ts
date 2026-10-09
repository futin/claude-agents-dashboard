/**
 * gitUpstream.ts — which upstream counts the Git view and Lookout's Git pending tile both read (zero deps). Shared so the board's chip and triage
 * (`client/src/lib/gitStatsText.ts`) and the hub widget (`server/lib/hub-widgets.ts`) cannot disagree about the same repo.
 */
import type { RepoGitStats } from './types.js';

type OkRepo = Extract<RepoGitStats, { state: 'ok' }>;

/**
 * The current branch's upstream facts the page draws, or null when there is nothing to say: the field is absent (an older server), null, level (0 / 0),
 * or the upstream is `origin/<trunk>` — that branch's own row already shows the same numbers against the same base. The chip and the Triage rule both read
 * this, so they never disagree.
 */
export function gitUpstreamShown(r: OkRepo): NonNullable<OkRepo['currentVsUpstream']> | null {
  const u = r.currentVsUpstream;
  if (u === undefined || u === null) return null;
  if (u.counts !== null && u.counts.ahead === 0 && u.counts.behind === 0) return null;
  if (r.trunk !== null && u.upstream === `origin/${r.trunk}`) return null;
  return u;
}
