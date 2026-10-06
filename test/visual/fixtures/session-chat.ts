/** `GET /api/sessions/:id/chat` — the working session's tail: a short exchange about rate limiting, oldest first, no history above it. */
import type { ChatMessage, SessionChat } from '../../../shared/types.js';

import { MIN, SEC, agoIso } from './epoch.js';
import { SESSION_IDS } from './sessions.js';

/** The first message's text — what a test looks for to prove the drawer opened on this fixture. */
export const FIXTURE_FIRST_MESSAGE = 'Add per-client rate limiting to the /v1/orders endpoint, 60 requests a minute.';

const messages: ChatMessage[] = [
  { role: 'user', at: 6 * MIN, text: FIXTURE_FIRST_MESSAGE, tools: [] },
  {
    role: 'assistant',
    at: 5 * MIN + 40 * SEC,
    text: "I'll look at how the orders router is mounted and whether there's existing middleware to hang a limiter on.",
    tools: [
      { name: 'Grep', detail: 'router.use' },
      { name: 'Read', detail: 'src/routes/orders.ts' }
    ]
  },
  {
    role: 'assistant',
    at: 3 * MIN,
    text: 'There is no limiter yet. I will add a token-bucket middleware keyed on the API client id, with a `Retry-After` header on 429.',
    tools: [{ name: 'Write', detail: 'src/middleware/rateLimit.ts' }]
  },
  { role: 'user', at: 2 * MIN, text: 'Make the limit configurable per environment.', tools: [] },
  {
    role: 'assistant',
    at: 4 * SEC,
    text: 'Reading `RATE_LIMIT_PER_MIN` from config with 60 as the default, and wiring it into the middleware now.',
    tools: [
      { name: 'Edit', detail: 'src/config.ts' },
      { name: 'Edit', detail: 'src/middleware/rateLimit.ts' }
    ]
  }
].map((m, i) => ({
  uuid: `5a1c${String(i).padStart(4, '0')}-0b2d-4c3e-8f4a-6b7c8d9e0f1${i}`,
  role: m.role as ChatMessage['role'],
  ts: agoIso(m.at),
  text: m.text,
  textTruncated: false,
  tools: m.tools
}));

export const sessionChat: SessionChat = {
  id: SESSION_IDS.working,
  messages,
  cursor: 48_210,
  headOffset: 0,
  hasMore: false
};
