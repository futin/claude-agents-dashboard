/**
 * The three hold-and-wait endpoints, driven through the real route table:
 * `POST /api/questions/wait`, `POST /api/plans/wait`, `POST /api/messages/wait`.
 *
 * These are the endpoints a Claude Code hook blocks on, so every rejection here
 * is load-bearing in a way a normal 4xx is not: any non-200 makes the hook exit
 * 0 and the terminal dialog appear, while a *silently registered* wait that
 * nobody will ever answer parks a real session for up to its full deadline.
 * The two failure modes this file exists for are therefore:
 *
 *   1. a gate that lets a request through when it should not (toggle off, bad
 *      token, bad id, unknown session), and
 *   2. a hold that outlives its client — `res.on('close')` not firing, or
 *      firing against a stale id.
 *
 * Every registration assertion reads the store directly (`pendingSessionIds`
 * and friends) rather than inferring from the response, because "refused
 * without registering" and "registered, then answered with an error" look
 * identical from the client side.
 */

import assert from 'node:assert';

import { testAsync, until, withServer } from './api-harness.js';
import { messageSessionIds } from '../server/lib/messages.js';
import { pendingSessionIds } from '../server/lib/pending.js';
import { planSessionIds } from '../server/lib/plans.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ENV = 'SHOW_USAGE=false\nSKIP_PROC_SCAN=true\n';

/** A `toolInput` `sanitizeQuestions` accepts. */
const QUESTION_INPUT = {
  questions: [{ header: 'Pick', question: 'Which way?', options: [{ label: 'left' }, { label: 'right' }] }]
};
/** A `toolInput` `sanitizePlan` accepts. */
const PLAN_INPUT = { plan: '## Plan\n\nDo the thing.' };

/** No wait may be held by any store — the state every case starts and ends in. */
function assertNothingHeld(where: string): void {
  assert.equal(pendingSessionIds().size, 0, `${where}: a question wait was registered`);
  assert.equal(planSessionIds().size, 0, `${where}: a plan wait was registered`);
  assert.equal(messageSessionIds().size, 0, `${where}: a message wait was registered`);
}

