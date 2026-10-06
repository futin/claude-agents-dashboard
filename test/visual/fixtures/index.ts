/** Every `/api` GET the built client issues, mapped to its fixture body. POSTs (and `/api/git-fetch`) are deliberately absent: mock-api refuses writes. */
import type { FixtureMap } from '../mock-api.js';

import { account } from './account.js';
import { analytics } from './analytics.js';
import { configs } from './configs.js';
import { configsFile } from './configs-file.js';
import { configsProject } from './configs-project.js';
import { gitStats } from './git-stats.js';
import { health } from './health.js';
import { pins } from './pins.js';
import { sessionChat } from './session-chat.js';
import { sessionDetail } from './session-detail.js';
import { sessionMessage } from './session-message.js';
import { sessionPlan } from './session-plan.js';
import { sessionQuestion } from './session-question.js';
import { SESSION_IDS, sessions } from './sessions.js';
import { settings } from './settings.js';
import { usageHistory } from './usage-history.js';
import { usageProfile } from './usage-profile.js';
import { usageRates } from './usage-rates.js';

export { FIXTURE_FIRST_MESSAGE } from './session-chat.js';

/** The working session — the one whose chat and subagents the per-session fixtures describe. */
export const FIXTURE_SESSION_ID: string = SESSION_IDS.working;

export const fixtures: FixtureMap = {
  '/api/sessions': sessions,
  '/api/sessions/:id': sessionDetail,
  // The tail poll (`?after=<cursor>`) appends what it gets; answering it with the first page again would grow the drawer every 3s.
  '/api/sessions/:id/chat': (url: URL) => url.searchParams.has('after') ? { ...sessionChat, messages: [] } : sessionChat,
  '/api/sessions/:id/plan': sessionPlan,
  '/api/sessions/:id/message': sessionMessage,
  '/api/sessions/:id/question': sessionQuestion,
  '/api/account': account,
  '/api/usage/profile': usageProfile,
  '/api/usage/rates': usageRates,
  '/api/usage/history': usageHistory,
  '/api/settings': settings,
  '/api/analytics': analytics,
  '/api/health': health,
  '/api/pins': pins,
  '/api/configs': configs,
  '/api/configs/project': configsProject,
  '/api/configs/file': configsFile,
  '/api/git-stats': gitStats
};
