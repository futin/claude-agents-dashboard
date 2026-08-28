/**
 * The three answer endpoints, driven through the real route table:
 * `POST /api/sessions/:id/answer`, `.../plan-answer`, `.../message-answer`.
 *
 * All three are a gate stack over a four-way switch, and the switch is the
 * point: `ok` → 200, `not-found` → 404, `mismatch` → 409, anything else → 400.
 * `not-found` and `mismatch` are the pair that matters and the pair most easily
 * collapsed — "no question is waiting" tells the UI to close the panel, while
 * "that question is no longer the one waiting" tells it to reload and show the
 * newer one. Merging them (or answering 404 for both) silently loses a
 * question the user is still looking at, and no unit test of `pending.answer`
 * can see it because that function returns strings, not status codes.
 *
 * Also covered here: the route-order rule that `:id/answer` and its siblings
 * must be matched before the bare `:id` detail route.
 */

import assert from 'node:assert';

import { testAsync, until, withServer } from './api-harness.js';
import type { Harness } from './api-harness.js';
import { messageSessionIds } from '../server/lib/messages.js';
import { pendingSessionIds } from '../server/lib/pending.js';
import { planSessionIds } from '../server/lib/plans.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

const QUESTION_INPUT = {
  questions: [{ header: 'Pick', question: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] }]
};
const PLAN_INPUT = { plan: '## Plan\n\nDo the thing.' };

/**
 * One row per answer endpoint: how to get a wait held, what its live id field
 * is called, a body that answers it, and the error strings the switch emits.
 * The three handlers are the same shape, so the cases are written once and run
 * three times — a divergence in any one of them shows up as that row failing.
 */
interface Endpoint {
  name: string;
  route: string;
  /** Hold a wait for `ID` and return its live id (questionId / planId / messageId). */
  hold(h: Harness): Promise<{ id: string; abort(): void }>;
  /** Is a wait currently held for `ID`? */
  held(): boolean;
  /** A body that answers the wait, given its live id. */
  goodBody(id: string): unknown;
  /** A body whose id is well-formed but stale. */
  staleBody(): unknown;
  /** A body that reaches the switch and is refused by it. */
  malformedBody(id: string): unknown;
  notFound: string;
  mismatch: string;
  badAnswer: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    name: 'answer',
    route: `/api/sessions/${ID}/answer`,
    async hold(h) {
      const open = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID), 'the question wait registers');
      const pending = (await h.req(`/api/sessions/${ID}/question`)).json?.pending as { questionId: string };
      return { id: pending.questionId, abort: () => open.abort() };
    },
    held: () => pendingSessionIds().has(ID),
    goodBody: id => ({ questionId: id, answers: [{ index: 0, selected: ['left'] }] }),
    staleBody: () => ({ questionId: 'a-question-that-was-superseded' }),
    // Right id, but the answers do not match the questions — `validateAnswer`
    // returns 'malformed', which is the switch's default arm.
    malformedBody: id => ({ questionId: id, answers: [] }),
    notFound: 'no question is waiting',
    mismatch: 'that question is no longer the one waiting',
    badAnswer: 'bad answer'
  },
  {
    name: 'plan-answer',
    route: `/api/sessions/${ID}/plan-answer`,
    async hold(h) {
      const open = h.open('/api/plans/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: PLAN_INPUT, timeoutMs: 600_000 })
      });
      await until(() => planSessionIds().has(ID), 'the plan wait registers');
      const pending = (await h.req(`/api/sessions/${ID}/plan`)).json?.pending as { planId: string };
      return { id: pending.planId, abort: () => open.abort() };
    },
    held: () => planSessionIds().has(ID),
    goodBody: id => ({ planId: id, verdict: 'reject', feedback: 'try the other approach' }),
    staleBody: () => ({ planId: 'a-plan-that-was-superseded' }),
    // A reject with no feedback: the store refuses it, because a bare "no"
    // gives the model nothing to revise against.
    malformedBody: id => ({ planId: id, verdict: 'reject', feedback: '   ' }),
    notFound: 'no plan is waiting',
    mismatch: 'that plan is no longer the one waiting',
    badAnswer: 'bad verdict'
  },
  {
    name: 'message-answer',
    route: `/api/sessions/${ID}/message-answer`,
    async hold(h) {
      const open = h.open('/api/messages/wait', {
        body: JSON.stringify({ sessionId: ID, timeoutMs: 600_000 })
      });
      await until(() => messageSessionIds().has(ID), 'the message wait registers');
      const pending = (await h.req(`/api/sessions/${ID}/message`)).json?.pending as { messageId: string };
      return { id: pending.messageId, abort: () => open.abort() };
    },
    held: () => messageSessionIds().has(ID),
    goodBody: id => ({ messageId: id, text: 'one more thing' }),
    staleBody: () => ({ messageId: 'a-window-that-already-closed' }),
    malformedBody: id => ({ messageId: id, text: '   ' }),
    notFound: 'no reply window is open',
    mismatch: 'that window is no longer the one open',
    badAnswer: 'bad message'
  }
];