export async function run(): Promise<number> {
  console.log('\n=== wait endpoints (api.ts via the router) ===\n');
  let ok = 0, total = 0;
  const check = (r: boolean): void => { total++; if (r) ok++; };

  /* ------------------------------------------------------------- the gates */

  check(await testAsync('REMOTE_ANSWER=false: all three waits are 404 and register nothing', async () => {
    await withServer(`${ENV}REMOTE_ANSWER=false\n`, async h => {
      h.plant(ID);
      const cases: Array<[string, unknown]> = [
        ['/api/questions/wait', { sessionId: ID, toolInput: QUESTION_INPUT }],
        ['/api/plans/wait', { sessionId: ID, toolInput: PLAN_INPUT }],
        ['/api/messages/wait', { sessionId: ID }]
      ];
      for (const [route, body] of cases) {
        const reply = await h.req(route, { method: 'POST', body: JSON.stringify(body) });
        assert.equal(reply.status, 404, `${route} must refuse`);
        assert.equal(reply.json?.error, 'remote answers disabled');
      }
      // The claim is not just the status code: a registered-then-404'd wait
      // would strand the hook for its whole deadline.
      assertNothingHeld('toggle off');
    });
  }));

  check(await testAsync('a bad ANSWER_TOKEN is 403 on all three, and registers nothing', async () => {
    await withServer(`${ENV}ANSWER_TOKEN=s3cret\n`, async h => {
      h.plant(ID);
      const cases: Array<[string, unknown]> = [
        ['/api/questions/wait', { sessionId: ID, toolInput: QUESTION_INPUT }],
        ['/api/plans/wait', { sessionId: ID, toolInput: PLAN_INPUT }],
        ['/api/messages/wait', { sessionId: ID }]
      ];
      for (const [route, body] of cases) {
        const reply = await h.req(route, {
          method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer wrong' }
        });
        assert.equal(reply.status, 403, `${route} must refuse`);
        assert.equal(reply.json?.error, 'bad token');
      }
      assertNothingHeld('bad token');
    });
  }));

  check(await testAsync('the right ANSWER_TOKEN gets past the gate (the 403 above is discriminating)', async () => {
    await withServer(`${ENV}ANSWER_TOKEN=s3cret\n`, async h => {
      h.plant(ID);
      // Deliberately unusable questions: this must fail *after* the token
      // check, proving the token was accepted rather than the route being
      // unreachable for some other reason.
      const reply = await h.req('/api/questions/wait', {
        method: 'POST',
        body: JSON.stringify({ sessionId: ID, toolInput: { questions: [] } }),
        headers: { Authorization: 'Bearer s3cret' }
      });
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'no usable questions');
    });
  }));

  check(await testAsync('a sessionId that fails ID_RE is 400 "bad sessionId" on all three', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const bad = '../../etc/passwd';
      const cases: Array<[string, unknown]> = [
        ['/api/questions/wait', { sessionId: bad, toolInput: QUESTION_INPUT }],
        ['/api/plans/wait', { sessionId: bad, toolInput: PLAN_INPUT }],
        ['/api/messages/wait', { sessionId: bad }]
      ];
      for (const [route, body] of cases) {
        const reply = await h.req(route, { method: 'POST', body: JSON.stringify(body) });
        assert.equal(reply.status, 400, `${route} must refuse`);
        assert.equal(reply.json?.error, 'bad sessionId');
      }
      assertNothingHeld('bad sessionId');
    });
  }));

  check(await testAsync('a missing sessionId is 400 "bad sessionId", not a wait keyed on ""', async () => {
    await withServer(ENV, async h => {
      const reply = await h.req('/api/messages/wait', { method: 'POST', body: JSON.stringify({}) });
      assert.equal(reply.status, 400);
      assert.equal(reply.json?.error, 'bad sessionId');
      assertNothingHeld('empty sessionId');
    });
  }));

  check(await testAsync('a non-JSON body is 400 "bad body", not a throw', async () => {
    await withServer(ENV, async h => {
      for (const route of ['/api/questions/wait', '/api/plans/wait', '/api/messages/wait']) {
        const reply = await h.req(route, { method: 'POST', body: '{not json' });
        assert.equal(reply.status, 400, `${route} must refuse`);
        assert.equal(reply.json?.error, 'bad body');
      }
      assertNothingHeld('bad body');
    });
  }));

  check(await testAsync('an unknown session is 404 on the question and plan waits', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const ghost = '99999999-9999-4999-8999-999999999999';
      const cases: Array<[string, unknown]> = [
        ['/api/questions/wait', { sessionId: ghost, toolInput: QUESTION_INPUT }],
        ['/api/plans/wait', { sessionId: ghost, toolInput: PLAN_INPUT }]
      ];
      for (const [route, body] of cases) {
        const reply = await h.req(route, { method: 'POST', body: JSON.stringify(body) });
        assert.equal(reply.status, 404, `${route} must refuse`);
        assert.equal(reply.json?.error, 'unknown session');
      }
      assertNothingHeld('unknown session');
    });
  }));

  check(await testAsync('the message wait deliberately does NOT check sessionExists', async () => {
    await withServer(ENV, async h => {
      // The mirror of the case above, and the reason it is worth its own test:
      // a Stop hook fires as the turn ends, which is exactly when the
      // transcript may not be flushed yet. Applying the question wait's
      // `sessionExists` check here would break every first turn.
      const ghost = '99999999-9999-4999-8999-999999999999';
      const held = h.open('/api/messages/wait', {
        body: JSON.stringify({ sessionId: ghost, timeoutMs: 60_000 })
      });
      await until(() => messageSessionIds().has(ghost), 'the unknown session is held anyway');
      held.abort();
      await until(() => !messageSessionIds().has(ghost), 'the hold is released on abort');
    });
  }));

  check(await testAsync('GET on a wait route is 405 with an Allow header', async () => {
    await withServer(ENV, async h => {
      for (const route of ['/api/questions/wait', '/api/plans/wait', '/api/messages/wait']) {
        const reply = await h.req(route);
        assert.equal(reply.status, 405, `${route} is POST-only`);
        assert.equal(reply.json?.error, 'method not allowed');
      }
    });
  }));

  /* ---------------------------------------- the hold, and its close cleanup */

  check(await testAsync('a question wait holds its response open and registers the session', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      let answered = false;
      const held = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      void held.reply.then(() => { answered = true; }, () => undefined);

      await until(() => pendingSessionIds().has(ID), 'the question wait registers');
      // Give the event loop several turns: a handler that answered immediately
      // would have resolved by now.
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(answered, false, 'the response must stay held, not answer 200 straight away');

      held.abort();
      await until(() => !pendingSessionIds().has(ID), "res.on('close') cancels the entry");
    });
  }));

  check(await testAsync("a plan wait's entry is cancelled when the client disconnects", async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const held = h.open('/api/plans/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: PLAN_INPUT, timeoutMs: 600_000 })
      });
      await until(() => planSessionIds().has(ID), 'the plan wait registers');
      held.abort();
      // Without the close listener this entry would sit out the full 10 minutes
      // with the dashboard still offering a send-back nothing would read.
      await until(() => !planSessionIds().has(ID), "res.on('close') cancels the plan entry");
    });
  }));

  check(await testAsync("a message wait's entry is cancelled when the client disconnects", async () => {
    await withServer(ENV, async h => {
      const held = h.open('/api/messages/wait', {
        body: JSON.stringify({ sessionId: ID, timeoutMs: 600_000 })
      });
      await until(() => messageSessionIds().has(ID), 'the message wait registers');
      held.abort();
      await until(() => !messageSessionIds().has(ID), "res.on('close') cancels the message entry");
    });
  }));

  check(await testAsync('a disconnect does not evict a newer wait for the same session', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      // The stale-id rule in `pending.cancel`: the first hook's socket dying
      // must not take the second hook's live question with it. Without it, an
      // interrupted-and-retried hook silently loses its replacement.
      const first = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID), 'the first wait registers');
      const firstId = ((await h.req(`/api/sessions/${ID}/question`)).json?.pending as { questionId: string }).questionId;

      const second = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      // The second supersedes the first, which releases the first's response.
      const firstReply = await first.reply;
      assert.equal(firstReply.status, 200);
      assert.equal(firstReply.json?.status, 'superseded');

      const secondId = ((await h.req(`/api/sessions/${ID}/question`)).json?.pending as { questionId: string }).questionId;
      assert.notEqual(secondId, firstId, 'the store is holding the newer question');

      // Now the first socket goes away for good. Its close listener carries the
      // *old* questionId, so it must be a no-op.
      first.abort();
      for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));
      assert.ok(pendingSessionIds().has(ID), "a stale close must not evict the newer wait");

      second.abort();
      await until(() => !pendingSessionIds().has(ID), 'the newer wait is cancelled by its own close');
    });
  }));

  check(await testAsync('a held wait is answered 200 through /api/sessions/:id/answer', async () => {
    await withServer(ENV, async h => {
      h.plant(ID);
      const held = h.open('/api/questions/wait', {
        body: JSON.stringify({ sessionId: ID, toolInput: QUESTION_INPUT, timeoutMs: 600_000 })
      });
      await until(() => pendingSessionIds().has(ID), 'the question wait registers');
      const pending = (await h.req(`/api/sessions/${ID}/question`)).json?.pending as { questionId: string };

      const posted = await h.req(`/api/sessions/${ID}/answer`, {
        method: 'POST',
        body: JSON.stringify({ questionId: pending.questionId, answers: [{ index: 0, selected: ['left'] }] })
      });
      assert.equal(posted.status, 200);
      assert.equal(posted.json?.ok, true);

      // The whole point of the hold: the hook's own response now completes.
      const result = await held.reply;
      assert.equal(result.status, 200);
      assert.equal(result.json?.status, 'answered');
      assert.match(String(result.json?.reason), /left/);
      assertNothingHeld('after the answer');
    });
  }));

  console.log(`\n  ${ok}/${total} passed`);
  return total - ok;
}
