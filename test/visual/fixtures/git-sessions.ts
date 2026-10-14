/**
 * `GET /api/sessions` for the Git shots only: the shared four sessions plus an idle one on lumen-cli's release branch, so the sessions join shows
 * working (aurora), waiting (harbor) and idle (lumen) chips. Git-only, so the Sessions shots keep their four rows.
 */
import type { SessionsResponse } from '../../../shared/types.js';

import { MIN, ago, agoIso } from './epoch.js';
import { sessions } from './sessions.js';

const idle = sessions.sessions.find((s) => s.status === 'idle')!;

const lumenIdle = {
  ...idle,
  id: 'c0ffee00-1111-4222-8333-444455556666',
  project: 'lumen-cli',
  projectPath: '/Users/dev/code/lumen-cli',
  gitBranch: 'release/2.4',
  sessionName: null,
  tasks: null,
  taskPlan: null,
  updatedMs: ago(40 * MIN),
  lastTimestamp: agoIso(40 * MIN)
};

export const gitSessions: SessionsResponse = { ...sessions, sessions: [...sessions.sessions, lumenIdle] };
