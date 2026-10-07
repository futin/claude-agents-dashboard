/** `GET /api/sessions` — four sessions, one per status, across two invented projects, all active at EPOCH. */
import type { Session, SessionsResponse } from '../../../shared/types.js';

import { account } from './account.js';
import { agoIso, ago, MIN, SEC } from './epoch.js';

export const HOME = '/Users/dev';

export const PROJECTS = {
  aurora: { name: 'aurora-api', path: `${HOME}/code/aurora-api`, dirName: '-Users-dev-code-aurora-api' },
  harbor: { name: 'harbor-web', path: `${HOME}/code/harbor-web`, dirName: '-Users-dev-code-harbor-web' }
} as const;

export const SESSION_IDS = {
  working: '3f2a9c4e-7b1d-4e8a-9c2f-5d6e7a8b9c01',
  idle: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e42',
  question: 'b7e6d5c4-3b2a-4190-8f7e-6d5c4b3a2913',
  incomplete: 'e1f2a3b4-c5d6-47e8-9f0a-1b2c3d4e5f64'
} as const;

function session(over: Partial<Session> & Pick<Session, 'id' | 'status' | 'model' | 'tokens' | 'contextWindow'>): Session {
  const project = over.project ?? PROJECTS.aurora.name;
  return {
    project,
    projectPath: project === PROJECTS.aurora.name ? PROJECTS.aurora.path : PROJECTS.harbor.path,
    sessionName: null,
    gitBranch: 'main',
    contextWindowLabel: over.contextWindow >= 1_000_000 ? `${over.contextWindow / 1_000_000}M` : `${Math.round(over.contextWindow / 1000)}k`,
    contextPct: Math.round((over.tokens / over.contextWindow) * 1000) / 10,
    surface: 'local',
    remoteQuestion: false,
    remotePlan: false,
    remoteReply: false,
    permissionWait: false,
    activity: null,
    lastTimestamp: agoIso(30 * SEC),
    updatedMs: ago(30 * SEC),
    version: '2.1.250',
    kaizenLesson: null,
    tasks: null,
    taskPlan: null,
    ...over
  };
}

const list: Session[] = [
  session({
    id: SESSION_IDS.working,
    status: 'working',
    project: PROJECTS.aurora.name,
    sessionName: 'Orders rate limiting',
    gitBranch: 'feat/orders-rate-limit',
    model: 'claude-opus-4-6',
    tokens: 142_000,
    contextWindow: 200_000,
    activity: { tool: 'Edit', detail: 'src/middleware/rateLimit.ts' },
    lastTimestamp: agoIso(4 * SEC),
    updatedMs: ago(4 * SEC),
    stopState: 'ready',
    surface: 'dashboard'
  }),
  session({
    id: SESSION_IDS.idle,
    status: 'idle',
    project: PROJECTS.aurora.name,
    gitBranch: 'main',
    model: 'claude-sonnet-4-5-20250929',
    tokens: 41_500,
    contextWindow: 200_000,
    lastTimestamp: agoIso(2 * MIN),
    updatedMs: ago(2 * MIN),
    kaizenLesson: 'Batch independent shell calls into one round-trip.'
  }),
  session({
    id: SESSION_IDS.question,
    status: 'question',
    project: PROJECTS.harbor.name,
    sessionName: 'Checkout redesign',
    gitBranch: 'feat/checkout-steps',
    model: 'claude-opus-4-6',
    tokens: 612_000,
    contextWindow: 1_000_000,
    activity: { tool: 'AskUserQuestion', detail: 'Which payment step layout should ship first?' },
    lastTimestamp: agoIso(45 * SEC),
    updatedMs: ago(45 * SEC)
  }),
  session({
    id: SESSION_IDS.incomplete,
    status: 'incomplete',
    project: PROJECTS.harbor.name,
    gitBranch: 'fix/nav-overflow',
    model: 'claude-haiku-4-5-20251001',
    tokens: 176_000,
    contextWindow: 200_000,
    activity: { tool: 'Bash', detail: 'pnpm test --filter nav' },
    lastTimestamp: agoIso(3 * MIN + 20 * SEC),
    updatedMs: ago(3 * MIN + 20 * SEC)
  })
];

export const sessions: SessionsResponse = {
  generatedAt: agoIso(0),
  activeWindowMin: 5,
  maxSessions: 5,
  runningClaudeProcs: 4,
  totals: { shown: list.length, active: list.length },
  sessions: list,
  launching: [],
  usage: account.usage,
  usageStatus: 'ok'
};
