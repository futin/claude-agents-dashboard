// The dashboard's Lookout hub widgets, served under /api/hub/widgets by lookout-widgets (docs/subsystems/hub-widgets.md).
import { createHubHandler, type GaugeBar, type HubHandler, type RowStatus, type WidgetDecl } from 'lookout-widgets';

import type { RepoGitStats, Session } from '../../shared/types.js';
import { scanSnapshot } from '../api.js';
import type { Config } from './config.js';
import { markGitWatched } from './git-fetch.js';
import { readGitStats } from './git-stats.js';
import { getCachedUsageState, type UsageState } from './usage.js';

export interface HubSources {
  usage?: () => UsageState;
  sessions?: () => Session[];
  git?: () => Promise<RepoGitStats[]>;
  /** Called on every `git` data read, so a placed tile keeps the fetch timer running the way an open Git view does. */
  watchGit?: () => void;
}

const STATUS: Record<Session['status'], RowStatus> = { working: 'running', question: 'warn', incomplete: 'error', idle: 'idle' };

function usageBars({ usage, status }: UsageState): { bars: GaugeBar[] } {
  if (usage === null || status !== 'ok') throw new Error(`usage ${status}`);
  const bars: GaugeBar[] = [];
  for (const [label, w] of [['5-hour', usage.fiveHour], ['Weekly', usage.sevenDay]] as const) {
    if (w.utilization === null) continue;
    bars.push(w.resetsAt === null ? { label, percent: w.utilization } : { label, percent: w.utilization, resetsAt: w.resetsAt });
  }
  if (bars.length === 0) throw new Error('usage has no windows');
  return { bars };
}

function sessionRow(s: Session) {
  const subtitle = [s.gitBranch, s.model, `ctx ${Math.round(s.contextPct)}%`].filter((p): p is string => p !== null).join(' · ');
  return { id: s.id, title: s.sessionName ?? s.project, subtitle, status: STATUS[s.status], open: `/?session=${encodeURIComponent(s.id)}` };
}

type GitRow = { id: string; title: string; subtitle: string; status: RowStatus; open: string };

const GIT_OPEN = '/?view=git';

function unreadableReason(r: Exclude<RepoGitStats, { state: 'ok' }>): string {
  if (r.state === 'missing') return 'folder missing';
  if (r.state === 'not-git') return 'not a git repo';
  return /timed out/.test(r.message) ? 'timed out' : 'git error';
}

/**
 * One row per pinned repo with something to commit, push or pull, plus one per repo the reader could not read; clean repos are left out. Ahead and behind
 * add the local trunk against `origin/<trunk>` to the current branch against its upstream. An upstream of `origin/<trunk>` (that is "unmerged", not
 * "unpushed") and a gone upstream count for nothing, as in the Git view's triage rule. Rows go pull (warn), then commit/push (running), then unreadable
 * (error), each group in pin order, so a small tile's first rows are the most urgent.
 */
export function gitPendingRows(repos: RepoGitStats[]): GitRow[] {
  const pull: GitRow[] = [], push: GitRow[] = [], bad: GitRow[] = [];
  for (const r of repos) {
    const row = { id: r.dirName, title: r.name, open: GIT_OPEN };
    if (r.state !== 'ok') {
      bad.push({ ...row, subtitle: unreadableReason(r), status: 'error' });
      continue;
    }
    let ahead = r.trunkVsOrigin?.ahead ?? 0, behind = r.trunkVsOrigin?.behind ?? 0;
    const up = r.currentVsUpstream;
    if (up && up.counts && !(r.trunk !== null && up.upstream === `origin/${r.trunk}`)) {
      ahead += up.counts.ahead;
      behind += up.counts.behind;
    }
    const parts = [r.uncommitted > 0 ? `${r.uncommitted} changed` : null, ahead > 0 ? `↑${ahead}` : null, behind > 0 ? `↓${behind}` : null];
    const subtitle = parts.filter((p): p is string => p !== null).join(' · ');
    if (subtitle === '') continue;
    if (behind > 0) pull.push({ ...row, subtitle, status: 'warn' });
    else push.push({ ...row, subtitle, status: 'running' });
  }
  return [...pull, ...push, ...bad];
}

/** Getters default to the live usage cache and a fresh session scan; tests inject fixtures. */
export function createDashboardHub(config: Config, sources: HubSources = {}): HubHandler {
  const usage = sources.usage ?? getCachedUsageState;
  const sessions = sources.sessions ?? (() => scanSnapshot(config).sessions);
  const git = sources.git ?? (async () => (await readGitStats(config)).repos);
  const watchGit = sources.watchGit ?? markGitWatched;
  const widgets: WidgetDecl[] = [];
  if (config.showUsage) widgets.push({ id: 'usage', title: 'Claude usage', render: 'gauge', refreshSeconds: 60, load: () => usageBars(usage()) });
  widgets.push({ id: 'sessions', title: 'Sessions', render: 'list', refreshSeconds: 10, open: '/', load: () => ({ rows: sessions().map(sessionRow) }) });
  widgets.push({
    id: 'git', title: 'Git pending', render: 'list', refreshSeconds: 30, open: GIT_OPEN,
    load: async () => {
      watchGit();
      return { rows: gitPendingRows(await git()) };
    }
  });
  return createHubHandler({ app: { name: 'Claude Agents Dashboard' }, widgets });
}
