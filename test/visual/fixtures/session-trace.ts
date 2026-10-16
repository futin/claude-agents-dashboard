/**
 * `GET /api/sessions/:id/trace` — the working session's causal trace: two turns on the rate-limiting task the chat fixture tells, from the first grep to a
 * question still waiting on the user. The chat fixture's tool lines carry the ids of the steps here (`TRACE_IDS`), so `why?` has somewhere to land.
 *
 * Every `at` is an absolute ISO string off `EPOCH`; the clock and zone are pinned, so the facts the inspector renders from them never move.
 */
import type { SessionTrace, TraceStep } from '../../../shared/types.js';

import { MIN, SEC, agoIso } from './epoch.js';
import { SESSION_IDS } from './sessions.js';

/** Ids the chat fixture's tool lines point at, one per line, in the order they appear there. */
export const TRACE_IDS = {
  grepRouter: 'toolu_01',
  readOrders: 'toolu_02',
  writeLimiter: 'toolu_06',
  editConfig: 'toolu_08',
  editLimiter: 'toolu_09'
} as const;

/** The two user prompts are the chat fixture's two user messages, so a prompt step's id is that message's uuid. */
export const PROMPT_IDS = {
  first: '5a1c0000-0b2d-4c3e-8f4a-6b7c8d9e0f10',
  second: '5a1c0003-0b2d-4c3e-8f4a-6b7c8d9e0f13'
} as const;

const FIRST_PROMPT = 'Add per-client rate limiting to the /v1/orders endpoint, 60 requests a minute.';
const SECOND_PROMPT = 'Make the limit configurable per environment.';

/** `at` for a step that landed `ms` before EPOCH. */
const at = (ms: number): string => agoIso(ms);

