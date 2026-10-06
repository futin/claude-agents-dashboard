/** `GET /api/analytics` — three `/kaizen`-logged sessions from the week before EPOCH, newest first, each with a re-run analysis. */
import type { AnalyticsReport, AnalyticsResponse, SessionAnalysis, TokenTotals } from '../../../shared/types.js';

import { DAY, HOUR, MIN, agoIso } from './epoch.js';
import { HOME, PROJECTS } from './sessions.js';

function totals(input: number, output: number, cacheCreation: number, cacheRead: number): TokenTotals {
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    combined: input + output + cacheCreation + cacheRead,
    billableApprox: input + output + cacheCreation
  };
}

interface Spec {
  id: string;
  project: { name: string; path: string; dirName: string };
  model: string;
  daysAgo: number;
  hours: number;
  scale: number;
  lesson: string;
  status?: AnalyticsReport['lessonStatus'];
}

function report(s: Spec): AnalyticsReport {
  const t = totals(4_200 * s.scale, 61_000 * s.scale, 310_000 * s.scale, 8_900_000 * s.scale);
  const turns = Math.round(140 * s.scale);
  const tools: [string, number, number][] = [['Read', 48, 92_000], ['Bash', 61, 41_000], ['Edit', 33, 9_800], ['Grep', 22, 14_500], ['Task', 3, 6_200]];
  const analysis: SessionAnalysis = {
    id: s.id,
    file: `${HOME}/.claude/projects/${s.project.dirName}/${s.id}.jsonl`,
    cwd: s.project.path,
    models: [s.model],
    startedAt: agoIso(s.daysAgo * DAY + s.hours * HOUR),
    endedAt: agoIso(s.daysAgo * DAY),
    durationMs: s.hours * HOUR,
    totals: t,
    perTurn: {
      count: turns,
      avgCombined: Math.round(t.combined / turns),
      maxCombined: Math.round((t.combined / turns) * 2.1),
      maxTurnIndex: Math.round(turns * 0.8),
      neverCompacted: false
    },
    byTool: tools.map(([tool, count, resultTokens]) => ({
      tool,
      count: Math.round(count * s.scale),
      durationMs: Math.round(count * s.scale) * 2_400,
      errors: tool === 'Bash' ? Math.round(4 * s.scale) : 0,
      approxOutputTokens: Math.round(count * s.scale * 310),
      resultTokens: Math.round(resultTokens * s.scale)
    })),
    bySubagent: [
      {
        id: `toolu_${s.id.slice(0, 8)}_task1`,
        type: 'Explore',
        description: 'Survey the module',
        status: 'done',
        startedAt: agoIso(s.daysAgo * DAY + s.hours * HOUR - 10 * MIN),
        endedAt: agoIso(s.daysAgo * DAY + s.hours * HOUR - 13 * MIN),
        durationMs: 3 * MIN,
        tokens: 44_000,
        agentId: `${s.id.slice(0, 8)}a1`,
        toolUses: 17
      }
    ],
    subagentTotals: { count: 1, tokens: 412_000, usage: totals(1_100, 9_400, 52_000, 349_500), fallbackCount: 0, unknownTokenCount: 0 },
    serverTools: { webSearch: 0, webFetch: Math.round(2 * s.scale) },
    errorSignals: { toolErrors: Math.round(4 * s.scale), retries: Math.round(2 * s.scale), userCorrections: 1 },
    notes: ['cacheRead is replayed context, billed at ~10%.', 'Per-tool output tokens are approximate.']
  };
  return {
    sessionId: s.id,
    project: s.project.name,
    cwd: s.project.path,
    models: [s.model],
    loggedAt: agoIso(s.daysAgo * DAY).slice(0, 10),
    analysis,
    lesson: s.lesson,
    lessonStatus: s.status ?? null
  };
}

export const analytics: AnalyticsResponse = {
  generatedAt: agoIso(0),
  keep: 5,
  reports: [
    report({
      id: '0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a',
      project: PROJECTS.aurora,
      model: 'claude-opus-4-6',
      daysAgo: 1,
      hours: 3,
      scale: 1.3,
      lesson: 'Read narrowly: a whole-file Read of the router cost more than the fix.'
    }),
    report({
      id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6',
      project: PROJECTS.harbor,
      model: 'claude-sonnet-4-5-20250929',
      daysAgo: 3,
      hours: 2,
      scale: 0.7,
      lesson: 'Run the visual suite before claiming the layout fix is done.',
      status: { status: 'actioned', date: agoIso(2 * DAY).slice(0, 10), note: 'added to project CLAUDE.md' }
    }),
    report({
      id: '2f3e4d5c-6b7a-4890-8b1c-d2e3f4a5b6c7',
      project: PROJECTS.aurora,
      model: 'claude-opus-4-6',
      daysAgo: 6,
      hours: 5,
      scale: 2,
      lesson: 'Batch independent shell calls into one round-trip.',
      status: { status: 'promoted', date: agoIso(4 * DAY).slice(0, 10), note: 'raised to global config' }
    })
  ],
  lastReviewAt: agoIso(4 * DAY).slice(0, 10),
  reviewDue: false
};
