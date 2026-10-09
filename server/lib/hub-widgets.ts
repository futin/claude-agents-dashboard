// The dashboard's Lookout hub widgets, served under /api/hub/widgets by lookout-widgets (docs/subsystems/hub-widgets.md).
import { createHubHandler, type GaugeBar, type HubHandler, type RowStatus, type WidgetDecl } from 'lookout-widgets';

import type { Session } from '../../shared/types.js';
import { scanSnapshot } from '../api.js';
import type { Config } from './config.js';
import { getCachedUsageState, type UsageState } from './usage.js';

export interface HubSources {
  usage?: () => UsageState;
  sessions?: () => Session[];
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

/** Getters default to the live usage cache and a fresh session scan; tests inject fixtures. */
export function createDashboardHub(config: Config, sources: HubSources = {}): HubHandler {
  const usage = sources.usage ?? getCachedUsageState;
  const sessions = sources.sessions ?? (() => scanSnapshot(config).sessions);
  const widgets: WidgetDecl[] = [];
  if (config.showUsage) widgets.push({ id: 'usage', title: 'Claude usage', render: 'gauge', refreshSeconds: 60, load: () => usageBars(usage()) });
  widgets.push({ id: 'sessions', title: 'Sessions', render: 'list', refreshSeconds: 10, open: '/', load: () => ({ rows: sessions().map(sessionRow) }) });
  return createHubHandler({ app: { name: 'Claude Agents Dashboard' }, widgets });
}