export async function run(): Promise<number> {
  console.log('\n=== answer endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  for (const ep of ENDPOINTS) {
    check(await testAsync(`${ep.name}: 'ok' → 200 and the wait is released`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const wait = await ep.hold(h);
        const reply = await h.req(ep.route, { method: 'POST', body: JSON.stringify(ep.goodBody(wait.id)) });
        assert.equal(reply.status, 200);
        assert.equal(reply.json?.ok, true);
        assert.equal(ep.held(), false, 'answering must clear the store entry');
        wait.abort();
      });
    }));

    check(await testAsync(`${ep.name}: 'not-found' → 404 when nothing is waiting`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const reply = await h.req(ep.route, { method: 'POST', body: JSON.stringify(ep.staleBody()) });
        assert.equal(reply.status, 404);
        assert.equal(reply.json?.error, ep.notFound);
      });
    }));

    check(await testAsync(`${ep.name}: 'mismatch' → 409, distinct from the 404`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const wait = await ep.hold(h);
        const reply = await h.req(ep.route, { method: 'POST', body: JSON.stringify(ep.staleBody()) });
        // Same request body as the 404 case above; the only difference is that
        // a wait *is* held. Collapsing these two loses a live question.
        assert.equal(reply.status, 409, 'a stale id against a live wait is a conflict, not a miss');
        assert.equal(reply.json?.error, ep.mismatch);
        assert.equal(ep.held(), true, 'a mismatched answer must not release the wait');
        wait.abort();
      });
    }));

    check(await testAsync(`${ep.name}: the switch default → 400`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const wait = await ep.hold(h);
        const reply = await h.req(ep.route, { method: 'POST', body: JSON.stringify(ep.malformedBody(wait.id)) });
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error, ep.badAnswer);
        assert.equal(ep.held(), true, 'a refused answer leaves the wait for a second attempt');
        wait.abort();
      });
    }));

    check(await testAsync(`${ep.name}: a non-JSON body is 400 "bad body", not a throw`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const reply = await h.req(ep.route, { method: 'POST', body: '{not json' });
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error, 'bad body');
      });
    }));

    check(await testAsync(`${ep.name}: REMOTE_ANSWER=false is 404 before the body is read`, async () => {
      await withServer(`${ENV}REMOTE_ANSWER=false\n`, async h => {
        h.plant(ID);
        const reply = await h.req(ep.route, { method: 'POST', body: '{not json' });
        assert.equal(reply.status, 404);
        assert.equal(reply.json?.error, 'remote answers disabled');
      });
    }));

    check(await testAsync(`${ep.name}: a bad token is 403`, async () => {
      await withServer(`${ENV}ANSWER_TOKEN=s3cret\n`, async h => {
        h.plant(ID);
        const reply = await h.req(ep.route, {
          method: 'POST', body: '{not json', headers: { Authorization: 'Bearer wrong' }
        });
        assert.equal(reply.status, 403);
        assert.equal(reply.json?.error, 'bad token');
      });
    }));

    check(await testAsync(`${ep.name}: an id that fails ID_RE is 400 "bad id"`, async () => {
      await withServer(ENV, async h => {
        const reply = await h.req(ep.route.replace(ID, 'not$valid'), {
          method: 'POST', body: JSON.stringify({})
        });
        assert.equal(reply.status, 400);
        assert.equal(reply.json?.error, 'bad id');
      });
    }));

    check(await testAsync(`${ep.name}: GET is 405, and the route beats the bare :id detail route`, async () => {
      await withServer(ENV, async h => {
        h.plant(ID);
        const reply = await h.req(ep.route);
        // If the detail regex had swallowed this path it would answer 200 with
        // an agents array instead — the route-order trap `index.ts` documents.
        assert.equal(reply.status, 405);
        assert.equal(reply.json?.error, 'method not allowed');
      });
    }));
  }

  /* ------------------------------------------------------ the toggle nuance */

  check(await testAsync('the answer routes gate on the env flag, not the runtime toggle', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      // `serveSessionAnswer` reads `config.remoteAnswer` while the wait routes
      // read `getState(config).remoteAnswer`. So with the runtime toggle off
      // but the env flag on, a wait registered before the flip can still be
      // answered — the deliberate asymmetry that lets the toggle release held
      // waits rather than strand them. Pinned here so a "consistency" refactor
      // has to be a decision.
      const open = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID), 'the question wait registers');

      const off = await h.req('/api/remote-answer', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      assert.equal(off.status, 200);
      // The flip dismissed the held wait, so the answer route now reports the
      // *store's* verdict (404 no question is waiting) rather than the gate's
      // "remote answers disabled" — i.e. it got past the gate.
      const reply = await h.req(`/api/sessions/${ID}/answer`, {
        method: 'POST', body: JSON.stringify({ questionId: 'anything' })
      });
      assert.equal(reply.status, 404);
      assert.equal(reply.json?.error, 'no question is waiting', 'the gate is the env flag, and it is on');
      open.abort();
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