const steps: TraceStep[] = [
  { id: PROMPT_IDS.first, turn: 1, kind: 'prompt', tool: 'Prompt', detail: FIRST_PROMPT, intent: null, intentFrom: null, at: at(6 * MIN), status: null, result: null, why: [], thinking: null },
  {
    id: TRACE_IDS.grepRouter, turn: 1, kind: 'read', tool: 'Grep', detail: 'router.use', intent: 'Find where the orders router is mounted', intentFrom: 'text',
    at: at(5 * MIN + 40 * SEC), status: 'ok', result: '3 matches in 2 files', task: 'Token bucket store', why: [{ id: PROMPT_IDS.first, rel: 'asked' }], thinking: 'signature'
  },
  {
    id: TRACE_IDS.readOrders, turn: 1, kind: 'read', tool: 'Read', detail: 'src/routes/orders.ts', intent: 'The router that needs the limiter', intentFrom: 'text',
    at: at(5 * MIN + 35 * SEC), status: 'ok', result: '118 lines', task: 'Token bucket store',
    why: [{ id: TRACE_IDS.grepRouter, rel: 'informed' }], thinking: null
  },
  {
    id: 'toolu_03', turn: 1, kind: 'read', tool: 'Grep', detail: '"rateLimit|throttle"  src', intent: 'Check for an existing limiter before adding one', intentFrom: 'description',
    at: at(5 * MIN + 25 * SEC), status: 'ok', result: 'No matches found', task: 'Token bucket store', why: [{ id: PROMPT_IDS.first, rel: 'asked' }], thinking: null
  },
  {
    id: 'toolu_04', turn: 1, kind: 'agent', tool: 'Task · cavecrew-investigator', detail: 'find how API clients are identified per request',
    intent: 'Map client identity without reading every middleware here', intentFrom: 'description', at: at(5 * MIN), status: 'ok', result: '2 files · file:line table',
    task: 'Sliding window counter', why: [{ id: PROMPT_IDS.first, rel: 'asked' }], thinking: 'signature'
  },
  {
    id: 'toolu_04a', turn: 1, kind: 'read', tool: 'Grep', detail: '"x-api-key"  src', intent: null, intentFrom: null, agent: 'toolu_04',
    at: at(4 * MIN + 55 * SEC), status: 'ok', result: '4 matches', task: 'Sliding window counter', why: [{ id: 'toolu_04', rel: 'delegated' }], thinking: null
  },
  {
    id: 'toolu_04b', turn: 1, kind: 'read', tool: 'Read', detail: 'src/middleware/auth.ts', intent: null, intentFrom: null, agent: 'toolu_04',
    at: at(4 * MIN + 48 * SEC), status: 'ok', result: '74 lines', task: 'Sliding window counter', why: [{ id: 'toolu_04a', rel: 'informed' }], thinking: null
  },
  {
    id: 'toolu_05', turn: 1, kind: 'decide', tool: 'ExitPlanMode', detail: 'Token-bucket limiter on /v1/orders', intent: 'One bucket per client id, mounted before the router', intentFrom: 'text',
    at: at(4 * MIN), status: 'ok', result: 'approved', answer: 'approved', task: 'Middleware wiring',
    why: [{ id: PROMPT_IDS.first, rel: 'asked' }], thinking: 'text',
    thinkingText: 'Client identity is the x-api-key header, so the bucket key is that id. A token bucket allows a short burst without a second counter, and Retry-After falls out of the refill rate.'
  },
  {
    id: TRACE_IDS.writeLimiter, turn: 1, kind: 'edit', tool: 'Write', detail: 'src/middleware/rateLimit.ts', intent: 'A token-bucket middleware keyed on the client id', intentFrom: 'text',
    at: at(3 * MIN), status: 'ok', result: '1 file written · 52 lines', task: 'Middleware wiring', why: [{ id: 'toolu_05', rel: 'plan' }], thinking: 'signature'
  },
  { id: PROMPT_IDS.second, turn: 2, kind: 'prompt', tool: 'Prompt', detail: SECOND_PROMPT, intent: null, intentFrom: null, at: at(2 * MIN), status: null, result: null, why: [], thinking: null },
  {
    id: 'toolu_07', turn: 2, kind: 'read', tool: 'Read', detail: 'src/config.ts', intent: 'See how the other settings are read from the environment', intentFrom: 'text',
    at: at(1 * MIN + 52 * SEC), status: 'ok', result: '41 lines', task: 'Per-route limits', why: [{ id: PROMPT_IDS.second, rel: 'asked' }], thinking: null
  },
  {
    id: TRACE_IDS.editConfig, turn: 2, kind: 'edit', tool: 'Edit', detail: 'src/config.ts', intent: 'Read RATE_LIMIT_PER_MIN with 60 as the default', intentFrom: 'text',
    at: at(1 * MIN + 40 * SEC), status: 'ok', result: '1 replacement', task: 'Per-route limits',
    why: [{ id: 'toolu_07', rel: 'informed' }, { id: 'toolu_05', rel: 'plan' }], thinking: null
  },
  {
    id: TRACE_IDS.editLimiter, turn: 2, kind: 'edit', tool: 'Edit', detail: 'src/middleware/rateLimit.ts', intent: 'Take the limit from config instead of the constant', intentFrom: 'text',
    at: at(1 * MIN + 25 * SEC), status: 'ok', result: '1 replacement', task: 'Per-route limits',
    why: [{ id: 'toolu_05', rel: 'plan' }], thinking: null
  },
  {
    id: 'toolu_10', turn: 2, kind: 'bash', tool: 'Bash', detail: 'pnpm typecheck', intent: 'Typecheck the limiter against the new config field', intentFrom: 'description',
    at: at(1 * MIN + 10 * SEC), status: 'error', result: "src/middleware/rateLimit.ts(18,9): Property 'limitPerMin' does not exist on type 'Config'", task: 'Burst allowance',
    why: [{ id: TRACE_IDS.writeLimiter, rel: 'verifies' }, { id: TRACE_IDS.editConfig, rel: 'verifies' }, { id: TRACE_IDS.editLimiter, rel: 'verifies' }], thinking: 'signature'
  },
  {
    id: 'toolu_11', turn: 2, kind: 'edit', tool: 'Edit', detail: 'src/config.ts:12', intent: 'The field is named rateLimitPerMin there', intentFrom: 'text',
    at: at(1 * MIN), status: 'ok', result: '1 replacement', task: 'Burst allowance',
    why: [{ id: 'toolu_10', rel: 'retry' }, { id: 'toolu_07', rel: 'informed' }], thinking: null
  },
  {
    id: 'toolu_12', turn: 2, kind: 'bash', tool: 'Bash', detail: 'pnpm typecheck', intent: 'Typecheck again', intentFrom: 'description',
    at: at(50 * SEC), status: 'ok', result: 'no errors', task: 'Burst allowance', why: [{ id: 'toolu_11', rel: 'verifies' }], thinking: null
  },
  {
    id: 'toolu_13', turn: 2, kind: 'edit', tool: 'Write', detail: 'docs/subsystems/rate-limit.md', intent: 'Record the env var and the 429 contract', intentFrom: 'text',
    at: at(35 * SEC), status: 'ok', result: '1 file written · 38 lines', task: 'Retry-After header', why: [{ id: 'toolu_05', rel: 'plan' }], thinking: null
  },
  {
    id: 'toolu_14', turn: 2, kind: 'bash', tool: 'Bash', detail: 'git commit -m "feat(orders): per-client rate limit, configurable per env"',
    intent: 'Commit the limiter', intentFrom: 'description', at: at(25 * SEC), status: 'ok', result: '[main 5d21e08] 4 files changed', sha: '5d21e08', task: 'Retry-After header',
    why: [{ id: TRACE_IDS.writeLimiter, rel: 'commits' }, { id: TRACE_IDS.editConfig, rel: 'commits' }, { id: TRACE_IDS.editLimiter, rel: 'commits' },
      { id: 'toolu_11', rel: 'commits' }, { id: 'toolu_13', rel: 'commits' }], thinking: null
  },
  {
    id: 'toolu_15', turn: 2, kind: 'decide', tool: 'AskUserQuestion', detail: 'What should staging default to? · Which clients are exempt?',
    intent: 'The staging default is a product call, so ask instead of picking', intentFrom: 'text', at: at(10 * SEC), status: 'running', result: null,
    task: 'Metrics and alerts for throttled requests per tenant', why: [{ id: PROMPT_IDS.second, rel: 'asked' }], thinking: 'text',
    thinkingText: 'Production stays at 60, but a load test on staging would trip it at once. That is a trade-off between realism and noise, so ask, and ask about exempt clients in the same card.'
  }
];

export const sessionTrace: SessionTrace = {
  id: SESSION_IDS.working,
  steps,
  cursor: 19,
  epoch: 'visual-fixture',
  thinking: { recorded: 8, readable: 2 },
  dropped: 0
};
